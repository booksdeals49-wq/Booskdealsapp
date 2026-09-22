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
  // Shopify's own per-variant "cost per item" (InventoryItem.unitCost) —
  // whatever the merchant/shipper already entered in Shopify's product
  // admin — captured as a snapshot at order-sync time, NOT re-fetched
  // live on every load. That matters because unitCost is a live property
  // of the variant, not order-time data Shopify retains historically: if
  // it were re-fetched every reconciliation pass, editing a product's cost
  // in Shopify later would silently change the recorded profit on old,
  // already-settled orders. Optional/nullable: undefined for line items
  // synced before this existed, null when Shopify has no cost on file for
  // that variant. See resolveUnitCost below for priority vs. the default
  // COGS % and the manual per-product override.
  shopifyUnitCost?: number | null;
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
  // Government tax on ad-platform transactions — % of ad spend (not
  // revenue), one blended rate across Meta/Google/TikTok/Snapchat. Not used
  // by computeOrderProfit below (it's not a per-order cost); applied at the
  // aggregate ad-spend level instead — see costSettingsResolver.ts's
  // computeAdSpendTax. Kept on this type so it versions the same way as
  // every other rate here.
  ecommerceTransactionTaxPercent: number;
};

export type ProductCostOverride = {
  variantId: string;
  costPerUnit: number;
};

// A merchant-configured delivery cost for one courier, e.g. TCS, Trax,
// Leopards, PostEx — see CourierRate in schema.prisma. Deliberately a
// simple "current value" list, not versioned by date the way CostSettings
// is (same precedent as ProductCostOverride above) — resolveDeliveryFee
// below always uses whatever's configured now.
export type CourierRateOverride = {
  courierName: string; // as entered by the merchant, e.g. "TCS", "Leopards Courier"
  cost: number;
};

export type OrderInput = {
  orderId: string;
  totalPrice: number;
  subtotalPrice: number;
  isCod: boolean;
  isRto: boolean;
  // Cancelled in Shopify WITHOUT ever being dispatched (stock issue, fraud
  // check, customer request before shipping) — as opposed to isRto, which
  // means it WAS dispatched and came back. No sale happened and no
  // delivery was attempted, so it's excluded from revenue and cost
  // entirely rather than being folded into either a normal completed
  // order or an RTO. Mutually exclusive with isRto in practice (see
  // orderSync.server.ts's computeIsRto), but both are passed through
  // explicitly here rather than re-derived, so this module stays
  // framework/DB-free.
  isCancelled: boolean;
  // Whether Shopify's courier/tracking integration has confirmed this
  // order was actually delivered (Fulfillment.deliveredAt). Only matters
  // for COD orders: a prepaid order's cash is already collected at
  // checkout, so it's realized revenue immediately regardless of delivery
  // status. A COD order's cash isn't collected until the courier hands it
  // over and takes payment — so until isDelivered is true, its revenue
  // sits in "pipeline" (placed, not yet collected) rather than "realized".
  // See computeOrderProfit for exactly how this splits revenue.
  isDelivered: boolean;
  // Whether Shopify shows this order as fulfilled/dispatched (handed to the
  // courier) — independent of isDelivered, which is the courier's later
  // confirmation that it actually reached the customer. This is what
  // drives cost timing: COGS, the outbound delivery fee, and packaging are
  // real the moment the order ships (the courier charges for the trip and
  // the product has physically left inventory) regardless of how the
  // delivery attempt turns out — exactly like an RTO order (dispatched,
  // then returned) already incurs them. Revenue realization stays tied to
  // isDelivered, not this — see computeOrderProfit.
  isDispatched: boolean;
  // Which courier/tracking company Shopify says actually shipped this
  // order (OrderRecord.trackingCompany — captured automatically from
  // Shopify's fulfillment tracking info, see orderSync.server.ts). Null/
  // undefined for an order with no fulfillment tracking info yet, or whose
  // courier integration doesn't report a tracking company at all. Used
  // only to pick a per-courier delivery cost — see resolveDeliveryFee.
  courierName?: string | null;
  lineItems: LineItem[];
};

