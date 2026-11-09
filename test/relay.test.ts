import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { sign, verify } from '../src/signature.ts';
import { Store } from '../src/store.ts';
import { processDue, backoff, type WorkerOptions } from '../src/worker.ts';
import { createApp } from '../src/app.ts';

describe('signature', () => {
  const body = '{"id":"evt_1"}';
  it('verifies its own signature', () => assert.deepEqual(verify('s', body, sign('s', body)), { ok: true }));
  it('rejects a changed body', () => assert.equal(verify('s', body + ' ', sign('s', body)).ok, false));
  it('rejects the wrong secret', () => assert.equal(verify('x', body, sign('s', body)).ok, false));
  it('rejects old timestamps (replay protection)', () => {
    const old = sign('s', body, 1_000);
    assert.deepEqual(verify('s', body, old, { now: 2_000 }), { ok: false, reason: 'timestamp outside tolerance' });
  });
  it('rejects a malformed header', () => assert.equal(verify('s', body, 'garbage').ok, false));
});

describe('backoff', () => {
  it('doubles and caps', () => {
    const mid = () => 0.5; // no jitter
    assert.deepEqual([1, 2, 3, 4, 10].map((a) => backoff(a, 1000, 5000, mid)), [1000, 2000, 4000, 5000, 5000]);
  });
});

describe('worker', () => {
  const opts = (fetchImpl: typeof fetch): WorkerOptions => ({
    signingSecret: 'out', maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 10_000, timeoutMs: 1000, batchSize: 10, fetch: fetchImpl,
  });
  const reply = (status: number) => (async () => new Response(null, { status })) as unknown as typeof fetch;

  it('marks successful deliveries and signs outgoing requests', async () => {
    const store = new Store();
    store.enqueue('shop', 'e1', '{"a":1}', ['http://target/a'], 0);
    let seen: Headers | undefined;
    const fetchImpl = (async (_url: string, init: RequestInit) => { seen = new Headers(init.headers); return new Response(null, { status: 204 }); }) as unknown as typeof fetch;
    assert.deepEqual(await processDue(store, opts(fetchImpl), 0), { delivered: 1, failed: 0 });
    assert.equal(store.stats().delivered, 1);
    assert.equal(verify('out', '{"a":1}', seen?.get('x-signature') ?? undefined).ok, true);
    assert.equal(seen?.get('x-event-id'), 'e1');
  });

  it('retries 5xx with backoff, then gives up', async () => {
    const store = new Store();
    store.enqueue('shop', 'e2', '{}', ['http://target/b'], 0);
    await processDue(store, opts(reply(503)), 0);
    let d = store.list(null)[0];
    assert.equal(d.status, 'pending');
    assert.equal(d.attempts, 1);
    assert.ok(d.nextAttemptAt >= 800 && d.nextAttemptAt <= 1200);

    assert.deepEqual(await processDue(store, opts(reply(503)), 0), { delivered: 0, failed: 0 }); // not due yet
    await processDue(store, opts(reply(503)), 10_000);
    await processDue(store, opts(reply(503)), 100_000);
    d = store.list(null)[0];
    assert.equal(d.status, 'dead');
    assert.equal(d.attempts, 3);
    assert.equal(d.lastError, 'HTTP 503');
  });

  it('does not retry permanent 4xx errors', async () => {
    const store = new Store();
    store.enqueue('shop', 'e3', '{}', ['http://target/c'], 0);
    await processDue(store, opts(reply(422)), 0);
    assert.equal(store.list(null)[0].status, 'dead');
  });

  it('retries network errors and 429', async () => {
    const store = new Store();
    store.enqueue('shop', 'e4', '{}', ['http://t/1', 'http://t/2'], 0);
    const flaky = (async (url: string) => {
      if (url.endsWith('/1')) throw new Error('ECONNREFUSED');
      return new Response(null, { status: 429 });
    }) as unknown as typeof fetch;
    await processDue(store, opts(flaky), 0);
    assert.deepEqual(store.list(null).map((d) => d.status), ['pending', 'pending']);
  });
});

describe('HTTP API', () => {
  let server: Server;
  let base: string;
  let store: Store;
  const ADMIN = 'admin-token';

  beforeEach(() => { store.db.exec('DELETE FROM deliveries'); });
  before(async () => {
    store = new Store();
    server = createServer(createApp(store, {
      adminToken: ADMIN,
      sources: { shop: { secret: 'shop-secret', targets: ['http://erp/hooks', 'http://crm/hooks'] } },
      maxBodyBytes: 1000,
    }));
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => server.close());

  const deliver = (body: string, signature = sign('shop-secret', body), source = 'shop') =>
    fetch(`${base}/hooks/${source}`, { method: 'POST', headers: { 'X-Signature': signature, 'Content-Type': 'application/json' }, body });

  it('accepts a signed event and fans it out to every target', async () => {
    const res = await deliver('{"id":"ord_1","type":"order.created"}');
    assert.equal(res.status, 202);
    assert.deepEqual(await res.json(), { eventId: 'ord_1', queued: 2, duplicate: false });
  });

  it('de-duplicates repeated events', async () => {
    await deliver('{"id":"ord_2"}');
    const body = await (await deliver('{"id":"ord_2"}')).json();
    assert.equal(body.duplicate, true);
    assert.equal(store.stats().pending, 2);
  });

  it('rejects bad signatures, unknown sources and large bodies', async () => {
    assert.equal((await deliver('{"id":1}', sign('wrong', '{"id":1}'))).status, 401);
    assert.equal((await deliver('{"id":1}', undefined, 'nope')).status, 404);
    const big = JSON.stringify({ id: 'x', pad: 'a'.repeat(2000) });
    assert.equal((await deliver(big)).status, 413);
  });

  it('protects the admin API and replays dead deliveries', async () => {
    await deliver('{"id":"ord_3"}');
    const [d] = store.list(null);
    store.markFailed(d.id, 'HTTP 500', null);

    assert.equal((await fetch(`${base}/deliveries?status=dead`)).status, 401);
    const auth = { headers: { Authorization: `Bearer ${ADMIN}` } };
    const dead = await (await fetch(`${base}/deliveries?status=dead`, auth)).json();
    assert.equal(dead.length, 1);

    const replay = await fetch(`${base}/deliveries/${d.id}/replay`, { method: 'POST', ...auth });
    assert.equal(replay.status, 200);
    assert.equal(store.get(d.id)?.status, 'pending');
    assert.equal((await fetch(`${base}/deliveries/${d.id}/replay`, { method: 'POST', ...auth })).status, 409);
    assert.deepEqual(await (await fetch(`${base}/stats`, auth)).json(), { pending: 2, delivered: 0, dead: 0 });
  });
});
