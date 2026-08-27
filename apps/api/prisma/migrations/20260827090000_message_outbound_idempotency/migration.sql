-- Add Message.idempotencyKey: caller-supplied idempotency boundary for
-- OUTBOUND writes (WhatsApp outbound send slice), mirroring the exact
-- pattern already established by Appointment.idempotencyKey (nullable +
-- unique; Postgres unique indexes allow any number of NULL rows, so
-- messages that never supply a key are unaffected). See schema.prisma's
-- comment on this column for why this is a distinct boundary from the
-- existing (channelAccountRef, externalId) inbound idempotency constraint.
-- AlterTable
ALTER TABLE "messages" ADD COLUMN "idempotencyKey" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "messages_idempotencyKey_key" ON "messages"("idempotencyKey");
