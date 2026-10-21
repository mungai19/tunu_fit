'use strict';
const { tx } = require('./db');

// ---------------------------------------------------------------------------
// Rules (change these numbers to change the product)
// ---------------------------------------------------------------------------
const RULES = {
  EARN: 3,               // KSh off the subscription for every committed workout completed
  PENALTY: 2,            // KSh added back...
  PENALTY_EVERY: 2,      // ...for every 2 consecutive committed workouts missed
  GRACE_PER_MONTH: 2,    // excused days per month (no penalty, streak protected)
  REMINDER_LEAD: 15,     // minutes before the workout that the pop-up appears
  MIN_PAY: 10,           // never charge less than this (KSh) on a renewal
  MAX_DISCOUNT_PCT: 0.4, // credit can cover at most 40% of a renewal
  MIN_FRACTION: 0.5,     // must spend at least this share of the workout's time before checking in
  PLAN_DAYS: 30,
};
const PRICES = { plus: 799, student: 399 };
const FREE_MAX_DAYS = 3;

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// ---------------------------------------------------------------------------
// Date helpers (all "days" are the user's own local calendar days)
// ---------------------------------------------------------------------------
function validTz(tz) {
  try { new Intl.DateTimeFormat('en-GB', { timeZone: tz }); return true; } catch { return false; }
}

function tzParts(ms, tz) {
  const f = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  const p = {};
  for (const x of f.formatToParts(new Date(ms))) p[x.type] = x.value;
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    month: `${p.year}-${p.month}`,
    minutes: Number(p.hour) * 60 + Number(p.minute),
  };
}

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Monday = 0 ... Sunday = 6
function weekdayOf(dateStr) {
  return (new Date(dateStr + 'T00:00:00Z').getUTCDay() + 6) % 7;
}

function dayNumber(dateStr) {
  return Math.floor(new Date(dateStr + 'T00:00:00Z').getTime() / 86400000);
}

function hmToMinutes(hm) {
  const [h, m] = hm.split(':').map(Number);
  return h * 60 + m;
}

// ---------------------------------------------------------------------------
// Accessors
// ---------------------------------------------------------------------------
const getUser = (db, id) => db.prepare('SELECT * FROM users WHERE id = ?').get(id);

function getSlots(db, uid) {
  const rows = db.prepare('SELECT * FROM availability WHERE user_id = ? ORDER BY weekday').all(uid);
  const byDay = {};
  for (const r of rows) byDay[r.weekday] = { ...r };
  return byDay;
}

function effectivePlan(u, nowMs) {
  return u.plan !== 'free' && u.plan_expires > nowMs ? u.plan : 'free';
}

function graceLeft(u, month) {
  return u.grace_month === month ? Math.max(0, RULES.GRACE_PER_MONTH - u.grace_used) : RULES.GRACE_PER_MONTH;
}

// ---------------------------------------------------------------------------
// Credit ledger: the balance can never go below 0 and every change is logged
// ---------------------------------------------------------------------------
function adjustCredit(db, uid, delta, reason, date) {
  const u = db.prepare('SELECT credit FROM users WHERE id = ?').get(uid);
  let applied = delta;
  if (u.credit + delta < 0) applied = -u.credit;
  if (applied === 0) return 0;
  const balance = u.credit + applied;
  db.prepare('UPDATE users SET credit = ? WHERE id = ?').run(balance, uid);
  db.prepare('INSERT INTO ledger (user_id, date, delta, reason, balance_after, created_at) VALUES (?,?,?,?,?,?)')
    .run(uid, date, applied, reason, balance, Date.now());
  return applied;
}

// ---------------------------------------------------------------------------
// Settlement: process every finished committed day we have not looked at yet.
// Runs lazily on each authenticated request, so no cron job is needed.
//   done        -> resets the "missed in a row" counter (the +3 was paid at check-in)
//   grace       -> excused: nothing happens, streak is protected
//   anything else -> missed. Every 2nd consecutive miss adds KSh 2 back to the price.
// ---------------------------------------------------------------------------
function settle(db, uid, today) {
  const u = getUser(db, uid);
  const yesterday = addDays(today, -1);
  if (u.last_settled >= yesterday) return;

  const slots = getSlots(db, uid);
  let cm = u.consecutive_missed;
  let from = addDays(u.last_settled, 1);
  const floor = addDays(yesterday, -400); // never loop over an unbounded gap
  if (from < floor) from = floor;

  tx(db, () => {
    for (let d = from; d <= yesterday; d = addDays(d, 1)) {
      if (d < u.created_date) continue;
      if (!slots[weekdayOf(d)]) continue;
      const c = db.prepare('SELECT status FROM checkins WHERE user_id = ? AND date = ?').get(uid, d);
      if (c && c.status === 'done') { cm = 0; continue; }
      if (c && c.status === 'grace') continue;
      cm += 1;
      db.prepare(`INSERT INTO checkins (user_id, date, status) VALUES (?,?, 'missed')
                  ON CONFLICT(user_id, date) DO UPDATE SET status = 'missed'`).run(uid, d);
      if (cm % RULES.PENALTY_EVERY === 0) {
        adjustCredit(db, uid, -RULES.PENALTY, `Missed ${RULES.PENALTY_EVERY} workouts in a row`, d);
      }
    }
    db.prepare('UPDATE users SET last_settled = ?, consecutive_missed = ? WHERE id = ?').run(yesterday, cm, uid);
  });
}

