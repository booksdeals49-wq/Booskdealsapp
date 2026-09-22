import { useMemo, useState } from "react";
import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { Link, useLoaderData } from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  Text,
  BlockStack,
  InlineStack,
  InlineGrid,
  DataTable,
  EmptyState,
  Divider,
  Icon,
} from "@shopify/polaris";
import {
  CashDollarIcon,
  ChartLineIcon,
  ReturnIcon,
  TargetIcon,
  MegaphoneIcon,
  ChartHistogramGrowthIcon,
  TargetFilledIcon,
  ClockIcon,
  ChevronRightIcon,
  ReceiptDollarIcon,
} from "@shopify/polaris-icons";
import { authenticate, registerWebhooks } from "../shopify.server";
import prisma from "../db.server";
import {
  computeOrderProfit,
  summarizeProfit,
  computeRoas,
} from "../services/profit.server";
import { backfillRecentOrders, wasDispatched } from "../services/orderSync.server";
import {
  getCostSettingsHistory,
  resolveCostSettingsAt,
  costRecognitionDate,
  computeAdSpendTax,
} from "../services/costSettingsHistory.server";
import { getCourierRateOverrides } from "../services/courierRates.server";
import {
  ProfitTrendChart,
  CostBreakdownBar,
  COST_SEGMENT_COLORS,
  type TrendPoint,
} from "../components/DashboardVisuals";
import { StatCard, SectionHeading, IconBadge, hexToRgba } from "../components/StatTile";
import { InsightsRow } from "../components/InsightsRow";
// `generateInsights` is a runtime function used only inside the loader below
// (tree-shaken out of the client bundle, same as the other `.server` loader
// imports above); the types are `import type` so they're erased entirely
// and safe to reference from the component too.
import { generateInsights } from "../services/insights.server";
import type { CityStat, ProductStat, Insight } from "../services/insights.server";
import { BRAND } from "../components/theme";

const DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
// Deliberately separate from DAYS above: DAYS drives what the Dashboard
// itself displays/aggregates (stat cards, trend chart, the "vs previous
// period" comparison window) — widening THAT changes what merchants see by
// default. This constant only controls how far back backfillRecentOrders
// looks when reconciling with Shopify, so older orders actually get pulled
// in and stored without changing the Dashboard's own 30-day display window.
const BACKFILL_DAYS = 60;

// Each stat card links to the page that explains it, colored by
// destination — not by whether the number is good or bad, that's what the
// card's own tone (profit/loss border + value color) already says. Reusing
// the same hex per destination everywhere means a merchant learns "gold =
// ad stuff" once and it holds across the whole dashboard.
const DEST = {
  reports: { url: "/app/reports", label: "Reports", color: BRAND.navy },
  orders: { url: "/app/orders", label: "Orders", color: "#4A6FA5" },
  adSpend: { url: "/app/ad-spend", label: "Ad Spend", color: BRAND.gold },
  costSettings: { url: "/app/settings", label: "Cost Settings", color: BRAND.warn },
} as const;

