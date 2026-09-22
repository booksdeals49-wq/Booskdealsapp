import { useMemo } from "react";
import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
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
  LocationIcon,
  ArrowUpIcon,
  ArrowDownIcon,
} from "@shopify/polaris-icons";
import type { IconSource } from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import {
  computeOrderProfit,
  summarizeProfit,
  computeRoas,
  type CostSettings as CostSettingsType,
} from "../services/profit.server";
import { backfillRecentOrders } from "../services/orderSync.server";
import {
  ProfitTrendChart,
  RtoRiskBars,
  CostBreakdownBar,
  COST_SEGMENT_COLORS,
  type TrendPoint,
} from "../components/DashboardVisuals";

const DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

type OrderRow = {
  orderId: string;
  totalPrice: number;
  subtotalPrice: number;
  isCod: boolean;
  isRto: boolean;
  lineItemsJson: string;
  city: string | null;
  createdAt: Date;
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const shop = session.shop;

  let orders = await prisma.orderRecord.findMany({
    where: {
      shop,
      createdAt: { gte: new Date(Date.now() - DAYS * DAY_MS) },
    },
  });

  // First-run convenience: if we have zero local orders, pull recent
  // history from Shopify so the dashboard isn't empty before webhooks fire.
  if (orders.length === 0) {
    await backfillRecentOrders(admin, shop, DAYS);
    orders = await prisma.orderRecord.findMany({
      where: {
        shop,
        createdAt: { gte: new Date(Date.now() - DAYS * DAY_MS) },
      },
    });
  }

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

  const costSettings = await prisma.costSettings.upsert({
    where: { shop },
    update: {},
    create: { shop },
  });
  const productCosts = await prisma.productCost.findMany({ where: { shop } });

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

  const settings: CostSettingsType = costSettings;
  const overrides = productCosts.map(
    (p: { variantId: string; costPerUnit: number }) => ({
      variantId: p.variantId,
      costPerUnit: p.costPerUnit,
    }),
  );

  const toBreakdown = (o: OrderRow) =>
    computeOrderProfit(
      {
        orderId: o.orderId,
        totalPrice: o.totalPrice,
        subtotalPrice: o.subtotalPrice,
        isCod: o.isCod,
        isRto: o.isRto,
        lineItems: JSON.parse(o.lineItemsJson),
      },
      settings,
      overrides,
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

  const grossOrderRevenue = (orders as OrderRow[]).reduce(
    (s, o) => s + o.totalPrice,
    0,
  );
  const roas = computeRoas(
    grossOrderRevenue,
    summary.revenue,
    summary.netProfit,
    totalAdSpend,
  );

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

  // City breakdown for the "highest RTO-risk cities" list.
  const byCity = new Map<
    string,
    { orders: number; rto: number; revenue: number }
  >();
  (orders as OrderRow[]).forEach((o) => {
    const key = o.city || "Unknown";
    const entry = byCity.get(key) || { orders: 0, rto: 0, revenue: 0 };
    entry.orders += 1;
    if (o.isRto) entry.rto += 1;
    entry.revenue += o.isRto ? 0 : o.totalPrice;
    byCity.set(key, entry);
  });
  const cityRows = Array.from(byCity.entries())
    .map(([city, v]) => ({
      city,
      ...v,
      rtoRate: v.orders > 0 ? (v.rto / v.orders) * 100 : 0,
    }))
    .sort((a, b) => b.rtoRate - a.rtoRate)
    .slice(0, 8);

  return json({
    shop,
    currency: costSettings.currency,
    summary,
    previousSummary,
    roas,
    totalAdSpend,
    orderCount: orders.length,
    cityRows,
    trendPoints,
  });
};

function money(n: number, currency: string) {
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
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
    orderCount,
    cityRows,
    trendPoints,
  } = useLoaderData<typeof loader>();

  const profitPositive = summary.netProfit >= 0;
  const netProfitDelta = percentChange(summary.netProfit, previousSummary.netProfit);
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
      ].map((seg, i) => ({ ...seg, color: COST_SEGMENT_COLORS[i % COST_SEGMENT_COLORS.length] })),
    [summary, totalAdSpend],
  );

  if (orderCount === 0) {
    return (
      <Page title="COD Profit Dashboard">
        <Card>
          <EmptyState
            heading="No orders in the last 30 days yet"
            image="https://cdn.shopify.com/s/files/1/0757/9955/files/empty-state.svg"
          >
            <p>
              Once orders come in (or Shopify sends the backfill), your true
              profit numbers will show up here.
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
          <Layout.Section>
            <InlineGrid columns={{ xs: 1, sm: 2, md: 4 }} gap="400">
              <StatCard
                label="Net profit"
                value={money(summary.netProfit, currency)}
                tone={profitPositive ? "success" : "critical"}
                icon={CashDollarIcon}
                deltaPercent={netProfitDelta}
              />
              <StatCard
                label="Revenue (realized)"
                value={money(summary.revenue, currency)}
                icon={ChartLineIcon}
                deltaPercent={revenueDelta}
              />
              <StatCard
                label="RTO rate"
                value={`${summary.rtoRatePercent.toFixed(1)}%`}
                tone={summary.rtoRatePercent > 20 ? "critical" : undefined}
                icon={ReturnIcon}
              />
              <StatCard
                label="Margin"
                value={`${summary.marginPercent.toFixed(1)}%`}
                icon={TargetIcon}
              />
            </InlineGrid>
          </Layout.Section>

          <Layout.Section>
            <Card>
              <BlockStack gap="300">
                <SectionHeading icon={ChartLineIcon} title="Net profit trend (last 30 days)" />
                <ProfitTrendChart points={trendPoints} />
              </BlockStack>
            </Card>
          </Layout.Section>

          <Layout.Section>
            <InlineGrid columns={{ xs: 1, sm: 3 }} gap="400">
              <StatCard
                label="Ad spend"
                value={money(totalAdSpend, currency)}
                icon={MegaphoneIcon}
              />
              <StatCard
                label="Gross ROAS"
                value={roas.grossRoas.toFixed(2)}
                icon={ChartHistogramGrowthIcon}
              />
              <StatCard
                label="True ROAS (COD-adjusted)"
                value={roas.trueRoas.toFixed(2)}
                tone={
                  totalAdSpend > 0 && roas.trueRoas < 1 ? "critical" : undefined
                }
                icon={TargetFilledIcon}
              />
            </InlineGrid>
          </Layout.Section>

          <Layout.Section>
            <Card>
              <BlockStack gap="400">
                <SectionHeading icon={CashDollarIcon} title="Cost breakdown (last 30 days)" />
                <CostBreakdownBar segments={costSegments} currency={currency} money={money} />
                <Divider />
                <DataTable
                  columnContentTypes={["text", "numeric"]}
                  headings={["Line", "Amount"]}
                  rows={[
                    ["COGS (counted as loss)", money(summary.cogs, currency)],
                    ["Delivery fees", money(summary.deliveryFees, currency)],
                    ["RTO costs", money(summary.rtoCosts, currency)],
                    [
                      "Cash handling fees",
                      money(summary.cashHandlingFees, currency),
                    ],
                    ["Taxes", money(summary.taxes, currency)],
                    ["Packaging", money(summary.packagingFees, currency)],
                    ["Ad spend", money(totalAdSpend, currency)],
                  ]}
                />
              </BlockStack>
            </Card>
          </Layout.Section>

          <Layout.Section>
            <Card>
              <BlockStack gap="300">
                <SectionHeading icon={LocationIcon} title="Highest RTO-risk cities" />
                {cityRows.length === 0 ? (
                  <Text as="p" tone="subdued">
                    No shipping city data on recent orders yet.
                  </Text>
                ) : (
                  <RtoRiskBars rows={cityRows} currency={currency} money={money} />
                )}
              </BlockStack>
            </Card>
          </Layout.Section>
        </Layout>
      </BlockStack>
    </Page>
  );
}

