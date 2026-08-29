import { Injectable } from '@nestjs/common';
import { logger } from '../../logging/logger';
import { uploadAndAttachMedia } from '../../messaging/attachment-ingest';
import type { MediaStorage } from '../../media/media-storage.interface';
import { MessageService } from '../../messaging/message.service';
import type { InstagramMediaRef } from './instagram.normalizer';

// Task 7-9 — the Instagram-specific half of inbound media persistence.
// Unlike WhatsApp, there is no media-id/auth-fetch step: docs/meta/
// instagram-messaging.md's already-VERIFIED note ("media is not fetched by
// authenticated ID the way WhatsApp media is") means payload.url is the
// only thing the webhook gives, and this system's own research could not
// confirm from Meta's own documentation whether fetching it needs any
// authentication at all (see that doc's "Not established" section) — this
// attempts a plain, unauthenticated GET, the best-supported reading of both
// this repo's own doc and third-party implementer reports. If that
// assumption is ever wrong in production, the download fails safely (see
// below) rather than silently mis-authenticating.
//
// This class's ingest() method NEVER throws — every failure (HTTP error,
// network error, MediaStorage failure) is caught, safely logged, and
// swallowed, so a media-download/storage problem can never turn a valid
// webhook into a failed one and never leaves a storageRef fabricated for a
// failed upload.
@Injectable()
export class InstagramMediaIngestService {
  constructor(
    private readonly mediaStorage: MediaStorage,
    private readonly messageService: MessageService,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async ingest(clinicId: string, messageId: string, ref: InstagramMediaRef): Promise<void> {
    try {
      const downloaded = await this.downloadMedia(ref.url);
      if (!downloaded) return;

      await uploadAndAttachMedia(this.mediaStorage, this.messageService, {
        clinicId,
        messageId,
        // No natural per-attachment identifier from Meta (unlike WhatsApp's
        // media id) — only one attachment is persisted per message in this
        // slice, so a fixed segment is enough to keep the key
        // clinic/message-scoped without collision.
        attachmentId: 'primary',
        type: ref.attachmentType,
        bytes: downloaded.bytes,
        // Meta provides no mime_type in the webhook payload for this
        // channel (docs/meta/facebook-messenger.md's "No MIME type or file
        // size is provided" — Instagram shares the same contract) — only
        // the downloaded response's own Content-Type header is a real,
        // non-invented source for it.
        mime: downloaded.mime,
      });
    } catch (err) {
      logger.error({ messageId, err: sanitizeError(err) }, 'Instagram: media ingestion failed, message persisted without attachment');
    }
  }

  // Returns bytes and mime together (never a shared instance field) — this
  // service is a singleton-scoped Nest provider, so per-call state must
  // never live on `this` or two concurrent webhook requests could leak
  // each other's content-type.
  private async downloadMedia(url: string): Promise<{ bytes: Buffer; mime?: string } | null> {
    const response = await this.fetchImpl(url);
    if (!response.ok) {
      logger.warn({ status: response.status }, 'Instagram: media download failed');
      return null;
    }
    const mime = response.headers.get('content-type') ?? undefined;
    return { bytes: Buffer.from(await response.arrayBuffer()), mime };
  }
}

function sanitizeError(err: unknown): { name?: string; message?: string } {
  if (!(err instanceof Error)) return { message: 'Unknown error' };
  return { name: err.name, message: err.message };
}
