(() => {
'use strict';

// ---------------------------------------------------------------- helpers
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const DAYS_LONG = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const KSH = (n) => 'KSh ' + Number(n).toLocaleString('en-KE');
const BOLT = '<svg viewBox="0 0 64 64" aria-hidden="true"><path d="M36 6 16 36h14l-4 22 22-32H34z" fill="#d4af37"/></svg>';
const LOGO = `<span class="logo">${BOLT}<span>Tunu <b>Fit</b></span></span>`;
const ICONS = {
  dashboard: '<svg viewBox="0 0 24 24"><path d="M3 11 12 3l9 8"/><path d="M5 10v10h14V10"/></svg>',
  schedule: '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M8 3v4M16 3v4M3 11h18"/></svg>',
  workouts: '<svg viewBox="0 0 24 24"><path d="M6 7v10M18 7v10M3 10v4M21 10v4M6 12h12"/></svg>',
  progress: '<svg viewBox="0 0 24 24"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></svg>',
  plans: '<svg viewBox="0 0 24 24"><rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/></svg>',
  settings: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/></svg>',
  admin: '<svg viewBox="0 0 24 24"><path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z"/></svg>',
};

const state = {
  ready: false, user: null, config: null, route: 'dashboard', skew: 0,
  onb: { step: 1, mode: 'home', goal: 'consistency', level: 'beginner' },
  authTab: 'login', workoutFilter: 'all', month: null, timer: null, payPoll: null,
};

function fmtTime(hm) {
  const [h, m] = hm.split(':').map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}
const placeLabel = (p) => (p === 'gym' ? 'Gym' : 'Home');
const mmss = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
function inText(mins) {
  if (mins < 1) return 'now';
  if (mins < 60) return `in ${mins} min`;
  if (mins < 1440) return `in ${Math.floor(mins / 60)} h ${mins % 60 ? (mins % 60) + ' min' : ''}`.trim();
  return `in ${Math.floor(mins / 1440)} day(s)`;
}
function store(key, val) {
  try { if (val === undefined) return localStorage.getItem(key); localStorage.setItem(key, val); } catch { return null; }
  return null;
}

async function api(path, { method = 'GET', body } = {}) {
  const opts = { method, credentials: 'same-origin', headers: {} };
  if (method !== 'GET') { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body || {}); }
  let res;
  try { res = await fetch('/api' + path, opts); } catch { throw new Error('You appear to be offline. Check your connection and try again.'); }
  let data = null;
  try { data = await res.json(); } catch { /* ignore */ }
  if (!res.ok) {
    const e = new Error((data && data.error) || 'Something went wrong.');
    e.status = res.status;
    if (res.status === 401 && state.user) { state.user = null; render(); }
    throw e;
  }
  return data;
}

function toast(msg, type = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.textContent = msg;
  $('#toast-host').appendChild(el);
  setTimeout(() => el.remove(), 4500);
}

function busy(btn, on, label) {
  if (!btn) return;
  if (on) { btn.dataset.l = btn.innerHTML; btn.disabled = true; if (label) btn.textContent = label; }
  else { btn.disabled = false; if (btn.dataset.l) btn.innerHTML = btn.dataset.l; }
}

// ---------------------------------------------------------------- routing / shell
const NAV = [
  ['dashboard', 'Today'], ['schedule', 'Schedule'], ['workouts', 'Workouts'],
  ['progress', 'Progress'], ['plans', 'Plans'], ['settings', 'Settings'],
];

function routeFromHash() {
  const r = (location.hash.replace(/^#\/?/, '') || 'dashboard').split('?')[0];
  state.route = [...NAV.map((n) => n[0]), 'admin'].includes(r) ? r : 'dashboard';
}
window.addEventListener('hashchange', () => { routeFromHash(); if (state.user && state.user.onboarded) renderShell(); });

function render() {
  clearInterval(state.timer);
  if (!state.ready) { $('#app').innerHTML = '<div class="loading"><span class="spinner"></span></div>'; return; }
  if (!state.user) return renderAuth();
  if (!state.user.onboarded) return renderOnboarding();
  routeFromHash();
  renderShell();
}

function renderShell() {
  const items = NAV.slice();
  if (state.user.is_admin) items.push(['admin', 'Admin']);
  $('#app').innerHTML = `
    <div class="shell">
      <aside class="side">
        ${LOGO}
        <nav class="nav" aria-label="Main">
          ${items.map(([k, label]) => `<a href="#/${k}" ${state.route === k ? 'aria-current="page"' : ''}>${ICONS[k === 'plans' ? 'plans' : k]}<span>${label}</span></a>`).join('')}
        </nav>
        <div class="who">${esc(state.user.name)}<br><span class="pill">${esc(state.user.plan)}</span></div>
      </aside>
      <main id="view" tabindex="-1"><div class="loading"><span class="spinner"></span></div></main>
    </div>`;
  const views = { dashboard: viewDashboard, schedule: viewSchedule, workouts: viewWorkouts, progress: viewProgress, plans: viewPlans, settings: viewSettings, admin: viewAdmin };
  clearInterval(state.timer);
  clearInterval(state.payPoll);
  views[state.route]().catch((e) => { const v = $('#view'); if (v) v.innerHTML = `<div class="card"><p class="err">${esc(e.message)}</p><button class="btn ghost" data-act="reload">Try again</button></div>`; });
}

async function refreshUser() {
  const r = await api('/me');
  state.user = r.user;
}

// ---------------------------------------------------------------- auth
function renderAuth() {
  const rules = state.config ? state.config.rules : { earn: 3, penalty: 2, penalty_every: 2 };
  const reg = state.authTab === 'register';
  $('#app').innerHTML = `
    <div class="auth">
      <section class="auth-hero">
        ${LOGO}
        <div>
          <h1>Don't just start.<span>Stay consistent.</span></h1>
          <p class="muted" style="max-width:34rem">Home workouts or gym sessions. You pick the days and hours. We remind you 15 minutes before, and your consistency makes your subscription cheaper.</p>
        </div>
        <ul class="rules">
          <li><span class="badge">-${KSH(rules.earn)}</span><span>off your subscription <b>every day you show up</b> for a workout you scheduled.</span></li>
          <li><span class="badge bad">+${KSH(rules.penalty)}</span><span>comes back for <b>every ${rules.penalty_every} workouts in a row</b> you miss. Never more.</span></li>
          <li><span class="badge">${rules.grace_per_month || 2}</span><span><b>Grace Days</b> each month. Life happens, no penalty.</span></li>
        </ul>
      </section>
      <section class="auth-panel">
        <div class="tabs" role="tablist">
          <button role="tab" data-act="auth-tab" data-tab="login" aria-selected="${!reg}">Log in</button>
          <button role="tab" data-act="auth-tab" data-tab="register" aria-selected="${reg}">Create account</button>
        </div>
        <form id="auth-form" novalidate>
          ${reg ? `<div class="field"><label for="f-name">Your name</label><input id="f-name" type="text" autocomplete="name" required maxlength="60"></div>` : ''}
          <div class="field"><label for="f-email">Email</label><input id="f-email" type="email" autocomplete="email" required></div>
          ${reg ? `<div class="field"><label for="f-phone">M-Pesa phone <span style="text-transform:none;letter-spacing:0">(optional)</span></label><input id="f-phone" type="tel" inputmode="tel" placeholder="07XX XXX XXX" autocomplete="tel"></div>` : ''}
          <div class="field"><label for="f-pass">Password</label><input id="f-pass" type="password" autocomplete="${reg ? 'new-password' : 'current-password'}" required minlength="8"></div>
          <div class="err" id="auth-err" role="alert"></div>
          <button class="btn block" type="submit">${reg ? 'Create my account' : 'Log in'}</button>
        </form>
        <p class="muted small" style="margin-top:1rem">${reg ? 'By signing up you agree to train safely. Tunu Fit is not medical advice; check with a doctor before starting a new programme.' : 'New here? Create an account in under a minute.'}</p>
      </section>
    </div>`;
  $('#auth-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('button[type=submit]', e.target);
    const err = $('#auth-err'); err.textContent = '';
    busy(btn, true, 'One moment...');
    try {
      const payload = { email: $('#f-email').value, password: $('#f-pass').value };
      if (reg) {
        payload.name = $('#f-name').value; payload.phone = $('#f-phone').value;
        payload.tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      }
      const r = await api(reg ? '/auth/register' : '/auth/login', { method: 'POST', body: payload });
      state.user = r.user;
      if (!state.user.onboarded) { state.onb = { step: 1, mode: 'home', goal: 'consistency', level: 'beginner' }; }
      render();
      startReminders();
    } catch (ex) { err.textContent = ex.message; busy(btn, false); }
  });
}

// ---------------------------------------------------------------- schedule editor (used by onboarding + schedule page)
function scheduleEditorHtml(slots, mode) {
  const byDay = {}; slots.forEach((s) => { byDay[s.weekday] = s; });
  return DAYS_LONG.map((name, i) => {
    const s = byDay[i];
    const on = !!s;
    return `<div class="slot ${on ? '' : 'off'}" data-wd="${i}">
      <label class="dname" style="margin:0;color:inherit"><input type="checkbox" ${on ? 'checked' : ''} data-act="slot-toggle" aria-label="Train on ${name}"> ${DAYS[i]}</label>
      <div class="ctl"><label for="t${i}">Start time</label><input id="t${i}" type="time" value="${esc(s ? s.start_time : '18:00')}" required></div>
      <div class="ctl"><label for="m${i}">Length</label><select id="m${i}">${[10, 15, 20, 30, 45, 60, 90].map((m) => `<option value="${m}" ${(s ? s.minutes : 30) === m ? 'selected' : ''}>${m} min</option>`).join('')}</select></div>
      <div class="ctl"><label for="p${i}">Where</label><select id="p${i}" ${mode === 'both' ? '' : 'disabled'}>
        <option value="home" ${(s ? s.place : mode === 'gym' ? 'gym' : 'home') === 'home' ? 'selected' : ''}>Home</option>
        <option value="gym" ${(s ? s.place : mode === 'gym' ? 'gym' : 'home') === 'gym' ? 'selected' : ''}>Gym</option></select></div>
    </div>`;
  }).join('');
}

function collectSlots(root) {
  const out = [];
  $$('.slot', root).forEach((row) => {
    if (!$('input[type=checkbox]', row).checked) return;
    const i = Number(row.dataset.wd);
    out.push({ weekday: i, start_time: $(`#t${i}`, row).value, minutes: Number($(`#m${i}`, row).value), place: $(`#p${i}`, row).value });
  });
  return out;
}

// ---------------------------------------------------------------- onboarding
const defaultSlots = (mode) => [0, 2, 4].map((weekday) => ({ weekday, start_time: '18:00', minutes: 30, place: mode === 'gym' ? 'gym' : 'home' }));

function renderOnboarding() {
  const o = state.onb;
  const opt = (name, val, em, label) => `<button type="button" class="choice" data-act="onb-pick" data-k="${name}" data-v="${val}" aria-pressed="${o[name] === val}"><span class="em">${em}</span>${label}</button>`;
  $('#app').innerHTML = `
    <div class="onb">
      ${LOGO}
      <div class="steps"><i class="on"></i><i class="${o.step === 2 ? 'on' : ''}"></i></div>
      ${o.step === 1 ? `
        <h1 style="font-size:2.2rem">Where do you train?</h1>
        <p class="muted">You can change this any time.</p>
        <div class="grid3" style="margin-bottom:1.5rem">${opt('mode', 'home', '🏠', 'Home')}${opt('mode', 'gym', '🏋🏽', 'Gym')}${opt('mode', 'both', '🔁', 'Both')}</div>
        <div class="grid2">
          <div class="field"><label for="o-goal">Main goal</label><select id="o-goal">
            ${[['consistency', 'Build consistency'], ['lose_weight', 'Lose weight'], ['build_muscle', 'Build muscle'], ['stay_active', 'Stay active'], ['strength', 'Get stronger']].map(([v, l]) => `<option value="${v}" ${o.goal === v ? 'selected' : ''}>${l}</option>`).join('')}
          </select></div>
          <div class="field"><label for="o-level">Fitness level</label><select id="o-level">
            ${[['beginner', 'Beginner'], ['intermediate', 'Intermediate'], ['advanced', 'Advanced']].map(([v, l]) => `<option value="${v}" ${o.level === v ? 'selected' : ''}>${l}</option>`).join('')}
          </select></div>
        </div>
        <div class="err" id="onb-err" role="alert"></div>
        <button class="btn block" data-act="onb-next">Next: choose your hours</button>
      ` : `
        <h1 style="font-size:2.2rem">When can you train?</h1>
        <p class="muted">Tick the days you commit to and pick the hour you will start. Only these days count for your points.</p>
        <div class="reminder-note">⏰ <span>Tunu Fit pops up a reminder <b>15 minutes before</b> each session.</span></div>
        <div id="sched" class="card">${scheduleEditorHtml(defaultSlots(o.mode), o.mode)}</div>
        <div class="err" id="onb-err" role="alert"></div>
        <div class="row"><button class="btn ghost" data-act="onb-back">Back</button><button class="btn" data-act="onb-save">Start my journey</button></div>
      `}
    </div>`;
}

// ---------------------------------------------------------------- dashboard
async function viewDashboard() {
  const d = await api('/dashboard');
  state.user = d.user;
  state.skew = d.now.ms - Date.now();
  state.dash = d;
  const t = d.today, c = d.credit, s = d.stats;
  const first = state.user.name.split(' ')[0];
  const hour = Math.floor(d.now.minutes / 60);
  const greet = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  let hero = '';
  if (t.status === 'rest') {
    hero = `<span class="pill">Rest day</span><div class="big">Recover well</div><p class="muted">No workout scheduled today. Rest is part of the plan.</p>`;
  } else if (t.status === 'done') {
    hero = `<span class="pill ok">Showed up</span><div class="big">You did it ✅</div><p class="muted">+${KSH(c.earn)} added to your credit. See you at your next session.</p>`;
  } else if (t.status === 'grace') {
    hero = `<span class="pill grace">Grace Day</span><div class="big">Rest, no penalty</div><p class="muted">Life happens. Come back at your next session.</p>`;
  } else if (t.status === 'skipped') {
    hero = `<span class="pill bad">Skipped</span><div class="big">Tomorrow is a fresh start</div><p class="muted">This counts as a miss. You can still change your mind and train today.</p>
      <button class="btn" data-act="open-workout" data-id="${t.workout ? t.workout.id : ''}">Train anyway</button>`;
  } else {
    const w = t.workout;
    hero = `<span class="pill">Today's commitment</span>
      <div class="big">${w ? esc(w.title) : 'Your workout'}</div>
      <div class="time">${fmtTime(t.slot.start_time)} · ${t.slot.minutes} min · ${placeLabel(t.slot.place)}</div>
      <p class="muted" style="margin:.6rem 0 1rem">${t.started_at ? 'Workout in progress. Finish it to check in.' : 'Show up and earn ' + KSH(c.earn) + ' off your subscription.'}</p>
      <div class="row tight">
        <button class="btn" data-act="open-workout" data-id="${w ? w.id : ''}">${t.started_at ? 'Resume workout' : 'Start workout'}</button>
        <button class="btn ghost" data-act="cant-today">I can't today</button>
      </div>`;
  }
  const nextLine = d.next
    ? `Next session: <b>${DAYS_LONG[d.next.weekday]} ${fmtTime(d.next.start_time)}</b> (${inText(d.next.in_minutes)}). Reminder pops up 15 min before.`
    : 'No sessions scheduled. Add your hours in Schedule.';
  const pct = Math.min(100, Math.round(((c.list_price - c.next_price) / c.list_price) * 100));
  $('#view').innerHTML = `
    <div class="page-head"><div><h2>${greet}, ${esc(first)}</h2><p class="muted">${nextLine}</p></div></div>
    <div class="card gold-edge today">${hero}</div>
    <div class="grid4" style="margin-bottom:1rem">
      <div class="card stat"><div class="num">${s.streak}</div><div class="lbl">🔥 Day streak</div></div>
      <div class="card stat"><div class="num">${s.consistency === null ? '–' : s.consistency + '%'}</div><div class="lbl">30-day consistency</div></div>
      <div class="card stat"><div class="num">${s.workouts_completed}</div><div class="lbl">Workouts done</div></div>
      <div class="card stat"><div class="num">${d.grace_left}</div><div class="lbl">Grace days left</div></div>
    </div>
    <div class="card">
      <h3>This week</h3>
      <div class="week">${d.week.map((w) => {
        const ic = { done: '✅', missed: '❌', grace: '💙', today: '⭕', upcoming: '⏳', skipped: '❌', rest: '·' }[w.status];
        return `<div class="day ${w.status} ${w.is_today ? 'is-today' : ''}"><div class="dn">${DAYS[w.weekday]}</div><div class="ic" aria-label="${w.status}">${ic}</div><div class="tm">${w.slot ? fmtTime(w.slot.start_time) : 'rest'}</div></div>`;
      }).join('')}</div>
    </div>
    <div class="card">
      <h3>Your Tunu credit</h3>
      <div class="price-line"><span class="now">${KSH(c.next_price)}</span><s>${KSH(c.list_price)}</s><span class="muted small">next renewal${c.plan_for_quote === 'student' ? ' (student)' : ''}</span></div>
      <div class="meter" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100" aria-label="Discount earned"><i style="width:${pct}%"></i></div>
      <p class="small muted" style="margin-top:.7rem">You have <b class="gold">${KSH(c.balance)}</b> in credit. Every workout you show up for takes <b>${KSH(c.earn)}</b> off. Every ${c.penalty_every} missed in a row puts <b>${KSH(c.penalty)}</b> back${c.missed_in_a_row ? ` (you have ${c.missed_in_a_row} miss${c.missed_in_a_row > 1 ? '' : ''} in a row; one more adds ${KSH(c.penalty)} back)` : ''}.</p>
    </div>`;
}

// ---------------------------------------------------------------- workout player
async function openWorkout(id) {
  const d = await api('/dashboard');
  state.skew = d.now.ms - Date.now();
  const wl = await api('/workouts');
  const w = wl.workouts.find((x) => x.id === Number(id)) || wl.workouts[0];
  if (!w) return toast('No workouts available for your profile.', 'bad');
  if (w.locked) { toast('This workout is part of a paid plan.'); location.hash = '#/plans'; return; }
  const t = d.today;
  const canTrack = ['today', 'skipped'].includes(t.status) && t.slot && (state.user.mode === 'both' || state.user.mode === w.place);
  const resumed = canTrack && t.started_at && t.workout && t.workout.id === w.id;
  const frac = state.config && typeof state.config.rules.min_fraction === 'number' ? state.config.rules.min_fraction : 0.5;
  const minNeed = Math.ceil(w.minutes * 60 * frac);
  const host = $('#modal-host');
  host.innerHTML = `
    <div class="overlay" role="dialog" aria-modal="true" aria-label="${esc(w.title)}">
      <div class="modal">
        <div class="row" style="justify-content:space-between"><span class="pill">${placeLabel(w.place)} · ${w.minutes} min · ${esc(w.level)}</span><button class="btn dark sm" data-act="close-modal" aria-label="Close">✕</button></div>
        <h2 style="margin-top:.6rem">${esc(w.title)}</h2>
        <p class="muted">${esc(w.focus)}</p>
        <ol class="exlist">${w.exercises.map((e) => `<li><span></span><span>${esc(e.name)}</span><span>${esc(e.detail)}</span></li>`).join('')}</ol>
        ${canTrack ? `
          <div class="timer" id="timer" aria-live="off">00:00</div>
          <p class="muted small" style="text-align:center" id="timer-note">Press start when you begin. Check-in unlocks after ${Math.ceil(minNeed / 60)} min.</p>
          <div class="err" id="w-err" role="alert"></div>
          <div class="row tight" style="justify-content:center">
            <button class="btn" id="w-start" data-act="w-start" data-id="${w.id}">Start</button>
            <button class="btn" id="w-finish" data-act="w-finish" disabled>I showed up ✅</button>
          </div>` : `<p class="muted small">This is free practice. It is not one of your scheduled sessions today, so it does not count towards points.</p>`}
        <p class="muted small" style="margin-top:1rem">Warm up first, stop if something hurts, and check with a doctor if you have a health condition.</p>
      </div>
    </div>`;
  host.dataset.minNeed = String(minNeed);
  if (canTrack) {
    if (resumed) { $('#w-start').classList.add('hidden'); runTimer(t.started_at, minNeed); }
    else $('#w-finish').classList.add('hidden');
  }
}

function runTimer(startedAt, minNeed) {
  clearInterval(state.timer);
  const tick = () => {
    const el = $('#timer'); if (!el) { clearInterval(state.timer); return; }
    const sec = Math.max(0, Math.floor((Date.now() + state.skew - startedAt) / 1000));
    el.textContent = mmss(sec);
    const fin = $('#w-finish'), note = $('#timer-note');
    if (fin) {
      fin.classList.remove('hidden');
      fin.disabled = sec < minNeed;
      if (note) note.textContent = sec < minNeed ? `Check-in unlocks in ${mmss(minNeed - sec)}. Keep going!` : 'Done? Tap the button to check in.';
    }
  };
  tick();
  state.timer = setInterval(tick, 1000);
}

// ---------------------------------------------------------------- schedule page
async function viewSchedule() {
  const { slots } = await api('/availability');
  const lead = state.config ? state.config.rules.reminder_lead : 15;
  $('#view').innerHTML = `
    <div class="page-head"><div><h2>Your hours</h2><p class="muted">Pick the days and the hour you will train. These are your commitments.</p></div></div>
    <div class="reminder-note">⏰ <span>A pop-up reminds you <b>${lead} minutes before</b> every session (keep Tunu Fit open in a tab, or install it to your home screen).</span></div>
    ${state.user.plan === 'free' ? `<p class="muted small">Free plan: up to ${state.config.rules.free_max_days} days a week.</p>` : ''}
    <div class="card" id="sched">${scheduleEditorHtml(slots, state.user.mode)}</div>
    <div class="err" id="sch-err" role="alert"></div>
    <button class="btn" data-act="sched-save">Save my hours</button>`;
}

// ---------------------------------------------------------------- workouts page
async function viewWorkouts() {
  const { workouts } = await api('/workouts');
  const f = state.workoutFilter;
  const list = workouts.filter((w) => f === 'all' || w.place === f);
  const both = state.user.mode === 'both';
  $('#view').innerHTML = `
    <div class="page-head"><div><h2>Workouts</h2><p class="muted">Tap any workout to see it. Scheduled-day sessions count for points.</p></div></div>
    ${both ? `<div class="chips">${['all', 'home', 'gym'].map((k) => `<button class="chip" data-act="filter" data-v="${k}" aria-pressed="${f === k}">${k === 'all' ? 'All' : placeLabel(k)}</button>`).join('')}</div>` : ''}
    <div class="wgrid">${list.map((w) => `
      <button class="wcard" data-act="open-workout" data-id="${w.id}">
        <div class="row tight"><span class="pill">${placeLabel(w.place)}</span>${w.locked ? '<span class="pill bad">🔒 Plus</span>' : ''}</div>
        <h3>${esc(w.title)}</h3>
        <span class="muted small">${esc(w.focus)} · ${w.minutes} min · ${esc(w.level)}</span>
      </button>`).join('') || '<p class="muted">Nothing here yet.</p>'}</div>`;
}

// ---------------------------------------------------------------- progress page
async function viewProgress() {
  const p = await api('/progress' + (state.month ? `?month=${state.month}` : ''));
  state.month = p.month;
  const [y, m] = p.month.split('-').map(Number);
  const title = new Date(Date.UTC(y, m - 1, 1)).toLocaleString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const shift = (n) => { const d = new Date(Date.UTC(y, m - 1 + n, 1)); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`; };
  const cells = [];
  for (let i = 0; i < p.first_weekday; i++) cells.push('<div class="c empty"></div>');
  p.days.forEach((d) => {
    const mark = { done: '✅', missed: '❌', grace: '💙' }[d.status] || '';
    cells.push(`<div class="c ${d.status} ${d.is_today ? 'is-today' : ''}" title="${d.date} ${d.status}"><b>${Number(d.date.slice(8))}</b><span>${mark}</span></div>`);
  });
  const s = p.stats;
  $('#view').innerHTML = `
    <div class="page-head"><div><h2>Progress</h2><p class="muted">Every session, tracked simply.</p></div></div>
    <div class="grid4" style="margin-bottom:1rem">
      <div class="card stat"><div class="num">${s.streak}</div><div class="lbl">🔥 Streak</div></div>
      <div class="card stat"><div class="num">${s.consistency === null ? '–' : s.consistency + '%'}</div><div class="lbl">Consistency</div></div>
      <div class="card stat"><div class="num">${p.counts.done}</div><div class="lbl">Done this month</div></div>
      <div class="card stat"><div class="num">${p.counts.missed}</div><div class="lbl">Missed this month</div></div>
    </div>
    <div class="card">
      <div class="row" style="justify-content:space-between;margin-bottom:.8rem">
        <button class="btn dark sm" data-act="month" data-v="${shift(-1)}" aria-label="Previous month">‹</button>
        <h3 style="margin:0">${esc(title)}</h3>
        <button class="btn dark sm" data-act="month" data-v="${shift(1)}" aria-label="Next month">›</button>
      </div>
      <div class="cal">${DAYS.map((d) => `<div class="h">${d}</div>`).join('')}${cells.join('')}</div>
      <div class="legend"><span><i style="background:#55d68a"></i>Showed up</span><span><i style="background:#ee6a57"></i>Missed</span><span><i style="background:#6cb4ff"></i>Grace day</span><span><i style="background:#d4af37"></i>Today</span></div>
    </div>
    <div class="card">
      <h3>Credit history</h3>
      ${p.ledger.length ? `<table><thead><tr><th>Date</th><th>What happened</th><th>Change</th><th>Balance</th></tr></thead><tbody>
        ${p.ledger.map((l) => `<tr><td>${esc(l.date)}</td><td>${esc(l.reason)}</td><td class="${l.delta >= 0 ? 'plus' : 'minus'}">${l.delta >= 0 ? '+' : '−'}${KSH(Math.abs(l.delta))}</td><td>${KSH(l.balance_after)}</td></tr>`).join('')}
      </tbody></table>` : '<p class="muted">Complete your first workout to start earning credit.</p>'}
    </div>`;
}

// ---------------------------------------------------------------- plans / M-Pesa
async function viewPlans() {
  const s = await api('/subscription');
  state.sub = s;
  const exp = s.plan !== 'free' ? new Date(s.plan_expires).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : null;
  const q = s.quotes;
  const priceBlock = (qq) => `<div class="amt">${KSH(qq.amount)}</div><div class="small muted">${qq.credit_used ? `<s>${KSH(qq.price)}</s> · ${KSH(qq.credit_used)} credit applied` : `${KSH(qq.price)} / month`}</div>`;
  const stu = s.student_status;
  $('#view').innerHTML = `
    <div class="page-head"><div><h2>Plans</h2><p class="muted">Your credit: <b class="gold">${KSH(s.credit)}</b>. It comes off at checkout (up to 40% per renewal).</p></div></div>
    ${s.demo ? '<div class="demo-banner"><b>Demo mode:</b> M-Pesa keys are not set, so payments are simulated and no real money moves.</div>' : ''}
    ${s.plan !== 'free' ? `<div class="card gold-edge"><span class="pill ok">Active</span> <b>${esc(s.plan === 'student' ? 'Student' : 'Tunu Fit+')}</b> until <b>${exp}</b>. Renew early any time; days stack.</div>` : ''}
    <div class="plans">
      <div class="card plan ${s.plan === 'free' ? 'current' : ''}"><h3>Free</h3><div class="amt">KSh 0</div>
        <ul><li>Up to 3 workout days a week</li><li>Free workouts (home + gym)</li><li>Tracking, streaks, reminders</li><li>Earn credit towards Plus</li></ul>
        ${s.plan === 'free' ? '<span class="pill">Your plan</span>' : ''}</div>
      <div class="card plan ${s.plan === 'plus' ? 'current' : ''}"><h3>Tunu Fit+</h3>${priceBlock(q.plus)}
        <ul><li>Every workout unlocked</li><li>Up to 7 days a week</li><li>Credit discount at renewal</li></ul>
        <button class="btn" data-act="pay-open" data-plan="plus">${s.plan === 'plus' ? 'Renew' : 'Subscribe'}</button></div>
      <div class="card plan ${s.plan === 'student' ? 'current' : ''}"><h3>Student</h3>${priceBlock(q.student)}
        <ul><li>Everything in Plus</li><li>Half-price for students</li><li>Verified by student ID</li></ul>
        ${stu === 'verified' ? `<button class="btn" data-act="pay-open" data-plan="student">${s.plan === 'student' ? 'Renew' : 'Subscribe'}</button>`
          : stu === 'pending' ? '<span class="pill">Verification pending</span>'
          : '<button class="btn ghost" data-act="student-open">Verify I am a student</button>'}</div>
    </div>
    <div id="pay-box"></div>
    ${s.history.length ? `<div class="card"><h3>Payments</h3><table><thead><tr><th>Plan</th><th>Paid</th><th>Credit used</th><th>Status</th><th>Receipt</th></tr></thead><tbody>
      ${s.history.map((h) => `<tr><td>${esc(h.plan)}</td><td>${KSH(h.amount)}</td><td>${KSH(h.credit_used)}</td><td>${esc(h.status)}${h.demo ? ' (demo)' : ''}</td><td>${esc(h.receipt || '')}</td></tr>`).join('')}</tbody></table></div>` : ''}`;
  if (s.pending) watchPayment(s.pending.id);
}

function openPayBox(plan) {
  const s = state.sub, q = s.quotes[plan];
  $('#pay-box').innerHTML = `
    <div class="card gold-edge" id="pay-card">
      <h3>Pay with <span class="mpesa"><i>M-PESA</i></span></h3>
      <p>${plan === 'student' ? 'Student' : 'Tunu Fit+'}: <b>${KSH(q.amount)}</b>${q.credit_used ? ` <span class="muted">(${KSH(q.price)} minus ${KSH(q.credit_used)} Tunu credit)</span>` : ''}</p>
      <div class="field"><label for="pay-phone">M-Pesa phone number</label><input id="pay-phone" type="tel" inputmode="tel" placeholder="07XX XXX XXX" value="${esc(s.phone ? '0' + s.phone.slice(3) : '')}" autocomplete="tel"></div>
      <div class="err" id="pay-err" role="alert"></div>
      <div class="row tight"><button class="btn" data-act="pay-go" data-plan="${plan}">Send M-Pesa prompt</button><button class="btn ghost" data-act="pay-cancel">Cancel</button></div>
      <p class="muted small" style="margin-top:.8rem">You will get a prompt on your phone. Enter your M-Pesa PIN to approve.</p>
    </div>`;
  $('#pay-box').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function watchPayment(id) {
  const box = $('#pay-box'); if (!box) return;
  box.innerHTML = `<div class="card gold-edge" id="pay-status"><span class="spinner"></span> <b>Waiting for M-Pesa...</b><p class="muted small">Check your phone and enter your PIN. This page updates by itself.</p></div>`;
  const started = Date.now();
  clearInterval(state.payPoll);
  const check = async () => {
    try {
      const r = await api('/payments/' + id);
      const p = r.payment;
      if (p.status === 'pending') {
        if (Date.now() - started > 150000) { clearInterval(state.payPoll); $('#pay-status').innerHTML = '<b>Still waiting.</b> If you approved on your phone, refresh in a minute. Otherwise try again.'; }
        return;
      }
      clearInterval(state.payPoll);
      if (p.status === 'success') {
        await refreshUser();
        $('#pay-status').innerHTML = `<span class="pill ok">Paid</span> <b>${KSH(p.amount)}</b> received${p.receipt ? ` (receipt ${esc(p.receipt)})` : ''}. Your plan is active. 🎉`;
        toast('Payment confirmed. Welcome to Tunu Fit+!', 'ok');
        setTimeout(() => { if (state.route === 'plans') renderShell(); }, 2500);
      } else if (p.status === 'review') {
        $('#pay-status').innerHTML = '<b>Payment needs a quick review.</b> The amount received did not match. Contact support with your M-Pesa message.';
      } else {
        $('#pay-status').innerHTML = `<span class="pill bad">Not completed</span> ${esc(p.message || 'The payment did not go through.')} Your credit was returned. <button class="btn sm ghost" data-act="reload">Try again</button>`;
      }
    } catch (e) { /* keep polling */ }
  };
  state.payPoll = setInterval(check, 3000);
  setTimeout(check, 1200);
}

// ---------------------------------------------------------------- settings
async function viewSettings() {
  const u = state.user;
  const notif = 'Notification' in window ? Notification.permission : 'unsupported';
  $('#view').innerHTML = `
    <div class="page-head"><div><h2>Settings</h2><p class="muted">${esc(u.email)}</p></div></div>
    <div class="card"><form id="set-form" novalidate>
      <div class="field"><label for="s-name">Name</label><input id="s-name" type="text" value="${esc(u.name)}" maxlength="60"></div>
      <div class="field"><label for="s-phone">M-Pesa phone</label><input id="s-phone" type="tel" value="${esc(u.phone ? '0' + u.phone.slice(3) : '')}" placeholder="07XX XXX XXX"></div>
      <div class="grid3">
        <div class="field"><label for="s-mode">I train at</label><select id="s-mode">${[['home', 'Home'], ['gym', 'Gym'], ['both', 'Both']].map(([v, l]) => `<option value="${v}" ${u.mode === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
        <div class="field"><label for="s-level">Level</label><select id="s-level">${['beginner', 'intermediate', 'advanced'].map((v) => `<option value="${v}" ${u.level === v ? 'selected' : ''}>${v[0].toUpperCase() + v.slice(1)}</option>`).join('')}</select></div>
        <div class="field"><label for="s-goal">Goal</label><select id="s-goal">${[['consistency', 'Build consistency'], ['lose_weight', 'Lose weight'], ['build_muscle', 'Build muscle'], ['stay_active', 'Stay active'], ['strength', 'Get stronger']].map(([v, l]) => `<option value="${v}" ${u.goal === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      </div>
      <div class="err" id="set-err" role="alert"></div>
      <button class="btn" type="submit">Save changes</button>
    </form></div>
    <div class="card"><h3>Reminders</h3>
      <p class="muted">The in-app pop-up appears 15 minutes before each session while Tunu Fit is open. You can also allow device notifications.</p>
      ${notif === 'granted' ? '<span class="pill ok">Device notifications on</span>' : notif === 'denied' ? '<span class="pill bad">Blocked in browser settings</span>' : notif === 'unsupported' ? '<span class="pill">Not supported on this browser</span>' : '<button class="btn ghost" data-act="notif">Allow device notifications</button>'}
      <div style="margin-top:.8rem"><button class="btn dark sm" data-act="test-reminder">Preview the pop-up</button></div>
    </div>
    <div class="card"><button class="btn danger" data-act="logout">Log out</button></div>`;
  $('#set-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#set-err'); err.textContent = '';
    try {
      const r = await api('/me/profile', { method: 'PUT', body: { name: $('#s-name').value, phone: $('#s-phone').value, mode: $('#s-mode').value, level: $('#s-level').value, goal: $('#s-goal').value, tz: Intl.DateTimeFormat().resolvedOptions().timeZone } });
      state.user = r.user; toast('Saved', 'ok');
    } catch (ex) { err.textContent = ex.message; }
  });
}

// ---------------------------------------------------------------- admin
async function viewAdmin() {
  const a = await api('/admin/summary');
  $('#view').innerHTML = `
    <div class="page-head"><div><h2>Admin</h2></div></div>
    <div class="grid4" style="margin-bottom:1rem">
      <div class="card stat"><div class="num">${a.users}</div><div class="lbl">Users</div></div>
      <div class="card stat"><div class="num">${a.paying}</div><div class="lbl">Paying</div></div>
      <div class="card stat"><div class="num">${KSH(a.revenue)}</div><div class="lbl">Revenue (live)</div></div>
      <div class="card stat"><div class="num">${KSH(a.credit_owed)}</div><div class="lbl">Credit owed</div></div>
    </div>
    <div class="card"><h3>Student requests</h3>${a.pending_students.length ? `<table><tbody>${a.pending_students.map((s) => `<tr><td>${esc(s.name)}<br><span class="muted small">${esc(s.email)}</span></td><td>ID: ${esc(s.student_id)}</td><td style="text-align:right"><button class="btn sm" data-act="stu" data-id="${s.id}" data-v="approve">Approve</button> <button class="btn sm danger" data-act="stu" data-id="${s.id}" data-v="reject">Reject</button></td></tr>`).join('')}</tbody></table>` : '<p class="muted">No pending requests.</p>'}</div>
    ${a.review_payments.length ? `<div class="card"><h3>Payments to review</h3><table><tbody>${a.review_payments.map((p) => `<tr><td>#${p.id}</td><td>${KSH(p.amount)}</td><td>${esc(p.receipt || '')}</td><td>${esc(p.result_desc)}</td></tr>`).join('')}</tbody></table></div>` : ''}
    <div class="card"><h3>Recent payments</h3><table><thead><tr><th>User</th><th>Plan</th><th>Amount</th><th>Status</th></tr></thead><tbody>${a.recent_payments.map((p) => `<tr><td>${esc(p.email)}</td><td>${esc(p.plan)}</td><td>${KSH(p.amount)}</td><td>${esc(p.status)}${p.demo ? ' (demo)' : ''}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">None yet</td></tr>'}</tbody></table></div>`;
}

// ---------------------------------------------------------------- reminders (15 minutes before)
function showReminder(r) {
  const host = $('#reminder-host');
  const when = r.minutes_until <= 0 ? 'starts now' : `starts in ${r.minutes_until} min`;
  host.innerHTML = `
    <div class="reminder" role="alert">
      <div class="t">⏰ Workout ${when}</div>
      <p style="margin:.3rem 0 .8rem">${esc(r.workout || 'Your session')} · ${fmtTime(r.start_time)} · ${r.minutes} min · ${placeLabel(r.place)}.<br><span class="muted small">You committed to this. Show up!</span></p>
      <div class="row tight"><button class="btn sm" data-act="reminder-go">Let's go</button><button class="btn sm dark" data-act="reminder-close">Later</button></div>
    </div>`;
  clearTimeout(showReminder.t);
  showReminder.t = setTimeout(() => { host.innerHTML = ''; }, 120000);
  try {
    if ('Notification' in window && Notification.permission === 'granted') {
      new Notification(`Workout ${when}`, { body: `${r.workout || 'Your session'} at ${fmtTime(r.start_time)}`, tag: 'tunu-reminder' });
    }
  } catch { /* some mobile browsers only allow service-worker notifications */ }
}

async function pollReminder() {
  if (!state.user || !state.user.onboarded) return; // keeps polling in a background tab so the notification can fire
  try {
    const r = await api('/reminders/due');
    if (r.due) {
      const k = `tunu_rem_${state.user.id}`;
      if (store(k) !== r.key) { store(k, r.key); showReminder(r); }
    }
  } catch { /* ignore */ }
}
let reminderTimer = null;
function startReminders() {
  clearInterval(reminderTimer);
  pollReminder();
  reminderTimer = setInterval(pollReminder, 30000);
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) pollReminder(); });

// ---------------------------------------------------------------- events
document.addEventListener('click', async (ev) => {
  const el = ev.target.closest('[data-act]');
  if (!el) return;
  const act = el.dataset.act;
  try {
    switch (act) {
      case 'auth-tab': state.authTab = el.dataset.tab; renderAuth(); break;
      case 'reload': render(); break;
      case 'slot-toggle': el.closest('.slot').classList.toggle('off', !el.checked); break;
      case 'onb-pick': state.onb[el.dataset.k] = el.dataset.v; renderOnboarding(); break;
      case 'onb-next': state.onb.goal = $('#o-goal').value; state.onb.level = $('#o-level').value;
        try {
          const r = await api('/me/profile', { method: 'PUT', body: { mode: state.onb.mode, goal: state.onb.goal, level: state.onb.level, tz: Intl.DateTimeFormat().resolvedOptions().timeZone } });
          state.user = r.user; state.onb.step = 2; renderOnboarding();
        } catch (e) { $('#onb-err').textContent = e.message; }
        break;
      case 'onb-back': state.onb.step = 1; renderOnboarding(); break;
      case 'onb-save': {
        const slots = collectSlots($('#sched'));
        if (!slots.length) { $('#onb-err').textContent = 'Tick at least one day.'; break; }
        busy(el, true, 'Saving...');
        try {
          const r = await api('/availability', { method: 'PUT', body: { slots } });
          state.user = r.user; location.hash = '#/dashboard'; render(); startReminders();
        } catch (e) { $('#onb-err').textContent = e.message; busy(el, false); }
        break;
      }
      case 'sched-save': {
        const slots = collectSlots($('#sched'));
        if (!slots.length) { $('#sch-err').textContent = 'Tick at least one day.'; break; }
        busy(el, true, 'Saving...');
        try { await api('/availability', { method: 'PUT', body: { slots } }); toast('Hours saved. Reminders are set.', 'ok'); $('#sch-err').textContent = ''; }
        catch (e) { $('#sch-err').textContent = e.message; }
        busy(el, false);
        break;
      }
      case 'filter': state.workoutFilter = el.dataset.v; viewWorkouts(); break;
      case 'month': state.month = el.dataset.v; viewProgress(); break;
      case 'open-workout': {
        let id = el.dataset.id;
        if (!id) { const { workouts } = await api('/workouts'); id = workouts.find((w) => !w.locked)?.id; }
        await openWorkout(id); break;
      }
      case 'close-modal': clearInterval(state.timer); $('#modal-host').innerHTML = ''; if (state.route === 'dashboard') viewDashboard(); break;
      case 'w-start': {
        busy(el, true, 'Starting...');
        try {
          const r = await api('/checkin/start', { method: 'POST', body: { workout_id: Number(el.dataset.id) } });
          state.skew = r.server_now - Date.now();
          busy(el, false); el.classList.add('hidden');
          runTimer(r.started_at, Number($('#modal-host').dataset.minNeed));
        } catch (e) { $('#w-err').textContent = e.message; busy(el, false); }
        break;
      }
      case 'w-finish': {
        busy(el, true, 'Checking in...');
        try {
          const r = await api('/checkin/complete', { method: 'POST' });
          clearInterval(state.timer);
          $('#modal-host').innerHTML = `<div class="overlay"><div class="modal" style="text-align:center"><div style="font-size:3rem">✅</div><h2>You showed up!</h2><p class="gold" style="font-family:var(--display);font-size:1.8rem;margin:0">+${KSH(r.earned)} credit</p><p class="muted">Streak: ${r.stats.streak} 🔥 · Credit balance ${KSH(r.credit)}</p><button class="btn block" data-act="close-modal">Nice</button></div></div>`;
          refreshUser();
        } catch (e) { $('#w-err').textContent = e.message; busy(el, false); }
        break;
      }
      case 'cant-today': {
        const g = state.user.grace_left;
        $('#modal-host').innerHTML = `<div class="overlay"><div class="modal"><h2>Can't make it today?</h2>
          <p class="muted">${g > 0 ? `Use a Grace Day: no penalty and your streak is protected. You have <b class="gold">${g}</b> left this month.` : 'You have no Grace Days left this month. Skipping counts as a miss.'}</p>
          <div class="row tight">${g > 0 ? '<button class="btn" data-act="use-grace">Use a Grace Day</button>' : '<button class="btn danger" data-act="skip">Skip today</button>'}<button class="btn ghost" data-act="close-modal">Never mind, I will train</button></div></div></div>`;
        break;
      }
      case 'use-grace': await api('/checkin/grace', { method: 'POST' }); $('#modal-host').innerHTML = ''; await refreshUser(); toast('Grace Day used. Rest well.', 'ok'); viewDashboard(); break;
      case 'skip': await api('/checkin/skip', { method: 'POST' }); $('#modal-host').innerHTML = ''; viewDashboard(); break;
      case 'pay-open': openPayBox(el.dataset.plan); break;
      case 'pay-cancel': $('#pay-box').innerHTML = ''; break;
      case 'pay-go': {
        busy(el, true, 'Sending...');
        try {
          const r = await api('/subscription/checkout', { method: 'POST', body: { plan: el.dataset.plan, phone: $('#pay-phone').value } });
          toast(r.message); watchPayment(r.payment.id);
        } catch (e) { const er = $('#pay-err'); if (er) er.textContent = e.message; busy(el, false); }
        break;
      }
      case 'student-open':
        $('#pay-box').innerHTML = `<div class="card gold-edge"><h3>Student verification</h3><p class="muted">Enter your student ID or admission number. We check it and unlock the student price, usually within a day.</p>
          <div class="field"><label for="stu-id">Student ID / admission no.</label><input id="stu-id" type="text" maxlength="40"></div><div class="err" id="stu-err" role="alert"></div>
          <div class="row tight"><button class="btn" data-act="student-send">Submit</button><button class="btn ghost" data-act="pay-cancel">Cancel</button></div></div>`;
        break;
      case 'student-send':
        try { await api('/student/request', { method: 'POST', body: { student_id: $('#stu-id').value } }); toast('Request sent. We will confirm soon.', 'ok'); renderShell(); }
        catch (e) { $('#stu-err').textContent = e.message; }
        break;
      case 'stu': await api(`/admin/students/${el.dataset.id}/${el.dataset.v}`, { method: 'POST' }); viewAdmin(); break;
      case 'notif': { const p = await Notification.requestPermission(); toast(p === 'granted' ? 'Device notifications on' : 'Notifications not enabled'); viewSettings(); break; }
      case 'test-reminder': showReminder({ minutes_until: 15, workout: 'Full Body Starter', start_time: '18:00', minutes: 30, place: state.user.mode === 'gym' ? 'gym' : 'home' }); break;
      case 'reminder-close': $('#reminder-host').innerHTML = ''; break;
      case 'reminder-go': $('#reminder-host').innerHTML = ''; if (location.hash === '#/dashboard') viewDashboard(); else location.hash = '#/dashboard'; break;
      case 'logout': await api('/auth/logout', { method: 'POST' }); state.user = null; clearInterval(reminderTimer); render(); break;
    }
  } catch (e) { toast(e.message, 'bad'); }
});

// ---------------------------------------------------------------- boot
(async function boot() {
  render();
  try { state.config = await api('/config'); } catch { /* shown later */ }
  try { const r = await api('/me'); state.user = r.user; } catch { state.user = null; }
  state.ready = true;
  render();
  if (state.user) startReminders();
})();
})();
