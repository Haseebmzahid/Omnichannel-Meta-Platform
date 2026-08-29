import { Injectable } from '@nestjs/common';
import { logger } from '../../logging/logger';
import { uploadAndAttachMedia } from '../../messaging/attachment-ingest';
import type { MediaStorage } from '../../media/media-storage.interface';
import { MessageService } from '../../messaging/message.service';
import type { WhatsAppMediaRef } from './whatsapp.normalizer';

// Task 7-9 — the WhatsApp-specific half of inbound media persistence:
// docs/meta/whatsapp-cloud-api.md's "Retrieve Media URL + download" flow,
// re-VERIFIED against developers.facebook.com/docs/whatsapp/cloud-api/
// reference/media at implementation time:
//   1. GET https://graph.facebook.com/{version}/{mediaId}?phone_number_id=...
//      with Authorization: Bearer {accessToken} -> { url, mime_type, ... }
//   2. GET that url, same Authorization header -> the actual bytes
//      (url expires after 5 minutes; the metadata call above is always
//      re-run per attempt rather than caching a URL across messages).
// Never uses the newer, gradually-rolled-out inline `image.url`/etc. field
// from the webhook payload itself — that field's own download-auth
// requirement is not independently confirmed (see docs/meta/
// whatsapp-cloud-api.md's "Not established" section), so this always
// takes the one flow this codebase's own research fully verified.
//
// This class's ingest() method NEVER throws — every failure (missing
// token, HTTP error, network error, MediaStorage failure) is caught, safely
// logged, and swallowed, so a media-download/storage problem can never turn
// a valid webhook into a failed one (Part 3 instruction) and never leaves a
// storageRef fabricated for a failed upload — see this file's own try/catch,
// the only one in this class.
@Injectable()
export class WhatsAppMediaIngestService {
  constructor(
    private readonly accessToken: string | undefined,
    private readonly apiVersion: string,
    private readonly mediaStorage: MediaStorage,
    private readonly messageService: MessageService,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async ingest(clinicId: string, messageId: string, ref: WhatsAppMediaRef): Promise<void> {
    if (!this.accessToken) {
      logger.warn({ messageId }, 'WhatsApp: media ingestion skipped — access token not configured');
      return;
    }

    try {
      const metadata = await this.retrieveMediaMetadata(ref.mediaId);
      if (!metadata) return;

      const bytes = await this.downloadMediaBytes(metadata.url);
      if (!bytes) return;

      await uploadAndAttachMedia(this.mediaStorage, this.messageService, {
        clinicId,
        messageId,
        attachmentId: ref.mediaId,
        type: ref.attachmentType,
        bytes,
        mime: metadata.mimeType,
        caption: ref.caption ?? ref.filename,
      });
    } catch (err) {
      // Never logs the access token, the media URL (Meta's own docs call it
      // confidential), or media bytes — only a safe name/message, with the
      // token defensively redacted from the message text even though it
      // should only ever appear in a request header, never in a thrown
      // error's own message, in practice.
      logger.error({ messageId, err: this.sanitizeError(err) }, 'WhatsApp: media ingestion failed, message persisted without attachment');
    }
  }

  private sanitizeError(err: unknown): { name?: string; message?: string } {
    if (!(err instanceof Error)) return { message: 'Unknown error' };
    const message = this.accessToken ? err.message.split(this.accessToken).join('[REDACTED]') : err.message;
    return { name: err.name, message };
  }

  private async retrieveMediaMetadata(mediaId: string): Promise<{ url: string; mimeType?: string } | null> {
    const url = `https://graph.facebook.com/${this.apiVersion}/${mediaId}`;
    const response = await this.fetchImpl(url, { headers: { Authorization: `Bearer ${this.accessToken}` } });
    if (!response.ok) {
      logger.warn({ mediaId, status: response.status }, 'WhatsApp: media metadata retrieval failed');
      return null;
    }
    const payload: unknown = await response.json().catch(() => undefined);
    const mediaUrl = isRecord(payload) && typeof payload.url === 'string' ? payload.url : undefined;
    if (!mediaUrl) {
      logger.warn({ mediaId }, 'WhatsApp: media metadata response had no url');
      return null;
    }
    const mimeType = isRecord(payload) && typeof payload.mime_type === 'string' ? payload.mime_type : undefined;
    return { url: mediaUrl, mimeType };
  }

  private async downloadMediaBytes(mediaUrl: string): Promise<Buffer | null> {
    const response = await this.fetchImpl(mediaUrl, { headers: { Authorization: `Bearer ${this.accessToken}` } });
    if (!response.ok) {
      logger.warn({ status: response.status }, 'WhatsApp: media download failed');
      return null;
    }
    return Buffer.from(await response.arrayBuffer());
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
