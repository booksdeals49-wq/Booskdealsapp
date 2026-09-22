import prisma from "../db.server";
import type { LineItem } from "./profit.server";
import { wasDispatched } from "./fulfillmentStatus";

// Re-exported so every existing call site (`import { wasDispatched } from
// "./orderSync.server"`) keeps working unchanged — the actual logic now
// lives in fulfillmentStatus.ts, kept framework-free so it's unit testable
// without a live database. See that file for the full rationale.
export { wasDispatched };

// Shopify doesn't have a native "RTO" concept — merchants using COD apps
// and courier/fulfillment integrations conventionally signal a
// returned-to-origin order via a tag or cancel reason, but the exact
// wording varies a lot by courier ("RTO", "Return to Sender", "RTO
// Initiated", "Undelivered - Returned", etc.). We match on any tag that
// CONTAINS one of these keywords (not an exact match) so more real-world
// courier tagging conventions are caught automatically — merchants can
// always flip it manually from the Orders screen too (see
// app.orders.tsx action) for anything this doesn't catch.
const RTO_KEYWORDS = [
  "rto",
  "return-to-origin",
  "return to origin",
  "returned",
  "return to sender",
  "undelivered",
  "delivery failed",
  "failed delivery",
  "cod refused",
  "refused",
];
const COD_GATEWAY_HINTS = [
  "cash on delivery",
  "cod",
  "cashondelivery",
  "cash-on-delivery",
  "pay on delivery",
  "payondelivery",
];
// A fulfillment's shipment_status (REST) / FulfillmentEventStatus (GraphQL)
// value that means the courier has genuinely started moving the package —
// as opposed to Shopify merely showing the order as "fulfilled", which only
// means a label was generated/handed off internally and can sit at the
// shipper's end for a while before the courier actually picks it up. Any of
// these (lowercased, matching the REST webhook's snake_case convention)
// count as "in transit" for the Orders page's status badge — not just the
// literal "in_transit" value, since out-for-delivery/picked-up/attempted
// all equally prove the courier has the parcel moving.
const IN_TRANSIT_SHIPMENT_STATUSES = [
  "in_transit",
  "out_for_delivery",
  "attempted_delivery",
  "carrier_picked_up",
  "delivered",
];

export type ShopifyOrderPayload = {
  admin_graphql_api_id?: string;
  id: number | string;
  name: string;
  total_price: string;
  subtotal_price: string;
  currency: string;
  financial_status: string | null;
  fulfillment_status: string | null;
  cancel_reason?: string | null;
  cancelled_at?: string | null;
  tags?: string;
  payment_gateway_names?: string[];
  created_at: string;
  shipping_address?: { city?: string; country?: string } | null;
  source_name?: string | null;
  referring_site?: string | null;
  // Present when a courier/tracking-company integration has posted a
  // status update onto this order's fulfillment(s). shipment_status
  // reaching "delivered" is what tells us a COD order's cash was actually
  // collected — see computeIsDelivered below. created_at is each
  // fulfillment's own dispatch timestamp, used as an approximate
  // dispatchedAt (see below) — corrected to Shopify's authoritative
  // Fulfillment.createdAt by the GraphQL backfill reconciliation.
  fulfillments?: Array<{
    shipment_status?: string | null;
    created_at?: string | null;
    // The courier/tracking-company name for this shipment, as reported by
    // whichever courier integration created it — e.g. "TCS", "Leopards
    // Courier". Used to auto-detect which courier fulfilled an order (see
    // latestTrackingCompany below) so profit.server.ts can apply that
    // courier's own configured cost instead of the flat delivery fee.
    tracking_company?: string | null;
  }> | null;
  line_items: Array<{
    variant_id: number | string | null;
    product_id: number | string | null;
    title: string;
    quantity: number;
    price: string;
  }>;
};

