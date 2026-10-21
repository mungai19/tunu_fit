'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../server');

process.env.ADMIN_EMAIL = 'admin@tunu.test';
process.env.MPESA_CALLBACK_SECRET = 'test-secret-123';
delete process.env.MPESA_CONSUMER_KEY; // force demo mode

let a1, a2, base1, base2;
const listen = (app) => new Promise((r) => app.server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${app.server.address().port}`)));
before(async () => {
  a1 = createApp({ dbFile: ':memory:', testClock: true, minFraction: 0, demoDelayMs: 150 });
  a2 = createApp({ dbFile: ':memory:', testClock: true, minFraction: 0, demoDelayMs: 600000 });
  base1 = await listen(a1); base2 = await listen(a2);
});
after(() => { a1.close(); a2.close(); });

const WED_1100 = '2026-10-21T08:00:00Z';   // Wed 11:00 Nairobi
const WED_1745 = '2026-10-21T14:45:00Z';   // Wed 17:45 Nairobi
const SAT_1100 = '2026-10-24T08:00:00Z';

async function call(base, method, path, { body, cookie, now = WED_1100, raw } = {}) {
  const headers = { 'x-test-now': now };
  if (body !== undefined || raw) headers['Content-Type'] = 'application/json';
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(base + path, { method, headers, body: raw || (body !== undefined ? JSON.stringify(body) : undefined) });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text, cookie: (res.headers.get('set-cookie') || '').split(';')[0] };
}
async function signup(base, email, extra = {}) {
  const r = await call(base, 'POST', '/api/auth/register', { body: { name: 'Stacy Test', email, password: 'correct-horse', tz: 'Africa/Nairobi', ...extra } });
  assert.equal(r.status, 200, r.text);
  return r.cookie;
}
const slots = (days) => days.map((weekday) => ({ weekday, start_time: '18:00', minutes: 30, place: 'home' }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('static site is served, path traversal is blocked', async () => {
  const home = await fetch(base1 + '/');
  assert.equal(home.status, 200);
  assert.match(await home.text(), /Tunu Fit/);
  assert.equal((await fetch(base1 + '/app.js')).status, 200);
  const bad = await fetch(base1 + '/%2e%2e/server/db.js');
  assert.ok([403, 404].includes(bad.status), 'status ' + bad.status);
  assert.equal((await fetch(base1 + '/data/tunu.db')).status, 404);
});

test('auth: validation, duplicates, login, logout, content-type', async () => {
  assert.equal((await call(base1, 'POST', '/api/auth/register', { body: { name: 'X', email: 'bad', password: 'longenough1' } })).status, 400);
  assert.equal((await call(base1, 'POST', '/api/auth/register', { body: { name: 'Xavier', email: 'x@y.co', password: 'short' } })).status, 400);
  const cookie = await signup(base1, 'auth@tunu.test');
  assert.match(cookie, /^tunu_session=/);
  assert.equal((await call(base1, 'POST', '/api/auth/register', { body: { name: 'Dup', email: 'AUTH@tunu.test', password: 'correct-horse' } })).status, 409);
  assert.equal((await call(base1, 'POST', '/api/auth/login', { body: { email: 'auth@tunu.test', password: 'wrong-pass-1' } })).status, 401);
  const ok = await call(base1, 'POST', '/api/auth/login', { body: { email: 'auth@tunu.test', password: 'correct-horse' } });
  assert.equal(ok.status, 200);
  assert.equal((await call(base1, 'GET', '/api/me', { cookie: ok.cookie })).json.user.email, 'auth@tunu.test');
  assert.equal((await call(base1, 'GET', '/api/me')).status, 401);
  const noType = await fetch(base1 + '/api/auth/login', { method: 'POST', body: '{}' });
  assert.equal(noType.status, 415);
  await call(base1, 'POST', '/api/auth/logout', { cookie: ok.cookie, body: {} });
  assert.equal((await call(base1, 'GET', '/api/me', { cookie: ok.cookie })).status, 401);
  // no secrets leak
  const me = await call(base1, 'GET', '/api/me', { cookie });
  assert.ok(!/pass_hash|salt/.test(me.text));
});

test('full journey: availability, reminder 15 min before, check-in, +3, misses, -2', async () => {
  const cookie = await signup(base1, 'stacy@tunu.test', { phone: '0712 345 678' });
  assert.equal((await call(base1, 'GET', '/api/me', { cookie })).json.user.onboarded, false);

  // free plan: max 3 days
  assert.equal((await call(base1, 'PUT', '/api/availability', { cookie, body: { slots: slots([0, 1, 2, 3, 4]) } })).status, 402);
  assert.equal((await call(base1, 'PUT', '/api/availability', { cookie, body: { slots: [{ weekday: 2, start_time: '25:99', minutes: 30, place: 'home' }] } })).status, 400);
  const sv = await call(base1, 'PUT', '/api/availability', { cookie, body: { slots: slots([2, 3, 4]) } }); // Wed Thu Fri
  assert.equal(sv.status, 200);
  assert.equal(sv.json.user.onboarded, true);

  // dashboard before the session
  const d = await call(base1, 'GET', '/api/dashboard', { cookie });
  assert.equal(d.json.today.status, 'today');
  assert.equal(d.json.today.slot.start_time, '18:00');
  assert.equal(d.json.credit.balance, 0);

  // reminder: not at 11:00, YES at 17:45 (15 min before 18:00)
  assert.equal((await call(base1, 'GET', '/api/reminders/due', { cookie })).json.due, false);
  const rem = await call(base1, 'GET', '/api/reminders/due', { cookie, now: WED_1745 });
  assert.equal(rem.json.due, true);
  assert.equal(rem.json.minutes_until, 15);
  assert.ok(rem.json.workout);

  // check in
  const wl = await call(base1, 'GET', '/api/workouts', { cookie });
  const free = wl.json.workouts.find((w) => !w.locked);
  const locked = wl.json.workouts.find((w) => w.locked);
  assert.equal((await call(base1, 'POST', '/api/checkin/start', { cookie, body: { workout_id: locked.id } })).status, 402);
  assert.equal((await call(base1, 'POST', '/api/checkin/complete', { cookie, body: {} })).status, 409); // not started
  assert.equal((await call(base1, 'POST', '/api/checkin/start', { cookie, body: { workout_id: free.id } })).status, 200);
  const done = await call(base1, 'POST', '/api/checkin/complete', { cookie, body: {} });
  assert.equal(done.status, 200, done.text);
  assert.equal(done.json.earned, 3);
  assert.equal(done.json.credit, 3);
  assert.equal((await call(base1, 'POST', '/api/checkin/complete', { cookie, body: {} })).status, 409);
  assert.equal((await call(base1, 'GET', '/api/reminders/due', { cookie, now: WED_1745 })).json.due, false); // already done

  // skip Thursday + Friday, look on Saturday: two misses in a row => credit -2
  const sat = await call(base1, 'GET', '/api/dashboard', { cookie, now: SAT_1100 });
  assert.equal(sat.json.credit.balance, 1);
  assert.equal(sat.json.stats.workouts_completed, 1);
  const wk = sat.json.week.map((x) => x.status);
  assert.deepEqual(wk, ['rest', 'rest', 'done', 'missed', 'missed', 'rest', 'rest']);

  // progress calendar + ledger
  const pr = await call(base1, 'GET', '/api/progress?month=2026-10', { cookie, now: SAT_1100 });
  assert.equal(pr.json.counts.done, 1); assert.equal(pr.json.counts.missed, 2);
  assert.deepEqual(pr.json.ledger.map((l) => l.delta), [-2, 3]);
  assert.equal((await call(base1, 'GET', '/api/progress?month=nope', { cookie })).status, 200);
});

test('grace day and skip via API', async () => {
  const cookie = await signup(base1, 'grace@tunu.test');
  await call(base1, 'PUT', '/api/availability', { cookie, body: { slots: slots([2]) } });
  assert.equal((await call(base1, 'POST', '/api/checkin/grace', { cookie, body: {} })).json.grace_left, 1);
  const d = await call(base1, 'GET', '/api/dashboard', { cookie });
  assert.equal(d.json.today.status, 'grace');
  assert.equal((await call(base1, 'POST', '/api/checkin/grace', { cookie, body: {} })).status, 409);
  const c2 = await signup(base1, 'skip@tunu.test');
  await call(base1, 'PUT', '/api/availability', { cookie: c2, body: { slots: slots([4]) } }); // Friday only
  assert.equal((await call(base1, 'POST', '/api/checkin/skip', { cookie: c2, body: {} })).status, 400); // Wed not scheduled
});

test('subscription: M-Pesa demo checkout applies credit and activates the plan', async () => {
  const cookie = await signup(base1, 'pay@tunu.test', { phone: '0712345678' });
  await call(base1, 'PUT', '/api/availability', { cookie, body: { slots: slots([2, 3, 4]) } });
  const wl = (await call(base1, 'GET', '/api/workouts', { cookie })).json.workouts.find((w) => !w.locked);
  await call(base1, 'POST', '/api/checkin/start', { cookie, body: { workout_id: wl.id } });
  await call(base1, 'POST', '/api/checkin/complete', { cookie, body: {} });          // credit 3

  const sub = await call(base1, 'GET', '/api/subscription', { cookie });
  assert.equal(sub.json.quotes.plus.amount, 796);
  assert.equal(sub.json.demo, true);

  assert.equal((await call(base1, 'POST', '/api/subscription/checkout', { cookie, body: { plan: 'plus', phone: '12345' } })).status, 400);
  assert.equal((await call(base1, 'POST', '/api/subscription/checkout', { cookie, body: { plan: 'student', phone: '0712345678' } })).status, 403);
  assert.equal((await call(base1, 'POST', '/api/subscription/checkout', { cookie, body: { plan: 'gold', phone: '0712345678' } })).status, 400);

  const co = await call(base1, 'POST', '/api/subscription/checkout', { cookie, body: { plan: 'plus', phone: '0712345678' } });
  assert.equal(co.status, 200, co.text);
  assert.equal(co.json.payment.amount, 796);
  assert.equal(co.json.payment.credit_used, 3);
  assert.equal((await call(base1, 'GET', '/api/me', { cookie })).json.user.credit, 0);       // reserved
  assert.equal((await call(base1, 'POST', '/api/subscription/checkout', { cookie, body: { plan: 'plus', phone: '0712345678' } })).status, 409); // one at a time

  await sleep(250);
  const st = await call(base1, 'GET', `/api/payments/${co.json.payment.id}`, { cookie });
  assert.equal(st.json.payment.status, 'success');
  assert.equal(st.json.plan, 'plus');
  const me = (await call(base1, 'GET', '/api/me', { cookie })).json.user;
  assert.equal(me.plan, 'plus');
  assert.equal(me.credit, 0);
  // paid plan unlocks more days and premium workouts
  assert.equal((await call(base1, 'PUT', '/api/availability', { cookie, body: { slots: slots([0, 1, 2, 3, 4]) } })).status, 200);
  assert.ok((await call(base1, 'GET', '/api/workouts', { cookie })).json.workouts.every((w) => !w.locked));
  // another user cannot read this payment
  const other = await signup(base1, 'nosy@tunu.test');
  assert.equal((await call(base1, 'GET', `/api/payments/${co.json.payment.id}`, { cookie: other })).status, 404);
});

test('M-Pesa callback: secret required, failure returns credit, success activates, amount mismatch goes to review', async () => {
  const cookie = await signup(base2, 'cb@tunu.test', { phone: '0722000111' });
  await call(base2, 'PUT', '/api/availability', { cookie, body: { slots: slots([2]) } });
  const w = (await call(base2, 'GET', '/api/workouts', { cookie })).json.workouts.find((x) => !x.locked);
  await call(base2, 'POST', '/api/checkin/start', { cookie, body: { workout_id: w.id } });
  await call(base2, 'POST', '/api/checkin/complete', { cookie, body: {} });
  const co = await call(base2, 'POST', '/api/subscription/checkout', { cookie, body: { plan: 'plus', phone: '254722000111' } });
  assert.equal(co.status, 200);
  const pid = co.json.payment.id;
  const row = a2.db.prepare('SELECT checkout_request_id FROM payments WHERE id=?').get(pid);
  const cbBody = (code, extra = {}) => ({ Body: { stkCallback: { MerchantRequestID: 'm', CheckoutRequestID: row.checkout_request_id, ResultCode: code, ResultDesc: code === 0 ? 'ok' : 'Request cancelled by user', ...extra } } });

  assert.equal((await call(base2, 'POST', '/api/mpesa/callback/wrong-secret', { body: cbBody(0) })).status, 403);
  // customer cancelled -> payment failed, credit returned
  assert.equal((await call(base2, 'POST', '/api/mpesa/callback/test-secret-123', { body: cbBody(1032) })).status, 200);
  assert.equal((await call(base2, 'GET', `/api/payments/${pid}`, { cookie })).json.payment.status, 'failed');
  assert.equal((await call(base2, 'GET', '/api/me', { cookie })).json.user.credit, 3);

  // new attempt, wrong amount paid => review, plan not activated
  const co2 = await call(base2, 'POST', '/api/subscription/checkout', { cookie, body: { plan: 'plus', phone: '254722000111' } });
  const row2 = a2.db.prepare('SELECT checkout_request_id FROM payments WHERE id=?').get(co2.json.payment.id);
  const meta = (amount) => ({ CallbackMetadata: { Item: [{ Name: 'Amount', Value: amount }, { Name: 'MpesaReceiptNumber', Value: 'RKT123ABC' }] } });
  const body2 = (amount) => ({ Body: { stkCallback: { MerchantRequestID: 'm', CheckoutRequestID: row2.checkout_request_id, ResultCode: 0, ResultDesc: 'ok', ...meta(amount) } } });
  await call(base2, 'POST', '/api/mpesa/callback/test-secret-123', { body: body2(1) });
  assert.equal((await call(base2, 'GET', `/api/payments/${co2.json.payment.id}`, { cookie })).json.payment.status, 'review');
  assert.equal((await call(base2, 'GET', '/api/me', { cookie })).json.user.plan, 'free');
});

test('M-Pesa callback success activates the plan (and is idempotent)', async () => {
  const cookie = await signup(base2, 'cb2@tunu.test');
  const co = await call(base2, 'POST', '/api/subscription/checkout', { cookie, body: { plan: 'plus', phone: '0733000222' } });
  const row = a2.db.prepare('SELECT checkout_request_id, amount FROM payments WHERE id=?').get(co.json.payment.id);
  const body = { Body: { stkCallback: { MerchantRequestID: 'm', CheckoutRequestID: row.checkout_request_id, ResultCode: 0, ResultDesc: 'ok',
    CallbackMetadata: { Item: [{ Name: 'Amount', Value: row.amount }, { Name: 'MpesaReceiptNumber', Value: 'RKT999XYZ' }] } } } };
  await call(base2, 'POST', '/api/mpesa/callback/test-secret-123', { body });
  const exp1 = (await call(base2, 'GET', '/api/me', { cookie })).json.user.plan_expires;
  await call(base2, 'POST', '/api/mpesa/callback/test-secret-123', { body }); // duplicate delivery
  const me = (await call(base2, 'GET', '/api/me', { cookie })).json.user;
  assert.equal(me.plan, 'plus');
  assert.equal(me.plan_expires, exp1);
  assert.equal(a2.db.prepare('SELECT receipt FROM payments WHERE id=?').get(co.json.payment.id).receipt, 'RKT999XYZ');
});

test('student plan: request, admin approval, discounted checkout', async () => {
  const cookie = await signup(base1, 'stu@tunu.test', { phone: '0700111222' });
  assert.equal((await call(base1, 'POST', '/api/student/request', { cookie, body: { student_id: '1' } })).status, 400);
  assert.equal((await call(base1, 'POST', '/api/student/request', { cookie, body: { student_id: 'BBIT/1234/22' } })).json.student_status, 'pending');
  assert.equal((await call(base1, 'GET', '/api/admin/summary', { cookie })).status, 403);

  const admin = await signup(base1, 'admin@tunu.test');
  const sum = await call(base1, 'GET', '/api/admin/summary', { cookie: admin });
  assert.equal(sum.status, 200);
  const req = sum.json.pending_students.find((s) => s.email === 'stu@tunu.test');
  assert.equal(req.student_id, 'BBIT/1234/22');
  assert.equal((await call(base1, 'POST', `/api/admin/students/${req.id}/approve`, { cookie: admin, body: {} })).status, 200);

  const co = await call(base1, 'POST', '/api/subscription/checkout', { cookie, body: { plan: 'student', phone: '0700111222' } });
  assert.equal(co.status, 200, co.text);
  assert.equal(co.json.payment.amount, 399);
  await sleep(250);
  await call(base1, 'GET', `/api/payments/${co.json.payment.id}`, { cookie });
  assert.equal((await call(base1, 'GET', '/api/me', { cookie })).json.user.plan, 'student');
});
