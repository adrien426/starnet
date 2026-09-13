'use strict';
// revenue-notify.test.js — pings the agent's opted-in chats on a real sale and/or a coded kill verdict.
// Host-composed text only (never model text); same anti-spam opt-in gate as autonotify.js; never throws.
const assert = require('assert');
const { makeRevenueNotifier, composeMessage } = require('../sidecar/revenue-notify.js');

let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); n++; };

function harness(chatsByAgent) {
  const sent = [];
  const nf = makeRevenueNotifier({
    send: (chatId, text, channel) => { sent.push({ chatId, text, channel }); return Promise.resolve(); },
    chatsFor: (aid) => (chatsByAgent[aid] || [])
  });
  return { nf, sent };
}

// --- composeMessage ---
ok(/\$19\.99/.test(composeMessage({ agentId: 'biz1', hypothesis: 'stickers', source: 'stripe', revenueCents: 1999 })), 'formats revenueCents as dollars');
ok(/biz1 \(stickers\)/.test(composeMessage({ agentId: 'biz1', hypothesis: 'stickers', revenueCents: 100 })), 'names the agent + hypothesis');
eq(composeMessage({ agentId: 'biz1', revenueCents: 0 }), '', 'a zero-revenue, non-kill event composes nothing (no ping worth sending)');
ok(/KILL/.test(composeMessage({ agentId: 'biz1', hypothesis: 'mugs', revenueCents: 0, verdict: { verdict: 'kill', reason: 'zero revenue after 14 days' } })), 'a kill verdict composes a KILL line even with zero revenue');
ok(/💰[\s\S]*☠/.test(composeMessage({ agentId: 'biz1', revenueCents: 500, verdict: { verdict: 'kill', reason: 'cost blew out' } })), 'a sale AND a kill on the same event compose both lines');

// --- a sale pings the agent's opted-in chats ---
{
  const h = harness({ biz1: [{ chatId: '111', channel: 'telegram' }] });
  h.nf.onEvent('revenue.event', { agentId: 'biz1', hypothesis: 'stickers', source: 'stripe', revenueCents: 1999, costCents: 0, verdict: { verdict: 'keep' } });
  eq(h.sent.length, 1, 'one ping on a real sale');
  eq([h.sent[0].chatId, h.sent[0].channel], ['111', 'telegram'], 'sent to the right chat + channel');
  ok(/\$19\.99/.test(h.sent[0].text) && /biz1/.test(h.sent[0].text), 'message names the amount and the agent');
}

// --- a kill verdict pings even with zero revenue on this event ---
{
  const h = harness({ biz1: [{ chatId: '111', channel: 'telegram' }] });
  h.nf.onEvent('revenue.event', { agentId: 'biz1', hypothesis: 'mugs', revenueCents: 0, costCents: 900, verdict: { verdict: 'kill', reason: 'cost_cents (900) exceeds 2× revenue_cents (100)' } });
  eq(h.sent.length, 1, 'a kill verdict pings on its own');
  ok(/KILL/.test(h.sent[0].text), 'message carries the KILL verdict');
}

// --- anti-spam: a $0 event with a keep verdict never pings ---
{
  const h = harness({ biz1: [{ chatId: '111', channel: 'telegram' }] });
  h.nf.onEvent('revenue.event', { agentId: 'biz1', revenueCents: 0, verdict: { verdict: 'keep' } });
  h.nf.onEvent('other.event', { agentId: 'biz1', revenueCents: 1999 });   // wrong event name is ignored entirely
  eq(h.sent.length, 0, 'nothing worth reporting -> no ping, and non-revenue.event events are ignored');
}

// --- opt-in: no chats -> no ping ---
{
  const h = harness({});
  h.nf.onEvent('revenue.event', { agentId: 'biz1', revenueCents: 1999 });
  eq(h.sent.length, 0, 'no opted-in chat -> no ping');
}

// --- an event with no agentId is a safe no-op ---
{
  const h = harness({ biz1: [{ chatId: '111' }] });
  h.nf.onEvent('revenue.event', { revenueCents: 1999 });
  eq(h.sent.length, 0, 'a payload with no agentId cannot be attributed -> safe no-op');
}

// --- cross-agent isolation ---
{
  const h = harness({ biz1: [{ chatId: 'A1', channel: 'telegram' }], biz2: [{ chatId: 'B1', channel: 'discord' }] });
  h.nf.onEvent('revenue.event', { agentId: 'biz1', revenueCents: 1999 });
  eq(h.sent.map(s => s.chatId), ['A1'], "only the event's own agent chats are pinged (no cross-agent leak)");
}

// --- fan-out: every opted-in chat for the agent gets it ---
{
  const h = harness({ biz1: [{ chatId: '111', channel: 'telegram' }, { chatId: '222', channel: 'discord' }] });
  h.nf.onEvent('revenue.event', { agentId: 'biz1', revenueCents: 1999 });
  eq(h.sent.map(s => [s.chatId, s.channel]).sort(), [['111', 'telegram'], ['222', 'discord']], 'pings every opted-in chat, each on its own channel');
}

// --- never throws even if send is hostile (sync throw or rejection) ---
{
  const nf1 = makeRevenueNotifier({ send: () => { throw new Error('boom'); }, chatsFor: () => [{ chatId: '1' }] });
  nf1.onEvent('revenue.event', { agentId: 'biz1', revenueCents: 1999 });   // must not throw
  const nf2 = makeRevenueNotifier({ send: () => Promise.reject(new Error('rate limited')), chatsFor: () => [{ chatId: '1' }] });
  nf2.onEvent('revenue.event', { agentId: 'biz1', revenueCents: 1999 });   // must not throw synchronously either
  ok(true, 'a throwing/rejecting send never escapes onEvent');
}

// --- source-locks for the wiring ---
const fs = require('fs'); const path = require('path');
const idx = fs.readFileSync(path.join(__dirname, '..', 'sidecar', 'index.js'), 'utf8');
ok(/require\('\.\/revenue-notify\.js'\)/.test(idx), 'index.js requires the revenue notifier');
ok(/makeRevenueNotifier\(/.test(idx), 'index.js instantiates the revenue notifier');
ok(/revenueNotifier\.onEvent\('revenue\.event'/.test(idx), 'index.js fires revenue.event after a successful record');
ok(/notifyRevenueRow\(row\)/.test(idx), 'both revenue handlers call the shared notify helper after recordStrict');

console.log('revenue-notify.test.js OK —', n, 'assertions');
