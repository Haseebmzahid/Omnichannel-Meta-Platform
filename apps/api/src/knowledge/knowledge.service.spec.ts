import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../prisma/prisma.service';
import { ClinicKnowledgeService } from './knowledge.service';

const CLINIC_ID = 'clinic-1';

function buildService(findManyResult: unknown[] = []) {
  const findMany = vi.fn().mockResolvedValue(findManyResult);
  const prisma = { knowledgeDocument: { findMany } } as unknown as PrismaService;
  return { service: new ClinicKnowledgeService(prisma), findMany };
}

describe('ClinicKnowledgeService', () => {
  it('1. every query is scoped by the given clinicId', async () => {
    const { service, findMany } = buildService([]);
    await service.search({ clinicId: CLINIC_ID, query: 'hours' });

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ clinicId: CLINIC_ID }) }),
    );
  });

  it('2. only isActive documents are ever matched', async () => {
    const { service, findMany } = buildService([]);
    await service.search({ clinicId: CLINIC_ID, query: 'hours' });

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ isActive: true }) }),
    );
  });

  it('3. only category/title/body are ever selected — never the full row', async () => {
    const { service, findMany } = buildService([]);
    await service.search({ clinicId: CLINIC_ID, query: 'hours' });

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ select: { category: true, title: true, body: true } }),
    );
  });

  it('4. results are capped at a small, bounded number', async () => {
    const { service, findMany } = buildService([]);
    await service.search({ clinicId: CLINIC_ID, query: 'hours' });

    const call = findMany.mock.calls[0]?.[0];
    expect(call.take).toBeGreaterThan(0);
    expect(call.take).toBeLessThanOrEqual(10);
  });

  it('5. found is true and the projected results are returned when matches exist', async () => {
    const rows = [{ category: 'HOURS', title: 'Opening hours', body: 'Mon-Sat 9am-6pm.' }];
    const { service } = buildService(rows);

    const result = await service.search({ clinicId: CLINIC_ID, query: 'hours' });

    expect(result).toEqual({ found: true, results: rows });
  });

  it('6. found is false with an empty results array when nothing matches — a safe not-found result', async () => {
    const { service } = buildService([]);
    const result = await service.search({ clinicId: CLINIC_ID, query: 'something nobody documented' });

    expect(result).toEqual({ found: false, results: [] });
  });

  it('7. a raw database/Prisma error is never caught or reshaped here — it propagates for ToolRegistry to sanitize', async () => {
    const findMany = vi.fn().mockRejectedValue(new Error('connection to postgres://clinic:clinic_dev_password@localhost/clinic_dev failed'));
    const prisma = { knowledgeDocument: { findMany } } as unknown as PrismaService;
    const service = new ClinicKnowledgeService(prisma);

    await expect(service.search({ clinicId: CLINIC_ID, query: 'hours' })).rejects.toThrow();
  });
});
