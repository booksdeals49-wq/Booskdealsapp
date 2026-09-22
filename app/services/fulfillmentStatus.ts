// Pure fulfillment-status classification — no Prisma/Remix imports, same
// framework-free rationale as profit.server.ts and costSettingsResolver.ts,
// so it can be unit tested without a live database (and without Prisma even
// being generated, which orderSync.server.ts's top-level `db.server` import
// would otherwise force). orderSync.server.ts re-exports wasDispatched from
// here so every existing call site keeps importing it from there unchanged.

// The set of Shopify fulfillment-status values that actually mean an order
// has been handed to a courier — matches both the REST webhook's
// snake_case values ("fulfilled", "partial", "restocked") and the GraphQL
// displayFulfillmentStatus enum (FULFILLED, PARTIALLY_FULFILLED, RESTOCKED),
// normalized to lowercase-with-spaces so both shapes hit the same entries.
// Deliberately an EXACT allowlist rather than a loose substring check on
// "fulfil" — that used to false-positive on "UNFULFILLED" (which, read as
// plain text, literally contains the substring "fulfil": u-n-[fulfil]-led)
// and on "PENDING_FULFILLMENT", silently marking freshly-placed, never-
// touched orders as dispatched and skipping them straight into "pipeline"
// revenue instead of "pending fulfillment". IN_PROGRESS/ON_HOLD/OPEN/
// SCHEDULED are deliberately excluded too — none of them mean the order has
// actually left the warehouse yet.
const DISPATCHED_FULFILLMENT_STATUSES = new Set([
  "fulfilled",
  "partial",
  "partially fulfilled",
  "restocked",
]);

// A cancelled order was actually dispatched (and is therefore a real RTO,
// not just an administrative cancellation) if Shopify's fulfillment status
// shows it was fulfilled, partially fulfilled, or restocked (restocked is
// what Shopify itself calls it when a fulfilled order's items are returned
// to inventory).
export function wasDispatched(fulfillmentStatus?: string | null): boolean {
  const s = (fulfillmentStatus ?? "").toLowerCase().replace(/_/g, " ").trim();
  return DISPATCHED_FULFILLMENT_STATUSES.has(s);
}
