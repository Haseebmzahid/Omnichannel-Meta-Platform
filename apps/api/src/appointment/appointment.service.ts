import { BadRequestException, Injectable } from '@nestjs/common';
import { type Appointment, Prisma } from '../generated/prisma/client';
import { AppointmentStatus } from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import {
  DoctorNotFoundException,
  ExpiredHoldException,
  IdempotencyKeyConflictException,
  InvalidHoldException,
  NoAvailabilityException,
  PatientNotFoundException,
  SlotConflictException,
} from './appointment.errors';
import type { BookAppointmentInput, CheckAvailabilityInput, CheckAvailabilityResult, HoldSlotInput } from './appointment.types';
import {
  addMinutes,
  appointmentBlocksSlot,
  dayOfWeekForDate,
  intervalsOverlap,
  localDateOf,
  sliceIntoSlots,
  timeOfDayFromColumn,
  type TimeWindow,
  zonedTimeToUtc,
} from './availability.util';
import { generateReferenceCode } from './reference-code.util';

// Short-lived reservation per ADR-005 ("hold_slot ... short-lived
// reservation between availability check and confirmation, to reduce race
// exposure during the confirmation turn"). The architecture does not
// specify an exact duration; 10 minutes is this task's documented,
// deliberately simple choice — long enough for a patient to confirm in a
// chat turn, short enough to keep a slot from being tied up indefinitely
// once cleanup (a later, worker-based task per Part 9) exists.
const DEFAULT_HOLD_MINUTES = 10;

// Retries for a transaction that fails with a Postgres serialization
// conflict under SERIALIZABLE isolation — see runSerializable and
// isSerializationConflict below for the two error shapes this covers.
const MAX_SERIALIZATION_RETRIES = 3;

interface ResolvedWindow extends TimeWindow {
  slotDurationMinutes: number;
}

@Injectable()
export class AppointmentService {
  constructor(private readonly prisma: PrismaService) {}

  // Part 2: deterministic availability. Never asks an LLM to do scheduling
  // arithmetic — pure DB reads + pure date/interval math.
  async checkAvailability(input: CheckAvailabilityInput): Promise<CheckAvailabilityResult> {
    const doctor = await this.prisma.doctor.findUnique({ where: { id: input.doctorId }, include: { clinic: true } });
    if (!doctor) throw new DoctorNotFoundException(input.doctorId);

    const windows = await this.resolveScheduleWindows(this.prisma, doctor.id, input.date, doctor.clinic.timezone);
    const candidateSlots = windows.flatMap((w) => sliceIntoSlots(w, input.slotDurationMinutes ?? w.slotDurationMinutes));

    if (candidateSlots.length === 0) {
      return { doctorId: doctor.id, clinicId: doctor.clinicId, date: input.date, timezone: doctor.clinic.timezone, slots: [] };
    }

    // Scope the appointments query tightly to the actual candidate range,
    // not a full 24h day, and let Postgres do the CANCELLED exclusion;
    // the expired-hold exclusion (appointmentBlocksSlot) depends on "now"
    // and is applied in application code below.
    const firstSlot = candidateSlots[0];
    const lastSlot = candidateSlots[candidateSlots.length - 1];
    if (!firstSlot || !lastSlot) {
      // Unreachable given the length check above; satisfies strict
      // indexed-access typing.
      return { doctorId: doctor.id, clinicId: doctor.clinicId, date: input.date, timezone: doctor.clinic.timezone, slots: [] };
    }
    const rangeStart = firstSlot.start;
    const rangeEnd = lastSlot.end;

    const appointments = await this.prisma.appointment.findMany({
      where: {
        doctorId: doctor.id,
        status: { not: AppointmentStatus.CANCELLED },
        scheduledStart: { lt: rangeEnd },
        scheduledEnd: { gt: rangeStart },
      },
    });

    const now = new Date();
    const blocking = appointments.filter((a) => appointmentBlocksSlot(a, now));

    const slots = candidateSlots.filter(
      (slot) => !blocking.some((a) => intervalsOverlap(slot.start, slot.end, a.scheduledStart, a.scheduledEnd)),
    );

    return { doctorId: doctor.id, clinicId: doctor.clinicId, date: input.date, timezone: doctor.clinic.timezone, slots };
  }

