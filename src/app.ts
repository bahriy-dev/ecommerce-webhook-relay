import type { IncomingMessage, ServerResponse } from 'node:http';
import { timingSafeEqual, createHash } from 'node:crypto';
import { verify } from './signature.ts';
import type { Store, DeliveryStatus } from './store.ts';

export interface SourceConfig {
  /** Shared secret the sender signs its webhooks with. */
  secret: string;
  /** URLs every event from this source is forwarded to. */
  targets: string[];
}

export interface AppConfig {
  sources: Record<string, SourceConfig>;
  adminToken: string;
  maxBodyBytes?: number;
}

export function createApp(store: Store, config: AppConfig) {
  const maxBody = config.maxBodyBytes ?? 1024 * 1024;

  return async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const [first, second, third] = url.pathname.split('/').filter(Boolean);

    try {
      if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { status: 'ok' });

      // ---------- Inbound webhooks ----------
      if (req.method === 'POST' && first === 'hooks' && second && !third) {
        const source = config.sources[second];
        if (!source) return send(res, 404, { error: 'Unknown source' });

        const raw = await readRaw(req, maxBody);
        const check = verify(source.secret, raw, header(req, 'x-signature'));
        if (!check.ok) return send(res, 401, { error: `Invalid signature: ${check.reason}` });

        let payload: unknown;
        try { payload = JSON.parse(raw); } catch { return send(res, 400, { error: 'Body must be JSON' }); }

        // Prefer the sender's event id for de-duplication, fall back to a hash of the body.
        const bodyId = (payload as { id?: unknown })?.id;
        const eventId = header(req, 'x-event-id') ?? (typeof bodyId === 'string' || typeof bodyId === 'number' ? String(bodyId) : null)
          ?? createHash('sha256').update(raw).digest('hex');

        const queued = store.enqueue(second, eventId, raw, source.targets);
        // Senders retry on non-2xx, so a duplicate is still a success for them.
        return send(res, 202, { eventId, queued, duplicate: queued === 0 });
      }

      // ---------- Admin API ----------
      if (first === 'deliveries' || first === 'stats') {
        if (!isAdmin(req, config.adminToken)) return send(res, 401, { error: 'Admin token required' });

        if (req.method === 'GET' && first === 'stats' && !second) return send(res, 200, store.stats());
        if (req.method === 'GET' && !second) {
          const status = url.searchParams.get('status') as DeliveryStatus | null;
          if (status && !['pending', 'delivered', 'dead'].includes(status)) return send(res, 400, { error: 'Invalid status' });
          const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 50));
          return send(res, 200, store.list(status, limit));
        }
        if (req.method === 'GET' && second && !third) {
          const d = store.get(Number(second));
          return d ? send(res, 200, d) : send(res, 404, { error: 'Delivery not found' });
        }
        if (req.method === 'POST' && second && third === 'replay') {
          return store.replay(Number(second))
            ? send(res, 200, { replayed: true })
            : send(res, 409, { error: 'Only dead deliveries can be replayed' });
        }
      }

      return send(res, 404, { error: 'Not found' });
    } catch (err) {
      if (err instanceof PayloadTooLarge) return send(res, 413, { error: 'Body too large' });
      console.error(err);
      return send(res, 500, { error: 'Internal server error' });
    }
  };
}

class PayloadTooLarge extends Error {}

async function readRaw(req: IncomingMessage, max: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max) throw new PayloadTooLarge();
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

function isAdmin(req: IncomingMessage, token: string): boolean {
  const given = Buffer.from(/^Bearer (.+)$/.exec(header(req, 'authorization') ?? '')?.[1] ?? '');
  const expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}
