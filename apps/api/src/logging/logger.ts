import pino from 'pino';
import { config } from '../config';

/**
 * Structured JSON logger. Fields: timestamp, level, message, plus whatever
 * structured context callers pass in. Never pass request bodies or secrets
 * as context here.
 */
export const logger = pino({
  level: config.LOG_LEVEL,
  messageKey: 'message',
  timestamp: () => `,"timestamp":"${new Date().toISOString()}"`,
  formatters: {
    level: (label) => ({ level: label }),
  },
});
