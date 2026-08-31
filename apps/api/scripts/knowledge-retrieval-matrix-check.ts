import 'reflect-metadata';
import { GeminiEmbeddingProvider } from '../src/ai/providers/gemini-embedding.provider';
import { config } from '../src/config';
import { bestSemanticScore, fuseScore, RELEVANCE_THRESHOLD } from '../src/knowledge/knowledge-hybrid-search';
import { PrismaService } from '../src/prisma/prisma.service';

// Task 7-8 — manual calibration tool. NOT part of the automated test
// suite and NOT wired into package.json (same convention as
// gemini-smoke-test.ts): requires a real GEMINI_API_KEY and a clinic
// already seeded with the pilot knowledge documents (`pnpm seed:knowledge`)
// and backfilled (`pnpm backfill:knowledge-embeddings`).
//
//   pnpm --filter @clinic/api exec tsx scripts/knowledge-retrieval-matrix-check.ts <clinicId>
//
// The unit tests in knowledge.service.hybrid.spec.ts prove the fusion/
// threshold/clinic-scoping CODE is correct using hand-constructed
// embedding vectors — they cannot prove gemini-embedding-001 itself
// actually produces good cross-lingual similarity for the REAL pilot
// documents and REAL example queries in English / Urdu script / Roman
// Urdu / mixed script. That empirical proof needs a real API call, which
// this environment does not have credentials for — run this yourself once
// with a real key and read the printed scores.
//
// Deliberately bypasses ClinicKnowledgeService.search() itself — that
// method's public contract intentionally never exposes raw scores (the AI
// model has no use for them). This script calls the same pure fusion
// functions (knowledge-hybrid-search.ts) directly so a human can see the
// numbers. It only ever queries the semantic half in isolation
// ("fused(semantic-only)" below, with keywordScoreNorm fixed at 0) — real
// production search() also adds a keyword contribution on top of this, so
// this is a conservative lower bound on the real fused score, not the
// exact number a real patient query would get.
//
// If the printed scores don't cluster the way RELEVANCE_THRESHOLD (0.5,
// in knowledge-hybrid-search.ts) assumes, adjust that constant based on
// what you see here — that is the actual point of this script.

interface Case {
  label: string;
  query: string;
  queryTranslation?: string;
  /** Empty string means "expect found:false" (a negative case). */
  expectedTitleContains: string;
}

const CASES: Case[] = [
  { label: 'Doctor — English', query: 'Who is the doctor here?', expectedTitleContains: 'Gulfam' },
  { label: 'Doctor — Urdu script', query: 'یہاں ڈاکٹر کون ہے؟', queryTranslation: 'Who is the doctor here?', expectedTitleContains: 'Gulfam' },
  { label: 'Doctor — Roman Urdu', query: 'yahan doctor kon hai?', queryTranslation: 'who is the doctor here', expectedTitleContains: 'Gulfam' },
  { label: 'Doctor — mixed', query: 'Doctor sahab ka naam kya hai?', queryTranslation: "what is the doctor's name", expectedTitleContains: 'Gulfam' },

  { label: 'Hours — English', query: 'What time do you open?', expectedTitleContains: 'Hours' },
  { label: 'Hours — Urdu script', query: 'کلینک کب کھلتا ہے؟', queryTranslation: 'When does the clinic open?', expectedTitleContains: 'Hours' },
  { label: 'Hours — Roman Urdu', query: 'clinic kab khulta hai?', queryTranslation: 'when does the clinic open', expectedTitleContains: 'Hours' },
  { label: 'Hours — mixed', query: 'aap ka opening time kya hai please', queryTranslation: 'what is your opening time please', expectedTitleContains: 'Hours' },

  { label: 'Location — English', query: 'Where is the clinic located?', expectedTitleContains: 'Location' },
  { label: 'Location — Urdu script', query: 'کلینک کہاں ہے؟', queryTranslation: 'Where is the clinic?', expectedTitleContains: 'Location' },
  { label: 'Location — Roman Urdu', query: 'clinic kahan hai', queryTranslation: 'where is the clinic', expectedTitleContains: 'Location' },
  { label: 'Location — mixed', query: 'location bata dein please', queryTranslation: 'please tell me the location', expectedTitleContains: 'Location' },

  { label: 'Bariatric surgery — English', query: 'Do you do weight loss surgery?', expectedTitleContains: 'Bariatric' },
  { label: 'Bariatric surgery — Urdu script', query: 'کیا آپ وزن کم کرنے کی سرجری کرتے ہیں؟', queryTranslation: 'Do you do weight loss surgery?', expectedTitleContains: 'Bariatric' },
  { label: 'Bariatric surgery — Roman Urdu', query: 'weight loss ki surgery hoti hai?', queryTranslation: 'is weight loss surgery available', expectedTitleContains: 'Bariatric' },
  { label: 'Bariatric surgery — mixed', query: 'bariatric surgery available hai kya', queryTranslation: 'is bariatric surgery available', expectedTitleContains: 'Bariatric' },

  { label: 'FAQ/fees — English', query: 'What are your fees?', expectedTitleContains: 'FAQ' },
  { label: 'FAQ/fees — Urdu script', query: 'فیس کتنی ہے؟', queryTranslation: 'How much is the fee?', expectedTitleContains: 'FAQ' },
  { label: 'FAQ/fees — Roman Urdu', query: 'fees kitni hai', queryTranslation: 'how much is the fee', expectedTitleContains: 'FAQ' },
  { label: 'FAQ/fees — mixed', query: 'consultation ka charge kitna hai?', queryTranslation: 'what is the consultation charge', expectedTitleContains: 'FAQ' },

  { label: 'Unrelated — English', query: "what's the weather today", expectedTitleContains: '' },
  { label: 'Unrelated — Urdu script', query: 'آج موسم کیسا ہے', queryTranslation: "what's the weather today", expectedTitleContains: '' },
  { label: 'Unrelated — Roman Urdu', query: 'aaj weather kaisa hai', queryTranslation: "what's the weather today", expectedTitleContains: '' },
];

