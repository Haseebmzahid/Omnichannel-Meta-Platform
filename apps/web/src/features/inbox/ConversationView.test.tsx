import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../test/test-utils';
import { ApiError } from '../../lib/api/client';
import * as inboxApi from '../../lib/api/inbox';
import type { InboxConversationDetail, InboxMessageDto } from '../../lib/api/types';
import { ConversationView } from './ConversationView';

vi.mock('../../lib/api/inbox');

beforeEach(() => {
  vi.clearAllMocks();
});

function baseConversation(overrides: Partial<InboxConversationDetail> = {}): InboxConversationDetail {
  return {
    id: 'conv-1',
    channel: 'WHATSAPP',
    status: 'OPEN',
    mode: 'HUMAN',
    contact: { id: 'contact-1', displayName: 'Fatima Noor' },
    patient: null,
    assignedStaff: { id: 'staff-1', name: 'Dr. Amina' },
    unreadCount: 0,
    externalThreadKey: '1234',
    windowExpiresAt: null,
    windowType: null,
    extensionExpiresAt: null,
    labels: [],
    internalNotes: [],
    lastMessageAt: new Date().toISOString(),
    lastPatientMessageAt: new Date().toISOString(),
    firstResponseAt: null,
    resolvedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function message(overrides: Partial<InboxMessageDto> = {}): InboxMessageDto {
  return {
    id: `m-${Math.random()}`,
    direction: 'INBOUND',
    senderType: 'PATIENT',
    senderStaffId: null,
    contentType: 'TEXT',
    text: 'Hello',
    deliveryStatus: 'DELIVERED',
    externalId: null,
    createdAt: new Date().toISOString(),
    attachments: [],
    ...overrides,
  };
}

function mockReadEndpoints(conversation: InboxConversationDetail, messages: InboxMessageDto[]) {
  vi.mocked(inboxApi.getConversation).mockResolvedValue(conversation);
  vi.mocked(inboxApi.getMessages).mockResolvedValue({ items: messages, nextCursor: null });
  vi.mocked(inboxApi.markRead).mockResolvedValue(conversation);
}

describe('ConversationView', () => {
  // 7. Message rendering — PATIENT / AI / STAFF visually distinguished
  it('renders patient, AI, and staff messages with distinguishing labels', async () => {
    mockReadEndpoints(
      baseConversation(),
      [
        message({ id: 'm1', senderType: 'PATIENT', text: 'I have a headache' }),
        message({ id: 'm2', senderType: 'AI', direction: 'OUTBOUND', text: 'Sorry to hear that.' }),
        message({ id: 'm3', senderType: 'STAFF', direction: 'OUTBOUND', text: 'This is Dr. Amina.', senderStaffId: 'staff-1' }),
      ],
    );

    renderWithProviders(<ConversationView conversationId="conv-1" currentStaffId="staff-1" currentStaffRole="AGENT" />);

    expect(await screen.findByText('I have a headache')).toBeInTheDocument();
    expect(screen.getByText('Sorry to hear that.')).toBeInTheDocument();
    expect(screen.getByText('This is Dr. Amina.')).toBeInTheDocument();
    expect(screen.getByText('AI')).toBeInTheDocument(); // AI sender tag
    expect(screen.getByText('· You')).toBeInTheDocument(); // own-message attribution
  });

  // 8. Staff reply
  it('sends a reply and clears the composer', async () => {
    mockReadEndpoints(baseConversation(), []);
    vi.mocked(inboxApi.sendReply).mockResolvedValue({ messageId: 'm-new', channel: 'WHATSAPP', deliveryStatus: 'SENT', delivered: true });
    const user = userEvent.setup();

    renderWithProviders(<ConversationView conversationId="conv-1" currentStaffId="staff-1" currentStaffRole="AGENT" />);

    const composer = await screen.findByLabelText('Reply message');
    await user.type(composer, 'On my way, see you soon.');
    await user.click(screen.getByRole('button', { name: 'Send message' }));

    await waitFor(() => expect(inboxApi.sendReply).toHaveBeenCalledWith('conv-1', 'On my way, see you soon.'));
    expect(composer).toHaveValue('');
  });

  // 9. Takeover action
  it('shows Take Over for a PENDING conversation and calls the takeover endpoint', async () => {
    mockReadEndpoints(baseConversation({ mode: 'PENDING', assignedStaff: null }), []);
    vi.mocked(inboxApi.takeover).mockResolvedValue(baseConversation({ mode: 'HUMAN' }));
    const user = userEvent.setup();

    renderWithProviders(<ConversationView conversationId="conv-1" currentStaffId="staff-1" currentStaffRole="AGENT" />);

    const takeoverButton = await screen.findByRole('button', { name: 'Take over' });
    await user.click(takeoverButton);

    await waitFor(() => expect(inboxApi.takeover).toHaveBeenCalledWith('conv-1'));
  });

  // 10. Status change
  it('changes conversation status via the select and calls the status endpoint', async () => {
    mockReadEndpoints(baseConversation({ status: 'OPEN' }), []);
    vi.mocked(inboxApi.updateStatus).mockResolvedValue(baseConversation({ status: 'RESOLVED' }));
    const user = userEvent.setup();

    renderWithProviders(<ConversationView conversationId="conv-1" currentStaffId="staff-1" currentStaffRole="AGENT" />);

    const statusSelect = await screen.findByLabelText('Conversation status');
    await user.selectOptions(statusSelect, 'RESOLVED');

    await waitFor(() => expect(inboxApi.updateStatus).toHaveBeenCalledWith('conv-1', 'RESOLVED'));
  });

  it('surfaces a useful error, without mutating the visible status, when the backend rejects a transition', async () => {
    mockReadEndpoints(baseConversation({ status: 'OPEN', mode: 'PENDING' }), []);
    vi.mocked(inboxApi.updateStatus).mockRejectedValue(
      new ApiError(409, 'Cannot transition conversation status from OPEN to RESOLVED: a conversation awaiting a human cannot be resolved.'),
    );
    const user = userEvent.setup();

    renderWithProviders(<ConversationView conversationId="conv-1" currentStaffId="staff-1" currentStaffRole="AGENT" />);

    const statusSelect = await screen.findByLabelText('Conversation status');
    await user.selectOptions(statusSelect, 'RESOLVED');

    expect(await screen.findByRole('alert')).toHaveTextContent(/cannot transition/i);
    expect(statusSelect).toHaveValue('OPEN');
  });

  // 11. Read action
  it('marks the conversation as read on open when it has unread messages', async () => {
    mockReadEndpoints(baseConversation({ unreadCount: 4 }), []);

    renderWithProviders(<ConversationView conversationId="conv-1" currentStaffId="staff-1" currentStaffRole="AGENT" />);

    await waitFor(() => expect(inboxApi.markRead).toHaveBeenCalledWith('conv-1'));
  });

  it('does not call markRead when there is nothing unread', async () => {
    mockReadEndpoints(baseConversation({ unreadCount: 0 }), []);

    renderWithProviders(<ConversationView conversationId="conv-1" currentStaffId="staff-1" currentStaffRole="AGENT" />);

    await screen.findByText('Fatima Noor');
    expect(inboxApi.markRead).not.toHaveBeenCalled();
  });

  // 12. ReadOnly UI restrictions
  it('hides mutating controls (composer, takeover, status) for a READ_ONLY staff member', async () => {
    mockReadEndpoints(baseConversation({ mode: 'PENDING', status: 'OPEN' }), [message({ text: 'Hi there' })]);

    renderWithProviders(<ConversationView conversationId="conv-1" currentStaffId="staff-1" currentStaffRole="READ_ONLY" />);

    expect(await screen.findByText('Hi there')).toBeInTheDocument();
    expect(screen.queryByLabelText('Reply message')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Take over' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Conversation status')).not.toBeInTheDocument();
    expect(screen.getByText(/read-only staff cannot reply/i)).toBeInTheDocument();
  });

  // 13. API error handling
  it('shows a retryable error state when the conversation fails to load', async () => {
    vi.mocked(inboxApi.getConversation).mockRejectedValue(new ApiError(500, 'Could not load this conversation.'));
    vi.mocked(inboxApi.getMessages).mockResolvedValue({ items: [], nextCursor: null });

    renderWithProviders(<ConversationView conversationId="conv-1" currentStaffId="staff-1" currentStaffRole="AGENT" />);

    expect(await screen.findByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('shows a clean "no longer available" message for a 404 (deleted/unavailable conversation), with no retry affordance', async () => {
    vi.mocked(inboxApi.getConversation).mockRejectedValue(new ApiError(404, 'Conversation was not found.'));
    vi.mocked(inboxApi.getMessages).mockResolvedValue({ items: [], nextCursor: null });

    renderWithProviders(<ConversationView conversationId="conv-1" currentStaffId="staff-1" currentStaffRole="AGENT" />);

    expect(await screen.findByText('This conversation is no longer available.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
  });

  it('shows a failed-send state with a resend action when the backend reports delivery failure', async () => {
    mockReadEndpoints(baseConversation(), [message({ direction: 'OUTBOUND', senderType: 'STAFF', senderStaffId: 'staff-1', text: 'Hi', deliveryStatus: 'FAILED' })]);

    renderWithProviders(<ConversationView conversationId="conv-1" currentStaffId="staff-1" currentStaffRole="AGENT" />);

    expect(await screen.findByText(/failed to send/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Resend' })).toBeInTheDocument();
  });
});