  // Part 4: hold_slot(). Transactional (SERIALIZABLE) so two concurrent
  // holds for overlapping-but-not-identical-start windows cannot both
  // succeed — see runSerializable and Part 3's explicit warning that the
  // (doctorId, scheduledStart) unique index alone is not sufficient.
  async holdSlot(input: HoldSlotInput): Promise<Appointment> {
    if (input.start >= input.end) throw new BadRequestException('start must be before end.');

    const doctor = await this.prisma.doctor.findUnique({ where: { id: input.doctorId }, include: { clinic: true } });
    if (!doctor) throw new DoctorNotFoundException(input.doctorId);
    const patient = await this.prisma.patient.findUnique({ where: { id: input.patientId } });
    if (!patient) throw new PatientNotFoundException(input.patientId);

    return this.runSerializable(async (tx) => {
      const existing = await tx.appointment.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
      if (existing) {
        this.assertIdempotentReplayMatches(existing, input, input.idempotencyKey);
        return existing;
      }

      const localDate = localDateOf(input.start, doctor.clinic.timezone);
      const windows = await this.resolveScheduleWindows(tx, doctor.id, localDate, doctor.clinic.timezone);
      const withinSchedule = windows.some((w) => w.start <= input.start && input.end <= w.end);
      if (!withinSchedule) throw new NoAvailabilityException();

      const conflict = await this.findConflict(tx, doctor.id, input.start, input.end);
      if (conflict) throw new SlotConflictException();

      return this.createAppointment(tx, {
        clinicId: doctor.clinicId,
        doctorId: doctor.id,
        patientId: patient.id,
        scheduledStart: input.start,
        scheduledEnd: input.end,
        status: AppointmentStatus.HELD,
        holdExpiresAt: addMinutes(new Date(), DEFAULT_HOLD_MINUTES),
        idempotencyKey: input.idempotencyKey,
        createdBy: input.createdBy,
        sourceConversationId: input.sourceConversationId,
        sourceChannel: input.sourceChannel,
      });
    });
  }

  // Part 5: book_appointment(). Dual-mode per ADR-005 (hold_slot is
  // optional): confirms an existing hold when holdId is supplied, else
  // books directly.
  async bookAppointment(input: BookAppointmentInput): Promise<Appointment> {
    return this.runSerializable(async (tx) => {
      if (input.holdId) {
        return this.confirmHold(tx, input.holdId, input);
      }
      return this.bookDirect(tx, input);
    });
  }

  private async confirmHold(
    tx: Prisma.TransactionClient,
    holdId: string,
    input: BookAppointmentInput,
  ): Promise<Appointment> {
    const hold = await tx.appointment.findUnique({ where: { id: holdId } });
    if (!hold) throw new InvalidHoldException(`Hold ${holdId} was not found.`);
    if (input.doctorId && input.doctorId !== hold.doctorId) {
      throw new InvalidHoldException('Hold does not match the requested doctor.');
    }
    if (input.patientId && input.patientId !== hold.patientId) {
      throw new InvalidHoldException('Hold does not match the requested patient.');
    }

    // Idempotent replay: calling book_appointment(holdId) again after it
    // already succeeded returns the same confirmed row rather than erroring.
    if (hold.status === AppointmentStatus.CONFIRMED) return hold;

    if (hold.status !== AppointmentStatus.HELD) {
      throw new InvalidHoldException(`Hold ${holdId} is not in a holdable state (status=${hold.status}).`);
    }

    const now = new Date();
    if (hold.holdExpiresAt !== null && hold.holdExpiresAt <= now) {
      throw new ExpiredHoldException(holdId);
    }

    // Defense in depth: re-verify nothing else has come to occupy this
    // exact interval since the hold was created.
    const conflict = await this.findConflict(tx, hold.doctorId, hold.scheduledStart, hold.scheduledEnd, hold.id);
    if (conflict) throw new SlotConflictException();

    return tx.appointment.update({
      where: { id: holdId },
      data: {
        status: AppointmentStatus.CONFIRMED,
        holdExpiresAt: null,
        sourceConversationId: input.sourceConversationId ?? hold.sourceConversationId,
        sourceChannel: input.sourceChannel ?? hold.sourceChannel,
      },
    });
  }

