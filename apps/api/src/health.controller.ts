import { Controller, ForbiddenException, Get, Inject, UseGuards } from '@nestjs/common';
import { AI_PROVIDER, AIProviderError, type AIProvider } from './ai/ai-provider.interface';
import type { SanitizedGeminiError } from './ai/providers/gemini.provider';
import type { AuthenticatedStaffContext } from './auth/auth.types';
import { CurrentStaff } from './auth/current-staff.decorator';
import { SessionAuthGuard } from './auth/session-auth.guard';
import { config } from './config';
import { StaffRole } from './generated/prisma/enums';

@Controller('health')
export class HealthController {
  constructor(@Inject(AI_PROVIDER) private readonly aiProvider: AIProvider) {}

  @Get()
  getHealth(): { status: 'ok' } {
    return { status: 'ok' };
  }

  // Production Gemini diagnostic — confirms the deployed environment's
  // GEMINI_API_KEY actually authenticates with Gemini, without ever
  // exposing the key or the model's reply text. ADMIN-only (mirrors
  // staff.controller.ts's assertCanManageStaff pattern) — ForbiddenException
  // matches the existing safe-error convention (see StaffModule's own
  // ForbiddenException usage), not a distinct guard. Reuses the same
  // AI_PROVIDER binding ai.module.ts already wires to GeminiAIProvider — no
  // new provider, no new module, no change to the orchestrator/tool-calling
  // path this token is normally consumed through.
  @Get('gemini')
  @UseGuards(SessionAuthGuard)
  async getGeminiHealth(@CurrentStaff() staff: AuthenticatedStaffContext): Promise<{
    keyConfigured: boolean;
    model: string;
    success: boolean;
    error?: string;
    // Diagnostic-only fields (ADMIN-only response, never returned to any
    // other caller/channel): the safe subset of the underlying failure that
    // gemini.provider.ts's sanitizeError() captured onto AIProviderError's
    // `cause`. Never the API key, headers, cookies, request payload, or
    // Gemini's actual reply content — see SanitizedGeminiError's own
    // doc-comment for exactly what it carries.
    errorClass?: string;
    errorStatus?: number;
    errorDetail?: string;
  }> {
    if (staff.role !== StaffRole.ADMIN) {
      throw new ForbiddenException('Only ADMIN staff can perform this action.');
    }

    const keyConfigured = Boolean(config.GEMINI_API_KEY);
    const model = config.GEMINI_MODEL;

    try {
      // Smallest valid AIProviderRequest — a single ping, no tools. The
      // response's `text`/`toolCalls` are deliberately never read or
      // returned here (Requirement: never return the Gemini response text).
      await this.aiProvider.generate({ messages: [{ role: 'user', content: 'ping' }], tools: [] });
      return { keyConfigured, model, success: true };
    } catch (err) {
      // GeminiAIProvider.generate() always throws AIProviderError with an
      // already-sanitized message (see gemini.provider.ts's sanitizeError())
      // — never the raw SDK error, key, or stack trace. The generic fallback
      // below only matters if some other AIProvider binding ever violates
      // that contract.
      const message = err instanceof AIProviderError ? err.message : 'The AI provider is currently unavailable. Please try again.';
      const diagnostic = err instanceof AIProviderError ? this.extractDiagnostic(err.cause) : undefined;
      return { keyConfigured, model, success: false, error: message, ...diagnostic };
    }
  }

  // `err.cause` is `unknown` by type (Error's own contract) even though
  // gemini.provider.ts only ever puts a SanitizedGeminiError there — this
  // narrows defensively rather than casting, so a future AIProviderError
  // thrown without a `cause` (or with something else entirely) safely
  // yields no diagnostic fields instead of leaking or crashing.
  private extractDiagnostic(
    cause: unknown,
  ): { errorClass?: string; errorStatus?: number; errorDetail?: string } | undefined {
    if (typeof cause !== 'object' || cause === null) return undefined;
    const sanitized = cause as SanitizedGeminiError;

    const errorDetail = sanitized.networkCause
      ? `network: ${sanitized.networkCause.code ?? sanitized.name} — ${sanitized.networkCause.message}`
      : sanitized.message;

    return { errorClass: sanitized.name, errorStatus: sanitized.status, errorDetail };
  }
}
