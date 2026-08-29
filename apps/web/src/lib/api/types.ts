// Hand-mirrored from the backend's own contract — never guessed. Sources:
//   apps/api/src/generated/prisma/enums.ts   (enums)
//   apps/api/src/inbox/inbox.types.ts        (Inbox DTOs)
//   apps/api/src/auth/auth.types.ts          (AuthenticatedStaffSummary)
// packages/shared-types is still an empty scaffold (Task 7-3 inspection
// confirmed this — see the final report), so these are not re-exports of a
// shared package; they are this app's own copy, kept honest to the backend
// by construction. Wiring up packages/shared-types so both apps import one
// definition is a reasonable follow-up, not done here to keep this task's
// backend footprint minimal.

export const StaffRole = {
  ADMIN: 'ADMIN',
  MANAGER: 'MANAGER',
  AGENT: 'AGENT',
  READ_ONLY: 'READ_ONLY',
} as const;
export type StaffRole = (typeof StaffRole)[keyof typeof StaffRole];

export const ChannelKey = {
  WHATSAPP: 'WHATSAPP',
  INSTAGRAM: 'INSTAGRAM',
  MESSENGER: 'MESSENGER',
} as const;
export type ChannelKey = (typeof ChannelKey)[keyof typeof ChannelKey];

export const ConversationStatus = {
  OPEN: 'OPEN',
  SNOOZED: 'SNOOZED',
  RESOLVED: 'RESOLVED',
  ARCHIVED: 'ARCHIVED',
} as const;
export type ConversationStatus = (typeof ConversationStatus)[keyof typeof ConversationStatus];

export const ConversationMode = {
  AI: 'AI',
  PENDING: 'PENDING',
  HUMAN: 'HUMAN',
  PAUSED: 'PAUSED',
  SUSPENDED: 'SUSPENDED',
} as const;
export type ConversationMode = (typeof ConversationMode)[keyof typeof ConversationMode];

export const MessageDirection = {
  INBOUND: 'INBOUND',
  OUTBOUND: 'OUTBOUND',
} as const;
export type MessageDirection = (typeof MessageDirection)[keyof typeof MessageDirection];

export const MessageSenderType = {
  PATIENT: 'PATIENT',
  AI: 'AI',
  STAFF: 'STAFF',
  SYSTEM: 'SYSTEM',
} as const;
export type MessageSenderType = (typeof MessageSenderType)[keyof typeof MessageSenderType];

export const MessageContentType = {
  TEXT: 'TEXT',
  MEDIA: 'MEDIA',
  CHOICE_REPLY: 'CHOICE_REPLY',
  LOCATION: 'LOCATION',
  CONTACT: 'CONTACT',
  SYSTEM_EVENT: 'SYSTEM_EVENT',
  UNSUPPORTED: 'UNSUPPORTED',
} as const;
export type MessageContentType = (typeof MessageContentType)[keyof typeof MessageContentType];

export const MessageDeliveryStatus = {
  PENDING: 'PENDING',
  SENT: 'SENT',
  DELIVERED: 'DELIVERED',
  READ: 'READ',
  FAILED: 'FAILED',
} as const;
export type MessageDeliveryStatus = (typeof MessageDeliveryStatus)[keyof typeof MessageDeliveryStatus];

export const AttachmentType = {
  IMAGE: 'IMAGE',
  VIDEO: 'VIDEO',
  AUDIO: 'AUDIO',
  DOCUMENT: 'DOCUMENT',
  VOICE: 'VOICE',
  STICKER: 'STICKER',
  UNSUPPORTED: 'UNSUPPORTED',
} as const;
export type AttachmentType = (typeof AttachmentType)[keyof typeof AttachmentType];

// --- auth.types.ts: AuthenticatedStaffSummary ---------------------------

export interface StaffSummary {
  id: string;
  name: string;
  email: string;
  role: StaffRole;
  clinicId: string;
}

// --- staff.types.ts: StaffSummaryDto (Task 7-3's staff-management API) --
// A distinct type from StaffSummary above (that one is "who is logged in",
// this one is "a row in the staff-management list") — mirrors the backend's
// own StaffSummaryDto exactly, never passwordHash/mfaSecret.

export const StaffStatus = {
  ACTIVE: 'ACTIVE',
  DISABLED: 'DISABLED',
} as const;
export type StaffStatus = (typeof StaffStatus)[keyof typeof StaffStatus];

export interface Staff {
  id: string;
  name: string;
  email: string;
  role: StaffRole;
  status: StaffStatus;
  clinicId: string;
  lastLoginAt: string | null;
  createdAt: string;
}

