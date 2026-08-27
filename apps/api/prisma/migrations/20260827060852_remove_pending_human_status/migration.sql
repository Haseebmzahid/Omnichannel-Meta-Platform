-- Retire the `PENDING_HUMAN` value from `ConversationStatus`.
--
-- Per docs/architecture/01-domain-model.md ("`status` vs `mode` —
-- resolved") and docs/architecture/03-conversation-and-inbox.md §5:
-- `status` is the inbox-workflow lifecycle only (open/snoozed/resolved/
-- archived); waiting for a human is expressed exclusively as
-- `status = OPEN, mode = PENDING` (ConversationMode, unchanged).
--
-- Postgres has no `ALTER TYPE ... DROP VALUE`, so the safe pattern for
-- removing an enum value is: create the new enum, repoint the column at
-- it via a text cast, swap the type names, then drop the old type. Safe
-- here because no row currently uses `PENDING_HUMAN` (verified before
-- writing this migration; the environment has no production data).
-- AlterEnum
BEGIN;
CREATE TYPE "ConversationStatus_new" AS ENUM ('OPEN', 'SNOOZED', 'RESOLVED', 'ARCHIVED');
ALTER TABLE "public"."conversations" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "conversations" ALTER COLUMN "status" TYPE "ConversationStatus_new" USING ("status"::text::"ConversationStatus_new");
ALTER TYPE "ConversationStatus" RENAME TO "ConversationStatus_old";
ALTER TYPE "ConversationStatus_new" RENAME TO "ConversationStatus";
DROP TYPE "public"."ConversationStatus_old";
ALTER TABLE "conversations" ALTER COLUMN "status" SET DEFAULT 'OPEN';
COMMIT;
