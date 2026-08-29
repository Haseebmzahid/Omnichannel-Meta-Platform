import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { AttachmentType, ChannelKey, MessageContentType } from '../../generated/prisma/enums';
import { ALL_INSTAGRAM_MEDIA_WEBHOOK_FIXTURES, INSTAGRAM_STICKER_ATTACHMENT_WEBHOOK } from './__fixtures__/instagram-media-webhook.fixture';
import { extractInstagramMediaRef, extractInstagramMessagingEvents, normalizeInstagramInboundMessage } from './instagram.normalizer';
import type { InstagramMessagingEvent, InstagramWebhookPayload } from './instagram.types';

const CLINIC_ID = 'clinic-uuid';
const ACCOUNT_ID = 'ig-account-1';
const SENDER_IGSID = 'igsid-sender-1';

function textPayload(): InstagramWebhookPayload {
  return {
    object: 'instagram',
    entry: [
      {
        id: ACCOUNT_ID,
        time: 1735689600000,
        messaging: [
          {
            sender: { id: SENDER_IGSID },
            recipient: { id: ACCOUNT_ID },
            timestamp: 1735689600000,
            message: { mid: 'ig-mid-1', text: 'hello there' },
          },
        ],
      },
    ],
  };
}

describe('extractInstagramMessagingEvents', () => {
  it('extracts every messaging event from every entry', () => {
    const events = extractInstagramMessagingEvents(textPayload());
    expect(events).toHaveLength(1);
    expect(events[0]?.sender?.id).toBe(SENDER_IGSID);
  });

  it('ignores a payload whose object is not "instagram"', () => {
    expect(extractInstagramMessagingEvents({ object: 'page', entry: [] })).toEqual([]);
  });

  it('never throws on malformed/adversarial input', () => {
    expect(extractInstagramMessagingEvents(null)).toEqual([]);
    expect(extractInstagramMessagingEvents(undefined)).toEqual([]);
    expect(extractInstagramMessagingEvents('not an object')).toEqual([]);
    expect(extractInstagramMessagingEvents({})).toEqual([]);
    expect(extractInstagramMessagingEvents({ object: 'instagram', entry: [null, {}] })).toEqual([]);
  });
});