// clinicId is deliberately absent — apps/api/src/staff/staff.controller.ts
// derives it from the session cookie and drops any caller-supplied value.
export interface CreateStaffInput {
  name: string;
  email: string;
  password: string;
  role: StaffRole;
}

// --- knowledge.types.ts: KnowledgeDocumentSummaryDto (Task 7-7's
// knowledge-authoring API) ------------------------------------------------
// Distinct from ClinicKnowledgeResultItem (the AI-tool's own, never-exposed
// shape) — this is the staff-facing management projection, which does
// include id/tags/isActive/timestamps because a management UI genuinely
// needs them to identify, edit, and disable a specific row.

export const KnowledgeCategory = {
  CLINIC_INFO: 'CLINIC_INFO',
  DOCTOR: 'DOCTOR',
  SERVICE: 'SERVICE',
  FEE: 'FEE',
  HOURS: 'HOURS',
  LOCATION: 'LOCATION',
  POLICY: 'POLICY',
  FAQ: 'FAQ',
} as const;
export type KnowledgeCategory = (typeof KnowledgeCategory)[keyof typeof KnowledgeCategory];

export interface KnowledgeDocument {
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

// clinicId is deliberately absent — apps/api/src/knowledge/knowledge.controller.ts
// derives it from the session cookie and drops any caller-supplied value.
export interface CreateKnowledgeDocumentInput {
  category: KnowledgeCategory;
  title: string;
  body: string;
  tags: string[];
}

export type UpdateKnowledgeDocumentInput = CreateKnowledgeDocumentInput;

// --- inbox.types.ts -------------------------------------------------------

export interface InboxContactSummary {
  id: string;
  displayName: string | null;
}

export interface InboxPatientSummary {
  id: string;
  displayName: string;
}

export interface InboxPatientDetail extends InboxPatientSummary {
  verifiedPhone: string | null;
  verifiedEmail: string | null;
}

export interface InboxMessagePreview {
  text: string;
  direction: MessageDirection;
  senderType: MessageSenderType;
  createdAt: string;
}

export interface InboxConversationSummary {
  id: string;
  channel: ChannelKey;
  status: ConversationStatus;
  mode: ConversationMode;
  contact: InboxContactSummary;
  patient: InboxPatientSummary | null;
  assignedStaffId: string | null;
  unreadCount: number;
  lastMessageAt: string | null;
  lastMessagePreview: InboxMessagePreview | null;
  externalThreadKey: string;
}

export interface InboxConversationDetail {
  id: string;
  channel: ChannelKey;
  status: ConversationStatus;
  mode: ConversationMode;
  contact: InboxContactSummary;
  patient: InboxPatientDetail | null;
  assignedStaff: { id: string; name: string } | null;
  unreadCount: number;
  externalThreadKey: string;
  windowExpiresAt: string | null;
  windowType: string | null;
  extensionExpiresAt: string | null;
  labels: string[];
  internalNotes: string[];
  lastMessageAt: string | null;
  lastPatientMessageAt: string | null;
  firstResponseAt: string | null;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

// Task 7-9 — storageRef is deliberately not part of this DTO (the backend
// stopped sending it): it's an internal object-storage key with no use to
// the browser now that GET /inbox/attachments/:id exists — see
// useAttachmentUrl (features/inbox/hooks.ts), which fetches a short-lived
// signed URL by attachment id instead.
export interface InboxAttachmentDto {
  id: string;
  type: AttachmentType;
  mime: string | null;
  caption: string | null;
}

export interface InboxAttachmentUrlDto {
  url: string;
  expiresInSeconds: number;
}

export interface InboxMessageDto {
  id: string;
  direction: MessageDirection;
  senderType: MessageSenderType;
  senderStaffId: string | null;
  contentType: MessageContentType;
  text: string;
  deliveryStatus: MessageDeliveryStatus;
  externalId: string | null;
  createdAt: string;
  attachments: InboxAttachmentDto[];
}

export interface CursorPage<T> {
  items: T[];
  nextCursor: string | null;
}

export interface ListConversationsParams {
  channel?: ChannelKey;
  status?: ConversationStatus;
  mode?: ConversationMode;
  search?: string;
  cursor?: string;
  limit?: number;
}

export interface GetMessagesParams {
  cursor?: string;
  limit?: number;
}

export interface InboxReplyResultDto {
  messageId: string;
  channel: ChannelKey;
  deliveryStatus: MessageDeliveryStatus;
  delivered: boolean;
  failureReason?: string;
}
