import { DatabaseSync } from 'node:sqlite';

export type DeliveryStatus = 'pending' | 'delivered' | 'dead';

export interface Delivery {
  id: number;
  eventId: string;
  source: string;
  target: string;
  payload: string;
  status: DeliveryStatus;
  attempts: number;
  nextAttemptAt: number;
  lastError: string | null;
  createdAt: number;
}

const COLUMNS = `id, event_id AS eventId, source, target, payload, status, attempts,
  next_attempt_at AS nextAttemptAt, last_error AS lastError, created_at AS createdAt`;

/** Durable outbox: every (event, target) pair is one row that survives restarts. */
export class Store {
  readonly db: DatabaseSync;

  constructor(path = ':memory:') {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS deliveries (
        id              INTEGER PRIMARY KEY,
        event_id        TEXT NOT NULL,
        source          TEXT NOT NULL,
        target          TEXT NOT NULL,
        payload         TEXT NOT NULL,
        status          TEXT NOT NULL DEFAULT 'pending',
        attempts        INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL,
        last_error      TEXT,
        created_at      INTEGER NOT NULL,
        UNIQUE (source, event_id, target)
      );
      CREATE INDEX IF NOT EXISTS deliveries_due ON deliveries (status, next_attempt_at);
    `);
  }

  /** Returns how many new deliveries were queued; 0 means the event was a duplicate. */
  enqueue(source: string, eventId: string, payload: string, targets: string[], now = Date.now()): number {
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO deliveries (event_id, source, target, payload, next_attempt_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    let queued = 0;
    for (const target of targets) queued += Number(insert.run(eventId, source, target, payload, now, now).changes);
    return queued;
  }

  due(limit: number, now = Date.now()): Delivery[] {
    return this.db
      .prepare(`SELECT ${COLUMNS} FROM deliveries WHERE status = 'pending' AND next_attempt_at <= ? ORDER BY next_attempt_at LIMIT ?`)
      .all(now, limit) as unknown as Delivery[];
  }

  markDelivered(id: number): void {
    this.db.prepare("UPDATE deliveries SET status = 'delivered', attempts = attempts + 1, last_error = NULL WHERE id = ?").run(id);
  }

  markFailed(id: number, error: string, nextAttemptAt: number | null): void {
    this.db
      .prepare(`UPDATE deliveries SET attempts = attempts + 1, last_error = ?,
                status = CASE WHEN ? IS NULL THEN 'dead' ELSE 'pending' END,
                next_attempt_at = COALESCE(?, next_attempt_at) WHERE id = ?`)
      .run(error.slice(0, 500), nextAttemptAt, nextAttemptAt, id);
  }

  get(id: number): Delivery | undefined {
    return this.db.prepare(`SELECT ${COLUMNS} FROM deliveries WHERE id = ?`).get(id) as unknown as Delivery | undefined;
  }

  list(status: DeliveryStatus | null, limit = 50): Delivery[] {
    const where = status ? 'WHERE status = ?' : '';
    const args = status ? [status, limit] : [limit];
    return this.db.prepare(`SELECT ${COLUMNS} FROM deliveries ${where} ORDER BY id DESC LIMIT ?`).all(...args) as unknown as Delivery[];
  }

  /** Puts a dead delivery back in the queue (manual replay). */
  replay(id: number, now = Date.now()): boolean {
    const { changes } = this.db
      .prepare("UPDATE deliveries SET status = 'pending', attempts = 0, next_attempt_at = ?, last_error = NULL WHERE id = ? AND status = 'dead'")
      .run(now, id);
    return Number(changes) > 0;
  }

  stats(): Record<DeliveryStatus, number> {
    const rows = this.db.prepare('SELECT status, COUNT(*) AS n FROM deliveries GROUP BY status').all() as { status: DeliveryStatus; n: number }[];
    return { pending: 0, delivered: 0, dead: 0, ...Object.fromEntries(rows.map((r) => [r.status, r.n])) };
  }
}
