'use strict';
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const seedWorkouts = require('./workouts');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  pass_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  phone TEXT,
  tz TEXT NOT NULL DEFAULT 'Africa/Nairobi',
  mode TEXT NOT NULL DEFAULT 'home',            -- home | gym | both
  goal TEXT NOT NULL DEFAULT 'consistency',
  level TEXT NOT NULL DEFAULT 'beginner',
  plan TEXT NOT NULL DEFAULT 'free',            -- free | plus | student
  plan_expires INTEGER NOT NULL DEFAULT 0,      -- epoch ms
  student_status TEXT NOT NULL DEFAULT 'none',  -- none | pending | verified
  student_id TEXT,
  credit INTEGER NOT NULL DEFAULT 0,            -- Tunu credit in KSh
  consecutive_missed INTEGER NOT NULL DEFAULT 0,
  created_date TEXT NOT NULL,                   -- YYYY-MM-DD in user's tz
  last_settled TEXT NOT NULL,                   -- last day whose misses were processed
  grace_month TEXT NOT NULL DEFAULT '',
  grace_used INTEGER NOT NULL DEFAULT 0,
  onboarded INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS availability (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  weekday INTEGER NOT NULL,                     -- 0 = Monday ... 6 = Sunday
  start_time TEXT NOT NULL,                     -- HH:MM
  minutes INTEGER NOT NULL,
  place TEXT NOT NULL DEFAULT 'home',           -- home | gym
  PRIMARY KEY (user_id, weekday)
);

CREATE TABLE IF NOT EXISTS workouts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  place TEXT NOT NULL,
  focus TEXT NOT NULL,
  level TEXT NOT NULL,
  minutes INTEGER NOT NULL,
  premium INTEGER NOT NULL DEFAULT 0,
  exercises TEXT NOT NULL                       -- JSON
);

CREATE TABLE IF NOT EXISTS checkins (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  status TEXT NOT NULL,                         -- started | done | grace | skipped | missed
  workout_id INTEGER,
  started_at INTEGER,
  completed_at INTEGER,
  PRIMARY KEY (user_id, date)
);

CREATE TABLE IF NOT EXISTS ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  delta INTEGER NOT NULL,
  reason TEXT NOT NULL,
  balance_after INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000)
);
CREATE INDEX IF NOT EXISTS idx_ledger_user ON ledger(user_id, id DESC);

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan TEXT NOT NULL,
  list_price INTEGER NOT NULL,
  credit_used INTEGER NOT NULL,
  amount INTEGER NOT NULL,
  phone TEXT NOT NULL,
  demo INTEGER NOT NULL DEFAULT 0,
  checkout_request_id TEXT,
  merchant_request_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',       -- pending | success | failed | expired | review
  receipt TEXT,
  result_desc TEXT,
  created_at INTEGER NOT NULL,
  last_query_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_pay_checkout ON payments(checkout_request_id);
`;

function open(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM workouts').get();
  if (n === 0) {
    const ins = db.prepare(
      'INSERT INTO workouts (title, place, focus, level, minutes, premium, exercises) VALUES (?,?,?,?,?,?,?)'
    );
    db.exec('BEGIN');
    for (const x of seedWorkouts) {
      ins.run(x.title, x.place, x.focus, x.level, x.minutes, x.premium, JSON.stringify(x.exercises));
    }
    db.exec('COMMIT');
  }
  return db;
}

function tx(db, fn) {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    throw e;
  }
}

module.exports = { open, tx };
