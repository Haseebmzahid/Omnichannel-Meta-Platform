import type { LoggerService } from '@nestjs/common';
import { logger } from './logger';

function toMessage(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/**
 * Routes Nest's internal framework logging (startup, route mapping, etc.)
 * and any application-level Logger use through the shared pino instance, so
 * every log line — framework or application — has the same structured shape.
 */
export class NestPinoLogger implements LoggerService {
  log(message: unknown, context?: string): void {
    logger.info({ context }, toMessage(message));
  }

  error(message: unknown, trace?: string, context?: string): void {
    logger.error({ context, trace }, toMessage(message));
  }

  warn(message: unknown, context?: string): void {
    logger.warn({ context }, toMessage(message));
  }

  debug(message: unknown, context?: string): void {
    logger.debug({ context }, toMessage(message));
  }

  verbose(message: unknown, context?: string): void {
    logger.trace({ context }, toMessage(message));
  }
}
