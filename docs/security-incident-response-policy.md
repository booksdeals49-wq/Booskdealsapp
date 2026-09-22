# Security Incident Response Policy — COD Profit Analytics

**Owner:** Hamza Farooq
**Applies to:** the COD Profit Analytics Shopify app and its infrastructure (Railway-hosted app + Postgres database, Shopify Partner/Dev Dashboard, GitHub repository).

## 1. What counts as an incident

Any of the following:
- Unauthorized access to the app's database, hosting account, or source repository.
- Leaked or exposed credentials (`SHOPIFY_API_SECRET`, `TOKEN_ENCRYPTION_KEY`, `DATABASE_URL`, ad-platform tokens).
- A bug that exposes one merchant's data to another (cross-tenant leak).
- Suspicious/anomalous access patterns in Railway or Shopify Partner Dashboard logs.

## 2. Immediate response (first 24 hours)

1. **Contain**: rotate the affected credential immediately (Shopify Client Secret via Partner Dashboard "Rotate", `TOKEN_ENCRYPTION_KEY` and `DATABASE_URL` via Railway Variables) and redeploy.
2. **Assess scope**: check Railway logs and the database to determine which shops/records were potentially affected and what data was exposed.
3. **Stop the bleeding**: if the vulnerability is in app code, patch and deploy a fix before doing anything else; if it's a leaked secret, revoking it takes priority over root-causing.

## 3. Notification

1. **Merchants**: any merchant whose data was potentially exposed is notified by email (using the contact on file) within **72 hours** of confirming the incident, describing what happened, what data was involved, and what's being done.
2. **Shopify**: significant incidents affecting merchant or customer data are reported to Shopify via Partner Dashboard support, consistent with the Partner Program Agreement.
3. **Regulatory**: if the incident involves personal data of EU/UK individuals and meets GDPR's notification threshold, follow the 72-hour supervisory authority notification requirement.

## 4. Post-incident

1. Root-cause the issue and document what happened and why.
2. Ship a fix and, where practical, a regression test.
3. Review whether additional monitoring/logging would have caught it sooner, and add it if so.

## 5. Contact

Security reports / incidents: **hamzamukaty11@gmail.com**