  private async bookDirect(tx: Prisma.TransactionClient, input: BookAppointmentInput): Promise<Appointment> {
    if (!input.doctorId || !input.patientId || !input.start || !input.end || !input.createdBy) {
      throw new BadRequestException(
        'doctorId, patientId, start, end, and createdBy are required when booking without a holdId.',
      );
    }
    if (input.start >= input.end) throw new BadRequestException('start must be before end.');

    const existing = await tx.appointment.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
    if (existing) {
      this.assertIdempotentReplayMatches(
        existing,
        { doctorId: input.doctorId, patientId: input.patientId, start: input.start, end: input.end },
        input.idempotencyKey,
      );
      return existing;
    }

    const doctor = await tx.doctor.findUnique({ where: { id: input.doctorId }, include: { clinic: true } });
    if (!doctor) throw new DoctorNotFoundException(input.doctorId);
    const patient = await tx.patient.findUnique({ where: { id: input.patientId } });
    if (!patient) throw new PatientNotFoundException(input.patientId);

    const localDate = localDateOf(input.start, doctor.clinic.timezone);
    const windows = await this.resolveScheduleWindows(tx, doctor.id, localDate, doctor.clinic.timezone);
    const withinSchedule = windows.some((w) => w.start <= (input.start as Date) && (input.end as Date) <= w.end);
    if (!withinSchedule) throw new NoAvailabilityException();

    const conflict = await this.findConflict(tx, doctor.id, input.start, input.end);
    if (conflict) throw new SlotConflictException();

    return this.createAppointment(tx, {
      clinicId: doctor.clinicId,
      doctorId: doctor.id,
      patientId: patient.id,
      scheduledStart: input.start,
      scheduledEnd: input.end,
      status: AppointmentStatus.CONFIRMED,
      idempotencyKey: input.idempotencyKey,
      createdBy: input.createdBy,
      sourceConversationId: input.sourceConversationId,
      sourceChannel: input.sourceChannel,
    });
  }

  // Resolves the open working windows for a doctor on a given clinic-local
  // calendar date. Per docs/architecture/01-domain-model.md's DoctorSchedule
  // fields ("day_of_week or specific date") and "is_exception
  // (holiday/override)": a specificDate row, when present for the date,
  // REPLACES the recurring dayOfWeek rule for that date entirely (override
  // semantics) rather than being merged with it. A fully closed day (a
  // holiday exception) is represented under the existing schema — without
  // adding a boolean flag it doesn't have — by a specificDate row whose
  // startTime equals endTime: sliceIntoSlots naturally produces zero slots
  // for a zero-width window, so no special-casing is needed here.
  private async resolveScheduleWindows(
    client: Prisma.TransactionClient,
    doctorId: string,
    date: string,
    timezone: string,
  ): Promise<ResolvedWindow[]> {
    const weekday = dayOfWeekForDate(date);
    const specificDateValue = new Date(`${date}T00:00:00.000Z`);

    const [exceptionRows, recurringRows] = await Promise.all([
      client.doctorSchedule.findMany({ where: { doctorId, specificDate: specificDateValue } }),
      client.doctorSchedule.findMany({ where: { doctorId, dayOfWeek: weekday, specificDate: null } }),
    ]);

    const rows = exceptionRows.length > 0 ? exceptionRows : recurringRows;

    return rows
      .map((row) => {
        const s = timeOfDayFromColumn(row.startTime);
        const e = timeOfDayFromColumn(row.endTime);
        return {
          start: zonedTimeToUtc(date, s.hour, s.minute, s.second, timezone),
          end: zonedTimeToUtc(date, e.hour, e.minute, e.second, timezone),
          slotDurationMinutes: row.slotDurationMinutes,
        };
      })
      .filter((w) => w.end > w.start);
  }

