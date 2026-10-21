# TUNU FIT

> Don't just start. Stay consistent.

A black-and-gold web app for **home and gym** workouts that rewards consistency: every workout you show up for takes **KSh 3 off** your subscription, and every **2 workouts you miss in a row** puts **KSh 2 back**. Subscriptions are paid with **M-Pesa (STK Push)**.

No build step and **zero npm dependencies**. It runs on Node's built-in SQLite.

## Run it

Needs **Node 22.5 or newer** (`node -v`).

```bash
cd tunu-fit
npm start
# open http://localhost:3000
```

It starts in **demo mode**: M-Pesa is simulated (a payment "succeeds" about 5 seconds after you start it, and no money moves). Create an account and click through everything.

Run the tests: `npm test`

## What's inside

| Feature | How it works |
|---|---|
| **Login / sign-up** | Email + password (scrypt-hashed), 30-day session cookie (HttpOnly, SameSite), login rate-limiting |
| **Home / Gym / Both** | Chosen at onboarding, changeable in Settings. Workout library is filtered to match |
| **Your hours** | For each day you commit to: start time, length (10-90 min), and Home or Gym. These are your commitments |
| **15-minute reminder** | A pop-up drops from the top of the screen at T-15 min ("Workout starts in 15 min"), plus an optional device notification |
| **Simple tracking** | Today card, 🔥 streak, 30-day consistency %, week strip, monthly calendar (✅ ❌ 💙), credit history |
| **Points / credit** | See rules below. Every change is written to a ledger you can audit |
| **M-Pesa** | STK Push + callback + status query, with credit applied at checkout |
| **Plans** | Free (3 days/week, free workouts) · Tunu Fit+ KSh 799 · Student KSh 399 |
| **Student plan** | Student submits their ID, you approve it in the **Admin** tab |

## The points rules

Edit them in one place: `RULES` at the top of `server/logic.js`.

- **+KSh 3** credit for every scheduled workout you complete.
- **−KSh 2** (price goes back up) for every **2 scheduled workouts missed in a row**. Missing 4 in a row = KSh 4 back. Missing just one costs nothing, and training in between resets the count.
- **2 Grace Days a month**: tap "I can't today" and nothing is lost.
- Only days you **scheduled** count, so a 3-days-a-week user is never punished on rest days.
- Credit can't go below KSh 0 and can cover at most **40% of a renewal** (KSh 319 on Plus), with a KSh 10 minimum charge. This protects your revenue.
- You must spend at least **half the workout's time** before "I showed up" unlocks, so it can't be tapped without training.
- The day someone signs up can earn credit but is never counted as a miss.

Misses are processed automatically the next time the user opens the app (no cron job needed).

## Going live with M-Pesa

1. Create a free account at <https://developer.safaricom.co.ke>, create an app, and enable **Lipa Na M-Pesa (STK Push)**. Copy the **Consumer Key / Secret**, and the **Passkey** + **Shortcode** from the test credentials page.
2. `cp .env.example .env` and fill it in. Setting `MPESA_CONSUMER_KEY` turns demo mode off.
3. Safaricom must reach your callback over **public https**. Locally use `ngrok http 3000` and set `PUBLIC_URL` to the ngrok address. Set `MPESA_CALLBACK_SECRET` to a long random string.
4. Restart, and pay with the sandbox test number from the Daraja portal.
5. For **real money**: apply for Daraja **Go Live** with your Paybill or Till number, then set `MPESA_ENV=production` and your production shortcode / passkey / keys. Till numbers use `MPESA_TRANSACTION_TYPE=CustomerBuyGoodsOnline`.

**Please test this against the Daraja sandbox yourself before taking real payments.** I could not reach Safaricom from my build environment, so the Daraja requests are written to their documented format but have not been run against the live API. The payment *logic* (credit reservation, callback handling, failures, duplicates, amount mismatch) is covered by the automated tests using simulated callbacks.

### What happens in a payment
1. The user taps Subscribe → the credit to be used is **reserved** (taken off their balance) and a prompt is sent to their phone.
2. They enter their PIN → Safaricom calls your callback → the plan is activated for 30 days.
3. If they cancel, time out, or it fails, the credit is **returned automatically**.
4. If the amount received doesn't match, the payment is flagged **"review"** in Admin and the plan is not activated.

## Deploying

Any Node 22 host works (a small VPS, Railway, Render, Fly.io). Requirements: persistent disk for `data/tunu.db`, https, and `COOKIE_SECURE=1`. Back up `data/tunu.db`.

## Honest limitations (next steps)

- **Reminders need the app open.** The pop-up and the browser notification appear while Tunu Fit is open in a tab (even in the background). A closed browser can't be reached by a website. Real background push comes with the installable app (service worker + web push, or native push) in the next phase.
- No email verification or password reset yet. That is the next thing to add (needs an email provider such as Resend or Brevo).
- Renewals are manual: the plan runs 30 days, then the user pays again. M-Pesa has no simple auto-debit. Add a reminder email/SMS before expiry.
- Student verification is a manual ID check by you. Re-check students periodically.
- Credit is a discount, not cash. Keep that in your Terms and add a Privacy Policy and health disclaimer before launch. You're storing health-related data, so review Kenya's Data Protection Act requirements.
- Workouts are starter content. Replace them with your own in `server/workouts.js`. Delete `data/tunu.db` to re-seed.

## Project layout

```
server/index.js      HTTP server + API routes
server/logic.js      points rules, settlement, streaks, reminders  ← the heart
server/mpesa.js      Daraja STK Push / query / callback parsing / demo mode
server/db.js         SQLite schema
server/workouts.js   seed workouts (edit me)
public/              the web app (index.html, styles.css, app.js)
test/                22 automated tests
```

## Turning it into an app later

The API is plain JSON over HTTP and the front end is a single-page app, so the next step is to add a web app manifest + service worker (installable PWA with real push reminders), or wrap it in Capacitor for the Play Store and App Store.
