// Fires on every fulfillment status change — the near-real-time path for
// both "courier tracking says in transit" and "courier tracking says
// delivered" (see shopify.server.ts's FULFILLMENTS_UPDATE registration).
// The payload here is a single Fulfillment resource (order_id, status,
// shipment_status, tracking info, created_at/updated_at), NOT a full order,
// so this can't run the usual syncOrderFromPayload — it just flips
// dispatchedAt/inTransitAt/deliveredAt on the matching OrderRecord as the
// courier's own status progresses.
//
// This is a fast-path convenience alongside, not instead of, the
// authoritative GraphQL reconciliation in orderSync.server.ts's
// backfillRecentOrders (which reads Shopify's real Fulfillment.createdAt /
// .inTransitAt / .deliveredAt timestamps on every Dashboard load and will
// fix/set these even if this webhook is ever missed or delayed).
import type { ActionFunctionArgs } from "@remix-run/node";
import prisma from "../db.server";
import { authenticateWebhookResilient } from "../services/webhookAuth.server";

type FulfillmentPayload = {
  order_id: number | string;
  status?: string | null;
  shipment_status?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  // The courier/tracking-company name for this fulfillment, e.g. "TCS",
  // "Leopards Courier" — see orderSync.server.ts's latestTrackingCompany
  // for the same field on the fuller order-sync paths. This is the
  // fastest of the three paths to pick up a courier: it fires the moment
  // Shopify has this info, without waiting for the next order webhook or
  // Dashboard-load reconciliation.
  tracking_company?: string | null;
};

// Same list used in orderSync.server.ts's webhook path — any of these means
// the courier has genuinely started moving the parcel, as opposed to
// Shopify merely showing the order as "fulfilled" (a label generated/handed
// off internally, which can sit at the shipper's end for a while before the
// courier actually picks it up). Kept as a separate literal here rather
// than importing, since this route only ever sees a single Fulfillment
// payload, not the full order shape orderSync.server.ts works with.
const IN_TRANSIT_SHIPMENT_STATUSES = [
  "in_transit",
  "out_for_delivery",
  "attempted_delivery",
  "carrier_picked_up",
  "delivered",
];

export const action = async ({ request }: ActionFunctionArgs) => {
  // This route never needs `admin` — see webhookAuth.server.ts for why the
  // resilient wrapper is used instead of calling authenticate.webhook()
  // directly.
  const { shop, payload } = await authenticateWebhookResilient(request);
  const fulfillment = payload as FulfillmentPayload;

  if (!fulfillment.order_id) {
    return new Response();
  }

  const shipmentStatus = (fulfillment.shipment_status || "").toLowerCase();
  const isDelivered = shipmentStatus === "delivered";
  const isInTransit = IN_TRANSIT_SHIPMENT_STATUSES.includes(shipmentStatus);

  const orderId = `gid://shopify/Order/${fulfillment.order_id}`;

  // Only ever SET each timestamp, never clear/overwrite it — same
  // one-directional-safe guard used everywhere else in the sync layer (see
  // orderSync.server.ts), so this can never silently undo a merchant's
  // manual correction from the Orders screen, and a redelivered webhook for
  // an already-set timestamp is a harmless no-op (the `xAt: null` filter
  // just matches nothing). Three separate updateMany calls rather than one
  // combined `data` object, since each field's guard condition is
  // independent (e.g. a "delivered" update should still backfill
  // dispatchedAt/inTransitAt if either was somehow missed).
  //
  // dispatchedAt is set unconditionally here (not gated on shipment_status)
  // because a fulfillment-update webhook firing at all means this
  // fulfillment exists — i.e. the order has been dispatched — regardless of
  // which particular shipment_status this update carries.
  const dispatchedAt = fulfillment.created_at
    ? new Date(fulfillment.created_at)
    : new Date();
  await prisma.orderRecord.updateMany({
    where: { shop, orderId, dispatchedAt: null },
    data: { dispatchedAt },
  });

  if (isInTransit) {
    await prisma.orderRecord.updateMany({
      where: { shop, orderId, inTransitAt: null },
      data: {
        inTransitAt: fulfillment.updated_at
          ? new Date(fulfillment.updated_at)
          : new Date(),
      },
    });
  }

  if (isDelivered) {
    await prisma.orderRecord.updateMany({
      where: { shop, orderId, deliveredAt: null },
      data: {
        deliveredAt: fulfillment.updated_at
          ? new Date(fulfillment.updated_at)
          : new Date(),
      },
    });
  }

  // A live Shopify fact, not something a merchant hand-edits in this app —
  // unlike dispatchedAt/inTransitAt/deliveredAt above, always safe to
  // overwrite with whatever the latest fulfillment update reports, no
  // "only if not already set" guard needed. No `where` filter beyond
  // shop+orderId, so a later correction (rare, but couriers do get
  // reassigned) is picked up too.
  if (fulfillment.tracking_company) {
    await prisma.orderRecord.updateMany({
      where: { shop, orderId },
      data: { trackingCompany: fulfillment.tracking_company },
    });
  }

  return new Response();
};
