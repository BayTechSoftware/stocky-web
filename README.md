# Stocky Watcher (web)

Companion web app to the **Stocky** ESP32 device — a stock **watcher** with
buy/sell signals. Inspired by Portfolio Radar; built as its own small, focused app.

**Stack:** Next.js (App Router, TypeScript) · Tailwind · Supabase (Postgres + Auth)
· Twelve Data (market data) · Vercel (host + Cron).

## What v1 does
Log in → your watchlist of ~50–80 symbols, each scored with a buy/sell signal,
refreshed on a schedule:

- **Signal engine** (`lib/signals.ts`, pure + unit-tested): RSI(14), 50/200-day
  MAs, a Fibonacci-retracement **buy-zone band**, and a **BUY / WASHOUT / WATCH /
  OVERBOUGHT** assessment + 0–100 score. Thresholds are named constants — easy to tune.
- **Dashboard:** watchlist table (price · zone · RSI · signal · score), filters,
  a "buy signals today" panel, and a "since yesterday" change-log.
- **Refresh pipeline:** Vercel Cron → `/api/refresh` → Twelve Data (candles once/day,
  quotes periodically) → compute → upsert to Supabase → write a daily history row.

**Not in v1** (roadmap): positions/P&L · candidate screener · Congress/insider/13D ·
news + daily AI note · the device tie-in (push signals to the Stocky screen).

## Status
- ✅ Project scaffolded; **signal engine done + tested** (`npm test`, 13/13).
- ✅ Twelve Data client, Supabase schema, env template.
- ⏳ Next: auth + dashboard pages + the `/api/refresh` cron route (needs the accounts below).

## Setup
1. **Accounts** (create these — they can't be scripted):
   - **Twelve Data** → free API key.
   - **Supabase** → new project; note the URL + anon key + service-role key.
2. `cp .env.example .env.local` and fill in the keys.
3. In Supabase → SQL editor, run `supabase/schema.sql`.
4. `npm install` then `npm run dev` (http://localhost:3000).

## Scripts
- `npm run dev` — local dev server
- `npm run build` — production build
- `npm test` — run the signal-engine unit tests (vitest)
