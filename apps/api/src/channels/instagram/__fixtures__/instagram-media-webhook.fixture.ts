// Realistic Instagram (Page-linked) inbound media-attachment webhook
// payloads — verified directly against Meta's own current developer
// documentation on 2026-08-28 (see docs/meta/instagram-messaging.md's
// "Inbound media (attachments) contract" section, which cross-references
// facebook-messenger.md's own section for the full field-level detail —
// both channels share this exact event shape).
//
// These are documentation/contract fixtures, not a code change: no
// normalizer or type in this directory is modified by this file. Their
// only consumer today is instagram.normalizer.spec.ts's proof that the
// current, deliberately text-only normalizer still safely skips a
// *real-shaped* attachment payload — the same safe-skip behavior already
// covered by that file's existing minimal `{ type: 'image' }` fixture, now
// re-proven against the literal shape Meta actually sends. Building the
// real parser/download path against these fixtures is Task 7-9 proper, not
// this task.

const RECIPIENT_IGSID = 'ig-recipient-1';
const SENDER_IGSID = 'ig-sender-1';

function envelope(message: Record<string, unknown>) {
  return {
    object: 'instagram',
    entry: [
      {
        id: RECIPIENT_IGSID,
        time: 1735689600000,
        messaging: [
          {
            sender: { id: SENDER_IGSID },
            recipient: { id: RECIPIENT_IGSID },
            timestamp: 1735689600000,
            message: { mid: 'ig-mid-media-test', ...message },
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
export const INSTAGRAM_IMAGE_ATTACHMENT_WEBHOOK = envelope({
  attachments: [{ type: 'image', payload: { url: 'https://scontent.example.test/ig-image.jpg' } }],
});

export const INSTAGRAM_VIDEO_ATTACHMENT_WEBHOOK = envelope({
  attachments: [{ type: 'video', payload: { url: 'https://scontent.example.test/ig-video.mp4' } }],
});

export const INSTAGRAM_AUDIO_ATTACHMENT_WEBHOOK = envelope({
  attachments: [{ type: 'audio', payload: { url: 'https://scontent.example.test/ig-audio.mp3' } }],
});

// "file" is Messenger/Instagram's generic document-equivalent type name —
// there is no separate "document" type the way WhatsApp has one.
export const INSTAGRAM_FILE_ATTACHMENT_WEBHOOK = envelope({
  attachments: [{ type: 'file', payload: { url: 'https://scontent.example.test/ig-file.pdf' } }],
});

// sticker — carries payload.sticker_id in addition to payload.url (per
// Meta's documented 90-day sticker/image transition through 2026-08-30).
export const INSTAGRAM_STICKER_ATTACHMENT_WEBHOOK = envelope({
  attachments: [{ type: 'sticker', payload: { url: 'https://scontent.example.test/ig-sticker.webp', sticker_id: '369239263222822' } }],
});

export const ALL_INSTAGRAM_MEDIA_WEBHOOK_FIXTURES = [
  INSTAGRAM_IMAGE_ATTACHMENT_WEBHOOK,
  INSTAGRAM_VIDEO_ATTACHMENT_WEBHOOK,
  INSTAGRAM_AUDIO_ATTACHMENT_WEBHOOK,
  INSTAGRAM_FILE_ATTACHMENT_WEBHOOK,
  INSTAGRAM_STICKER_ATTACHMENT_WEBHOOK,
];
