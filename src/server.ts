import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { createApp, type AppConfig } from './app.ts';
import { Store } from './store.ts';
import { processDue } from './worker.ts';

const env = process.env;
const required = (name: string) => {
  const v = env[name];
  if (!v) { console.error(`${name} is required`); process.exit(1); }
  return v;
};

// SOURCES_FILE points to JSON like: { "shop": { "secret": "…", "targets": ["https://erp.example.com/hooks"] } }
const sources = JSON.parse(readFileSync(env.SOURCES_FILE ?? 'sources.json', 'utf8')) as AppConfig['sources'];
const store = new Store(env.DATABASE_PATH ?? 'relay.db');

const handler = createApp(store, { sources, adminToken: required('ADMIN_TOKEN') });
const workerOptions = {
  signingSecret: required('SIGNING_SECRET'),
  maxAttempts: Number(env.MAX_ATTEMPTS ?? 8),
  baseDelayMs: Number(env.BASE_DELAY_MS ?? 5_000),
  maxDelayMs: Number(env.MAX_DELAY_MS ?? 60 * 60 * 1000),
  timeoutMs: Number(env.TIMEOUT_MS ?? 10_000),
  batchSize: Number(env.BATCH_SIZE ?? 20),
};

let running = false;
const timer = setInterval(async () => {
  if (running) return;
  running = true;
  try {
    const r = await processDue(store, workerOptions);
    if (r.delivered || r.failed) console.log(`delivered=${r.delivered} failed=${r.failed}`);
  } finally {
    running = false;
  }
}, Number(env.POLL_INTERVAL_MS ?? 1000));

const port = Number(env.PORT ?? 3000);
const server = createServer(handler).listen(port, () => {
  console.log(`webhook-relay listening on :${port} for sources: ${Object.keys(sources).join(', ')}`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    clearInterval(timer);
    server.close(() => { store.db.close(); process.exit(0); });
  });
}
