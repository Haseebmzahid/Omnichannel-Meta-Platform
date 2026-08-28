import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../test/test-utils';
import * as inboxApi from '../../lib/api/inbox';
import type { InboxConversationSummary } from '../../lib/api/types';
import { ConversationList } from './ConversationList';

vi.mock('../../lib/api/inbox');

beforeEach(() => {
  vi.clearAllMocks();
});

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

  // 5. Multi-channel presentation — WhatsApp, Instagram, and Messenger all
  // appear in the SAME conversation list, never three separate inboxes.
  it('renders distinct channel badges for WhatsApp, Instagram, and Messenger conversations in one list', async () => {
    vi.mocked(inboxApi.listConversations).mockResolvedValue({
      items: [
        conversation({ id: 'wa-1', contact: { id: 'c1', displayName: 'WA Contact' }, channel: 'WHATSAPP' }),
        conversation({ id: 'ig-1', contact: { id: 'c2', displayName: 'IG Contact' }, channel: 'INSTAGRAM' }),
        conversation({ id: 'msgr-1', contact: { id: 'c3', displayName: 'Messenger Contact' }, channel: 'MESSENGER' }),
      ],
      nextCursor: null,
    });

    renderWithProviders(<ConversationList activeConversationId={undefined} onSelect={vi.fn()} />);

    // Wait on the contact names first — unlike the channel labels, they
    // never collide with the filter row's own static <option> text, so this
    // is the reliable signal that the real list (not the filters) has loaded.
    expect(await screen.findByText('WA Contact')).toBeInTheDocument();
    expect(screen.getByText('IG Contact')).toBeInTheDocument();
    expect(screen.getByText('Messenger Contact')).toBeInTheDocument();

    // Scoped to each row with `within` — "WhatsApp"/"Instagram"/"Messenger"
    // also appear as plain <option> labels in the channel filter dropdown
    // above the list, so an unscoped getByText would be ambiguous.
    const waRow = screen.getByText('WA Contact').closest('li')!;
    const igRow = screen.getByText('IG Contact').closest('li')!;
    const msgrRow = screen.getByText('Messenger Contact').closest('li')!;
    expect(within(waRow).getByText('WhatsApp')).toBeInTheDocument();
    expect(within(igRow).getByText('Instagram')).toBeInTheDocument();
    expect(within(msgrRow).getByText('Messenger')).toBeInTheDocument();
  });

  // 17. Pagination / load-more
  it('loads the next page via cursor pagination when "Load more" is clicked', async () => {
    vi.mocked(inboxApi.listConversations)
      .mockResolvedValueOnce({
        items: [conversation({ id: 'conv-1', contact: { id: 'c1', displayName: 'First Contact' } })],
        nextCursor: 'cursor-1',
      })
      .mockResolvedValueOnce({
        items: [conversation({ id: 'conv-2', contact: { id: 'c2', displayName: 'Second Contact' } })],
        nextCursor: null,
      });

    const user = userEvent.setup();
    renderWithProviders(<ConversationList activeConversationId={undefined} onSelect={vi.fn()} />);

    expect(await screen.findByText('First Contact')).toBeInTheDocument();
    expect(screen.queryByText('Second Contact')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Load more' }));

    expect(await screen.findByText('Second Contact')).toBeInTheDocument();
    // First page's row stays — "load more" appends, it doesn't replace.
    expect(screen.getByText('First Contact')).toBeInTheDocument();
    expect(inboxApi.listConversations).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: 'cursor-1' }));
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
