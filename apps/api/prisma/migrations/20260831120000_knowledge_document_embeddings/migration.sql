-- AlterTable
ALTER TABLE "knowledge_documents" ADD COLUMN     "embedding" DOUBLE PRECISION[] NOT NULL DEFAULT ARRAY[]::DOUBLE PRECISION[],
ADD COLUMN     "embeddingModel" TEXT,
ADD COLUMN     "embeddingUpdatedAt" TIMESTAMP(3);
