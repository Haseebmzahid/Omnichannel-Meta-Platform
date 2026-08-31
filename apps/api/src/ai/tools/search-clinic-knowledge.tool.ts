import { z } from 'zod';
import type { ClinicKnowledgeService } from '../../knowledge/knowledge.service';
import type { ToolDefinition } from '../tool.types';

// Task 4C-10 — the first read-only clinic-knowledge tool
// (docs/architecture/04-ai-orchestration.md §3 "search_clinic_knowledge",
// ADR-009's "grounded answers only" rule). A thin pass-through to
// ClinicKnowledgeService.search() — this file does not touch Prisma and
// does not decide which clinic to search.
//
// Security boundary enforced structurally, not by convention (same pattern
// as check_availability.tool.ts / send-message.tool.ts):
//   - clinicId: NOT in inputSchema. The model physically cannot supply,
//     override, or redirect to another clinic's knowledge — the handler
//     only ever reads `context.clinicId`, the trusted AIContext value.
//   - patientId / channel / conversationId / any database id: also not
//     accepted — this tool has no use for them, and accepting them would
//     just be more surface area for a value the model supplies to be
//     mistaken for an authorization input.
//   - Output is a `select`-projected, already-sanitized shape from
//     ClinicKnowledgeService (category/title/body only) — never a raw
//     Prisma row, and never anything resembling a credential/connection
//     string.

const MAX_QUERY_LENGTH = 200;

// Task 7-8 (Adeeba multilingual retrieval) — queryTranslation is Gemini's
// own best-effort plain-English or Urdu-script gloss of the patient's
// question, used alongside the verbatim query for semantic embedding
// (knowledge.service.ts's embedQueries()). It is a cross-lingual retrieval
// hedge specifically for Roman Urdu, not a translation the patient ever
// sees — never returned, never logged as patient-facing text.
const inputSchema = z.object({
  query: z.string().trim().min(1).max(MAX_QUERY_LENGTH),
  queryTranslation: z.string().trim().max(MAX_QUERY_LENGTH).optional(),
});

export type SearchClinicKnowledgeToolInput = z.infer<typeof inputSchema>;

// Structured tool output. `found: false` is the explicit, safe
// "insufficient information" result the model is instructed (system
// instruction) to defer to rather than invent an answer for — never an
// empty-but-ambiguous array on its own.
export interface SearchClinicKnowledgeToolOutput {
  success: true;
  found: boolean;
  results: Array<{ category: string; title: string; body: string }>;
}

export function createSearchClinicKnowledgeTool(
  knowledgeService: Pick<ClinicKnowledgeService, 'search'>,
): ToolDefinition<SearchClinicKnowledgeToolInput, SearchClinicKnowledgeToolOutput> {
  return {
    name: 'search_clinic_knowledge',
    description:
      "Searches this clinic's own knowledge base for real, staff-authored facts — clinic info, hours, location, " +
      'services, fees, doctor information, policies, and FAQs. Returns found: false when nothing matches; treat ' +
      'that as "this information is not available", never as licence to guess. This tool never returns real-time ' +
      "appointment availability — use check_availability for that. Retrieval works across English, Urdu script, " +
      'and Roman Urdu; if the patient wrote in Roman Urdu or mixed script, also pass queryTranslation with your ' +
      'own best plain-English or Urdu-script rendering of their question — this improves matching, it is never ' +
      'shown to the patient.',
    inputSchema,
    handler: async (input, context): Promise<SearchClinicKnowledgeToolOutput> => {
      // Trusted backend context only — never a clinicId the model could
      // supply (there is no such field in inputSchema to supply one
      // through in the first place).
      const result = await knowledgeService.search({
        clinicId: context.clinicId,
        query: input.query,
        queryTranslation: input.queryTranslation,
      });
      return { success: true, found: result.found, results: result.results };
    },
    // Task 7-8's deterministic escalation gate: an unresolved clinic-fact
    // question ('opens') blocks a bare send_message until it's resolved —
    // either a later search in the same turn actually finds something
    // ('closes') or the model explicitly escalates. See tool.types.ts's
    // ToolGroundingMetadata and send-message.tool.ts's blockedByOpenGap.
    grounding: {
      effect: (output) => (output.found ? 'closes' : 'opens'),
    },
  };
}
