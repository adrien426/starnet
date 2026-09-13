/* sidecar/revenue-ledger.js — the append-only REAL-REVENUE logbook (the "connective tissue" a business-testing
   loop needs: sidecar/index.js wires the webhook + read tools to this, but nothing here touches disk or the
   clock directly).

   One immutable line per settled sale/refund/cost event ({ id, agentId, hypothesis, source, revenueCents,
   costCents, occurredAt, raw }), keyed by the AGENT BUSINESS it was testing. This is what closes the loop
   docs/AUTONOMOUS_BUSINESS_LOOP_PLAN.md names as blocking: without it, an orchestrator kills or keeps a
   business agent on a model's IMPRESSION, not on money that actually moved.

   THE POINT OF verdict(): the kill/keep call is CODE, not the model. `revenue_status` (tools/builtin/revenue.js)
   only ever hands the model this function's output — never lets it invent its own bar for "this failed".
   Thresholds are constants here, not prompt text, so they cannot be talked out of.

   PURE given its injected edges: `io` (the disk adapter — readAll/append, provided by the Node host) and
   `clock` (now()). No ambient time/IO here, so it passes lint-determinism and is testable headlessly with an
   in-memory io — same discipline as sidecar/ledger.js (the spend ledger this mirrors).

   makeRevenueLedger({ io, clock, killAfterMs?, costMultiplier? }) -> {
     record(event) -> entry,          // fail-open: a persistence hiccup never throws (RAM mirror still answers)
     recordStrict(event) -> entry,    // same, but append failure throws — the HTTP webhook handler wants this:
                                       // an accepted sale that silently failed to persist is a lost dollar, so it
                                       // must fail closed (503, Stripe retries) rather than 200 a phantom write.
     all() -> entry[],  count() -> int,  forAgent(agentId) -> entry[],
     aggregate(agentId) -> { agentId, events, revenueCents, costCents, hypotheses, firstAt, lastAt } | null,
     aggregateAll() -> aggregate[]  (every agentId seen, newest-active first),
     verdict(agentId, opts?) -> { agentId, verdict:'kill'|'keep'|'insufficient-data', reason, ...aggregate }
   } */
