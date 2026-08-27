import 'reflect-metadata';
import { WhatsAppSendService } from '../src/channels/whatsapp/whatsapp-send.service';
import { config } from '../src/config';

// Manual-only WhatsApp Cloud API outbound live smoke test — NOT part of the
// automated test suite. vitest.config.mts only picks up
// `test/**/*.e2e-spec.ts` and `src/**/*.spec.ts`; this file matches
// neither, and nothing in `pnpm typecheck`/`pnpm build`/`pnpm test`
// executes it. Run it explicitly once real WhatsApp credentials are
// available, per Task's "do NOT automatically make a real Meta request
// unless ... you explicitly create an isolated manual command":
//
//   pnpm --filter @clinic/api smoke:whatsapp -- <recipient_wa_id> ["message text"]
//
// The recipient is always a required CLI argument, never hardcoded — this
// script cannot accidentally message anyone without the caller explicitly
// naming a number. Exercises only WhatsAppSendService (the real Meta HTTP
// call) — no Prisma, no Messaging Core persistence — since the point of
// this script is verifying Meta connectivity/credentials, not re-testing
// the full outbound pipeline (already covered by
// whatsapp-outbound.service.spec.ts with a fake WhatsAppSendService).
//
// Safety: never logs, prints, or hardcodes WHATSAPP_ACCESS_TOKEN — only
// checks whether it is set. That check runs first, before any network
// access.

async function main(): Promise<void> {
  if (!config.WHATSAPP_ACCESS_TOKEN || !config.WHATSAPP_PHONE_NUMBER_ID) {
    console.log('WHATSAPP_ACCESS_TOKEN / WHATSAPP_PHONE_NUMBER_ID are not configured. Smoke test skipped.');
    return;
  }

  const [to, ...textParts] = process.argv.slice(2);
  if (!to) {
    console.error('Usage: pnpm --filter @clinic/api smoke:whatsapp -- <recipient_wa_id> ["message text"]');
    process.exitCode = 1;
    return;
  }
  const text = textParts.join(' ') || 'This is a WhatsApp Cloud API outbound smoke test.';

  const sendService = new WhatsAppSendService(config.WHATSAPP_ACCESS_TOKEN, config.WHATSAPP_PHONE_NUMBER_ID, config.WHATSAPP_API_VERSION);

  console.log('--- WhatsApp outbound smoke test ---');
  console.log('API version:', config.WHATSAPP_API_VERSION);
  console.log('Sending to:', to);
  console.log('Text:', text);

  try {
    const result = await sendService.sendText(to, text);
    console.log('\nSent. Meta message id:', result.externalMessageId);
  } catch (err) {
    // WhatsAppSendService already translates every failure into a safe,
    // typed WhatsAppSendException with no raw Meta payload or credential —
    // this catch is a defensive top-level guard, not a second sanitization
    // layer that assumes the first one failed.
    console.error('Smoke test failed:', err instanceof Error ? err.message : 'Unknown error');
    process.exitCode = 1;
  }
}

main();
