import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { config } from '../config';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { SessionAuthGuard } from './session-auth.guard';
import { SESSION_TTL_SECONDS } from './auth.constants';

// Task 7-2 — dev-only fallback secret. packages/config's production
// superRefine check means the app cannot even boot in production without
// AUTH_JWT_SECRET set, so this fallback is dead code there; in
// development/test it lets the app and its test suite run without
// per-developer secret setup, exactly like DATABASE_URL's dev-fallback in
// packages/config. Not a real credential.
const DEV_FALLBACK_JWT_SECRET = 'dev-only-insecure-jwt-signing-secret-do-not-use-in-production';

@Module({
  imports: [
    JwtModule.register({
      secret: config.AUTH_JWT_SECRET ?? DEV_FALLBACK_JWT_SECRET,
      signOptions: { expiresIn: SESSION_TTL_SECONDS },
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, SessionAuthGuard],
  // Both exported, not just SessionAuthGuard: @UseGuards(SessionAuthGuard)
  // in an importing module (e.g. InboxModule) resolves the guard class by
  // reference within that module's own DI scope, which also needs
  // SessionAuthGuard's own constructor dependency (AuthService) to be
  // visible there — exporting the guard alone is not enough.
  exports: [AuthService, SessionAuthGuard],
})
export class AuthModule {}
