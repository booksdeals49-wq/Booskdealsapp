# COD Profit App (MVP)

An embedded Shopify admin app that computes **true COD (cash-on-delivery)
profit** per order/product/city — netting out COGS, delivery fees, RTO
(return-to-origin) costs, cash-handling fees, and tax — and layers on Meta
ad spend to show gross vs. "true" (COD-adjusted) ROAS. This is a from-scratch
MVP build inspired by the feature set of apps like Financify, not a copy of
anyone's code.

Built with the standard Shopify stack: Remix + Vite, Polaris, App Bridge,
Prisma (SQLite for dev), and the Shopify Admin GraphQL API.

## What's included (MVP scope)

- Cost Settings screen — configure default COGS %, delivery fee, RTO fee,
  cash handling %, tax %, packaging fee, currency.
- Dashboard — net profit, realized revenue, RTO rate, margin, ad spend,
  gross ROAS, **true ROAS** (COD-adjusted), a cost-breakdown table, and a
  "highest RTO-risk cities" table.
- Orders screen — every order in the last 30 days with its computed profit
  breakdown, and a one-click toggle to mark/unmark an order as RTO (also
  tags the order in Shopify so it stays visible outside the app).
- Ad Spend screen — connect a Meta ad account (access token + ad account
  ID) and sync daily spend for ROAS calculations.
- Order sync via webhooks (`orders/create`, `orders/updated`,
  `orders/cancelled`) plus an automatic 30-day backfill on first load.
- Mandatory GDPR compliance webhooks (`customers/data_request`,
  `customers/redact`, `shop/redact`) — required before any public listing.
- A framework-free profit calculation engine
  (`app/services/profit.server.ts`) with a standalone test suite
  (`npm run test:profit`) — 7/7 passing.

## What's deliberately NOT built yet (see "Path to full feature parity")

Google/TikTok/Snapchat ad integrations, WhatsApp report scheduling,
affiliate/UTM payout tracking, per-plan billing (Shopify Billing API),
and courier/3PL delivery-status integrations. These are straightforward
to add on top of this foundation — see below.

## Prerequisites

- Node.js 18.20+ (Node 20 or 22 recommended)
- A Shopify Partner account and a development store (you said you already
  have both)
- The Shopify CLI: `npm install -g @shopify/cli@latest`

## Setup

1. **Install dependencies**

   ```bash
   npm install
   ```

2. **Create the app in your Partner Dashboard and link it**

   From the project root:

   ```bash
   npm run config:link
   ```

   This walks you through selecting your Partner organization and either
   creating a new app or linking to an existing one, and writes your real
   `client_id` into `shopify.app.toml` (replacing the placeholder).

3. **Copy environment variables**

   ```bash
   cp .env.example .env
   ```

   Fill in `SHOPIFY_API_KEY` and `SHOPIFY_API_SECRET` from Partner Dashboard
   → your app → Client credentials. `SHOPIFY_APP_URL` gets set automatically
   by `shopify app dev` in the next step (it manages a tunnel URL for you),
   so you can leave it blank locally.

4. **Set up the database**

   ```bash
   npx prisma migrate dev --name init
   ```

   (Uses SQLite locally via `DATABASE_URL="file:./dev.sqlite"` — already set
   in `.env.example`.)

5. **Run the app**

   ```bash
   npm run dev
   ```

   The Shopify CLI opens a browser flow to install the app on your dev
   store, sets up a tunnel, and starts the Remix dev server. Approve the
   scopes (`read_orders,write_orders,read_products,read_customers`) when
   prompted.

6. **Try it out**

   - Place a couple of test orders on your dev store (Shopify lets you
     create orders with a "Cash on Delivery" style manual payment, or just
     use any payment method for testing — the app infers COD from the
     payment gateway name where possible and otherwise treats orders
     normally).
   - Visit **Cost Settings** in the app nav and set your delivery fee, RTO
     fee, etc.
   - Visit **Orders** and mark one as RTO to see how the numbers shift.
   - Visit **Dashboard** to see net profit, RTO rate, and the cost
     breakdown update.
   - Visit **Ad Spend**, paste in a Meta access token + ad account ID (see
     below), and sync to see gross vs. true ROAS.

### Getting a Meta access token for testing

