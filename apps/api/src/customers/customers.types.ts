import type { ChannelKey } from '../generated/prisma/enums';

// The staff-facing customer-export projection — deliberately narrow, per
// this feature's own "export known customer information only" scope.
// Never id/clinicId/patientId/contactId or anything else Prisma-internal:
// a name, the two verified contact channels a clinic would actually use to
// reach someone (phone/email — never a raw channel-native identifier like a
// wa_id/PSID/IGSID, which is not necessarily a real phone/email), which
// messaging channels this clinic has exchanged messages with them on, and
// when that relationship started/was last active.
export interface CustomerExportRow {
  name: string;
  phone: string | null;
  email: string | null;
  channels: ChannelKey[];
  firstInteraction: string;
  lastInteraction: string;
}