// ---------------------------------------------------------------------------
// Check-in flow
// ---------------------------------------------------------------------------
function getWorkout(db, id) {
  const w = db.prepare('SELECT * FROM workouts WHERE id = ?').get(id);
  return w ? { ...w, exercises: JSON.parse(w.exercises) } : null;
}

function startWorkout(db, u, today, workoutId, nowMs) {
  const slot = getSlots(db, u.id)[weekdayOf(today)];
  if (!slot) throw new HttpError(400, 'Today is not one of your scheduled workout days.');
  const w = getWorkout(db, workoutId);
  if (!w) throw new HttpError(404, 'Workout not found.');
  if (w.premium && effectivePlan(u, nowMs) === 'free') {
    throw new HttpError(402, 'This workout is part of a paid plan.');
  }
  if (u.mode !== 'both' && w.place !== u.mode) {
    throw new HttpError(400, `Your profile is set to ${u.mode} workouts.`);
  }
  const c = db.prepare('SELECT * FROM checkins WHERE user_id = ? AND date = ?').get(u.id, today);
  if (c && (c.status === 'done' || c.status === 'grace')) {
    throw new HttpError(409, c.status === 'done' ? 'You already showed up today.' : 'Today is covered by a Grace Day.');
  }
  if (c && c.status === 'started' && c.workout_id === w.id) return { started_at: c.started_at, workout: w };
  db.prepare(`INSERT INTO checkins (user_id, date, status, workout_id, started_at)
              VALUES (?,?, 'started', ?, ?)
              ON CONFLICT(user_id, date) DO UPDATE SET status = 'started', workout_id = excluded.workout_id,
                started_at = excluded.started_at`).run(u.id, today, w.id, nowMs);
  return { started_at: nowMs, workout: w };
}

function finishWorkout(db, u, today, nowMs, minFraction = RULES.MIN_FRACTION) {
  const c = db.prepare('SELECT * FROM checkins WHERE user_id = ? AND date = ?').get(u.id, today);
  if (!c || c.status !== 'started') throw new HttpError(409, 'Start a workout first.');
  const w = getWorkout(db, c.workout_id);
  const needed = Math.ceil(w.minutes * 60 * minFraction);
  const elapsed = Math.floor((nowMs - c.started_at) / 1000);
  if (elapsed < needed) {
    const left = needed - elapsed;
    throw new HttpError(425, `Keep going. About ${Math.ceil(left / 60)} more minute(s) before you can check in.`);
  }
  return tx(db, () => {
    db.prepare(`UPDATE checkins SET status = 'done', completed_at = ? WHERE user_id = ? AND date = ?`)
      .run(nowMs, u.id, today);
    db.prepare('UPDATE users SET consecutive_missed = 0 WHERE id = ?').run(u.id);
    const earned = adjustCredit(db, u.id, RULES.EARN, `Workout completed: ${w.title}`, today);
    return { earned };
  });
}

function useGrace(db, u, today, month) {
  const slot = getSlots(db, u.id)[weekdayOf(today)];
  if (!slot) throw new HttpError(400, 'Today is not one of your scheduled workout days.');
  const c = db.prepare('SELECT status FROM checkins WHERE user_id = ? AND date = ?').get(u.id, today);
  if (c && (c.status === 'done' || c.status === 'grace')) throw new HttpError(409, 'Today is already covered.');
  const left = graceLeft(u, month);
  if (left <= 0) throw new HttpError(409, 'No Grace Days left this month.');
  tx(db, () => {
    const used = u.grace_month === month ? u.grace_used + 1 : 1;
    db.prepare('UPDATE users SET grace_month = ?, grace_used = ? WHERE id = ?').run(month, used, u.id);
    db.prepare(`INSERT INTO checkins (user_id, date, status) VALUES (?,?, 'grace')
                ON CONFLICT(user_id, date) DO UPDATE SET status = 'grace'`).run(u.id, today);
  });
  return { grace_left: left - 1 };
}

