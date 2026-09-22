// Product-wise delivery analysis: for each product, how many orders it
// appeared in, how many are still in flight, how many delivered vs. came
// back RTO, and the realized revenue attributable to it. This is the same
// per-order data the rest of the app already computes, re-grouped by
// product instead of by order/city/channel.

import prisma from "../db.server";
import type { LineItem } from "./profit.server";

type OrderRow = {
  orderId: string;
  isRto: boolean;
  cancelledAt: Date | null;
  fulfillmentStatus: string | null;
  lineItemsJson: string;
};

export type ProductDeliveryRow = {
  productId: string;
  title: string;
  orders: number;
  inProcess: number;
  delivered: number;
  rto: number;
  deliveryRatePercent: number;
  rtoRatePercent: number;
  revenueImpact: number; // realized (delivered-order) revenue attributable to this product
};

function isFulfilled(status: string | null): boolean {
  return (status ?? "").toLowerCase() === "fulfilled";
}

export async function getProductDelivery(
  shop: string,
  from: Date,
  to: Date,
): Promise<ProductDeliveryRow[]> {
  const orders = await prisma.orderRecord.findMany({
    where: { shop, createdAt: { gte: from, lt: to } },
  });

  type Accumulator = {
    title: string;
    orders: number;
    inProcess: number;
    delivered: number;
    rto: number;
    revenueImpact: number;
  };
  const byProduct = new Map<string, Accumulator>();

  (orders as OrderRow[]).forEach((o) => {
    // Cancelled-before-dispatch orders never reached the delivery pipeline
    // for this product one way or the other, so they're excluded rather
    // than silently counted as "in process" or "delivered".
    if (o.cancelledAt && !o.isRto) return;

    const lineItems: LineItem[] = JSON.parse(o.lineItemsJson);
    // A product counts once per order even if it has multiple line entries
    // in that order (e.g. two variants of the same product).
    const seenInThisOrder = new Set<string>();

    lineItems.forEach((item) => {
      const key = item.productId || item.title;
      if (seenInThisOrder.has(key)) {
        // Still add to revenue impact for additional line quantity, but
        // don't double count the order/delivery/RTO tallies below.
        if (!o.isRto) {
          const entry = byProduct.get(key);
          if (entry) entry.revenueImpact += item.price * item.quantity;
        }
        return;
      }
      seenInThisOrder.add(key);

      const entry = byProduct.get(key) || {
        title: item.title,
        orders: 0,
        inProcess: 0,
        delivered: 0,
        rto: 0,
        revenueImpact: 0,
      };
      entry.orders += 1;
      if (o.isRto) {
        entry.rto += 1;
      } else if (!isFulfilled(o.fulfillmentStatus)) {
        entry.inProcess += 1;
      } else {
        entry.delivered += 1;
      }
      if (!o.isRto) {
        entry.revenueImpact += item.price * item.quantity;
      }
      byProduct.set(key, entry);
    });
  });

  return Array.from(byProduct.entries())
    .map(([productId, v]) => ({
      productId,
      title: v.title,
      orders: v.orders,
      inProcess: v.inProcess,
      delivered: v.delivered,
      rto: v.rto,
      deliveryRatePercent: v.orders > 0 ? (v.delivered / v.orders) * 100 : 0,
      rtoRatePercent: v.orders > 0 ? (v.rto / v.orders) * 100 : 0,
      revenueImpact: v.revenueImpact,
    }))
    .sort((a, b) => b.orders - a.orders);
}
