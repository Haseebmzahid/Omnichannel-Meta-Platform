import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Injectable } from '@nestjs/common';
import { logger } from '../../logging/logger';
import { MediaStorageError, type MediaStorage, type MediaUploadInput, type MediaUploadResult } from '../media-storage.interface';

// The first real MediaStorage implementation. S3-compatible rather than
// AWS-specific: @aws-sdk/client-s3 talks to any endpoint implementing the
// S3 API (real AWS S3, MinIO, Cloudflare R2, DigitalOcean Spaces, ...) —
// endpoint/forcePathStyle below is exactly what lets the same code target
// a self-hosted MinIO in local dev/docker-compose and a real bucket in
// production without a second implementation. This is deliberately the
// only place @aws-sdk/client-s3 is imported anywhere in the app — nothing
// outside providers/ ever sees an S3 command type, mirroring how Gemini's
// SDK is confined to ai/providers/ (see ai.module.ts's safety-boundary
// comment).
export interface S3MediaStorageConfig {
  /** Custom S3-compatible endpoint (MinIO/R2/Spaces/...); leave undefined to use real AWS S3's own regional endpoints. */
  endpoint?: string;
  region: string;
  bucket?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  /** MinIO and most non-AWS S3-compatible services require path-style addressing; real AWS S3 works either way. */
  forcePathStyle: boolean;
}

const DEFAULT_SIGNED_URL_TTL_SECONDS = 300;

@Injectable()
export class S3MediaStorage implements MediaStorage {
  private client?: S3Client;

  constructor(private readonly config: S3MediaStorageConfig) {}

  async upload(input: MediaUploadInput): Promise<MediaUploadResult> {
    const client = this.getClient();

    try {
      await client.send(
        new PutObjectCommand({
          Bucket: this.getBucket(),
          Key: input.key,
          Body: input.body,
          ContentType: input.contentType,
        }),
      );
      return { key: input.key, bytes: input.body.byteLength };
    } catch (err) {
      throw this.toSafeError(err, 'upload media');
    }
  }

  async getSignedReadUrl(key: string, expiresInSeconds: number = DEFAULT_SIGNED_URL_TTL_SECONDS): Promise<string> {
    const client = this.getClient();

    try {
      return await getSignedUrl(client, new GetObjectCommand({ Bucket: this.getBucket(), Key: key }), { expiresIn: expiresInSeconds });
    } catch (err) {
      throw this.toSafeError(err, 'create a signed media URL');
    }
  }

  async delete(key: string): Promise<void> {
    const client = this.getClient();

    try {
      await client.send(new DeleteObjectCommand({ Bucket: this.getBucket(), Key: key }));
    } catch (err) {
      throw this.toSafeError(err, 'delete media');
    }
  }

  // Lazy, same reasoning as GeminiAIProvider.getClient() (ai/providers/
  // gemini.provider.ts): constructing — and especially calling — the SDK
  // client must never happen until something actually needs storage, so
  // MediaStorageModule can be wired into AppModule with zero configuration
  // and zero network access at boot. Throws before the SDK is ever touched
  // if bucket/credentials are missing — "missing configuration fails
  // safely" rather than the SDK's own less-safe failure mode.
  private getClient(): S3Client {
    if (!this.config.bucket || !this.config.accessKeyId || !this.config.secretAccessKey) {
      throw new MediaStorageError('Media storage is not configured.');
    }
    if (!this.client) {
      this.client = new S3Client({
        endpoint: this.config.endpoint,
        region: this.config.region,
        forcePathStyle: this.config.forcePathStyle,
        credentials: {
          accessKeyId: this.config.accessKeyId,
          secretAccessKey: this.config.secretAccessKey,
        },
      });
    }
    return this.client;
  }

  // getClient() above already guarantees config.bucket is set whenever a
  // client exists — this only narrows the type for the command builders.
  private getBucket(): string {
    if (!this.config.bucket) throw new MediaStorageError('Media storage is not configured.');
    return this.config.bucket;
  }

  // Never logs or returns the access key/secret — only a safe name/message
  // survives into the log, with both credential values defensively
  // redacted from the message even though the AWS SDK should never echo
  // them back in practice. Same "one generic message for every failure
  // mode" rule as GeminiAIProvider.sanitizeError().
  private toSafeError(err: unknown, action: string): MediaStorageError {
    logger.error({ err: this.sanitizeError(err) }, `Media storage failed to ${action}`);
    return new MediaStorageError(`Could not ${action}. Please try again.`);
  }

  private sanitizeError(err: unknown): { name?: string; message?: string } {
    if (!(err instanceof Error)) return { message: 'Unknown error' };
    let message = err.message;
    if (this.config.accessKeyId) message = message.split(this.config.accessKeyId).join('[REDACTED]');
    if (this.config.secretAccessKey) message = message.split(this.config.secretAccessKey).join('[REDACTED]');
    return { name: err.name, message };
  }
}
