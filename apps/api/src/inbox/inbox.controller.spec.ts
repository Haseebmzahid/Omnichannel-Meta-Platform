import 'reflect-metadata';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { ConversationStatus, StaffRole } from '../generated/prisma/enums';
import type { AuthenticatedStaffContext } from '../auth/auth.types';
import { InboxController } from './inbox.controller';
import type { InboxService } from './inbox.service';

const CLINIC_ID = randomUUID();
const CONVERSATION_ID = randomUUID();
const STAFF_ID = randomUUID();
const ATTACHMENT_ID = randomUUID();

function staffContext(overrides: Partial<AuthenticatedStaffContext> = {}): AuthenticatedStaffContext {
  return { staffId: STAFF_ID, clinicId: CLINIC_ID, role: StaffRole.AGENT, ...overrides };
}

function buildController(overrides: Partial<Record<keyof InboxService, ReturnType<typeof vi.fn>>> = {}) {
  const inboxService = {
    listConversations: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    getConversation: vi.fn().mockResolvedValue({ id: CONVERSATION_ID }),
    getMessages: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    reply: vi.fn().mockResolvedValue({ messageId: 'm1' }),
    markRead: vi.fn().mockResolvedValue({ id: CONVERSATION_ID }),
    takeover: vi.fn().mockResolvedValue({ id: CONVERSATION_ID }),
    resumeAi: vi.fn().mockResolvedValue({ id: CONVERSATION_ID }),
    updateStatus: vi.fn().mockResolvedValue({ id: CONVERSATION_ID }),
    getAttachmentSignedUrl: vi.fn().mockResolvedValue({ url: 'https://storage.example.test/signed-url', expiresInSeconds: 300 }),
    ...overrides,
  } as unknown as InboxService;

  return { controller: new InboxController(inboxService), inboxService };
}

