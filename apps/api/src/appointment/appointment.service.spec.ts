import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Appointment } from '../generated/prisma/client';
import { AppointmentCreatedBy, AppointmentStatus } from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import { ExpiredHoldException, SlotConflictException } from './appointment.errors';
import { AppointmentService } from './appointment.service';
import { dayOfWeekForDate, nextIsoDate } from './availability.util';

// Integration tests against the real local dev Postgres (see
// apps/api/src/prisma/prisma.service.ts — same DATABASE_URL default used
// by `pnpm test`). All fixtures are created under one throwaway Clinic and
// deleted in afterAll, so this never pollutes the permanent dev database.
//
// Each scenario below uses its own calendar date (same weekday, a distinct
// week offset) so appointment rows created by one test can never be seen
// by another test's availability/conflict queries — no shared mutable
// fixture state between tests, no ordering dependency.

const CLINIC_TIMEZONE = 'Asia/Karachi'; // fixed UTC+5, no DST — deterministic expected instants
const SCHEDULE_START_UTC = Date.UTC(1970, 0, 1, 9, 0, 0); // 09:00 local
const SCHEDULE_END_UTC = Date.UTC(1970, 0, 1, 10, 0, 0); // 10:00 local
const SLOT_MINUTES = 30;

function addWeeks(isoDate: string, weeks: number): string {
  let d = isoDate;
  for (let i = 0; i < weeks * 7; i++) d = nextIsoDate(d);
  return d;
}

// 09:00/09:30 Asia/Karachi (UTC+5) as absolute instants, for a given test date.
function localSlotInstants(date: string) {
  return {
    slot0: { start: new Date(`${date}T04:00:00.000Z`), end: new Date(`${date}T04:30:00.000Z`) },
    slot1: { start: new Date(`${date}T04:30:00.000Z`), end: new Date(`${date}T05:00:00.000Z`) },
  };
}

