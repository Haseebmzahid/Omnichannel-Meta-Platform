import { HttpException } from '@nestjs/common';
import { z } from 'zod';
import { logger } from '../logging/logger';
import type { AIContext } from './ai-context.types';
import type { AIToolDescriptor } from './ai-provider.interface';

// Task 4C-5, Part 3 — provider-independent tool definition.
//
// Input is validated with Zod (inputSchema) before the handler ever runs —
// this is the concrete mechanism behind ADR-009's "tool arguments are
// validated independently of what the model claims." Output is not
// Zod-validated: it is constructed by our own trusted domain code (the
// handler), not supplied by the model, so there is nothing untrusted to
// validate on the way out.
export interface ToolDefinition<Input, Output> {
  name: string;
  description: string;
  inputSchema: z.ZodType<Input>;
  handler: (input: Input, context: AIContext) => Promise<Output>;
}

export type ToolDispatchResult =
  | { success: true; output: unknown }
  | { success: false; error: { code: 'UNKNOWN_TOOL' | 'INVALID_ARGUMENTS' | 'EXECUTION_ERROR'; message: string } };

// A minimal, dependency-free Zod-schema -> JSON-schema-shaped object,
// sufficient for a provider's function-declaration `parameters` field.
// Intentionally narrow: this task defines the contract, not a full
// zod-to-json-schema library integration (see the module's "no
// unnecessary dependencies" scope instruction).
function describeSchema(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { target: 'draft-7' });
  return json as Record<string, unknown>;
}

// Rejects unknown tools and malformed arguments before any domain service
// ever runs (Part 3's two hard requirements), and never lets a raw
// domain/Prisma error escape to the AI provider (Part 5/7) — the same
// "trust our own HttpException subclasses, sanitize everything else"
// pattern already used by apps/api/src/common/http-exception.filter.ts,
// applied here for the non-HTTP AI boundary.
export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition<unknown, unknown>>();

  register<Input, Output>(tool: ToolDefinition<Input, Output>): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool "${tool.name}" is already registered.`);
    }
    this.tools.set(tool.name, tool as ToolDefinition<unknown, unknown>);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  describeAll(): AIToolDescriptor[] {
    return [...this.tools.values()].map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: describeSchema(tool.inputSchema),
    }));
  }

  async dispatch(name: string, rawArguments: unknown, context: AIContext): Promise<ToolDispatchResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return { success: false, error: { code: 'UNKNOWN_TOOL', message: `Unknown tool: "${name}".` } };
    }

    const parsed = tool.inputSchema.safeParse(rawArguments);
    if (!parsed.success) {
      return {
        success: false,
        error: { code: 'INVALID_ARGUMENTS', message: `Invalid arguments for tool "${name}": ${parsed.error.message}` },
      };
    }

    try {
      const output = await tool.handler(parsed.data, context);
      return { success: true, output };
    } catch (err) {
      // A domain error we already sanitized on purpose (e.g.
      // DoctorNotFoundException) has a safe, useful message — pass it
      // through. Anything else (a raw Error, a Prisma error) is logged
      // server-side and replaced with a generic message; its details
      // never reach the model.
      if (err instanceof HttpException) {
        return { success: false, error: { code: 'EXECUTION_ERROR', message: err.message } };
      }
      logger.error({ tool: name, err }, 'Tool execution failed');
      return { success: false, error: { code: 'EXECUTION_ERROR', message: `Tool "${name}" failed to execute.` } };
    }
  }
}
