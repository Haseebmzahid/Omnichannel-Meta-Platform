import type { ArgumentsHost } from '@nestjs/common';
import { HttpException, HttpStatus } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { GlobalExceptionFilter } from './http-exception.filter';

function createHost() {
  const json = vi.fn();
  const status = vi.fn(() => ({ json }));
  const host = {
    switchToHttp: () => ({
      getResponse: () => ({ status }),
      getRequest: () => ({ method: 'GET', url: '/boom' }),
    }),
  } as unknown as ArgumentsHost;
  return { host, json, status };
}

describe('GlobalExceptionFilter', () => {
  it('formats a known HttpException using its own status and message', () => {
    const filter = new GlobalExceptionFilter();
    const { host, json, status } = createHost();

    filter.catch(new HttpException('Nope', HttpStatus.BAD_REQUEST), host);

    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith({ statusCode: 400, error: 'Bad Request', message: 'Nope' });
  });

  it('maps an unexpected error to a generic 500 without leaking internal details', () => {
    const filter = new GlobalExceptionFilter();
    const { host, json, status } = createHost();

    filter.catch(new Error('connection string exposed by accident'), host);

    expect(status).toHaveBeenCalledWith(500);
    const body = json.mock.calls[0]?.[0];
    expect(body).toEqual({
      statusCode: 500,
      error: 'Internal Server Error',
      message: 'An unexpected error occurred.',
    });
    expect(JSON.stringify(body)).not.toContain('connection string exposed by accident');
  });
});
