// Core COD profit calculation engine.
//
// This module is intentionally framework-free (no Prisma/Remix imports) so
// it can be unit tested in isolation and reused from webhooks, loaders, or
// a future background job without pulling in the whole app.

export type LineItem = {
  variantId: string;
  productId: string;
  title: string;
  quantity: number;
  price: number; // unit price charged to the customer, in shop currency
};

export type CostSettings = {
  defaultCogsPercent: number; // e.g. 35 means 35% of item price when no override exists
  deliveryFeeFlat: number; // charged on every order regardless of outcome
  rtoFeeFlat: number; // extra cost only when the order is returned to origin
  cashHandlingPercent: number; // % of order total
  taxPercent: number; // % of revenue (VAT/GST)
  packagingFeeFlat: number;
  // Whether a returned (RTO) order's inventory comes back sellable. When
  // true, COGS is NOT counted as a loss on RTO orders (only delivery + RTO
  // shipping are). When false, COGS is written off in full on every RTO.
  rtoRestockable: boolean;
};

export type ProductCostOverride = {
  variantId: string;
  costPerUnit: number;
};

export type OrderInput = {
  orderId: string;
  totalPrice: number;
  subtotalPrice: number;
  isCod: boolean;
  isRto: boolean;
  lineItems: LineItem[];
};

export type OrderProfitBreakdown = {
  orderId: string;
  revenue: number;
  // Raw product cost for the goods in this order, always calculated —
  // informational, and does not by itself reflect whether it hit profit.
  cogs: number;
  // The portion of `cogs` actually counted as a loss for this order: for a
  // non-RTO order this always equals `cogs`; for an RTO order it's 0 when
  // costSettings.rtoRestockable is true (inventory recovered, resellable)
  // or `cogs` when false (assumed unsellable). This is what feeds
  // totalCost/netProfit below, so it's the number that reconciles with them.
  cogsLoss: number;
  deliveryFee: number;
  rtoCost: number;
  cashHandlingFee: number;
  tax: number;
  packagingFee: number;
  totalCost: number;
  netProfit: number;
  marginPercent: number; // netProfit / revenue * 100, 0 when revenue is 0
};

/**
 * Resolve the per-unit cost for a line item: an explicit product-level
 * override if one exists, otherwise a percentage of the item's selling
 * price using the shop's default COGS assumption.
 */
function resolveUnitCost(
  item: LineItem,
  overridesByVariant: Map<string, number>,
  defaultCogsPercent: number,
): number {
  const override = overridesByVariant.get(item.variantId);
  if (override !== undefined) return override;
  return item.price * (defaultCogsPercent / 100);
}

/**
 * Compute the full profit breakdown for a single order.
 *
 * Key COD-specific rule: an order that came back RTO (return to origin)
 * earns zero realized revenue — the merchant never collected cash on
 * delivery — but still incurs delivery cost out AND the RTO cost of
 * shipping it back. Whether the product cost (COGS) is also a loss on that
 * order depends on costSettings.rtoRestockable: if the returned item goes
 * back into sellable inventory, COGS isn't written off (cogsLoss = 0); if
 * returns are typically damaged/unsellable, COGS is written off in full.
 */
