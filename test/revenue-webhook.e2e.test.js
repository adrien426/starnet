/* node test/revenue-webhook.e2e.test.js — LIVE proof of the revenue connector against a REAL sidecar process:
   a correctly Stripe-signed webhook lands a row in revenue-events.jsonl and is readable back through
   /api/revenue/summary; an unsigned/tampered delivery is refused; the manual /api/revenue/events ingestion
   path requires the station's own token. Mirrors test/webhook-replay.e2e.test.js's boot/fetch discipline. */
'use strict';
const A = require('./_assert.js');
const crypto = require('crypto');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn } = require('child_process');
const { bootToken } = require('./_httpToken.js');

const HOST = '127.0.0.1';
const INDEX = path.resolve(__dirname, '..', 'sidecar', 'index.js');
const SECRET = 'whsec_' + 'e'.repeat(32);
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function sign(t, body) { return crypto.createHmac('sha256', SECRET).update(t + '.' + body).digest('hex'); }

function boot(port, env, attemptsLeft) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [INDEX], {
      env: Object.assign({}, process.env, env, { SKYNET_PORT: String(port) }),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '', settled = false;
    const onData = d => {
      out += d.toString();
      if (!settled && out.indexOf('http://' + HOST + ':' + port) >= 0) { settled = true; resolve({ child, port }); }
      else if (!settled && /already in use/i.test(out)) {
        settled = true; try { child.kill(); } catch (_) {}
        if (attemptsLeft > 0) resolve(boot(port + 1, env, attemptsLeft - 1)); else reject(new Error('no free port'));
      }
    };
    child.stdout.on('data', onData); child.stderr.on('data', onData);
    child.on('error', e => { if (!settled) { settled = true; reject(e); } });
    setTimeout(() => { if (!settled) { settled = true; try { child.kill(); } catch (_) {} reject(new Error('boot timeout:\n' + out)); } }, 9000);
  });
}

(async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-revenue-e2e-'));
  const env = { SKYNET_WORKSPACES: ws, STARNET_STRIPE_WEBHOOK_SECRET: SECRET };
  let child, port;
  try {
    ({ child, port } = await boot(8960 + (process.pid % 30), env, 20));
    const B = 'http://' + HOST + ':' + port;
    const token = await bootToken(B, B);

    // ---- unsigned delivery is refused, never recorded ----
    const evt = { id: 'evt_e2e_1', type: 'checkout.session.completed', created: 1700000000, data: { object: { id: 'cs_1', amount_total: 1999, metadata: { agentId: 'biz1', hypothesis: 'stickers' } } } };
    const body = JSON.stringify(evt);
    const unsigned = await fetch(B + '/api/revenue/webhook/stripe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    A.eq(unsigned.status, 401, 'an unsigned Stripe webhook is refused');

    // ---- a correctly signed delivery is accepted WITHOUT the station's own per-launch token ----
    // (proves the TOKEN_EXEMPT wiring: Stripe's servers cannot carry it, so Stripe's own HMAC must be the fence)
    const t = String(Math.floor(Date.now() / 1000));
    const signed = await fetch(B + '/api/revenue/webhook/stripe', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Stripe-Signature': 't=' + t + ',v1=' + sign(t, body) }, body
    });
    A.eq(signed.status, 200, 'a correctly signed Stripe webhook is accepted with NO X-StarNet-Token header');
    const signedJson = await signed.json();
    A.ok(signedJson.ok && signedJson.recorded, 'the webhook response confirms the event was recorded');

    // ---- it durably landed on disk ----
    const eventsFile = path.join(ws, 'revenue-events.jsonl');
    A.ok(fs.existsSync(eventsFile), 'revenue-events.jsonl was written to the workspaces dir');
    A.ok(fs.readFileSync(eventsFile, 'utf8').indexOf('biz1') >= 0, 'the durable ledger carries the delivered agentId');

    // ---- readable back through the token-guarded summary route ----
    const summary = await fetch(B + '/api/revenue/summary?agent=biz1', { headers: { 'X-StarNet-Token': token } });
    const sJson = await summary.json();
    A.eq(sJson.verdict, 'keep', 'a healthy first sale reads back as keep');
    A.eq(sJson.revenueCents, 1999, 'the read-back revenueCents matches the Stripe amount_total');

    // ---- the summary route itself still requires the station token (not Stripe-exempt) ----
    const noToken = await fetch(B + '/api/revenue/summary?agent=biz1');
    A.eq(noToken.status, 403, '/api/revenue/summary is NOT token-exempt (only the Stripe webhook path is)');

    // ---- manual ingestion (Etsy/Shopify polling, a logged cost) requires the station token ----
    const manualNoToken = await fetch(B + '/api/revenue/events', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agentId: 'biz2', source: 'etsy', revenueCents: 500 }) });
    A.eq(manualNoToken.status, 403, 'manual ingestion without the station token is refused');
    const manual = await fetch(B + '/api/revenue/events', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-StarNet-Token': token }, body: JSON.stringify({ agentId: 'biz2', source: 'etsy', revenueCents: 500 }) });
    A.eq(manual.status, 200, 'manual ingestion with the station token succeeds');

    // ---- a duplicate delivery (Stripe retries on any non-2xx, or a benign resend) re-records the same id, never
    // crashes — the reader (aggregate) is not asserted duplicate-proof here, only that ingestion stays available ----
    const resend = await fetch(B + '/api/revenue/webhook/stripe', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Stripe-Signature': 't=' + t + ',v1=' + sign(t, body) }, body });
    A.eq(resend.status, 200, 'a resent identical delivery is accepted again (idempotence is a reader concern, not an ingestion refusal)');
  } finally {
    try { child && child.kill(); } catch (_) {}
    await sleep(150);
    try { fs.rmSync(ws, { recursive: true, force: true }); } catch (_) {}
  }
  A.report('revenue-webhook.e2e.test');
})().catch(e => { console.log('FAIL: revenue-webhook.e2e.test threw - ' + (e && e.stack || e)); process.exit(1); });
