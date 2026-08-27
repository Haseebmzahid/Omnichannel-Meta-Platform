import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { PrismaModule } from '../prisma/prisma.module';
import { AiModule } from './ai.module';
import { ToolRegistry } from './tool.types';

// Proves send_message (Task 4C-7) is actually wired into the real AiModule
// DI graph — the same registration pattern check_availability already
// used — not just constructible by hand in send-message.tool.spec.ts.
// Building the full module here touches no network and requires no real
// Gemini/Meta credentials: GeminiAIProvider's client is constructed lazily
// (see ai.module.ts's header comment), and every channel adapter service
// in ChannelOutboundModule's graph only stores injected config/PrismaService
// references in its constructor — none of them call out anywhere at
// module-init time.
describe('AiModule wiring', () => {
  it('registers check_availability, send_message, and search_clinic_knowledge in the real DI-constructed ToolRegistry', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [PrismaModule, AiModule] }).compile();
    const registry = moduleRef.get(ToolRegistry);

    expect(registry.has('check_availability')).toBe(true);
    expect(registry.has('send_message')).toBe(true);
    expect(registry.has('search_clinic_knowledge')).toBe(true);

    await moduleRef.close();
  });
});
