'use strict';
// Safaricom Daraja (M-Pesa Express / STK Push).
// If MPESA_CONSUMER_KEY is not set the app runs in DEMO mode: no request leaves your machine
// and a payment "succeeds" a few seconds after it is started. Demo payments move no money.

function config() {
  const e = process.env;
  const env = (e.MPESA_ENV || 'sandbox').toLowerCase() === 'production' ? 'production' : 'sandbox';
  return {
    key: e.MPESA_CONSUMER_KEY || '',
    secret: e.MPESA_CONSUMER_SECRET || '',
    shortcode: e.MPESA_SHORTCODE || '',
    passkey: e.MPESA_PASSKEY || '',
    // CustomerPayBillOnline for Paybill, CustomerBuyGoodsOnline for a Till number
    txType: e.MPESA_TRANSACTION_TYPE || 'CustomerPayBillOnline',
    // For a Till, PartyB is the till number (MPESA_TILL) while BusinessShortCode stays the store/HO number
    partyB: e.MPESA_PARTY_B || e.MPESA_SHORTCODE || '',
    callbackBase: (e.PUBLIC_URL || '').replace(/\/+$/, ''),
    callbackSecret: e.MPESA_CALLBACK_SECRET || '',
    base: env === 'production' ? 'https://api.safaricom.co.ke' : 'https://sandbox.safaricom.co.ke',
    env,
  };
}

function isDemo() {
  return !config().key;
}

function assertReady(c) {
  const missing = [];
  if (!c.secret) missing.push('MPESA_CONSUMER_SECRET');
  if (!c.shortcode) missing.push('MPESA_SHORTCODE');
  if (!c.passkey) missing.push('MPESA_PASSKEY');
  if (!c.callbackBase) missing.push('PUBLIC_URL');
  if (!c.callbackSecret) missing.push('MPESA_CALLBACK_SECRET');
  if (missing.length) throw new Error('M-Pesa is not fully configured. Missing: ' + missing.join(', '));
  if (!/^https:\/\//.test(c.callbackBase)) throw new Error('PUBLIC_URL must be a public https:// address (use ngrok while testing).');
}

let tokenCache = { value: '', exp: 0 };

async function getToken(c) {
  if (tokenCache.value && Date.now() < tokenCache.exp) return tokenCache.value;
  const auth = Buffer.from(`${c.key}:${c.secret}`).toString('base64');
  const r = await fetch(`${c.base}/oauth/v1/generate?grant_type=client_credentials`, {
    headers: { Authorization: `Basic ${auth}` },
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw new Error(`Daraja auth failed (${r.status})`);
  const j = await r.json();
  tokenCache = { value: j.access_token, exp: Date.now() + (Number(j.expires_in || 3500) - 60) * 1000 };
  return tokenCache.value;
}

function timestamp() {
  // YYYYMMDDHHmmss in Nairobi time
  return new Date().toLocaleString('sv-SE', { timeZone: 'Africa/Nairobi' }).replace(/[-: ]/g, '');
}

function password(c, ts) {
  return Buffer.from(`${c.shortcode}${c.passkey}${ts}`).toString('base64');
}

async function stkPush({ phone, amount, reference, description }) {
  const c = config();
  if (!c.key) {
    const id = 'DEMO-' + Math.random().toString(36).slice(2, 10).toUpperCase();
    return { demo: true, checkoutRequestId: id, merchantRequestId: id };
  }
  assertReady(c);
  const ts = timestamp();
  const body = {
    BusinessShortCode: c.shortcode,
    Password: password(c, ts),
    Timestamp: ts,
    TransactionType: c.txType,
    Amount: amount,
    PartyA: phone,
    PartyB: c.partyB,
    PhoneNumber: phone,
    CallBackURL: `${c.callbackBase}/api/mpesa/callback/${c.callbackSecret}`,
    AccountReference: String(reference).slice(0, 12),
    TransactionDesc: String(description).slice(0, 13),
  };
  const r = await fetch(`${c.base}/mpesa/stkpush/v1/processrequest`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${await getToken(c)}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || String(j.ResponseCode) !== '0') {
    throw new Error(j.errorMessage || j.ResponseDescription || `Daraja error (${r.status})`);
  }
  return { demo: false, checkoutRequestId: j.CheckoutRequestID, merchantRequestId: j.MerchantRequestID };
}

// Returns { state: 'pending' | 'success' | 'failed', desc }
async function stkQuery(checkoutRequestId) {
  const c = config();
  assertReady(c);
  const ts = timestamp();
  const r = await fetch(`${c.base}/mpesa/stkpushquery/v1/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${await getToken(c)}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      BusinessShortCode: c.shortcode, Password: password(c, ts), Timestamp: ts, CheckoutRequestID: checkoutRequestId,
    }),
    signal: AbortSignal.timeout(15000),
  });
  const j = await r.json().catch(() => ({}));
  if (j.ResultCode === undefined) return { state: 'pending', desc: j.errorMessage || 'Processing' };
  return String(j.ResultCode) === '0'
    ? { state: 'success', desc: j.ResultDesc }
    : { state: 'failed', desc: j.ResultDesc };
}

// Parse the body Safaricom POSTs to the callback URL
function parseCallback(body) {
  const cb = body && body.Body && body.Body.stkCallback;
  if (!cb || !cb.CheckoutRequestID) return null;
  const items = (cb.CallbackMetadata && cb.CallbackMetadata.Item) || [];
  const get = (n) => (items.find((i) => i.Name === n) || {}).Value;
  return {
    checkoutRequestId: String(cb.CheckoutRequestID),
    ok: Number(cb.ResultCode) === 0,
    desc: String(cb.ResultDesc || ''),
    receipt: get('MpesaReceiptNumber') ? String(get('MpesaReceiptNumber')) : null,
    amount: get('Amount') !== undefined ? Number(get('Amount')) : null,
  };
}

// 07xx / 01xx / +2547xx / 2547xx -> 2547XXXXXXXX
function normalizePhone(input) {
  const s = String(input || '').replace(/[\s\-()]/g, '').replace(/^\+/, '');
  let m = s;
  if (/^0[17]\d{8}$/.test(s)) m = '254' + s.slice(1);
  return /^254[17]\d{8}$/.test(m) ? m : null;
}

module.exports = { isDemo, stkPush, stkQuery, parseCallback, normalizePhone, config };
