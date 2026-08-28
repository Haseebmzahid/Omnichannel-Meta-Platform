import { Injectable } from '@nestjs/common';
import { ChannelKey } from '../generated/prisma/enums';
import { ConversationNotFoundException } from '../messaging/messaging.errors';
import { PrismaService } from '../prisma/prisma.service';
import { UnsupportedOutboundChannelException } from './channel-outbound.errors';
import type { ChannelOutboundAdapter, ChannelOutboundResult, ChannelOutboundTextInput } from './channel-outbound.types';
import { InstagramOutboundService } from './instagram/instagram-outbound.service';
import { MessengerOutboundService } from './messenger/messenger-outbound.service';
import { WhatsAppOutboundService } from './whatsapp/whatsapp-outbound.service';

// The channel-neutral outbound entry point AI/staff should depend on
// instead of picking a channel-specific service themselves:
//
//   AI / Staff -> ChannelOutboundDispatcher -> WhatsAppOutboundService
//                                            -> InstagramOutboundService
//                                            -> MessengerOutboundService
//
// Deliberately thin — it does NOT duplicate anything the channel adapters
// already own (conversation/clinic validation, recipient resolution,
// Message persistence, idempotency, the Meta call, SENT/FAILED
// reconciliation). Its only two jobs are:
//   1. a cheap read of the conversation's channelKey, to pick the right
//      adapter (the adapters still independently re-validate
//      clinic+channel scoping themselves — this is not a second copy of
//      that validation, just enough information to route correctly);
//   2. delegating to that adapter's sendText(), then narrowing its result
//      to the channel-neutral ChannelOutboundResult shape.
//
// Never accepts or resolves a recipient id itself — that continues to come
// from the channel adapter's own Conversation-based resolution, exactly as
// before this dispatcher existed.
@Injectable()
export class ChannelOutboundDispatcher {
  private readonly adapters: Map<ChannelKey, ChannelOutboundAdapter>;

  constructor(
    private readonly prisma: PrismaService,
    whatsAppOutbound: WhatsAppOutboundService,
    instagramOutbound: InstagramOutboundService,
    messengerOutbound: MessengerOutboundService,
  ) {
    this.adapters = new Map<ChannelKey, ChannelOutboundAdapter>([
      [ChannelKey.WHATSAPP, whatsAppOutbound],
      [ChannelKey.INSTAGRAM, instagramOutbound],
      [ChannelKey.MESSENGER, messengerOutbound],
    ]);
  }

  async sendText(input: ChannelOutboundTextInput): Promise<ChannelOutboundResult> {
    // Clinic-scoped by construction, same as every channel adapter's own
    // lookup: a conversation belonging to another clinic (or that simply
    // doesn't exist) resolves to "not found" here too — never leaking
    // cross-clinic existence, and never a caller-supplied channel/recipient.
    const conversation = await this.prisma.conversation.findFirst({
      where: { id: input.conversationId, clinicId: input.clinicId },
      select: { channelKey: true },
    });
    if (!conversation) throw new ConversationNotFoundException(input.conversationId);

    const adapter = this.adapters.get(conversation.channelKey);
    if (!adapter) throw new UnsupportedOutboundChannelException(conversation.channelKey);

    const result = await adapter.sendText(input);

    return {
      channel: adapter.channel,
      messageId: result.message.id,
      externalId: result.message.externalId,
      deliveryStatus: result.message.deliveryStatus,
      delivered: result.delivered,
      failureReason: result.failureReason,
    };
  }
}
