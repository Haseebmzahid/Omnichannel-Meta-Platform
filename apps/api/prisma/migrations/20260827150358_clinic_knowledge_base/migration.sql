-- CreateEnum
CREATE TYPE "KnowledgeCategory" AS ENUM ('CLINIC_INFO', 'DOCTOR', 'SERVICE', 'FEE', 'HOURS', 'LOCATION', 'POLICY', 'FAQ');

-- CreateTable
CREATE TABLE "knowledge_documents" (
    "id" UUID NOT NULL,
    "clinicId" UUID NOT NULL,
    "category" "KnowledgeCategory" NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "tags" TEXT[],
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "knowledge_documents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "knowledge_documents_clinicId_category_idx" ON "knowledge_documents"("clinicId", "category");

-- CreateIndex
CREATE INDEX "knowledge_documents_clinicId_isActive_idx" ON "knowledge_documents"("clinicId", "isActive");

-- AddForeignKey
ALTER TABLE "knowledge_documents" ADD CONSTRAINT "knowledge_documents_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "clinics"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
