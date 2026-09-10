import { Injectable } from '@nestjs/common';

// Resolves an Instagram webhook's recipient.id (the Instagram professional
// account id, this channel's channelAccountRef) to the clinicId
// NormalizedInboundMessage requires — never trusting a clinicId supplied by
// the request itself. Mirrors
// ../whatsapp/whatsapp-account-resolver.service.ts exactly.
//
// Config-based, not a database lookup: the current schema is deliberately
// single-clinic (roadmap OQ-5), so there is exactly one Instagram-account-
// to-clinic mapping to resolve, already available from validated config
// (INSTAGRAM_ACCOUNT_ID / INSTAGRAM_CLINIC_ID — see packages/config/src/
// index.ts). This deliberately does NOT add a Meta-account-to-clinic Prisma
// table — that is a real schema addition, left for whenever OQ-5 is
// resolved in favor of multi-clinic.
//
// Returns null (rather than throwing) for an unrecognized account id so the
// caller can log and skip that one webhook event safely — a misrouted or
// not-yet-configured account is not grounds to fail the whole request once
// the signature has already been verified authentic.
@Injectable()
export class InstagramAccountResolverService {
  constructor(
    private readonly accountIdSource: string | undefined | (() => string | undefined),
    private readonly configuredClinicId: string | undefined,
  ) {}

  private getAccountId(): string | undefined {
    return typeof this.accountIdSource === 'function' ? this.accountIdSource() : this.accountIdSource;
  }

  resolveClinicId(accountId: string): string | null {
    const configuredAccountId = this.getAccountId();
    if (!configuredAccountId || !this.configuredClinicId) return null;
    if (accountId !== configuredAccountId) return null;
    return this.configuredClinicId;
  }
}
