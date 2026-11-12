/**
 * Per-target event routing.
 *
 * A target is either a URL (receives every event) or an object with an `events` filter:
 *   { "url": "https://wms.example.com/hooks", "events": ["order.paid", "stock.*"] }
 *
 * Patterns are exact event types or a prefix ending in ".*". A lone "*" matches everything.
 * An empty list (`"events": []`) subscribes to nothing, which pauses a target without removing it.
 */
export type TargetConfig = string | { url: string; events?: string[] };

export function matchesEvent(pattern: string, eventType: string): boolean {
  if (pattern === '*') return true;
  if (pattern.endsWith('.*')) return eventType.startsWith(pattern.slice(0, -1));
  return pattern === eventType;
}

/**
 * Returns the URLs that should receive an event.
 * Filtered targets only get events whose type they asked for; an event without a type
 * only goes to unfiltered targets.
 */
export function routeEvent(targets: TargetConfig[], eventType: string | null): string[] {
  const urls: string[] = [];
  for (const target of targets) {
    if (typeof target === 'string') urls.push(target);
    else if (target.events === undefined) urls.push(target.url);
    else if (eventType && target.events.some((p) => matchesEvent(p, eventType))) urls.push(target.url);
  }
  return [...new Set(urls)];
}

/**
 * Reads the event type from the payload's `type` / `event` field.
 * Only the body is covered by the HMAC signature, so an unsigned header such as X-Event-Type
 * is never used: a replayed request could otherwise be re-routed by changing it.
 */
export function eventTypeOf(payload: unknown): string | null {
  const body = payload as { type?: unknown; event?: unknown } | null;
  if (typeof body?.type === 'string') return body.type;
  if (typeof body?.event === 'string') return body.event;
  return null;
}
