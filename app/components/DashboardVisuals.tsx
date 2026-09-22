// Hand-rolled, dependency-free visual components for the Dashboard.
//
// Deliberately built as plain inline SVG / styled divs rather than pulling
// in a charting library: it keeps the bundle small, has zero SSR risk (pure
// functions, no browser-only APIs like ResizeObserver), and lets us match
// Polaris's own color tokens exactly. Colors below are Polaris's actual
// design-token values (success green #008060, critical red #D72C0D,
// neutral grays), not arbitrary choices.

import { useRef, useState } from "react";
import { BlockStack, InlineStack, Text } from "@shopify/polaris";
import { BRAND, CHART_PALETTE } from "./theme";

const SUCCESS = BRAND.profit;
const CRITICAL = BRAND.loss;
const SUBDUED_BG = BRAND.slateBg;
const SUBDUED_FG = BRAND.slate;

// ---------------------------------------------------------------------------
// Net profit trend line chart (last N days)
// ---------------------------------------------------------------------------

export type TrendPoint = { date: string; netProfit: number };

const CHART_WIDTH = 640;
const CHART_HEIGHT = 220;
// Left gutter fits Y-axis value labels, bottom gutter fits X-axis date
// labels — neither existed before, which is exactly what made the chart
// unreadable without a legend.
const PAD = { top: 16, right: 12, bottom: 28, left: 52 };

// Rounds a [min, max] range to a handful of "clean" gridline values —
// 0 / 5,000 / 10,000, never 0 / 4,238 / 8,476 — same idea as d3's tick().
function niceTicks(rawMin: number, rawMax: number, targetCount = 4): number[] {
  let min = rawMin;
  let max = rawMax;
  if (min === max) {
    min -= 1;
    max += 1;
  }
  const roughStep = (max - min) / (targetCount - 1);
  const magnitude = Math.pow(10, Math.floor(Math.log10(roughStep)));
  const residual = roughStep / magnitude;
  const step =
    residual > 5
      ? 10 * magnitude
      : residual > 2
        ? 5 * magnitude
        : residual > 1
          ? 2 * magnitude
          : magnitude;
  const niceMin = Math.floor(min / step) * step;
  const niceMax = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let v = niceMin; v <= niceMax + step / 2; v += step) {
    ticks.push(Math.round(v));
  }
  return ticks;
}

