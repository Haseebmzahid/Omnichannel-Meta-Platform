import { screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../test/test-utils';
import * as inboxApi from '../../lib/api/inbox';
import type { InboxMessageDto } from '../../lib/api/types';
import { MessageBubble } from './MessageBubble';

vi.mock('../../lib/api/inbox');

beforeEach(() => {
  vi.clearAllMocks();
});

function message(overrides: Partial<InboxMessageDto> = {}): InboxMessageDto {
  return {
    id: 'm1',
    direction: 'INBOUND',
    senderType: 'PATIENT',
    senderStaffId: null,
    contentType: 'MEDIA',
    text: '[Image]',
    deliveryStatus: 'DELIVERED',
    externalId: null,
    createdAt: new Date().toISOString(),
    attachments: [],
    ...overrides,
  };
}

describe('MessageBubble', () => {
  // Regression: existing text-message rendering remains unchanged.
  it('renders a plain text message unaffected by attachment handling', async () => {
    const msg = message({ contentType: 'TEXT', text: 'Hello there', attachments: [] });
    renderWithProviders(<MessageBubble message={msg} isOwnMessage={false} />);

    expect(await screen.findByText('Hello there')).toBeInTheDocument();
    expect(inboxApi.getAttachmentUrl).not.toHaveBeenCalled();
  });

  it('renders an image attachment inline once the signed URL resolves', async () => {
    vi.mocked(inboxApi.getAttachmentUrl).mockResolvedValue({ url: 'https://storage.example.test/photo.jpg', expiresInSeconds: 300 });
    const msg = message({ attachments: [{ id: 'att-1', type: 'IMAGE', mime: 'image/jpeg', caption: 'A photo' }] });

    renderWithProviders(<MessageBubble message={msg} isOwnMessage={false} />);

    const img = await screen.findByRole('img', { name: 'A photo' });
    expect(img).toHaveAttribute('src', 'https://storage.example.test/photo.jpg');
    expect(inboxApi.getAttachmentUrl).toHaveBeenCalledWith('att-1');
  });

  it('renders an audio attachment with playback controls once the signed URL resolves', async () => {
    vi.mocked(inboxApi.getAttachmentUrl).mockResolvedValue({ url: 'https://storage.example.test/voice.ogg', expiresInSeconds: 300 });
    const msg = message({ attachments: [{ id: 'att-2', type: 'AUDIO', mime: 'audio/ogg', caption: null }] });

    renderWithProviders(<MessageBubble message={msg} isOwnMessage={false} />);

    // No accessible role for a native <audio> element with no <track> — located directly.
    const audioEl = await vi.waitUntil(() => document.querySelector('audio'));
    expect(audioEl).toHaveAttribute('src', 'https://storage.example.test/voice.ogg');
    expect(audioEl).toHaveAttribute('controls');
  });

  it('shows a loading placeholder before the signed URL resolves', async () => {
    vi.mocked(inboxApi.getAttachmentUrl).mockReturnValue(new Promise(() => {}));
    const msg = message({ attachments: [{ id: 'att-3', type: 'IMAGE', mime: 'image/png', caption: null }] });

    renderWithProviders(<MessageBubble message={msg} isOwnMessage={false} />);

    expect(await screen.findByLabelText('Loading attachment')).toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('falls back to the safe type+caption summary when the signed URL request fails', async () => {
    vi.mocked(inboxApi.getAttachmentUrl).mockRejectedValue(new Error('not found'));
    const msg = message({ attachments: [{ id: 'att-4', type: 'IMAGE', mime: 'image/png', caption: 'Broken image' }] });

    renderWithProviders(<MessageBubble message={msg} isOwnMessage={false} />);

    expect(await screen.findByText('Broken image')).toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it.each(['VIDEO', 'DOCUMENT', 'STICKER', 'UNSUPPORTED'] as const)('shows the safe type+caption fallback for an unsupported %s attachment, never fetching a signed URL', async (type) => {
    const msg = message({ attachments: [{ id: 'att-5', type, mime: null, caption: null }] });

    renderWithProviders(<MessageBubble message={msg} isOwnMessage={false} />);

    expect(await screen.findByText(type.toLowerCase())).toBeInTheDocument();
    expect(inboxApi.getAttachmentUrl).not.toHaveBeenCalled();
  });
});
