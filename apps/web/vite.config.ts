/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    css: true,
    // The default 'forks' pool timed out starting worker processes in this
    // environment (Windows, several concurrent dev processes already
    // running) — 'threads' is the standard, reliable fallback.
    pool: 'threads',
    // Multi-step userEvent interactions (type + type + click + a real
    // mutation + a route change) can exceed the 5s default under real
    // contention (e.g. this workspace's backend test suite running
    // concurrently against real Postgres) without anything being wrong.
    testTimeout: 15000,
  },
});