'use strict';
(function (root, factory) {
  const api = factory(typeof require === 'function' ? require('./failopen.js').note : function (tag, e) { console.warn('[failopen] ' + tag + ':', (e && e.message) || e); });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { (root.SK = root.SK || {}).revenueLedger = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (failNote) {
  'use strict';

  // Hard-coded arbitration constants (docs/AUTONOMOUS_BUSINESS_LOOP_PLAN.md §4): "un agent business est
  // supprimé si revenue_cents = 0 après N jours ou si cost_cents > revenue_cents × 2. Le LLM propose, le
  // code décide." Overridable per-call for tests/tuning, never by model-supplied input.
  const DEFAULT_KILL_AFTER_MS = 14 * 24 * 60 * 60 * 1000;   // 14 days
  const DEFAULT_COST_MULTIPLIER = 2;
  const SOURCES = new Set(['stripe', 'etsy', 'shopify', 'gumroad', 'manual']);
  const ID_MAX = 100, TEXT_MAX = 200, RAW_MAX = 4000;

  function str(v) { return v == null ? '' : String(v); }
  function text(v, max) { return str(v).slice(0, max || TEXT_MAX); }
  function cents(v) { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.max(0, n) : 0; }

  // No Math.random here (lint-determinism forbids ambient rng in a pure module): a fallback id for a caller
  // that supplied none is derived from the injected clock + a monotonic per-process counter instead.
  function makeEntry(e, now, seq) {
    e = e || {};
    const raw = e.raw && typeof e.raw === 'object' ? e.raw : null;
    let rawText = '';
    if (raw) { try { rawText = JSON.stringify(raw).slice(0, RAW_MAX); } catch (_) { rawText = ''; } }
    return {
      id: text(e.id, ID_MAX) || ('rev_' + now.toString(36) + '_' + Number(seq || 0).toString(36)),
      agentId: text(e.agentId, 40),
      hypothesis: text(e.hypothesis, TEXT_MAX),
      source: SOURCES.has(str(e.source)) ? str(e.source) : 'manual',
      revenueCents: cents(e.revenueCents),
      costCents: cents(e.costCents),
      occurredAt: Number.isFinite(Number(e.occurredAt)) && Number(e.occurredAt) > 0 ? Math.floor(Number(e.occurredAt)) : now,
      raw: rawText
    };
  }

  function makeRevenueLedger(opts) {
    opts = opts || {};
    const io = opts.io || { readAll() { return []; }, append() {} };
    const clock = opts.clock || { now() { return 0; } };
    const killAfterMs = Number.isFinite(opts.killAfterMs) && opts.killAfterMs > 0 ? opts.killAfterMs : DEFAULT_KILL_AFTER_MS;
    const costMultiplier = Number.isFinite(opts.costMultiplier) && opts.costMultiplier > 0 ? opts.costMultiplier : DEFAULT_COST_MULTIPLIER;

    // in-memory mirror, loaded once — same discipline as ledger.js: never RAM-trimmed, because arbitration
    // aggregates over an agent's FULL lifetime (a business tested for 40 days must not forget day 1's cost).
    let rows = [], nextSeq = 1;
    try { const raw = io.readAll(); if (Array.isArray(raw)) rows = raw.filter(r => r && typeof r === 'object').map(r => makeEntry(r, Number(r.occurredAt) || 0, nextSeq++)); }
    catch (e) { rows = []; }

    function record(e) {
      const entry = makeEntry(e, clock.now(), nextSeq++);
      if (!entry.agentId) return null;   // an event with nothing to attribute it to arbitrates nothing
      rows.push(entry);
      // persistence failure must never crash the caller (RAM mirror still answers); tagged rather than silent.
      try { io.append(entry); } catch (e) { failNote('revenueLedger.record.append', e); }
      return entry;
    }

    function recordStrict(e) {
      const entry = makeEntry(e, clock.now(), nextSeq++);
      if (!entry.agentId) throw new Error('revenue event requires an agentId');
      io.append(entry);   // fail closed: thrown BEFORE the RAM mirror sees it, so a caller that catches never
      rows.push(entry);   // reports success for a row that never reached disk.
      return entry;
    }

    function forAgent(agentId) {
      agentId = str(agentId);
      return rows.filter(r => r.agentId === agentId).sort((a, b) => a.occurredAt - b.occurredAt);
    }

    function aggregateRows(agentId, agentRows) {
      if (!agentRows.length) return null;
      let revenueCents = 0, costCents = 0, firstAt = Infinity, lastAt = 0;
      const hypotheses = [];
      for (const r of agentRows) {
        revenueCents += r.revenueCents; costCents += r.costCents;
        if (r.occurredAt < firstAt) firstAt = r.occurredAt;
        if (r.occurredAt > lastAt) lastAt = r.occurredAt;
        if (r.hypothesis && hypotheses.indexOf(r.hypothesis) < 0) hypotheses.push(r.hypothesis);
      }
      return { agentId, events: agentRows.length, revenueCents, costCents, hypotheses, firstAt, lastAt };
    }

    function aggregate(agentId) { return aggregateRows(str(agentId), forAgent(agentId)); }

    function aggregateAll() {
      const byAgent = new Map();
      for (const r of rows) { if (!byAgent.has(r.agentId)) byAgent.set(r.agentId, []); byAgent.get(r.agentId).push(r); }
      const out = [];
      for (const [agentId, agentRows] of byAgent) out.push(aggregateRows(agentId, agentRows.slice().sort((a, b) => a.occurredAt - b.occurredAt)));
      return out.sort((a, b) => b.lastAt - a.lastAt);
    }

    /* THE CODED VERDICT. Never asks the model — a run that wants to know whether to kill a business agent
       calls this and reports the answer, it does not decide one. */
    function verdict(agentId, vOpts) {
      vOpts = vOpts || {};
      const now = Number.isFinite(vOpts.now) ? vOpts.now : clock.now();
      const kAfter = Number.isFinite(vOpts.killAfterMs) && vOpts.killAfterMs > 0 ? vOpts.killAfterMs : killAfterMs;
      const kMult = Number.isFinite(vOpts.costMultiplier) && vOpts.costMultiplier > 0 ? vOpts.costMultiplier : costMultiplier;
      const agg = aggregate(agentId);
      if (!agg) return { agentId: str(agentId), verdict: 'insufficient-data', reason: 'no revenue events recorded yet', events: 0, revenueCents: 0, costCents: 0, hypotheses: [], firstAt: null, lastAt: null };
      // Zero revenue is judged ONLY by the patience window below — "cost_cents > revenue_cents × N" is otherwise
      // satisfied by ANY cost at all once revenue_cents is 0 (N×0 = 0), which would kill every business agent on
      // its very first API call, before it ever got a day to sell anything. The cost-blowout rule is a runaway-
      // spend breaker for an agent that HAS some revenue but is burning far past it, not a zero-revenue test.
      if (agg.revenueCents > 0 && agg.costCents > agg.revenueCents * kMult) {
        return Object.assign({ verdict: 'kill', reason: 'cost_cents (' + agg.costCents + ') exceeds ' + kMult + '× revenue_cents (' + agg.revenueCents + ')' }, agg);
      }
      if (agg.revenueCents === 0 && (now - agg.firstAt) >= kAfter) {
        return Object.assign({ verdict: 'kill', reason: 'zero revenue after ' + Math.floor((now - agg.firstAt) / (24 * 60 * 60 * 1000)) + ' days (threshold ' + Math.floor(kAfter / (24 * 60 * 60 * 1000)) + ')' }, agg);
      }
      return Object.assign({ verdict: 'keep', reason: 'below both kill thresholds' }, agg);
    }

    return {
      record, recordStrict,
      all() { return rows.map(r => Object.assign({}, r)); },
      count() { return rows.length; },
      forAgent(agentId) { return forAgent(agentId).map(r => Object.assign({}, r)); },
      aggregate, aggregateAll, verdict
    };
  }

  return { makeRevenueLedger, SOURCES, DEFAULT_KILL_AFTER_MS, DEFAULT_COST_MULTIPLIER };
});
