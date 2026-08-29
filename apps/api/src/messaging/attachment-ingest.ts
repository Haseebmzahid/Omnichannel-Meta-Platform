import type { AttachmentType } from '../generated/prisma/enums';
import { AttachmentSource } from '../generated/prisma/enums';
import type { MediaStorage } from '../media/media-storage.interface';
import { buildMediaStorageKey } from '../media/media-storage-key';
import type { MessageService } from './message.service';

// Task 7-9 — the one channel-neutral tail every channel's media-ingest
// service shares once it has real downloaded bytes in hand: build the
// clinic/message-scoped storage key, upload, then persist the Attachment
// via MessageService (the persistence authority). Nothing here is
// WhatsApp/Instagram/Messenger-specific — the channel-specific part
// (how to get from a webhook payload to `bytes`) stays entirely inside
// each channel's own *-media.service.ts, which is this function's only
// caller, always from within its own try/catch (a throw here must never
// reach a webhook controller — see each service's own comment).
export interface UploadAndAttachMediaInput {
  clinicId: string;
  messageId: string;
  /** Scopes the storage key alongside clinicId/messageId — see media-storage-key.ts. */
  attachmentId: string;
  type: AttachmentType;
  bytes: Buffer;
  mime?: string;
  caption?: string;
}

export async function uploadAndAttachMedia(mediaStorage: MediaStorage, messageService: MessageService, input: UploadAndAttachMediaInput): Promise<void> {
  const key = buildMediaStorageKey({ clinicId: input.clinicId, messageId: input.messageId, attachmentId: input.attachmentId });
  const uploadResult = await mediaStorage.upload({ key, body: input.bytes, contentType: input.mime });

  await messageService.attachMediaToMessage(input.messageId, {
    type: input.type,
    storageRef: uploadResult.key,
    mime: input.mime,
    bytes: uploadResult.bytes,
    caption: input.caption,
    source: AttachmentSource.DOWNLOADED,
  });
}
