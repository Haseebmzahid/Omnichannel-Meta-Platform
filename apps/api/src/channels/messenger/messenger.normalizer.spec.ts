import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { AttachmentType, ChannelKey, MessageContentType, MessageDeliveryStatus } from '../../generated/prisma/enums';
import { ALL_MESSENGER_MEDIA_WEBHOOK_FIXTURES, MESSENGER_STICKER_ATTACHMENT_WEBHOOK } from './__fixtures__/messenger-media-webhook.fixture';
import {
  extractMessengerMediaRef,
  extractMessengerMessagingEvents,
  normalizeMessengerDeliveries,
  normalizeMessengerInboundMessage,
} from './messenger.normalizer';
import type { MessengerMessagingEvent, MessengerWebhookPayload } from './messenger.types';

const CLINIC_ID = 'clinic-uuid';
const PAGE_ID = 'msgr-page-1';
const SENDER_PSID = 'psid-sender-1';

function textPayload(): MessengerWebhookPayload {
  return {
    object: 'page',
    entry: [
      {
        id: PAGE_ID,
        time: 1735689600000,
        messaging: [
          {
            sender: { id: SENDER_PSID },
            recipient: { id: PAGE_ID },
            timestamp: 1735689600000,
            message: { mid: 'msgr-mid-1', text: 'hello there' },
          },
        ],
      },
    ],
  };
}

describe('extractMessengerMessagingEvents', () => {
  it('extracts every messaging event from every entry', () => {
    const events = extractMessengerMessagingEvents(textPayload());
    expect(events).toHaveLength(1);
    expect(events[0]?.sender?.id).toBe(SENDER_PSID);
  });

  it('ignores a payload whose object is not "page"', () => {
    expect(extractMessengerMessagingEvents({ object: 'instagram', entry: [] })).toEqual([]);
  });

  it('never throws on malformed/adversarial input', () => {
    expect(extractMessengerMessagingEvents(null)).toEqual([]);
    expect(extractMessengerMessagingEvents(undefined)).toEqual([]);
    expect(extractMessengerMessagingEvents('not an object')).toEqual([]);
    expect(extractMessengerMessagingEvents({})).toEqual([]);
    expect(extractMessengerMessagingEvents({ object: 'page', entry: [null, {}] })).toEqual([]);
  });
});