// Task 7-2 — the controller's HTTP-boundary validation (unchanged from
// Task 7-1) plus proof that authenticated identity, never a caller-
// supplied clinicId/staffId, drives every call into InboxService.
describe('InboxController — HTTP-boundary validation and authenticated-identity enforcement', () => {
  it('rejects a non-UUID conversationId with a sanitized 400', async () => {
    const { controller } = buildController();

    await expect(controller.getConversation(staffContext(), 'not-a-uuid')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects an invalid channel filter value', async () => {
    const { controller } = buildController();

    await expect(controller.listConversations(staffContext(), { channel: 'TELEGRAM' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a limit above the maximum page size', async () => {
    const { controller } = buildController();

    await expect(controller.listConversations(staffContext(), { limit: '999' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a reply body missing text', async () => {
    const { controller } = buildController();

    await expect(controller.reply(staffContext(), CONVERSATION_ID, {})).rejects.toBeInstanceOf(BadRequestException);
  });

  it('a client-supplied staffId in the reply body is ignored — the authenticated staffId is always used instead', async () => {
    const { controller, inboxService } = buildController();

    await controller.reply(staffContext(), CONVERSATION_ID, { staffId: randomUUID(), text: 'hi' });

    // Whatever staffId the client tried to smuggle in, InboxService is
    // always called with the authenticated staff's own id.
    expect(inboxService.reply).toHaveBeenCalledWith(CLINIC_ID, CONVERSATION_ID, STAFF_ID, 'hi');
  });

  it('rejects a status body with an unsupported value — never a new status value is allowed through', async () => {
    const { controller } = buildController();

    await expect(controller.updateStatus(staffContext(), CONVERSATION_ID, { status: 'DELETED' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('never reaches InboxService when validation fails', async () => {
    const { controller, inboxService } = buildController();

    await expect(controller.getConversation(staffContext(), 'not-a-uuid')).rejects.toThrow();
    expect(inboxService.getConversation).not.toHaveBeenCalled();
  });

  it('valid input is parsed and passed through to InboxService using the authenticated clinicId', async () => {
    const { controller, inboxService } = buildController();

    await controller.updateStatus(staffContext(), CONVERSATION_ID, { status: 'RESOLVED' });

    expect(inboxService.updateStatus).toHaveBeenCalledWith(CLINIC_ID, CONVERSATION_ID, ConversationStatus.RESOLVED);
  });

  it('takeover uses the authenticated staffId, accepting no body at all', async () => {
    const { controller, inboxService } = buildController();

    await controller.takeover(staffContext(), CONVERSATION_ID);

    expect(inboxService.takeover).toHaveBeenCalledWith(CLINIC_ID, CONVERSATION_ID, STAFF_ID);
  });

  it('a valid list query with filters is parsed and passed through using the authenticated clinicId', async () => {
    const { controller, inboxService } = buildController();

    await controller.listConversations(staffContext(), { status: 'OPEN', limit: '10' });

    expect(inboxService.listConversations).toHaveBeenCalledWith(CLINIC_ID, expect.objectContaining({ status: 'OPEN', limit: 10 }));
  });

  it('a different authenticated clinicId scopes reads to that clinic, never the caller-remembered one', async () => {
    const { controller, inboxService } = buildController();
    const otherClinicId = randomUUID();

    await controller.listConversations(staffContext({ clinicId: otherClinicId }), {});

    expect(inboxService.listConversations).toHaveBeenCalledWith(otherClinicId, expect.any(Object));
  });

  it('READ_ONLY staff cannot reply — rejected before InboxService is called', async () => {
    const { controller, inboxService } = buildController();

    await expect(controller.reply(staffContext({ role: StaffRole.READ_ONLY }), CONVERSATION_ID, { text: 'hi' })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(inboxService.reply).not.toHaveBeenCalled();
  });

  it('READ_ONLY staff cannot take over a conversation', async () => {
    const { controller, inboxService } = buildController();

    await expect(controller.takeover(staffContext({ role: StaffRole.READ_ONLY }), CONVERSATION_ID)).rejects.toBeInstanceOf(ForbiddenException);
    expect(inboxService.takeover).not.toHaveBeenCalled();
  });

  describe('resumeAi', () => {
    it('uses the authenticated staffId and passes the reason through', async () => {
      const { controller, inboxService } = buildController();

      await controller.resumeAi(staffContext(), CONVERSATION_ID, { reason: 'patient issue resolved' });

      expect(inboxService.resumeAi).toHaveBeenCalledWith(CLINIC_ID, CONVERSATION_ID, STAFF_ID, 'patient issue resolved');
    });

    it('rejects a body missing reason', async () => {
      const { controller, inboxService } = buildController();

      await expect(controller.resumeAi(staffContext(), CONVERSATION_ID, {})).rejects.toBeInstanceOf(BadRequestException);
      expect(inboxService.resumeAi).not.toHaveBeenCalled();
    });

    it('rejects a blank/whitespace-only reason', async () => {
      const { controller, inboxService } = buildController();

      await expect(controller.resumeAi(staffContext(), CONVERSATION_ID, { reason: '   ' })).rejects.toBeInstanceOf(BadRequestException);
      expect(inboxService.resumeAi).not.toHaveBeenCalled();
    });

    it('rejects a non-UUID conversationId', async () => {
      const { controller } = buildController();

      await expect(controller.resumeAi(staffContext(), 'not-a-uuid', { reason: 'reason' })).rejects.toBeInstanceOf(BadRequestException);
    });

    it('READ_ONLY staff cannot resume AI', async () => {
      const { controller, inboxService } = buildController();

      await expect(
        controller.resumeAi(staffContext({ role: StaffRole.READ_ONLY }), CONVERSATION_ID, { reason: 'reason' }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(inboxService.resumeAi).not.toHaveBeenCalled();
    });
  });

  it('READ_ONLY staff cannot change conversation status', async () => {
    const { controller, inboxService } = buildController();

    await expect(
      controller.updateStatus(staffContext({ role: StaffRole.READ_ONLY }), CONVERSATION_ID, { status: 'RESOLVED' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(inboxService.updateStatus).not.toHaveBeenCalled();
  });

  it('READ_ONLY staff can still read (list/get/messages/markRead)', async () => {
    const { controller, inboxService } = buildController();
    const readOnly = staffContext({ role: StaffRole.READ_ONLY });

    await controller.listConversations(readOnly, {});
    await controller.getConversation(readOnly, CONVERSATION_ID);
    await controller.getMessages(readOnly, CONVERSATION_ID, {});
    await controller.markRead(readOnly, CONVERSATION_ID);

    expect(inboxService.listConversations).toHaveBeenCalled();
    expect(inboxService.getConversation).toHaveBeenCalled();
    expect(inboxService.getMessages).toHaveBeenCalled();
    expect(inboxService.markRead).toHaveBeenCalled();
  });

  // Task 7-9 — the authenticated media endpoint.
  describe('getAttachmentUrl', () => {
    it('rejects a non-UUID attachmentId with a sanitized 400', async () => {
      const { controller } = buildController();

      await expect(controller.getAttachmentUrl(staffContext(), 'not-a-uuid')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('never reaches InboxService when the attachmentId is invalid', async () => {
      const { controller, inboxService } = buildController();

      await expect(controller.getAttachmentUrl(staffContext(), 'not-a-uuid')).rejects.toThrow();
      expect(inboxService.getAttachmentSignedUrl).not.toHaveBeenCalled();
    });

    it('delegates to InboxService using the authenticated clinicId, never a caller-supplied one', async () => {
      const { controller, inboxService } = buildController();

      await controller.getAttachmentUrl(staffContext(), ATTACHMENT_ID);

      expect(inboxService.getAttachmentSignedUrl).toHaveBeenCalledWith(CLINIC_ID, ATTACHMENT_ID);
    });

    it('a different authenticated clinicId scopes the lookup to that clinic', async () => {
      const { controller, inboxService } = buildController();
      const otherClinicId = randomUUID();

      await controller.getAttachmentUrl(staffContext({ clinicId: otherClinicId }), ATTACHMENT_ID);

      expect(inboxService.getAttachmentSignedUrl).toHaveBeenCalledWith(otherClinicId, ATTACHMENT_ID);
    });

    it('READ_ONLY staff can view an attachment — viewing media is a read, not a mutation', async () => {
      const { controller, inboxService } = buildController();

      const result = await controller.getAttachmentUrl(staffContext({ role: StaffRole.READ_ONLY }), ATTACHMENT_ID);

      expect(inboxService.getAttachmentSignedUrl).toHaveBeenCalled();
      expect(result).toEqual({ url: 'https://storage.example.test/signed-url', expiresInSeconds: 300 });
    });
  });
});
