import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { AIContext } from '../src/ai/ai-context.types';
import { AiModule } from '../src/ai/ai.module';
import { AiOrchestratorService } from '../src/ai/ai-orchestrator.service';
import { config } from '../src/config';

// Manual-only Gemini live smoke test — NOT part of the automated test
// suite. vitest.config.mts only picks up `test/**/*.e2e-spec.ts` and
// `src/**/*.spec.ts`; this file matches neither, and nothing in
// `pnpm typecheck`/`pnpm build`/`pnpm test` executes it. Run it explicitly
// once a real key is available:
//
//   pnpm --filter @clinic/api smoke:gemini
//
// Reuses the real, already-implemented architecture end to end — no
// reimplementation, no stubs, no changes to any of it:
//
//   config (loadConfig) -> AiModule (real Nest DI wiring) ->
//     AiOrchestratorService -> GeminiAIProvider (real @google/genai call)
//     + ToolRegistry -> check_availability -> AppointmentService ->
//     PostgreSQL
//
// Requires GEMINI_API_KEY to actually call Gemini, and PostgreSQL
// (docker-compose) running for the check_availability tool to execute —
// exactly as both are required in the running application. Neither is
// touched just to detect a missing key: that check runs first, before any
// Nest bootstrap, DB connection, or network access.
//
// Safety: this script never logs, prints, or hardcodes GEMINI_API_KEY —
// only checks whether it is set.

async function main(): Promise<void> {
  if (!config.GEMINI_API_KEY) {
    console.log('GEMINI_API_KEY is not configured. Smoke test skipped.');
    return;
  }

  const app = await NestFactory.createApplicationContext(AiModule, { logger: ['error', 'warn'] });

  try {
    const orchestrator = app.get(AiOrchestratorService);

    const context: AIContext = {
      clinicId: 'smoke-test-clinic',
      conversationId: 'smoke-test-conversation',
      recentMessages: [],
      channel: 'WHATSAPP',
      mode: 'AI',
    };

    // Deliberately mixes English, Urdu, and Roman Urdu in one message
    // (Task Part 4), and asks about doctor availability so Gemini has a
    // natural reason to call check_availability — exercising: a real
    // multilingual request, the tool exposed via ToolRegistry, Gemini
    // requesting it, dispatch through the real ToolRegistry +
    // AppointmentService, and the result fed back for a final response.
    //
    // The doctor id below is a placeholder, not seeded data — if it
    // doesn't exist, AppointmentService safely reports "not found" via
    // the tool result rather than crashing. That is itself a valid,
    // successful smoke-test outcome: it proves the full pipeline (tool
    // exposure -> Gemini's tool call -> ToolRegistry dispatch ->
    // AppointmentService -> safe structured result -> back to Gemini)
    // works end to end.
    const message =
      'Hi! Is Dr. 11111111-1111-4111-8111-111111111111 available tomorrow (2030-01-08)? ' +
      'مجھے کل کی اپائنٹمنٹ چاہیے — kya slot mil sakta hai?';

    console.log('--- Gemini smoke test ---');
    console.log('Model:', config.GEMINI_MODEL);
    console.log('Sending message:', message);

    const response = await orchestrator.handle({ context, message });

    console.log('\n--- Tool calls ---');
    if (response.toolCalls.length === 0) {
      console.log('(none — Gemini answered without calling a tool)');
    } else {
      for (const call of response.toolCalls) {
        console.log(`${call.name}:`, JSON.stringify(call.result, null, 2));
      }
    }

    console.log('\n--- Final response ---');
    console.log(response.text);
  } catch (err) {
    // Never print a raw/unexpected error here either. GeminiAIProvider
    // already translates every SDK failure into a safe AIProviderError
    // message (gemini.provider.ts) — this catch is a defensive top-level
    // guard on top of that, not a second sanitization layer that assumes
    // the first one failed.
    console.error('Smoke test failed:', err instanceof Error ? err.message : 'Unknown error');
    process.exitCode = 1;
  } finally {
    await app.close();
  }
}

main();
