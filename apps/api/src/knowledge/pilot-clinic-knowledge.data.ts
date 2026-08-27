import { KnowledgeCategory } from '../generated/prisma/enums';

export interface KnowledgeSeedDocument {
  category: KnowledgeCategory;
  title: string;
  body: string;
  tags: string[];
}

// Task 4C-11 — verified pilot-clinic knowledge, transcribed directly from
// the project's verified research context (this task's own brief). Nothing
// here is invented: no fees, no years-of-experience or success-count
// claims, no "best surgeon" language, and no medical advice. OPD hours are
// explicitly flagged as unverified rather than presented as confirmed —
// per this task's own instruction not to represent them as guaranteed
// real-time appointment availability.
//
// Kept granular (one focused document per topic) rather than one combined
// document, per this task's explicit instruction — this also keeps each
// document's tag list precise for ClinicKnowledgeService's keyword/tag
// match (knowledge.service.ts) instead of one large document matching
// every query indiscriminately.
//
// This is data only — see knowledge-seed.ts for how it is applied
// idempotently, and ai/tools/search-clinic-knowledge.tool.ts for how the AI
// retrieves it. Never inlined into the Gemini system prompt (ADR-009
// "grounded answers only" — docs/architecture/04-ai-orchestration.md §5).
export const PILOT_CLINIC_KNOWLEDGE_DOCUMENTS: readonly KnowledgeSeedDocument[] = [
  {
    category: KnowledgeCategory.DOCTOR,
    title: 'Dr. Hafiz Gulfam Sulehri — Doctor Profile',
    body: 'Dr. Hafiz Gulfam Sulehri is a General and Laparoscopic Surgeon. Qualifications: MBBS, MS (General Surgery).',
    tags: ['dr gulfam', 'hafiz gulfam', 'gulfam sulehri', 'doctor', 'surgeon', 'mbbs', 'general surgery'],
  },
  {
    category: KnowledgeCategory.SERVICE,
    title: 'General & Laparoscopic Surgery',
    body:
      'The clinic offers general surgery and laparoscopic (minimally invasive) surgery, performed by ' +
      'Dr. Hafiz Gulfam Sulehri.',
    tags: ['general surgery', 'laparoscopic', 'laparoscopic surgery', 'minimally invasive surgery'],
  },
  {
    category: KnowledgeCategory.SERVICE,
    title: 'Bariatric / Weight-loss Surgery',
    body: 'The clinic offers bariatric (weight-loss) surgery.',
    tags: ['bariatric', 'weight loss', 'weight-loss surgery', 'sleeve', 'gastric bypass', 'obesity surgery'],
  },
  {
    category: KnowledgeCategory.SERVICE,
    title: 'Proctological / Laser Surgery',
    body:
      'The clinic offers proctological and laser surgery, covering conditions such as hemorrhoids (piles), ' +
      'fissure, fistula, and pilonidal sinus.',
    tags: [
      'proctology',
      'proctological surgery',
      'laser surgery',
      'hemorrhoids',
      'piles',
      'fissure',
      'fistula',
      'pilonidal',
    ],
  },
  {
    category: KnowledgeCategory.SERVICE,
    title: 'Diabetic Foot & Complex Wounds',
    body: 'The clinic treats diabetic foot conditions and complex, hard-to-heal wounds.',
    tags: ['diabetic foot', 'diabetes', 'wound care', 'complex wounds', 'wound management'],
  },
  {
    category: KnowledgeCategory.SERVICE,
    title: 'Varicocele Surgery',
    body: 'The clinic offers documented varicocele surgery.',
    tags: ['varicocele', 'varicocele surgery'],
  },
  {
    category: KnowledgeCategory.LOCATION,
    title: 'Clinic Location',
    body: 'The clinic is located at Bashir Hospital, Khadim Ali Road, Model Town, Sialkot.',
    tags: ['location', 'address', 'bashir hospital', 'sialkot', 'khadim ali road', 'model town'],
  },
  {
    category: KnowledgeCategory.HOURS,
    title: 'OPD Hours (unverified)',
    body:
      'Reported OPD timing is Monday to Saturday, 12 PM to 3 PM, at Bashir Hospital. This timing has not been ' +
      "independently verified against the hospital's current schedule and may change — confirm directly with " +
      'the clinic before relying on it. This is general OPD timing information, not a real-time appointment ' +
      'slot; ask separately about actual bookable appointment availability.',
    tags: ['hours', 'opd', 'opd hours', 'timing', 'schedule', 'unverified'],
  },
  {
    category: KnowledgeCategory.FAQ,
    title: 'Patient FAQ',
    body:
      'Q: Who is the doctor? A: Dr. Hafiz Gulfam Sulehri, MBBS, MS (General Surgery), a General and ' +
      'Laparoscopic Surgeon.\n' +
      'Q: Where is the clinic? A: Bashir Hospital, Khadim Ali Road, Model Town, Sialkot.\n' +
      'Q: What services are offered? A: General surgery, laparoscopic surgery, bariatric (weight-loss) ' +
      'surgery, proctological/laser surgery, diabetic foot and complex wound care, and varicocele surgery.\n' +
      'Q: What are the OPD hours? A: Reported as Monday to Saturday, 12 PM to 3 PM — unverified, please ' +
      'confirm with the clinic.',
    tags: ['faq', 'general information', 'clinic info'],
  },
];