function SectionHeading({ icon, title }: { icon: IconSource; title: string }) {
  return (
    <InlineStack gap="200" blockAlign="center">
      <Icon source={icon} tone="subdued" />
      <Text as="h2" variant="headingMd">
        {title}
      </Text>
    </InlineStack>
  );
}

function StatCard({
  label,
  value,
  tone,
  icon,
  deltaPercent,
}: {
  label: string;
  value: string;
  tone?: "success" | "critical";
  icon?: IconSource;
  deltaPercent?: number | null;
}) {
  return (
    <Card>
      <BlockStack gap="200">
        <InlineStack align="space-between" blockAlign="center">
          <Text as="span" tone="subdued" variant="bodySm">
            {label}
          </Text>
          {icon && <Icon source={icon} tone="subdued" />}
        </InlineStack>
        <Text as="span" variant="headingLg" tone={tone}>
          {value}
        </Text>
        {deltaPercent !== undefined && deltaPercent !== null && (
          <InlineStack gap="100" blockAlign="center">
            <Icon
              source={deltaPercent >= 0 ? ArrowUpIcon : ArrowDownIcon}
              tone={deltaPercent >= 0 ? "success" : "critical"}
            />
            <Text
              as="span"
              variant="bodySm"
              tone={deltaPercent >= 0 ? "success" : "critical"}
            >
              {Math.abs(deltaPercent).toFixed(1)}% vs previous 30 days
            </Text>
          </InlineStack>
        )}
      </BlockStack>
    </Card>
  );
}
