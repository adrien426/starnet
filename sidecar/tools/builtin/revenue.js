/* sidecar/tools/builtin/revenue.js — read the CODED verdict on a business agent's real revenue.

   docs/AUTONOMOUS_BUSINESS_LOOP_PLAN.md's learning-loop gap: "l'orchestrateur ne saura pas que le test n°3 a
   mieux marché que le n°7 sans câblage explicite de la mesure vers la décision." This tool is that wiring —
   and ONLY that wiring. It never lets the model invent its own bar for "this failed": it hands back whatever
   sidecar/revenue-ledger.js's verdict() computed from hard-coded thresholds (kill after N days at zero revenue,
   or cost past a fixed multiple of revenue), and the model's job is to ACT on that verdict (team.dispatch a
   summon/delete), never to re-derive or override it. "Le LLM propose, le code décide."

   Read-only, no consent gate: it reaches no network and mutates nothing, same trust class as team.subagents.
   Rides the `orchestrator` capId (capability/registry.js) — any lead already holding team.dispatch/team.summon
   gets this for free, without a new grantable object.

   makeRevenueTool({ ledger }) -> { revenueStatusTool, register(reg) }
     ledger : sidecar/revenue-ledger.js's makeRevenueLedger() instance (aggregate/aggregateAll/verdict). */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.SK = root.SK || {}; root.SK.tools = root.SK.tools || {}; (root.SK.tools.builtin = root.SK.tools.builtin || {}).revenue = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function fmtCents(c) { return '$' + (Number(c || 0) / 100).toFixed(2); }

  function lineFor(v) {
    if (v.verdict === 'insufficient-data') return v.agentId + ': no revenue events yet — insufficient-data (keep testing)';
    return v.agentId + ': ' + v.verdict.toUpperCase() + ' — ' + fmtCents(v.revenueCents) + ' revenue / ' + fmtCents(v.costCents)
      + ' cost across ' + v.events + ' event(s). ' + v.reason;
  }

  function makeRevenueTool(deps) {
    deps = deps || {};
    const ledger = deps.ledger;
    if (!ledger) throw new Error('revenue.js requires { ledger }');

    const revenueStatusTool = {
      name: 'revenue_status', capability: 'orchestrator', scope: 'read', requiresConsent: false, timeoutMs: 5000,
      description: 'Read the CODED keep/kill verdict for a business agent you spawned to test a monetization hypothesis, '
        + 'from REAL revenue events (Stripe/Etsy/Shopify/Gumroad), never from your own impression of how it went. '
        + 'agentId: check one agent business; omit to list every tested agent, newest activity first. '
        + 'The verdict (kill / keep / insufficient-data) is computed by fixed thresholds in code — treat it as the '
        + 'decision, not a suggestion: act on "kill" by ending that agent, never override it with your own judgment.',
      schema: { type: 'object', properties: { agentId: { type: 'string' } } },
      run: async (args) => {
        const agentId = String((args && args.agentId) || '').trim();
        if (agentId) {
          const v = ledger.verdict(agentId);
          return { content: lineFor(v), summary: agentId + ': ' + v.verdict };
        }
        const all = ledger.aggregateAll();
        if (!all.length) return { content: 'No business agents have any recorded revenue events yet.', summary: 'no data' };
        const lines = all.map(a => lineFor(ledger.verdict(a.agentId)));
        return { content: lines.join('\n'), summary: all.length + ' business agent(s) tracked' };
      }
    };

    return { revenueStatusTool, register(reg) { reg.register(revenueStatusTool); return reg; } };
  }

  return { makeRevenueTool };
});