export function computeOrderProfit(
  order: OrderInput,
  costSettings: CostSettings,
  productCosts: ProductCostOverride[],
): OrderProfitBreakdown {
  const overridesByVariant = new Map(
    productCosts.map((p) => [p.variantId, p.costPerUnit]),
  );

  const cogs = order.lineItems.reduce((sum, item) => {
    const unitCost = resolveUnitCost(
      item,
      overridesByVariant,
      costSettings.defaultCogsPercent,
    );
    return sum + unitCost * item.quantity;
  }, 0);

  const revenue = order.isRto ? 0 : order.totalPrice;

  const cogsLoss = order.isRto && costSettings.rtoRestockable ? 0 : cogs;
  const deliveryFee = costSettings.deliveryFeeFlat;
  const rtoCost = order.isRto ? costSettings.rtoFeeFlat : 0;
  const packagingFee = costSettings.packagingFeeFlat;

  // Cash handling and tax are only meaningful on cash actually collected,
  // so they don't apply to RTO'd (uncollected) orders.
  const cashHandlingFee = order.isRto
    ? 0
    : order.totalPrice * (costSettings.cashHandlingPercent / 100);
  const tax = order.isRto
    ? 0
    : order.totalPrice * (costSettings.taxPercent / 100);

  const totalCost =
    cogsLoss + deliveryFee + rtoCost + cashHandlingFee + tax + packagingFee;

  const netProfit = revenue - totalCost;
  const marginPercent = revenue > 0 ? (netProfit / revenue) * 100 : 0;

  return {
    orderId: order.orderId,
    revenue,
    cogs,
    cogsLoss,
    deliveryFee,
    rtoCost,
    cashHandlingFee,
    tax,
    packagingFee,
    totalCost,
    netProfit,
    marginPercent,
  };
}

export type ProfitSummary = {
  orderCount: number;
  rtoCount: number;
  rtoRatePercent: number;
  revenue: number;
  // Sum of cogsLoss (the portion actually counted as lost), not raw cogs —
  // this is what reconciles with totalCost/netProfit below.
  cogs: number;
  deliveryFees: number;
  rtoCosts: number;
  cashHandlingFees: number;
  taxes: number;
  packagingFees: number;
  totalCost: number;
  netProfit: number;
  marginPercent: number;
};

/** Aggregate a set of per-order breakdowns into a summary for a dashboard. */
export function summarizeProfit(
  breakdowns: OrderProfitBreakdown[],
  rtoFlags: boolean[],
): ProfitSummary {
  const orderCount = breakdowns.length;
  const rtoCount = rtoFlags.filter(Boolean).length;

  const totals = breakdowns.reduce(
    (acc, b) => {
      acc.revenue += b.revenue;
      acc.cogs += b.cogsLoss;
      acc.deliveryFees += b.deliveryFee;
      acc.rtoCosts += b.rtoCost;
      acc.cashHandlingFees += b.cashHandlingFee;
      acc.taxes += b.tax;
      acc.packagingFees += b.packagingFee;
      acc.totalCost += b.totalCost;
      acc.netProfit += b.netProfit;
      return acc;
    },
    {
      revenue: 0,
      cogs: 0,
      deliveryFees: 0,
      rtoCosts: 0,
      cashHandlingFees: 0,
      taxes: 0,
      packagingFees: 0,
      totalCost: 0,
      netProfit: 0,
    },
  );

  return {
    orderCount,
    rtoCount,
    rtoRatePercent: orderCount > 0 ? (rtoCount / orderCount) * 100 : 0,
    ...totals,
    marginPercent: totals.revenue > 0 ? (totals.netProfit / totals.revenue) * 100 : 0,
  };
}

export type RoasResult = {
  adSpend: number;
  grossRoas: number; // all order revenue (incl. RTO'd, pre-return) / spend
  trueRoas: number; // only realized (non-RTO) revenue / spend
  profitAfterAdSpend: number; // netProfit - adSpend
};

/**
 * ROAS the way a COD merchant actually cares about it: a naive ROAS counts
 * revenue the moment an order is placed, which overstates performance when
 * RTO rates are high (common for COD). "True ROAS" only counts revenue that
 * was actually collected.
 */
export function computeRoas(
  grossOrderRevenue: number,
  realizedRevenue: number,
  netProfit: number,
  adSpend: number,
): RoasResult {
  return {
    adSpend,
    grossRoas: adSpend > 0 ? grossOrderRevenue / adSpend : 0,
    trueRoas: adSpend > 0 ? realizedRevenue / adSpend : 0,
    profitAfterAdSpend: netProfit - adSpend,
  };
}
