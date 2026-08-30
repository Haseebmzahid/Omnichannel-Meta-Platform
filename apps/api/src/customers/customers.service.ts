import { Injectable } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client';
import { toCsv } from '../common/csv.util';
import { PrismaService } from '../prisma/prisma.service';
import type { CustomerExportRow } from './customers.types';

const CSV_HEADERS = ['Name', 'Phone', 'Email', 'Channels', 'First Interaction', 'Last Interaction'];

// The CSV shaping step, separate from listCustomersForClinic() above so
// "what a customer row contains" and "how it's rendered as CSV text" stay
// independently testable. Channels is the one multi-value field — joined
// into a single cell with ", "; toCsv()'s own escaping quotes that cell
// automatically (it contains a comma) exactly like any other field that
// needs quoting, not a special case.
export function buildCustomerExportCsv(rows: CustomerExportRow[]): string {
  const csvRows = rows.map((row) => [row.name, row.phone ?? '', row.email ?? '', row.channels.join(', '), row.firstInteraction, row.lastInteraction]);
  return toCsv(CSV_HEADERS, csvRows);
}

// A generous safety ceiling, not a real pagination mechanism — an export
// that silently truncated a clinic's customer list would be actively
// misleading. Mirrors ClinicKnowledgeService's own CANDIDATE_FETCH_CAP
// reasoning (knowledge/knowledge.service.ts): exists only so a clinic that
// somehow accumulated an unusually large contact list can't turn one export
// request into an unbounded query.
const MAX_EXPORT_ROWS = 20_000;

// The static shape of what a customer export needs from a Contact row —
// `conversations` here has no `where` yet (Prisma.ContactGetPayload only
// cares about the *shape*, not the runtime filter value), so this can stay
// a module-level constant and still drive an accurately-typed row via
// GetPayload below, the same convention conversation.service.ts's
// LIST_INCLUDE/DETAIL_INCLUDE already use.
const CUSTOMER_SELECT = {
  displayName: true,
  patient: { select: { displayName: true, verifiedPhone: true, verifiedEmail: true } },
  conversations: { select: { channelKey: true, createdAt: true, lastMessageAt: true } },
} satisfies Prisma.ContactSelect;

type CustomerContactRow = Prisma.ContactGetPayload<{ select: typeof CUSTOMER_SELECT }>;

@Injectable()
export class CustomerExportService {
  constructor(private readonly prisma: PrismaService) {}

  // "This clinic's customers" = Contacts with at least one Conversation
  // scoped to this clinicId. Contact itself carries no clinicId column (see
  // schema.prisma's Conversation.clinicId comment: Contact/ChannelIdentity
  // don't carry one, Conversation is the denormalized clinic-scoping field
  // for exactly this reason) — this is the same identity boundary
  // ConversationService/InboxService already use throughout the messaging
  // domain, reused here rather than inventing a second one. The nested
  // `conversations` select below carries the identical `where: { clinicId }`
  // filter, so every conversation this method ever sees for a given contact
  // already belongs to this clinic — channels/first-interaction/
  // last-interaction below are computed only from those rows, never from
  // Contact.channelIdentities or Contact.patient directly (neither of which
  // is itself clinic-scoped, and a Patient/Contact can in principle — per
  // ADR-004 — be shared across more than one clinic's conversations).
  async listCustomersForClinic(clinicId: string): Promise<CustomerExportRow[]> {
    const contacts = await this.prisma.contact.findMany({
      where: { conversations: { some: { clinicId } } },
      select: {
        ...CUSTOMER_SELECT,
        conversations: { where: { clinicId }, select: CUSTOMER_SELECT.conversations.select },
      },
      take: MAX_EXPORT_ROWS,
    });

    // Sorted in application code (not via Prisma `orderBy`) because
    // "first interaction" is itself computed per-contact from the
    // clinic-scoped conversations above, not a single column to order by —
    // deterministic and stable regardless of the database's own row order.
    return contacts.map(toCustomerExportRow).sort((a, b) => a.firstInteraction.localeCompare(b.firstInteraction));
  }
}

function toCustomerExportRow(contact: CustomerContactRow): CustomerExportRow {
  // Guaranteed non-empty: listCustomersForClinic() only ever selects
  // contacts matched by `conversations: { some: { clinicId } }`, and the
  // conversations returned here carry that identical filter.
  const conversationTimes = contact.conversations.map((c) => c.createdAt.getTime());
  const lastActivityTimes = contact.conversations.map((c) => (c.lastMessageAt ?? c.createdAt).getTime());

  return {
    name: contact.patient?.displayName ?? contact.displayName ?? 'Unknown',
    phone: contact.patient?.verifiedPhone ?? null,
    email: contact.patient?.verifiedEmail ?? null,
    channels: [...new Set(contact.conversations.map((c) => c.channelKey))].sort(),
    firstInteraction: new Date(Math.min(...conversationTimes)).toISOString(),
    lastInteraction: new Date(Math.max(...lastActivityTimes)).toISOString(),
  };
}