// Cost breakdown's section header is the one clickable element on this page
// that isn't a StatCard — same destination-color treatment (hover glow,
// arrow, colored label), scoped locally since SectionHeading itself is
// shared by several non-clickable screens.
function ClickableSectionHeading({
  icon,
  title,
  subtitle,
  dest,
}: {
  icon: Parameters<typeof SectionHeading>[0]["icon"];
  title: string;
  subtitle?: string;
  dest: (typeof DEST)[keyof typeof DEST];
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <Link to={dest.url} style={{ textDecoration: "none", color: "inherit", display: "block" }}>
      <div
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        style={{
          cursor: "pointer",
          borderRadius: 10,
          margin: "-8px",
          padding: "8px",
          background: hovered ? hexToRgba(dest.color, 0.05) : "transparent",
          transition: "background 150ms ease",
        }}
      >
        <InlineStack gap="300" blockAlign="center" wrap={false}>
          <IconBadge icon={icon} />
          <BlockStack gap="0">
            <InlineStack gap="150" blockAlign="center">
              <Text as="h2" variant="headingMd">
                {title}
              </Text>
              <span style={{ color: dest.color, opacity: hovered ? 1 : 0, transition: "opacity 150ms ease" }}>
                <Icon source={ChevronRightIcon} tone="inherit" />
              </span>
            </InlineStack>
            {subtitle && (
              <Text as="p" tone="subdued" variant="bodySm">
                {subtitle}
              </Text>
            )}
            <span style={{ display: "inline-flex", alignItems: "center", gap: 5, marginTop: 3 }}>
              <span style={{ width: 6, height: 6, borderRadius: 2, background: dest.color, flexShrink: 0 }} />
              <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.04em", textTransform: "uppercase", color: dest.color }}>
                {dest.label}
              </span>
            </span>
          </BlockStack>
        </InlineStack>
      </div>
    </Link>
  );
}

type OrderRow = {
  orderId: string;
  totalPrice: number;
  subtotalPrice: number;
  isCod: boolean;
  isRto: boolean;
  cancelledAt: Date | null;
  deliveredAt: Date | null;
  dispatchedAt: Date | null;
  fulfillmentStatus: string | null;
  trackingCompany: string | null;
  lineItemsJson: string;
  city: string | null;
  createdAt: Date;
};

