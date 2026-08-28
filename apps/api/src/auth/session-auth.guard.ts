import { CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { AuthService } from './auth.service';
import { InvalidSessionException } from './auth.errors';
import { SESSION_COOKIE_NAME } from './auth.constants';
import type { AuthenticatedStaffContext } from './auth.types';

// Applied per-controller via @UseGuards(SessionAuthGuard) (see
// inbox.controller.ts). Reads the session cookie, verifies it through
// AuthService (the one centralized place token verification happens — see
// that file's header comment), and attaches the resulting
// AuthenticatedStaffContext to the request for @CurrentStaff() to read.
// Missing/malformed/expired token, or a token for a staff member who no
// longer exists or is DISABLED, all reject the same way: a generic 401
// from AuthService.verifySession(), never a hint as to which.
@Injectable()
export class SessionAuthGuard implements CanActivate {
  constructor(private readonly authService: AuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request & { staff?: AuthenticatedStaffContext }>();
    const token = request.cookies?.[SESSION_COOKIE_NAME];
    if (!token || typeof token !== 'string') throw new InvalidSessionException();

    request.staff = await this.authService.verifySession(token);
    return true;
  }
}
