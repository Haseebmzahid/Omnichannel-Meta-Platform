import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { config } from './config';
import { GlobalExceptionFilter } from './common/http-exception.filter';
import { logger } from './logging/logger';
import { NestPinoLogger } from './logging/nest-logger.service';

async function bootstrap() {
  // rawBody: true exposes req.rawBody (Buffer) alongside normal JSON
  // parsing for every route — needed only by the WhatsApp webhook
  // controller's signature verification (docs/architecture/02-channel-
  // adapters.md, "operate on the raw request body"), without disabling or
  // duplicating body parsing anywhere else.
  const app = await NestFactory.create(AppModule, { logger: new NestPinoLogger(), rawBody: true });
  app.useGlobalFilters(new GlobalExceptionFilter());

  await app.listen(config.PORT);
  logger.info({ port: config.PORT, env: config.NODE_ENV }, 'API listening');
}

bootstrap();
