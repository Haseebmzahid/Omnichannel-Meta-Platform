import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import type { AuthenticatedStaffContext } from './auth.types';

// Task 7-2 — the one place a controller reads authenticated identity from.
// Populated by SessionAuthGuard (must run first, via @UseGuards on the same
// controller/route); never by a request body, query string, or path
// parameter — see inbox.controller.ts for what this replaces.
export const CurrentStaff = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthenticatedStaffContext => {
  const request = ctx.switchToHttp().getRequest<Request & { staff?: AuthenticatedStaffContext }>();
  if (!request.staff) {
    // A wiring bug (SessionAuthGuard missing from the route), not a
    // client-triggerable runtime condition — a request that reaches here
    // without req.staff set already failed the guard and never got this
    // far, so this only fires if the guard was forgotten entirely.
    throw new Error('CurrentStaff() used on a route without SessionAuthGuard applied.');
  }
  return request.staff;
});
