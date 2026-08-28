import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import { StaffStatus } from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import { InvalidCredentialsException, InvalidSessionException } from './auth.errors';
import type { AuthenticatedStaffContext, AuthenticatedStaffSummary } from './auth.types';

// Task 7-2 — the staff auth boundary. Everything that turns a
// password/cookie into a verified AuthenticatedStaffContext lives here,
// centralized per the task's own "session/token verification is
// centralized" requirement — SessionAuthGuard and AuthController are both
// thin callers of this service, never re-implementing verification
// themselves.
//
// JWT payload carries only { staffId } — deliberately not clinicId/role,
// even though both are known at sign time. verifySession() re-reads Staff
// fresh from the database on every request instead of trusting the token's
// claims, so a role change or an account being DISABLED takes effect on
// the very next request rather than only once the (up to
// SESSION_TTL_SECONDS-old) token expires. The extra query is the accepted
// cost of that property — see auth.module.ts for the session lifetime.
interface SessionTokenPayload {
  staffId: string;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
  ) {}

  async login(email: string, password: string): Promise<{ token: string; staff: AuthenticatedStaffSummary }> {
    // findFirst, not a unique lookup: Staff.email is unique per clinic
    // (@@unique([clinicId, email])), not globally — see
    // docs/architecture/05-implementation-roadmap.md OQ-5, "Current schema
    // assumes single Clinic operationally." Resolving login by email alone
    // is safe under that same documented, codebase-wide assumption (e.g.
    // WHATSAPP_CLINIC_ID/INSTAGRAM_CLINIC_ID in packages/config); revisit
    // this lookup (clinic selection at login) if/when OQ-5 is resolved in
    // favor of real multi-tenancy.
    const staff = await this.prisma.staff.findFirst({ where: { email, status: StaffStatus.ACTIVE } });
    if (!staff) throw new InvalidCredentialsException();

    const passwordValid = await argon2.verify(staff.passwordHash, password);
    if (!passwordValid) throw new InvalidCredentialsException();

    await this.prisma.staff.update({ where: { id: staff.id }, data: { lastLoginAt: new Date() } });

    const payload: SessionTokenPayload = { staffId: staff.id };
    const token = await this.jwtService.signAsync(payload);

    return {
      token,
      staff: { id: staff.id, name: staff.name, email: staff.email, role: staff.role, clinicId: staff.clinicId },
    };
  }

  // Task 7-3 — the staff portal needs to restore "who is logged in" after a
  // page reload (the JWT is httpOnly, so the frontend can never read it and
  // the login response body is the only other place identity has ever been
  // returned). SessionAuthGuard already proves the caller is `staffId`;
  // this just re-shapes the same Staff row login() already returns into
  // the same AuthenticatedStaffSummary, for a route the guard protects.
  async getStaffSummary(staffId: string): Promise<AuthenticatedStaffSummary> {
    const staff = await this.prisma.staff.findFirst({ where: { id: staffId, status: StaffStatus.ACTIVE } });
    if (!staff) throw new InvalidSessionException();
    return { id: staff.id, name: staff.name, email: staff.email, role: staff.role, clinicId: staff.clinicId };
  }

  async verifySession(token: string): Promise<AuthenticatedStaffContext> {
    let payload: SessionTokenPayload;
    try {
      payload = await this.jwtService.verifyAsync<SessionTokenPayload>(token);
    } catch {
      // Covers every jsonwebtoken failure mode (malformed, bad signature,
      // expired) with the one generic response — see auth.errors.ts.
      throw new InvalidSessionException();
    }

    const staff = await this.prisma.staff.findFirst({ where: { id: payload.staffId, status: StaffStatus.ACTIVE } });
    if (!staff) throw new InvalidSessionException();

    return { staffId: staff.id, clinicId: staff.clinicId, role: staff.role };
  }
}