  // Real interval-overlap conflict detection (Part 3) — never relies on
  // the (doctorId, scheduledStart) unique index alone, since that only
  // catches identical start times, not unequal-length overlaps.
  private async findConflict(
    tx: Prisma.TransactionClient,
    doctorId: string,
    start: Date,
    end: Date,
    excludeId?: string,
  ): Promise<Appointment | undefined> {
    const candidates = await tx.appointment.findMany({
      where: {
        doctorId,
        status: { not: AppointmentStatus.CANCELLED },
        scheduledStart: { lt: end },
        scheduledEnd: { gt: start },
        ...(excludeId ? { id: { not: excludeId } } : {}),
      },
    });
    const now = new Date();
    return candidates.find((a) => appointmentBlocksSlot(a, now) && intervalsOverlap(start, end, a.scheduledStart, a.scheduledEnd));
  }

  private assertIdempotentReplayMatches(
    existing: Appointment,
    expected: { doctorId?: string; patientId?: string; start?: Date; end?: Date },
    key: string,
  ): void {
    const mismatched =
      (expected.doctorId !== undefined && expected.doctorId !== existing.doctorId) ||
      (expected.patientId !== undefined && expected.patientId !== existing.patientId) ||
      (expected.start !== undefined && expected.start.getTime() !== existing.scheduledStart.getTime()) ||
      (expected.end !== undefined && expected.end.getTime() !== existing.scheduledEnd.getTime());
    if (mismatched) throw new IdempotencyKeyConflictException(key);
  }

  // Part 6/7: creates the row with a fresh referenceCode, retrying on a
  // referenceCode collision (astronomically unlikely — see
  // reference-code.util.ts) and translating every other unique-constraint
  // violation into the right domain error rather than leaking a raw
  // Prisma error (Part 10). In particular this is where a concurrent
  // hold/book race that slips past the application-level conflict check
  // gets caught by the database's own partial unique index
  // (appointments_doctorId_scheduledStart_active_key, from the
  // appointment_engine migration) as the final safety net.
  private async createAppointment(
    tx: Prisma.TransactionClient,
    data: Omit<Prisma.AppointmentUncheckedCreateInput, 'referenceCode'>,
  ): Promise<Appointment> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await tx.appointment.create({ data: { ...data, referenceCode: generateReferenceCode() } });
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          const target = String((err.meta as { target?: unknown } | undefined)?.target ?? '');
          if (target.includes('referenceCode')) continue;
          if (target.includes('idempotencyKey') && typeof data.idempotencyKey === 'string') {
            const existing = await tx.appointment.findUnique({ where: { idempotencyKey: data.idempotencyKey } });
            if (existing) return existing;
          }
          throw new SlotConflictException();
        }
        throw err;
      }
    }
    throw new SlotConflictException();
  }

  // Runs `fn` in a SERIALIZABLE transaction, retrying on a Postgres
  // serialization failure. This, not the unique index, is what actually
  // prevents two concurrent requests from both successfully holding/
  // booking overlapping-but-different-start windows (Part 4's
  // requirement) — SERIALIZABLE isolation makes Postgres itself detect the
  // write-write conflict between the two transactions' overlap checks.
  //
  // The same underlying Postgres serialization failure surfaces through
  // two different shapes depending on exactly where the pg driver adapter
  // detects it: usually Prisma wraps it as PrismaClientKnownRequestError
  // code P2034 ("transaction failed due to a write conflict or a
  // deadlock"), but when the adapter detects it itself (observed at the
  // final write inside the transaction, e.g. the appointment INSERT) it
  // throws a raw DriverAdapterError named 'TransactionWriteConflict'
  // before Prisma gets a chance to wrap it. Both are the identical
  // condition this method already exists to retry — recognizing both is
  // not a new conflict-handling strategy, just correct detection of the
  // one this code was already written for. Confirmed via a standalone
  // concurrency repro against a real Postgres instance (see Task 4C-5
  // report) rather than guessed from documentation.
  private async runSerializable<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    for (let attempt = 1; attempt <= MAX_SERIALIZATION_RETRIES; attempt++) {
      try {
        return await this.prisma.$transaction(fn, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      } catch (err) {
        if (!this.isSerializationConflict(err)) throw err;
        if (attempt === MAX_SERIALIZATION_RETRIES) throw new SlotConflictException();
      }
    }
    // Unreachable — the loop always returns or throws.
    throw new SlotConflictException();
  }

  private isSerializationConflict(err: unknown): boolean {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2034') return true;
    return (
      err instanceof Error && err.name === 'DriverAdapterError' && err.message.includes('TransactionWriteConflict')
    );
  }
}