export type OrderProfitBreakdown = {
  orderId: string;
  revenue: number;
  // Revenue for a COD order that's been placed but NOT YET dispatched to a
  // courier (isCod && !isDispatched && !isCancelled): the merchant hasn't
  // shipped it yet, so there's nothing "in transit" about it — it's simply
  // waiting to be fulfilled. Kept separate from pipelineRevenue below, which
  // is specifically the post-dispatch, awaiting-delivery stage. Always 0 for
  // prepaid orders and always 0 once the order is dispatched (at which point
  // the same amount moves into pipelineRevenue, then into revenue once
  // delivered).
  pendingFulfillmentRevenue: number;
  // Revenue for a COD order that HAS been dispatched to a courier but not
  // yet confirmed delivered (isCod && isDispatched && !isDelivered &&
  // !isRto): the sale isn't cancelled or returned, and it's genuinely in
  // transit, but no cash has actually changed hands yet, so it's excluded
  // from `revenue` and tracked here instead — "in the pipeline". Always 0
  // for prepaid orders (their cash is collected at checkout, so they're
  // realized immediately), always 0 before dispatch (see
  // pendingFulfillmentRevenue above), and always 0 once isDelivered flips
  // true (at which point the same amount moves into `revenue`).
  pipelineRevenue: number;
  // The cost already deducted from netProfit for THIS order while its
  // revenue is still sitting in pipelineRevenue — i.e. exactly what's
  // dragging net profit down for an order that hasn't paid off yet: 0 if
  // it hasn't shipped, or cogsLoss+deliveryFee+packagingFee once dispatched
  // (equal to this order's totalCost, since cash handling/tax stay 0 until
  // delivery). Not a separate cost — just totalCost isolated to pending
  // orders, so a Dashboard/Reports view can explain *why* net profit dipped
  // on a day with a lot of dispatches: "$X of today's cost is for orders
  // still in transit, $Y in matching revenue is expected once delivered."
  // Always 0 outside the pending-COD case.
  inTransitCost: number;
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
 * Resolve the per-unit cost for a line item, in priority order:
 *  1. A manual per-product override set in this app (most explicit —
 *     a merchant who set this specifically meant to override everything
 *     else).
 *  2. Shopify's own "cost per item" for that variant (shopifyUnitCost) —
 *     if the shipper/merchant already entered a real cost in Shopify's
 *     product admin, use that actual number instead of guessing.
 *  3. The shop's default COGS % assumption, applied to the item's selling
 *     price — the fallback for any product Shopify has no cost on file
 *     for.
 */
function resolveUnitCost(
  item: LineItem,
  overridesByVariant: Map<string, number>,
  defaultCogsPercent: number,
): number {
  const override = overridesByVariant.get(item.variantId);
  if (override !== undefined) return override;
  if (item.shopifyUnitCost != null) return item.shopifyUnitCost;
  return item.price * (defaultCogsPercent / 100);
}

function normalizeCourierName(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * The delivery fee to charge THIS order: the merchant's configured cost for
 * whichever courier actually shipped it (order.courierName, matched
 * against courierRates), falling back to the flat
 * CostSettings.deliveryFeeFlat when there's no detected courier or no
 * configured rate matches it. Matching is case-insensitive and tolerant of
 * either name being a substring of the other — Shopify's tracking_company
 * string rarely comes back in exactly the wording a merchant would type
 * into Cost Settings (e.g. a merchant-entered "TCS" should still match
 * Shopify reporting "TCS Express").
 */
function resolveDeliveryFee(
  courierName: string | null | undefined,
  courierRates: CourierRateOverride[],
  flatFee: number,
): number {
  if (!courierName) return flatFee;
  const detected = normalizeCourierName(courierName);
  if (!detected) return flatFee;
  const match = courierRates.find((rate) => {
    const configured = normalizeCourierName(rate.courierName);
    return (
      configured.length > 0 &&
      (detected === configured ||
        detected.includes(configured) ||
        configured.includes(detected))
    );
  });
  return match ? match.cost : flatFee;
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
  courierRates: CourierRateOverride[] = [],
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

  // A cancelled (never-dispatched) order is a no-op for profit purposes:
  // no cash was collected, no delivery was attempted, so none of the
  // delivery/RTO/handling/tax costs apply either — unlike an RTO order,
  // which WAS dispatched and so still incurs delivery + return shipping.
  // cogs is zeroed here too (not just cogsLoss) since an order cancelled
  // before dispatch — stock issue, fraud check, customer request — never
  // actually consumed inventory the way a dispatched-then-returned RTO
  // order did.
  if (order.isCancelled) {
    return {
      orderId: order.orderId,
      revenue: 0,
      pendingFulfillmentRevenue: 0,
      pipelineRevenue: 0,
      inTransitCost: 0,
      cogs: 0,
      cogsLoss: 0,
      deliveryFee: 0,
      rtoCost: 0,
      cashHandlingFee: 0,
      tax: 0,
      packagingFee: 0,
      totalCost: 0,
      netProfit: 0,
      marginPercent: 0,
    };
  }

  // A COD order that's been placed but that the courier hasn't yet
  // confirmed as delivered: not cancelled, not RTO, just still in flight
  // (whether or not it's shipped yet — see isDispatched below for that
  // distinction). Its revenue isn't realized yet — see
  // OrderProfitBreakdown.pendingFulfillmentRevenue / pipelineRevenue.
  // Prepaid (non-COD) orders skip this entirely: their cash is already in
  // hand at checkout, so they're realized immediately regardless of courier
  // status.
  const isPendingCod = order.isCod && !order.isDelivered && !order.isRto;
  // Split isPendingCod into its two distinct stages: still waiting to be
  // handed to a courier at all, vs. genuinely in transit / awaiting the
  // courier's delivery confirmation. Merchants read these very differently
  // — "I haven't shipped this yet" is an action item; "it's out for
  // delivery" is just a waiting game — so they get separate revenue
  // buckets instead of being lumped into one "pipeline" figure.
  const isPendingFulfillment = isPendingCod && !order.isDispatched;
  const isPendingDelivery = isPendingCod && order.isDispatched;

  const revenue = order.isRto ? 0 : isPendingCod ? 0 : order.totalPrice;
  const pendingFulfillmentRevenue = isPendingFulfillment ? order.totalPrice : 0;
  const pipelineRevenue = isPendingDelivery ? order.totalPrice : 0;

  // COGS, delivery fee and packaging become real costs the moment the
  // order is DISPATCHED (handed to the courier) — not when it's delivered.
  // The courier charges for the trip whether or not the delivery succeeds,
  // and the product has physically left inventory either way, so these are
  // sunk costs from dispatch onward regardless of the eventual outcome —
  // exactly like an RTO order (dispatched, then returned) already incurs
  // them today. Before dispatch (order just placed, nothing shipped yet),
  // none of this has happened, so there's genuinely nothing to charge yet.
  // Revenue realization is a separate question tied to isDelivered (cash
  // collection), not this — so a dispatched-but-undelivered COD order can
  // show a real negative net profit here (cost committed, cash not yet
  // in), which is the accurate in-transit picture rather than a deferred
  // zero.
  const costsIncurred = order.isRto || order.isDispatched;

  const cogsLoss = !costsIncurred
    ? 0
    : order.isRto && costSettings.rtoRestockable
      ? 0
      : cogs;
  const deliveryFee = costsIncurred
    ? resolveDeliveryFee(order.courierName, courierRates, costSettings.deliveryFeeFlat)
    : 0;
  const rtoCost = order.isRto ? costSettings.rtoFeeFlat : 0;
  const packagingFee = costsIncurred ? costSettings.packagingFeeFlat : 0;

  // Cash handling and tax are only meaningful on cash actually collected —
  // they don't apply to RTO'd (never collected) orders, and for a COD order
  // still awaiting delivery they haven't happened yet either, dispatched or
  // not. They get booked in the same period as the revenue itself, once
  // delivery is confirmed.
  const cashHandlingFee =
    order.isRto || isPendingCod
      ? 0
      : order.totalPrice * (costSettings.cashHandlingPercent / 100);
  const tax =
    order.isRto || isPendingCod
      ? 0
      : order.totalPrice * (costSettings.taxPercent / 100);

  const totalCost =
    cogsLoss + deliveryFee + rtoCost + cashHandlingFee + tax + packagingFee;

  const netProfit = revenue - totalCost;
  const marginPercent = revenue > 0 ? (netProfit / revenue) * 100 : 0;

  // See the field comment above — this is just totalCost, isolated to the
  // pending-delivery case, so the app can explain a net-profit dip instead
  // of leaving it looking like a straight loss. (Numerically this would be
  // 0 for a pending-fulfillment order anyway, since costsIncurred above is
  // false before dispatch — narrowed to isPendingDelivery here purely so
  // the name and the value agree: "in transit" cost for an order that
  // hasn't shipped would be a contradiction.)
  const inTransitCost = isPendingDelivery ? totalCost : 0;

  return {
    orderId: order.orderId,
    revenue,
    pendingFulfillmentRevenue,
    pipelineRevenue,
    inTransitCost,
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
  // Sum of pendingFulfillmentRevenue across all orders — placed COD orders
  // the merchant hasn't shipped yet. This is an action item ("go fulfill
  // these"), distinct from pipelineRevenue below (already shipped, just
  // waiting on the courier).
  pendingFulfillmentRevenue: number;
  // Sum of pipelineRevenue across all orders — COD orders that HAVE been
  // dispatched and are still awaiting courier-confirmed delivery. Shown
  // alongside `revenue` so a merchant can see cash already in hand vs. cash
  // still expected from orders genuinely in transit.
  pipelineRevenue: number;
  // Sum of inTransitCost — the portion of totalCost/netProfit above that
  // comes from orders still in the pipeline (dispatched, not yet
  // delivered). Use this to explain a net-profit dip: it's cost already
  // committed for orders whose matching revenue (pipelineRevenue) hasn't
  // landed yet, not a loss on those orders.
  inTransitCost: number;
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
      acc.pendingFulfillmentRevenue += b.pendingFulfillmentRevenue;
      acc.pipelineRevenue += b.pipelineRevenue;
      acc.inTransitCost += b.inTransitCost;
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
      pendingFulfillmentRevenue: 0,
      pipelineRevenue: 0,
      inTransitCost: 0,
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