// Primary signal: the payment gateway's name. This only works when the
// gateway/app the merchant uses actually has "COD"/"cash on delivery" in
// its name — in practice there are a lot of third-party COD apps (courier
// integrations, custom checkout gateways) with names that don't contain
// any of those words at all, which silently made every order through them
// look prepaid (isCod: false) and realize full revenue immediately,
// regardless of delivery status. financialStatus is the fallback for
// exactly that case: a genuinely prepaid gateway authorizes/captures
// payment at checkout, so Shopify shows it as "paid" (or "authorized")
// within moments — a freshly placed order still sitting at "pending" means
// no cash has actually come in yet, which is precisely the situation this
// whole realized/unrealized split exists to track, whatever the gateway is
// called. This also self-corrects: once a pending order is later marked
// paid, isCod is recomputed on the very next reconciliation pass and flips
// back to false, so it stops being treated as COD.
function computeIsCod(
  gatewayNames?: string[] | null,
  financialStatus?: string | null,
): boolean {
  const gateways = (gatewayNames || []).map((g) => g.toLowerCase());
  if (
    gateways.some((g) => COD_GATEWAY_HINTS.some((hint) => g.includes(hint)))
  ) {
    return true;
  }
  return (financialStatus || "").toLowerCase() === "pending";
}

// Webhook-path delivery detection: true if any fulfillment's shipment
// status has reached "delivered". This only tells us THAT it's delivered,
// not exactly when — the more precise timestamp comes from
// Fulfillment.deliveredAt via the GraphQL backfill path below, which
// reconciles every order on every Dashboard load and will correct an
// approximate webhook-derived timestamp to the real one.
function isDeliveredFromWebhook(payload: ShopifyOrderPayload): boolean {
  return (payload.fulfillments || []).some(
    (f) => (f.shipment_status || "").toLowerCase() === "delivered",
  );
}

// Same idea as isDeliveredFromWebhook, but for "the courier has actually
// started moving this parcel" — see IN_TRANSIT_SHIPMENT_STATUSES above for
// why this is deliberately NOT the same thing as wasDispatched/Shopify's
// fulfillment status.
function isInTransitFromWebhook(payload: ShopifyOrderPayload): boolean {
  return (payload.fulfillments || []).some((f) =>
    IN_TRANSIT_SHIPMENT_STATUSES.includes(
      (f.shipment_status || "").toLowerCase(),
    ),
  );
}

// Earliest non-null fulfillment created_at across an order's fulfillments —
// an approximate dispatch timestamp for the fast webhook path (an order can
// have more than one shipment; the first one created is when it first
// actually shipped). Corrected to Shopify's authoritative
// Fulfillment.createdAt by the GraphQL backfill reconciliation below.
function earliestFulfillmentCreatedAt(
  payload: ShopifyOrderPayload,
): Date | null {
  const timestamps = (payload.fulfillments || [])
    .map((f) => f.created_at)
    .filter((t): t is string => Boolean(t))
    .sort();
  return timestamps.length ? new Date(timestamps[0]) : null;
}

// Fold a freshly-fetched set of line items' shopifyUnitCost values onto
// whatever was already recorded for this order, keeping the ALREADY-KNOWN
// cost rather than the fresh one wherever both exist. shopifyUnitCost is a
// snapshot, not a live value (see profit.server.ts's LineItem type) —
// InventoryItem.unitCost is a live property of the variant, so re-fetching
// it on every reconciliation pass and blindly overwriting would silently
// change an already-settled order's recorded profit every time the
// merchant edits that product's cost in Shopify later. Only ever fills in
// a cost that was previously missing (e.g. the merchant added a cost to
// Shopify after this order first synced) — same one-directional-safe
// principle used for isRto/deliveredAt/dispatchedAt/inTransitAt elsewhere
// in this file. Matches line items by variantId; falls back to the fresh
// value when there's nothing recorded yet to preserve.
function preserveKnownLineItemCosts(
  freshLineItems: LineItem[],
  existingLineItemsJson: string | null | undefined,
): LineItem[] {
  if (!existingLineItemsJson) return freshLineItems;
  let existing: LineItem[];
  try {
    existing = JSON.parse(existingLineItemsJson);
  } catch {
    return freshLineItems;
  }
  const existingByVariant = new Map(existing.map((li) => [li.variantId, li]));
  return freshLineItems.map((li) => {
    const prior = existingByVariant.get(li.variantId);
    if (prior && prior.shopifyUnitCost != null) {
      return { ...li, shopifyUnitCost: prior.shopifyUnitCost };
    }
    return li;
  });
}

