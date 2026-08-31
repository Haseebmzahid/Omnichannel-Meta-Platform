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
//
// Task 7-8 — `grounding` is the deterministic escalation-enforcement
// mechanism (Adeeba multilingual retrieval, requirement: "a clinic-fact
// question cannot simply receive a model-generated guess"). It is
// declarative metadata a tool attaches to itself; ToolRegistry.dispatch()
// interprets it generically below without ever hardcoding a tool name —
// AiOrchestratorService only creates and threads an opaque GroundingState
// per turn (see its own header comment on staying tool-agnostic).
//   - `effect(output)`: does this call's own result leave a clinic-fact
//     question unresolved ('opens' — search_clinic_knowledge, found:false)
//     or resolve one ('closes' — escalate_to_human; search_clinic_knowledge,
//     found:true)? Returning undefined means "no effect on the gate".
//   - `blockedByOpenGap`: while the gate is open, dispatch() does not run
//     this tool's own handler at all — it redirects to `redirectToTool`
//     with a synthetic input (`buildFallbackInput`), so a bare reply can
//     never go out while a clinic-fact question is unresolved. This is
//     enforced at the dispatch boundary, not by trusting the model's
//     compliance with its system instruction.
export interface ToolGroundingMetadata<Output> {
  effect?: (output: Output) => 'opens' | 'closes' | undefined;
  blockedByOpenGap?: {
    redirectToTool: string;
    buildFallbackInput: (originalInput: unknown, context: AIContext) => unknown;
  };
}

export interface ToolDefinition<Input, Output> {
  name: string;
  description: string;
  inputSchema: z.ZodType<Input>;
  handler: (input: Input, context: AIContext) => Promise<Output>;
  grounding?: ToolGroundingMetadata<Output>;
}

// Fresh per AiOrchestratorService.handle() call — never shared across
// conversations or turns (ToolRegistry itself is a long-lived singleton;
// this state is not). `gapOpen` starts false and is only ever mutated by
// dispatch() below, based on each grounding-aware tool's own declared
// effect().
export interface GroundingState {
  gapOpen: boolean;
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

  async dispatch(name: string, rawArguments: unknown, context: AIContext, grounding?: GroundingState): Promise<ToolDispatchResult> {
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

    // Task 7-8's deterministic escalation gate: while a clinic-fact
    // question is unresolved (grounding.gapOpen), a tool declaring
    // `blockedByOpenGap` never runs its own handler — dispatch is
    // redirected to the declared fallback tool instead. Falls through to
    // the normal path below if the redirect target is missing/misconfigured
    // (never silently drops the patient's turn) or itself fails.
    if (grounding?.gapOpen && tool.grounding?.blockedByOpenGap) {
      const redirected = await this.tryRedirect(tool.grounding.blockedByOpenGap, name, parsed.data, context, grounding);
      if (redirected) return redirected;
    }

    try {
      const output = await tool.handler(parsed.data, context);
      this.applyGroundingEffect(tool, output, grounding);
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

  private applyGroundingEffect(tool: ToolDefinition<unknown, unknown>, output: unknown, grounding?: GroundingState): void {
    if (!grounding || !tool.grounding?.effect) return;
    const effect = tool.grounding.effect(output);
    if (effect === 'opens') grounding.gapOpen = true;
    else if (effect === 'closes') grounding.gapOpen = false;
  }

  private async tryRedirect(
    blocked: NonNullable<ToolGroundingMetadata<unknown>['blockedByOpenGap']>,
    originalToolName: string,
    originalInput: unknown,
    context: AIContext,
    grounding: GroundingState,
  ): Promise<ToolDispatchResult | undefined> {
    const target = this.tools.get(blocked.redirectToTool);
    if (!target) {
      logger.error({ tool: originalToolName, redirectToTool: blocked.redirectToTool }, 'Grounding-gate redirect target not registered — dispatching original tool instead');
      return undefined;
    }

    const fallbackInput = blocked.buildFallbackInput(originalInput, context);
    const parsedFallback = target.inputSchema.safeParse(fallbackInput);
    if (!parsedFallback.success) {
      logger.error({ tool: originalToolName, redirectToTool: blocked.redirectToTool }, 'Grounding-gate redirect fallback input failed validation — dispatching original tool instead');
      return undefined;
    }

    try {
      const output = await target.handler(parsedFallback.data, context);
      this.applyGroundingEffect(target, output, grounding);
      return { success: true, output: { redirected: true, from: originalToolName, to: blocked.redirectToTool, result: output } };
    } catch (err) {
      if (err instanceof HttpException) {
        return { success: false, error: { code: 'EXECUTION_ERROR', message: err.message } };
      }
      logger.error({ tool: blocked.redirectToTool, err }, 'Tool execution failed');
      return { success: false, error: { code: 'EXECUTION_ERROR', message: `Tool "${blocked.redirectToTool}" failed to execute.` } };
    }
  }
}
