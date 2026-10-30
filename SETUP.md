# Stocky Watcher — setup

Three accounts to create, then local run, then deploy. ~15 minutes.

## 1. Twelve Data (market data)
1. https://twelvedata.com → **Sign up** (free).
2. Dashboard → **API Keys** → copy the key.
   - Free tier: 800 credits/day, 8 req/min — fine for ~50–80 names refreshed hourly.

## 2. Supabase (database + auth)
1. https://supabase.com → **New project** (name, strong DB password, nearest region). Wait ~2 min.
2. **Project Settings → API**, copy three values:
   - **Project URL** → `NEXT_PUBLIC_SUPABASE_URL`
   - **anon public** key → `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - **service_role** key (secret!) → `SUPABASE_SERVICE_ROLE_KEY`
3. **SQL Editor → New query** → paste all of `supabase/schema.sql` → **Run** (creates tables + RLS).
4. **Authentication → Providers → Email**: for quick testing you can turn **off** "Confirm email"
   so sign-up logs you straight in. (Leave it on to require the email confirmation link.)

## 3. Local run
```bash
cd /Users/ebay/Projects/stocky-web
cp .env.example .env.local        # then fill in all 5 values
# CRON_SECRET can be any random string:  openssl rand -hex 16
npm install
npm run dev                       # http://localhost:3000
```
- Create an account, add a few tickers.
- Populate signals once (the secret goes in the header, not the URL):
  `curl -H "Authorization: Bearer YOUR_CRON_SECRET" http://localhost:3000/api/refresh`,
  then reload the dashboard.

## 4. Vercel (deploy + hourly refresh)
1. Push to GitHub:
   ```bash
   git remote add origin git@github.com:<you>/stocky-web.git
   git push -u origin main
   ```
2. vercel.com → **Add New → Project** → import the repo (Next.js auto-detected).
3. **Settings → Environment Variables** → add the same 5 vars
   (`TWELVE_DATA_API_KEY`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
   `SUPABASE_SERVICE_ROLE_KEY`, `CRON_SECRET`). Deploy.
4. The `vercel.json` cron calls `/api/refresh` hourly; Vercel auto-sends
   `Authorization: Bearer $CRON_SECRET` because you set `CRON_SECRET`.
   - **Note:** the Vercel Hobby plan may limit cron frequency. If hourly isn't allowed,
     we can trigger the refresh from a Supabase scheduled function or an external ping.
5. **Supabase → Authentication → URL Configuration** → add your Vercel URL to **Site URL**
   and **Redirect URLs** so auth works on the deployed domain.

That's it — sign in, add your watchlist, and the signals fill in on the next refresh.
