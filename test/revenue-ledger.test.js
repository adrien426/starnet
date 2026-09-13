/* node test/revenue-ledger.test.js — the real-revenue ledger + its CODED keep/kill verdict, fed an in-memory
   io + a controllable clock (zero disk). Mirrors test/ledger.test.js's discipline for the spend ledger. */
'use strict';
const A = require('./_assert.js');
const { makeRevenueLedger } = require('../sidecar/revenue-ledger.js');

function fakeIo(seed) { const rows = (seed || []).slice(); return { rows, readAll() { return rows.slice(); }, append(e) { rows.push(e); } }; }
const DAY = 24 * 60 * 60 * 1000;
let t = 1_000_000;
const clock = { now: () => t };

// ---- record persists, coerces fields, and refuses an unattributable event ----
{
  const io = fakeIo();
  const L = makeRevenueLedger({ io, clock });
  const e = L.record({ agentId: 'biz1', hypothesis: 'stickers', source: 'stripe', revenueCents: 1999, costCents: 200 });
  A.eq(e.agentId, 'biz1', 'agentId persisted');
  A.eq(e.revenueCents, 1999, 'revenueCents persisted');
  A.eq(e.occurredAt, t, 'occurredAt falls back to the clock');
  A.eq(io.rows.length, 1, 'entry persisted through io.append');
  A.eq(L.record({ agentId: '' }), null, 'an event with no agentId is refused (nothing to arbitrate)');
  A.eq(io.rows.length, 1, 'the refused event never reached io');
  A.eq(L.record({ agentId: 'biz1', source: 'not-a-real-source' }).source, 'manual', 'an unknown source coerces to manual');
  A.eq(L.record({ agentId: 'biz1', revenueCents: -50 }).revenueCents, 0, 'a negative amount clamps to zero');
}

// ---- recordStrict throws on a failed append instead of silently swallowing it ----
{
  const io = { readAll() { return []; }, append() { throw new Error('disk full'); } };
  const L = makeRevenueLedger({ io, clock });
  A.throws(() => L.recordStrict({ agentId: 'biz1', revenueCents: 100 }), 'recordStrict propagates an append failure (fail-closed)');
  A.eq(L.count(), 0, 'the RAM mirror never sees a row whose append failed');
  A.throws(() => L.recordStrict({ agentId: '' }), 'recordStrict also refuses a missing agentId');
}

// ---- a prior log is loaded on construction (restart survives) ----
{
  const io = fakeIo([{ id: 'r1', agentId: 'biz1', revenueCents: 500, costCents: 0, occurredAt: t }]);
  const L = makeRevenueLedger({ io, clock });
  A.eq(L.count(), 1, 'a seeded log is loaded at construction');
  A.eq(L.forAgent('biz1').length, 1, 'forAgent sees the loaded row');
}

// ---- aggregate sums revenue/cost, tracks hypotheses and the first/last event time ----
{
  const io = fakeIo();
  const L = makeRevenueLedger({ io, clock });
  L.record({ agentId: 'biz1', hypothesis: 'stickers', revenueCents: 1000, costCents: 100, occurredAt: t });
  L.record({ agentId: 'biz1', hypothesis: 'stickers', revenueCents: 500, costCents: 50, occurredAt: t + DAY });
  L.record({ agentId: 'biz1', hypothesis: 'mugs', revenueCents: 0, costCents: 20, occurredAt: t + 2 * DAY });
  L.record({ agentId: 'biz2', revenueCents: 9999, costCents: 0, occurredAt: t });
  const agg = L.aggregate('biz1');
  A.eq(agg.events, 3, 'aggregate counts every event for the agent');
  A.eq(agg.revenueCents, 1500, 'aggregate sums revenue across events');
  A.eq(agg.costCents, 170, 'aggregate sums cost across events');
  A.eq(agg.hypotheses, ['stickers', 'mugs'], 'aggregate lists distinct hypotheses in first-seen order');
  A.eq(agg.firstAt, t, 'aggregate tracks the earliest event time');
  A.eq(agg.lastAt, t + 2 * DAY, 'aggregate tracks the latest event time');
  A.eq(L.aggregate('nobody'), null, 'an untested agent aggregates to null');
  const all = L.aggregateAll();
  A.eq(all.length, 2, 'aggregateAll covers every agent seen');
  A.eq(all[0].agentId, 'biz1', 'aggregateAll orders by most recent activity first');
}

// ---- verdict: the CODED thresholds, never the model's own read ----
{
  const io = fakeIo();
  const L = makeRevenueLedger({ io, clock, killAfterMs: 3 * DAY, costMultiplier: 2 });

  A.eq(L.verdict('ghost').verdict, 'insufficient-data', 'no events at all -> insufficient-data, not a kill');

  L.record({ agentId: 'zero-rev', revenueCents: 0, costCents: 10, occurredAt: t });
  A.eq(L.verdict('zero-rev', { now: t + 2 * DAY }).verdict, 'keep', 'zero revenue but still inside the grace window -> keep');
  A.eq(L.verdict('zero-rev', { now: t + 4 * DAY }).verdict, 'kill', 'zero revenue past the kill-after window -> kill');
  A.ok(/zero revenue after/.test(L.verdict('zero-rev', { now: t + 4 * DAY }).reason), 'the zero-revenue kill names its reason');

  L.record({ agentId: 'costly', revenueCents: 100, costCents: 50, occurredAt: t });
  A.eq(L.verdict('costly', { now: t + 4 * DAY }).verdict, 'keep', 'cost under 2x revenue, some revenue exists -> keep');
  L.record({ agentId: 'costly', revenueCents: 0, costCents: 300, occurredAt: t + DAY });
  A.eq(L.verdict('costly', { now: t + 4 * DAY }).verdict, 'kill', 'cost now exceeds 2x cumulative revenue -> kill regardless of the day window');
  A.ok(/exceeds/.test(L.verdict('costly', { now: t + 4 * DAY }).reason), 'the cost-blowout kill names its reason');

  L.record({ agentId: 'winner', revenueCents: 5000, costCents: 200, occurredAt: t });
  A.eq(L.verdict('winner', { now: t + 30 * DAY }).verdict, 'keep', 'healthy revenue relative to cost -> keep, no matter how much time passed');
}

A.report('revenue-ledger.test');
