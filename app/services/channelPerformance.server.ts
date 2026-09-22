// Channel-wise performance: orders, delivery rate, RTO ("RTS") rate, and
// average order value per marketing channel — classified from the
// referring URL captured at checkout (see services/channel.ts).

import prisma from "../db.server";
import { classifyChannel } from "./channel";

export type ChannelPerformanceRow = {
  channel: string;
  orders: number;
  delivered: number;
  rto: number;
  deliveryRatePercent: number;
  rtoRatePercent: number;
  avgOrderValue: number;
  performance: "good" | "average" | "poor";
};

function ratePerformance(deliveryRatePercent: number): "good" | "average" | "poor" {
  if (deliveryRatePercent >= 70) return "good";
  if (deliveryRatePercent >= 45) return "average";
  return "poor";
}

export async function getChannelPerformance(
  shop: string,
  from: Date,
  to: Date,
): Promise<ChannelPerformanceRow[]> {
  const orders = await prisma.orderRecord.findMany({
    where: { shop, createdAt: { gte: from, lt: to } },
  });

  type Accumulator = { orders: number; delivered: number; rto: number; grossTotal: number };
  const byChannel = new Map<string, Accumulator>();

  (
    orders as Array<{
      totalPrice: number;
      isRto: boolean;
      cancelledAt: Date | null;
      channel: string | null;
      referringSite: string | null;
    }>
  ).forEach((o) => {
    // Cancelled-before-dispatch orders never reached the delivery pipeline
    // for this channel one way or the other, so they're excluded rather
    // than silently counted as "delivered".
    if (o.cancelledAt && !o.isRto) return;
    const key = classifyChannel(o);
    const entry = byChannel.get(key) || { orders: 0, delivered: 0, rto: 0, grossTotal: 0 };
    entry.orders += 1;
    entry.delivered += o.isRto ? 0 : 1;
    entry.rto += o.isRto ? 1 : 0;
    entry.grossTotal += o.totalPrice;
    byChannel.set(key, entry);
  });

  return Array.from(byChannel.entries())
    .map(([channel, v]) => {
      const deliveryRatePercent = v.orders > 0 ? (v.delivered / v.orders) * 100 : 0;
      return {
        channel,
        orders: v.orders,
        delivered: v.delivered,
        rto: v.rto,
        deliveryRatePercent,
        rtoRatePercent: v.orders > 0 ? (v.rto / v.orders) * 100 : 0,
        avgOrderValue: v.orders > 0 ? v.grossTotal / v.orders : 0,
        performance: ratePerformance(deliveryRatePercent),
      };
    })
    .sort((a, b) => b.orders - a.orders);
}