export function ProfitTrendChart({
  points,
  currency,
  money,
}: {
  points: TrendPoint[];
  currency: string;
  money: (n: number, currency: string) => string;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  // null = "not hovering" -> falls back to the most recent day, same as the
  // chart's old, non-interactive default.
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  if (points.length === 0) return null;

  const values = points.map((p) => p.netProfit);
  const ticks = niceTicks(Math.min(0, ...values), Math.max(0, ...values), 4);
  const min = ticks[0];
  const max = ticks[ticks.length - 1];
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

  const active = hoverIndex !== null ? plotted[hoverIndex] : plotted[plotted.length - 1];
  const activeColor = active.netProfit >= 0 ? SUCCESS : CRITICAL;

  // X-axis: first/middle/last only — a label under every one of ~30 daily
  // points would just collide into unreadable text.
  const xLabelIndexes = Array.from(
    new Set([0, Math.floor((plotted.length - 1) / 2), plotted.length - 1]),
  );

  const updateHover = (clientX: number) => {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    if (rect.width === 0) return;
    // The SVG scales via viewBox to whatever width the card actually
    // renders at, so pointer position has to be converted from screen
    // pixels back into the chart's own 0-640 coordinate space.
    const localX = ((clientX - rect.left) / rect.width) * CHART_WIDTH;
    let nearest = 0;
    let nearestDist = Infinity;
    plotted.forEach((p, i) => {
      const dist = Math.abs(p.x - localX);
      if (dist < nearestDist) {
        nearestDist = dist;
        nearest = i;
      }
    });
    setHoverIndex(nearest);
  };

  // The tooltip is plain HTML, not SVG text — positioned as a percentage of
  // the card's own width so it tracks the hovered point without a second
  // round of pixel math, and clamped near the edges so it never runs off
  // the card.
  const tooltipLeftPercent = (active.x / CHART_WIDTH) * 100;
  const tooltipTransform =
    tooltipLeftPercent < 15
      ? "translateX(0%)"
      : tooltipLeftPercent > 85
        ? "translateX(-100%)"
        : "translateX(-50%)";

  return (
    <div style={{ position: "relative" }}>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
        width="100%"
        height={CHART_HEIGHT}
        role="img"
        aria-label={`Net profit trend over the last ${points.length} days, ending at ${money(last.netProfit, currency)} on ${new Date(last.date).toLocaleDateString()}`}
        preserveAspectRatio="none"
      >
        {/* Y-axis gridlines + value labels */}
        {ticks.map((t) => (
          <g key={t}>
            <line
              x1={PAD.left}
              y1={toY(t)}
              x2={CHART_WIDTH - PAD.right}
              y2={toY(t)}
              stroke="#E3E3E3"
              strokeWidth={1}
            />
            <text
              x={PAD.left - 8}
              y={toY(t)}
              textAnchor="end"
              dominantBaseline="middle"
              fontSize={11}
              fill={SUBDUED_FG}
            >
              {t.toLocaleString()}
            </text>
          </g>
        ))}

        {/* X-axis date labels */}
        {xLabelIndexes.map((i) => (
          <text
            key={i}
            x={plotted[i].x}
            y={CHART_HEIGHT - 8}
            textAnchor={i === 0 ? "start" : i === plotted.length - 1 ? "end" : "middle"}
            fontSize={11}
            fill={SUBDUED_FG}
          >
            {new Date(plotted[i].date).toLocaleDateString(undefined, {
              month: "short",
              day: "numeric",
            })}
          </text>
        ))}

        <path d={areaPath} fill={areaColor} stroke="none" />
        <path
          d={linePath}
          fill="none"
          stroke={lineColor}
          strokeWidth={2.5}
          strokeLinejoin="round"
          strokeLinecap="round"
        />

        {/* Crosshair — tracks the pointer on hover, hidden otherwise. */}
        <line
          x1={active.x}
          y1={PAD.top}
          x2={active.x}
          y2={CHART_HEIGHT - PAD.bottom}
          stroke={SUBDUED_FG}
          strokeWidth={1}
          strokeDasharray="3 3"
          opacity={hoverIndex !== null ? 0.6 : 0}
        />
        <circle
          cx={active.x}
          cy={active.y}
          r={5}
          fill={activeColor}
          stroke="#FFFFFF"
          strokeWidth={1.5}
        />

        {/* Invisible hit area covering the full plot — bigger than the 2px
            line itself, so the reader doesn't have to aim precisely. */}
        <rect
          x={PAD.left}
          y={PAD.top}
          width={innerW}
          height={innerH}
          fill="transparent"
          style={{ cursor: "crosshair", touchAction: "none" }}
          onPointerMove={(e) => updateHover(e.clientX)}
          onPointerLeave={() => setHoverIndex(null)}
        />
      </svg>

      <div
        style={{
          position: "absolute",
          left: `${tooltipLeftPercent}%`,
          top: 0,
          transform: tooltipTransform,
          pointerEvents: "none",
          opacity: hoverIndex !== null ? 1 : 0,
          transition: "opacity 100ms ease",
          background: "#FFFFFF",
          border: "1px solid #E3E8EF",
          borderRadius: 8,
          padding: "8px 10px",
          boxShadow: "0 2px 8px rgba(15, 23, 42, 0.12)",
          whiteSpace: "nowrap",
        }}
      >
        <Text as="p" variant="bodySm" tone="subdued">
          {new Date(active.date).toLocaleDateString(undefined, {
            weekday: "short",
            month: "short",
            day: "numeric",
          })}
        </Text>
        <InlineStack gap="150" blockAlign="center">
          <span
            style={{
              display: "inline-block",
              width: 10,
              height: 2,
              background: activeColor,
            }}
          />
          <Text
            as="span"
            fontWeight="semibold"
            tone={active.netProfit >= 0 ? "success" : "critical"}
          >
            {money(active.netProfit, currency)}
          </Text>
        </InlineStack>
      </div>
    </div>
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
// signals). Pulled from the app's signature "financial" palette so charts
// match the rest of the app's branding.
export const COST_SEGMENT_COLORS = CHART_PALETTE;
