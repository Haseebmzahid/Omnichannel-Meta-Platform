import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ChannelOutboundDispatcher } from '../channels/channel-outbound-dispatcher.service';
import type { ConversationStatus } from '../generated/prisma/enums';
import { ConversationService } from '../messaging/conversation.service';
import type { ConversationDetailRow, ConversationListRow } from '../messaging/conversation.service';
import { MessageService } from '../messaging/message.service';
import type { MessageWithAttachments } from '../messaging/message.service';
import { PrismaService } from '../prisma/prisma.service';
import { StaffNotFoundException } from './inbox.errors';
import type {
  CursorPage,
  GetInboxMessagesInput,
  InboxConversationDetail,
  InboxConversationSummary,
  InboxMessageDto,
  InboxReplyResultDto,
  ListInboxConversationsInput,
} from './inbox.types';

// Task 7-1 — the staff inbox's own service layer. This is the "Staff
// Inbox API" box in the architecture diagram the task gives:
//
//   WhatsApp/Instagram/Messenger -> Messaging Core -> PostgreSQL
//                                        ^
//                                        |
//                          Staff Inbox API (this file) -> Web Portal (later)
//
// Every read and mutation goes through the SAME Messaging Core the
// channel adapters and the AI orchestrator already use
// (ConversationService/MessageService) — there is no second inbox
// database, no portal-specific Conversation/Message model, and no direct
// Prisma access to conversations/messages here (the one direct
// PrismaService use in this file, assertStaffBelongsToClinic below, reads
// Staff only, a model Messaging Core doesn't own).
//
// Authentication note (Task 7-1 Section 15, stop condition 5): no
// authentication/authorization mechanism exists anywhere in this codebase
// yet (grepped — no guard/JWT/session code at all), and this task
// explicitly excludes building one. clinicId and staffId are therefore
// accepted as explicit inputs from the caller (controller path/body
// params) rather than derived from a verified session, exactly as the
// task's own route sketch implies. This is a real, intentional gap, not a
// silently-invented workaround: every read/mutation still strictly
// clinic-scopes its query against the persisted Conversation (never
// trusting a channel/recipient/account id from the client), and
// staffId is independently verified to belong to the claimed clinic
// before being used for an assignment/attribution — but nothing here
// verifies that the HTTP caller is *actually* the clinic or staff member
// it claims to be. See the Task 7-1 report for why this is flagged rather
// than resolved by inventing an auth layer.
@Injectable()
export class InboxService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly conversationService: ConversationService,
    private readonly messageService: MessageService,
    private readonly dispatcher: ChannelOutboundDispatcher,
  ) {}

  async listConversations(clinicId: string, input: ListInboxConversationsInput): Promise<CursorPage<InboxConversationSummary>> {
    const result = await this.conversationService.listConversationsForClinic({
      clinicId,
      channelKey: input.channel,
      status: input.status,
      mode: input.mode,
      search: input.search,
      cursor: input.cursor,
      limit: input.limit,
    });

    return { items: result.conversations.map(toConversationSummary), nextCursor: result.nextCursor };
  }

  async getConversation(clinicId: string, conversationId: string): Promise<InboxConversationDetail> {
    const conversation = await this.conversationService.getConversationForClinic(clinicId, conversationId);
    return toConversationDetail(conversation);
  }

  async getMessages(clinicId: string, conversationId: string, input: GetInboxMessagesInput): Promise<CursorPage<InboxMessageDto>> {
    // getConversationMessages() already clinic-scopes and throws
    // ConversationNotFoundException on a cross-clinic/missing id — reused
    // as-is, not re-checked here (Task 4C section 4: "reuse
    // getConversationMessages() rather than duplicating message querying
    // logic").
    const result = await this.messageService.getConversationMessages({
      clinicId,
      conversationId,
      cursor: input.cursor,
      limit: input.limit,
    });

    return { items: result.messages.map(toMessageDto), nextCursor: result.nextCursor };
  }

  async markRead(clinicId: string, conversationId: string): Promise<InboxConversationDetail> {
    const conversation = await this.conversationService.markConversationRead(clinicId, conversationId);
    return toConversationDetail(conversation);
  }

  async takeover(clinicId: string, conversationId: string, staffId: string): Promise<InboxConversationDetail> {
    await this.assertStaffBelongsToClinic(clinicId, staffId);
    const conversation = await this.conversationService.takeoverConversation(clinicId, conversationId, staffId);
    return toConversationDetail(conversation);
  }

  async updateStatus(clinicId: string, conversationId: string, status: ConversationStatus): Promise<InboxConversationDetail> {
    const conversation = await this.conversationService.updateConversationStatus(clinicId, conversationId, status);
    return toConversationDetail(conversation);
  }

  // Task 7-1, section 6 — the staff reply boundary:
  //
  //   Staff Inbox -> ChannelOutboundDispatcher -> WhatsApp/InstagramOutboundService -> Meta
  //
  // This method never touches Prisma's Message/Conversation tables
  // itself, never picks a channel, and never accepts a recipient/account
  // id — clinicId and conversationId are the only identifiers threaded
  // through, exactly as send-message.tool.ts already does for the AI's
  // own reply path (Task 4C-9's hardening applies equally here: the
  // dispatcher resolves channel + recipient from the persisted
  // Conversation, never from caller input).
  async reply(clinicId: string, conversationId: string, staffId: string, text: string): Promise<InboxReplyResultDto> {
    await this.assertStaffBelongsToClinic(clinicId, staffId);

    const result = await this.dispatcher.sendText({
      clinicId,
      conversationId,
      text,
      senderType: 'STAFF',
      senderStaffId: staffId,
      idempotencyKey: deriveStaffReplyIdempotencyKey(conversationId, staffId, text),
    });

    return {
      messageId: result.messageId,
      channel: result.channel,
      deliveryStatus: result.deliveryStatus,
      delivered: result.delivered,
      failureReason: result.failureReason,
    };
  }

  // The one direct Prisma read in this file — Staff is not a Messaging
  // Core model, and there is no StaffService to delegate to yet (see
  // inbox.errors.ts). Exists only to catch a staffId that is bogus or
  // belongs to a different clinic before it reaches an assignment/
  // attribution field — the closest thing to authorization this task can
  // do without inventing an authentication layer (see this class's own
  // header comment).
  private async assertStaffBelongsToClinic(clinicId: string, staffId: string): Promise<void> {
    const staff = await this.prisma.staff.findFirst({ where: { id: staffId, clinicId } });
    if (!staff) throw new StaffNotFoundException(staffId);
  }
}

