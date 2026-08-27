import { Injectable } from '@nestjs/common';
import type { Conversation } from '../generated/prisma/client';
import type { ChannelKey, ConversationMode, ConversationStatus } from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import type { Db } from './messaging.db';

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
  conversations: Conversation[];
  nextCursor: string | null;
}

const DEFAULT_PAGE_SIZE = 25;

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
    const limit = input.limit ?? DEFAULT_PAGE_SIZE;

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
      orderBy: [{ lastMessageAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
    });

    const hasMore = conversations.length > limit;
    const page = hasMore ? conversations.slice(0, limit) : conversations;
    const last = page[page.length - 1];

    return { conversations: page, nextCursor: hasMore && last ? last.id : null };
  }
}
