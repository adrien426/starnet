/* node test/revenue-tool.test.js — revenue_status, the tool surface an orchestrator agent calls to read the
   CODED keep/kill verdict. Asserts the tool never re-derives a verdict itself — it only formats whatever
   sidecar/revenue-ledger.js computed — and is wired into CAP_REGISTRY under the orchestrator object. */
'use strict';
const A = require('./_assert.js');
const { makeRevenueTool } = require('../sidecar/tools/builtin/revenue.js');
const { makeRevenueLedger } = require('../sidecar/revenue-ledger.js');
const { CAP_REGISTRY } = require('../sidecar/capability/registry.js');

function fakeIo() { const rows = []; return { readAll() { return rows.slice(); }, append(e) { rows.push(e); } }; }

(async () => {
  // ---- wired into the registry as a read-only, consent-free orchestrator tool ----
  {
    const row = CAP_REGISTRY.orchestrator.find(r => r.tool === 'revenue_status');
    A.ok(!!row, 'revenue_status is granted by the orchestrator object');
    A.eq(row.scope, 'read', 'revenue_status is read-only');
    A.eq(row.requiresConsent, false, 'revenue_status needs no consent (reaches no network, mutates nothing)');
    A.eq(row.network, false, 'revenue_status is declared as reaching no network');
  }

  // ---- no agentId: lists every tested agent ----
  {
    const ledger = makeRevenueLedger({ io: fakeIo(), clock: { now: () => 1000 } });
    ledger.record({ agentId: 'winner', revenueCents: 5000, costCents: 100, occurredAt: 1000 });
    ledger.record({ agentId: 'loser', revenueCents: 100, costCents: 500, occurredAt: 1000 });   // cost > 2x revenue -> instant kill
    const { revenueStatusTool } = makeRevenueTool({ ledger });
    A.eq(revenueStatusTool.name, 'revenue_status', 'tool is named revenue_status');
    A.eq(revenueStatusTool.requiresConsent, false, 'the tool definition itself carries no consent gate');
    const out = await revenueStatusTool.run({});
    A.ok(/winner/.test(out.content) && /loser/.test(out.content), 'omitting agentId reports every tracked agent');
    A.ok(/KILL/.test(out.content), 'a losing agent surfaces an uppercase KILL verdict, not a hedge');
  }

  // ---- one agentId: reports that agent's coded verdict, not the model's own read ----
  {
    const ledger = makeRevenueLedger({ io: fakeIo(), clock: { now: () => 1000 } });
    ledger.record({ agentId: 'biz1', revenueCents: 200, costCents: 50, occurredAt: 1000 });
    const { revenueStatusTool } = makeRevenueTool({ ledger });
    const out = await revenueStatusTool.run({ agentId: 'biz1' });
    A.eq(out.summary, 'biz1: keep', 'summary carries the ledger verdict verbatim');
    A.ok(/\$2\.00 revenue/.test(out.content), 'content formats revenueCents as dollars');
  }

  // ---- an untested agentId reports insufficient-data, never fabricates a kill/keep ----
  {
    const ledger = makeRevenueLedger({ io: fakeIo(), clock: { now: () => 1000 } });
    const { revenueStatusTool } = makeRevenueTool({ ledger });
    const out = await revenueStatusTool.run({ agentId: 'never-tested' });
    A.eq(out.summary, 'never-tested: insufficient-data', 'an untested agent reports insufficient-data');
  }

  A.report('revenue-tool.test');
})().catch(e => { console.error(e); process.exit(1); });
