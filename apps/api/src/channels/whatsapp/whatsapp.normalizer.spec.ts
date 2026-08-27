import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { ChannelKey, MessageContentType, MessageDeliveryStatus } from '../../generated/prisma/enums';
import { extractWhatsAppMessageChanges, normalizeWhatsAppInboundMessages, normalizeWhatsAppStatuses } from './whatsapp.normalizer';
import type { WhatsAppChangeValue, WhatsAppWebhookPayload } from './whatsapp.types';

const CLINIC_ID = 'clinic-uuid';
const PHONE_NUMBER_ID = '1234567890';

function textPayload(): WhatsAppWebhookPayload {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'waba-1',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { phone_number_id: PHONE_NUMBER_ID, display_phone_number: '15550001111' },
              contacts: [{ wa_id: '15550002222', profile: { name: 'Test Patient' } }],
              messages: [
                {
                  id: 'wamid.TEST1',
                  from: '15550002222',
                  timestamp: '1735689600',
                  type: 'text',
                  text: { body: 'hello there' },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

describe('extractWhatsAppMessageChanges', () => {
  it('extracts the value of every "messages"-field change', () => {
    const values = extractWhatsAppMessageChanges(textPayload());
    expect(values).toHaveLength(1);
    expect(values[0]?.metadata?.phone_number_id).toBe(PHONE_NUMBER_ID);
  });

  it('ignores a payload whose object is not "whatsapp_business_account"', () => {
    expect(extractWhatsAppMessageChanges({ object: 'page', entry: [] })).toEqual([]);
  });

  it('ignores a change whose field is not "messages"', () => {
    const payload: WhatsAppWebhookPayload = {
      object: 'whatsapp_business_account',
      entry: [{ id: 'waba-1', changes: [{ field: 'message_template_status_update', value: {} }] }],
    };
    expect(extractWhatsAppMessageChanges(payload)).toEqual([]);
  });

  it('never throws on malformed/adversarial input', () => {
    expect(extractWhatsAppMessageChanges(null)).toEqual([]);
    expect(extractWhatsAppMessageChanges(undefined)).toEqual([]);
    expect(extractWhatsAppMessageChanges('not an object')).toEqual([]);
    expect(extractWhatsAppMessageChanges({})).toEqual([]);
    expect(extractWhatsAppMessageChanges({ object: 'whatsapp_business_account', entry: [null, {}] })).toEqual([]);
  });
});

describe('normalizeWhatsAppInboundMessages', () => {
  it('1. a valid text message normalizes to the channel-neutral contract', () => {
    const [value] = extractWhatsAppMessageChanges(textPayload());
    const [normalized] = normalizeWhatsAppInboundMessages(value as WhatsAppChangeValue, CLINIC_ID);

    expect(normalized).toBeDefined();
    expect(normalized).toMatchObject({
      clinicId: CLINIC_ID,
      channelKey: ChannelKey.WHATSAPP,
      channelAccountRef: PHONE_NUMBER_ID,
      externalContactId: '15550002222',
      externalThreadKey: '15550002222',
      externalMessageId: 'wamid.TEST1',
      direction: 'INBOUND',
      senderDisplayName: 'Test Patient',
      contentType: MessageContentType.TEXT,
      text: 'hello there',
    });
    expect(normalized?.receivedAt).toEqual(new Date(1735689600 * 1000));
  });

  it('2. maps to ChannelKey.WHATSAPP specifically', () => {
    const [value] = extractWhatsAppMessageChanges(textPayload());
    const [normalized] = normalizeWhatsAppInboundMessages(value as WhatsAppChangeValue, CLINIC_ID);
    expect(normalized?.channelKey).toBe(ChannelKey.WHATSAPP);
  });

  it('3. carries a reply-to id from message.context.id when present', () => {
    const payload = textPayload();
    const message = payload.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (message) message.context = { id: 'wamid.PARENT' };

    const [value] = extractWhatsAppMessageChanges(payload);
    const [normalized] = normalizeWhatsAppInboundMessages(value as WhatsAppChangeValue, CLINIC_ID);
    expect(normalized?.replyToExternalMessageId).toBe('wamid.PARENT');
  });

  it('4. an unsupported message type produces no normalized message (safe skip, no crash)', () => {
    const payload = textPayload();
    const message = payload.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (message) {
      message.type = 'unsupported';
      message.text = undefined;
      message.errors = [{ code: 131051, title: 'Unsupported message type' }];
    }

    const [value] = extractWhatsAppMessageChanges(payload);
    expect(() => normalizeWhatsAppInboundMessages(value as WhatsAppChangeValue, CLINIC_ID)).not.toThrow();
    expect(normalizeWhatsAppInboundMessages(value as WhatsAppChangeValue, CLINIC_ID)).toEqual([]);
  });

  it('5. a non-text message type (e.g. image) produces no normalized message', () => {
    const payload = textPayload();
    const message = payload.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (message) {
      message.type = 'image';
      message.text = undefined;
    }

    const [value] = extractWhatsAppMessageChanges(payload);
    expect(normalizeWhatsAppInboundMessages(value as WhatsAppChangeValue, CLINIC_ID)).toEqual([]);
  });

  it('6. a status-only value (delivery/read receipts) produces no normalized message', () => {
    const value: WhatsAppChangeValue = {
      messaging_product: 'whatsapp',
      metadata: { phone_number_id: PHONE_NUMBER_ID },
      statuses: [{ id: 'wamid.TEST1', status: 'delivered' }],
    };
    expect(normalizeWhatsAppInboundMessages(value, CLINIC_ID)).toEqual([]);
  });

  it('7. a message missing id/from is skipped rather than crashing', () => {
    const value: WhatsAppChangeValue = {
      metadata: { phone_number_id: PHONE_NUMBER_ID },
      messages: [{ type: 'text', text: { body: 'no id or from' } }],
    };
    expect(() => normalizeWhatsAppInboundMessages(value, CLINIC_ID)).not.toThrow();
    expect(normalizeWhatsAppInboundMessages(value, CLINIC_ID)).toEqual([]);
  });

  it('8. no phone_number_id means nothing is normalized', () => {
    const value: WhatsAppChangeValue = {
      messages: [{ id: 'wamid.TEST1', from: '15550002222', type: 'text', text: { body: 'hi' } }],
    };
    expect(normalizeWhatsAppInboundMessages(value, CLINIC_ID)).toEqual([]);
  });
});

describe('normalizeWhatsAppStatuses', () => {
  it('1. a "delivered" status maps to MessageDeliveryStatus.DELIVERED', () => {
    const value: WhatsAppChangeValue = {
      statuses: [{ id: 'wamid.TEST1', status: 'delivered', timestamp: '1735689600', recipient_id: '15550002222' }],
    };
    const [update] = normalizeWhatsAppStatuses(value, PHONE_NUMBER_ID);
    expect(update).toMatchObject({
      channelKey: ChannelKey.WHATSAPP,
      channelAccountRef: PHONE_NUMBER_ID,
      externalMessageId: 'wamid.TEST1',
      status: MessageDeliveryStatus.DELIVERED,
    });
    expect(update?.occurredAt).toEqual(new Date(1735689600 * 1000));
  });

  it('2. "sent" and "read" map correctly too', () => {
    const value: WhatsAppChangeValue = {
      statuses: [
        { id: 'wamid.A', status: 'sent' },
        { id: 'wamid.B', status: 'read' },
      ],
    };
    const [sent, read] = normalizeWhatsAppStatuses(value, PHONE_NUMBER_ID);
    expect(sent?.status).toBe(MessageDeliveryStatus.SENT);
    expect(read?.status).toBe(MessageDeliveryStatus.READ);
  });

  it('3. a "failed" status carries safe failure metadata, never the raw Meta error text', () => {
    const value: WhatsAppChangeValue = {
      statuses: [{ id: 'wamid.TEST1', status: 'failed', errors: [{ code: 131050, title: 'Recipient not on WhatsApp', message: 'raw meta text' }] }],
    };
    const [update] = normalizeWhatsAppStatuses(value, PHONE_NUMBER_ID);
    expect(update?.status).toBe(MessageDeliveryStatus.FAILED);
    expect(update?.failureClass).toBe('meta_status_failed');
    expect(update?.failureCode).toBe('131050');
    expect(update?.failureMessage).not.toContain('raw meta text');
    expect(update?.failureMessage).not.toContain('Recipient not on WhatsApp');
  });

  it('4. a non-failed status carries no failure fields at all', () => {
    const value: WhatsAppChangeValue = { statuses: [{ id: 'wamid.TEST1', status: 'read' }] };
    const [update] = normalizeWhatsAppStatuses(value, PHONE_NUMBER_ID);
    expect(update?.failureClass).toBeUndefined();
    expect(update?.failureCode).toBeUndefined();
    expect(update?.failureMessage).toBeUndefined();
  });

  it('5. an unrecognized future status value is safely skipped, not guessed at', () => {
    const value: WhatsAppChangeValue = { statuses: [{ id: 'wamid.TEST1', status: 'some_future_status' }] };
    expect(normalizeWhatsAppStatuses(value, PHONE_NUMBER_ID)).toEqual([]);
  });

  it('6. a malformed status event (missing id or status) is skipped rather than crashing', () => {
    const missingId: WhatsAppChangeValue = { statuses: [{ status: 'delivered' }] };
    const missingStatus: WhatsAppChangeValue = { statuses: [{ id: 'wamid.TEST1' }] };
    expect(() => normalizeWhatsAppStatuses(missingId, PHONE_NUMBER_ID)).not.toThrow();
    expect(normalizeWhatsAppStatuses(missingId, PHONE_NUMBER_ID)).toEqual([]);
    expect(normalizeWhatsAppStatuses(missingStatus, PHONE_NUMBER_ID)).toEqual([]);
  });

  it('7. no statuses on the value means nothing is normalized', () => {
    expect(normalizeWhatsAppStatuses({}, PHONE_NUMBER_ID)).toEqual([]);
  });

  it('8. a batch mixing inbound messages and statuses normalizes both independently', () => {
    const payload = textPayload();
    const value = payload.entry?.[0]?.changes?.[0]?.value;
    if (value) value.statuses = [{ id: 'wamid.STATUS1', status: 'delivered' }];

    const [extracted] = extractWhatsAppMessageChanges(payload);
    const messages = normalizeWhatsAppInboundMessages(extracted as WhatsAppChangeValue, CLINIC_ID);
    const statuses = normalizeWhatsAppStatuses(extracted as WhatsAppChangeValue, PHONE_NUMBER_ID);

    expect(messages).toHaveLength(1);
    expect(statuses).toHaveLength(1);
    expect(statuses[0]?.externalMessageId).toBe('wamid.STATUS1');
  });
});
