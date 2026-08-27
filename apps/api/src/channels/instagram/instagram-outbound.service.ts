import { BadRequestException, Injectable } from '@nestjs/common';
import { ChannelKey, MessageContentType, MessageDeliveryStatus } from '../../generated/prisma/enums';
import { logger } from '../../logging/logger';
import type { MessageWithAttachments } from '../../messaging/message.service';
import { MessageService } from '../../messaging/message.service';
import { ConversationNotFoundException } from '../../messaging/messaging.errors';
import { PrismaService } from '../../prisma/prisma.service';
import { InstagramSendException } from './instagram.errors';
import { InstagramSendService } from './instagram-send.service';

export interface SendInstagramTextInput {
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

export interface SendInstagramTextResult {
  message: MessageWithAttachments;
  delivered: boolean;
  /** Present only when delivered is false — a safe, non-technical summary, never a raw Meta error. */
  failureReason?: string;
}

// The channel-neutral outbound application operation, implemented for
// Instagram — mirrors ../whatsapp/whatsapp-outbound.service.ts exactly:
// validate -> resolve the Instagram recipient from the existing
// Conversation architecture -> persist PENDING through MessageService
// (Messaging Core) -> call the Instagram adapter -> reconcile the
// persisted row with Meta's outcome -> return a safe, normalized result.
// Never touches Prisma for anything the Messaging Core already owns
// (identity/conversation/message persistence) — the one direct Prisma read
// here is the clinic-scoped Conversation lookup that resolves the
// recipient, which is exactly this operation's own job (never require the
// caller to manually construct an arbitrary IGSID).
//
// Known, accepted limitation (not solved here): a crash between Meta
// confirming the send and this service reconciling the Message row to SENT
// can theoretically leave a message stuck PENDING despite having actually
// been delivered, risking a duplicate on a naive retry. This is the same
// limitation WhatsAppOutboundService already carries — Message.idempotencyKey
// bounds *this system's* retries, not Meta's own at-least-once delivery
// guarantees on its side; no new mechanism is invented to close that gap.
@Injectable()
export class InstagramOutboundService {
  // Identity tag for ChannelOutboundDispatcher's adapter registry (see
  // ../channel-outbound.types.ts) — the only change this class needed to
  // satisfy that channel-neutral contract, since SendInstagramTextInput/
  // SendInstagramTextResult already structurally match it.
  readonly channel = ChannelKey.INSTAGRAM;

  constructor(
    private readonly prisma: PrismaService,
    private readonly messageService: MessageService,
    private readonly sendService: InstagramSendService,
  ) {}

  async sendText(input: SendInstagramTextInput): Promise<SendInstagramTextResult> {
    if (!input.text.trim()) {
      throw new BadRequestException('text must not be empty.');
    }

    // Clinic-scoped by construction: a conversation belonging to another
    // clinic (or a non-Instagram conversation) simply does not match this
    // query and resolves to "not found" — never a cross-clinic send, and
    // never a caller-supplied IGSID.
    const conversation = await this.prisma.conversation.findFirst({
      where: { id: input.conversationId, clinicId: input.clinicId, channelKey: ChannelKey.INSTAGRAM },
    });
    if (!conversation) throw new ConversationNotFoundException(input.conversationId);

    // Conversation.externalThreadKey IS the sender's IGSID for an Instagram
    // conversation (see instagram.normalizer.ts's inbound normalization,
    // which sets externalThreadKey = event.sender.id) — no separate
    // ChannelIdentity lookup is needed to recover it.
    const recipientIgsid = conversation.externalThreadKey;

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
      const result = await this.sendService.sendText(recipientIgsid, input.text);
      const sent = await this.messageService.markOutboundMessageSent(message.id, result.externalMessageId);
      return { message: sent, delivered: true };
    } catch (err) {
      const failure = toFailureRecord(err);
      const failed = await this.messageService.markOutboundMessageFailed(message.id, failure);

      // A known, classified send failure (bad auth, window closed, Meta
      // rejected the request, network unreachable) is a normal business
      // outcome — the Message row now correctly says FAILED, and the
      // caller gets a safe summary back rather than a thrown exception.
      if (err instanceof InstagramSendException) {
        return { message: failed, delivered: false, failureReason: failure.failureMessage };
      }

      // Anything else is unexpected (a bug, not a documented Meta outcome).
      // The row is still correctly reconciled to FAILED above — never left
      // PENDING — but this is re-thrown rather than swallowed, matching
      // MessageService.handleUnexpectedError's own convention: log safe
      // metadata only, throw a generic message, never leak internals.
      const safe = err instanceof Error ? { name: err.name, message: err.message } : { message: 'Unknown error' };
      logger.error({ err: safe }, 'Instagram: outbound send failed unexpectedly');
      throw new Error('Failed to send Instagram message.');
    }
  }
}

function toFailureRecord(err: unknown): { failureClass: string; failureCode?: string; failureMessage: string } {
  if (err instanceof InstagramSendException) {
    return {
      failureClass: err.failureClass,
      failureCode: err.metaErrorCode !== undefined ? String(err.metaErrorCode) : undefined,
      failureMessage: err.message,
    };
  }
  return { failureClass: 'unknown', failureMessage: 'Instagram send failed unexpectedly.' };
}
