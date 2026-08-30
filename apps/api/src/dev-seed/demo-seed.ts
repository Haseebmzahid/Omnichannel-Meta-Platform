import { createHash } from 'node:crypto';
import type { PrismaService } from '../prisma/prisma.service';
import {
  ChannelKey,
  ChannelLinkConfidence,
  ChannelLinkMethod,
  ChannelLinkState,
  ConversationMode,
  KnowledgeCategory,
  MessageContentType,
  MessageDirection,
  MessageSenderType,
  StaffRole,
} from '../generated/prisma/enums';
import { PILOT_CLINIC_KNOWLEDGE_DOCUMENTS } from '../knowledge/pilot-clinic-knowledge.data';
import { seedClinicKnowledge } from '../knowledge/knowledge-seed';
import { StaffService } from '../staff/staff.service';

// A one-off development/demo dataset for the Neon Dev branch — NOT part of
// the automated test suite, and never wired into the running application.
// Reuses the real, already-implemented write paths wherever one exists
// (StaffService.createStaff() for staff, seedClinicKnowledge() for
// knowledge documents — see knowledge/knowledge-seed.ts, this codebase's
// only pre-existing seed mechanism) rather than reinventing them. Contact/
// Patient/ChannelIdentity/Conversation/Message are written directly via
// Prisma, exactly as every existing integration test fixture in this
// codebase already does — there is no dedicated service for any of those
// (see e.g. messaging/conversation.service.spec.ts's own fixture setup).
//
// Idempotency strategy — every demo row is looked up by a natural or
// deterministic key BEFORE writing, and left completely untouched if
// already present (never merely "updated to the same values", to avoid
// even a spurious @updatedAt bump on a no-op re-run):
//   - Clinic/Patient/Contact/ChannelIdentity: no natural DB uniqueness
//     constraint exists for these (see schema.prisma's own comments on
//     Patient/Contact) — id is assigned deterministically instead (see
//     demoId() below), and looked up by that id.
//   - Staff: the schema's own real natural key, @@unique([clinicId, email]).
//   - Conversation: the schema's own real natural key,
//     @@unique([channelKey, channelAccountRef, externalThreadKey]).
//   - Message: Message.idempotencyKey — the exact field this schema
//     already defines for "dedupe an application-level write before a real
//     external id exists" (see schema.prisma's own comment on it).
// Running seedDemoData() any number of times therefore converges to
// exactly the same rows — never duplicates, never drifts.
//
// Every identifier is namespaced under one deterministic Clinic id, which
// is also cleanupDemoData()'s one and only safety boundary: it deletes
// exactly the rows reachable from that one clinic id (after independently
// re-confirming the clinic's name still matches DEMO_CLINIC_NAME), never
// anything else.

const DEMO_NAMESPACE = 'dr-gulfam-demo-clinic-v1';

