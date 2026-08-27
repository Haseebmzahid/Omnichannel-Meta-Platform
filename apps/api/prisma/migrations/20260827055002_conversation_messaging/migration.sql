-- CreateEnum
CREATE TYPE "ConversationStatus" AS ENUM ('OPEN', 'PENDING_HUMAN', 'SNOOZED', 'RESOLVED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "ConversationMode" AS ENUM ('AI', 'PENDING', 'HUMAN', 'PAUSED', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "MessageDirection" AS ENUM ('INBOUND', 'OUTBOUND');

-- CreateEnum
CREATE TYPE "MessageSenderType" AS ENUM ('PATIENT', 'AI', 'STAFF', 'SYSTEM');

-- CreateEnum
CREATE TYPE "MessageContentType" AS ENUM ('TEXT', 'MEDIA', 'CHOICE_REPLY', 'LOCATION', 'CONTACT', 'SYSTEM_EVENT', 'UNSUPPORTED');

-- CreateEnum
CREATE TYPE "MessageDeliveryStatus" AS ENUM ('PENDING', 'SENT', 'DELIVERED', 'READ', 'FAILED');

-- CreateEnum
CREATE TYPE "AttachmentType" AS ENUM ('IMAGE', 'VIDEO', 'AUDIO', 'DOCUMENT', 'VOICE', 'STICKER', 'UNSUPPORTED');

-- CreateEnum
CREATE TYPE "AttachmentSource" AS ENUM ('DOWNLOADED', 'REMOTE_URL');

-- CreateTable
CREATE TABLE "conversations" (
    "id" UUID NOT NULL,
    "clinicId" UUID NOT NULL,
    "contactId" UUID NOT NULL,
    "patientId" UUID,
    "channelKey" "ChannelKey" NOT NULL,
    "channelAccountRef" TEXT NOT NULL,
    "externalThreadKey" TEXT NOT NULL,
    "status" "ConversationStatus" NOT NULL DEFAULT 'OPEN',
    "mode" "ConversationMode" NOT NULL DEFAULT 'AI',
    "assignedStaffId" UUID,
    "windowExpiresAt" TIMESTAMP(3),
    "windowType" TEXT,
    "extensionExpiresAt" TIMESTAMP(3),
    "unreadCount" INTEGER NOT NULL DEFAULT 0,
    "lastMessageAt" TIMESTAMP(3),
    "lastPatientMessageAt" TIMESTAMP(3),
    "firstResponseAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "labels" TEXT[],
    "internalNotes" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "messages" (
    "id" UUID NOT NULL,
    "conversationId" UUID NOT NULL,
    "channelKey" "ChannelKey" NOT NULL,
    "channelAccountRef" TEXT NOT NULL,
    "direction" "MessageDirection" NOT NULL,
    "senderType" "MessageSenderType" NOT NULL,
    "senderStaffId" UUID,
    "contentType" "MessageContentType" NOT NULL,
    "text" TEXT NOT NULL,
    "choiceSelection" JSONB,
    "replyToId" UUID,
    "externalId" TEXT,
    "externalReplyToId" TEXT,
    "sentAt" TIMESTAMP(3),
    "receivedAt" TIMESTAMP(3),
    "deliveryStatus" "MessageDeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "failureClass" TEXT,
    "failureCode" TEXT,
    "failureMessage" TEXT,
    "aiGenerated" BOOLEAN NOT NULL DEFAULT false,
    "degraded" BOOLEAN NOT NULL DEFAULT false,
    "degradedReason" TEXT,
    "channelMeta" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attachments" (
    "id" UUID NOT NULL,
    "messageId" UUID NOT NULL,
    "type" "AttachmentType" NOT NULL,
    "storageRef" TEXT,
    "mime" TEXT,
    "bytes" INTEGER,
    "caption" TEXT,
    "source" "AttachmentSource" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attachments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "conversations_clinicId_idx" ON "conversations"("clinicId");

-- CreateIndex
CREATE INDEX "conversations_clinicId_lastMessageAt_idx" ON "conversations"("clinicId", "lastMessageAt");

-- CreateIndex
CREATE INDEX "conversations_clinicId_channelKey_idx" ON "conversations"("clinicId", "channelKey");

-- CreateIndex
CREATE INDEX "conversations_patientId_idx" ON "conversations"("patientId");

-- CreateIndex
CREATE UNIQUE INDEX "conversations_channelKey_channelAccountRef_externalThreadKe_key" ON "conversations"("channelKey", "channelAccountRef", "externalThreadKey");

-- CreateIndex
CREATE INDEX "messages_conversationId_createdAt_idx" ON "messages"("conversationId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "messages_channelAccountRef_externalId_key" ON "messages"("channelAccountRef", "externalId");

-- CreateIndex
CREATE INDEX "attachments_messageId_idx" ON "attachments"("messageId");

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "clinics"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "contacts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "patients"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_assignedStaffId_fkey" FOREIGN KEY ("assignedStaffId") REFERENCES "staff"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "conversations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_senderStaffId_fkey" FOREIGN KEY ("senderStaffId") REFERENCES "staff"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_replyToId_fkey" FOREIGN KEY ("replyToId") REFERENCES "messages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "messages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