describe('normalizeMessengerInboundMessage', () => {
  it('1. a valid text message normalizes to the channel-neutral contract', () => {
    const [event] = extractMessengerMessagingEvents(textPayload());
    const normalized = normalizeMessengerInboundMessage(event as MessengerMessagingEvent, CLINIC_ID);

    expect(normalized).toMatchObject({
      clinicId: CLINIC_ID,
      channelKey: ChannelKey.MESSENGER,
      channelAccountRef: PAGE_ID,
      externalContactId: SENDER_PSID,
      externalThreadKey: SENDER_PSID,
      externalMessageId: 'msgr-mid-1',
      direction: 'INBOUND',
      contentType: MessageContentType.TEXT,
      text: 'hello there',
    });
    expect(normalized?.receivedAt).toEqual(new Date(1735689600000));
  });

  it('2. maps to ChannelKey.MESSENGER specifically', () => {
    const [event] = extractMessengerMessagingEvents(textPayload());
    const normalized = normalizeMessengerInboundMessage(event as MessengerMessagingEvent, CLINIC_ID);
    expect(normalized?.channelKey).toBe(ChannelKey.MESSENGER);
  });

  it('3. carries a reply-to id from message.reply_to.mid when present', () => {
    const payload = textPayload();
    const event = payload.entry?.[0]?.messaging?.[0];
    if (event?.message) event.message.reply_to = { mid: 'msgr-mid-parent' };

    const normalized = normalizeMessengerInboundMessage(event as MessengerMessagingEvent, CLINIC_ID);
    expect(normalized?.replyToExternalMessageId).toBe('msgr-mid-parent');
  });

  it('4. an echo of our own outbound send produces no normalized message', () => {
    const payload = textPayload();
    const event = payload.entry?.[0]?.messaging?.[0];
    if (event?.message) event.message.is_echo = true;

    expect(() => normalizeMessengerInboundMessage(event as MessengerMessagingEvent, CLINIC_ID)).not.toThrow();
    expect(normalizeMessengerInboundMessage(event as MessengerMessagingEvent, CLINIC_ID)).toBeNull();
  });

  it('5. a non-text message (attachment only, no text) produces no normalized message', () => {
    const event: MessengerMessagingEvent = {
      sender: { id: SENDER_PSID },
      recipient: { id: PAGE_ID },
      timestamp: 1735689600000,
      message: { mid: 'msgr-mid-2', attachments: [{ type: 'image' }] },
    };
    expect(normalizeMessengerInboundMessage(event, CLINIC_ID)).toBeNull();
  });

  it('6. an event with no `message` (delivery/read receipt, postback) produces no normalized message', () => {
    const event: MessengerMessagingEvent = { sender: { id: SENDER_PSID }, recipient: { id: PAGE_ID } };
    expect(() => normalizeMessengerInboundMessage(event, CLINIC_ID)).not.toThrow();
    expect(normalizeMessengerInboundMessage(event, CLINIC_ID)).toBeNull();
  });

  it('7. an event missing sender/recipient id is skipped rather than crashing', () => {
    const event: MessengerMessagingEvent = { message: { mid: 'msgr-mid-3', text: 'no sender' } };
    expect(() => normalizeMessengerInboundMessage(event, CLINIC_ID)).not.toThrow();
    expect(normalizeMessengerInboundMessage(event, CLINIC_ID)).toBeNull();
  });

  it('8. an event missing message.mid is skipped rather than crashing', () => {
    const event: MessengerMessagingEvent = {
      sender: { id: SENDER_PSID },
      recipient: { id: PAGE_ID },
      message: { text: 'no mid' },
    };
    expect(normalizeMessengerInboundMessage(event, CLINIC_ID)).toBeNull();
  });

  it('9. falls back to the current time when timestamp is missing/invalid', () => {
    const event: MessengerMessagingEvent = {
      sender: { id: SENDER_PSID },
      recipient: { id: PAGE_ID },
      message: { mid: 'msgr-mid-4', text: 'no timestamp' },
    };
    const before = Date.now();
    const normalized = normalizeMessengerInboundMessage(event, CLINIC_ID);
    expect(normalized?.receivedAt.getTime()).toBeGreaterThanOrEqual(before);
  });

  // Task 7-9 prerequisite (2026-08-28 Meta-doc verification pass) — proves
  // the current safe-skip behavior holds against the *real* attachment
  // shape Meta actually sends (image/video/audio/file/sticker), not just a
  // minimal `{ type: 'image' }` toy input. See __fixtures__/
  // messenger-media-webhook.fixture.ts and docs/meta/facebook-messenger.md's
  // "Inbound media (attachments) contract" section.
  // Task 7-9 — updated from the prerequisite verification pass's own test:
  // that pass proved these real-shaped attachment payloads were safely
  // SKIPPED (no media persistence existed yet). Now that
  // MessengerMediaIngestService exists, these same fixtures must normalize
  // to a real MEDIA message instead.
  it('10. every real-shaped media attachment webhook (image/video/audio/file/sticker) normalizes to a MEDIA message, never throws', () => {
    for (const payload of ALL_MESSENGER_MEDIA_WEBHOOK_FIXTURES) {
      const [event] = extractMessengerMessagingEvents(payload);
      expect(event).toBeDefined();
      expect(() => normalizeMessengerInboundMessage(event as MessengerMessagingEvent, CLINIC_ID)).not.toThrow();

      const normalized = normalizeMessengerInboundMessage(event as MessengerMessagingEvent, CLINIC_ID);
      expect(normalized?.contentType).toBe(MessageContentType.MEDIA);
      expect(normalized?.text).toBeTruthy();
    }
  });
});

