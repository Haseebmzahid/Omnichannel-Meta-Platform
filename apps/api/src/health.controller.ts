import { Controller, ForbiddenException, Get, Inject, UseGuards } from '@nestjs/common';
import { AI_PROVIDER, AIProviderError, type AIProvider } from './ai/ai-provider.interface';
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
  async getGeminiHealth(
    @CurrentStaff() staff: AuthenticatedStaffContext,
  ): Promise<{ keyConfigured: boolean; model: string; success: boolean; error?: string }> {
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
      return { keyConfigured, model, success: false, error: message };
    }
  }
}
