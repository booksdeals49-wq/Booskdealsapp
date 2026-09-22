// Pure, dependency-free insight-generation logic for the Dashboard's
// "Insights" row. Deliberately takes plain pre-aggregated numbers (not
// Prisma models) so it stays easy to unit test and reason about — all the
// actual data fetching/aggregation happens in app._index.tsx's loader.

export type InsightTone = "success" | "critical" | "warn" | "gold";

export type Insight = {
  tone: InsightTone;
  tag: string;
  headline: string;
  detail: string;
};

export type CityStat = {
  city: string;
  orders: number;
  rtoRate: number; // percent, 0-100
  margin: number | null; // percent, null if not enough revenue to compute
  revenue: number;
};

export type ProductStat = {
  title: string;
  orders: number;
  margin: number | null; // percent, null if not enough revenue to compute
};

/** Percent change from `previous` to `current`; null when there's no meaningful baseline. */
function percentChange(current: number, previous: number): number | null {
  if (previous === 0) return current === 0 ? 0 : null;
  return ((current - previous) / Math.abs(previous)) * 100;
}

const MIN_CITY_ORDERS = 5;
const MIN_PRODUCT_ORDERS = 3;
const TREND_THRESHOLD_PERCENT = 8;
const ANOMALY_MIN_ABSOLUTE_GAP = 10; // percentage points above shop average

export function generateInsights(input: {
  netProfitAfterAdSpend: number;
  previousNetProfitAfterAdSpend: number;
  shopRtoRatePercent: number;
  cityStats: CityStat[];
  productStats: ProductStat[];
  money: (n: number) => string;
}): Insight[] {
  const { cityStats, productStats, money } = input;
  const insights: Insight[] = [];

  // 1. Trend — net profit vs. previous period.
  const trendPercent = percentChange(
    input.netProfitAfterAdSpend,
    input.previousNetProfitAfterAdSpend,
  );
  if (trendPercent !== null && Math.abs(trendPercent) >= TREND_THRESHOLD_PERCENT) {
    const up = trendPercent >= 0;
    insights.push({
      tone: up ? "success" : "critical",
      tag: "Trend",
      headline: `Net profit ${up ? "up" : "down"} ${Math.abs(trendPercent).toFixed(0)}% vs. last period`,
      detail: `${money(input.netProfitAfterAdSpend)} this period${
        up ? " — your best stretch in a while." : " — worth a closer look at what changed."
      }`,
    });
  }

  // 2. Anomaly — a city with an RTO rate well above the shop average.
  const anomalyCity = cityStats
    .filter((c) => c.orders >= MIN_CITY_ORDERS)
    .sort((a, b) => b.rtoRate - a.rtoRate)[0];
  if (
    anomalyCity &&
    anomalyCity.rtoRate - input.shopRtoRatePercent >= ANOMALY_MIN_ABSOLUTE_GAP &&
    anomalyCity.rtoRate > input.shopRtoRatePercent * 1.3
  ) {
    insights.push({
      tone: "critical",
      tag: "Anomaly",
      headline: `RTO rate spiked in ${anomalyCity.city}`,
      detail: `${anomalyCity.rtoRate.toFixed(0)}% this period — well above your shop average of ${input.shopRtoRatePercent.toFixed(0)}%.`,
    });
  }

  // 3. Top performer — best-margin product with meaningful volume.
  const topProduct = productStats
    .filter((p) => p.orders >= MIN_PRODUCT_ORDERS && p.margin !== null)
    .sort((a, b) => (b.margin as number) - (a.margin as number))[0];
  if (topProduct) {
    insights.push({
      tone: "gold",
      tag: "Top performer",
      headline: `Best margin: ${topProduct.title}`,
      detail: `${(topProduct.margin as number).toFixed(0)}% margin across ${topProduct.orders} orders — your strongest product this period.`,
    });
  }

  // 4. Lowest performer — worst-margin city with meaningful volume, only
  // flagged if it's actually dragging (avoid noise on an already-healthy shop).
  const worstCity = cityStats
    .filter((c) => c.orders >= MIN_CITY_ORDERS && c.margin !== null)
    .sort((a, b) => (a.margin as number) - (b.margin as number))[0];
  if (worstCity && (worstCity.margin as number) < 10) {
    insights.push({
      tone: "warn",
      tag: "Lowest performer",
      headline: `${worstCity.city} is dragging on margin`,
      detail: `Just ${(worstCity.margin as number).toFixed(0)}% margin there — RTO and delivery costs are eating most of the revenue.`,
    });
  }

  return insights.slice(0, 4);
}
