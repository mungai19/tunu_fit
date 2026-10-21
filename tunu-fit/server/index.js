'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { open, tx } = require('./db');
const L = require('./logic');
const mpesa = require('./mpesa');

const scrypt = promisify(crypto.scrypt);
const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const { HttpError, RULES, PRICES } = L;
const DEMO_DELAY_MS = 5000;
const PENDING_TTL_MS = 10 * 60 * 1000;

function loadEnv() {
  const f = path.join(ROOT, '.env');
  if (!fs.existsSync(f)) return;
  for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
    if (/^\s*#/.test(line)) continue;
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    const val = m[2].replace(/\s+#.*$/, '').replace(/^["']|["']$/g, ''); // drop trailing "# comment"
    if (process.env[m[1]] === undefined) process.env[m[1]] = val;
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json',
};

function createApp(opts = {}) {
  const dbFile = opts.dbFile || process.env.DB_FILE || path.join(ROOT, 'data', 'tunu.db');
  const allowTestClock = !!opts.testClock;           // lets tests send an `x-test-now` header
  const minFraction = opts.minFraction !== undefined ? opts.minFraction : RULES.MIN_FRACTION;
  const demoDelay = opts.demoDelayMs !== undefined ? opts.demoDelayMs : DEMO_DELAY_MS;
  const db = open(dbFile);
  const adminEmail = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const attempts = new Map();                        // naive login rate limit

  // ------------------------------------------------------------------ helpers
  const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
  const nowOf = (req) => {
    if (allowTestClock && req.headers['x-test-now']) {
      const t = Date.parse(req.headers['x-test-now']);
      if (!Number.isNaN(t)) return t;
    }
    return Date.now();
  };

  function send(res, status, data, headers = {}) {
    const body = typeof data === 'string' ? data : JSON.stringify(data);
    res.writeHead(status, {
      'Content-Type': typeof data === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...headers,
    });
    res.end(body);
  }

  function readJson(req, limit = 100_000) {
    return new Promise((resolve, reject) => {
      let size = 0; const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > limit) { reject(new HttpError(413, 'Request too large.')); req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', () => {
        if (!chunks.length) return resolve({});
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { reject(new HttpError(400, 'Invalid JSON.')); }
      });
      req.on('error', reject);
    });
  }

  function cookies(req) {
    const out = {};
    for (const part of (req.headers.cookie || '').split(';')) {
      const i = part.indexOf('=');
      if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    }
    return out;
  }

  function sessionCookie(req, token, maxAge) {
    const secure = process.env.COOKIE_SECURE === '1' || req.headers['x-forwarded-proto'] === 'https';
    return `tunu_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
  }

  const isAdmin = (u) => !!adminEmail && u.email === adminEmail;

  function publicUser(u, nowMs) {
    const t = L.tzParts(nowMs, u.tz);
    return {
      id: u.id, name: u.name, email: u.email, phone: u.phone, tz: u.tz,
      mode: u.mode, goal: u.goal, level: u.level,
      plan: L.effectivePlan(u, nowMs), plan_expires: u.plan_expires,
      student_status: u.student_status, credit: u.credit,
      grace_left: L.graceLeft(u, t.month), onboarded: !!u.onboarded, is_admin: isAdmin(u),
    };
  }

  async function authUser(req, nowMs) {
    const token = cookies(req).tunu_session;
    if (!token) return null;
    const s = db.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(sha(token));
    if (!s) return null;
    if (s.expires_at < Date.now()) { db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(s.token_hash); return null; }
    let u = L.getUser(db, s.user_id);
    if (!u) return null;
    L.settle(db, u.id, L.tzParts(nowMs, u.tz).date);
    return L.getUser(db, u.id);
  }

  function clean(str, max) {
    return String(str ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
  }

  function rateLimit(key, max = 10, windowMs = 15 * 60 * 1000) {
    const now = Date.now();
    const rec = (attempts.get(key) || []).filter((t) => now - t < windowMs);
    if (rec.length >= max) throw new HttpError(429, 'Too many attempts. Please wait a few minutes and try again.');
    rec.push(now); attempts.set(key, rec);
    if (attempts.size > 5000) attempts.clear();
  }

  async function hashPassword(pw, salt) {
    return (await scrypt(pw, salt, 64)).toString('hex');
  }

  async function startSession(req, res, uid) {
    const token = crypto.randomBytes(32).toString('hex');
    const ttl = 30 * 24 * 3600 * 1000;
    db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?,?,?)').run(sha(token), uid, Date.now() + ttl);
    return sessionCookie(req, token, ttl / 1000);
  }

  // ------------------------------------------------------------------ payments
  function activatePlan(p, receipt, desc, wasExpired) {
    tx(db, () => {
      const u = L.getUser(db, p.user_id);
      const base = Math.max(u.plan_expires, Date.now());
      db.prepare('UPDATE users SET plan = ?, plan_expires = ? WHERE id = ?')
        .run(p.plan, base + RULES.PLAN_DAYS * 86400000, u.id);
      db.prepare(`UPDATE payments SET status = 'success', receipt = ?, result_desc = ? WHERE id = ?`)
        .run(receipt, desc, p.id);
      // credit was returned when the payment expired; take it again now that the payment really went through
      if (wasExpired && p.credit_used > 0) {
        L.adjustCredit(db, u.id, -p.credit_used, 'Credit used on renewal', L.tzParts(Date.now(), u.tz).date);
      }
    });
  }

  function failPayment(p, status, desc) {
    tx(db, () => {
      const r = db.prepare(`UPDATE payments SET status = ?, result_desc = ? WHERE id = ? AND status = 'pending'`).run(status, desc, p.id);
      if (r.changes > 0 && p.credit_used > 0) {
        const u = L.getUser(db, p.user_id);
        L.adjustCredit(db, u.id, p.credit_used, 'Credit returned (payment not completed)', L.tzParts(Date.now(), u.tz).date);
      }
    });
  }

  function succeedPayment(p, receipt, desc, amountPaid) {
    const fresh = db.prepare('SELECT * FROM payments WHERE id = ?').get(p.id);
    if (fresh.status === 'success') return;
    if (amountPaid !== null && amountPaid !== undefined && Number(amountPaid) !== fresh.amount) {
      db.prepare(`UPDATE payments SET status = 'review', receipt = ?, result_desc = ? WHERE id = ?`)
        .run(receipt, `Amount mismatch: expected ${fresh.amount}, got ${amountPaid}`, fresh.id);
      return;
    }
    if (fresh.status === 'pending') activatePlan(fresh, receipt, desc, false);
    else if (fresh.status === 'expired' || fresh.status === 'failed') activatePlan(fresh, receipt, desc, true);
  }

  async function refreshPayment(p) {
    if (p.status !== 'pending') return p;
    const age = Date.now() - p.created_at;
    if (p.demo) {
      if (age >= demoDelay) succeedPayment(p, 'DEMO' + p.id.toString().padStart(6, '0'), 'Demo payment (no money moved)', null);
    } else if (age > 20000 && Date.now() - p.last_query_at > 10000) {
      db.prepare('UPDATE payments SET last_query_at = ? WHERE id = ?').run(Date.now(), p.id);
      try {
        const q = await mpesa.stkQuery(p.checkout_request_id);
        if (q.state === 'success') succeedPayment(p, null, q.desc, null);
        else if (q.state === 'failed') failPayment(p, 'failed', q.desc);
      } catch { /* the callback may still arrive; keep waiting */ }
    }
    const cur = db.prepare('SELECT * FROM payments WHERE id = ?').get(p.id);
    if (cur.status === 'pending' && Date.now() - cur.created_at > PENDING_TTL_MS) failPayment(cur, 'expired', 'No response from M-Pesa');
    return db.prepare('SELECT * FROM payments WHERE id = ?').get(p.id);
  }

  const publicPayment = (p) => ({
    id: p.id, plan: p.plan, amount: p.amount, credit_used: p.credit_used, list_price: p.list_price,
    status: p.status, receipt: p.receipt, message: p.result_desc, demo: !!p.demo,
  });

  // ------------------------------------------------------------------ routes
  const routes = [];
  const route = (method, pattern, opts, handler) => routes.push({ method, re: new RegExp(`^${pattern}$`), opts, handler });

  route('GET', '/api/config', { auth: false }, async () => ({
    mpesa_demo: mpesa.isDemo(),
    prices: PRICES,
    rules: {
      earn: RULES.EARN, penalty: RULES.PENALTY, penalty_every: RULES.PENALTY_EVERY,
      grace_per_month: RULES.GRACE_PER_MONTH, reminder_lead: RULES.REMINDER_LEAD, free_max_days: L.FREE_MAX_DAYS,
      min_fraction: minFraction,
    },
  }));

  route('POST', '/api/auth/register', { auth: false }, async ({ req, res, body, now }) => {
    rateLimit('reg:' + req.socket.remoteAddress, 20);
    const name = clean(body.name, 60);
    const email = clean(body.email, 120).toLowerCase();
    const password = String(body.password || '');
    if (name.length < 2) throw new HttpError(400, 'Please enter your name.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) throw new HttpError(400, 'Please enter a valid email address.');
    if (password.length < 8 || password.length > 200) throw new HttpError(400, 'Password must be at least 8 characters.');
    const tz = L.validTz(body.tz) ? body.tz : 'Africa/Nairobi';
    let phone = null;
    if (body.phone) {
      phone = mpesa.normalizePhone(body.phone);
      if (!phone) throw new HttpError(400, 'Enter your phone as 07XXXXXXXX or 2547XXXXXXXX.');
    }
    if (db.prepare('SELECT id FROM users WHERE email = ?').get(email)) {
      throw new HttpError(409, 'An account with this email already exists. Try logging in.');
    }
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = await hashPassword(password, salt);
    const today = L.tzParts(now, tz).date;
    const r = db.prepare(`INSERT INTO users (name, email, pass_hash, salt, phone, tz, created_date, last_settled, created_at)
                          VALUES (?,?,?,?,?,?,?,?,?)`).run(name, email, hash, salt, phone, tz, today, today, Date.now());
    const cookie = await startSession(req, res, Number(r.lastInsertRowid));
    return { __headers: { 'Set-Cookie': cookie }, user: publicUser(L.getUser(db, Number(r.lastInsertRowid)), now) };
  });

  route('POST', '/api/auth/login', { auth: false }, async ({ req, res, body, now }) => {
    const email = clean(body.email, 120).toLowerCase();
    rateLimit(`login:${req.socket.remoteAddress}:${email}`, 10);
    const u = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    const salt = u ? u.salt : 'x'.repeat(32);
    const hash = await hashPassword(String(body.password || ''), salt);
    const ok = u && crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(u.pass_hash, 'hex'));
    if (!ok) throw new HttpError(401, 'Incorrect email or password.');
    attempts.delete(`login:${req.socket.remoteAddress}:${email}`);
    const cookie = await startSession(req, res, u.id);
    L.settle(db, u.id, L.tzParts(now, u.tz).date);
    return { __headers: { 'Set-Cookie': cookie }, user: publicUser(L.getUser(db, u.id), now) };
  });

  route('POST', '/api/auth/logout', { auth: false }, async ({ req }) => {
    const token = cookies(req).tunu_session;
    if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha(token));
    return { __headers: { 'Set-Cookie': sessionCookie(req, '', 0) }, ok: true };
  });

  route('GET', '/api/me', { auth: true }, async ({ user, now }) => ({ user: publicUser(user, now) }));

  route('PUT', '/api/me/profile', { auth: true }, async ({ user, body, now }) => {
    const mode = ['home', 'gym', 'both'].includes(body.mode) ? body.mode : user.mode;
    const level = ['beginner', 'intermediate', 'advanced'].includes(body.level) ? body.level : user.level;
    const goal = ['consistency', 'lose_weight', 'build_muscle', 'stay_active', 'strength'].includes(body.goal) ? body.goal : user.goal;
    const name = body.name !== undefined ? clean(body.name, 60) : user.name;
    if (name.length < 2) throw new HttpError(400, 'Please enter your name.');
    let phone = user.phone;
    if (body.phone !== undefined) {
      if (body.phone === '' || body.phone === null) phone = null;
      else {
        phone = mpesa.normalizePhone(body.phone);
        if (!phone) throw new HttpError(400, 'Enter your phone as 07XXXXXXXX or 2547XXXXXXXX.');
      }
    }
    const tz = body.tz && L.validTz(body.tz) ? body.tz : user.tz;
    db.prepare('UPDATE users SET name=?, mode=?, level=?, goal=?, phone=?, tz=? WHERE id=?').run(name, mode, level, goal, phone, tz, user.id);
    // keep schedule places consistent with the chosen mode
    if (mode !== 'both') db.prepare('UPDATE availability SET place = ? WHERE user_id = ?').run(mode, user.id);
    return { user: publicUser(L.getUser(db, user.id), now) };
  });

  route('GET', '/api/availability', { auth: true }, async ({ user }) => ({
    slots: Object.values(L.getSlots(db, user.id)).map(({ weekday, start_time, minutes, place }) => ({ weekday, start_time, minutes, place })),
  }));

  route('PUT', '/api/availability', { auth: true }, async ({ user, body, now }) => {
    const input = Array.isArray(body.slots) ? body.slots : [];
    const seen = new Set(); const rows = [];
    for (const s of input) {
      const wd = Number(s.weekday);
      if (!Number.isInteger(wd) || wd < 0 || wd > 6 || seen.has(wd)) throw new HttpError(400, 'Invalid day in schedule.');
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(s.start_time))) throw new HttpError(400, 'Choose a valid start time for each day.');
      const minutes = Number(s.minutes);
      if (![10, 15, 20, 30, 45, 60, 90].includes(minutes)) throw new HttpError(400, 'Choose a valid workout length.');
      let place = ['home', 'gym'].includes(s.place) ? s.place : 'home';
      if (user.mode !== 'both') place = user.mode;
      seen.add(wd); rows.push({ wd, start: s.start_time, minutes, place });
    }
    if (L.effectivePlan(user, now) === 'free' && rows.length > L.FREE_MAX_DAYS) {
      throw new HttpError(402, `The free plan covers up to ${L.FREE_MAX_DAYS} workout days a week. Upgrade to schedule more.`);
    }
    tx(db, () => {
      db.prepare('DELETE FROM availability WHERE user_id = ?').run(user.id);
      const ins = db.prepare('INSERT INTO availability (user_id, weekday, start_time, minutes, place) VALUES (?,?,?,?,?)');
      for (const r of rows) ins.run(user.id, r.wd, r.start, r.minutes, r.place);
      db.prepare('UPDATE users SET onboarded = 1 WHERE id = ?').run(user.id);
    });
    return { ok: true, days: rows.length, user: publicUser(L.getUser(db, user.id), now) };
  });

  route('GET', '/api/workouts', { auth: true }, async ({ user, now, url }) => {
    const place = url.searchParams.get('place');
    const plan = L.effectivePlan(user, now);
    const rows = db.prepare('SELECT * FROM workouts ORDER BY place, premium, minutes').all()
      .filter((w) => (user.mode === 'both' ? true : w.place === user.mode))
      .filter((w) => !place || w.place === place);
    return {
      workouts: rows.map((w) => ({ ...w, exercises: JSON.parse(w.exercises), locked: !!w.premium && plan === 'free' })),
    };
  });

  route('GET', '/api/dashboard', { auth: true }, async ({ user, now }) => ({
    user: publicUser(user, now), ...L.buildDashboard(db, user, now),
  }));

  route('GET', '/api/progress', { auth: true }, async ({ user, now, url }) => {
    let month = url.searchParams.get('month');
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month || '')) month = L.tzParts(now, user.tz).month;
    return L.buildProgress(db, user, now, month);
  });

  route('GET', '/api/reminders/due', { auth: true }, async ({ user, now }) => L.reminderDue(db, user, now));

  route('POST', '/api/checkin/start', { auth: true }, async ({ user, body, now }) => {
    const today = L.tzParts(now, user.tz).date;
    const r = L.startWorkout(db, user, today, Number(body.workout_id), now);
    return { started_at: r.started_at, workout: r.workout, server_now: now };
  });

  route('POST', '/api/checkin/complete', { auth: true }, async ({ user, now }) => {
    const today = L.tzParts(now, user.tz).date;
    const r = L.finishWorkout(db, user, today, now, minFraction);
    const fresh = L.getUser(db, user.id);
    return { earned: r.earned, credit: fresh.credit, stats: L.computeStats(db, fresh, today) };
  });

  route('POST', '/api/checkin/grace', { auth: true }, async ({ user, now }) => {
    const t = L.tzParts(now, user.tz);
    return L.useGrace(db, user, t.date, t.month);
  });

  route('POST', '/api/checkin/skip', { auth: true }, async ({ user, now }) => {
    L.skipToday(db, user, L.tzParts(now, user.tz).date);
    return { ok: true };
  });

  route('GET', '/api/subscription', { auth: true }, async ({ user, now }) => {
    const plan = L.effectivePlan(user, now);
    const open = db.prepare(`SELECT * FROM payments WHERE user_id = ? AND status = 'pending' ORDER BY id DESC LIMIT 1`).get(user.id);
    const history = db.prepare('SELECT * FROM payments WHERE user_id = ? ORDER BY id DESC LIMIT 10').all(user.id).map(publicPayment);
    return {
      plan, plan_expires: user.plan_expires, student_status: user.student_status, credit: user.credit,
      quotes: { plus: L.quote(user, 'plus', now), student: L.quote(user, 'student', now) },
      pending: open ? publicPayment(open) : null,
      history, demo: mpesa.isDemo(), phone: user.phone,
    };
  });

  route('POST', '/api/subscription/checkout', { auth: true }, async ({ user, body, now }) => {
    const plan = String(body.plan || '');
    if (!PRICES[plan]) throw new HttpError(400, 'Choose a plan.');
    if (plan === 'student' && user.student_status !== 'verified') {
      throw new HttpError(403, 'Your student status is not verified yet.');
    }
    const phone = mpesa.normalizePhone(body.phone);
    if (!phone) throw new HttpError(400, 'Enter your M-Pesa number as 07XXXXXXXX or 2547XXXXXXXX.');

    for (const p of db.prepare(`SELECT * FROM payments WHERE user_id = ? AND status = 'pending'`).all(user.id)) {
      const cur = await refreshPayment(p);
      if (cur.status === 'pending' && Date.now() - cur.created_at < 90000) {
        throw new HttpError(409, 'A payment is already in progress. Check your phone, or wait a minute and try again.');
      }
      if (cur.status === 'pending') failPayment(cur, 'expired', 'Replaced by a new attempt');
    }

    const fresh = L.getUser(db, user.id);
    const q = L.quote(fresh, plan, now);
    const today = L.tzParts(now, fresh.tz).date;
    const id = tx(db, () => {
      const r = db.prepare(`INSERT INTO payments (user_id, plan, list_price, credit_used, amount, phone, demo, created_at)
                            VALUES (?,?,?,?,?,?,?,?)`).run(fresh.id, plan, q.price, q.credit_used, q.amount, phone, mpesa.isDemo() ? 1 : 0, Date.now());
      if (q.credit_used > 0) L.adjustCredit(db, fresh.id, -q.credit_used, 'Credit reserved for renewal', today);
      return Number(r.lastInsertRowid);
    });
    let p = db.prepare('SELECT * FROM payments WHERE id = ?').get(id);
    try {
      const s = await mpesa.stkPush({ phone, amount: q.amount, reference: `TUNU${fresh.id}`, description: 'Tunu Fit' });
      db.prepare('UPDATE payments SET checkout_request_id = ?, merchant_request_id = ? WHERE id = ?')
        .run(s.checkoutRequestId, s.merchantRequestId, id);
    } catch (e) {
      failPayment(p, 'failed', e.message);
      throw new HttpError(502, `Could not send the M-Pesa prompt: ${e.message}`);
    }
    p = db.prepare('SELECT * FROM payments WHERE id = ?').get(id);
    return { payment: publicPayment(p), message: mpesa.isDemo() ? 'Demo mode: confirming in a few seconds.' : 'Check your phone and enter your M-Pesa PIN.' };
  });

  route('GET', '/api/payments/(\\d+)', { auth: true }, async ({ user, params }) => {
    const p = db.prepare('SELECT * FROM payments WHERE id = ? AND user_id = ?').get(Number(params[0]), user.id);
    if (!p) throw new HttpError(404, 'Payment not found.');
    const cur = await refreshPayment(p);
    const fresh = L.getUser(db, user.id);
    return { payment: publicPayment(cur), credit: fresh.credit, plan: L.effectivePlan(fresh, Date.now()) };
  });

  route('POST', '/api/student/request', { auth: true }, async ({ user, body }) => {
    const sid = clean(body.student_id, 40);
    if (sid.length < 4) throw new HttpError(400, 'Enter your student ID / admission number.');
    if (user.student_status === 'verified') return { student_status: 'verified' };
    db.prepare(`UPDATE users SET student_status = 'pending', student_id = ? WHERE id = ?`).run(sid, user.id);
    return { student_status: 'pending' };
  });

  // M-Pesa calls this URL after the customer answers the prompt. The secret in the path stops random callers.
  route('POST', '/api/mpesa/callback/([A-Za-z0-9_-]+)', { auth: false, json: false }, async ({ body, params }) => {
    const want = Buffer.from(mpesa.config().callbackSecret || '\u0000nope');
    const got = Buffer.from(params[0]);
    if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) throw new HttpError(403, 'Forbidden');
    const cb = mpesa.parseCallback(body);
    if (cb) {
      const p = db.prepare('SELECT * FROM payments WHERE checkout_request_id = ?').get(cb.checkoutRequestId);
      if (p) {
        if (cb.ok) succeedPayment(p, cb.receipt, cb.desc, cb.amount);
        else failPayment(p, 'failed', cb.desc);
      }
    }
    return { ResultCode: 0, ResultDesc: 'Accepted' };
  });

  // ---- admin
  const requireAdmin = (u) => { if (!isAdmin(u)) throw new HttpError(403, 'Admins only.'); };

  route('GET', '/api/admin/summary', { auth: true }, async ({ user, now }) => {
    requireAdmin(user);
    const n = (sql, ...a) => db.prepare(sql).get(...a).n;
    return {
      users: n('SELECT COUNT(*) AS n FROM users'),
      paying: n(`SELECT COUNT(*) AS n FROM users WHERE plan != 'free' AND plan_expires > ?`, now),
      revenue: n(`SELECT COALESCE(SUM(amount),0) AS n FROM payments WHERE status = 'success' AND demo = 0`),
      credit_owed: n('SELECT COALESCE(SUM(credit),0) AS n FROM users'),
      pending_students: db.prepare(`SELECT id, name, email, student_id FROM users WHERE student_status = 'pending' ORDER BY id`).all(),
      review_payments: db.prepare(`SELECT id, user_id, amount, receipt, result_desc FROM payments WHERE status = 'review'`).all(),
      recent_payments: db.prepare(`SELECT p.id, u.email, p.plan, p.amount, p.status, p.demo, p.receipt FROM payments p JOIN users u ON u.id = p.user_id ORDER BY p.id DESC LIMIT 15`).all(),
    };
  });

  route('POST', '/api/admin/students/(\\d+)/(approve|reject)', { auth: true }, async ({ user, params }) => {
    requireAdmin(user);
    const status = params[1] === 'approve' ? 'verified' : 'none';
    const r = db.prepare(`UPDATE users SET student_status = ? WHERE id = ? AND student_status = 'pending'`).run(status, Number(params[0]));
    if (!r.changes) throw new HttpError(404, 'No pending request for that user.');
    return { ok: true };
  });

  // ------------------------------------------------------------------ static files
  function serveStatic(req, res, pathname) {
    let rel = pathname === '/' ? '/index.html' : pathname;
    let file;
    try { file = path.normalize(path.join(PUBLIC, decodeURIComponent(rel))); } catch { return send(res, 400, 'Bad request'); }
    if (!file.startsWith(PUBLIC + path.sep)) return send(res, 403, 'Forbidden');
    fs.readFile(file, (err, data) => {
      if (err) {
        if (path.extname(rel)) return send(res, 404, 'Not found');
        return fs.readFile(path.join(PUBLIC, 'index.html'), (e2, d2) => (e2 ? send(res, 404, 'Not found') : res.writeHead(200, htmlHeaders()).end(d2)));
      }
      const ext = path.extname(file).toLowerCase();
      res.writeHead(200, ext === '.html' ? htmlHeaders() : { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(data);
    });
  }

  const SECURITY = {
    'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    'X-Frame-Options': 'DENY',
  };
  const htmlHeaders = () => ({ 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache', ...SECURITY });

  // ------------------------------------------------------------------ server
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (!url.pathname.startsWith('/api/')) {
        if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
        return serveStatic(req, res, url.pathname);
      }
      const now = nowOf(req);
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = url.pathname.match(r.re);
        if (!m) continue;
        let body = {};
        if (req.method !== 'GET') {
          if (r.opts.json !== false && !String(req.headers['content-type'] || '').startsWith('application/json')) {
            throw new HttpError(415, 'Content-Type must be application/json.');
          }
          body = await readJson(req);
        }
        const user = r.opts.auth ? await authUser(req, now) : null;
        if (r.opts.auth && !user) throw new HttpError(401, 'Please log in.');
        const out = await r.handler({ req, res, user, body, now, url, params: m.slice(1) });
        const { __headers, ...data } = out || {};
        return send(res, 200, data, { ...SECURITY, ...(__headers || {}) });
      }
      throw new HttpError(404, 'Not found.');
    } catch (e) {
      if (e instanceof HttpError) return send(res, e.status, { error: e.message }, SECURITY);
      console.error(e);
      send(res, 500, { error: 'Something went wrong on our side. Please try again.' }, SECURITY);
    }
  });

  return { server, db, close: () => { server.close(); try { db.close(); } catch { /* ignore */ } } };
}

if (require.main === module) {
  loadEnv();
  const port = Number(process.env.PORT || 3000);
  const app = createApp();
  app.server.listen(port, () => {
    console.log(`\n  TUNU FIT running at http://localhost:${port}`);
    console.log(`  M-Pesa: ${mpesa.isDemo() ? 'DEMO mode (no real money moves). Add Daraja keys in .env to go live.' : 'Daraja ' + mpesa.config().env}`);
    if (!process.env.ADMIN_EMAIL) console.log('  Tip: set ADMIN_EMAIL in .env to unlock the admin tab (student approvals, payments).');
    console.log('');
  });
}

module.exports = { createApp };
