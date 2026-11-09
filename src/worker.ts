import { sign } from './signature.ts';
import type { Store } from './store.ts';

export interface WorkerOptions {
  /** Secret used to sign outgoing requests so targets can verify them. */
  signingSecret: string;
  maxAttempts: number;
  /** First retry delay; doubles every attempt (with ±20% jitter), capped at maxDelayMs. */
  baseDelayMs: number;
  maxDelayMs: number;
  timeoutMs: number;
  batchSize: number;
  fetch?: typeof fetch;
}

export function backoff(attempt: number, baseMs: number, maxMs: number, random = Math.random): number {
  const exp = Math.min(maxMs, baseMs * 2 ** (attempt - 1));
  return Math.round(exp * (0.8 + random() * 0.4));
}

/** Delivers due rows once. Call it on an interval (see server.ts) or directly in tests. */
export async function processDue(store: Store, opts: WorkerOptions, now = Date.now()): Promise<{ delivered: number; failed: number }> {
  const doFetch = opts.fetch ?? fetch;
  const due = store.due(opts.batchSize, now);
  let delivered = 0;
  let failed = 0;

  await Promise.all(
    due.map(async (d) => {
      try {
        const res = await doFetch(d.target, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Event-Id': d.eventId,
            'X-Event-Source': d.source,
            'X-Delivery-Attempt': String(d.attempts + 1),
            'X-Signature': sign(opts.signingSecret, d.payload),
          },
          body: d.payload,
          signal: AbortSignal.timeout(opts.timeoutMs),
        });
        if (res.ok) {
          store.markDelivered(d.id);
          delivered++;
          return;
        }
        // 4xx (except 408/429) means the target rejected the event: retrying won't help.
        const permanent = res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429;
        fail(d.id, d.attempts + 1, `HTTP ${res.status}`, permanent);
      } catch (err) {
        fail(d.id, d.attempts + 1, err instanceof Error ? err.message : String(err), false);
      }
      failed++;
    }),
  );
  return { delivered, failed };

  function fail(id: number, attempt: number, error: string, permanent: boolean) {
    const giveUp = permanent || attempt >= opts.maxAttempts;
    store.markFailed(id, error, giveUp ? null : now + backoff(attempt, opts.baseDelayMs, opts.maxDelayMs));
  }
}
