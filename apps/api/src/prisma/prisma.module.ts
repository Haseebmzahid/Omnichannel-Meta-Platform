import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';

/**
 * Global: PrismaService is a near-universal dependency — essentially every
 * future domain module (patients, appointments, conversations, knowledge
 * base, ...) will need it. This matches NestJS's own documented pattern for
 * exposing a database service app-wide rather than re-importing PrismaModule
 * into every feature module.
 */
@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
