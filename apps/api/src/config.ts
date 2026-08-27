import { loadConfig } from '@clinic/config';

/**
 * Parsed once at process start. Fails fast (throws) if the environment is
 * invalid — every other module reads config through this, never process.env
 * directly.
 */
export const config = loadConfig();
