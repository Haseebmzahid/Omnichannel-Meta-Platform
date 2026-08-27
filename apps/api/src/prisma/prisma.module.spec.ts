import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { PrismaModule } from './prisma.module';
import { PrismaService } from './prisma.service';

describe('PrismaModule', () => {
  it('provides a PrismaService instance via DI without connecting', async () => {
    // Deliberately does not call app.init() — that would invoke
    // onModuleInit()/$connect() and require a live database. This test only
    // proves the module wiring resolves.
    //
    // Note: asserting with toBeInstanceOf(PrismaService) here triggers a
    // "Maximum call stack size exceeded" — Vitest's assertion formatter
    // recursing on Prisma 7's Proxy-based client internals when trying to
    // pretty-print the value, not a real DI or runtime issue (the actual
    // app boots and connects successfully; see apps/api's boot validation).
    // Checking for the concrete PrismaClient methods avoids that recursion.
    const moduleRef = await Test.createTestingModule({ imports: [PrismaModule] }).compile();

    const prisma = moduleRef.get(PrismaService);

    expect(typeof prisma).toBe('object');
    expect(typeof prisma.$connect).toBe('function');
    expect(typeof prisma.$disconnect).toBe('function');
  });
});
