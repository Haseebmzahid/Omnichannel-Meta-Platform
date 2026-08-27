import { BadRequestException, HttpException, Injectable } from '@nestjs/common';
import type { Attachment, Conversation, Message } from '../generated/prisma/client';
import { Prisma } from '../generated/prisma/client';
import { MessageDeliveryStatus, MessageDirection, MessageSenderType } from '../generated/prisma/enums';
import { logger } from '../logging/logger';
import { PrismaService } from '../prisma/prisma.service';
import { ConversationService } from './conversation.service';
import { IdentityResolutionService } from './identity-resolution.service';
import {
  ClinicNotFoundException,
  ConversationNotFoundException,
  MessageIdempotencyKeyConflictException,
} from './messaging.errors';
import type {
  NormalizedAttachment,
  NormalizedInboundMessage,
  OutboundDeliveryStatusUpdate,
  OutboundMessageInput,
} from './messaging.types';

export interface MessageWithAttachments extends Message {
  attachments: Attachment[];
}

export interface IngestInboundMessageResult {
  message: MessageWithAttachments;
  conversation: Conversation;
  /** false when this call resolved to an already-ingested message (duplicate delivery). */
  created: boolean;
}

export interface GetConversationMessagesInput {
  clinicId: string;
  conversationId: string;
  cursor?: string;
  limit?: number;
}

export interface GetConversationMessagesResult {
  messages: MessageWithAttachments[];
  nextCursor: string | null;
}

export interface ReconcileDeliveryStatusResult {
  /** null when no Message matches (channelAccountRef, externalMessageId) — a safe no-op, not an error. */
  message: MessageWithAttachments | null;
  /** false for an unknown message, a duplicate, or a stale/out-of-order status that was correctly ignored. */
  applied: boolean;
}

// The smallest sensible monotonic transition policy for
// MessageDeliveryStatus, given the current Meta lifecycle (sent -> delivered
// -> read, with failed reachable any time before delivery is confirmed —
// see WhatsAppOutboundService/whatsapp.normalizer.ts's status mapping) and
// the existing enum (PENDING/SENT/DELIVERED/READ/FAILED — no schema change
// needed, this enum already represents the full lifecycle). No architecture
// doc defines this policy today, so this is deliberately the smallest safe
// rule, not a general state machine:
//
//   - PENDING < SENT < DELIVERED < READ is a strictly increasing
//     progression; a status is only applied if it is *strictly later* in
//     that progression than the message's current status — an equal or
//     earlier status (a duplicate, a retry, or an out-of-order/delayed
//     webhook) is a harmless no-op, never a downgrade.
//   - FAILED is a terminal outcome for a message that never got confirmed
//     delivered: applicable only from PENDING or SENT, never from
//     DELIVERED or READ (a message already confirmed delivered obviously
//     didn't fail to send, whatever a late/out-of-order webhook claims).
//   - FAILED itself is terminal: no further status is applied once a
//     message is FAILED, rather than guessing whether a late success
//     should reopen it.
const DELIVERY_PROGRESSION_RANK: Partial<Record<MessageDeliveryStatus, number>> = {
  [MessageDeliveryStatus.PENDING]: 0,
  [MessageDeliveryStatus.SENT]: 1,
  [MessageDeliveryStatus.DELIVERED]: 2,
  [MessageDeliveryStatus.READ]: 3,
};

function shouldApplyDeliveryStatus(current: MessageDeliveryStatus, incoming: MessageDeliveryStatus): boolean {
  if (incoming === current) return false;
  if (current === MessageDeliveryStatus.FAILED) return false;

  if (incoming === MessageDeliveryStatus.FAILED) {
    return current === MessageDeliveryStatus.PENDING || current === MessageDeliveryStatus.SENT;
  }

  const currentRank = DELIVERY_PROGRESSION_RANK[current];
  const incomingRank = DELIVERY_PROGRESSION_RANK[incoming];
  if (currentRank === undefined || incomingRank === undefined) return false;
  return incomingRank > currentRank;
}

// A duplicate Meta delivery racing the first one can collide on any of the
// three unique keys involved (ChannelIdentity, Conversation, or Message
// itself) — retried, not treated as fatal. See ingestInboundMessage.
const MAX_INGEST_ATTEMPTS = 3;
const DEFAULT_PAGE_SIZE = 50;