describe('normalizeInstagramInboundMessage', () => {
  it('1. a valid text message normalizes to the channel-neutral contract', () => {
    const [event] = extractInstagramMessagingEvents(textPayload());
    const normalized = normalizeInstagramInboundMessage(event as InstagramMessagingEvent, CLINIC_ID);

    expect(normalized).toMatchObject({
      clinicId: CLINIC_ID,
      channelKey: ChannelKey.INSTAGRAM,
      channelAccountRef: ACCOUNT_ID,
      externalContactId: SENDER_IGSID,
      externalThreadKey: SENDER_IGSID,
      externalMessageId: 'ig-mid-1',
      direction: 'INBOUND',
      contentType: MessageContentType.TEXT,
      text: 'hello there',
    });
    expect(normalized?.receivedAt).toEqual(new Date(1735689600000));
  });

  it('2. maps to ChannelKey.INSTAGRAM specifically', () => {
    const [event] = extractInstagramMessagingEvents(textPayload());
    const normalized = normalizeInstagramInboundMessage(event as InstagramMessagingEvent, CLINIC_ID);
    expect(normalized?.channelKey).toBe(ChannelKey.INSTAGRAM);
  });

  it('3. carries a reply-to id from message.reply_to.mid when present', () => {
    const payload = textPayload();
    const event = payload.entry?.[0]?.messaging?.[0];
    if (event?.message) event.message.reply_to = { mid: 'ig-mid-parent' };

    const normalized = normalizeInstagramInboundMessage(event as InstagramMessagingEvent, CLINIC_ID);
    expect(normalized?.replyToExternalMessageId).toBe('ig-mid-parent');
  });

  it('4. an echo of our own outbound send produces no normalized message', () => {
    const payload = textPayload();
    const event = payload.entry?.[0]?.messaging?.[0];
    if (event?.message) event.message.is_echo = true;

    expect(() => normalizeInstagramInboundMessage(event as InstagramMessagingEvent, CLINIC_ID)).not.toThrow();
    expect(normalizeInstagramInboundMessage(event as InstagramMessagingEvent, CLINIC_ID)).toBeNull();
  });

  it('5. a non-text message (attachment only, no text) produces no normalized message', () => {
    const event: InstagramMessagingEvent = {
      sender: { id: SENDER_IGSID },
      recipient: { id: ACCOUNT_ID },
      timestamp: 1735689600000,
      message: { mid: 'ig-mid-2', attachments: [{ type: 'image' }] },
    };
    expect(normalizeInstagramInboundMessage(event, CLINIC_ID)).toBeNull();
  });

  it('6. an event with no `message` (read receipt/postback) produces no normalized message', () => {
    const event: InstagramMessagingEvent = { sender: { id: SENDER_IGSID }, recipient: { id: ACCOUNT_ID } };
    expect(() => normalizeInstagramInboundMessage(event, CLINIC_ID)).not.toThrow();
    expect(normalizeInstagramInboundMessage(event, CLINIC_ID)).toBeNull();
  });

  it('7. an event missing sender/recipient id is skipped rather than crashing', () => {
    const event: InstagramMessagingEvent = { message: { mid: 'ig-mid-3', text: 'no sender' } };
    expect(() => normalizeInstagramInboundMessage(event, CLINIC_ID)).not.toThrow();
    expect(normalizeInstagramInboundMessage(event, CLINIC_ID)).toBeNull();
  });

  it('8. an event missing message.mid is skipped rather than crashing', () => {
    const event: InstagramMessagingEvent = {
      sender: { id: SENDER_IGSID },
      recipient: { id: ACCOUNT_ID },
      message: { text: 'no mid' },
    };
    expect(normalizeInstagramInboundMessage(event, CLINIC_ID)).toBeNull();
  });

  it('9. falls back to the current time when timestamp is missing/invalid', () => {
    const event: InstagramMessagingEvent = {
      sender: { id: SENDER_IGSID },
      recipient: { id: ACCOUNT_ID },
      message: { mid: 'ig-mid-4', text: 'no timestamp' },
    };
    const before = Date.now();
    const normalized = normalizeInstagramInboundMessage(event, CLINIC_ID);
    expect(normalized?.receivedAt.getTime()).toBeGreaterThanOrEqual(before);
  });

  // Task 7-9 prerequisite (2026-08-28 Meta-doc verification pass) — proves
  // the current safe-skip behavior holds against the *real* attachment
  // shape Meta actually sends (image/video/audio/file/sticker), not just a
  // minimal `{ type: 'image' }` toy input. See __fixtures__/
  // instagram-media-webhook.fixture.ts and docs/meta/instagram-messaging.md's
  // "Inbound media (attachments) contract" section.
  // Task 7-9 — updated from the prerequisite verification pass's own test:
  // that pass proved these real-shaped attachment payloads were safely
  // SKIPPED (no media persistence existed yet). Now that
  // InstagramMediaIngestService exists, these same fixtures must normalize
  // to a real MEDIA message instead.
  it('10. every real-shaped media attachment webhook (image/video/audio/file/sticker) normalizes to a MEDIA message, never throws', () => {
    for (const payload of ALL_INSTAGRAM_MEDIA_WEBHOOK_FIXTURES) {
      const [event] = extractInstagramMessagingEvents(payload);
      expect(event).toBeDefined();
      expect(() => normalizeInstagramInboundMessage(event as InstagramMessagingEvent, CLINIC_ID)).not.toThrow();

      const normalized = normalizeInstagramInboundMessage(event as InstagramMessagingEvent, CLINIC_ID);
      expect(normalized?.contentType).toBe(MessageContentType.MEDIA);
      expect(normalized?.text).toBeTruthy();
    }
  });
});

describe('extractInstagramMediaRef', () => {
  it('maps a supported attachment to its url/attachmentType', () => {
    const [event] = extractInstagramMessagingEvents(INSTAGRAM_STICKER_ATTACHMENT_WEBHOOK);
    const ref = extractInstagramMediaRef((event as InstagramMessagingEvent).message);
    expect(ref).toEqual({ url: 'https://scontent.example.test/ig-sticker.webp', attachmentType: AttachmentType.STICKER });
  });

  it('returns null for a text message (no attachments)', () => {
    const ref = extractInstagramMediaRef({ mid: 'ig-mid-1', text: 'hello' });
    expect(ref).toBeNull();
  });

  it('never throws on malformed/adversarial input', () => {
    expect(() => extractInstagramMediaRef(undefined)).not.toThrow();
    expect(extractInstagramMediaRef(undefined)).toBeNull();
    expect(() => extractInstagramMediaRef({ mid: 'x', attachments: [null, {}] } as never)).not.toThrow();
  });
});
