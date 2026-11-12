import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { matchesEvent, routeEvent, eventTypeOf } from '../src/routing.ts';

describe('matchesEvent', () => {
  it('matches exact types', () => {
    assert.equal(matchesEvent('order.paid', 'order.paid'), true);
    assert.equal(matchesEvent('order.paid', 'order.created'), false);
  });
  it('matches prefix wildcards', () => {
    assert.equal(matchesEvent('stock.*', 'stock.updated'), true);
    assert.equal(matchesEvent('stock.*', 'stocktake.done'), false);
    assert.equal(matchesEvent('*', 'anything'), true);
  });
});

describe('routeEvent', () => {
  const targets = [
    'https://erp/hooks',
    { url: 'https://wms/hooks', events: ['order.paid', 'stock.*'] },
    { url: 'https://acc/hooks', events: ['order.paid', 'refund.*'] },
    { url: 'https://all/hooks' },
  ];
  it('sends an event only to subscribed targets', () => {
    assert.deepEqual(routeEvent(targets, 'stock.updated'), ['https://erp/hooks', 'https://wms/hooks', 'https://all/hooks']);
    assert.deepEqual(routeEvent(targets, 'order.paid'), ['https://erp/hooks', 'https://wms/hooks', 'https://acc/hooks', 'https://all/hooks']);
  });
  it('sends untyped events only to unfiltered targets', () => {
    assert.deepEqual(routeEvent(targets, null), ['https://erp/hooks', 'https://all/hooks']);
  });
  it('treats an empty event list as no subscription', () => {
    const paused = [{ url: 'https://paused/hooks', events: [] }, 'https://erp/hooks'];
    assert.deepEqual(routeEvent(paused, 'order.paid'), ['https://erp/hooks']);
    assert.deepEqual(routeEvent(paused, null), ['https://erp/hooks']);
  });
  it('removes duplicate URLs', () => {
    assert.deepEqual(routeEvent(['https://a', { url: 'https://a', events: ['*'] }], 'x'), ['https://a']);
  });
});

describe('eventTypeOf', () => {
  it('reads the signed body: type, then event', () => {
    assert.equal(eventTypeOf({ type: 'order.created' }), 'order.created');
    assert.equal(eventTypeOf({ event: 'refund.created' }), 'refund.created');
    assert.equal(eventTypeOf({ id: 1 }), null);
  });
});
