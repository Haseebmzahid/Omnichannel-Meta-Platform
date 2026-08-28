import { Injectable } from '@nestjs/common';

// Resolves a Messenger webhook's recipient.id (the Facebook Page id, this
// channel's channelAccountRef) to the clinicId NormalizedInboundMessage
// requires — never trusting a clinicId supplied by the request itself.
// Mirrors ../whatsapp/whatsapp-account-resolver.service.ts and
// ../instagram/instagram-account-resolver.service.ts exactly.
//
// Config-based, not a database lookup: the current schema is deliberately
// single-clinic (roadmap OQ-5), so there is exactly one Page-to-clinic
// mapping to resolve, already available from validated config
// (MESSENGER_PAGE_ID / MESSENGER_CLINIC_ID — see packages/config/src/
// index.ts). This deliberately does NOT add a Meta-account-to-clinic Prisma
// table — that is a real schema addition, left for whenever OQ-5 is
// resolved in favor of multi-clinic, not invented here.
//
// Returns null (rather than throwing) for an unrecognized Page id so the
// caller can log and skip that one webhook event safely — a misrouted or
// not-yet-configured Page is not grounds to fail the whole request once the
// signature has already been verified authentic.
@Injectable()
export class MessengerAccountResolverService {
  constructor(
    private readonly configuredPageId: string | undefined,
    private readonly configuredClinicId: string | undefined,
  ) {}

  resolveClinicId(pageId: string): string | null {
    if (!this.configuredPageId || !this.configuredClinicId) return null;
    if (pageId !== this.configuredPageId) return null;
    return this.configuredClinicId;
  }
}
