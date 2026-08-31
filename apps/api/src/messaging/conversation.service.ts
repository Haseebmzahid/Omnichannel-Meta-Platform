import { Injectable } from '@nestjs/common';
import type { Conversation, Prisma } from '../generated/prisma/client';
import { ConversationMode, ConversationStatus } from '../generated/prisma/enums';
import type { ChannelKey } from '../generated/prisma/enums';
import { logger } from '../logging/logger';
import { PrismaService } from '../prisma/prisma.service';
import { ConversationNotFoundException, InvalidModeTransitionException, InvalidStatusTransitionException } from './messaging.errors';
import type { Db } from './messaging.db';

// Task 7-1 — the exact projection the staff inbox list needs per
// conversation: enough to render a sidebar row (contact/patient display
// name, a one-line preview of the latest message) without ever
// materializing a full Contact/Patient/Message row (verifiedPhone,
// channelMeta, etc. are never selected here — see inbox.service.ts for the
// DTO this feeds).
const LIST_INCLUDE = {
  contact: { select: { id: true, displayName: true } },
  patient: { select: { id: true, displayName: true } },
  messages: {
    select: { id: true, text: true, direction: true, senderType: true, createdAt: true },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: 1,
  },
} satisfies Prisma.ConversationInclude;

export type ConversationListRow = Prisma.ConversationGetPayload<{ include: typeof LIST_INCLUDE }>;

// The single-conversation ("detail") projection — a portal legitimately
// needs a bit more than the list row (verified phone/email so staff can
// actually contact the patient, who is assigned) but still never the raw
// Patient.notes field or anything channel-credential-shaped.
const DETAIL_INCLUDE = {
  contact: { select: { id: true, displayName: true } },
  patient: { select: { id: true, displayName: true, verifiedPhone: true, verifiedEmail: true } },
  assignedStaff: { select: { id: true, name: true } },
} satisfies Prisma.ConversationInclude;

export type ConversationDetailRow = Prisma.ConversationGetPayload<{ include: typeof DETAIL_INCLUDE }>;

// Messaging core — conversation resolution + the unified inbox query.
//
// Conversation identity is exactly the documented triple
// (channelKey, channelAccountRef, externalThreadKey) — ADR-003: "A
// Conversation belongs to exactly one channel." This is what makes
// WhatsApp/Instagram/Messenger, and different Meta account refs, provably
// unable to merge: they can never produce the same lookup key.
export interface ResolveConversationInput {
  clinicId: string;
  contactId: string;
  /** Denormalized from the resolved Contact — null for an unresolved contact, never invented here. */
  patientId: string | null;
  channelKey: ChannelKey;
  channelAccountRef: string;
  externalThreadKey: string;
}

export interface ListConversationsForClinicInput {
  clinicId: string;
  channelKey?: ChannelKey;
  status?: ConversationStatus;
  mode?: ConversationMode;
  /** Matches against the linked Contact's or Patient's display name, case-insensitively. */
  search?: string;
  /** Opaque pagination cursor from a previous page's `nextCursor`. */
  cursor?: string;
  limit?: number;
}

export interface ListConversationsForClinicResult {
  conversations: ConversationListRow[];
  nextCursor: string | null;
}

const DEFAULT_PAGE_SIZE = 25;
// Task 7-1, requirement 2 ("sensible maximum page size") — applied here,
// at the primitive itself, not only at the inbox controller boundary, so
// this method is safe regardless of caller.
const MAX_PAGE_SIZE = 100;

@Injectable()
export class ConversationService {
  constructor(private readonly prisma: PrismaService) {}

  // Find-or-create only. Never resets status/mode/assignedStaffId on an
  // existing conversation ("do not reset human ownership automatically")
  // — activity fields (lastMessageAt, unreadCount, ...) are updated
  // separately by recordInboundActivity/recordOutboundActivity, which run
  // only after a message has actually been persisted.
  async resolveOrCreateConversation(input: ResolveConversationInput, client: Db = this.prisma): Promise<Conversation> {
    const existing = await client.conversation.findUnique({
      where: {
        channelKey_channelAccountRef_externalThreadKey: {
          channelKey: input.channelKey,
          channelAccountRef: input.channelAccountRef,
          externalThreadKey: input.externalThreadKey,
        },
      },
    });

    if (existing) return existing;

    // status/mode intentionally omitted — schema defaults (OPEN/AI) apply,
    // matching "initialize the documented status/mode values."
    return client.conversation.create({
      data: {
        clinicId: input.clinicId,
        contactId: input.contactId,
        patientId: input.patientId,
        channelKey: input.channelKey,
        channelAccountRef: input.channelAccountRef,
        externalThreadKey: input.externalThreadKey,
      },
    });
  }

  async recordInboundActivity(conversationId: string, receivedAt: Date, client: Db = this.prisma): Promise<void> {
    await client.conversation.update({
      where: { id: conversationId },
      data: {
        lastMessageAt: receivedAt,
        lastPatientMessageAt: receivedAt,
        unreadCount: { increment: 1 },
      },
    });
  }

