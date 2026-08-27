-- Appointment engine: DoctorSchedule + Appointment.
--
-- Per docs/architecture/01-domain-model.md §2 ("Doctor / DoctorSchedule",
-- "Appointment") and ADR-005 (appointment-transaction-model). Reuses the
-- existing Clinic/Doctor/Patient/Conversation tables — no duplicate
-- provider/patient/clinic tables.
-- CreateEnum
CREATE TYPE "AppointmentStatus" AS ENUM ('HELD', 'CONFIRMED', 'CANCELLED', 'COMPLETED', 'NO_SHOW', 'RESCHEDULED');

-- CreateEnum
CREATE TYPE "AppointmentCreatedBy" AS ENUM ('AI', 'STAFF');

-- CreateTable
CREATE TABLE "doctor_schedules" (
    "id" UUID NOT NULL,
    "doctorId" UUID NOT NULL,
    "dayOfWeek" INTEGER,
    "specificDate" DATE,
    "startTime" TIME NOT NULL,
    "endTime" TIME NOT NULL,
    "slotDurationMinutes" INTEGER NOT NULL,
    "isException" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "doctor_schedules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "appointments" (
    "id" UUID NOT NULL,
    "clinicId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "doctorId" UUID NOT NULL,
    "scheduledStart" TIMESTAMPTZ NOT NULL,
    "scheduledEnd" TIMESTAMPTZ NOT NULL,
    "status" "AppointmentStatus" NOT NULL,
    "sourceConversationId" UUID,
    "sourceChannel" "ChannelKey",
    "referenceCode" TEXT NOT NULL,
    "holdExpiresAt" TIMESTAMPTZ,
    "idempotencyKey" TEXT,
    "createdBy" "AppointmentCreatedBy" NOT NULL,
    "cancelledReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "appointments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "doctor_schedules_doctorId_idx" ON "doctor_schedules"("doctorId");

-- CreateIndex
CREATE INDEX "doctor_schedules_doctorId_dayOfWeek_idx" ON "doctor_schedules"("doctorId", "dayOfWeek");

-- CreateIndex
CREATE INDEX "doctor_schedules_doctorId_specificDate_idx" ON "doctor_schedules"("doctorId", "specificDate");

-- CreateIndex
CREATE UNIQUE INDEX "appointments_referenceCode_key" ON "appointments"("referenceCode");

-- CreateIndex
CREATE UNIQUE INDEX "appointments_idempotencyKey_key" ON "appointments"("idempotencyKey");

-- CreateIndex
CREATE INDEX "appointments_clinicId_idx" ON "appointments"("clinicId");

-- CreateIndex
CREATE INDEX "appointments_doctorId_scheduledStart_idx" ON "appointments"("doctorId", "scheduledStart");

-- CreateIndex
CREATE INDEX "appointments_patientId_scheduledStart_idx" ON "appointments"("patientId", "scheduledStart");

-- AddForeignKey
ALTER TABLE "doctor_schedules" ADD CONSTRAINT "doctor_schedules_doctorId_fkey" FOREIGN KEY ("doctorId") REFERENCES "doctors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "clinics"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_doctorId_fkey" FOREIGN KEY ("doctorId") REFERENCES "doctors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_sourceConversationId_fkey" FOREIGN KEY ("sourceConversationId") REFERENCES "conversations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Booking safety (ADR-005): "A database-level unique constraint on
-- (doctor_id, scheduled_start) for non-cancelled appointments... provides
-- a second, independent guarantee against double-booking even under
-- concurrent requests." Prisma's schema DSL has no syntax for a partial
-- (filtered) unique index, so it is added here as hand-written SQL rather
-- than as a `@@unique` in schema.prisma.
--
-- Known limitation, stated as documented (not silently improved): this
-- blocks two rows sharing the exact same (doctorId, scheduledStart)
-- instant. It does NOT prevent two appointments of unequal length
-- overlapping at different start times (e.g. a 30-minute slot at 09:00
-- and a 45-minute slot starting 09:15 for the same doctor) — the
-- architecture documents only this exact constraint, not a range-exclusion
-- constraint, so none is added here.
CREATE UNIQUE INDEX "appointments_doctorId_scheduledStart_active_key"
    ON "appointments" ("doctorId", "scheduledStart")
    WHERE "status" != 'CANCELLED';
