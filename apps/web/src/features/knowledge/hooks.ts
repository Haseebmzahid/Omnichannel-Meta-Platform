import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as knowledgeApi from '../../lib/api/knowledge';
import type { CreateKnowledgeDocumentInput, UpdateKnowledgeDocumentInput } from '../../lib/api/types';

// No pagination/server-side filtering — the backend list endpoint takes no
// query params (see knowledge.controller.ts), mirroring StaffService's own
// "small per-clinic list" shape. Search/category/status filtering happens
// client-side over this cached list (see KnowledgePage.tsx).

export const knowledgeKeys = {
  list: () => ['knowledge', 'list'] as const,
};

export function useKnowledgeDocuments() {
  return useQuery({
    queryKey: knowledgeKeys.list(),
    queryFn: knowledgeApi.listKnowledgeDocuments,
  });
}

export function useCreateKnowledgeDocument() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateKnowledgeDocumentInput) => knowledgeApi.createKnowledgeDocument(input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: knowledgeKeys.list() }),
  });
}

export function useUpdateKnowledgeDocument() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateKnowledgeDocumentInput }) => knowledgeApi.updateKnowledgeDocument(id, input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: knowledgeKeys.list() }),
  });
}

export function useUpdateKnowledgeDocumentStatus() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, isActive }: { id: string; isActive: boolean }) => knowledgeApi.updateKnowledgeDocumentStatus(id, isActive),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: knowledgeKeys.list() }),
  });
}
