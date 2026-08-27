import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import { Catch, HttpException, HttpStatus } from '@nestjs/common';
import type { Request, Response } from 'express';
import { logger } from '../logging/logger';

interface ErrorResponseBody {
  statusCode: number;
  error: string;
  message: string;
}

function formatStatusText(statusCode: number): string {
  const raw = (HttpStatus as unknown as Record<number, string>)[statusCode];
  if (!raw) return 'Error';
  return raw
    .toLowerCase()
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function resolve(exception: unknown): { statusCode: number; body: ErrorResponseBody } {
  if (exception instanceof HttpException) {
    const statusCode = exception.getStatus();
    const response = exception.getResponse();
    const rawMessage =
      typeof response === 'string'
        ? response
        : ((response as { message?: string | string[] })?.message ?? exception.message);
    const message = Array.isArray(rawMessage) ? rawMessage.join(', ') : rawMessage;

    return { statusCode, body: { statusCode, error: formatStatusText(statusCode), message } };
  }

  // Unexpected/internal error — never leak stack traces or implementation
  // details to the client; the real error is logged server-side instead.
  const statusCode = HttpStatus.INTERNAL_SERVER_ERROR;
  return {
    statusCode,
    body: { statusCode, error: formatStatusText(statusCode), message: 'An unexpected error occurred.' },
  };
}

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();
    const { statusCode, body } = resolve(exception);

    logger.error(
      {
        method: request.method,
        path: request.url,
        statusCode,
        ...(statusCode >= 500 && exception instanceof Error ? { stack: exception.stack } : {}),
      },
      body.message,
    );

    response.status(statusCode).json(body);
  }
}
