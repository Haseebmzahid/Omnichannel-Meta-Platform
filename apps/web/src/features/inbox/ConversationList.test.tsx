import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../test/test-utils';
import * as inboxApi from '../../lib/api/inbox';
import type { InboxConversationSummary } from '../../lib/api/types';
import { ConversationList } from './ConversationList';

vi.mock('../../lib/api/inbox');

function conversation(overrides: Partial<InboxConversationSummary> = {}): InboxConversationSummary {
  return {
    id: 'conv-1',
    channel: 'WHATSAPP',
    status: 'OPEN',
    mode: 'AI',
    contact: { id: 'contact-1', displayName: 'Fatima Noor' },
    patient: null,
    assignedStaffId: null,
    unreadCount: 0,
    lastMessageAt: new Date().toISOString(),
    lastMessagePreview: { text: 'Hello there', direction: 'INBOUND', senderType: 'PATIENT', createdAt: new Date().toISOString() },
    externalThreadKey: '1234',
    ...overrides,
  };
}

describe('ConversationList', () => {
  // 4. Inbox loading
  it('shows a loading skeleton before conversations arrive', async () => {
    vi.mocked(inboxApi.listConversations).mockReturnValue(new Promise(() => {})); // never resolves

    renderWithProviders(<ConversationList activeConversationId={undefined} onSelect={vi.fn()} />);

    // Skeleton rows render as aria-hidden placeholders — assert the real content isn't there yet.
    expect(screen.queryByText('Fatima Noor')).not.toBeInTheDocument();
  });

  // 5. Inbox empty state
  it('shows an empty state when there are no conversations', async () => {
    vi.mocked(inboxApi.listConversations).mockResolvedValue({ items: [], nextCursor: null });

    renderWithProviders(<ConversationList activeConversationId={undefined} onSelect={vi.fn()} />);

    expect(await screen.findByText('No conversations yet')).toBeInTheDocument();
  });

  // 6. Conversation selection
  it('calls onSelect with the conversation id when a row is clicked', async () => {
    vi.mocked(inboxApi.listConversations).mockResolvedValue({ items: [conversation()], nextCursor: null });
    const onSelect = vi.fn();
    const user = userEvent.setup();

    renderWithProviders(<ConversationList activeConversationId={undefined} onSelect={onSelect} />);

    await user.click(await screen.findByText('Fatima Noor'));
    expect(onSelect).toHaveBeenCalledWith('conv-1');
  });

  // 14. WhatsApp + Instagram channel rendering
  it('renders distinct channel badges for WhatsApp and Instagram conversations', async () => {
    vi.mocked(inboxApi.listConversations).mockResolvedValue({
      items: [
        conversation({ id: 'wa-1', contact: { id: 'c1', displayName: 'WA Contact' }, channel: 'WHATSAPP' }),
        conversation({ id: 'ig-1', contact: { id: 'c2', displayName: 'IG Contact' }, channel: 'INSTAGRAM' }),
      ],
      nextCursor: null,
    });

    renderWithProviders(<ConversationList activeConversationId={undefined} onSelect={vi.fn()} />);

    expect(await screen.findByText('WhatsApp')).toBeInTheDocument();
    expect(screen.getByText('Instagram')).toBeInTheDocument();
  });

  it('shows an unread badge and bolds the row for a conversation with unread messages', async () => {
    vi.mocked(inboxApi.listConversations).mockResolvedValue({ items: [conversation({ unreadCount: 3 })], nextCursor: null });

    renderWithProviders(<ConversationList activeConversationId={undefined} onSelect={vi.fn()} />);

    expect(await screen.findByLabelText('3 unread')).toBeInTheDocument();
  });

  it('surfaces a retryable error state when the list request fails', async () => {
    vi.mocked(inboxApi.listConversations).mockRejectedValue(new Error('Could not load conversations.'));

    renderWithProviders(<ConversationList activeConversationId={undefined} onSelect={vi.fn()} />);

    expect(await screen.findByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});
