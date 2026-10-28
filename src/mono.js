// Thin client for monobank acquiring (https://monobank.ua/api-docs/acquiring)
// plus webhook signature verification. No state except the cached public key.
// The token is read from MONO_API_TOKEN (pm2 env on the server) and is never
// logged or stored in the database.
const crypto = require('crypto');

const BASE = process.env.MONO_API_BASE || 'https://api.monobank.ua';

class MonoError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'MonoError';
    this.status = status;
    this.body = body;
  }
}

function createMono({ token = process.env.MONO_API_TOKEN, fetchImpl = globalThis.fetch, base = BASE } = {}) {
  let pubKeyB64 = null;

  const enabled = () => !!token;

  async function call(method, path, body) {
    if (!token) throw new MonoError('MONO_API_TOKEN is not set', 0);
    const res = await fetchImpl(base + path, {
      method,
      headers: { 'X-Token': token, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : {}; } catch { /* non-JSON error page */ }
    if (!res.ok) {
      const msg = (json && (json.errText || json.errCode || json.error)) || `HTTP ${res.status}`;
      throw new MonoError(`monobank: ${msg}`, res.status, json);
    }
    return json || {};
  }

  // amount in kopecks. Returns { invoiceId, pageUrl }.
  function createInvoice({ amount, reference, destination, redirectUrl, webHookUrl, validity = 3600 }) {
    return call('POST', '/api/merchant/invoice/create', {
      amount,
      ccy: 980,
      paymentType: 'debit',
      validity,
      redirectUrl,
      webHookUrl,
      merchantPaymInfo: { reference, destination },
    });
  }

  const invoiceStatus = invoiceId =>
    call('GET', '/api/merchant/invoice/status?invoiceId=' + encodeURIComponent(invoiceId));

  // Full refund when `amount` is omitted. extRef makes the request traceable on
  // monobank's side. Returns { status: processing|success|failure, ... }.
  function cancelInvoice({ invoiceId, extRef, amount }) {
    const body = { invoiceId, extRef };
    if (amount !== undefined) body.amount = amount;
    return call('POST', '/api/merchant/invoice/cancel', body);
  }

  async function fetchPubKey(force) {
    if (pubKeyB64 && !force) return pubKeyB64;
    const r = await call('GET', '/api/merchant/pubkey');
    if (!r.key) throw new MonoError('monobank: empty pubkey response', 0);
    pubKeyB64 = r.key;
    return pubKeyB64;
  }

  // The key is cached; if a signature does not verify, refetch once and retry
  // (monobank rotates it) before declaring the webhook forged.
  async function verifyWebhook(rawBody, signB64) {
    if (!rawBody || !signB64) return false;
    if (verifySignature(await fetchPubKey(false), signB64, rawBody)) return true;
    return verifySignature(await fetchPubKey(true), signB64, rawBody);
  }

  return { enabled, createInvoice, invoiceStatus, cancelInvoice, fetchPubKey, verifyWebhook };
}

// pubKeyB64: base64 of the PEM (or DER) X.509 ECDSA public key.
// signB64: base64 of the DER-encoded ECDSA signature over SHA-256(rawBody).
function verifySignature(pubKeyB64, signB64, rawBody) {
  try {
    const raw = Buffer.from(pubKeyB64, 'base64');
    const text = raw.toString('utf8');
    const key = text.includes('BEGIN')
      ? crypto.createPublicKey(text)
      : crypto.createPublicKey({ key: raw, format: 'der', type: 'spki' });
    return crypto.verify('sha256', rawBody, { key, dsaEncoding: 'der' }, Buffer.from(signB64, 'base64'));
  } catch {
    return false;
  }
}

module.exports = { createMono, verifySignature, MonoError };
