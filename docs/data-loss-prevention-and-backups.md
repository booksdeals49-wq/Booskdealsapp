# Data Loss Prevention & Backup Strategy — COD Profit Analytics

## Storage

- Production data lives in a managed Postgres database hosted on Railway. Railway encrypts storage volumes at rest and all connections use TLS in transit.
- The most sensitive fields — merchants' connected ad-platform credentials (`AdAccountConnection.accessToken`, `extraJson`) — are additionally encrypted at the application layer with AES-256-GCM before being written to the database (see `app/services/crypto.server.ts`), so they remain unreadable even from a raw database dump.

## Backups

- Automated backups are provided by Railway's managed Postgres plan. [Confirm your current Railway plan includes automated backups and note the retention window here, e.g. "daily backups, 7-day retention," once verified in the Railway dashboard's Postgres service settings.]
- Backups inherit the same at-rest encryption as the primary database (Railway-managed).

## Test / production separation

- Local development uses a separate Postgres database from production, provisioned independently (a second Railway Postgres service or an equivalent local/dev instance), so development and testing never read or write real merchant data.
- The schema is kept in sync via `npx prisma db push` against whichever database `DATABASE_URL` points to in that environment.

## Data minimization & retention

- The app stores only the minimum order data needed for profit/RTO analytics (order totals, financial/fulfillment status, shipping city + country code — not full street address, name, phone, or email).
- Data is removed on the relevant GDPR triggers: `customers/redact` deletes a specific customer's associated order data on request; `shop/redact` deletes all of a shop's data 48 hours after uninstall, per Shopify's mandatory compliance webhook requirements.

## Recovery

- In the event of data loss, the most recent Railway backup is restored. Application code and configuration are recoverable independently via the GitHub repository, which is the source of truth for everything except the database contents.