// Cancelled-before-dispatch (stock issue, fraud check, customer request) —
// distinct from isRto, which means the order WAS dispatched and came back.
// No sale happened, so these are excluded from revenue everywhere below,
// the same way RTO orders are, but they also don't count as delivery
// attempts (unlike RTO, which did get shipped).
function isCancelledOrder(o: { isRto: boolean; cancelledAt: Date | null }) {
  return Boolean(o.cancelledAt) && !o.isRto;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const shop = session.shop;

  // Diagnostic: log exactly which access scopes Shopify has ACTUALLY
  // granted this shop's token right now, as opposed to what shopify.server.ts
  // is configured to request. These can drift apart — changing the SCOPES
  // env var only changes what a NEW authorization requests, it doesn't
  // retroactively broaden an already-issued token — so this makes that
  // drift directly visible in Railway logs instead of having to infer it
  // from webhook-registration failures like FULFILLMENTS_UPDATE needing
  // read_fulfillments. Safe/cheap to leave in permanently.
  try {
    const scopesResponse = await admin.graphql(
      `#graphql
      query CurrentAccessScopes {
        currentAppInstallation {
          accessScopes { handle }
        }
      }`,
    );
    const scopesJson = await scopesResponse.json();
    const grantedScopes = (
      scopesJson?.data?.currentAppInstallation?.accessScopes || []
    ).map((s: { handle: string }) => s.handle);
    console.log(
      `Currently granted access scopes for ${session.shop}: ${grantedScopes.join(", ") || "(none returned)"}`,
    );
  } catch (err) {
    console.error("Failed to fetch currently granted access scopes", err);
  }

  // Registering webhooks only happens automatically at install/re-auth time
  // (shopify.server.ts's afterAuth hook) — a shop that installed the app
  // before a new webhook topic (like FULFILLMENTS_UPDATE) was added to that
  // config would never actually get subscribed to it without reinstalling.
  // registerWebhooks() diffs against what's already registered and only
  // adds what's missing, so it's cheap and safe to call on every load —
  // this guarantees every installed shop picks up new topics automatically,
  // the same "reconcile on every load" guarantee backfillRecentOrders below
  // already provides for order data.
  await registerWebhooks({ session });

  // Reconcile with Shopify on every Dashboard load, not just when the local
  // database is empty. This used to be gated behind `orders.length === 0`
  // ("first-run convenience"), which meant it only ever ran once per shop —
  // after that, the dashboard relied entirely on webhooks to stay current,
  // and any missed/failed webhook delivery meant an order would never show
  // up no matter how many times the page was reloaded. syncOrderFromPayload
  // upserts (skip-if-exists on the create branch), so calling this on every
  // load is safe — it's just a small amount of extra Shopify API traffic to
  // guarantee nothing silently falls through the cracks.
  await backfillRecentOrders(admin, shop, BACKFILL_DAYS);

  const orders = await prisma.orderRecord.findMany({
    where: {
      shop,
      createdAt: { gte: new Date(Date.now() - DAYS * DAY_MS) },
    },
  });

  // A second, lightweight fetch for the *previous* 30-day window, purely so
  // the dashboard can show "vs previous period" deltas on the stat cards.
  const previousOrders = await prisma.orderRecord.findMany({
    where: {
      shop,
      createdAt: {
        gte: new Date(Date.now() - 2 * DAYS * DAY_MS),
        lt: new Date(Date.now() - DAYS * DAY_MS),
      },
    },
  });

  const costSettingsHistory = await getCostSettingsHistory(shop);
  const latestSettings = costSettingsHistory[costSettingsHistory.length - 1];
  const productCosts = await prisma.productCost.findMany({ where: { shop } });
  const courierRates = await getCourierRateOverrides(shop);

  const adSpendRows = await prisma.adSpend.findMany({
    where: {
      shop,
      date: { gte: new Date(Date.now() - DAYS * DAY_MS) },
    },
  });
  const totalAdSpend = adSpendRows.reduce(
    (s: number, r: { spend: number }) => s + r.spend,
    0,
  );

  // Also pull the previous period's ad spend, purely so the "vs previous
  // 30 days" delta on the Net profit card compares like-for-like (both
  // periods net of ad spend), not just the per-order cost stack.
  const previousAdSpendRows = await prisma.adSpend.findMany({
    where: {
      shop,
      date: {
        gte: new Date(Date.now() - 2 * DAYS * DAY_MS),
        lt: new Date(Date.now() - DAYS * DAY_MS),
      },
    },
  });
  const previousTotalAdSpend = previousAdSpendRows.reduce(
    (s: number, r: { spend: number }) => s + r.spend,
    0,
  );

  // Government tax on ad-platform transactions (Meta/Google/TikTok/Snapchat
  // combined) — blended single rate, resolved per-row by that row's own
  // date so a rate change never retroactively changes past tax. See
  // costSettingsResolver.ts's computeAdSpendTax.
  const ecommerceTransactionTax = computeAdSpendTax(
    adSpendRows as Array<{ date: Date; spend: number }>,
    costSettingsHistory,
  );
  const previousEcommerceTransactionTax = computeAdSpendTax(
    previousAdSpendRows as Array<{ date: Date; spend: number }>,
    costSettingsHistory,
  );

  const overrides = productCosts.map(
    (p: { variantId: string; costPerUnit: number }) => ({
      variantId: p.variantId,
      costPerUnit: p.costPerUnit,
    }),
  );

  // Each order's costs are computed under whichever CostSettings version
  // was in effect on ITS OWN dispatch/placement date — not today's rates —
  // so a merchant changing, say, the delivery fee never retroactively
  // changes what an already-dispatched order shows. See
  // costSettingsHistory.server.ts.
  const toBreakdown = (o: OrderRow) =>
    computeOrderProfit(
      {
        orderId: o.orderId,
        totalPrice: o.totalPrice,
        subtotalPrice: o.subtotalPrice,
        isCod: o.isCod,
        isRto: o.isRto,
        isCancelled: isCancelledOrder(o),
        isDelivered: Boolean(o.deliveredAt),
        isDispatched: wasDispatched(o.fulfillmentStatus),
        courierName: o.trackingCompany,
        lineItems: JSON.parse(o.lineItemsJson),
      },
      resolveCostSettingsAt(costSettingsHistory, costRecognitionDate(o)),
      overrides,
      courierRates,
    );

  const breakdowns = (orders as OrderRow[]).map(toBreakdown);
  const summary = summarizeProfit(
    breakdowns,
    (orders as OrderRow[]).map((o) => o.isRto),
  );

  const previousBreakdowns = (previousOrders as OrderRow[]).map(toBreakdown);
  const previousSummary = summarizeProfit(
    previousBreakdowns,
    (previousOrders as OrderRow[]).map((o) => o.isRto),
  );

  // Excludes cancelled (never-dispatched) orders — those were never a real
  // sale, unlike an RTO order, which WAS placed and dispatched and so still
  // belongs in "gross" (pre-return) revenue.
  const grossOrderRevenue = (orders as OrderRow[]).reduce(
    (s, o) => s + (isCancelledOrder(o) ? 0 : o.totalPrice),
    0,
  );
  const roas = computeRoas(
    grossOrderRevenue,
    summary.revenue,
    summary.netProfit,
    totalAdSpend,
  );

  // The headline "Net profit" figure is shown AFTER ad spend — profit.server.ts's
  // per-order netProfit intentionally excludes ad spend (it's ad-platform
  // agnostic), so ad spend is subtracted here once, at the aggregate level.
  const netProfitAfterAdSpend = summary.netProfit - totalAdSpend - ecommerceTransactionTax;
  const previousNetProfitAfterAdSpend =
    previousSummary.netProfit - previousTotalAdSpend - previousEcommerceTransactionTax;

  // Daily net-profit trend for the last DAYS days, zero-filled so gaps in
  // order activity don't break the chart's x-axis.
  const dayKey = (d: Date) => new Date(d).toISOString().slice(0, 10);
  const profitByDay = new Map<string, number>();
  (orders as OrderRow[]).forEach((o, i) => {
    const key = dayKey(o.createdAt);
    profitByDay.set(key, (profitByDay.get(key) || 0) + breakdowns[i].netProfit);
  });
  const trendPoints: TrendPoint[] = [];
  for (let i = DAYS - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * DAY_MS);
    const key = dayKey(d);
    trendPoints.push({ date: key, netProfit: profitByDay.get(key) || 0 });
  }

  // City breakdown for the "highest RTO-risk cities" list — also tracks
  // netProfit per city so we can derive a per-city margin for the Insights
  // row below.
  const byCity = new Map<
    string,
    { orders: number; rto: number; revenue: number; netProfit: number }
  >();
  (orders as OrderRow[]).forEach((o, i) => {
    // Cancelled (never-dispatched) orders are left out of city performance
    // entirely — they don't reflect a delivery attempt in that city one way
    // or the other, so counting them would just dilute the RTO rate.
    if (isCancelledOrder(o)) return;
    const key = o.city || "Unknown";
    const entry = byCity.get(key) || { orders: 0, rto: 0, revenue: 0, netProfit: 0 };
    entry.orders += 1;
    if (o.isRto) entry.rto += 1;
    entry.revenue += o.isRto ? 0 : o.totalPrice;
    entry.netProfit += breakdowns[i].netProfit;
    byCity.set(key, entry);
  });
  const cityStats: CityStat[] = Array.from(byCity.entries()).map(([city, v]) => ({
    city,
    orders: v.orders,
    rtoRate: v.orders > 0 ? (v.rto / v.orders) * 100 : 0,
    margin: v.revenue > 0 ? (v.netProfit / v.revenue) * 100 : null,
    revenue: v.revenue,
  }));

  // Product breakdown — apportions each order's netProfit across its line
  // items (weighted by each item's share of that order's revenue), grouped
  // by product, purely to surface a "best margin product" insight. This is
  // an approximation (order-level costs like delivery/RTO fees aren't
  // truly per-line-item) rather than a full per-product costing model.
  const byProduct = new Map<
    string,
    { title: string; orders: Set<string>; revenue: number; netProfit: number }
  >();
  (orders as OrderRow[]).forEach((o, i) => {
    const lineItems = JSON.parse(o.lineItemsJson) as Array<{
      productId: string;
      title: string;
      quantity: number;
      price: number;
    }>;
    const lineItemRevenueTotal = lineItems.reduce(
      (s, li) => s + li.price * li.quantity,
      0,
    );
    if (lineItemRevenueTotal <= 0) return;
    const b = breakdowns[i];
    lineItems.forEach((li) => {
      const share = (li.price * li.quantity) / lineItemRevenueTotal;
      const key = li.productId || li.title;
      const entry =
        byProduct.get(key) || { title: li.title, orders: new Set<string>(), revenue: 0, netProfit: 0 };
      entry.orders.add(o.orderId);
      entry.revenue += b.revenue * share;
      entry.netProfit += b.netProfit * share;
      byProduct.set(key, entry);
    });
  });
  const productStats: ProductStat[] = Array.from(byProduct.values()).map((v) => ({
    title: v.title,
    orders: v.orders.size,
    margin: v.revenue > 0 ? (v.netProfit / v.revenue) * 100 : null,
  }));

  const insights: Insight[] = generateInsights({
    netProfitAfterAdSpend,
    previousNetProfitAfterAdSpend,
    shopRtoRatePercent: summary.rtoRatePercent,
    cityStats,
    productStats,
    money: (n: number) => money(n, latestSettings.currency),
  });

  return json({
    shop,
    currency: latestSettings.currency,
    summary,
    previousSummary,
    roas,
    totalAdSpend,
    ecommerceTransactionTax,
    netProfitAfterAdSpend,
    previousNetProfitAfterAdSpend,
    orderCount: orders.length,
    trendPoints,
    insights,
  });
};

