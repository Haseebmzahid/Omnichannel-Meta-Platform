import { apiFetch } from './client';
import type { CreateKnowledgeDocumentInput, KnowledgeDocument, UpdateKnowledgeDocumentInput } from './types';

// Mirrors apps/api/src/knowledge/knowledge.controller.ts exactly (Task 7-7's
// authenticated routes — clinicId is never sent in any request body; the
// backend derives it from the session cookie, same convention as staff.ts).
//
//   GET   /knowledge
//   POST  /knowledge                { category, title, body, tags }
//   PATCH /knowledge/:id            { category, title, body, tags }
//   PATCH /knowledge/:id/status     { isActive }

export function listKnowledgeDocuments(): Promise<KnowledgeDocument[]> {
  return apiFetch<KnowledgeDocument[]>('/knowledge');
}

export function createKnowledgeDocument(input: CreateKnowledgeDocumentInput): Promise<KnowledgeDocument> {
  return apiFetch<KnowledgeDocument>('/knowledge', { method: 'POST', body: input });
}

export function updateKnowledgeDocument(id: string, input: UpdateKnowledgeDocumentInput): Promise<KnowledgeDocument> {
  return apiFetch<KnowledgeDocument>(`/knowledge/${id}`, { method: 'PATCH', body: input });
}

export function updateKnowledgeDocumentStatus(id: string, isActive: boolean): Promise<KnowledgeDocument> {
  return apiFetch<KnowledgeDocument>(`/knowledge/${id}/status`, { method: 'PATCH', body: { isActive } });
}
