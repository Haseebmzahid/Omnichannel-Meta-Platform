import { Module } from '@nestjs/common';
import { config } from '../config';
import { MEDIA_STORAGE } from './media-storage.interface';
import { S3MediaStorage } from './providers/s3-media-storage.provider';

// Task 7-10 — foundation only. No controller, no consumer yet: this module
// exists so a future task's download-and-rehost pipeline can
// @Inject(MEDIA_STORAGE) without also having to invent the wiring at that
// point. Registering this in AppModule is safe today with zero
// configuration set — S3MediaStorage never constructs an S3Client (let
// alone calls it) until upload/getSignedReadUrl/delete is actually invoked
// (see that class's getClient()).
@Module({
  providers: [
    {
      provide: MEDIA_STORAGE,
      useFactory: () =>
        new S3MediaStorage({
          endpoint: config.MEDIA_STORAGE_ENDPOINT,
          region: config.MEDIA_STORAGE_REGION,
          bucket: config.MEDIA_STORAGE_BUCKET,
          accessKeyId: config.MEDIA_STORAGE_ACCESS_KEY_ID,
          secretAccessKey: config.MEDIA_STORAGE_SECRET_ACCESS_KEY,
          forcePathStyle: config.MEDIA_STORAGE_FORCE_PATH_STYLE,
        }),
    },
  ],
  exports: [MEDIA_STORAGE],
})
export class MediaStorageModule {}