async function main(): Promise<void> {
  const [clinicId] = process.argv.slice(2);
  if (!clinicId) {
    console.error('Usage: pnpm --filter @clinic/api exec tsx scripts/knowledge-retrieval-matrix-check.ts <clinicId>');
    process.exitCode = 1;
    return;
  }
  if (!config.GEMINI_API_KEY) {
    console.error('GEMINI_API_KEY is not configured. This script needs a real key to call the real embedding API.');
    process.exitCode = 1;
    return;
  }

  const prisma = new PrismaService();
  const embeddingProvider = new GeminiEmbeddingProvider(config.GEMINI_API_KEY, config.GEMINI_EMBEDDING_MODEL);
  await prisma.$connect();

  try {
    const documents = await prisma.knowledgeDocument.findMany({
      where: { clinicId, isActive: true },
      select: { title: true, embedding: true },
    });
    if (documents.length === 0) {
      console.error(`No active knowledge documents found for clinic ${clinicId}. Seed it first: pnpm seed:knowledge -- ${clinicId}`);
      process.exitCode = 1;
      return;
    }
    const unembedded = documents.filter((d) => d.embedding.length === 0).length;
    if (unembedded > 0) {
      console.warn(`Warning: ${unembedded} document(s) have no embedding yet — run "pnpm backfill:knowledge-embeddings" first for meaningful numbers.\n`);
    }

    console.log(`--- Retrieval matrix check: ${documents.length} document(s), RELEVANCE_THRESHOLD=${RELEVANCE_THRESHOLD} ---\n`);

    let passed = 0;
    let failed = 0;
    for (const testCase of CASES) {
      const textsToEmbed = [testCase.query, testCase.queryTranslation].filter((t): t is string => Boolean(t));
      const queryEmbeddings = await Promise.all(textsToEmbed.map((text) => embeddingProvider.embed(text, 'RETRIEVAL_QUERY')));

      const scored = documents
        .map((doc) => ({
          title: doc.title,
          semanticScore: doc.embedding.length > 0 ? bestSemanticScore(doc.embedding, queryEmbeddings) : 0,
        }))
        .sort((a, b) => b.semanticScore - a.semanticScore);

      const top = scored[0];
      const fusedSemanticOnly = top ? fuseScore({ semanticScore: top.semanticScore, keywordScoreNorm: 0 }) : 0;
      const clearsThreshold = fusedSemanticOnly >= RELEVANCE_THRESHOLD;
      const isNegativeCase = testCase.expectedTitleContains === '';
      const ok = isNegativeCase ? !clearsThreshold : clearsThreshold && Boolean(top?.title.includes(testCase.expectedTitleContains));

      ok ? passed++ : failed++;
      console.log(
        `[${ok ? 'PASS' : 'FAIL'}] ${testCase.label.padEnd(28)} top="${top?.title ?? '(none)'}" ` +
          `semantic=${top?.semanticScore.toFixed(3) ?? '-'} fused(semantic-only)=${fusedSemanticOnly.toFixed(3)}`,
      );
    }

    console.log(`\n${passed} passed, ${failed} failed out of ${CASES.length}.`);
  } finally {
    await prisma.$disconnect();
  }
}

main();