// Deterministic, dependency-free "fake UUID" derivation: a stable SHA-256
// hash of a namespaced key, formatted into standard 8-4-4-4-12 hex groups
// with the version/variant nibbles forced so every id still *looks* like an
// ordinary UUIDv4 (Postgres's `uuid` column only cares about the format,
// not the version, but there is no reason to produce something that looks
// malformed). The same key always produces the same id, in this process or
// any other — that determinism is the entire idempotency mechanism for the
// tables below that have no natural DB-level uniqueness constraint.
export function demoId(key: string): string {
  const hash = createHash('sha256').update(`${DEMO_NAMESPACE}:${key}`).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

export const DEMO_CLINIC_NAME = 'Dr. Gulfam Demo Clinic';
export const DEMO_CLINIC_ID = demoId('clinic');

interface DemoStaffSeed {
  key: 'admin' | 'manager' | 'agent' | 'readonly';
  name: string;
  email: string;
  role: StaffRole;
}

// Clearly fake, obviously non-production emails — the `.test` TLD is
// IANA-reserved specifically for this (RFC 2606), the same convention
// every existing test fixture in this codebase already uses
// (`*@example.test`, `*@clinic.test`).
const DEMO_STAFF_SEEDS: readonly DemoStaffSeed[] = [
  { key: 'admin', name: 'Demo Admin', email: 'admin@demo.drgulfam.test', role: StaffRole.ADMIN },
  { key: 'manager', name: 'Demo Manager', email: 'manager@demo.drgulfam.test', role: StaffRole.MANAGER },
  { key: 'agent', name: 'Demo Agent', email: 'agent@demo.drgulfam.test', role: StaffRole.AGENT },
  { key: 'readonly', name: 'Demo Read Only', email: 'readonly@demo.drgulfam.test', role: StaffRole.READ_ONLY },
];

interface DemoPatientSeed {
  key: string;
  displayName: string;
  verifiedPhone?: string;
  verifiedEmail?: string;
}

// Fake Pakistani mobile numbers in the +923XXXXXXXXX shape used throughout
// this codebase's own fixtures/docs, and .test emails — none of these are
// real people or real contact details.
const DEMO_PATIENT_SEEDS: readonly DemoPatientSeed[] = [
  { key: 'fatima-noor', displayName: 'Fatima Noor', verifiedPhone: '+923001110001', verifiedEmail: 'fatima.noor@demo.drgulfam.test' },
  { key: 'zainab-malik', displayName: 'Zainab Malik', verifiedPhone: '+923001110002' },
  { key: 'hamza-sheikh', displayName: 'Hamza Sheikh', verifiedPhone: '+923001110003', verifiedEmail: 'hamza.sheikh@demo.drgulfam.test' },
  { key: 'ali-raza', displayName: 'Ali Raza' },
  { key: 'mehak-aslam', displayName: 'Mehak Aslam', verifiedPhone: '+923001110005' },
  { key: 'noman-iqbal', displayName: 'Noman Iqbal' },
];

interface DemoMessageSeed {
  key: string;
  minutesAgo: number;
  direction: MessageDirection;
  senderType: MessageSenderType;
  senderStaffKey?: DemoStaffSeed['key'];
  aiGenerated?: boolean;
  text: string;
}

interface DemoConversationSeed {
  key: string;
  /** null = an unresolved contact, never linked to a Patient. */
  patientKey: string | null;
  /** Only used when patientKey is null — the contact's own channel-native display name. */
  unresolvedDisplayName?: string;
  channelKey: ChannelKey;
  mode: ConversationMode;
  assignedStaffKey?: DemoStaffSeed['key'];
  messages: readonly DemoMessageSeed[];
}

// Content mirrors the real pilot-clinic knowledge (Dr. Hafiz Gulfam
// Sulehri, Bashir Hospital, Sialkot, OPD hours flagged as unverified, no
// invented fees) — the same discipline pilot-clinic-knowledge.data.ts's own
// header comment describes, so the demo conversations read as consistent
// with the demo knowledge base rather than contradicting it.
//
// One conversation per (patient, channel) pair; modes cover exactly what
// this task asks for and the architecture documents (AI/HUMAN/PENDING —
// docs/architecture/03-conversation-and-inbox.md §5). A PENDING
// conversation's only outbound message is the one AI acknowledgement the
// doc specifies ("AI silent except one acknowledgement") — never a second
// AI reply, which would misrepresent what PENDING means.
const DEMO_CONVERSATION_SEEDS: readonly DemoConversationSeed[] = [
  {
    key: 'fatima-noor-whatsapp',
    patientKey: 'fatima-noor',
    channelKey: ChannelKey.WHATSAPP,
    mode: ConversationMode.AI,
    messages: [
      { key: 'msg-1', minutesAgo: 95, direction: MessageDirection.INBOUND, senderType: MessageSenderType.PATIENT, text: 'Assalam o Alaikum, I wanted to ask about the OPD timings for this week.' },
      { key: 'msg-2', minutesAgo: 94, direction: MessageDirection.OUTBOUND, senderType: MessageSenderType.AI, aiGenerated: true, text: "Walaikum Assalam! Our OPD hours are Monday to Saturday. Would you like the timing for a specific day?" },
      { key: 'msg-3', minutesAgo: 60, direction: MessageDirection.INBOUND, senderType: MessageSenderType.PATIENT, text: 'Yes, for Monday please.' },
      { key: 'msg-4', minutesAgo: 59, direction: MessageDirection.OUTBOUND, senderType: MessageSenderType.AI, aiGenerated: true, text: "On Mondays the OPD is open in the afternoon — I'd recommend confirming the exact slot by phone, as timings can vary." },
    ],
  },
  {
    key: 'zainab-malik-whatsapp',
    patientKey: 'zainab-malik',
    channelKey: ChannelKey.WHATSAPP,
    mode: ConversationMode.PENDING,
    messages: [
      { key: 'msg-1', minutesAgo: 30, direction: MessageDirection.INBOUND, senderType: MessageSenderType.PATIENT, text: "I've been having severe pain after my surgery last week, I need to speak to someone urgently." },
      { key: 'msg-2', minutesAgo: 29, direction: MessageDirection.OUTBOUND, senderType: MessageSenderType.AI, aiGenerated: true, text: "I've flagged this for a staff member to review right away — someone will respond shortly." },
    ],
  },
  {
    key: 'hamza-sheikh-whatsapp',
    patientKey: 'hamza-sheikh',
    channelKey: ChannelKey.WHATSAPP,
    mode: ConversationMode.HUMAN,
    assignedStaffKey: 'agent',
    messages: [
      { key: 'msg-1', minutesAgo: 180, direction: MessageDirection.INBOUND, senderType: MessageSenderType.PATIENT, text: 'Can I get a refund for my cancelled appointment?' },
      { key: 'msg-2', minutesAgo: 179, direction: MessageDirection.OUTBOUND, senderType: MessageSenderType.AI, aiGenerated: true, text: "I've flagged this for a staff member to review right away — someone will respond shortly." },
      { key: 'msg-3', minutesAgo: 120, direction: MessageDirection.OUTBOUND, senderType: MessageSenderType.STAFF, senderStaffKey: 'agent', text: "Hi, thanks for reaching out — I can see your cancelled appointment and I'm processing the refund now; it should reflect within 3-5 business days." },
      { key: 'msg-4', minutesAgo: 110, direction: MessageDirection.INBOUND, senderType: MessageSenderType.PATIENT, text: 'Thank you so much!' },
    ],
  },
  {
    key: 'ali-raza-instagram',
    patientKey: 'ali-raza',
    channelKey: ChannelKey.INSTAGRAM,
    mode: ConversationMode.AI,
    messages: [
      { key: 'msg-1', minutesAgo: 50, direction: MessageDirection.INBOUND, senderType: MessageSenderType.PATIENT, text: 'Hey, do you guys offer laparoscopic surgery?' },
      { key: 'msg-2', minutesAgo: 49, direction: MessageDirection.OUTBOUND, senderType: MessageSenderType.AI, aiGenerated: true, text: 'Yes — the clinic offers general and laparoscopic (minimally invasive) surgery, performed by Dr. Hafiz Gulfam Sulehri.' },
      { key: 'msg-3', minutesAgo: 40, direction: MessageDirection.INBOUND, senderType: MessageSenderType.PATIENT, text: 'Great, is it done at Bashir Hospital?' },
      { key: 'msg-4', minutesAgo: 39, direction: MessageDirection.OUTBOUND, senderType: MessageSenderType.AI, aiGenerated: true, text: "That's correct — procedures are performed at Bashir Hospital, Sialkot." },
    ],
  },
  {
    key: 'unresolved-instagram',
    patientKey: null,
    unresolvedDisplayName: 'Instagram User',
    channelKey: ChannelKey.INSTAGRAM,
    mode: ConversationMode.PENDING,
    messages: [
      { key: 'msg-1', minutesAgo: 15, direction: MessageDirection.INBOUND, senderType: MessageSenderType.PATIENT, text: "Hi, this is urgent — I need to talk to a real person about a billing issue." },
      { key: 'msg-2', minutesAgo: 14, direction: MessageDirection.OUTBOUND, senderType: MessageSenderType.AI, aiGenerated: true, text: "I've let our staff know and someone will get back to you shortly." },
    ],
  },
  {
    key: 'mehak-aslam-messenger',
    patientKey: 'mehak-aslam',
    channelKey: ChannelKey.MESSENGER,
    mode: ConversationMode.HUMAN,
    assignedStaffKey: 'manager',
    messages: [
      { key: 'msg-1', minutesAgo: 200, direction: MessageDirection.INBOUND, senderType: MessageSenderType.PATIENT, text: 'Is Dr. Gulfam available for a consultation this week?' },
      { key: 'msg-2', minutesAgo: 199, direction: MessageDirection.OUTBOUND, senderType: MessageSenderType.AI, aiGenerated: true, text: 'Let me check with our team and get back to you.' },
      { key: 'msg-3', minutesAgo: 150, direction: MessageDirection.OUTBOUND, senderType: MessageSenderType.STAFF, senderStaffKey: 'manager', text: 'Hi, yes — Dr. Gulfam has an opening this Thursday afternoon. Would that work for you?' },
      { key: 'msg-4', minutesAgo: 140, direction: MessageDirection.INBOUND, senderType: MessageSenderType.PATIENT, text: 'Thursday afternoon works great, thank you!' },
    ],
  },
  {
    key: 'noman-iqbal-messenger',
    patientKey: 'noman-iqbal',
    channelKey: ChannelKey.MESSENGER,
    mode: ConversationMode.AI,
    messages: [
      { key: 'msg-1', minutesAgo: 20, direction: MessageDirection.INBOUND, senderType: MessageSenderType.PATIENT, text: "What's the consultation fee?" },
      { key: 'msg-2', minutesAgo: 19, direction: MessageDirection.OUTBOUND, senderType: MessageSenderType.AI, aiGenerated: true, text: "I don't have a confirmed fee schedule available right now — I'd recommend confirming directly with the clinic by phone." },
    ],
  },
];

// One shared channelAccountRef per channel — this demo clinic has exactly
// one WABA/Page/IG account, matching the real single-clinic, single-account
// shape every other fixture in this codebase already assumes.
const CHANNEL_ACCOUNT_REF: Record<ChannelKey, string> = {
  [ChannelKey.WHATSAPP]: `demo-waba-${DEMO_CLINIC_ID}`,
  [ChannelKey.INSTAGRAM]: `demo-ig-${DEMO_CLINIC_ID}`,
  [ChannelKey.MESSENGER]: `demo-page-${DEMO_CLINIC_ID}`,
};

export interface SeedDemoDataOptions {
  /** Applied to all four demo staff accounts — see scripts/seed-demo-data.ts for how this is supplied. */
  staffPassword: string;
}

export interface SeedDemoDataSummary {
  clinicCreated: boolean;
  staffCreated: string[];
  staffExisting: string[];
  patientsCreated: number;
  patientsExisting: number;
  contactsCreated: number;
  contactsExisting: number;
  conversationsCreated: number;
  conversationsExisting: number;
  messagesCreated: number;
  messagesExisting: number;
  knowledge: { created: number; updated: number; unchanged: number };
}

export async function seedDemoData(prisma: PrismaService, options: SeedDemoDataOptions): Promise<SeedDemoDataSummary> {
  const staffService = new StaffService(prisma);
  const summary: SeedDemoDataSummary = {
    clinicCreated: false,
    staffCreated: [],
    staffExisting: [],
    patientsCreated: 0,
    patientsExisting: 0,
    contactsCreated: 0,
    contactsExisting: 0,
    conversationsCreated: 0,
    conversationsExisting: 0,
    messagesCreated: 0,
    messagesExisting: 0,
    knowledge: { created: 0, updated: 0, unchanged: 0 },
  };

  // --- Clinic --------------------------------------------------------------
  const existingClinic = await prisma.clinic.findUnique({ where: { id: DEMO_CLINIC_ID } });
  if (!existingClinic) {
    await prisma.clinic.create({
      data: {
        id: DEMO_CLINIC_ID,
        name: DEMO_CLINIC_NAME,
        timezone: 'Asia/Karachi',
        address: 'Bashir Hospital, Sialkot, Pakistan',
      },
    });
    summary.clinicCreated = true;
  }

  // --- Staff -----------------------------------------------------------------
  const staffIdByKey = new Map<DemoStaffSeed['key'], string>();
  for (const seed of DEMO_STAFF_SEEDS) {
    const existing = await prisma.staff.findUnique({ where: { clinicId_email: { clinicId: DEMO_CLINIC_ID, email: seed.email } } });
    if (existing) {
      staffIdByKey.set(seed.key, existing.id);
      summary.staffExisting.push(seed.email);
      continue;
    }
    const created = await staffService.createStaff(DEMO_CLINIC_ID, {
      name: seed.name,
      email: seed.email,
      password: options.staffPassword,
      role: seed.role,
    });
    staffIdByKey.set(seed.key, created.id);
    summary.staffCreated.push(seed.email);
  }

  // --- Patients + Contacts + ChannelIdentities ------------------------------
  const patientIdByKey = new Map<string, string>();
  for (const seed of DEMO_PATIENT_SEEDS) {
    const patientId = demoId(`patient:${seed.key}`);
    const existingPatient = await prisma.patient.findUnique({ where: { id: patientId } });
    if (!existingPatient) {
      await prisma.patient.create({
        data: { id: patientId, clinicId: DEMO_CLINIC_ID, displayName: seed.displayName, verifiedPhone: seed.verifiedPhone, verifiedEmail: seed.verifiedEmail },
      });
      summary.patientsCreated += 1;
    } else {
      summary.patientsExisting += 1;
    }
    patientIdByKey.set(seed.key, patientId);
  }

  // One Contact per demo conversation (matches this domain's real shape: a
  // Contact is scoped to a single channel identity, not shared across
  // channels — see schema.prisma's own Contact/ChannelIdentity comments).
  const contactIdByConversationKey = new Map<string, string>();
  for (const conversationSeed of DEMO_CONVERSATION_SEEDS) {
    const contactId = demoId(`contact:${conversationSeed.key}`);
    const existingContact = await prisma.contact.findUnique({ where: { id: contactId } });
    const linkedPatientId = conversationSeed.patientKey ? patientIdByKey.get(conversationSeed.patientKey) : undefined;
    const displayName = conversationSeed.patientKey
      ? DEMO_PATIENT_SEEDS.find((p) => p.key === conversationSeed.patientKey)!.displayName
      : conversationSeed.unresolvedDisplayName!;

    if (!existingContact) {
      await prisma.contact.create({ data: { id: contactId, patientId: linkedPatientId, displayName } });
      summary.contactsCreated += 1;
    } else {
      summary.contactsExisting += 1;
    }
    contactIdByConversationKey.set(conversationSeed.key, contactId);

    const channelIdentityExternalId = `demo-${conversationSeed.key}`;
    const existingIdentity = await prisma.channelIdentity.findUnique({
      where: {
        channelKey_channelAccountRef_externalId: {
          channelKey: conversationSeed.channelKey,
          channelAccountRef: CHANNEL_ACCOUNT_REF[conversationSeed.channelKey],
          externalId: channelIdentityExternalId,
        },
      },
    });
    if (!existingIdentity) {
      const isLinked = linkedPatientId !== undefined;
      await prisma.channelIdentity.create({
        data: {
          contactId,
          channelKey: conversationSeed.channelKey,
          channelAccountRef: CHANNEL_ACCOUNT_REF[conversationSeed.channelKey],
          externalId: channelIdentityExternalId,
          displayNameAtChannel: displayName,
          linkState: isLinked ? ChannelLinkState.LINKED : ChannelLinkState.UNLINKED,
          linkMethod: isLinked ? ChannelLinkMethod.STAFF_CONFIRMED : undefined,
          linkConfidence: isLinked ? ChannelLinkConfidence.HIGH : undefined,
          linkedAt: isLinked ? new Date() : undefined,
          linkedByStaffId: isLinked ? staffIdByKey.get('admin') : undefined,
        },
      });
    }
  }

  // --- Conversations + Messages ----------------------------------------------
  const now = Date.now();
  for (const conversationSeed of DEMO_CONVERSATION_SEEDS) {
    const contactId = contactIdByConversationKey.get(conversationSeed.key)!;
    const patientId = conversationSeed.patientKey ? patientIdByKey.get(conversationSeed.patientKey) : undefined;
    const externalThreadKey = `demo-thread-${conversationSeed.key}`;

    const existingConversation = await prisma.conversation.findUnique({
      where: {
        channelKey_channelAccountRef_externalThreadKey: {
          channelKey: conversationSeed.channelKey,
          channelAccountRef: CHANNEL_ACCOUNT_REF[conversationSeed.channelKey],
          externalThreadKey,
        },
      },
    });

    let conversationId: string;
    if (existingConversation) {
      conversationId = existingConversation.id;
      summary.conversationsExisting += 1;
    } else {
      const messageTimes = conversationSeed.messages.map((m) => new Date(now - m.minutesAgo * 60_000));
      const lastMessageAt = messageTimes[messageTimes.length - 1];
      const lastPatientMessageAt = [...conversationSeed.messages]
        .map((m, i) => ({ m, t: messageTimes[i] }))
        .filter((x) => x.m.senderType === MessageSenderType.PATIENT)
        .at(-1)?.t;
      const firstOutboundIndex = conversationSeed.messages.findIndex((m) => m.direction === MessageDirection.OUTBOUND);
      const firstResponseAt = firstOutboundIndex >= 0 ? messageTimes[firstOutboundIndex] : undefined;
      // A conversation "looks unread" when its very last message is from
      // the patient — i.e. PENDING conversations (awaiting staff) and any
      // conversation whose most recent line came from the patient side.
      const lastMessage = conversationSeed.messages[conversationSeed.messages.length - 1];
      const unreadCount = lastMessage?.senderType === MessageSenderType.PATIENT ? 1 : 0;

      const created = await prisma.conversation.create({
        data: {
          clinicId: DEMO_CLINIC_ID,
          contactId,
          patientId,
          channelKey: conversationSeed.channelKey,
          channelAccountRef: CHANNEL_ACCOUNT_REF[conversationSeed.channelKey],
          externalThreadKey,
          mode: conversationSeed.mode,
          assignedStaffId: conversationSeed.assignedStaffKey ? staffIdByKey.get(conversationSeed.assignedStaffKey) : undefined,
          unreadCount,
          lastMessageAt,
          lastPatientMessageAt,
          firstResponseAt,
          createdAt: messageTimes[0],
        },
      });
      conversationId = created.id;
      summary.conversationsCreated += 1;
    }

    for (let i = 0; i < conversationSeed.messages.length; i += 1) {
      const messageSeed = conversationSeed.messages[i]!;
      const idempotencyKey = `demo-seed:${conversationSeed.key}:${messageSeed.key}`;
      const existingMessage = await prisma.message.findUnique({ where: { idempotencyKey } });
      if (existingMessage) {
        summary.messagesExisting += 1;
        continue;
      }

      const timestamp = new Date(now - messageSeed.minutesAgo * 60_000);
      await prisma.message.create({
        data: {
          conversationId,
          channelKey: conversationSeed.channelKey,
          channelAccountRef: CHANNEL_ACCOUNT_REF[conversationSeed.channelKey],
          direction: messageSeed.direction,
          senderType: messageSeed.senderType,
          senderStaffId: messageSeed.senderStaffKey ? staffIdByKey.get(messageSeed.senderStaffKey) : undefined,
          contentType: MessageContentType.TEXT,
          text: messageSeed.text,
          idempotencyKey,
          aiGenerated: messageSeed.aiGenerated ?? false,
          receivedAt: messageSeed.direction === MessageDirection.INBOUND ? timestamp : undefined,
          sentAt: messageSeed.direction === MessageDirection.OUTBOUND ? timestamp : undefined,
          createdAt: timestamp,
        },
      });
      summary.messagesCreated += 1;
    }
  }

  // --- Knowledge documents ---------------------------------------------------
  // Reuses the existing, already-tested seed mechanism verbatim — see this
  // file's own header comment.
  summary.knowledge = await seedClinicKnowledge(prisma, DEMO_CLINIC_ID, PILOT_CLINIC_KNOWLEDGE_DOCUMENTS);
  // A demo-specific document too, so the Knowledge screen shows more than
  // one category type sourced only from the pilot dataset.
  const demoFaq = {
    category: KnowledgeCategory.FAQ,
    title: 'Demo data notice',
    body: 'This knowledge document, and every record in this clinic, is seeded demo/development data — not a real patient, staff member, or clinic.',
    tags: ['demo', 'seed'],
  };
  const faqSummary = await seedClinicKnowledge(prisma, DEMO_CLINIC_ID, [demoFaq]);
  summary.knowledge.created += faqSummary.created;
  summary.knowledge.updated += faqSummary.updated;
  summary.knowledge.unchanged += faqSummary.unchanged;

  return summary;
}

export interface CleanupDemoDataSummary {
  found: boolean;
  messagesDeleted: number;
  conversationsDeleted: number;
  channelIdentitiesDeleted: number;
  contactsDeleted: number;
  patientsDeleted: number;
  knowledgeDocumentsDeleted: number;
  staffDeleted: number;
  clinicDeleted: boolean;
}

// Deletes exactly the rows reachable from DEMO_CLINIC_ID — nothing else.
// Re-confirms the clinic's name before touching anything, as a second,
// independent check beyond "the id matches": if that name ever doesn't
// match DEMO_CLINIC_NAME, this refuses to delete anything at all rather
// than guess.
export async function cleanupDemoData(prisma: PrismaService): Promise<CleanupDemoDataSummary> {
  const clinic = await prisma.clinic.findUnique({ where: { id: DEMO_CLINIC_ID } });
  if (!clinic) {
    return {
      found: false,
      messagesDeleted: 0,
      conversationsDeleted: 0,
      channelIdentitiesDeleted: 0,
      contactsDeleted: 0,
      patientsDeleted: 0,
      knowledgeDocumentsDeleted: 0,
      staffDeleted: 0,
      clinicDeleted: false,
    };
  }
  if (clinic.name !== DEMO_CLINIC_NAME) {
    throw new Error(`Refusing to clean up: clinic ${DEMO_CLINIC_ID} exists but its name does not match the expected demo clinic name.`);
  }

  const contactIds = (await prisma.contact.findMany({ where: { conversations: { some: { clinicId: DEMO_CLINIC_ID } } }, select: { id: true } })).map(
    (c) => c.id,
  );

  const { count: messagesDeleted } = await prisma.message.deleteMany({ where: { conversation: { clinicId: DEMO_CLINIC_ID } } });
  const { count: conversationsDeleted } = await prisma.conversation.deleteMany({ where: { clinicId: DEMO_CLINIC_ID } });
  const { count: channelIdentitiesDeleted } = await prisma.channelIdentity.deleteMany({ where: { contactId: { in: contactIds } } });
  const { count: contactsDeleted } = await prisma.contact.deleteMany({ where: { id: { in: contactIds } } });
  const { count: patientsDeleted } = await prisma.patient.deleteMany({ where: { clinicId: DEMO_CLINIC_ID } });
  const { count: knowledgeDocumentsDeleted } = await prisma.knowledgeDocument.deleteMany({ where: { clinicId: DEMO_CLINIC_ID } });
  const { count: staffDeleted } = await prisma.staff.deleteMany({ where: { clinicId: DEMO_CLINIC_ID } });
  await prisma.clinic.delete({ where: { id: DEMO_CLINIC_ID } });

  return {
    found: true,
    messagesDeleted,
    conversationsDeleted,
    channelIdentitiesDeleted,
    contactsDeleted,
    patientsDeleted,
    knowledgeDocumentsDeleted,
    staffDeleted,
    clinicDeleted: true,
  };
}
