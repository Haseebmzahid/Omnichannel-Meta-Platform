// Task 7-2 — fixed auth implementation details shared across
// auth.module.ts (JWT sign options), auth.controller.ts (cookie
// set/clear), and session-auth.guard.ts (cookie read). Not environment
// variables: these are implementation choices, not deployment-varying
// config, per this task's "do not add unnecessary environment variables"
// instruction.

export const SESSION_COOKIE_NAME = 'clinic_session';

// One staff shift. No "remember me"/refresh-token option in this task —
// re-login once expired. Revisit only if a real clinic ops need for a
// longer or shorter session shows up later.
export const SESSION_TTL_SECONDS = 12 * 60 * 60;