function skipToday(db, u, today) {
  const slot = getSlots(db, u.id)[weekdayOf(today)];
  if (!slot) throw new HttpError(400, 'Today is not one of your scheduled workout days.');
  const c = db.prepare('SELECT status FROM checkins WHERE user_id = ? AND date = ?').get(u.id, today);
  if (c && (c.status === 'done' || c.status === 'grace')) throw new HttpError(409, 'Today is already covered.');
  db.prepare(`INSERT INTO checkins (user_id, date, status) VALUES (?,?, 'skipped')
              ON CONFLICT(user_id, date) DO UPDATE SET status = 'skipped'`).run(u.id, today);
}

// ---------------------------------------------------------------------------
// Day status, stats, dashboard
// ---------------------------------------------------------------------------
function dayStatus(u, date, today, slots, checkins) {
  const slot = slots[weekdayOf(date)];
  if (!slot || date < u.created_date) return { status: 'rest' };
  const c = checkins[date];
  const base = { slot: { start_time: slot.start_time, minutes: slot.minutes, place: slot.place } };
  if (c && c.status === 'done') return { ...base, status: 'done' };
  if (c && c.status === 'grace') return { ...base, status: 'grace' };
  // the day you sign up is a bonus: it can earn credit but is never counted as a miss
  if (date === u.created_date && date < today) return { status: 'rest' };
  if (date < today) return { ...base, status: 'missed' };
  if (date === today) return { ...base, status: c && c.status === 'skipped' ? 'skipped' : 'today' };
  return { ...base, status: 'upcoming' };
}

function loadCheckins(db, uid, sinceDate) {
  const map = {};
  for (const r of db.prepare('SELECT * FROM checkins WHERE user_id = ? AND date >= ?').all(uid, sinceDate)) map[r.date] = r;
  return map;
}

function computeStats(db, u, today) {
  const slots = getSlots(db, u.id);
  const since = addDays(today, -365);
  const checkins = loadCheckins(db, u.id, since);

  // streak: consecutive committed days showed up; grace days protect it, today pending doesn't break it
  let streak = 0;
  for (let i = 0; i <= 365; i++) {
    const d = addDays(today, -i);
    if (d < u.created_date) break;
    if (!slots[weekdayOf(d)]) continue;
    const c = checkins[d];
    if (c && c.status === 'done') { streak++; continue; }
    if (c && c.status === 'grace') continue;
    if (d === today && !(c && c.status === 'skipped')) continue;
    break;
  }

  // consistency over the last 30 days (grace days excluded from both sides)
  const start = addDays(today, -29) > u.created_date ? addDays(today, -29) : u.created_date;
  let done = 0, due = 0;
  for (let d = start; d <= today; d = addDays(d, 1)) {
    if (!slots[weekdayOf(d)]) continue;
    const c = checkins[d];
    if (c && c.status === 'grace') continue;
    if (c && c.status === 'done') { done++; due++; continue; }
    if (d === u.created_date) continue;   // sign-up day is never a miss
    if (d < today) due++;
  }
  const total = db.prepare(`SELECT COUNT(*) AS n FROM checkins WHERE user_id = ? AND status = 'done'`).get(u.id).n;
  return {
    streak,
    consistency: due ? Math.round((done / due) * 100) : null,
    workouts_completed: total,
    scheduled_days: Object.keys(slots).length,
  };
}

function quote(u, plan, nowMs) {
  const price = PRICES[plan];
  if (!price) throw new HttpError(400, 'Unknown plan.');
  const maxDiscount = Math.floor(price * RULES.MAX_DISCOUNT_PCT);
  const creditUsed = Math.max(0, Math.min(u.credit, maxDiscount, price - RULES.MIN_PAY));
  return { plan, price, credit_used: creditUsed, amount: price - creditUsed, max_discount: maxDiscount };
}

function suggestWorkout(db, u, slot, today, nowMs) {
  const paid = effectivePlan(u, nowMs) !== 'free';
  const rows = db.prepare('SELECT * FROM workouts WHERE place = ? ORDER BY id').all(slot.place)
    .filter((w) => paid || !w.premium);
  if (!rows.length) return null;
  const rank = { beginner: 0, intermediate: 1, advanced: 2 };
  let pool = rows.filter((w) => rank[w.level] <= rank[u.level]);
  if (!pool.length) pool = rows;
  const w = pool[dayNumber(today) % pool.length];
  return { ...w, exercises: JSON.parse(w.exercises) };
}

