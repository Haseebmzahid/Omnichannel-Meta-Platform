import { Injectable } from '@nestjs/common';

// Resolves a WhatsApp webhook's phone_number_id (channelAccountRef) to the
// clinicId NormalizedInboundMessage requires — never trusting a clinicId
// supplied by the request itself (Part 7 instruction).
//
// Config-based, not a database lookup: the current schema is deliberately
// single-clinic (docs/architecture/05-implementation-roadmap.md OQ-5 —
// "Current schema assumes single Clinic operationally; multi-tenant is
// explicitly deferred, not designed against"), so there is exactly one
// phone-number-to-clinic mapping to resolve, already available from
// validated config (WHATSAPP_PHONE_NUMBER_ID / WHATSAPP_CLINIC_ID — see
// packages/config/src/index.ts). This deliberately does NOT add a
// Meta-account-to-clinic Prisma table: that is a real schema addition and,
// per this task's boundary instruction, is left for whenever OQ-5 is
// resolved in favor of multi-clinic — inventing it now would be exactly
// the kind of production data model this task is required to stop short of.
//
// Returns null (rather than throwing) for an unrecognized phone_number_id
// so the caller can log and skip that one webhook event safely, the same
// "don't crash, don't create a malformed row" treatment as an unsupported
// message type (Part 5) — a misrouted or not-yet-configured account is not
// grounds to fail the whole request once the signature has already been
// verified authentic.
@Injectable()
export class WhatsAppAccountResolverService {
  constructor(
    private readonly configuredPhoneNumberId: string | undefined,
    private readonly configuredClinicId: string | undefined,
  ) {}

  resolveClinicId(phoneNumberId: string): string | null {
    if (!this.configuredPhoneNumberId || !this.configuredClinicId) return null;
    if (phoneNumberId !== this.configuredPhoneNumberId) return null;
    return this.configuredClinicId;
  }
}