1. Go to [Meta Graph API Explorer](https://developers.facebook.com/tools/explorer/).
2. Select (or create) a Meta App, choose your ad account's business, and
   generate a User or System User access token with the `ads_read`
   permission.
3. Your ad account ID is in Ads Manager, usually shown as `act_123456789012345`
   — you can paste it with or without the `act_` prefix.

This works for your own ad account without Meta App Review. Distributing
this to other merchants at scale (i.e. once you list the app publicly) will
need Meta Business verification and ideally a proper OAuth connect flow
instead of asking merchants to paste tokens.

## Project structure

```
app/
  services/
    profit.server.ts      # pure profit-calculation engine (no framework deps)
    profit.test.ts         # standalone test suite for the engine
    orderSync.server.ts    # Shopify order -> local OrderRecord sync + RTO inference
    metaAds.server.ts      # Meta Marketing API client
  routes/
    app.tsx                 # embedded app layout (Polaris + App Bridge nav)
    app._index.tsx           # Dashboard
    app.settings.tsx         # Cost Settings
    app.orders.tsx           # Orders + RTO toggle
    app.ad-spend.tsx         # Meta connection + ROAS
    auth.$.tsx                # OAuth
    webhooks.*.tsx            # order sync + mandatory GDPR webhooks
  shopify.server.ts         # Shopify app config, scopes, webhook registration
  db.server.ts               # Prisma client singleton
prisma/schema.prisma        # Session, CostSettings, ProductCost, OrderRecord,
                             # AdAccountConnection, AdSpend
```

## A note on the sandbox this was built in

This project was built and verified (type-check clean, production `vite
build` succeeds, all 7 profit-engine tests pass) inside a network-sandboxed
environment that could not reach `binaries.prisma.sh` to download Prisma's
native query engine, so `prisma generate` / `prisma migrate dev` could not
be run end-to-end here. That domain is reachable from virtually any normal
developer machine or CI runner, so this should be a non-issue for you —
just run `npx prisma migrate dev --name init` as step 4 above and it will
fetch the engine and create `dev.sqlite` automatically. If you hit the same
403 error on your machine, it usually means a corporate proxy/firewall is
blocking `binaries.prisma.sh`; allow that host, or set
`PRISMA_ENGINES_MIRROR` to an internal mirror if your org has one.

## Path to full feature parity (beyond this MVP)

Roughly in priority order:

1. **Google/TikTok/Snapchat ad spend** — same pattern as `metaAds.server.ts`:
   a small client module + a connection row in `AdAccountConnection`, then
   sum all platforms' `AdSpend` rows into the dashboard ROAS calculation.
2. **Real OAuth for ad platforms** instead of pasted tokens, once you're
   ready to onboard other merchants — needed for a smooth public-app
   experience and required by each platform's own review process.
3. **Courier/3PL integration** for automatic RTO detection (instead of
   manual/tag-based) — most COD couriers in South Asia/MENA (Leopards,
   TCS, Trax, PostEx, Bosta, etc.) have status webhooks or polling APIs;
   map their "returned" status to `OrderRecord.isRto = true`.
2. **WhatsApp report scheduling** — WhatsApp Business Cloud API (Meta) or
   Twilio, triggered by a cron job that queries the same profit summary
   this dashboard uses and formats it as a message.
5. **Affiliate/UTM payout tracking** — parse `sourceName`/landing-page UTM
   params off each order (already partially captured via `channel`), add
   an `Affiliate` model with a payout rate, compute payouts alongside
   profit.
6. **Shopify Billing API** — replace the "you own this on your own dev
   store" model with `AppSubscription`/usage-based billing so you can
   charge merchants in tiers, mirroring Financify's Free/Starter/Pro plans.
7. **Protected Customer Data (Level 2) approval** — required before
   public listing, since this app reads shipping city (and would need full
   PII if you expand beyond city-level analysis). Request it from the
   Partner Dashboard's API access section once the app is feature-complete,
   and budget review time before you can go live.
8. Swap SQLite for Postgres and move session/cost data storage to a
   production database before handling real merchant traffic.

## Testing the profit engine standalone

```bash
npm run test:profit
```

This runs `app/services/profit.test.ts` directly (no Shopify/DB dependency)
covering: standard delivered-order math, RTO-order math (zero revenue, no
cash-handling/tax, but delivery+RTO costs still apply), per-product cost
overrides beating the default COGS %, aggregate summary correctness, and
gross-vs-true ROAS.
#   c o d - p r o f i t - a p p  
 