import type { Prisma } from '../generated/prisma/client';
import type { PrismaService } from '../prisma/prisma.service';

// Shared parameter type for messaging-core service methods that may run
// either directly against PrismaService or inside an existing
// $transaction callback (see message.service.ts's ingestInboundMessage,
// which composes IdentityResolutionService + ConversationService +
// its own message.create inside one transaction for atomicity).
export type Db = PrismaService | Prisma.TransactionClient;
