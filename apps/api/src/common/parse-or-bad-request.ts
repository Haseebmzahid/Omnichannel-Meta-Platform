import { BadRequestException } from '@nestjs/common';
import type { z } from 'zod';

// Shared HTTP-boundary validation helper — no class-validator/ValidationPipe
// infrastructure exists in this codebase (checked); Zod is already the
// codebase's validation idiom (see ai/tools/*.tool.ts, inbox.controller.ts).
// Originally lived only in inbox.controller.ts (Task 7-1); pulled out here
// once auth.controller.ts (Task 7-2) needed the exact same behaviour, so the
// ZodError-to-readable-message formatting has one owner.
export function parseOrBadRequest<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `${issue.path.join('.') || label}: ${issue.message}`).join('; ');
    throw new BadRequestException(`Invalid ${label} — ${issues}`);
  }
  return result.data;
}
