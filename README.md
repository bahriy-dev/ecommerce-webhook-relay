# webhook-relay

[![CI](https://github.com/bahriy-dev/webhook-relay/actions/workflows/ci.yml/badge.svg)](https://github.com/bahriy-dev/webhook-relay/actions/workflows/ci.yml)
![Node](https://img.shields.io/badge/node-%E2%89%A522.18-339933?logo=nodedotjs&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)
![SQLite](https://img.shields.io/badge/SQLite-outbox-003B57?logo=sqlite&logoColor=white)
![Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A small, reliable **webhook relay** for e-commerce integrations. Your store (or payment
provider, or marketplace) sends `order.created`, `order.paid`, `stock.updated` … to one URL; the
relay verifies the signature, stores the event, and delivers it to every system that needs it
(ERP, CRM, accounting, warehouse) with retries until each one confirms.

```
 shop ──signed POST──▶ webhook-relay ──▶ ERP        (retries with backoff)
                          │  SQLite   ──▶ CRM        (dead-letter after N attempts)
                          └─ outbox   ──▶ accounting (manual replay via admin API)
```

## Why

Calling five systems directly from a checkout request is fragile: one slow or broken target
breaks the order flow, and a lost webhook means a missing invoice. The relay answers the sender
in milliseconds with `202 Accepted` and takes over delivery.

- **Authenticity.** Inbound `X-Signature: t=…,v1=…` (HMAC-SHA256 over timestamp + raw body),
  constant-time compare, 5-minute replay window. Outbound requests are signed the same way.
- **Exactly-once queueing.** Events are de-duplicated per source by `X-Event-Id`, the body's
  `id`, or a hash of the body. Sender retries never create duplicate deliveries.
- **Durable outbox.** Every (event, target) pair is a SQLite row, so a restart loses nothing.
- **Smart retries.** Exponential backoff with jitter; network errors, `5xx`, `408` and `429` are
  retried, other `4xx` go straight to the dead-letter queue.
- **Event routing.** Each target can subscribe to specific event types (`order.paid`, `stock.*`),
  so the warehouse only gets stock events and accounting only gets payments.
- **Operations.** Admin API to list deliveries, inspect errors, replay dead ones and see stats.

## Quick start

```bash
git clone https://github.com/bahriy-dev/webhook-relay.git
cd webhook-relay
cp sources.example.json sources.json      # set your secrets and target URLs
ADMIN_TOKEN=change-me SIGNING_SECRET=change-me-too npm start
npm test                                  # 20 tests
```

Send a test event:

```bash
BODY='{"id":"ord_1001","type":"order.created","total":249900}'
TS=$(date +%s)
SIG=$(printf '%s' "$TS.$BODY" | openssl dgst -sha256 -hmac "$SHOP_SECRET" -hex | cut -d' ' -f2)
curl -X POST localhost:3000/hooks/shop -H "X-Signature: t=$TS,v1=$SIG" -d "$BODY"
# {"eventId":"ord_1001","eventType":"order.created","targets":1,"queued":1,"duplicate":false}
```

## Routing events to targets

`sources.json` lists where each source's events go. A plain URL receives everything; an object
with `events` receives only matching types. Patterns are exact (`order.paid`) or a prefix
(`stock.*`); `*` matches all.

```json
{
  "shop": {
    "secret": "…",
    "targets": [
      "https://erp.example.com/webhooks/orders",
      { "url": "https://wms.example.com/hooks", "events": ["order.paid", "order.cancelled", "stock.*"] },
      { "url": "https://accounting.example.com/hooks", "events": ["order.paid", "refund.*"] }
    ]
  }
}
```

The event type comes from the `X-Event-Type` header, or the payload's `type` / `event` field.
Events without a type only go to unfiltered targets.

## API

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| `POST` | `/hooks/:source` | signature | Receive an event from a configured source |
| `GET` | `/deliveries?status=dead&limit=50` | admin | List deliveries (`pending`, `delivered`, `dead`) |
| `GET` | `/deliveries/:id` | admin | One delivery with attempts and last error |
| `POST` | `/deliveries/:id/replay` | admin | Put a dead delivery back in the queue |
| `GET` | `/stats` | admin | Counts per status |
| `GET` | `/health` | — | Health check |

Admin routes need `Authorization: Bearer $ADMIN_TOKEN`.

Every outgoing request carries `X-Event-Id`, `X-Event-Source`, `X-Delivery-Attempt` and
`X-Signature`, so targets can verify the relay and de-duplicate on their side too.

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `ADMIN_TOKEN` | — | **Required.** Bearer token for the admin API |
| `SIGNING_SECRET` | — | **Required.** Secret used to sign outgoing requests |
| `SOURCES_FILE` | `sources.json` | Sources, their secrets and target URLs |
| `DATABASE_PATH` | `relay.db` | SQLite outbox |
| `MAX_ATTEMPTS` | `8` | Attempts before a delivery is dead |
| `BASE_DELAY_MS` / `MAX_DELAY_MS` | `5000` / `3600000` | Backoff start and cap |
| `TIMEOUT_MS` | `10000` | Per-request timeout |
| `BATCH_SIZE` / `POLL_INTERVAL_MS` | `20` / `1000` | Worker throughput |

## Project layout

```
src/
  signature.ts   HMAC signing and verification with replay protection
  routing.ts     per-target event filters (order.paid, stock.*)
  store.ts       SQLite outbox: enqueue, due, mark delivered/failed, replay, stats
  worker.ts      delivery loop, retry classification, exponential backoff
  app.ts         inbound webhook endpoint and admin API
  server.ts      config, polling worker, graceful shutdown
test/            node:test: signatures, backoff, worker with fake fetch, HTTP API
```

## License

MIT © [Bahri YILMAZ](https://bahriyilmaz.dev)
