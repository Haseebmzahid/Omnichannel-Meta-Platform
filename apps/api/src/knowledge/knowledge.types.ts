import type { KnowledgeCategory } from '../generated/prisma/enums';

export interface SearchClinicKnowledgeInput {
  clinicId: string;
  query: string;
}

// The minimum a caller (the AI tool) needs — never the full KnowledgeDocument
// row (id, clinicId, tags, isActive, updatedBy, createdAt/updatedAt are all
// internal bookkeeping the model has no use for and should never see).
export interface ClinicKnowledgeResultItem {
  category: KnowledgeCategory;
  title: string;
  body: string;
}

export interface SearchClinicKnowledgeResult {
  found: boolean;
  results: ClinicKnowledgeResultItem[];
}
