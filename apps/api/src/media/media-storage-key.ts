// Storage keys are always clinic- and message-scoped — never a caller-
// chosen path — so two clinics' media (or two messages' attachments) can
// never collide, and a leaked/guessed key from one clinic reveals nothing
// about another's key beyond the shared prefix shape. Deterministic (same
// inputs -> same key) so re-uploading the same attachment (e.g. a retried
// webhook delivery) overwrites the same object instead of accumulating
// orphaned copies — no separate dedup logic needed here.
export interface MediaStorageKeyInput {
  clinicId: string;
  messageId: string;
  attachmentId: string;
}

export function buildMediaStorageKey(input: MediaStorageKeyInput): string {
  return `clinics/${input.clinicId}/messages/${input.messageId}/attachments/${input.attachmentId}`;
}
