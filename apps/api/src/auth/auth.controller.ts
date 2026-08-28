import { Body, Controller, Get, HttpCode, HttpStatus, Post, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { config } from '../config';
import { parseOrBadRequest } from '../common/parse-or-bad-request';
import { CurrentStaff } from './current-staff.decorator';
import { SessionAuthGuard } from './session-auth.guard';
import { AuthService } from './auth.service';
import { SESSION_COOKIE_NAME, SESSION_TTL_SECONDS } from './auth.constants';
import type { AuthenticatedStaffContext, AuthenticatedStaffSummary } from './auth.types';

// Task 7-2 — the only unauthenticated-by-design routes in the staff
// portal's API surface. Sets/clears the httpOnly session cookie directly
// (no @UseGuards(SessionAuthGuard) here — logging in is how a session is
// created in the first place).
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(@Body() body: unknown, @Res({ passthrough: true }) res: Response): Promise<AuthenticatedStaffSummary> {
    const parsed = parseOrBadRequest(loginBodySchema, body, 'body');
    const { token, staff } = await this.authService.login(parsed.email, parsed.password);

    // httpOnly: never readable from client-side JS (XSS-token-theft
    // mitigation, docs/security/security-requirements.md §1's "never
    // shipped to frontend code" principle applied to the session token
    // itself, not just API keys). secure only in production so local
    // dev over plain http still works. sameSite: 'lax' — the staff portal
    // is same-site self-use, not embedded/cross-site.
    res.cookie(SESSION_COOKIE_NAME, token, {
      httpOnly: true,
      secure: config.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: SESSION_TTL_SECONDS * 1000,
      path: '/',
    });

    // The token itself is never in this response body — only in the
    // httpOnly cookie set above.
    return staff;
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  logout(@Res({ passthrough: true }) res: Response): void {
    res.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
  }

  // Task 7-3 — lets the staff portal restore identity (name/email/role/
  // clinicId for the top bar and role-gated UI) after a page reload,
  // without ever being able to read the httpOnly session cookie itself.
  // Guarded exactly like every inbox route: a missing/invalid/expired
  // session gets the same generic 401 SessionAuthGuard already produces.
  @Get('me')
  @UseGuards(SessionAuthGuard)
  async me(@CurrentStaff() staff: AuthenticatedStaffContext): Promise<AuthenticatedStaffSummary> {
    return this.authService.getStaffSummary(staff.staffId);
  }
}

const loginBodySchema = z.object({
  email: z.string().trim().email(),
  password: z.string().min(1),
});
