// Hand-rolled, dependency-free visual components for the Dashboard.
//
// Deliberately built as plain inline SVG / styled divs rather than pulling
// in a charting library: it keeps the bundle small, has zero SSR risk (pure
// functions, no browser-only APIs like ResizeObserver), and lets us match
// Polaris's own color tokens exactly. Colors below are Polaris's actual
// design-token values (success green #008060, critical red #D72C0D,
// neutral grays), not arbitrary choices.

import { BlockStack, InlineStack, Text } from "@shopify/polaris";

const SUCCESS = "#008060";
const CRITICAL = "#D72C0D";
const SUBDUED_BG = "#F1F1F1";
const SUBDUED_FG = "#8A8A8A";

// ---------------------------------------------------------------------------
// Net profit trend line chart (last N days)
// ---------------------------------------------------------------------------

export type TrendPoint = { date: string; netProfit: number };

const CHART_WIDTH = 640;
const CHART_HEIGHT = 160;
const PAD = { top: 12, right: 8, bottom: 8, left: 8 };

export function ProfitTrendChart({ points }: { points: TrendPoint[] }) {
  if (points.length === 0) return null;

  const values = points.map((p) => p.netProfit);
  const min = Math.min(0, ...values);
  const max = Math.max(0, ...values);
  const range = max - min || 1;
  const innerW = CHART_WIDTH - PAD.left - PAD.right;
  const innerH = CHART_HEIGHT - PAD.top - PAD.bottom;
  const stepX = points.length > 1 ? innerW / (points.length - 1) : 0;
  const toY = (v: number) => PAD.top + innerH - ((v - min) / range) * innerH;

  const plotted = points.map((p, i) => ({
    x: PAD.left + i * stepX,
    y: toY(p.netProfit),
    ...p,
  }));

  const linePath = plotted
    .map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(2)} ${p.y.toFixed(2)}`)
    .join(" ");
  const zeroY = toY(0);
  const areaPath = `${linePath} L ${plotted[plotted.length - 1].x.toFixed(2)} ${zeroY.toFixed(2)} L ${plotted[0].x.toFixed(2)} ${zeroY.toFixed(2)} Z`;

  const last = points[points.length - 1];
  const isPositive = last.netProfit >= 0;
  const lineColor = isPositive ? SUCCESS : CRITICAL;
  const areaColor = isPositive ? "rgba(0, 128, 96, 0.08)" : "rgba(215, 44, 13, 0.08)";

  return (
    <svg
      viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
      width="100%"
      height={CHART_HEIGHT}
      role="img"
      aria-label={`Net profit trend over the last ${points.length} days, ending at ${last.netProfit.toFixed(2)}`}
      preserveAspectRatio="none"
    >
      <line
        x1={PAD.left}
        y1={zeroY}
        x2={CHART_WIDTH - PAD.right}
        y2={zeroY}
        stroke="#E3E3E3"
        strokeWidth={1}
        strokeDasharray="4 4"
      />
      <path d={areaPath} fill={areaColor} stroke="none" />
      <path
        d={linePath}
        fill="none"
        stroke={lineColor}
        strokeWidth={2.5}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <circle
        cx={plotted[plotted.length - 1].x}
        cy={plotted[plotted.length - 1].y}
        r={4}
        fill={lineColor}
        stroke="#FFFFFF"
        strokeWidth={1.5}
      />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Highest RTO-risk cities — horizontal bar list
// ---------------------------------------------------------------------------

export type CityRiskRow = {
  city: string;
  orders: number;
  rtoRate: number;
  revenue: number;
};

export function RtoRiskBars({
  rows,
  currency,
  money,
}: {
  rows: CityRiskRow[];
  currency: string;
  money: (n: number, currency: string) => string;
}) {
  const maxRate = Math.max(...rows.map((r) => r.rtoRate), 1);

  return (
    <BlockStack gap="300">
      {rows.map((r) => {
        const risky = r.rtoRate > 20;
        return (
          <div key={r.city}>
            <InlineStack align="space-between" blockAlign="center">
              <BlockStack gap="0">
                <Text as="span" fontWeight="medium">
                  {r.city}
                </Text>
                <Text as="span" tone="subdued" variant="bodySm">
                  {r.orders} order{r.orders === 1 ? "" : "s"} ·{" "}
                  {money(r.revenue, currency)} realized
                </Text>
              </BlockStack>
              <Text as="span" tone={risky ? "critical" : undefined} fontWeight="semibold">
                {r.rtoRate.toFixed(1)}%
              </Text>
            </InlineStack>
            <div
              style={{
                background: SUBDUED_BG,
                borderRadius: 4,
                height: 6,
                marginTop: 6,
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  width: `${Math.max((r.rtoRate / maxRate) * 100, 2)}%`,
                  background: risky ? CRITICAL : SUBDUED_FG,
                  height: 6,
                  borderRadius: 4,
                }}
              />
            </div>
          </div>
        );
      })}
    </BlockStack>
  );
}

// ---------------------------------------------------------------------------
// Cost breakdown — proportional stacked bar + legend
// ---------------------------------------------------------------------------

export type CostSegment = { label: string; value: number; color: string };

export function CostBreakdownBar({
  segments,
  currency,
  money,
}: {
  segments: CostSegment[];
  currency: string;
  money: (n: number, currency: string) => string;
}) {
  const total = segments.reduce((s, seg) => s + Math.max(seg.value, 0), 0);
  if (total <= 0) return null;

  return (
    <BlockStack gap="300">
      <div
        style={{
          display: "flex",
          width: "100%",
          height: 12,
          borderRadius: 6,
          overflow: "hidden",
        }}
      >
        {segments
          .filter((seg) => seg.value > 0)
          .map((seg) => (
            <div
              key={seg.label}
              style={{
                width: `${(seg.value / total) * 100}%`,
                background: seg.color,
              }}
              title={`${seg.label}: ${money(seg.value, currency)}`}
            />
          ))}
      </div>
      <InlineStack gap="400" wrap>
        {segments.map((seg) => (
          <InlineStack key={seg.label} gap="150" blockAlign="center">
            <div
              style={{
                width: 8,
                height: 8,
                borderRadius: 2,
                background: seg.color,
                flexShrink: 0,
              }}
            />
            <Text as="span" variant="bodySm" tone="subdued">
              {seg.label} · {money(seg.value, currency)}
            </Text>
          </InlineStack>
        ))}
      </InlineStack>
    </BlockStack>
  );
}

// A small fixed palette for cost-breakdown segments — distinct, muted, and
// consistent across renders (not tied to Polaris semantic success/critical
// tones, since these are neutral cost categories rather than good/bad
// signals).
export const COST_SEGMENT_COLORS = [
  "#5C6AC4",
  "#47C1BF",
  "#EEC200",
  "#DE3618",
  "#9C6ADE",
  "#50B83C",
  "#F49342",
];
