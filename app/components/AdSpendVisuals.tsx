// Ad Spend dashboard visuals — same hand-rolled inline-SVG approach as
// DashboardVisuals.tsx's ProfitTrendChart (no charting library, zero SSR
// risk, exact color-token match), extended to plot several platforms on one
// chart at once with a multi-series hover tooltip.

import { useRef, useState } from "react";
import { Text } from "@shopify/polaris";
import { BRAND } from "./theme";

const SUBDUED_FG = BRAND.slate;

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

export type SpendSeries = {
  key: string;
  label: string;
  color: string;
  points: Array<{ date: string; spend: number }>;
};

const CHART_WIDTH = 1040;
const CHART_HEIGHT = 240;
const PAD = { top: 16, right: 12, bottom: 28, left: 56 };

// Default only used if a caller doesn't pass its own `money` formatter —
// every current caller (app.ad-spend.tsx) does, so its real currency
// (e.g. "Rs" for a PKR-denominated ad account) is what actually shows.
const defaultMoney = (n: number) => "$" + n.toFixed(2);

export function AdSpendTrendChart({
  series,
  money = defaultMoney,
}: {
  series: SpendSeries[];
  money?: (n: number) => string;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  const pointCount = series[0]?.points.length ?? 0;
  if (pointCount === 0) return null;

  const allValues = series.flatMap((s) => s.points.map((p) => p.spend));
  const ticks = niceTicks(0, Math.max(...allValues, 1), 4);
  const min = ticks[0];
  const max = ticks[ticks.length - 1];
  const range = max - min || 1;
  const innerW = CHART_WIDTH - PAD.left - PAD.right;
  const innerH = CHART_HEIGHT - PAD.top - PAD.bottom;
  const stepX = pointCount > 1 ? innerW / (pointCount - 1) : 0;
  const toY = (v: number) => PAD.top + innerH - ((v - min) / range) * innerH;
  const toX = (i: number) => PAD.left + i * stepX;

  const dates = series[0].points.map((p) => p.date);
  const xLabelIndexes = Array.from(
    new Set([0, Math.floor((pointCount - 1) / 2), pointCount - 1]),
  );

  const updateHover = (clientX: number) => {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    if (rect.width === 0) return;
    const localX = ((clientX - rect.left) / rect.width) * CHART_WIDTH;
    let nearest = 0;
    let nearestDist = Infinity;
    for (let i = 0; i < pointCount; i++) {
      const dist = Math.abs(toX(i) - localX);
      if (dist < nearestDist) {
        nearestDist = dist;
        nearest = i;
      }
    }
    setHoverIndex(nearest);
  };

  const activeIndex = hoverIndex ?? pointCount - 1;
  const tooltipLeftPercent = (toX(activeIndex) / CHART_WIDTH) * 100;
  const tooltipTransform =
    tooltipLeftPercent < 18
      ? "translateX(0%)"
      : tooltipLeftPercent > 82
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
        aria-label={`Daily ad spend by platform over the last ${pointCount} days`}
        preserveAspectRatio="none"
      >
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

        {xLabelIndexes.map((i) => (
          <text
            key={i}
            x={toX(i)}
            y={CHART_HEIGHT - 8}
            textAnchor={i === 0 ? "start" : i === pointCount - 1 ? "end" : "middle"}
            fontSize={11}
            fill={SUBDUED_FG}
          >
            {new Date(dates[i]).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
          </text>
        ))}

        {series.map((s) => {
          const path = s.points
            .map((p, i) => `${i === 0 ? "M" : "L"} ${toX(i).toFixed(2)} ${toY(p.spend).toFixed(2)}`)
            .join(" ");
          return (
            <path
              key={s.key}
              d={path}
              fill="none"
              stroke={s.color}
              strokeWidth={2.5}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          );
        })}

        <line
          x1={toX(activeIndex)}
          y1={PAD.top}
          x2={toX(activeIndex)}
          y2={CHART_HEIGHT - PAD.bottom}
          stroke={SUBDUED_FG}
          strokeWidth={1}
          strokeDasharray="3 3"
          opacity={hoverIndex !== null ? 0.6 : 0}
        />
        {series.map((s) => (
          <circle
            key={s.key}
            cx={toX(activeIndex)}
            cy={toY(s.points[activeIndex]?.spend ?? 0)}
            r={4}
            fill={s.color}
            stroke="#FFFFFF"
            strokeWidth={1.5}
          />
        ))}

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
          {new Date(dates[activeIndex]).toLocaleDateString(undefined, {
            weekday: "short",
            month: "short",
            day: "numeric",
          })}
        </Text>
        {series.map((s) => (
          <div key={s.key} style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 3 }}>
            <span style={{ display: "inline-block", width: 10, height: 2, background: s.color }} />
            <Text as="span" variant="bodySm">
              {s.label}: <Text as="span" fontWeight="semibold">{money(s.points[activeIndex]?.spend ?? 0)}</Text>
            </Text>
          </div>
        ))}
      </div>
    </div>
  );
}

// Proportional mix bar + legend — same visual language as
// DashboardVisuals.tsx's CostBreakdownBar, reused here for platform spend
// share instead of cost-category share.
export function SpendMixBar({
  segments,
  money = defaultMoney,
}: {
  segments: Array<{ label: string; value: number; color: string }>;
  money?: (n: number) => string;
}) {
  const total = segments.reduce((s, seg) => s + Math.max(seg.value, 0), 0);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", width: "100%", height: 12, borderRadius: 6, overflow: "hidden", background: BRAND.slateBg }}>
        {total > 0 &&
          segments
            .filter((seg) => seg.value > 0)
            .map((seg) => (
              <div
                key={seg.label}
                style={{ width: `${(seg.value / total) * 100}%`, background: seg.color }}
                title={`${seg.label}: ${money(seg.value)}`}
              />
            ))}
      </div>
      <div style={{ display: "flex", gap: 22, flexWrap: "wrap" }}>
        {segments.map((seg) => (
          <div key={seg.label} style={{ display: "flex", alignItems: "center", gap: 7 }}>
            <span style={{ width: 9, height: 9, borderRadius: 3, background: seg.color, flexShrink: 0 }} />
            <Text as="span" variant="bodySm" tone="subdued">
              {seg.label}{" "}
              <Text as="span" fontWeight="semibold" tone={undefined}>
                {money(seg.value)}
              </Text>{" "}
              · {total > 0 ? ((seg.value / total) * 100).toFixed(0) : "0"}%
            </Text>
          </div>
        ))}
      </div>
    </div>
  );
}