// Deterministic, content-derived key — mirrors send-message.tool.ts's
// deriveIdempotencyKey() exactly, namespaced `staff-reply:` and keyed on
// (conversationId, staffId, text) rather than just (conversationId, text):
// two different staff members sending byte-identical text to the same
// conversation are two genuinely separate actions, not a retry of one —
// including staffId in the digest keeps them from colliding. The same
// accepted limitation documented there applies here too: the identical
// staff member sending the identical text to the same conversation twice,
// as two deliberately separate messages, short-circuits to the first
// send's result rather than sending again.
function deriveStaffReplyIdempotencyKey(conversationId: string, staffId: string, text: string): string {
  const digest = createHash('sha256').update(`${conversationId}:${staffId}:${text}`).digest('hex').slice(0, 32);
  return `staff-reply:${digest}`;
}

function toConversationSummary(row: ConversationListRow): InboxConversationSummary {
  const latest = row.messages[0];
  return {
    id: row.id,
    channel: row.channelKey,
    status: row.status,
    mode: row.mode,
    contact: { id: row.contact.id, displayName: row.contact.displayName },
    patient: row.patient ? { id: row.patient.id, displayName: row.patient.displayName } : null,
    assignedStaffId: row.assignedStaffId,
    unreadCount: row.unreadCount,
    lastMessageAt: row.lastMessageAt?.toISOString() ?? null,
    lastMessagePreview: latest
      ? { text: latest.text, direction: latest.direction, senderType: latest.senderType, createdAt: latest.createdAt.toISOString() }
      : null,
    externalThreadKey: row.externalThreadKey,
  };
}

function toConversationDetail(row: ConversationDetailRow): InboxConversationDetail {
  return {
    id: row.id,
    channel: row.channelKey,
    status: row.status,
    mode: row.mode,
    contact: { id: row.contact.id, displayName: row.contact.displayName },
    patient: row.patient
      ? { id: row.patient.id, displayName: row.patient.displayName, verifiedPhone: row.patient.verifiedPhone, verifiedEmail: row.patient.verifiedEmail }
      : null,
    assignedStaff: row.assignedStaff ? { id: row.assignedStaff.id, name: row.assignedStaff.name } : null,
    unreadCount: row.unreadCount,
    externalThreadKey: row.externalThreadKey,
    windowExpiresAt: row.windowExpiresAt?.toISOString() ?? null,
    windowType: row.windowType,
    extensionExpiresAt: row.extensionExpiresAt?.toISOString() ?? null,
    labels: row.labels,
    internalNotes: row.internalNotes,
    lastMessageAt: row.lastMessageAt?.toISOString() ?? null,
    lastPatientMessageAt: row.lastPatientMessageAt?.toISOString() ?? null,
    firstResponseAt: row.firstResponseAt?.toISOString() ?? null,
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toMessageDto(message: MessageWithAttachments): InboxMessageDto {
  return {
    id: message.id,
    direction: message.direction,
    senderType: message.senderType,
    senderStaffId: message.senderStaffId,
    contentType: message.contentType,
    text: message.text,
    deliveryStatus: message.deliveryStatus,
    externalId: message.externalId,
    createdAt: message.createdAt.toISOString(),
    attachments: message.attachments.map((attachment) => ({
      id: attachment.id,
      type: attachment.type,
      storageRef: attachment.storageRef,
      mime: attachment.mime,
      caption: attachment.caption,
    })),
  };
}