function money(n: number, currency: string) {
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(n);
  } catch {
    return `${currency} ${n.toFixed(2)}`;
  }
}

/** Percent change from `previous` to `current`; null when there's no
 * meaningful baseline to compare against (previous period had nothing). */
function percentChange(current: number, previous: number): number | null {
  if (previous === 0) return current === 0 ? 0 : null;
  return ((current - previous) / Math.abs(previous)) * 100;
}

export default function Dashboard() {
  const {
    currency,
    summary,
    previousSummary,
    roas,
    totalAdSpend,
    ecommerceTransactionTax,
    netProfitAfterAdSpend,
    previousNetProfitAfterAdSpend,
    orderCount,
    trendPoints,
    insights,
  } = useLoaderData<typeof loader>();

  const profitPositive = netProfitAfterAdSpend >= 0;
  const netProfitDelta = percentChange(netProfitAfterAdSpend, previousNetProfitAfterAdSpend);
  const revenueDelta = percentChange(summary.revenue, previousSummary.revenue);

  const costSegments = useMemo(
    () =>
      [
        { label: "COGS", value: summary.cogs },
        { label: "Delivery", value: summary.deliveryFees },
        { label: "RTO", value: summary.rtoCosts },
        { label: "Cash handling", value: summary.cashHandlingFees },
        { label: "Tax", value: summary.taxes },
        { label: "Packaging", value: summary.packagingFees },
        { label: "Ad spend", value: totalAdSpend },
        { label: "Ecommerce transaction tax", value: ecommerceTransactionTax },
      ].map((seg, i) => ({ ...seg, color: COST_SEGMENT_COLORS[i % COST_SEGMENT_COLORS.length] })),
    [summary, totalAdSpend, ecommerceTransactionTax],
  );

  if (orderCount === 0) {
    return (
      <Page title="COD Profit Dashboard">
        <Card>
          <EmptyState
            heading="Your dashboard will populate as new orders come in"
            image="https://cdn.shopify.com/s/files/1/0757/9955/files/empty-state.svg"
          >
            <p>
              cod-profit-app syncs orders placed from the moment it's
              installed onward — it doesn't have any order history to show
              yet. Once your next order comes in, it'll appear here
              automatically with its true profit calculated, and this page
              will fill in from there.
            </p>
          </EmptyState>
        </Card>
      </Page>
    );
  }

  return (
    <Page
      title="COD Profit Dashboard"
      subtitle={`Last 30 days · ${orderCount} orders`}
    >
      <BlockStack gap="500">
        <Layout>
          {insights.length > 0 && (
            <Layout.Section>
              <BlockStack gap="300">
                <InlineStack gap="200" blockAlign="center">
                  <Text as="h2" variant="headingMd">
                    Insights
                  </Text>
                  <span
                    style={{
                      background: BRAND.gold,
                      color: "#FFFFFF",
                      fontSize: 10,
                      fontWeight: 700,
                      letterSpacing: "0.04em",
                      padding: "2px 7px",
                      borderRadius: 4,
                    }}
                  >
                    NEW
                  </span>
                </InlineStack>
                <InsightsRow insights={insights} />
              </BlockStack>
            </Layout.Section>
          )}

          <Layout.Section>
            <BlockStack gap="400">
              {/* Hero treatment: the one number a merchant should see before
                  anything else on the page. The other three headline stats
                  are still right underneath, just visually secondary. */}
              <StatCard
                size="large"
                label="Net profit (after ad spend & tax)"
                value={money(netProfitAfterAdSpend, currency)}
                tone={profitPositive ? "success" : "critical"}
                icon={CashDollarIcon}
                deltaPercent={netProfitDelta}
                // A dip here isn't necessarily a loss — it can just mean a
                // lot got dispatched recently. Delivery/packaging/COGS cost
                // is deducted the moment an order ships (see profit.server.ts),
                // but that order's revenue doesn't land until it's actually
                // delivered — so a big dispatch day shows its cost today and
                // its revenue later. This spells out that gap instead of
                // leaving the number looking like a straight loss.
                footnote={
                  summary.inTransitCost > 0
                    ? `Includes ${money(summary.inTransitCost, currency)} in cost for orders still in transit — ${money(summary.pipelineRevenue, currency)} in matching revenue expected once delivered`
                    : undefined
                }
                url={DEST.reports.url}
                destinationLabel={DEST.reports.label}
                destinationColor={DEST.reports.color}
              />
              <InlineGrid columns={{ xs: 1, sm: 3 }} gap="400">
                <StatCard
                  label="Revenue (realized)"
                  value={money(summary.revenue, currency)}
                  icon={ChartLineIcon}
                  deltaPercent={revenueDelta}
                  url={DEST.orders.url}
                  destinationLabel={DEST.orders.label}
                  destinationColor={DEST.orders.color}
                />
                <StatCard
                  label="RTO rate"
                  value={`${summary.rtoRatePercent.toFixed(1)}%`}
                  tone={summary.rtoRatePercent > 20 ? "critical" : undefined}
                  icon={ReturnIcon}
                  url={DEST.reports.url}
                  destinationLabel={DEST.reports.label}
                  destinationColor={DEST.reports.color}
                />
                <StatCard
                  label="Margin"
                  value={`${summary.marginPercent.toFixed(1)}%`}
                  icon={TargetIcon}
                  url={DEST.reports.url}
                  destinationLabel={DEST.reports.label}
                  destinationColor={DEST.reports.color}
                />
              </InlineGrid>
            </BlockStack>
          </Layout.Section>

          <Layout.Section>
            <Card>
              <BlockStack gap="300">
                <SectionHeading
                  icon={ChartLineIcon}
                  title="Net profit trend (last 30 days)"
                  subtitle="Per-order profit only — ad spend isn't attributable to a single day/order, so it's netted out separately above and in Reports."
                />
                <ProfitTrendChart points={trendPoints} currency={currency} money={money} />
              </BlockStack>
            </Card>
          </Layout.Section>

          <Layout.Section>
            <BlockStack gap="400">
              {/* Two distinct not-yet-realized stages, kept side by side but
                  visually grouped and separate from Ad spend/ROAS below:
                  "pending fulfillment" is an action item (go ship these),
                  "pipeline" is just a waiting game (already shipped). */}
              <InlineGrid columns={{ xs: 1, sm: 2 }} gap="400">
                <StatCard
                  label="Pending fulfillment"
                  value={money(summary.pendingFulfillmentRevenue, currency)}
                  icon={ClockIcon}
                  footnote="Placed COD orders you haven't shipped yet"
                  url={DEST.orders.url}
                  destinationLabel={DEST.orders.label}
                  destinationColor={DEST.orders.color}
                />
                <StatCard
                  label="Unrealized revenue (pipeline)"
                  value={money(summary.pipelineRevenue, currency)}
                  icon={ClockIcon}
                  footnote="Dispatched COD orders awaiting courier-confirmed delivery"
                  url={DEST.orders.url}
                  destinationLabel={DEST.orders.label}
                  destinationColor={DEST.orders.color}
                />
              </InlineGrid>
              <InlineGrid columns={{ xs: 1, sm: 2, md: 4 }} gap="400">
                <StatCard
                  label="Ad spend"
                  value={money(totalAdSpend, currency)}
                  icon={MegaphoneIcon}
                  url={DEST.adSpend.url}
                  destinationLabel={DEST.adSpend.label}
                  destinationColor={DEST.adSpend.color}
                />
                <StatCard
                  label="Ecommerce transaction tax"
                  value={money(ecommerceTransactionTax, currency)}
                  icon={ReceiptDollarIcon}
                  footnote="Govt. tax on ad-platform spend"
                  url={DEST.costSettings.url}
                  destinationLabel={DEST.costSettings.label}
                  destinationColor={DEST.costSettings.color}
                />
                <StatCard
                  label="Gross ROAS"
                  value={roas.grossRoas.toFixed(2)}
                  icon={ChartHistogramGrowthIcon}
                  url={DEST.adSpend.url}
                  destinationLabel={DEST.adSpend.label}
                  destinationColor={DEST.adSpend.color}
                />
                <StatCard
                  label="True ROAS (COD-adjusted)"
                  value={roas.trueRoas.toFixed(2)}
                  url={DEST.adSpend.url}
                  destinationLabel={DEST.adSpend.label}
                  destinationColor={DEST.adSpend.color}
                  tone={
                    totalAdSpend > 0 && roas.trueRoas < 1 ? "critical" : undefined
                  }
                  icon={TargetFilledIcon}
                />
              </InlineGrid>
            </BlockStack>
          </Layout.Section>

          <Layout.Section>
            <Card>
              <BlockStack gap="400">
                <ClickableSectionHeading
                  icon={CashDollarIcon}
                  title="Cost breakdown (last 30 days)"
                  subtitle="Click to manage cost settings"
                  dest={DEST.costSettings}
                />
                <CostBreakdownBar segments={costSegments} currency={currency} money={money} />
                <Divider />
                <DataTable
                  columnContentTypes={["text", "numeric"]}
                  headings={["Line", "Amount"]}
                  rows={[
                    ["COGS", money(summary.cogs, currency)],
                    ["Delivery fees", money(summary.deliveryFees, currency)],
                    ["RTO costs", money(summary.rtoCosts, currency)],
                    [
                      "Cash handling fees",
                      money(summary.cashHandlingFees, currency),
                    ],
                    ["Taxes", money(summary.taxes, currency)],
                    ["Packaging", money(summary.packagingFees, currency)],
                    ["Ad spend", money(totalAdSpend, currency)],
                    ["Ecommerce transaction tax", money(ecommerceTransactionTax, currency)],
                  ]}
                />
              </BlockStack>
            </Card>
          </Layout.Section>
        </Layout>
      </BlockStack>
    </Page>
  );
}
