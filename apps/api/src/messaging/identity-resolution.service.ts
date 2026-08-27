import { Injectable } from '@nestjs/common';
import type { Contact } from '../generated/prisma/client';
import type { ChannelKey } from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import type { Db } from './messaging.db';

// Messaging core — contact + channel identity resolution.
//
// Implements exactly the flow documented in ADR-004 / 03-conversation-and-inbox.md
// §4 for an *inbound message's sender*, and nothing more:
//
//   find ChannelIdentity by (channelKey, channelAccountRef, externalContactId)
//     -> found: reuse its Contact (and Patient link, if any) as-is
//     -> not found: create a new, unresolved Contact (patientId stays null)
//                   + its ChannelIdentity row
//
// This is deliberately NOT "patient identity linking" — it never touches
// Patient, never sets linkState/linkMethod/linkConfidence, and never
// merges anything. ADR-004's automatic-linking rules (verified phone,
// appointment reference code) govern a completely different operation —
// promoting an existing Contact to a Patient — which this service does not
// perform. A brand-new sender always gets a brand-new, unresolved Contact;
// an already-seen one is reused exactly as already linked (or not).
export interface ResolveContactInput {
  channelKey: ChannelKey;
  channelAccountRef: string;
  externalContactId: string;
  displayNameAtChannel?: string;
}

export interface ResolveContactResult {
  contact: Contact;
  isNewContact: boolean;
}

@Injectable()
export class IdentityResolutionService {
  constructor(private readonly prisma: PrismaService) {}

  async resolveContact(input: ResolveContactInput, client: Db = this.prisma): Promise<ResolveContactResult> {
    const existing = await client.channelIdentity.findUnique({
      where: {
        channelKey_channelAccountRef_externalId: {
          channelKey: input.channelKey,
          channelAccountRef: input.channelAccountRef,
          externalId: input.externalContactId,
        },
      },
      include: { contact: true },
    });

    if (existing) {
      return { contact: existing.contact, isNewContact: false };
    }

    const contact = await client.contact.create({
      data: { displayName: input.displayNameAtChannel },
    });

    await client.channelIdentity.create({
      data: {
        contactId: contact.id,
        channelKey: input.channelKey,
        channelAccountRef: input.channelAccountRef,
        externalId: input.externalContactId,
        displayNameAtChannel: input.displayNameAtChannel,
        // linkState defaults to UNLINKED; linkMethod/linkConfidence/
        // linkedByStaffId/linkedAt stay null — this is not a link event.
      },
    });

    return { contact, isNewContact: true };
  }
}
