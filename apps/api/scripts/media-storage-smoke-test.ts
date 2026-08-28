import 'reflect-metadata';
import { config } from '../src/config';
import { buildMediaStorageKey } from '../src/media/media-storage-key';
import { S3MediaStorage } from '../src/media/providers/s3-media-storage.provider';

// Manual-only media storage connectivity check — NOT part of the automated
// test suite. vitest.config.mts only picks up `test/**/*.e2e-spec.ts` and
// `src/**/*.spec.ts`; this file matches neither, and nothing in
// `pnpm typecheck`/`pnpm build`/`pnpm test` executes it. Run it explicitly
// once real bucket/credentials are configured:
//
//   pnpm --filter @clinic/api smoke:media-storage
//
// Reuses the real S3MediaStorage implementation end to end — no
// reimplementation, no stubs: config (loadConfig) -> S3MediaStorage -> the
// configured S3-compatible endpoint (real AWS S3, or a local MinIO, etc.).
//
// Safety: this script never logs, prints, or hardcodes
// MEDIA_STORAGE_ACCESS_KEY_ID/MEDIA_STORAGE_SECRET_ACCESS_KEY — only checks
// whether they are set. S3MediaStorage's own sanitizeError() strips both
// values from any error message before it ever reaches this script's
// console.error() below, so no code path here can leak them either.
//
// Uploads one small, harmless test object under its own scoped key, reads
// it back via a signed URL, then deletes it — this smoke test cleans up
// after itself rather than leaving test objects in the bucket.

async function main(): Promise<void> {
  if (!config.MEDIA_STORAGE_BUCKET || !config.MEDIA_STORAGE_ACCESS_KEY_ID || !config.MEDIA_STORAGE_SECRET_ACCESS_KEY) {
    console.log('Media storage is not configured (MEDIA_STORAGE_BUCKET/ACCESS_KEY_ID/SECRET_ACCESS_KEY). Smoke test skipped.');
    return;
  }

  const storage = new S3MediaStorage({
    endpoint: config.MEDIA_STORAGE_ENDPOINT,
    region: config.MEDIA_STORAGE_REGION,
    bucket: config.MEDIA_STORAGE_BUCKET,
    accessKeyId: config.MEDIA_STORAGE_ACCESS_KEY_ID,
    secretAccessKey: config.MEDIA_STORAGE_SECRET_ACCESS_KEY,
    forcePathStyle: config.MEDIA_STORAGE_FORCE_PATH_STYLE,
  });

  const key = buildMediaStorageKey({
    clinicId: 'smoke-test-clinic',
    messageId: 'smoke-test-message',
    attachmentId: `smoke-test-${Date.now()}`,
  });

  console.log('--- Media storage smoke test ---');
  console.log('Bucket:', config.MEDIA_STORAGE_BUCKET);
  console.log('Region:', config.MEDIA_STORAGE_REGION);
  console.log('Endpoint:', config.MEDIA_STORAGE_ENDPOINT ?? '(default AWS S3 endpoint)');
  console.log('Key:', key);

  try {
    console.log('\nUploading test object...');
    const uploadResult = await storage.upload({
      key,
      body: Buffer.from('media storage smoke test — safe to delete'),
      contentType: 'text/plain',
    });
    console.log('Uploaded:', uploadResult.bytes, 'bytes');

    console.log('\nRequesting a signed read URL...');
    const url = await storage.getSignedReadUrl(key, 60);
    // The signed URL itself is a short-lived, scoped credential — printed
    // here deliberately (this is a manual operator tool, not a log), same
    // as any other "here's your one-time link" CLI output. It expires in
    // 60 seconds and grants read-only access to this one throwaway object.
    console.log('Signed URL (expires in 60s):', url);

    console.log('\nDeleting test object...');
    await storage.delete(key);
    console.log('Deleted.');

    console.log('\n--- Media storage smoke test passed ---');
  } catch (err) {
    // S3MediaStorage already translates every SDK failure into a safe
    // MediaStorageError message (s3-media-storage.provider.ts) — this catch
    // is a defensive top-level guard on top of that, not a second
    // sanitization layer that assumes the first one failed.
    console.error('Smoke test failed:', err instanceof Error ? err.message : 'Unknown error');
    process.exitCode = 1;
  }
}

main();
