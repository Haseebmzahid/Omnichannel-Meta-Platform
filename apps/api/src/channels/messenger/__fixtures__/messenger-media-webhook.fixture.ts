// Realistic Facebook Page Messenger inbound media-attachment webhook
// payloads — verified directly against Meta's own current developer
// documentation on 2026-08-28 (see docs/meta/facebook-messenger.md's
// "Inbound media (attachments) contract" section for the full field-level
// writeup and sources — Instagram's Page-linked path shares this exact
// same shape, see instagram-messaging.md's own section).
//
// These are documentation/contract fixtures, not a code change: no
// normalizer or type in this directory is modified by this file. Their
// only consumer today is messenger.normalizer.spec.ts's proof that the
// current, deliberately text-only normalizer still safely skips a
// *real-shaped* attachment payload — the same safe-skip behavior already
// covered by that file's existing minimal `{ type: 'image' }` fixture, now
// re-proven against the literal shape Meta actually sends. Building the
// real parser/download path against these fixtures is Task 7-9 proper, not
// this task.

const PAGE_ID = 'page-1';
const SENDER_PSID = 'psid-sender-1';

function envelope(message: Record<string, unknown>) {
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
            message: { mid: 'msgr-mid-media-test', ...message },
          },
        ],
      },
    ],
  };
}

// image — the "type" field is the only type-indicator; Meta provides no
// mime_type/file_size on Messenger/Instagram attachments (unlike
// WhatsApp) — see the "No MIME type or file size is provided" caveat in
// docs/meta/facebook-messenger.md.
export const MESSENGER_IMAGE_ATTACHMENT_WEBHOOK = envelope({
  attachments: [{ type: 'image', payload: { url: 'https://scontent.example.test/msgr-image.jpg' } }],
});

export const MESSENGER_VIDEO_ATTACHMENT_WEBHOOK = envelope({
  attachments: [{ type: 'video', payload: { url: 'https://scontent.example.test/msgr-video.mp4' } }],
});

export const MESSENGER_AUDIO_ATTACHMENT_WEBHOOK = envelope({
  attachments: [{ type: 'audio', payload: { url: 'https://scontent.example.test/msgr-audio.mp3' } }],
});

// "file" is Messenger's generic document-equivalent type name — there is
// no separate "document" type the way WhatsApp has one.
export const MESSENGER_FILE_ATTACHMENT_WEBHOOK = envelope({
  attachments: [{ type: 'file', payload: { url: 'https://scontent.example.test/msgr-file.pdf' } }],
});

// sticker — carries payload.sticker_id in addition to payload.url (per
// Meta's documented 90-day sticker/image transition through 2026-08-30,
// during which both "sticker" and "image" attachment types may describe
// the same content).
export const MESSENGER_STICKER_ATTACHMENT_WEBHOOK = envelope({
  attachments: [{ type: 'sticker', payload: { url: 'https://scontent.example.test/msgr-sticker.webp', sticker_id: '369239263222822' } }],
});

export const ALL_MESSENGER_MEDIA_WEBHOOK_FIXTURES = [
  MESSENGER_IMAGE_ATTACHMENT_WEBHOOK,
  MESSENGER_VIDEO_ATTACHMENT_WEBHOOK,
  MESSENGER_AUDIO_ATTACHMENT_WEBHOOK,
  MESSENGER_FILE_ATTACHMENT_WEBHOOK,
  MESSENGER_STICKER_ATTACHMENT_WEBHOOK,
];
