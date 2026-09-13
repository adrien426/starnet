/* sidecar/revenue-webhook.js — verifies a Stripe webhook delivery's Stripe-Signature header.

   Pure core, no server/global state (mirrors channels/webhook-auth.js's makeWebhookVerifier). Stripe's own
   scheme, not StarNet's relay HMAC: the header is `t=<unix-seconds>,v1=<hex-hmac>[,v1=<hex-hmac>...]` and the
   signed payload is the literal string `${t}.${rawBody}`, HMAC-SHA256 with the endpoint's signing secret
   (https://stripe.com/docs/webhooks#verify-manually). Stripe can rotate signing secrets, so a delivery may
   carry more than one v1 value during the overlap window; ANY of them matching is a valid signature.

   WHY THIS CANNOT REUSE THE RELAY VERIFIER: makeWebhookVerifier expects StarNet's own timestamp+nonce+hex
   headers, minted by a caller that already holds this station's per-launch API token. Stripe's servers can
   supply neither that token nor those headers — the signing secret from the Stripe Dashboard (or `stripe
   listen`) is the ONLY fence a real Stripe delivery can carry, which is why this endpoint is separately listed
   in apiauth.js's TOKEN_EXEMPT set and relies entirely on verify() below.

   No replay-nonce store: unlike the relay ingress (which drives a real inbound action), a webhook delivery here
   only APPENDS an immutable revenue_events row keyed by Stripe's own event id — a replayed delivery re-records
   the same id, which is a duplicate-detection question for the reader (aggregate-by-id), not a security hole.

   makeStripeWebhookVerifier({ secret, now, toleranceMs? }) -> { verify({ header, body }) -> { ok, code, error, timestamp } } */
'use strict';
const crypto = require('node:crypto');

function makeStripeWebhookVerifier(opts) {
  opts = opts || {};
  const secret = String(opts.secret || '');
  const now = opts.now;
  if (typeof now !== 'function') throw new Error('makeStripeWebhookVerifier: an injected now function is required');
  const toleranceMs = Math.max(1000, Number(opts.toleranceMs) || 300000);   // Stripe's own default tolerance is 5 minutes

  function expected(timestamp, body) {
    return crypto.createHmac('sha256', secret).update(String(timestamp) + '.' + String(body)).digest('hex');
  }

  function parseHeader(header) {
    const out = { t: '', v1: [] };
    for (const part of String(header || '').split(',')) {
      const eq = part.indexOf('=');
      if (eq < 0) continue;
      const k = part.slice(0, eq).trim(), v = part.slice(eq + 1).trim();
      if (k === 't' && !out.t) out.t = v;
      else if (k === 'v1' && v) out.v1.push(v);
    }
    return out;
  }

  function verify(input) {
    input = input || {};
    if (secret.length < 16) return { ok: false, code: 503, error: 'stripe webhook secret is not configured' };
    const { t, v1 } = parseHeader(input.header);
    if (!/^\d{10,16}$/.test(t) || !v1.length || !v1.every(s => /^[a-f0-9]{64}$/i.test(s))) {
      return { ok: false, code: 401, error: 'invalid stripe-signature header' };
    }
    const at = Number(t), current = Number(now());
    if (!Number.isFinite(at) || Math.abs(current - at * 1000) > toleranceMs) {
      return { ok: false, code: 401, error: 'stale stripe webhook timestamp' };
    }
    const want = Buffer.from(expected(t, input.body || ''), 'hex');
    const matched = v1.some(sig => {
      const got = Buffer.from(sig.toLowerCase(), 'hex');
      return want.length === got.length && crypto.timingSafeEqual(want, got);
    });
    if (!matched) return { ok: false, code: 401, error: 'invalid stripe webhook signature' };
    return { ok: true, timestamp: at };
  }

  return { verify };
}

module.exports = { makeStripeWebhookVerifier };
