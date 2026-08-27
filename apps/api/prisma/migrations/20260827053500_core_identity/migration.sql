-- CreateEnum
CREATE TYPE "StaffRole" AS ENUM ('ADMIN', 'MANAGER', 'AGENT', 'READ_ONLY');

-- CreateEnum
CREATE TYPE "StaffStatus" AS ENUM ('ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "ChannelKey" AS ENUM ('WHATSAPP', 'INSTAGRAM', 'MESSENGER');

-- CreateEnum
CREATE TYPE "ChannelLinkState" AS ENUM ('UNLINKED', 'LINKED');

-- CreateEnum
CREATE TYPE "ChannelLinkMethod" AS ENUM ('VERIFIED_PHONE', 'APPOINTMENT_REF', 'STAFF_CONFIRMED', 'OTP');

-- CreateEnum
CREATE TYPE "ChannelLinkConfidence" AS ENUM ('HIGH', 'PENDING');

-- CreateTable
CREATE TABLE "clinics" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "timezone" TEXT NOT NULL,
    "address" TEXT,
    "hours" JSONB,
    "defaultConsultationFee" DECIMAL(10,2),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "clinics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "staff" (
    "id" UUID NOT NULL,
    "clinicId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "mfaSecret" TEXT,
    "role" "StaffRole" NOT NULL,
    "status" "StaffStatus" NOT NULL DEFAULT 'ACTIVE',
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "staff_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "doctors" (
    "id" UUID NOT NULL,
    "clinicId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "specialty" TEXT,
    "bio" TEXT,
    "consultationFee" DECIMAL(10,2),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "doctors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "patients" (
    "id" UUID NOT NULL,
    "clinicId" UUID NOT NULL,
    "displayName" TEXT NOT NULL,
    "verifiedPhone" TEXT,
    "verifiedEmail" TEXT,
    "dob" DATE,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "patients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contacts" (
    "id" UUID NOT NULL,
    "patientId" UUID,
    "displayName" TEXT,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "contacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "channel_identities" (
    "id" UUID NOT NULL,
    "contactId" UUID NOT NULL,
    "channelKey" "ChannelKey" NOT NULL,
    "channelAccountRef" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "displayNameAtChannel" TEXT,
    "linkState" "ChannelLinkState" NOT NULL DEFAULT 'UNLINKED',
    "linkMethod" "ChannelLinkMethod",
    "linkConfidence" "ChannelLinkConfidence",
    "linkedByStaffId" UUID,
    "linkedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "channel_identities_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "staff_clinicId_idx" ON "staff"("clinicId");

-- CreateIndex
CREATE UNIQUE INDEX "staff_clinicId_email_key" ON "staff"("clinicId", "email");

-- CreateIndex
CREATE INDEX "doctors_clinicId_idx" ON "doctors"("clinicId");

-- CreateIndex
CREATE INDEX "patients_clinicId_idx" ON "patients"("clinicId");

-- CreateIndex
CREATE INDEX "patients_verifiedPhone_idx" ON "patients"("verifiedPhone");

-- CreateIndex
CREATE INDEX "contacts_patientId_idx" ON "contacts"("patientId");

-- CreateIndex
CREATE INDEX "channel_identities_contactId_idx" ON "channel_identities"("contactId");

-- CreateIndex
CREATE UNIQUE INDEX "channel_identities_channelKey_channelAccountRef_externalId_key" ON "channel_identities"("channelKey", "channelAccountRef", "externalId");

-- AddForeignKey
ALTER TABLE "staff" ADD CONSTRAINT "staff_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "clinics"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "doctors" ADD CONSTRAINT "doctors_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "clinics"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patients" ADD CONSTRAINT "patients_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "clinics"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "patients"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_identities" ADD CONSTRAINT "channel_identities_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "contacts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_identities" ADD CONSTRAINT "channel_identities_linkedByStaffId_fkey" FOREIGN KEY ("linkedByStaffId") REFERENCES "staff"("id") ON DELETE SET NULL ON UPDATE CASCADE;
