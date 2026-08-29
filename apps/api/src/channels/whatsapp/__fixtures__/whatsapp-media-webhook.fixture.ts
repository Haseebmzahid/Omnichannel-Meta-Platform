// Realistic WhatsApp Cloud API inbound media webhook payloads — verified
// directly against Meta's own current developer documentation on
// 2026-08-28 (see docs/meta/whatsapp-cloud-api.md's "Inbound media
// contract" section for the full field-level writeup and sources).
//
// These are documentation/contract fixtures, not a code change: no
// normalizer or type in this directory is modified by this file. Their
// only consumer today is whatsapp.normalizer.spec.ts's proof that the
// current, deliberately text-only normalizer still safely skips a
// *real-shaped* media payload (never crashes, never fabricates a Message
// row) — the same safe-skip behavior already covered by that file's
// existing minimal `{ type: 'image' }` fixture, now re-proven against the
// literal shape Meta actually sends. Building the real parser/download
// path against these fixtures is Task 7-9 proper, not this task.
//
// Each payload is wrapped in the same entry[].changes[].value.messages[]
// envelope as every other WhatsApp fixture in this test suite — only
// messages[0].type and the type-named nested object change.

const PHONE_NUMBER_ID = '1234567890';
const SENDER_WA_ID = '15550002222';

function envelope(message: Record<string, unknown>) {
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
              contacts: [{ wa_id: SENDER_WA_ID, profile: { name: 'Test Patient' } }],
              messages: [
                {
                  id: 'wamid.MEDIA_TEST',
                  from: SENDER_WA_ID,
                  timestamp: '1735689600',
                  ...message,
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

// image — caption, mime_type, sha256, id, url (url is the gradually-rolled-out
// field, live since 2025-11-12 per Meta's own doc — see the "Not safe to
// assume present" caveat in docs/meta/whatsapp-cloud-api.md).
export const WHATSAPP_IMAGE_WEBHOOK = envelope({
  type: 'image',
  image: {
    caption: 'Taj Mahal',
    mime_type: 'image/jpeg',
    sha256: 'SfInY0gGKTsJlUWbwxC1k+FAD0FZHvzwfpvO0zX0GUI=',
    id: '1003383421387256',
    url: 'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=133_example',
  },
});

// audio — voice:true is a WhatsApp voice-note recording (maps to this
// repo's AttachmentType.VOICE, distinct from AttachmentType.AUDIO).
export const WHATSAPP_VOICE_NOTE_WEBHOOK = envelope({
  type: 'audio',
  audio: {
    mime_type: 'audio/ogg; codecs=opus',
    sha256: 'wvqXMe6n7n1W0zphvLPoLj+s/NtKqmr3zZ7YzTP7xFI=',
    id: '1908647269898587',
    voice: true,
  },
});

// document — the only media type carrying a filename field.
export const WHATSAPP_DOCUMENT_WEBHOOK = envelope({
  type: 'document',
  document: {
    caption: 'my receipt',
    filename: 'receipt.pdf',
    mime_type: 'application/pdf',
    sha256: 'V5OPpLD/gEG6Xjg0MbmQDLFgcKsL+j5LfY4ny/pZ4MY=',
    id: '622684793477189',
  },
});

// sticker — animated boolean, mime_type is always image/webp.
export const WHATSAPP_STICKER_WEBHOOK = envelope({
  type: 'sticker',
  sticker: {
    mime_type: 'image/webp',
    sha256: 'wvqXMe6n7n1W0zphvLPoLj+s/NtKqmr3zZ7YzTP7xFI=',
    id: '1908647269898588',
    animated: true,
  },
});

export const ALL_WHATSAPP_MEDIA_WEBHOOK_FIXTURES = [
  WHATSAPP_IMAGE_WEBHOOK,
  WHATSAPP_VOICE_NOTE_WEBHOOK,
  WHATSAPP_DOCUMENT_WEBHOOK,
  WHATSAPP_STICKER_WEBHOOK,
];
