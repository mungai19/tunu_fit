'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { open } = require('../server/db');
const L = require('../server/logic');

// A user who has committed to training EVERY day, joined on 2026-01-01.
function setup({ credit = 0 } = {}) {
  const db = open(':memory:');
  const r = db.prepare(`INSERT INTO users (name,email,pass_hash,salt,tz,created_date,last_settled,credit,onboarded,created_at,mode)
    VALUES ('T','t@x.com','h','s','Africa/Nairobi','2026-01-01','2026-01-01',?,1,0,'home')`).run(credit);
  const uid = Number(r.lastInsertRowid);
  for (let wd = 0; wd < 7; wd++) db.prepare(`INSERT INTO availability VALUES (?,?,?,?,?)`).run(uid, wd, '18:00', 30, 'home');
  const wid = db.prepare(`SELECT id FROM workouts WHERE place='home' AND premium=0 LIMIT 1`).get().id;
  const mark = (date, status) => db.prepare(`INSERT INTO checkins (user_id,date,status,workout_id) VALUES (?,?,?,?)`).run(uid, date, status, wid);
  const user = () => L.getUser(db, uid);
  const complete = (date) => {           // real check-in path, no minimum time
    L.startWorkout(db, user(), date, wid, 1000);
    return L.finishWorkout(db, user(), date, 1000 + 3600_000, 0);
  };
  return { db, uid, mark, user, complete };
}

test('showing up earns KSh 3 off, every time', () => {
  const s = setup();
  assert.equal(s.complete('2026-01-02').earned, 3);
  assert.equal(s.complete('2026-01-03').earned, 3);
  assert.equal(s.complete('2026-01-04').earned, 3);
  assert.equal(s.user().credit, 9);
});

test('cannot check in twice on the same day', () => {
  const s = setup();
  s.complete('2026-01-02');
  assert.throws(() => L.startWorkout(s.db, s.user(), '2026-01-02', 1, 5), /already showed up/);
});

test('missing ONE workout costs nothing', () => {
  const s = setup({ credit: 10 });
  L.settle(s.db, s.uid, '2026-01-03'); // Jan 2 missed
  assert.equal(s.user().credit, 10);
  assert.equal(s.user().consecutive_missed, 1);
});

test('every 2 missed workouts in a row puts KSh 2 back (4 misses = KSh 4)', () => {
  const s = setup({ credit: 10 });
  L.settle(s.db, s.uid, '2026-01-06'); // Jan 2,3,4,5 missed
  assert.equal(s.user().credit, 6);
  const ledger = s.db.prepare('SELECT delta FROM ledger WHERE user_id=?').all(s.uid).map((r) => r.delta);
  assert.deepEqual(ledger, [-2, -2]);
});

test('a workout in between resets the miss counter', () => {
  const s = setup({ credit: 10 });
  s.mark('2026-01-03', 'done');           // Jan 2 missed, Jan 3 done, Jan 4 missed
  L.settle(s.db, s.uid, '2026-01-05');
  assert.equal(s.user().credit, 10);
  assert.equal(s.user().consecutive_missed, 1);
});

test('Grace Days excuse a day without resetting or breaking anything', () => {
  const s = setup({ credit: 10 });
  s.mark('2026-01-03', 'grace');          // miss, grace, miss -> the 2 misses still pair up
  L.settle(s.db, s.uid, '2026-01-05');
  assert.equal(s.user().credit, 8);
  const s2 = setup({ credit: 10 });
  s2.mark('2026-01-02', 'grace'); s2.mark('2026-01-03', 'grace');
  L.settle(s2.db, s2.uid, '2026-01-04');
  assert.equal(s2.user().credit, 10);
});

test('credit never goes below zero', () => {
  const s = setup({ credit: 1 });
  L.settle(s.db, s.uid, '2026-01-04');    // 2 misses = -2, but only 1 available
  assert.equal(s.user().credit, 0);
  const s0 = setup({ credit: 0 });
  L.settle(s0.db, s0.uid, '2026-01-08');
  assert.equal(s0.user().credit, 0);
  assert.equal(s0.db.prepare('SELECT COUNT(*) n FROM ledger').get().n, 0);
});

test('settling is idempotent', () => {
  const s = setup({ credit: 10 });
  L.settle(s.db, s.uid, '2026-01-05');
  const after = s.user().credit;
  L.settle(s.db, s.uid, '2026-01-05');
  L.settle(s.db, s.uid, '2026-01-05');
  assert.equal(s.user().credit, after);
});