@Injectable()
export class MessageService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly identityResolution: IdentityResolutionService,
    private readonly conversationService: ConversationService,
  ) {}

  // The idempotent inbound-ingestion boundary. (channelAccountRef,
  // externalMessageId) is the documented idempotency identity
  // (01-domain-model.md §2 Message: "external_id per channel_account_ref")
  // — already enforced by the existing @@unique([channelAccountRef,
  // externalId]) constraint, no schema change needed.
  //
  // Safety strategy: a cheap existence check first (the common,
  // non-racing duplicate-delivery case), then a transaction that resolves
  // identity + conversation + creates the message atomically. If a
  // concurrent delivery wins a race on ANY of the three unique
  // constraints involved (ChannelIdentity / Conversation / Message), the
  // whole transaction aborts with a Postgres unique-violation and is
  // retried from the top — the retry's fresh existence checks then see
  // whatever the winning transaction committed and reuse it. This is a
  // database-constraint-driven strategy, not an in-memory lock, and
  // requires no elevated transaction isolation: each of the three checks
  // is a genuine unique-key lookup, which Postgres enforces correctly
  // under the default isolation level regardless of concurrency.
  async ingestInboundMessage(input: NormalizedInboundMessage): Promise<IngestInboundMessageResult> {
    const clinic = await this.prisma.clinic.findUnique({ where: { id: input.clinicId } });
    if (!clinic) throw new ClinicNotFoundException(input.clinicId);

    for (let attempt = 1; attempt <= MAX_INGEST_ATTEMPTS; attempt++) {
      const existing = await this.findMessageByIdempotencyKey(input.channelAccountRef, input.externalMessageId);
      if (existing) {
        const conversation = await this.prisma.conversation.findUniqueOrThrow({ where: { id: existing.conversationId } });
        return { message: existing, conversation, created: false };
      }

      try {
        return await this.prisma.$transaction(async (tx) => {
          const { contact } = await this.identityResolution.resolveContact(
            {
              channelKey: input.channelKey,
              channelAccountRef: input.channelAccountRef,
              externalContactId: input.externalContactId,
              displayNameAtChannel: input.senderDisplayName,
            },
            tx,
          );

          const conversation = await this.conversationService.resolveOrCreateConversation(
            {
              clinicId: input.clinicId,
              contactId: contact.id,
              patientId: contact.patientId,
              channelKey: input.channelKey,
              channelAccountRef: input.channelAccountRef,
              externalThreadKey: input.externalThreadKey,
            },
            tx,
          );

          const message = await tx.message.create({
            data: {
              conversationId: conversation.id,
              channelKey: input.channelKey,
              channelAccountRef: input.channelAccountRef,
              direction: MessageDirection.INBOUND,
              senderType: MessageSenderType.PATIENT,
              contentType: input.contentType,
              text: input.text,
              choiceSelection: toJsonInput(input.choiceSelection),
              externalId: input.externalMessageId,
              externalReplyToId: input.replyToExternalMessageId,
              receivedAt: input.receivedAt,
              channelMeta: toJsonInput(input.channelMeta),
              attachments: input.attachments ? { create: input.attachments.map(toAttachmentCreateInput) } : undefined,
            },
            include: { attachments: true },
          });

          await this.conversationService.recordInboundActivity(conversation.id, input.receivedAt, tx);

          return { message, conversation, created: true };
        });
      } catch (err) {
        if (isUniqueConstraintViolation(err) && attempt < MAX_INGEST_ATTEMPTS) {
          continue;
        }
        this.handleUnexpectedError(err, 'ingest inbound message');
      }
    }
    // Unreachable — the loop above always returns or throws.
    throw new Error('ingestInboundMessage: exhausted retry attempts unexpectedly.');
  }

  // Records an AI- or staff-generated message. Does not call the channel's
  // API itself — that is the calling channel adapter's job (e.g.
  // apps/api/src/channels/whatsapp/whatsapp-outbound.service.ts). Uses the
  // existing MessageDirection/MessageSenderType enums as-is;
  // deliveryStatus defaults to PENDING per schema and is only ever
  // advanced afterward, by markOutboundMessageSent()/
  // markOutboundMessageFailed() — this method never optimistically writes
  // a "sent" state before the channel adapter actually knows the outcome.
  //
  // When input.idempotencyKey is supplied, a repeated call with the same
  // key returns the original row unchanged instead of creating a second
  // logical outbound message — the boundary a retried send operation
  // checks before ever calling the channel's API (see
  // Message.idempotencyKey in schema.prisma). Reuses the exact
  // check-then-create-with-retry-on-race strategy already established by
  // ingestInboundMessage() above, not a second idempotency mechanism.
  async persistOutboundMessage(input: OutboundMessageInput): Promise<MessageWithAttachments> {
    if (input.senderType === 'STAFF' && !input.senderStaffId) {
      throw new BadRequestException('senderStaffId is required when senderType is STAFF.');
    }

    const conversation = await this.prisma.conversation.findFirst({
      where: { id: input.conversationId, clinicId: input.clinicId },
    });
    if (!conversation) throw new ConversationNotFoundException(input.conversationId);

    if (!input.idempotencyKey) {
      return this.createOutboundMessage(conversation, input);
    }

    for (let attempt = 1; attempt <= MAX_INGEST_ATTEMPTS; attempt++) {
      const existing = await this.findMessageByOutboundIdempotencyKey(input.idempotencyKey);
      if (existing) {
        this.assertIdempotentOutboundReplayMatches(existing, input);
        return existing;
      }

      try {
        return await this.createOutboundMessage(conversation, input);
      } catch (err) {
        if (isUniqueConstraintViolation(err) && attempt < MAX_INGEST_ATTEMPTS) {
          continue;
        }
        this.handleUnexpectedError(err, 'persist outbound message');
      }
    }
    // Unreachable — the loop above always returns or throws.
    throw new Error('persistOutboundMessage: exhausted retry attempts unexpectedly.');
  }

  // Advances a PENDING outbound row to SENT once the channel adapter has
  // confirmed the send and knows the channel's own message id. The only
  // path that ever sets externalId on an outbound row.
  async markOutboundMessageSent(messageId: string, externalId: string): Promise<MessageWithAttachments> {
    try {
      return await this.prisma.message.update({
        where: { id: messageId },
        data: { externalId, deliveryStatus: MessageDeliveryStatus.SENT },
        include: { attachments: true },
      });
    } catch (err) {
      this.handleUnexpectedError(err, 'mark outbound message sent');
    }
  }

  // Advances a PENDING outbound row to FAILED. failureMessage must already
  // be a safe, static string owned by the caller — never a raw channel
  // error payload or anything containing a secret (Part 12 instruction).
  async markOutboundMessageFailed(
    messageId: string,
    failure: { failureClass: string; failureCode?: string; failureMessage?: string },
  ): Promise<MessageWithAttachments> {
    try {
      return await this.prisma.message.update({
        where: { id: messageId },
        data: {
          deliveryStatus: MessageDeliveryStatus.FAILED,
          failureClass: failure.failureClass,
          failureCode: failure.failureCode,
          failureMessage: failure.failureMessage,
        },
        include: { attachments: true },
      });
    } catch (err) {
      this.handleUnexpectedError(err, 'mark outbound message failed');
    }
  }

  // Reconciles an outbound Message against a channel's delivery/read/failure
  // status callback (see whatsapp.normalizer.ts for the WhatsApp mapping).
  // Locates the Message via the same (channelAccountRef, externalId)
  // compound key already used as the inbound idempotency identity — this is
  // deliberately channel/account-scoped by construction (Part 4
  // instruction): a status event carrying a channelAccountRef that doesn't
  // match the stored message's simply finds nothing, so a status event
  // misrouted to (or spoofing) another account's channelAccountRef can
  // never reach a message it doesn't own. No separate clinic check is
  // needed on top of that — the same guarantee ingestInboundMessage already
  // relies on for this exact compound key.
  //
  // Safe on every edge case Part 9 calls out: unknown external message id
  // (message stays null, applied: false, logged at info — not an error),
  // a duplicate or stale/out-of-order status (rejected by
  // shouldApplyDeliveryStatus, applied: false, existing row returned
  // unchanged), and a status event that isn't for an OUTBOUND message
  // (defensive — Meta status callbacks only exist for messages this system
  // sent, but never trust that structurally).
  async reconcileOutboundDeliveryStatus(update: OutboundDeliveryStatusUpdate): Promise<ReconcileDeliveryStatusResult> {
    const existing = await this.findMessageByIdempotencyKey(update.channelAccountRef, update.externalMessageId);
    if (!existing) {
      logger.info({ channelAccountRef: update.channelAccountRef }, 'Messaging: status update for unknown external message id, skipping');
      return { message: null, applied: false };
    }

    if (existing.direction !== MessageDirection.OUTBOUND) {
      logger.warn({ messageId: existing.id }, 'Messaging: status update targeted a non-outbound message, skipping');
      return { message: existing, applied: false };
    }

    if (!shouldApplyDeliveryStatus(existing.deliveryStatus, update.status)) {
      return { message: existing, applied: false };
    }

    try {
      const message = await this.prisma.message.update({
        where: { id: existing.id },
        data: {
          deliveryStatus: update.status,
          ...(update.status === MessageDeliveryStatus.FAILED
            ? { failureClass: update.failureClass, failureCode: update.failureCode, failureMessage: update.failureMessage }
            : {}),
        },
        include: { attachments: true },
      });
      return { message, applied: true };
    } catch (err) {
      this.handleUnexpectedError(err, 'reconcile outbound delivery status');
    }
  }

  private async createOutboundMessage(conversation: Conversation, input: OutboundMessageInput): Promise<MessageWithAttachments> {
    const sentAt = input.sentAt ?? new Date();

    return this.prisma.$transaction(async (tx) => {
      const message = await tx.message.create({
        data: {
          conversationId: conversation.id,
          channelKey: conversation.channelKey,
          channelAccountRef: conversation.channelAccountRef,
          direction: MessageDirection.OUTBOUND,
          senderType: input.senderType === 'AI' ? MessageSenderType.AI : MessageSenderType.STAFF,
          senderStaffId: input.senderType === 'STAFF' ? input.senderStaffId : undefined,
          aiGenerated: input.senderType === 'AI',
          contentType: input.contentType,
          text: input.text,
          choiceSelection: toJsonInput(input.choiceSelection),
          replyToId: input.replyToId,
          idempotencyKey: input.idempotencyKey,
          sentAt,
          channelMeta: toJsonInput(input.channelMeta),
          attachments: input.attachments ? { create: input.attachments.map(toAttachmentCreateInput) } : undefined,
        },
        include: { attachments: true },
      });

      await this.conversationService.recordOutboundActivity(conversation, sentAt, tx);

      return message;
    });
  }

  // A replayed idempotency key must describe the identical logical send
  // (same conversation, same text) — reusing a key for a genuinely
  // different message is a caller bug, not a retry, and is rejected rather
  // than silently returning the wrong row. Mirrors AppointmentService's
  // own assertIdempotentReplayMatches.
  private assertIdempotentOutboundReplayMatches(existing: MessageWithAttachments, input: OutboundMessageInput): void {
    if (existing.conversationId !== input.conversationId || existing.text !== input.text) {
      // input.idempotencyKey is defined on every call site that reaches
      // this method (see persistOutboundMessage above).
      throw new MessageIdempotencyKeyConflictException(input.idempotencyKey as string);
    }
  }

  private async findMessageByOutboundIdempotencyKey(idempotencyKey: string): Promise<MessageWithAttachments | null> {
    return this.prisma.message.findUnique({ where: { idempotencyKey }, include: { attachments: true } });
  }

  // Message history for one conversation — conversation-scoped,
  // chronological, paginated, clinic-checked before any row is returned
  // (no cross-clinic leakage), no channel-specific branching.
  async getConversationMessages(input: GetConversationMessagesInput): Promise<GetConversationMessagesResult> {
    const conversation = await this.prisma.conversation.findFirst({
      where: { id: input.conversationId, clinicId: input.clinicId },
    });
    if (!conversation) throw new ConversationNotFoundException(input.conversationId);

    const limit = input.limit ?? DEFAULT_PAGE_SIZE;

    const messages = await this.prisma.message.findMany({
      where: { conversationId: input.conversationId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: limit + 1,
      ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
      include: { attachments: true },
    });

    const hasMore = messages.length > limit;
    const page = hasMore ? messages.slice(0, limit) : messages;
    const last = page[page.length - 1];

    return { messages: page, nextCursor: hasMore && last ? last.id : null };
  }

  private async findMessageByIdempotencyKey(
    channelAccountRef: string,
    externalId: string,
  ): Promise<MessageWithAttachments | null> {
    return this.prisma.message.findUnique({
      where: { channelAccountRef_externalId: { channelAccountRef, externalId } },
      include: { attachments: true },
    });
  }

  // Part 9 — logs metadata only, never a raw Prisma/database error and
  // never message content (message bodies can carry patient PII — never
  // logged by default).
  private handleUnexpectedError(err: unknown, action: string): never {
    if (err instanceof HttpException) throw err;
    const safe = err instanceof Error ? { name: err.name, message: err.message } : { message: 'Unknown error' };
    logger.error({ err: safe }, `Messaging: failed to ${action}`);
    throw new Error(`Failed to ${action}.`);
  }
}

function isUniqueConstraintViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

function toJsonInput(value: unknown): Prisma.InputJsonValue | undefined {
  return value === undefined ? undefined : (value as Prisma.InputJsonValue);
}

function toAttachmentCreateInput(attachment: NormalizedAttachment): Prisma.AttachmentCreateWithoutMessageInput {
  return {
    type: attachment.type,
    storageRef: attachment.storageRef,
    mime: attachment.mime,
    bytes: attachment.bytes,
    caption: attachment.caption,
    source: attachment.source,
  };
}
