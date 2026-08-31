import type { KnowledgeCategory } from '../generated/prisma/enums';

export interface SearchClinicKnowledgeInput {
  clinicId: string;
  query: string;
  // Adeeba multilingual retrieval (Task 7-8) — Gemini's own best-effort
  // plain-English/Urdu-script gloss of the patient's question, used
  // alongside the verbatim `query` for semantic embedding. Optional,
  // cross-lingual hedge specifically for Roman Urdu, not a translation
  // service — see knowledge.service.ts's search() for how it's used.
  queryTranslation?: string;
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

// --- Task 7-7: the staff-facing knowledge-authoring API ------------------
// Deliberately separate from ClinicKnowledgeResultItem above (that one is
// "what the AI model may see" — never id/tags/isActive); these describe
// "what a staff member managing the knowledge base sees and sends", the
// same distinction staff.types.ts draws between StaffSummaryDto and
// AuthenticatedStaffContext.

// clinicId is intentionally NOT a field here — same as staff.types.ts's
// CreateStaffInput: it always comes from the authenticated caller's own
// AuthenticatedStaffContext (see knowledge.controller.ts), never from a
// request body.
export interface CreateKnowledgeDocumentInput {
  category: KnowledgeCategory;
  title: string;
  body: string;
  tags: string[];
}

export type UpdateKnowledgeDocumentInput = CreateKnowledgeDocumentInput;

export interface UpdateKnowledgeDocumentStatusInput {
  isActive: boolean;
}

// The full safe Staff-facing projection of a KnowledgeDocument row — unlike
// ClinicKnowledgeResultItem, this DOES include id/tags/isActive/timestamps,
// because a management UI genuinely needs them to identify, edit, and
// disable a specific row. Still never leaks anything Prisma-internal beyond
// the model's own columns.
export interface KnowledgeDocumentSummaryDto {
  id: string;
  clinicId: string;
  category: KnowledgeCategory;
  title: string;
  body: string;
  tags: string[];
  isActive: boolean;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
}
