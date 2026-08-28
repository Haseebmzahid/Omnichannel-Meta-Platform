import { BadRequestException } from '@nestjs/common';

// Follows the same pattern as ../messaging/messaging.errors.ts and each
// channel's own *.errors.ts: an HttpException subclass with a safe,
// specific message, never a raw internal detail.
//
// Thrown only when a Conversation's channelKey has no registered adapter in
// ChannelOutboundDispatcher — a real, currently-unsupported channel, not a
// malformed/unknown one (that case is ConversationNotFoundException,
// reused as-is from the Messaging Core).
export class UnsupportedOutboundChannelException extends BadRequestException {
  constructor(channelKey: string) {
    super(`Outbound sending is not yet supported for channel "${channelKey}".`);
  }
}