  async recordOutboundActivity(conversation: Conversation, sentAt: Date, client: Db = this.prisma): Promise<void> {
    await client.conversation.update({
      where: { id: conversation.id },
      data: {
        lastMessageAt: sentAt,
        // Set once, on the first reply only — never overwritten afterward.
        ...(conversation.firstResponseAt ? {} : { firstResponseAt: sentAt }),
      },
    });
  }

  // The unified inbox: one query across all channels for a clinic — never
  // a per-channel repository method (ADR-003 / 03-conversation-and-inbox.md
  // §2: "The inbox queries across conversations... never merging").
  async listConversationsForClinic(input: ListConversationsForClinicInput): Promise<ListConversationsForClinicResult> {
    const limit = Math.min(input.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);

    const conversations = await this.prisma.conversation.findMany({
      where: {
        clinicId: input.clinicId,
        ...(input.channelKey ? { channelKey: input.channelKey } : {}),
        ...(input.status ? { status: input.status } : {}),
        ...(input.mode ? { mode: input.mode } : {}),
        ...(input.search
          ? {
              OR: [
                { contact: { displayName: { contains: input.search, mode: 'insensitive' } } },
                { patient: { displayName: { contains: input.search, mode: 'insensitive' } } },
              ],
            }
          : {}),
      },
      // Task 7-1 requirement: "prioritize recent activity using the
      // existing lastMessageAt field/index" — unchanged from the original
      // implementation, backed by the existing @@index([clinicId,
      // lastMessageAt]). `id desc` is the deterministic tie-break for rows
      // sharing the same lastMessageAt (including the never-messaged-yet
      // case where it's null on more than one row), and is also what makes
      // the `cursor: { id }` pagination below well-defined.
      orderBy: [{ lastMessageAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
      include: LIST_INCLUDE,
    });

    const hasMore = conversations.length > limit;
    const page = hasMore ? conversations.slice(0, limit) : conversations;
    const last = page[page.length - 1];

    return { conversations: page, nextCursor: hasMore && last ? last.id : null };
  }

  // Task 7-1 — the single-conversation read every staff-inbox mutation
  // below also uses for its own existence-and-ownership check. Same
  // "not found" for a genuinely missing conversation and one that exists
  // under a different clinic — no cross-clinic leakage, exactly like
  // MessageService's existing conversation-ownership checks.
  async getConversationForClinic(clinicId: string, conversationId: string): Promise<ConversationDetailRow> {
    const conversation = await this.prisma.conversation.findFirst({
      where: { id: conversationId, clinicId },
      include: DETAIL_INCLUDE,
    });
    if (!conversation) throw new ConversationNotFoundException(conversationId);
    return conversation;
  }

  // Task 7-1, requirement 5 — "the smallest backend operation required to
  // mark a conversation as read": Conversation.unreadCount is the only
  // persisted unread-state field the architecture documents (no separate
  // read-receipt model exists or is invented here). Resetting it to 0
  // affects staff inbox unread state only — it never touches
  // Message.deliveryStatus, which tracks Meta delivery/read receipts, a
  // completely different concern.
  async markConversationRead(clinicId: string, conversationId: string): Promise<ConversationDetailRow> {
    await this.getConversationForClinic(clinicId, conversationId);
    await this.prisma.conversation.update({ where: { id: conversationId }, data: { unreadCount: 0 } });
    return this.getConversationForClinic(clinicId, conversationId);
  }

  // Task 7-1, requirement 7 — the documented PENDING -> HUMAN mode
  // transition ("staff takes over"), per docs/architecture/
  // 03-conversation-and-inbox.md §5 ("PENDING: Human requested, not yet
  // claimed" / "HUMAN: Staff assigned"). Any other starting mode is
  // rejected. See resumeAiConversation() below for this transition's
  // documented inverse (HUMAN -> AI); any -> PAUSED and SUSPENDED -> AI
  // remain out of scope — see InvalidModeTransitionException's own comment.
  //
  // The guarded `updateMany` (not a plain `update`) is what makes this
  // safe under a race: if two staff members attempt to take over the same
  // PENDING conversation concurrently, only the update whose WHERE clause
  // still matches mode=PENDING at write time succeeds; the loser's
  // `count` comes back 0 and is reported as the same InvalidModeTransition
  // conflict a second, sequential attempt would see — never a silent
  // overwrite of the first staff member's assignment.
  async takeoverConversation(clinicId: string, conversationId: string, staffId: string): Promise<ConversationDetailRow> {
    const conversation = await this.getConversationForClinic(clinicId, conversationId);
    if (conversation.mode !== ConversationMode.PENDING) {
      throw new InvalidModeTransitionException(conversation.mode, ConversationMode.HUMAN);
    }

    const result = await this.prisma.conversation.updateMany({
      where: { id: conversationId, clinicId, mode: ConversationMode.PENDING },
      data: { mode: ConversationMode.HUMAN, assignedStaffId: staffId },
    });
    if (result.count === 0) {
      throw new InvalidModeTransitionException(conversation.mode, ConversationMode.HUMAN);
    }

    return this.getConversationForClinic(clinicId, conversationId);
  }

  // Task 7-8 (Adeeba multilingual retrieval) — the AI -> PENDING transition
  // docs/architecture/03-conversation-and-inbox.md §5 already documents
  // ("on AI-initiated escalation... low confidence... one realistic
  // acknowledgement is sent") but that, until now, nothing ever triggered.
  // Called from escalate-to-human.tool.ts when Adeeba cannot confidently
  // answer a clinic-fact question — surfaces the conversation in the
  // existing staff Inbox exactly like any other PENDING conversation, no
  // new UI needed.
  //
  // Deliberately non-throwing and idempotent, unlike takeoverConversation()
  // above: this is an internal AI safety net, not a staff-initiated HTTP
  // action a caller needs a clear rejection from. If the conversation has
  // already moved on (a human already took over, staff paused it, ...) by
  // the time this runs, that is an unremarkable race, not an error worth
  // surfacing to the model as a tool failure — it simply returns false and
  // the caller (the tool handler) still sends its acknowledgement text.
  // Same guarded-`updateMany` race protection as takeoverConversation().
  async escalateToHuman(clinicId: string, conversationId: string, reason: string): Promise<boolean> {
    const result = await this.prisma.conversation.updateMany({
      where: { id: conversationId, clinicId, mode: ConversationMode.AI },
      data: { mode: ConversationMode.PENDING },
    });

    const escalated = result.count > 0;
    if (escalated) {
      logger.info({ clinicId, conversationId, reason }, 'Conversation escalated to PENDING — AI could not confidently answer');
    }
    return escalated;
  }

  // The documented inverse of takeoverConversation() above: HUMAN -> AI
  // ("staff resumes AI"), per docs/architecture/03-conversation-and-
  // inbox.md §5 — "requires an explicit staff action and a reason. The AI
  // never auto-resumes from HUMAN." `reason` is required (never optional,
  // never defaulted) and recorded on the conversation's own internalNotes
  // — an existing, already-modeled, staff-only field — rather than
  // inventing an AuditLog model this task's schema section explicitly
  // excludes. assignedStaffId is cleared: once AI is back in control, no
  // staff member "owns" the conversation the way HUMAN mode's assignment
  // means, symmetric with takeoverConversation() setting it.
  //
  // Deliberately does NOT re-trigger the orchestrator itself — the "AI
  // orchestrator is given a summary of what the human did" requirement is
  // already satisfied structurally: AiContextService.buildContext() pulls
  // the same persisted message history this resume leaves untouched, and
  // every staff-authored message in it already maps to the 'assistant'
  // role (see ai-context.service.ts's toAIMessageRole()) — so the very
  // next inbound patient message the AI processes already sees what the
  // human said, with no separate summarization step to build.
  //
  // Same guarded-`updateMany` race protection as takeoverConversation():
  // only a write whose WHERE clause still matches mode=HUMAN at commit
  // time succeeds.
  async resumeAiConversation(clinicId: string, conversationId: string, staffId: string, reason: string): Promise<ConversationDetailRow> {
    const conversation = await this.getConversationForClinic(clinicId, conversationId);
    if (conversation.mode !== ConversationMode.HUMAN) {
      throw new InvalidModeTransitionException(conversation.mode, ConversationMode.AI);
    }

    const result = await this.prisma.conversation.updateMany({
      where: { id: conversationId, clinicId, mode: ConversationMode.HUMAN },
      data: {
        mode: ConversationMode.AI,
        assignedStaffId: null,
        internalNotes: { push: `AI resumed by staff ${staffId}: ${reason}` },
      },
    });
    if (result.count === 0) {
      throw new InvalidModeTransitionException(conversation.mode, ConversationMode.AI);
    }

    return this.getConversationForClinic(clinicId, conversationId);
  }

  // Task 7-1, requirement 8 — status transitions. No formal transition
  // graph for `status` is documented anywhere (unlike `mode`, which has a
  // full transition table in 03-conversation-and-inbox.md §5); the one
  // cross-field constraint that *is* documented, in
  // 01-domain-model.md's Conversation section, is enforced below and
  // nothing further is invented on top of it. `resolvedAt` is set exactly
  // when status is RESOLVED and cleared otherwise — its only documented
  // purpose is tracking when a conversation was last resolved.
  async updateConversationStatus(clinicId: string, conversationId: string, status: ConversationStatus): Promise<ConversationDetailRow> {
    const conversation = await this.getConversationForClinic(clinicId, conversationId);

    const movingToTerminal = status === ConversationStatus.RESOLVED || status === ConversationStatus.ARCHIVED;
    if (movingToTerminal && conversation.mode === ConversationMode.PENDING) {
      throw new InvalidStatusTransitionException(
        conversation.status,
        status,
        'a conversation awaiting a human (mode=PENDING) cannot be resolved or archived',
      );
    }

    await this.prisma.conversation.update({
      where: { id: conversationId },
      data: { status, resolvedAt: status === ConversationStatus.RESOLVED ? new Date() : null },
    });
    return this.getConversationForClinic(clinicId, conversationId);
  }
}
