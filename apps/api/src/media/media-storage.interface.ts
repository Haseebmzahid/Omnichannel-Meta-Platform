// Task 7-10 — the provider-agnostic media storage contract, mirroring
// ai/ai-provider.interface.ts's exact pattern: a small interface with no
// vocabulary from any one concrete provider's SDK (no S3Client, no AWS
// command types), a DI token the app binds a concrete implementation to,
// and a single sanitized error type every provider must translate its own
// failures into.
//
// See docs/architecture/01-domain-model.md's Attachment section
// ("storage_ref — our object storage key, media is downloaded and
// re-hosted") and docs/architecture/08-technology-stack.md's "deliberately
// left open" cloud-provider decision — an S3-compatible interface is what
// lets that decision stay open (AWS S3, MinIO, R2, Spaces, ... all speak
// the same API) without blocking this foundation on it.
//
// This task builds ONLY the storage foundation: nothing here downloads
// Meta media, no controller exposes a URL to the browser, and no caller
// exists yet — MediaStorageModule is wired into AppModule inert, ready for
// a future task's download-and-rehost pipeline to inject MEDIA_STORAGE,
// exactly like AI_PROVIDER was wired ahead of GeminiAIProvider ever being
// called for real.

export interface MediaUploadInput {
  /** Clinic/message-scoped key — always built by buildMediaStorageKey() (media-storage-key.ts), never a caller-chosen path. */
  key: string;
  body: Buffer | Uint8Array;
  contentType?: string;
}

export interface MediaUploadResult {
  /** Echoes the key that was actually written — convenience for the caller, not new information. */
  key: string;
  bytes: number;
}

export interface MediaStorage {
  upload(input: MediaUploadInput): Promise<MediaUploadResult>;
  /** A time-limited, credential-free URL for reading one object — never a permanent/public link. */
  getSignedReadUrl(key: string, expiresInSeconds?: number): Promise<string>;
  delete(key: string): Promise<void>;
}

// The one error shape every provider adapter must translate its own
// SDK-specific failure into before it crosses the MediaStorage boundary —
// same rule as AIProviderError (ai-provider.interface.ts): a safe, generic
// message, never a raw SDK error, stack trace, credential, or bucket path.
export class MediaStorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MediaStorageError';
  }
}

// NestJS DI token for whichever MediaStorage implementation is bound at
// runtime — see media-storage.module.ts.
export const MEDIA_STORAGE = Symbol('MEDIA_STORAGE');
