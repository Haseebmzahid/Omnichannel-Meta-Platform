import { BadRequestException, Injectable } from '@nestjs/common';
import { ChannelKey, MessageContentType, MessageDeliveryStatus } from '../../generated/prisma/enums';
import { logger } from '../../logging/logger';
import type { MessageWithAttachments } from '../../messaging/message.service';
import { MessageService } from '../../messaging/message.service';
import { ConversationNotFoundException } from '../../messaging/messaging.errors';
import { PrismaService } from '../../prisma/prisma.service';
import { WhatsAppSendException } from './whatsapp.errors';
import { WhatsAppSendService } from './whatsapp-send.service';

export interface SendWhatsAppTextInput {
  clinicId: string;
  conversationId: string;
  text: string;
  /** Only AI or STAFF originate outbound messages — never PATIENT/SYSTEM. */
  senderType: 'AI' | 'STAFF';
  /** Required when senderType is STAFF. */
  senderStaffId?: string;
  /** See Message.idempotencyKey — omit for a one-off send with no natural retry key. */
  idempotencyKey?: string;
}

export interface SendWhatsAppTextResult {
  message: MessageWithAttachments;
  delivered: boolean;
  /** Present only when delivered is false — a safe, non-technical summary, never a raw Meta error. */
  failureReason?: string;
}

// The channel-neutral outbound application operation this task's Part 2
// asks for, implemented for WhatsApp: validate -> resolve the WhatsApp
// recipient from the existing Conversation/ChannelIdentity architecture ->
// persist PENDING through MessageService (Messaging Core) -> call the
// WhatsApp adapter -> reconcile the persisted row with Meta's outcome ->
// return a safe, normalized result. Never touches Prisma for anything the
// Messaging Core already owns (identity/conversation/message persistence)
// — the one direct Prisma read here is the clinic-scoped Conversation
// lookup that resolves the recipient, which is exactly this operation's
// own job per Part 5 ("never require the caller to manually construct
// arbitrary Meta IDs").
@Injectable()
export class WhatsAppOutboundService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly messageService: MessageService,
    private readonly sendService: WhatsAppSendService,
  ) {}

  async sendText(input: SendWhatsAppTextInput): Promise<SendWhatsAppTextResult> {
    if (!input.text.trim()) {
      throw new BadRequestException('text must not be empty.');
    }

    // Clinic-scoped by construction: a conversation belonging to another
    // clinic (or a non-WhatsApp conversation) simply does not match this
    // query and resolves to "not found" — never a cross-clinic send, and
    // never a caller-supplied wa_id (Part 5 instruction).
    const conversation = await this.prisma.conversation.findFirst({
      where: { id: input.conversationId, clinicId: input.clinicId, channelKey: ChannelKey.WHATSAPP },
    });
    if (!conversation) throw new ConversationNotFoundException(input.conversationId);

    // Conversation.externalThreadKey IS the wa_id for a WhatsApp
    // conversation (see whatsapp.normalizer.ts's inbound normalization,
    // which sets externalThreadKey = message.from) — no separate
    // ChannelIdentity lookup is needed to recover it.
    const recipientWaId = conversation.externalThreadKey;

    // Persisted PENDING first (Messaging Core's existing default), before
    // Meta is ever called — see message.service.ts's persistOutboundMessage
    // doc comment. An idempotencyKey replay short-circuits here with the
    // original row, already reconciled or not; either way Meta is never
    // called a second time for the same logical send.
    const message = await this.messageService.persistOutboundMessage({
      clinicId: input.clinicId,
      conversationId: conversation.id,
      direction: 'OUTBOUND',
      senderType: input.senderType,
      senderStaffId: input.senderStaffId,
      contentType: MessageContentType.TEXT,
      text: input.text,
      idempotencyKey: input.idempotencyKey,
    });

    if (message.deliveryStatus !== MessageDeliveryStatus.PENDING) {
      return {
        message,
        delivered: message.deliveryStatus === MessageDeliveryStatus.SENT,
        failureReason: message.deliveryStatus === MessageDeliveryStatus.FAILED ? (message.failureMessage ?? undefined) : undefined,
      };
    }

    try {
      const result = await this.sendService.sendText(recipientWaId, input.text);
      const sent = await this.messageService.markOutboundMessageSent(message.id, result.externalMessageId);
      return { message: sent, delivered: true };
    } catch (err) {
      const failure = toFailureRecord(err);
      const failed = await this.messageService.markOutboundMessageFailed(message.id, failure);

      // A known, classified send failure (bad auth, window closed, Meta
      // rejected the request, network unreachable) is a normal business
      // outcome — the Message row now correctly says FAILED, and the
      // caller gets a safe summary back rather than a thrown exception.
      if (err instanceof WhatsAppSendException) {
        return { message: failed, delivered: false, failureReason: failure.failureMessage };
      }

      // Anything else is unexpected (a bug, not a documented Meta outcome).
      // The row is still correctly reconciled to FAILED above — never left
      // PENDING — but this is re-thrown rather than swallowed, matching
      // MessageService.handleUnexpectedError's own convention: log safe
      // metadata only, throw a generic message, never leak internals.
      const safe = err instanceof Error ? { name: err.name, message: err.message } : { message: 'Unknown error' };
      logger.error({ err: safe }, 'WhatsApp: outbound send failed unexpectedly');
      throw new Error('Failed to send WhatsApp message.');
    }
  }
}

function toFailureRecord(err: unknown): { failureClass: string; failureCode?: string; failureMessage: string } {
  if (err instanceof WhatsAppSendException) {
    return {
      failureClass: err.failureClass,
      failureCode: err.metaErrorCode !== undefined ? String(err.metaErrorCode) : undefined,
      failureMessage: err.message,
    };
  }
  return { failureClass: 'unknown', failureMessage: 'WhatsApp send failed unexpectedly.' };
}
