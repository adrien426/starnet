/* node test/revenue-webhook.test.js — Stripe-Signature verification, pure (no server, no network).
   Mirrors the discipline of channels/webhook-auth.js's own tests: valid signature accepted, a tampered
   body/signature/timestamp rejected, an unconfigured secret fails closed. */
'use strict';
const A = require('./_assert.js');
const crypto = require('crypto');
const { makeStripeWebhookVerifier } = require('../sidecar/revenue-webhook.js');

const SECRET = 'whsec_' + 'a'.repeat(32);
function sign(secret, t, body) { return crypto.createHmac('sha256', secret).update(t + '.' + body).digest('hex'); }

// ---- a correctly signed, fresh delivery is accepted ----
{
  let now = 1_700_000_000_000;
  const V = makeStripeWebhookVerifier({ secret: SECRET, now: () => now });
  const t = String(Math.floor(now / 1000));
  const body = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed' });
  const header = 't=' + t + ',v1=' + sign(SECRET, t, body);
  const v = V.verify({ header, body });
  A.ok(v.ok, 'a correctly signed delivery is accepted');
  A.eq(v.timestamp, Number(t), 'verify surfaces the parsed timestamp');
}

// ---- multiple v1 values (Stripe secret rotation): ANY matching signature is accepted ----
{
  let now = 1_700_000_000_000;
  const V = makeStripeWebhookVerifier({ secret: SECRET, now: () => now });
  const t = String(Math.floor(now / 1000));
  const body = '{}';
  const header = 't=' + t + ',v1=' + 'f'.repeat(64) + ',v1=' + sign(SECRET, t, body);
  A.ok(V.verify({ header, body }).ok, 'a header carrying multiple v1 values is accepted if ANY matches');
}

// ---- a tampered body invalidates the signature ----
{
  const now = 1_700_000_000_000;
  const V = makeStripeWebhookVerifier({ secret: SECRET, now: () => now });
  const t = String(Math.floor(now / 1000));
  const header = 't=' + t + ',v1=' + sign(SECRET, t, '{"a":1}');
  const v = V.verify({ header, body: '{"a":2}' });
  A.ok(!v.ok && v.code === 401, 'a body that does not match the signed payload is rejected (401)');
}

// ---- a stale timestamp outside tolerance is rejected even with a correct signature ----
{
  const now = 1_700_000_000_000;
  const V = makeStripeWebhookVerifier({ secret: SECRET, now: () => now, toleranceMs: 300000 });
  const staleT = String(Math.floor((now - 600000) / 1000));   // 10 minutes old, tolerance is 5
  const body = '{}';
  const header = 't=' + staleT + ',v1=' + sign(SECRET, staleT, body);
  const v = V.verify({ header, body });
  A.ok(!v.ok && /stale/.test(v.error), 'a timestamp past the tolerance window is refused as stale');
}

// ---- a malformed header is rejected, never crashes ----
{
  const V = makeStripeWebhookVerifier({ secret: SECRET, now: () => 1_700_000_000_000 });
  A.ok(!V.verify({ header: '', body: '{}' }).ok, 'an empty header is rejected');
  A.ok(!V.verify({ header: 't=notanumber,v1=' + 'a'.repeat(64), body: '{}' }).ok, 'a non-numeric timestamp is rejected');
  A.ok(!V.verify({ header: 't=1700000000,v1=nothex', body: '{}' }).ok, 'a non-hex signature is rejected');
}

// ---- an unconfigured secret fails CLOSED (503), never silently accepts ----
{
  const V = makeStripeWebhookVerifier({ secret: '', now: () => 1_700_000_000_000 });
  const v = V.verify({ header: 't=1700000000,v1=' + 'a'.repeat(64), body: '{}' });
  A.ok(!v.ok && v.code === 503, 'an empty/short secret refuses every delivery (503), never fails open');
}

A.report('revenue-webhook.test');