test('only committed days count (3x/week user is not punished on off days)', () => {
  const s = setup({ credit: 10 });
  s.db.prepare('DELETE FROM availability WHERE user_id=? AND weekday NOT IN (0,2,4)').run(s.uid); // Mon, Wed, Fri
  // Jan 2026: Fri Jan 2, Sat 3, Sun 4, Mon 5 ...
  L.settle(s.db, s.uid, '2026-01-05');   // processes Jan 2..4: only Fri Jan 2 is committed -> 1 miss
  assert.equal(s.user().credit, 10);
  assert.equal(s.user().consecutive_missed, 1);
  L.settle(s.db, s.uid, '2026-01-08');   // Mon Jan 5 + Wed Jan 7 missed -> 3 total, 2nd pair none yet...
  assert.equal(s.user().consecutive_missed, 3);
  assert.equal(s.user().credit, 8);      // penalty at the 2nd miss only
});

test('Grace Days: 2 per month, resets next month', () => {
  const s = setup();
  assert.equal(L.useGrace(s.db, s.user(), '2026-01-10', '2026-01').grace_left, 1);
  assert.equal(L.useGrace(s.db, s.user(), '2026-01-11', '2026-01').grace_left, 0);
  assert.throws(() => L.useGrace(s.db, s.user(), '2026-01-12', '2026-01'), /No Grace Days/);
  assert.equal(L.useGrace(s.db, s.user(), '2026-02-01', '2026-02').grace_left, 1);
});

test('check-in is refused until enough of the workout time has passed', () => {
  const s = setup();
  const wid = s.db.prepare(`SELECT id FROM workouts WHERE place='home' AND premium=0 AND minutes=15 LIMIT 1`).get().id;
  L.startWorkout(s.db, s.user(), '2026-01-02', wid, 0);
  assert.throws(() => L.finishWorkout(s.db, s.user(), '2026-01-02', 60_000, 0.5), /Keep going/);
  assert.equal(L.finishWorkout(s.db, s.user(), '2026-01-02', 8 * 60_000, 0.5).earned, 3);
});

test('streak and consistency', () => {
  const s = setup();
  s.complete('2026-01-02'); s.complete('2026-01-03'); s.mark('2026-01-04', 'missed');
  s.complete('2026-01-05'); s.complete('2026-01-06');
  s.db.prepare(`UPDATE users SET last_settled='2026-01-06' WHERE id=?`).run(s.uid);
  const st = L.computeStats(s.db, s.user(), '2026-01-07');
  assert.equal(st.streak, 2);
  assert.equal(st.consistency, 80);        // 4 of 5 committed days
  assert.equal(st.workouts_completed, 4);
});

test('15-minute reminder window (Nairobi time)', () => {
  const s = setup();
  s.db.prepare('DELETE FROM availability WHERE user_id=? AND weekday!=2').run(s.uid); // Wednesdays only, 18:00
  const at = (h, m) => Date.UTC(2026, 9, 21, h - 3, m);  // Wed 21 Oct 2026, EAT
  assert.equal(L.reminderDue(s.db, s.user(), at(17, 44)).due, false);
  const r = L.reminderDue(s.db, s.user(), at(17, 45));
  assert.equal(r.due, true); assert.equal(r.minutes_until, 15); assert.equal(r.start_time, '18:00');
  assert.equal(L.reminderDue(s.db, s.user(), at(17, 59)).due, true);
  assert.equal(L.reminderDue(s.db, s.user(), at(18, 1)).due, false);
  assert.equal(L.reminderDue(s.db, s.user(), Date.UTC(2026, 9, 22, 14, 50)).due, false); // Thursday: no slot
  s.db.prepare(`INSERT INTO checkins (user_id,date,status) VALUES (?,?, 'done')`).run(s.uid, '2026-10-21');
  assert.equal(L.reminderDue(s.db, s.user(), at(17, 50)).due, false);     // already showed up
});

test('quote caps the credit and never goes under the minimum', () => {
  const s = setup({ credit: 5000 });
  const q = L.quote(s.user(), 'plus', Date.now());
  assert.equal(q.price, 799);
  assert.equal(q.credit_used, 319);       // 40% cap
  assert.equal(q.amount, 480);
  assert.equal(L.quote({ credit: 20 }, 'student', 0).amount, 379);
});
