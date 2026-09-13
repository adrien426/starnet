/* sidecar/revenue-notify.js — ping the Commander over a connected channel (Telegram/Discord/…) when a business
   agent's REAL revenue changes, or when the coded verdict (sidecar/revenue-ledger.js) flips to kill.

   Mirrors autonotify.js exactly on purpose: a HOST-COMPOSED, deterministic one-line message, never model text —
   the whole point of docs/AUTONOMOUS_BUSINESS_LOOP_PLAN.md's arbitration rule is that a kill/keep call is CODE,
   not the model, and that discipline extends to what gets said about it: this module has no prompt, no LLM
   call, nothing a prompt-injected page or tool result could steer. Same opt-in/anti-spam gate as autonotify
   (chatsFor returns [] when the Commander hasn't opted an agent's chat in) and the same shape, so index.js wires
   it identically. Pure + injected-deps → node-testable with a fake send.

   makeRevenueNotifier({ send, chatsFor }) -> { onEvent(name, payload) }
     send(chatId, text, channel) -> Promise
     chatsFor(agentId) -> [{chatId, channel}]   // [] -> no ping (opt-out or no connected chat)

   It watches ONE event: 'revenue.event' { agentId, hypothesis, source, revenueCents, costCents, verdict }
   where `verdict` is the FULL sidecar/revenue-ledger.js verdict() object computed right after the write. */
'use strict';
(function (root, factory) {
  const failopen = typeof require === 'function' ? require('./failopen.js') : null;
  const api = factory(failopen || { note: function (tag, e) { console.warn('[failopen] ' + tag + ':', (e && e.message) || e); }, swallow: function (tag) { return (e) => { console.warn('[failopen] ' + tag + ':', (e && e.message) || e); }; } });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { (root.SK = root.SK || {}).revenueNotify = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (failopen) {
  'use strict';
  const { note: failNote, swallow } = failopen;

  function money(cents) { return '$' + (Number(cents || 0) / 100).toFixed(2); }
  function label(agentId, hypothesis) { return agentId + (hypothesis ? ' (' + hypothesis + ')' : ''); }

  // the message body — honest + compact, one line, never the model's words.
  function composeMessage(p) {
    const who = label(p.agentId, p.hypothesis);
    const lines = [];
    if (Number(p.revenueCents) > 0) lines.push('💰 ' + money(p.revenueCents) + ' — ' + who + ' via ' + (p.source || 'manual') + '.');
    if (p.verdict && p.verdict.verdict === 'kill') lines.push('☠ ' + who + ' — KILL: ' + p.verdict.reason + '.');
    return lines.join(' ');
  }

  function makeRevenueNotifier(opts) {
    const o = opts || {};
    const send = typeof o.send === 'function' ? o.send : function () {};
    const chatsFor = typeof o.chatsFor === 'function' ? o.chatsFor : function () { return []; };

    function onEvent(name, payload) {
      const p = payload || {};
      try {
        if (name !== 'revenue.event' || !p.agentId) return;
        const text = composeMessage(p);
        if (!text) return;   // a $0 event with no kill verdict says nothing worth a ping
        const chats = chatsFor(p.agentId) || [];
        if (!chats.length) return;   // no connected/opted-in chat -> no ping (same anti-spam gate as autonotify)
        for (const c of chats) {
          const chatId = (c && c.chatId != null) ? c.chatId : c;
          const channel = c && c.channel;
          try { Promise.resolve(send(chatId, text, channel)).catch(swallow('revenueNotify.send')); }
          catch (e) { failNote('revenueNotify.send.sync', e); }   // a notification must NEVER break the caller
        }
      } catch (e) { failNote('revenueNotify.onEvent', e); }   // a notification must NEVER break the caller
    }

    return { onEvent: onEvent };
  }

  return { makeRevenueNotifier: makeRevenueNotifier, composeMessage: composeMessage };
});