describe('extractMessengerMediaRef', () => {
  it('maps a supported attachment to its url/attachmentType', () => {
    const [event] = extractMessengerMessagingEvents(MESSENGER_STICKER_ATTACHMENT_WEBHOOK);
    const ref = extractMessengerMediaRef((event as MessengerMessagingEvent).message);
    expect(ref).toEqual({ url: 'https://scontent.example.test/msgr-sticker.webp', attachmentType: AttachmentType.STICKER });
  });

  it('returns null for a text message (no attachments)', () => {
    const ref = extractMessengerMediaRef({ mid: 'msgr-mid-1', text: 'hello' });
    expect(ref).toBeNull();
  });

  it('never throws on malformed/adversarial input', () => {
    expect(() => extractMessengerMediaRef(undefined)).not.toThrow();
    expect(extractMessengerMediaRef(undefined)).toBeNull();
    expect(() => extractMessengerMediaRef({ mid: 'x', attachments: [null, {}] } as never)).not.toThrow();
  });
});

describe('normalizeMessengerDeliveries', () => {
  it('1. a delivery event with mids maps each mid to a DELIVERED update', () => {
    const events: MessengerMessagingEvent[] = [
      {
        sender: { id: SENDER_PSID },
        recipient: { id: PAGE_ID },
        delivery: { mids: ['msgr-mid-a', 'msgr-mid-b'], watermark: 1735689600000 },
      },
    ];
    const updates = normalizeMessengerDeliveries(events, PAGE_ID);

    expect(updates).toHaveLength(2);
    expect(updates[0]).toMatchObject({
      channelKey: ChannelKey.MESSENGER,
      channelAccountRef: PAGE_ID,
      externalMessageId: 'msgr-mid-a',
      status: MessageDeliveryStatus.DELIVERED,
    });
    expect(updates[0]?.occurredAt).toEqual(new Date(1735689600000));
    expect(updates[1]?.externalMessageId).toBe('msgr-mid-b');
  });

  it('2. an event with no delivery field contributes nothing', () => {
    const events: MessengerMessagingEvent[] = [{ sender: { id: SENDER_PSID }, recipient: { id: PAGE_ID }, message: { mid: 'x', text: 'hi' } }];
    expect(normalizeMessengerDeliveries(events, PAGE_ID)).toEqual([]);
  });

  it('3. a delivery event with an empty mids array contributes nothing', () => {
    const events: MessengerMessagingEvent[] = [{ sender: { id: SENDER_PSID }, recipient: { id: PAGE_ID }, delivery: { mids: [], watermark: 1 } }];
    expect(normalizeMessengerDeliveries(events, PAGE_ID)).toEqual([]);
  });

  it('4. never throws on malformed/adversarial input', () => {
    expect(() => normalizeMessengerDeliveries([{}], PAGE_ID)).not.toThrow();
    expect(normalizeMessengerDeliveries([{}], PAGE_ID)).toEqual([]);
  });

  it('5. a read receipt (no mids, watermark only) is never normalized as a delivery — documented limitation', () => {
    const events: MessengerMessagingEvent[] = [{ sender: { id: SENDER_PSID }, recipient: { id: PAGE_ID }, read: { watermark: 1735689600000 } }];
    expect(normalizeMessengerDeliveries(events, PAGE_ID)).toEqual([]);
  });

  it('6. a batch mixing an inbound message and a delivery receipt normalizes both independently', () => {
    const events: MessengerMessagingEvent[] = [
      { sender: { id: SENDER_PSID }, recipient: { id: PAGE_ID }, timestamp: 1735689600000, message: { mid: 'msgr-mid-5', text: 'hi' } },
      { sender: { id: SENDER_PSID }, recipient: { id: PAGE_ID }, delivery: { mids: ['msgr-mid-5'], watermark: 1735689600000 } },
    ];

    const [inboundEvent] = events;
    const message = normalizeMessengerInboundMessage(inboundEvent as MessengerMessagingEvent, CLINIC_ID);
    const deliveries = normalizeMessengerDeliveries(events, PAGE_ID);

    expect(message?.externalMessageId).toBe('msgr-mid-5');
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.externalMessageId).toBe('msgr-mid-5');
  });
});