// Which courier's name to record for this order — the most recently
// created fulfillment that actually reports a tracking_company (an order
// with more than one shipment from different couriers is rare; the latest
// one is the most relevant answer to "what did this order actually ship
// with"). Returns null when no fulfillment reports a tracking company at
// all (courier integration doesn't send one, or nothing's shipped yet).
function latestTrackingCompany(
  fulfillments: ShopifyOrderPayload["fulfillments"],
): string | null {
  const withCompany = (fulfillments || []).filter(
    (f): f is { shipment_status?: string | null; created_at?: string | null; tracking_company: string } =>
      Boolean(f.tracking_company),
  );
  if (!withCompany.length) return null;
  const sorted = [...withCompany].sort((a, b) =>
    (a.created_at || "").localeCompare(b.created_at || ""),
  );
  return sorted[sorted.length - 1].tracking_company;
}

// Shared by both sync paths (webhook payloads and the GraphQL backfill) so
// the two can't drift apart the way they did before — the backfill path
// used to reimplement this separately and only checked tags, missing
// cancellations entirely.
//
// isRto and "cancelled" are deliberately kept as two different signals
// rather than one. A cancellation on its own does NOT mean RTO — a
// merchant (or Shopify's fraud check) can cancel an order for stock
// issues, fraud, or a customer request, all of which happen BEFORE the
// order is ever dispatched, so nothing was actually "returned to origin".
// Only a cancellation on an order that had already been dispatched counts
// as a genuine RTO here; every other cancellation is tracked separately via
// OrderRecord.cancelledAt (see syncOrderFromPayload / backfillRecentOrders)
// so it shows as "Cancelled" rather than being folded into either RTO or a
// normal completed order.
function computeIsRto({
  tags,
  cancelReason,
  cancelledAt,
  fulfillmentStatus,
}: {
  tags?: string[] | string | null;
  cancelReason?: string | null;
  cancelledAt?: string | null;
  fulfillmentStatus?: string | null;
}): boolean {
  if (cancelledAt && wasDispatched(fulfillmentStatus)) return true;

  // Independent of cancellation: a courier/fulfillment integration that
  // tags an order (or, less commonly, sets a specific cancel_reason
  // wording) as a return, even on an order Shopify doesn't itself show as
  // cancelled. Kept as a fallback for whatever tagging convention a given
  // courier integration uses.
  const tagList = Array.isArray(tags) ? tags : (tags || "").split(",");
  const normalizedTags = tagList.map((t) => t.trim().toLowerCase());
  if (normalizedTags.some((t) => RTO_KEYWORDS.some((kw) => t.includes(kw))))
    return true;

  if (cancelReason) {
    const reason = cancelReason.toLowerCase();
    if (
      reason.includes("declined") ||
      reason.includes("undeliverable") ||
      RTO_KEYWORDS.some((kw) => reason.includes(kw))
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Upsert a local OrderRecord from a raw Shopify REST/webhook order payload.
 * Returns whether this was a brand-new order (vs. an update to one we
 * already had) — callers use that to avoid double-counting billing usage
 * on webhook redeliveries.
 */
export async function syncOrderFromPayload(
  shop: string,
  payload: ShopifyOrderPayload,
) {
  const lineItems: LineItem[] = payload.line_items.map((li) => ({
    variantId: li.variant_id
      ? `gid://shopify/ProductVariant/${li.variant_id}`
      : "",
    productId: li.product_id
      ? `gid://shopify/Product/${li.product_id}`
      : "",
    title: li.title,
    quantity: li.quantity,
    price: Number(li.price),
  }));

  const orderId =
    payload.admin_graphql_api_id ?? `gid://shopify/Order/${payload.id}`;

  const existing = await prisma.orderRecord.findUnique({
    where: { shop_orderId: { shop, orderId } },
    select: { id: true, dispatchedAt: true, inTransitAt: true, lineItemsJson: true },
  });

  // The REST order webhook payload's line_items never carry Shopify's
  // per-variant cost (that lives on InventoryItem, not the order) — only
  // the GraphQL backfill below can fetch it. So this just preserves
  // whatever shopifyUnitCost the backfill already recorded for this order,
  // rather than ever setting one from this path.
  const lineItemsWithKnownCosts = preserveKnownLineItemCosts(
    lineItems,
    existing?.lineItemsJson,
  );

  const isCod = computeIsCod(
    payload.payment_gateway_names,
    payload.financial_status,
  );
  const isRto = computeIsRto({
    tags: payload.tags,
    cancelReason: payload.cancel_reason,
    cancelledAt: payload.cancelled_at,
    fulfillmentStatus: payload.fulfillment_status,
  });
  const cancelledAt = payload.cancelled_at
    ? new Date(payload.cancelled_at)
    : null;
  const deliveredViaWebhook = isDeliveredFromWebhook(payload);
  const dispatchedViaWebhook = wasDispatched(payload.fulfillment_status);
  const inTransitViaWebhook = isInTransitFromWebhook(payload);
  const approxDispatchedAt = dispatchedViaWebhook
    ? earliestFulfillmentCreatedAt(payload) ?? new Date()
    : null;
  const trackingCompany = latestTrackingCompany(payload.fulfillments);

  // Build the update payload without isRto/deliveredAt by default, and only
  // add each when Shopify's current signals say so. That means this
  // webhook can flip isRto false -> true (e.g. a cancellation just came
  // in) or deliveredAt null -> set (a delivery just got confirmed), but can
  // never silently flip either back — which matters because both are also
  // fields a merchant can set by hand from the Orders screen (RTO toggle,
  // Mark as Delivered). Without this guard, an unrelated update webhook
  // would recompute either as false/null and quietly undo a manual
  // correction. cancelledAt has no such manual-override concern (nothing in
  // the app lets a merchant hand-edit it), so it's always safe to sync
  // straight from Shopify.
  const updateData: Record<string, unknown> = {
    totalPrice: Number(payload.total_price),
    subtotalPrice: Number(payload.subtotal_price),
    financialStatus: payload.financial_status,
    fulfillmentStatus: payload.fulfillment_status,
    isCod,
    cancelledAt,
    city: payload.shipping_address?.city ?? null,
    country: payload.shipping_address?.country ?? null,
    channel: payload.source_name ?? null,
    referringSite: payload.referring_site ?? null,
    lineItemsJson: JSON.stringify(lineItemsWithKnownCosts),
  };
  if (isRto) {
    updateData.isRto = true;
  }
  if (deliveredViaWebhook) {
    // Approximate — "now" rather than the real delivery moment, since the
    // REST webhook payload only gives us a status string, not a timestamp.
    // The GraphQL backfill reconciliation (below) supplies and corrects
    // this to Shopify's real Fulfillment.deliveredAt on the very next
    // Dashboard load, so this is just a fast, best-effort first signal.
    updateData.deliveredAt = new Date();
  }
  // Only ever SET dispatchedAt/inTransitAt, never overwrite an
  // already-recorded value — same one-directional guard as isRto/deliveredAt
  // above, and it also stops a later, less-precise webhook redelivery from
  // drifting an already-set timestamp forward to "now" every time this
  // fires. The GraphQL backfill reconciliation still corrects the very
  // first approximate value to Shopify's authoritative timestamp.
  if (dispatchedViaWebhook && !existing?.dispatchedAt) {
    updateData.dispatchedAt = approxDispatchedAt;
  }
  if (inTransitViaWebhook && !existing?.inTransitAt) {
    updateData.inTransitAt = new Date();
  }
  // Unlike isRto/deliveredAt/dispatchedAt/inTransitAt above, this is purely
  // a live Shopify fact a merchant never hand-edits in this app — so unlike
  // those one-directional guards, it's fine (and correct) to overwrite it
  // on every sync with whatever the freshest payload reports. Only ever set
  // when we actually have a value, so a redelivery/reconciliation pass that
  // happens not to carry fulfillment data never blanks out an already-known
  // courier.
  if (trackingCompany) {
    updateData.trackingCompany = trackingCompany;
  }

  await prisma.orderRecord.upsert({
    where: { shop_orderId: { shop, orderId } },
    update: updateData,
    create: {
      shop,
      orderId,
      orderNumber: payload.name,
      totalPrice: Number(payload.total_price),
      subtotalPrice: Number(payload.subtotal_price),
      currency: payload.currency,
      financialStatus: payload.financial_status,
      fulfillmentStatus: payload.fulfillment_status,
      isCod,
      isRto,
      cancelledAt,
      deliveredAt: deliveredViaWebhook ? new Date() : null,
      dispatchedAt: approxDispatchedAt,
      inTransitAt: inTransitViaWebhook ? new Date() : null,
      city: payload.shipping_address?.city ?? null,
      country: payload.shipping_address?.country ?? null,
      trackingCompany,
      channel: payload.source_name ?? null,
      referringSite: payload.referring_site ?? null,
      lineItemsJson: JSON.stringify(lineItems),
      createdAt: new Date(payload.created_at),
    },
  });

  return { isNew: !existing };
}

/**
 * Backfill recent orders for a shop right after install via the Admin
 * GraphQL API, so the dashboard isn't empty until new webhooks arrive.
 * Call this from the app._index loader on first load, or a background job.
 *
 * Paginates through every page of orders in the window rather than taking
 * only the first 100 — a single `first: 100` page silently dropped any
 * order past the 100 most-recent ones whenever a shop had more than that
 * many in the lookback window. Capped at MAX_PAGES so a pathological shop
 * (or a bug) can't turn this into an unbounded loop on every single
 * Dashboard load — this reconciles on every load, see the call site.
 */
export async function backfillRecentOrders(
  admin: { graphql: (query: string, opts?: any) => Promise<Response> },
  shop: string,
  days = 30,
) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const QUERY = `#graphql
    query BackfillOrders($query: String!, $cursor: String) {
      orders(first: 100, after: $cursor, query: $query, sortKey: CREATED_AT, reverse: true) {
        pageInfo { hasNextPage endCursor }
        edges {
          node {
            id
            name
            createdAt
            displayFinancialStatus
            displayFulfillmentStatus
            cancelledAt
            cancelReason
            tags
            sourceName
            paymentGatewayNames
            currentTotalPriceSet { shopMoney { amount currencyCode } }
            subtotalPriceSet { shopMoney { amount } }
            fulfillments(first: 10) {
              createdAt
              deliveredAt
              inTransitAt
              trackingInfo {
                company
              }
            }
            lineItems(first: 50) {
              edges {
                node {
                  title
                  quantity
                  originalUnitPriceSet { shopMoney { amount } }
                  variant {
                    id
                    inventoryItem {
                      unitCost { amount }
                    }
                  }
                  product { id }
                }
              }
            }
          }
        }
      }
    }`;

  // Far more than a "recent backfill" pass is meant to cover — 20 × 100 =
  // 2,000 orders in the window before this stops paginating further.
  const MAX_PAGES = 20;
  const allEdges: any[] = [];
  let cursor: string | null = null;
  let hasNextPage = true;
  let pageNum = 0;

  while (hasNextPage && pageNum < MAX_PAGES) {
    pageNum++;
    let response: Response;
    try {
      response = await admin.graphql(QUERY, {
        // No status: filter here on purpose — the GraphQL orders query has no
        // default status restriction when it's omitted entirely, so this
        // already returns orders of every status (open, closed, cancelled).
        // "status:any" is NOT valid syntax here (that's a REST-API-only
        // convention) — including it made Shopify reject the whole query.
        variables: { query: `created_at:>=${since}`, cursor },
      });
    } catch (err: any) {
      // Log the full GraphQL error detail (Shopify's client throws on any
      // GraphQL-level "errors" array, even with HTTP 200) so it's actually
      // visible in Railway logs instead of collapsing to "[Array]" / a bare
      // "Unexpected Server Error". Then fail soft on just THIS page: any
      // orders already collected from earlier pages still get processed
      // below, instead of throwing the whole backfill away.
      // Now confirmed: what gets thrown here is a raw, un-read fetch Response
      // (status/statusText/headers, body still an unread ReadableStream) —
      // not an Error and not a pre-parsed Shopify error class. Every earlier
      // attempt to read err.message / err.response.errors / etc. came back
      // empty because those properties genuinely don't exist on a Response.
      // The real error text from Shopify is sitting unread in the body, so
      // read that directly.
      if (err instanceof Response) {
        let bodyText = "(could not read response body)";
        try {
          bodyText = await err.text();
        } catch (readErr) {
          bodyText = `(reading body threw: ${String(readErr)})`;
        }
        console.error(
          `backfillRecentOrders: BackfillOrders request failed (page ${pageNum}) — HTTP ${err.status} ${err.statusText} — body: ${bodyText}`,
        );
      } else {
        // Fallback for any other shape, in case it's ever something else.
        console.error(
          `backfillRecentOrders: BackfillOrders query failed (page ${pageNum}) — raw error object follows:`,
        );
        console.error(err);
      }
      break;
    }

    const json = await response.json();
    if (json?.errors) {
      console.error(
        `backfillRecentOrders: BackfillOrders returned GraphQL errors (page ${pageNum}) —`,
        JSON.stringify(json.errors, null, 2),
      );
    }
    const pageEdges = json?.data?.orders?.edges ?? [];
    allEdges.push(...pageEdges);

    const pageInfo = json?.data?.orders?.pageInfo;
    hasNextPage = Boolean(pageInfo?.hasNextPage);
    cursor = pageInfo?.endCursor ?? null;
  }

  // Always log the raw count, success or not — otherwise a clean run with
  // zero results looks identical to a clean run with the expected results,
  // and there's no way to tell them apart from Railway logs alone.
  console.log(
    `backfillRecentOrders: found ${allEdges.length} order(s) across ${pageNum} page(s) from Shopify since ${since} — ${allEdges.map((e: any) => e.node.name).join(", ") || "(none)"}`,
  );

  // Batched pre-fetch of each order's already-recorded line items, so the
  // shopifyUnitCost merge below (preserveKnownLineItemCosts) doesn't need
  // an extra DB round-trip per order inside the loop.
  const existingRecords = await prisma.orderRecord.findMany({
    where: { shop, orderId: { in: allEdges.map((e: any) => e.node.id) } },
    select: { orderId: true, lineItemsJson: true },
  });
  const existingLineItemsByOrderId = new Map<string, string | null>(
    (existingRecords as Array<{ orderId: string; lineItemsJson: string | null }>).map(
      (r) => [r.orderId, r.lineItemsJson],
    ),
  );

  for (const { node } of allEdges) {
    const freshLineItems: LineItem[] = node.lineItems.edges.map((e: any) => ({
      variantId: e.node.variant?.id ?? "",
      productId: e.node.product?.id ?? "",
      title: e.node.title,
      quantity: e.node.quantity,
      price: Number(e.node.originalUnitPriceSet.shopMoney.amount),
      // Shopify's own "cost per item" for this variant, if the
      // merchant/shipper has entered one — see profit.server.ts's
      // resolveUnitCost for how this ranks against the default COGS %.
      shopifyUnitCost:
        e.node.variant?.inventoryItem?.unitCost?.amount != null
          ? Number(e.node.variant.inventoryItem.unitCost.amount)
          : null,
    }));
    // GraphQL always returns Shopify's CURRENT cost for the variant (a
    // live value, not order-time history) — preserve whatever cost was
    // already recorded for this order rather than letting a later edit to
    // the product's cost in Shopify retroactively change an already-synced
    // order. See preserveKnownLineItemCosts above.
    const lineItems = preserveKnownLineItemCosts(
      freshLineItems,
      existingLineItemsByOrderId.get(node.id),
    );

    const isCod = computeIsCod(
      node.paymentGatewayNames,
      node.displayFinancialStatus,
    );
    const isRto = computeIsRto({
      tags: node.tags,
      cancelReason: node.cancelReason,
      cancelledAt: node.cancelledAt,
      fulfillmentStatus: node.displayFulfillmentStatus,
    });
    const cancelledAt = node.cancelledAt ? new Date(node.cancelledAt) : null;
    // Diagnostic: exactly what Shopify told us for this order and what we
    // derived from it, so a mis-detected isCod (e.g. a COD gateway whose
    // name doesn't contain "cod"/"cash on delivery") is visible in Railway
    // logs immediately instead of requiring another guess-and-ship round.
    console.log(
      `backfillRecentOrders: ${node.name} — gateways=${JSON.stringify(node.paymentGatewayNames)} financialStatus=${node.displayFinancialStatus} fulfillmentStatus=${node.displayFulfillmentStatus} -> isCod=${isCod}`,
    );
    // Authoritative — this is Shopify's real Fulfillment.deliveredAt
    // timestamp, not the webhook path's approximated "now". Take the
    // earliest non-null one across fulfillments (an order can have more
    // than one shipment; the first to actually deliver is what matters).
    const deliveredTimestamps = (node.fulfillments || [])
      .map((f: any) => f.deliveredAt)
      .filter(Boolean)
      .sort();
    const deliveredAt = deliveredTimestamps.length
      ? new Date(deliveredTimestamps[0])
      : null;
    // Same idea, for dispatch (Fulfillment.createdAt) and in-transit
    // (Fulfillment.inTransitAt — a field Shopify itself populates only once
    // the courier's own tracking shows real movement, which is exactly the
    // "genuinely in transit, not just fulfilled" signal the Orders page
    // status badge needs). Both are authoritative here, unlike the
    // webhook path's approximated first-signal values.
    const dispatchedTimestamps = (node.fulfillments || [])
      .map((f: any) => f.createdAt)
      .filter(Boolean)
      .sort();
    const dispatchedAt = dispatchedTimestamps.length
      ? new Date(dispatchedTimestamps[0])
      : null;
    const inTransitTimestamps = (node.fulfillments || [])
      .map((f: any) => f.inTransitAt)
      .filter(Boolean)
      .sort();
    const inTransitAt = inTransitTimestamps.length
      ? new Date(inTransitTimestamps[0])
      : null;
    // Same "latest fulfillment that actually reports one" idea as the
    // webhook path's latestTrackingCompany, using Shopify's authoritative
    // Fulfillment.trackingInfo.company instead of the REST payload's
    // tracking_company string. trackingInfo is a list per fulfillment
    // (usually one entry) — take the first company each fulfillment
    // reports, then the most recently created fulfillment that had one.
    const trackingCompanyByDate = (node.fulfillments || [])
      .map((f: any) => ({
        company: f.trackingInfo?.[0]?.company ?? null,
        createdAt: f.createdAt ?? "",
      }))
      .filter((t: { company: string | null }) => Boolean(t.company))
      .sort((a: { createdAt: string }, b: { createdAt: string }) =>
        a.createdAt.localeCompare(b.createdAt),
      );
    const trackingCompany = trackingCompanyByDate.length
      ? trackingCompanyByDate[trackingCompanyByDate.length - 1].company
      : null;

    // This used to be `update: {}` — meaning once an order existed locally,
    // this reconciliation pass would never touch it again no matter how
    // Shopify's copy changed. That's exactly what let a courier-cancelled
    // order sit here forever showing as a normal delivered order: if the
    // orders/cancelled webhook for it was ever missed, nothing would ever
    // re-check it. Now every order in the window gets its mutable fields
    // refreshed from Shopify on every Dashboard load — the same
    // "reconcile on every load" guarantee this function already provides
    // for orders that never arrived, extended to orders whose status
    // changed after they arrived.
    //
    // isRto and deliveredAt are still only ever added to the update when
    // the fresh check/value is truthy, same guard as the webhook path
    // above — a routine reload should never be able to silently undo a
    // merchant's manual "not RTO" correction, or a manual "Mark as
    // Delivered", from the Orders screen.
    const updateData: Record<string, unknown> = {
      totalPrice: Number(node.currentTotalPriceSet.shopMoney.amount),
      subtotalPrice: Number(node.subtotalPriceSet.shopMoney.amount),
      financialStatus: node.displayFinancialStatus,
      fulfillmentStatus: node.displayFulfillmentStatus,
      isCod,
      cancelledAt,
      city: node.shippingAddress?.city ?? null,
      country: node.shippingAddress?.countryCodeV2 ?? null,
      channel: node.sourceName ?? null,
      lineItemsJson: JSON.stringify(lineItems),
    };
    if (isRto) {
      updateData.isRto = true;
    }
    if (deliveredAt) {
      updateData.deliveredAt = deliveredAt;
    }
    if (dispatchedAt) {
      updateData.dispatchedAt = dispatchedAt;
    }
    if (inTransitAt) {
      updateData.inTransitAt = inTransitAt;
    }
    // Live Shopify fact, not a merchant-editable one — same as the webhook
    // path, safe to overwrite on every reconciliation pass rather than
    // gated to "only ever set."
    if (trackingCompany) {
      updateData.trackingCompany = trackingCompany;
    }

    await prisma.orderRecord.upsert({
      where: { shop_orderId: { shop, orderId: node.id } },
      update: updateData,
      create: {
        shop,
        orderId: node.id,
        orderNumber: node.name,
        totalPrice: Number(node.currentTotalPriceSet.shopMoney.amount),
        subtotalPrice: Number(node.subtotalPriceSet.shopMoney.amount),
        currency: node.currentTotalPriceSet.shopMoney.currencyCode,
        financialStatus: node.displayFinancialStatus,
        fulfillmentStatus: node.displayFulfillmentStatus,
        isCod,
        isRto,
        cancelledAt,
        deliveredAt,
        dispatchedAt,
        inTransitAt,
        city: node.shippingAddress?.city ?? null,
        country: node.shippingAddress?.countryCodeV2 ?? null,
        trackingCompany,
        channel: node.sourceName ?? null,
        lineItemsJson: JSON.stringify(lineItems),
        createdAt: new Date(node.createdAt),
      },
    });
  }

  return allEdges.length;
}