describe('AppointmentService', () => {
  const prisma = new PrismaService();
  const service = new AppointmentService(prisma);

  let clinicId: string;
  let doctorId: string;
  let patientId: string;
  const baseDate = '2030-01-07'; // arbitrary fixed future Monday; exact weekday is irrelevant, only consistency matters
  let week = 0;
  const nextTestDate = () => addWeeks(baseDate, week++);

  beforeAll(async () => {
    await prisma.$connect();

    const clinic = await prisma.clinic.create({
      data: { name: 'Test Clinic 4C-4', timezone: CLINIC_TIMEZONE },
    });
    clinicId = clinic.id;

    const doctor = await prisma.doctor.create({
      data: { clinicId, name: 'Dr. Test' },
    });
    doctorId = doctor.id;

    const patient = await prisma.patient.create({
      data: { clinicId, displayName: 'Test Patient' },
    });
    patientId = patient.id;

    await prisma.doctorSchedule.create({
      data: {
        doctorId,
        dayOfWeek: dayOfWeekForDate(baseDate),
        startTime: new Date(SCHEDULE_START_UTC),
        endTime: new Date(SCHEDULE_END_UTC),
        slotDurationMinutes: SLOT_MINUTES,
      },
    });
  });

  afterAll(async () => {
    await prisma.appointment.deleteMany({ where: { doctorId } });
    await prisma.doctorSchedule.deleteMany({ where: { doctorId } });
    await prisma.doctor.delete({ where: { id: doctorId } });
    await prisma.patient.delete({ where: { id: patientId } });
    await prisma.clinic.delete({ where: { id: clinicId } });
    await prisma.$disconnect();
  });

  it('1. returns the available slots for an open day', async () => {
    const date = nextTestDate();
    const { slot0, slot1 } = localSlotInstants(date);

    const result = await service.checkAvailability({ doctorId, date });

    expect(result.timezone).toBe(CLINIC_TIMEZONE);
    expect(result.clinicId).toBe(clinicId);
    expect(result.slots).toEqual([slot0, slot1]);
  });

  it('2. excludes a slot occupied by a CONFIRMED appointment', async () => {
    const date = nextTestDate();
    const { slot0, slot1 } = localSlotInstants(date);

    await prisma.appointment.create({
      data: {
        clinicId,
        doctorId,
        patientId,
        scheduledStart: slot0.start,
        scheduledEnd: slot0.end,
        status: AppointmentStatus.CONFIRMED,
        referenceCode: `TST2${date}`,
        createdBy: AppointmentCreatedBy.STAFF,
      },
    });

    const result = await service.checkAvailability({ doctorId, date });
    expect(result.slots).toEqual([slot1]);
  });

  it('3. excludes both slots for an overlapping appointment with a different start time', async () => {
    const date = nextTestDate();

    // 09:15-09:45 local — overlaps both the 09:00-09:30 and 09:30-10:00
    // slots without sharing either one's exact start time, which a plain
    // UNIQUE(doctorId, scheduledStart) constraint would miss entirely.
    await prisma.appointment.create({
      data: {
        clinicId,
        doctorId,
        patientId,
        scheduledStart: new Date(`${date}T04:15:00.000Z`),
        scheduledEnd: new Date(`${date}T04:45:00.000Z`),
        status: AppointmentStatus.CONFIRMED,
        referenceCode: `TST3${date}`,
        createdBy: AppointmentCreatedBy.STAFF,
      },
    });

    const result = await service.checkAvailability({ doctorId, date });
    expect(result.slots).toEqual([]);
  });

  it('4. a CANCELLED appointment does not block its slot', async () => {
    const date = nextTestDate();
    const { slot0, slot1 } = localSlotInstants(date);

    await prisma.appointment.create({
      data: {
        clinicId,
        doctorId,
        patientId,
        scheduledStart: slot0.start,
        scheduledEnd: slot0.end,
        status: AppointmentStatus.CANCELLED,
        referenceCode: `TST4${date}`,
        createdBy: AppointmentCreatedBy.STAFF,
      },
    });

    const result = await service.checkAvailability({ doctorId, date });
    expect(result.slots).toEqual([slot0, slot1]);
  });

  it('5. an expired HELD appointment does not block its slot', async () => {
    const date = nextTestDate();
    const { slot0, slot1 } = localSlotInstants(date);

    await prisma.appointment.create({
      data: {
        clinicId,
        doctorId,
        patientId,
        scheduledStart: slot0.start,
        scheduledEnd: slot0.end,
        status: AppointmentStatus.HELD,
        holdExpiresAt: new Date(Date.now() - 60_000),
        referenceCode: `TST5${date}`,
        createdBy: AppointmentCreatedBy.STAFF,
      },
    });

    const result = await service.checkAvailability({ doctorId, date });
    expect(result.slots).toEqual([slot0, slot1]);
  });

  it('6. holdSlot creates a valid HELD appointment', async () => {
    const date = nextTestDate();
    const { slot0 } = localSlotInstants(date);

    const held = await service.holdSlot({
      doctorId,
      patientId,
      start: slot0.start,
      end: slot0.end,
      idempotencyKey: `hold-6-${date}`,
      createdBy: AppointmentCreatedBy.AI,
    });

    expect(held.status).toBe(AppointmentStatus.HELD);
    expect(held.clinicId).toBe(clinicId);
    expect(held.doctorId).toBe(doctorId);
    expect(held.patientId).toBe(patientId);
    expect(held.holdExpiresAt).not.toBeNull();
    expect(held.holdExpiresAt && held.holdExpiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(held.referenceCode).toMatch(/^[A-Z0-9]{8}$/);
  });

  it('7. two concurrent overlapping holds cannot both succeed', async () => {
    const date = nextTestDate();

    // Overlapping, different-start intervals — the exact case the
    // (doctorId, scheduledStart) unique index alone would not catch.
    const holdA = service.holdSlot({
      doctorId,
      patientId,
      start: new Date(`${date}T04:00:00.000Z`),
      end: new Date(`${date}T04:30:00.000Z`),
      idempotencyKey: `hold-7a-${date}`,
      createdBy: AppointmentCreatedBy.AI,
    });
    const holdB = service.holdSlot({
      doctorId,
      patientId,
      start: new Date(`${date}T04:15:00.000Z`),
      end: new Date(`${date}T04:45:00.000Z`),
      idempotencyKey: `hold-7b-${date}`,
      createdBy: AppointmentCreatedBy.AI,
    });

    const results = await Promise.allSettled([holdA, holdB]);
    const fulfilled = results.filter((r): r is PromiseFulfilledResult<Appointment> => r.status === 'fulfilled');
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toBeInstanceOf(SlotConflictException);
  });

  it('8. bookAppointment converts a valid hold to CONFIRMED', async () => {
    const date = nextTestDate();
    const { slot0 } = localSlotInstants(date);

    const held = await service.holdSlot({
      doctorId,
      patientId,
      start: slot0.start,
      end: slot0.end,
      idempotencyKey: `hold-8-${date}`,
      createdBy: AppointmentCreatedBy.AI,
    });

    const confirmed = await service.bookAppointment({
      idempotencyKey: `confirm-8-${date}`,
      holdId: held.id,
    });

    expect(confirmed.id).toBe(held.id);
    expect(confirmed.status).toBe(AppointmentStatus.CONFIRMED);
    expect(confirmed.holdExpiresAt).toBeNull();
    expect(confirmed.doctorId).toBe(doctorId);
    expect(confirmed.patientId).toBe(patientId);
  });

  it('9. an expired hold cannot be booked', async () => {
    const date = nextTestDate();
    const { slot0 } = localSlotInstants(date);

    const expiredHold = await prisma.appointment.create({
      data: {
        clinicId,
        doctorId,
        patientId,
        scheduledStart: slot0.start,
        scheduledEnd: slot0.end,
        status: AppointmentStatus.HELD,
        holdExpiresAt: new Date(Date.now() - 60_000),
        referenceCode: `TST9${date}`,
        createdBy: AppointmentCreatedBy.AI,
      },
    });

    await expect(
      service.bookAppointment({ idempotencyKey: `confirm-9-${date}`, holdId: expiredHold.id }),
    ).rejects.toBeInstanceOf(ExpiredHoldException);
  });

  it('10. repeating the same idempotency key does not create a duplicate appointment', async () => {
    const date = nextTestDate();
    const { slot0 } = localSlotInstants(date);
    const idempotencyKey = `hold-10-${date}`;

    const first = await service.holdSlot({
      doctorId,
      patientId,
      start: slot0.start,
      end: slot0.end,
      idempotencyKey,
      createdBy: AppointmentCreatedBy.AI,
    });
    const second = await service.holdSlot({
      doctorId,
      patientId,
      start: slot0.start,
      end: slot0.end,
      idempotencyKey,
      createdBy: AppointmentCreatedBy.AI,
    });

    expect(second.id).toBe(first.id);

    const count = await prisma.appointment.count({ where: { idempotencyKey } });
    expect(count).toBe(1);
  });
});
