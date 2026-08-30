import { Body, Controller, ForbiddenException, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { CurrentStaff } from '../auth/current-staff.decorator';
import { SessionAuthGuard } from '../auth/session-auth.guard';
import type { AuthenticatedStaffContext } from '../auth/auth.types';
import { parseOrBadRequest } from '../common/parse-or-bad-request';
import { KnowledgeCategory, StaffRole } from '../generated/prisma/enums';
import { ClinicKnowledgeService } from './knowledge.service';
import type { KnowledgeDocumentSummaryDto } from './knowledge.types';

// Task 7-7 — the staff-facing knowledge-authoring API. Every route is
// gated by SessionAuthGuard, and clinicId comes exclusively from the
// verified AuthenticatedStaffContext SessionAuthGuard attaches to the
// request — never from a request body — mirroring staff/staff.controller.ts's
// exact Task 7-3 pattern (see that file's header comment). No route below
// accepts a caller-supplied clinicId at all: createDocumentBodySchema has no
// clinicId field, so even a client that sends one has it silently dropped
// by Zod before ClinicKnowledgeService is ever called.
@Controller('knowledge')
@UseGuards(SessionAuthGuard)
export class KnowledgeController {
  constructor(private readonly knowledgeService: ClinicKnowledgeService) {}

  // READ_ONLY may list documents — same "reads are fine, mutations are
  // not" rule already established for staff (StaffController.list) and the
  // inbox before it.
  @Get()
  async list(@CurrentStaff() staff: AuthenticatedStaffContext): Promise<KnowledgeDocumentSummaryDto[]> {
    return this.knowledgeService.listDocuments(staff.clinicId);
  }

  @Post()
  async create(@CurrentStaff() staff: AuthenticatedStaffContext, @Body() body: unknown): Promise<KnowledgeDocumentSummaryDto> {
    assertCanManageKnowledge(staff);
    const parsed = parseOrBadRequest(createDocumentBodySchema, body, 'body');
    return this.knowledgeService.createDocument(staff.clinicId, staff.staffId, parsed);
  }

  @Patch(':id')
  async update(
    @CurrentStaff() staff: AuthenticatedStaffContext,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<KnowledgeDocumentSummaryDto> {
    assertCanManageKnowledge(staff);
    const parsedId = parseOrBadRequest(uuidSchema, id, 'id');
    const parsed = parseOrBadRequest(updateDocumentBodySchema, body, 'body');
    return this.knowledgeService.updateDocument(staff.clinicId, parsedId, staff.staffId, parsed);
  }

  @Patch(':id/status')
  async updateStatus(
    @CurrentStaff() staff: AuthenticatedStaffContext,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<KnowledgeDocumentSummaryDto> {
    assertCanManageKnowledge(staff);
    const parsedId = parseOrBadRequest(uuidSchema, id, 'id');
    const parsed = parseOrBadRequest(updateStatusBodySchema, body, 'body');
    return this.knowledgeService.updateStatus(staff.clinicId, parsedId, staff.staffId, parsed);
  }
}

// Client-confirmed production role hardening: knowledge create/edit/
// enable/disable is an ADMIN-only capability — AGENT and MANAGER may view
// the knowledge base but never mutate it, exactly like READ_ONLY. Mirrors
// staff/staff.controller.ts's assertCanManageStaff exactly (see that
// file's header comment for why this stays duplicated rather than shared).
function assertCanManageKnowledge(staff: AuthenticatedStaffContext): void {
  if (staff.role !== StaffRole.ADMIN) {
    throw new ForbiddenException('Only ADMIN staff can perform this action.');
  }
}

// --- HTTP-boundary validation ------------------------------------------

const uuidSchema = z.uuid();
const categoryEnum = z.enum(Object.values(KnowledgeCategory) as [KnowledgeCategory, ...KnowledgeCategory[]]);

// clinicId is deliberately absent from this schema — see this file's
// header comment. No documented length policy exists for a knowledge
// document's title/body/tags; these are conservative, common-sense ceilings
// (matching StaffService's own "not a literal requirement transcription"
// framing for its password-length minimum), not a transcribed requirement.
const createDocumentBodySchema = z.object({
  category: categoryEnum,
  title: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(20000),
  tags: z.array(z.string().trim().min(1).max(50)).max(50).default([]),
});

const updateDocumentBodySchema = createDocumentBodySchema;

const updateStatusBodySchema = z.object({ isActive: z.boolean() });
