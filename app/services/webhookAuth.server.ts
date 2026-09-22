import { authenticate } from "../shopify.server";

// A hardened wrapper around @shopify/shopify-app-remix's
// authenticate.webhook() — use this in every webhook route instead of
// calling authenticate.webhook() directly.
//
// The library's authenticate.webhook() does more than verify the HMAC
// signature: with this app's `future.expiringOfflineAccessTokens` flag on
// (required — see shopify.server.ts's comment on why), it ALSO loads this
// shop's offline session and, if it's within 5 minutes of expiry, tries to
// refresh the access token — a live call to Shopify's OAuth token endpoint,
// made during webhook handling, even on a route that never touches
// `admin`/GraphQL at all (confirmed by reading
// ensure-offline-token-is-not-expired.ts / refresh-token.ts in
// @shopify/shopify-app-remix's own source: it happens unconditionally
// inside authenticate.webhook(), AFTER HMAC validation already passed).
//
// That refresh is *guaranteed* to fail for exactly the moment that matters
// most: APP_UNINSTALLED fires the instant a merchant uninstalls, which is
// also the instant Shopify revokes that shop's token — so if the stored
// session happens to be near expiry right then (far from a rare edge case),
// the library tries to refresh an already-revoked token, Shopify rejects
// it, and the whole request throws before our own cleanup code ever runs.
// The GDPR webhooks (SHOP_REDACT, CUSTOMERS_REDACT) that can follow days
// later for the same now-uninstalled shop hit the identical wall. A failed
// refresh throws a bare `Response(status: 500)` (or the underlying
// InvalidJwtError/HttpResponseError) — this is what shows up as "ERR" in
// Railway's logs for these routes.
//
// None of this app's webhook handlers use `admin` — every one of them only
// needs `shop` (and `payload`, for most) — so there is nothing to lose by
// not having a live, refreshed session. This wrapper calls the real
// authenticate.webhook() as normal; if it throws a Response carrying one of
// the library's own genuine validation-failure codes (400/401/405 — bad
// method, bad HMAC, malformed request), that's a real "this wasn't a valid
// Shopify webhook" and gets re-thrown as-is. Any OTHER failure is treated
// as the post-validation token-refresh crash described above: it falls
// back to Shopify's own X-Shopify-Shop-Domain header (present on every
// webhook request) for `shop`, and to a raw body read from a clone of the
// request taken BEFORE authenticate.webhook() ever consumed the original —
// so the caller still gets a usable `{ shop, payload }` and can finish its
// work instead of the request 500ing before it starts.
const VALIDATION_FAILURE_STATUSES = new Set([400, 401, 405]);

export async function authenticateWebhookResilient(
  request: Request,
): Promise<{ shop: string; payload: unknown }> {
  // Cloning tees the body stream — consuming the original inside
  // authenticate.webhook() below does not affect this copy.
  const bodyClone = request.clone();

  try {
    const { shop, payload } = await authenticate.webhook(request);
    return { shop, payload };
  } catch (err) {
    if (err instanceof Response && VALIDATION_FAILURE_STATUSES.has(err.status)) {
      throw err;
    }

    const shop = request.headers.get("X-Shopify-Shop-Domain");
    if (!shop) {
      // No usable fallback — surface the original failure rather than
      // guessing.
      throw err;
    }

    console.error(
      `authenticateWebhookResilient: authenticate.webhook() failed for ${shop} ` +
        `(most likely a revoked/expired offline-token refresh, not an HMAC ` +
        `failure — see this file's header comment) — proceeding with the ` +
        `shop header instead. Original error:`,
      err,
    );

    let payload: unknown = undefined;
    try {
      payload = JSON.parse(await bodyClone.text());
    } catch (parseErr) {
      console.error(
        "authenticateWebhookResilient: failed to parse the cloned webhook body",
        parseErr,
      );
    }
    return { shop, payload };
  }
}
