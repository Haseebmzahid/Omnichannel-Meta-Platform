import 'reflect-metadata';
import cookieParser from 'cookie-parser';
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
  // Task 7-3 — the staff portal (apps/web) is served from its own origin,
  // so its credentialed (cookie-carrying) fetch calls need an explicit
  // CORS allowance. `credentials: true` requires a specific origin, never
  // '*', per the CORS spec — WEB_ORIGIN is exactly one origin, not a list,
  // matching the "one clinic, one portal" scope this task builds for.
  // Meta's webhook calls and any other non-browser HTTP client are
  // unaffected — CORS is a browser-enforced restriction only.
  app.enableCors({ origin: config.WEB_ORIGIN, credentials: true });
  // Task 7-2 — parses the httpOnly session cookie SessionAuthGuard reads.
  // No secret passed to cookieParser() (that would enable its own signed-
  // cookie support); session verification is entirely AuthService's job.
  app.use(cookieParser());
  app.useGlobalFilters(new GlobalExceptionFilter());

  await app.listen(config.PORT);
  logger.info({ port: config.PORT, env: config.NODE_ENV }, 'API listening');
}

bootstrap();