function reminderDue(db, u, nowMs) {
  const t = tzParts(nowMs, u.tz);
  const slot = getSlots(db, u.id)[weekdayOf(t.date)];
  if (!slot || t.date < u.created_date) return { due: false };
  const c = db.prepare('SELECT status FROM checkins WHERE user_id = ? AND date = ?').get(u.id, t.date);
  if (c && ['done', 'grace', 'skipped'].includes(c.status)) return { due: false };
  const until = hmToMinutes(slot.start_time) - t.minutes;
  if (until < 0 || until > RULES.REMINDER_LEAD) return { due: false };
  return {
    due: true, key: `${t.date}T${slot.start_time}`, minutes_until: until,
    start_time: slot.start_time, place: slot.place, minutes: slot.minutes,
    workout: suggestWorkout(db, u, slot, t.date, nowMs)?.title || null,
  };
}

function buildDashboard(db, u, nowMs) {
  const t = tzParts(nowMs, u.tz);
  const today = t.date;
  const slots = getSlots(db, u.id);
  const checkins = loadCheckins(db, u.id, addDays(today, -400));

  const todaySt = dayStatus(u, today, today, slots, checkins);
  const todayC = checkins[today];
  const slot = slots[weekdayOf(today)];
  const todayInfo = { status: todaySt.status, slot: todaySt.slot || null, workout: null, started_at: null };
  if (slot && todaySt.status !== 'rest') {
    const wid = todayC && todayC.workout_id;
    todayInfo.workout = wid ? getWorkout(db, wid) : suggestWorkout(db, u, slot, today, nowMs);
    if (todayC && todayC.status === 'started') todayInfo.started_at = todayC.started_at;
  }

  const monday = addDays(today, -weekdayOf(today));
  const week = [];
  for (let i = 0; i < 7; i++) {
    const d = addDays(monday, i);
    week.push({ date: d, weekday: i, is_today: d === today, ...dayStatus(u, d, today, slots, checkins) });
  }

  let next = null;
  for (let off = 0; off <= 7 && !next; off++) {
    const d = addDays(today, off);
    const s = slots[weekdayOf(d)];
    if (!s) continue;
    if (off === 0) {
      const c = checkins[d];
      if (c && ['done', 'grace', 'skipped'].includes(c.status)) continue;
      if (hmToMinutes(s.start_time) + s.minutes < t.minutes) continue; // window fully passed
    }
    next = {
      date: d, weekday: weekdayOf(d), start_time: s.start_time, place: s.place, minutes: s.minutes,
      in_minutes: off * 1440 + hmToMinutes(s.start_time) - t.minutes,
    };
  }

  const plan = effectivePlan(u, nowMs);
  const q = plan === 'student' || u.student_status === 'verified' ? quote(u, 'student', nowMs) : quote(u, 'plus', nowMs);
  return {
    today: todayInfo,
    week,
    next,
    stats: computeStats(db, u, today),
    credit: {
      balance: u.credit,
      next_price: q.amount,
      list_price: q.price,
      plan_for_quote: q.plan,
      earn: RULES.EARN, penalty: RULES.PENALTY, penalty_every: RULES.PENALTY_EVERY,
      missed_in_a_row: u.consecutive_missed % RULES.PENALTY_EVERY,
    },
    grace_left: graceLeft(u, t.month),
    now: { date: today, minutes: t.minutes, ms: nowMs },
  };
}

function buildProgress(db, u, nowMs, month) {
  const t = tzParts(nowMs, u.tz);
  const today = t.date;
  const slots = getSlots(db, u.id);
  const checkins = loadCheckins(db, u.id, addDays(today, -800));
  const [y, m] = month.split('-').map(Number);
  const first = `${month}-01`;
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const days = [];
  for (let i = 0; i < daysInMonth; i++) {
    const d = addDays(first, i);
    days.push({ date: d, weekday: weekdayOf(d), is_today: d === today, ...dayStatus(u, d, today, slots, checkins) });
  }
  const counts = { done: 0, missed: 0, grace: 0 };
  for (const d of days) if (counts[d.status] !== undefined) counts[d.status]++;
  const ledger = db.prepare('SELECT date, delta, reason, balance_after FROM ledger WHERE user_id = ? ORDER BY id DESC LIMIT 40').all(u.id);
  return { month, first_weekday: weekdayOf(first), days, counts, stats: computeStats(db, u, today), ledger };
}

module.exports = {
  RULES, PRICES, FREE_MAX_DAYS, HttpError,
  validTz, tzParts, addDays, weekdayOf, hmToMinutes,
  getUser, getSlots, effectivePlan, graceLeft, adjustCredit,
  settle, startWorkout, finishWorkout, useGrace, skipToday, getWorkout,
  computeStats, quote, suggestWorkout, reminderDue, buildDashboard, buildProgress,
};
