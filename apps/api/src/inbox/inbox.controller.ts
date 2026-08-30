import { Body, Controller, ForbiddenException, Get, HttpCode, HttpStatus, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { CurrentStaff } from '../auth/current-staff.decorator';
import { SessionAuthGuard } from '../auth/session-auth.guard';
import type { AuthenticatedStaffContext } from '../auth/auth.types';
import { parseOrBadRequest } from '../common/parse-or-bad-request';
import { ChannelKey, ConversationMode, ConversationStatus, StaffRole } from '../generated/prisma/enums';
import { InboxService } from './inbox.service';
import type {
  CursorPage,
  InboxAttachmentUrlDto,
  InboxConversationDetail,
  InboxConversationSummary,
  InboxMessageDto,
  InboxReplyResultDto,
} from './inbox.types';

// Task 7-2 — refactored from Task 7-1's clinicId-in-path/staffId-in-body
// design (see git history) now that a real session exists. Every route is
// gated by SessionAuthGuard, and clinicId/staffId come exclusively from
// the verified AuthenticatedStaffContext SessionAuthGuard attaches to the
// request — never from a path segment, query string, or request body. No
// route below accepts a caller-supplied clinicId or staffId at all.
//
// This is authentication, not a replacement for InboxService/
// ConversationService's own clinic-scoped queries (defense in depth, per
// this task's section 5) — those are untouched: every read/mutation still
// independently clinic-scopes against the persisted Conversation.
@Controller('inbox')
@UseGuards(SessionAuthGuard)
export class InboxController {
  constructor(private readonly inboxService: InboxService) {}

  @Get('conversations')
  async listConversations(
    @CurrentStaff() staff: AuthenticatedStaffContext,
    @Query() query: Record<string, unknown>,
  ): Promise<CursorPage<InboxConversationSummary>> {
    const parsed = parseOrBadRequest(listConversationsQuerySchema, query, 'query');
    return this.inboxService.listConversations(staff.clinicId, parsed);
  }

  @Get('conversations/:conversationId')
  async getConversation(
    @CurrentStaff() staff: AuthenticatedStaffContext,
    @Param('conversationId') conversationId: string,
  ): Promise<InboxConversationDetail> {
    const parsedConversationId = parseOrBadRequest(uuidSchema, conversationId, 'conversationId');
    return this.inboxService.getConversation(staff.clinicId, parsedConversationId);
  }

  @Get('conversations/:conversationId/messages')
  async getMessages(
    @CurrentStaff() staff: AuthenticatedStaffContext,
    @Param('conversationId') conversationId: string,
    @Query() query: Record<string, unknown>,
  ): Promise<CursorPage<InboxMessageDto>> {
    const parsedConversationId = parseOrBadRequest(uuidSchema, conversationId, 'conversationId');
    const parsed = parseOrBadRequest(messagesQuerySchema, query, 'query');
    return this.inboxService.getMessages(staff.clinicId, parsedConversationId, parsed);
  }

  @Post('conversations/:conversationId/messages')
  @HttpCode(HttpStatus.CREATED)
  async reply(
    @CurrentStaff() staff: AuthenticatedStaffContext,
    @Param('conversationId') conversationId: string,
    @Body() body: unknown,
  ): Promise<InboxReplyResultDto> {
    assertCanMutate(staff);
    const parsedConversationId = parseOrBadRequest(uuidSchema, conversationId, 'conversationId');
    const parsed = parseOrBadRequest(replyBodySchema, body, 'body');
    return this.inboxService.reply(staff.clinicId, parsedConversationId, staff.staffId, parsed.text);
  }

  @Patch('conversations/:conversationId/read')
  async markRead(
    @CurrentStaff() staff: AuthenticatedStaffContext,
    @Param('conversationId') conversationId: string,
  ): Promise<InboxConversationDetail> {
    const parsedConversationId = parseOrBadRequest(uuidSchema, conversationId, 'conversationId');
    return this.inboxService.markRead(staff.clinicId, parsedConversationId);
  }

  @Post('conversations/:conversationId/takeover')
  async takeover(
    @CurrentStaff() staff: AuthenticatedStaffContext,
    @Param('conversationId') conversationId: string,
  ): Promise<InboxConversationDetail> {
    assertCanMutate(staff);
    const parsedConversationId = parseOrBadRequest(uuidSchema, conversationId, 'conversationId');
    return this.inboxService.takeover(staff.clinicId, parsedConversationId, staff.staffId);
  }

  // The documented inverse of takeover() above (docs/architecture/
  // 03-conversation-and-inbox.md §5: "HUMAN -> AI: requires an explicit
  // staff action and a reason") — a reason is therefore a required body
  // field, never optional, exactly like takeover() requires no body at all
  // because PENDING -> HUMAN needs no justification.
  @Post('conversations/:conversationId/resume-ai')
  async resumeAi(
    @CurrentStaff() staff: AuthenticatedStaffContext,
    @Param('conversationId') conversationId: string,
    @Body() body: unknown,
  ): Promise<InboxConversationDetail> {
    assertCanMutate(staff);
    const parsedConversationId = parseOrBadRequest(uuidSchema, conversationId, 'conversationId');
    const parsed = parseOrBadRequest(resumeAiBodySchema, body, 'body');
    return this.inboxService.resumeAi(staff.clinicId, parsedConversationId, staff.staffId, parsed.reason);
  }

  @Patch('conversations/:conversationId/status')
  async updateStatus(
    @CurrentStaff() staff: AuthenticatedStaffContext,
    @Param('conversationId') conversationId: string,
    @Body() body: unknown,
  ): Promise<InboxConversationDetail> {
    assertCanMutate(staff);
    const parsedConversationId = parseOrBadRequest(uuidSchema, conversationId, 'conversationId');
    const parsed = parseOrBadRequest(updateStatusBodySchema, body, 'body');
    return this.inboxService.updateStatus(staff.clinicId, parsedConversationId, parsed.status);
  }

  // Task 7-9 — a read, not a mutation (viewing an attachment isn't
  // changing anything), so READ_ONLY staff can call this exactly like
  // getMessages()/getConversation() above — no assertCanMutate() here.
  // clinicId is, as with every route in this controller, only ever the
  // authenticated staff's own — InboxService.getAttachmentSignedUrl()
  // resolves the attachment through Message -> Conversation -> clinicId
  // and returns the same 404 whether the id is unknown or belongs to
  // another clinic.
  @Get('attachments/:attachmentId')
  async getAttachmentUrl(
    @CurrentStaff() staff: AuthenticatedStaffContext,
    @Param('attachmentId') attachmentId: string,
  ): Promise<InboxAttachmentUrlDto> {
    const parsedAttachmentId = parseOrBadRequest(uuidSchema, attachmentId, 'attachmentId');
    return this.inboxService.getAttachmentSignedUrl(staff.clinicId, parsedAttachmentId);
  }
}

// Task 7-2, section 6 — the one role/action rule that is self-evident from
// the documented role enum itself (docs/architecture/01-domain-model.md
// §2: "Role: Admin | Manager | Agent | ReadOnly") without inventing a
// permission matrix the architecture doesn't specify: ReadOnly staff
// cannot perform the inbox's write actions (reply, takeover, status
// change). Every other role/action combination is left alone rather than
// guessed at — this task does not invent finer-grained semantics for
// Admin/Manager/Agent.
function assertCanMutate(staff: AuthenticatedStaffContext): void {
  if (staff.role === StaffRole.READ_ONLY) {
    throw new ForbiddenException('Read-only staff cannot perform this action.');
  }
}

// --- HTTP-boundary validation ------------------------------------------

const MAX_PAGE_SIZE = 100;

const uuidSchema = z.uuid();

const channelEnum = z.enum(Object.values(ChannelKey) as [ChannelKey, ...ChannelKey[]]);
const statusEnum = z.enum(Object.values(ConversationStatus) as [ConversationStatus, ...ConversationStatus[]]);
const modeEnum = z.enum(Object.values(ConversationMode) as [ConversationMode, ...ConversationMode[]]);

const listConversationsQuerySchema = z.object({
  channel: channelEnum.optional(),
  status: statusEnum.optional(),
  mode: modeEnum.optional(),
  search: z.string().trim().min(1).max(200).optional(),
  cursor: uuidSchema.optional(),
  limit: z.coerce.number().int().positive().max(MAX_PAGE_SIZE).optional(),
});

const messagesQuerySchema = z.object({
  cursor: uuidSchema.optional(),
  limit: z.coerce.number().int().positive().max(MAX_PAGE_SIZE).optional(),
});

const MAX_REPLY_TEXT_LENGTH = 4096;

// staffId is no longer part of this body — see this file's header comment.
const replyBodySchema = z.object({
  text: z.string().trim().min(1).max(MAX_REPLY_TEXT_LENGTH),
});

const updateStatusBodySchema = z.object({ status: statusEnum });

const MAX_RESUME_REASON_LENGTH = 500;

const resumeAiBodySchema = z.object({
  reason: z.string().trim().min(1).max(MAX_RESUME_REASON_LENGTH),
});
