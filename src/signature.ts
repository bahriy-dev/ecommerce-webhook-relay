import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Signature format (same idea as Stripe / GitHub webhooks):
 *   X-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">
 * Signing the timestamp together with the body blocks replay attacks.
 */
export function sign(secret: string, body: string, timestamp = Math.floor(Date.now() / 1000)): string {
  const mac = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return `t=${timestamp},v1=${mac}`;
}

export type VerifyResult = { ok: true } | { ok: false; reason: string };

export function verify(
  secret: string,
  body: string,
  header: string | undefined,
  { toleranceSeconds = 300, now = Math.floor(Date.now() / 1000) } = {},
): VerifyResult {
  if (!header) return { ok: false, reason: 'missing signature header' };
  const parts = Object.fromEntries(header.split(',').map((p) => p.trim().split('=') as [string, string]));
  const t = Number(parts.t);
  if (!Number.isInteger(t) || !parts.v1) return { ok: false, reason: 'malformed signature header' };
  if (Math.abs(now - t) > toleranceSeconds) return { ok: false, reason: 'timestamp outside tolerance' };

  const expected = createHmac('sha256', secret).update(`${t}.${body}`).digest();
  const given = Buffer.from(parts.v1, 'hex');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return { ok: false, reason: 'signature mismatch' };
  }
  return { ok: true };
}
