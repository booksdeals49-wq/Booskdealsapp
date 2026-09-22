import { useMemo, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { Form, useActionData, useLoaderData, useNavigation } from "@remix-run/react";
import {
  Page,
  Card,
  FormLayout,
  TextField,
  Button,
  BlockStack,
  InlineStack,
  Text,
  Banner,
  Badge,
  Tabs,
  Box,
} from "@shopify/polaris";
import {
  MegaphoneIcon,
  LinkIcon,
  CashDollarIcon,
  ChartLineIcon,
  DataTableIcon,
  LockIcon,
  ReceiptDollarIcon,
} from "@shopify/polaris-icons";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { fetchMetaDailySpend, fetchMetaAdAccountCurrency } from "../services/metaAds.server";
import { fetchTiktokDailySpend } from "../services/tiktokAds.server";
import { fetchSnapchatDailySpend } from "../services/snapchatAds.server";
import { fetchGoogleAdsDailySpend } from "../services/googleAds.server";
import { getBillingState, currentTier } from "../services/billing.server";
import { allowedAdPlatforms } from "../services/billingPlans";
import {
  getCostSettingsHistory,
  resolveCostSettingsAt,
} from "../services/costSettingsHistory.server";
import { UpgradePrompt } from "../components/UpgradePrompt";
import { IconBadge, SectionHeading } from "../components/StatTile";
import { AdSpendTrendChart, SpendMixBar } from "../components/AdSpendVisuals";
import { BRAND } from "../components/theme";
import { encryptSecret, decryptSecret, encryptJson, decryptJson } from "../services/crypto.server";
import { resolveDateRange } from "../utils/dateRange.server";
import { DateRangePicker } from "../components/DateRangePicker";

const PLATFORMS = ["meta", "google", "tiktok", "snapchat"] as const;
type Platform = (typeof PLATFORMS)[number];

const PLATFORM_LABEL: Record<Platform, string> = {
  meta: "Meta",
  google: "Google Ads",
  tiktok: "TikTok",
  snapchat: "Snapchat",
};

// Non-semantic colors only (no navy-loss red) so a platform swatch never
// reads as a good/bad signal — same CHART_PALETTE the Dashboard's cost
// breakdown draws from.
const PLATFORM_COLOR: Record<Platform, string> = {
  meta: BRAND.navy,
  google: BRAND.gold,
  tiktok: "#2F7A6B",
  snapchat: "#4A6FA5",
};

const DAY_MS = 24 * 60 * 60 * 1000;

type DailyPoint = { date: string; spend: number; impressions?: number; clicks?: number; revenue?: number };
type CampaignRow = { campaign: string; spend: number; ctr: number | null; roas: number | null };

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

// Meta's campaign spend is stored as "campaignId::campaignName" (and now
// TikTok/Google the same way) so campaigns with duplicate names — common
// for A/B tests — don't collide in the database. Strip the id back off for
// display; the user should only ever see the readable name.
function campaignDisplayName(raw: string) {
  const idx = raw.indexOf("::");
  return idx === -1 ? raw : raw.slice(idx + 2);
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const url = new URL(request.url);
  // Same "?from=&to=" URL-param range every other report page uses —
  // defaults to the last 30 days when neither is present. Replaces the old
  // fixed-7/14/30-day toggle so any range (e.g. "1st of September till
  // today") can be picked directly, not just three preset widths.
  const range = resolveDateRange(url);

  const billingState = await getBillingState(shop);
  const tier = currentTier(billingState);
  const unlocked = allowedAdPlatforms(tier);

  const connections = await prisma.adAccountConnection.findMany({ where: { shop } });
  const byPlatform: Record<Platform, { connected: boolean; accountId: string; extra: Record<string, string> }> =
    {
      meta: { connected: false, accountId: "", extra: {} },
      google: { connected: false, accountId: "", extra: {} },
      tiktok: { connected: false, accountId: "", extra: {} },
      snapchat: { connected: false, accountId: "", extra: {} },
    };
  for (const c of connections as Array<{ platform: string; accountId: string; extraJson: string | null }>) {
    if ((PLATFORMS as readonly string[]).includes(c.platform)) {
      byPlatform[c.platform as Platform] = {
        connected: true,
        accountId: c.accountId,
        extra: decryptJson(c.extraJson),
      };
    }
  }

  // Ascending oldest -> newest date keys spanning the selected range, so
  // the trend chart has a continuous, zero-filled series for exactly the
  // days the user picked.
  const dateKeys: string[] = [];
  for (let t = range.from.getTime(); t < range.to.getTime(); t += DAY_MS) {
    dateKeys.push(new Date(t).toISOString().slice(0, 10));
  }

  // An equal-length window immediately before the selected range, purely
  // for the "vs previous period" comparison — same idea as every other
  // page's own comparison, just totals-only (no daily breakdown needed).
  const spanMs = range.to.getTime() - range.from.getTime();
  const prevTo = range.from;
  const prevFrom = new Date(range.from.getTime() - spanMs);

  const [rows, prevRows, costSettingsHistory] = await Promise.all([
    prisma.adSpend.findMany({
      where: { shop, date: { gte: range.from, lt: range.to } },
      orderBy: { date: "asc" },
    }),
    prisma.adSpend.findMany({
      where: { shop, date: { gte: prevFrom, lt: prevTo } },
    }),
    getCostSettingsHistory(shop),
  ]);
  const currentTaxPercent =
    costSettingsHistory[costSettingsHistory.length - 1].ecommerceTransactionTaxPercent;

  const dailyTotals: Record<Platform, Map<string, DailyPoint>> = {
    meta: new Map(), google: new Map(), tiktok: new Map(), snapchat: new Map(),
  };
  for (const dk of dateKeys) {
    for (const p of PLATFORMS) dailyTotals[p].set(dk, { date: dk, spend: 0, impressions: 0, clicks: 0, revenue: 0 });
  }

  for (const r of rows as Array<{
    platform: string; date: Date; spend: number; campaign: string | null;
    impressions: number; clicks: number; revenue: number;
  }>) {
    if (!(PLATFORMS as readonly string[]).includes(r.platform)) continue;
    const p = r.platform as Platform;
    const dateKey = new Date(r.date).toISOString().slice(0, 10);
    const bucket = dailyTotals[p].get(dateKey);
    if (!bucket) continue; // shouldn't happen — row is already scoped to the range
    bucket.spend = round2(bucket.spend + r.spend);
    bucket.impressions = (bucket.impressions ?? 0) + (r.impressions ?? 0);
    bucket.clicks = (bucket.clicks ?? 0) + (r.clicks ?? 0);
    bucket.revenue = round2((bucket.revenue ?? 0) + (r.revenue ?? 0));
  }

  const daily: Record<Platform, DailyPoint[]> = {
    meta: dateKeys.map((dk) => dailyTotals.meta.get(dk)!),
    google: dateKeys.map((dk) => dailyTotals.google.get(dk)!),
    tiktok: dateKeys.map((dk) => dailyTotals.tiktok.get(dk)!),
    snapchat: dateKeys.map((dk) => dailyTotals.snapchat.get(dk)!),
  };

  // Previous-period totals per platform, for the hero card's delta — just a
  // sum, no daily breakdown needed since it's never charted.
  const prevTotals: Record<Platform, number> = { meta: 0, google: 0, tiktok: 0, snapchat: 0 };
  for (const r of prevRows as Array<{ platform: string; spend: number }>) {
    if (!(PLATFORMS as readonly string[]).includes(r.platform)) continue;
    const p = r.platform as Platform;
    prevTotals[p] = round2(prevTotals[p] + r.spend);
  }

  // Government tax on ad-platform transactions — one blended rate across
  // Meta/Google/TikTok/Snapchat combined (not per-platform), resolved per
  // row by that row's own date so a rate change never retroactively changes
  // past tax. Bucketed by day, same shape as `daily`. See
  // costSettingsResolver.ts's computeAdSpendTax.
  const dailyTaxMap = new Map<string, number>();
  for (const dk of dateKeys) dailyTaxMap.set(dk, 0);
  for (const r of rows as Array<{ platform: string; date: Date; spend: number }>) {
    if (!(PLATFORMS as readonly string[]).includes(r.platform)) continue;
    const dateKey = new Date(r.date).toISOString().slice(0, 10);
    if (!dailyTaxMap.has(dateKey)) continue;
    const settings = resolveCostSettingsAt(costSettingsHistory, r.date);
    dailyTaxMap.set(
      dateKey,
      round2(dailyTaxMap.get(dateKey)! + r.spend * (settings.ecommerceTransactionTaxPercent / 100)),
    );
  }
  const dailyTax = dateKeys.map((dk) => dailyTaxMap.get(dk)!);

  // Campaigns for the selected range only — `rows` is already scoped to it
  // (the query above), so no more range-keyed maps to pick between.
  function aggregateCampaigns(platform: Platform): CampaignRow[] {
    const totals = new Map<string, { spend: number; impressions: number; clicks: number; revenue: number }>();
    for (const r of rows as Array<{
      platform: string; date: Date; spend: number; campaign: string | null;
      impressions: number; clicks: number; revenue: number;
    }>) {
      if (r.platform !== platform) continue;
      const key = r.campaign && r.campaign.trim() ? r.campaign : "(Unlabeled)";
      const cur = totals.get(key) ?? { spend: 0, impressions: 0, clicks: 0, revenue: 0 };
      cur.spend += r.spend;
      cur.impressions += r.impressions ?? 0;
      cur.clicks += r.clicks ?? 0;
      cur.revenue += r.revenue ?? 0;
      totals.set(key, cur);
    }
    return Array.from(totals.entries())
      .map(([key, t]) => ({
        campaign: campaignDisplayName(key),
        spend: round2(t.spend),
        ctr: platform === "meta" && t.impressions > 0 ? round2((t.clicks / t.impressions) * 100) : null,
        roas: platform === "meta" && t.spend > 0 ? round2(t.revenue / t.spend) : null,
      }))
      .sort((a, b) => b.spend - a.spend)
      .slice(0, 25);
  }

  const campaigns: Record<Platform, CampaignRow[]> = {
    meta: aggregateCampaigns("meta"),
    google: aggregateCampaigns("google"),
    tiktok: aggregateCampaigns("tiktok"),
    snapchat: aggregateCampaigns("snapchat"),
  };

  return json({
    connections: byPlatform,
    daily,
    dailyTax,
    currentTaxPercent,
    campaigns,
    prevTotals,
    unlocked,
    tier,
    range,
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const form = await request.formData();
  const intent = form.get("intent");
  const platform = String(form.get("platform") ?? "") as Platform;

  if (!(PLATFORMS as readonly string[]).includes(platform)) {
    return json({ ok: false, error: "Unknown platform." }, { status: 400 });
  }

  // Server-side enforcement — not just a UI restriction — so a locked
  // platform can't be connected/synced by posting the form directly.
  const billingState = await getBillingState(shop);
  const tier = currentTier(billingState);
  if (!allowedAdPlatforms(tier).includes(platform)) {
    return json(
      { ok: false, error: `${PLATFORM_LABEL[platform]} is part of Growth and Pro. Visit Plan & Billing to upgrade.` },
      { status: 402 },
    );
  }

  if (intent === "connect") {
    // Wrapped in try/catch (unlike before) so a misconfigured or missing
    // TOKEN_ENCRYPTION_KEY — required by encryptSecret/encryptJson below,
    // see crypto.server.ts — shows a clear banner on this page instead of
    // crashing the whole app with a generic "Application error" screen.
    try {
      return await handleConnect(platform, shop, form);
    } catch (e: any) {
      return json(
        {
          ok: false,
          error:
            e?.message ??
            "Couldn't save this connection — check the server's environment configuration.",
        },
        { status: 500 },
      );
    }
  }

  if (intent === "sync") {
    const connection = await prisma.adAccountConnection.findUnique({
      where: { shop_platform: { shop, platform } },
    });
    if (!connection) {
      return json({ ok: false, error: `Connect a ${PLATFORM_LABEL[platform]} ad account first.` }, { status: 400 });
    }
    try {
      // Stored values are encrypted at rest (or legacy plaintext for
      // connections saved before that — decryptSecret/decryptJson handle
      // both transparently); decrypt right before calling out to the
      // platform's own API, never persist the plaintext form anywhere.
      const accessToken = decryptSecret(connection.accessToken);
      let spend: Array<{
        date: string; spend: number; campaign?: string;
        impressions?: number; clicks?: number; revenue?: number;
      }>;
      const syncDays = 30;
      if (platform === "meta") {
        spend = await fetchMetaDailySpend(accessToken, connection.accountId, syncDays);
        // The spend figures above are denominated in the ad account's own
        // reporting currency (e.g. PKR for a Pakistan-based account), not
        // necessarily USD — save it alongside the connection so the UI can
        // label numbers correctly instead of assuming "$". Best-effort: a
        // failed lookup here just leaves the currency unset for this sync,
        // it never blocks the spend sync itself.
        const metaCurrency = await fetchMetaAdAccountCurrency(accessToken, connection.accountId);
        if (metaCurrency) {
          const existingExtra = decryptJson(connection.extraJson);
          await prisma.adAccountConnection.update({
            where: { shop_platform: { shop, platform } },
            data: { extraJson: encryptJson({ ...existingExtra, currency: metaCurrency }) },
          });
        }
      } else if (platform === "tiktok") {
        spend = await fetchTiktokDailySpend(accessToken, connection.accountId, syncDays);
      } else if (platform === "snapchat") {
        spend = await fetchSnapchatDailySpend(accessToken, connection.accountId, syncDays);
      } else {
        const extra = decryptJson(connection.extraJson);
        spend = await fetchGoogleAdsDailySpend(
          {
            developerToken: extra.developerToken ?? "",
            clientId: extra.clientId ?? "",
            clientSecret: extra.clientSecret ?? "",
            refreshToken: accessToken,
            customerId: connection.accountId,
          },
          syncDays,
        );
      }

      // Clear out previously-synced rows in this same window before writing
      // fresh ones. Without this, switching how campaigns are reported
      // (e.g. the old account-level "" campaign rows vs. new real
      // per-campaign rows) leaves BOTH sitting side by side for the same
      // date — since they differ only by the campaign column, they don't
      // overwrite each other — and the dashboard ends up double-counting
      // that date's spend.
      const windowStart = new Date(Date.now() - syncDays * 24 * 60 * 60 * 1000);
      await prisma.adSpend.deleteMany({
        where: { shop, platform, date: { gte: windowStart } },
      });

      for (const day of spend) {
        if (!day.date) continue;
        const campaign = day.campaign || "";
        await prisma.adSpend.upsert({
          where: {
            shop_platform_date_campaign: {
              shop,
              platform,
              date: new Date(day.date),
              campaign,
            },
          },
          update: {
            spend: day.spend,
            impressions: day.impressions ?? 0,
            clicks: day.clicks ?? 0,
            revenue: day.revenue ?? 0,
          },
          create: {
            shop,
            platform,
            date: new Date(day.date),
            spend: day.spend,
            campaign,
            impressions: day.impressions ?? 0,
            clicks: day.clicks ?? 0,
            revenue: day.revenue ?? 0,
          },
        });
      }
      // spend.length counts rows (one per campaign per day, not one per
      // day) — count unique dates instead so this message says something
      // true ("Synced 30 days...") instead of a number like 210.
      const uniqueDays = new Set(spend.map((d) => d.date)).size;
      return json({ ok: true, message: `Synced ${uniqueDays} days of ${PLATFORM_LABEL[platform]} ad spend (${spend.length} campaign records).` });
    } catch (e: any) {
      return json({ ok: false, error: e.message ?? "Sync failed." }, { status: 500 });
    }
  }

  return json({ ok: false, error: "Unknown action." }, { status: 400 });
};

// Extracted out of action() so the "connect" intent's own try/catch above
// (added to catch a missing/invalid TOKEN_ENCRYPTION_KEY — see crypto.server.ts)
// can wrap it in one place, covering the Google branch and the shared
// Meta/TikTok/Snapchat branch below with a single catch.
async function handleConnect(platform: Platform, shop: string, form: FormData) {
  const accountId = String(form.get("accountId") ?? "").trim();

  if (platform === "google") {
      const developerToken = String(form.get("developerToken") ?? "").trim();
      const clientId = String(form.get("clientId") ?? "").trim();
      const clientSecret = String(form.get("clientSecret") ?? "").trim();
      const refreshTokenInput = String(form.get("refreshToken") ?? "").trim();
      if (!accountId || !developerToken || !clientId || !clientSecret) {
        return json(
          { ok: false, error: "Customer ID, developer token, client ID and client secret are all required." },
          { status: 400 },
        );
      }
      const existing = await prisma.adAccountConnection.findUnique({
        where: { shop_platform: { shop, platform } },
      });
      // Only encrypt a freshly-typed refresh token — a reused existing value
      // is already stored in whatever form it was last saved in (encrypted,
      // or legacy plaintext waiting to be upgraded on its next real edit),
      // so re-encrypting it here would double-encrypt and corrupt it.
      const refreshToken = refreshTokenInput
        ? encryptSecret(refreshTokenInput)
        : existing?.accessToken || "";
      if (!refreshToken) {
        return json({ ok: false, error: "Refresh token is required for a first-time connection." }, { status: 400 });
      }
      const extraJson = encryptJson({ developerToken, clientId, clientSecret });
      await prisma.adAccountConnection.upsert({
        where: { shop_platform: { shop, platform } },
        update: { accountId, accessToken: refreshToken, extraJson },
        create: { shop, platform, accountId, accessToken: refreshToken, extraJson },
      });
      return json({ ok: true, message: "Google Ads account connected." });
    }

    const accessTokenInput = String(form.get("accessToken") ?? "").trim();
    const existing = await prisma.adAccountConnection.findUnique({
      where: { shop_platform: { shop, platform } },
    });
    if (!accountId || (!accessTokenInput && !existing)) {
      return json(
        { ok: false, error: "Account ID and access token are both required." },
        { status: 400 },
      );
    }
    // Same "only encrypt what was actually resubmitted" rule as above.
    const accessToken = accessTokenInput
      ? encryptSecret(accessTokenInput)
      : existing?.accessToken || "";
    await prisma.adAccountConnection.upsert({
      where: { shop_platform: { shop, platform } },
      update: { accountId, accessToken },
      create: { shop, platform, accountId, accessToken },
    });
  return json({ ok: true, message: `${PLATFORM_LABEL[platform]} ad account connected.` });
}

// Ad spend figures are denominated in whatever currency the connected ad
// account itself reports in — for Meta that's fetched and saved per
// connection (see fetchMetaAdAccountCurrency in the action above), NOT
// necessarily USD. Same Intl.NumberFormat approach the Dashboard/Orders/
// Reports pages already use for the shop's own currency (see e.g.
// app._index.tsx's own money()). Falls back to a plain "$"-prefixed number
// only when no currency is known yet (a connection made before this fix,
// not yet re-synced).
function money(n: number, currency?: string) {
  if (!currency) return "$" + n.toFixed(2);
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      currencyDisplay: "narrowSymbol",
    }).format(n);
  } catch {
    return `${currency} ${n.toFixed(2)}`;
  }
}

function sum(points: DailyPoint[]) {
  return round2(points.reduce((s, p) => s + p.spend, 0));
}

function StatMini({ label, value, badge }: { label: string; value: string; badge?: string }) {
  return (
    <div style={{ minWidth: 120 }}>
      <InlineStack gap="150" blockAlign="center">
        <Text as="p" tone="subdued" variant="bodySm">{label}</Text>
        {badge && <Badge tone="info" size="small">{badge}</Badge>}
      </InlineStack>
      <Text as="p" variant="headingLg" fontWeight="bold">{value}</Text>
    </div>
  );
}

function roasBadgeTone(roas: number): "success" | "info" | "attention" {
  if (roas >= 3.5) return "success";
  if (roas >= 2) return "info";
  return "attention";
}

export default function AdSpend() {
  const { connections, daily, dailyTax, currentTaxPercent, campaigns, prevTotals, unlocked, tier, range } =
    useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const busy = navigation.state === "submitting";

  const [selected, setSelected] = useState(0);
  const platform = PLATFORMS[selected];
  const platformUnlocked = (unlocked as readonly string[]).includes(platform);

  // Currency for the combined/blended totals (hero card, tax, campaign
  // table) — the first connected platform that has reported its own
  // currency (see fetchMetaAdAccountCurrency), so numbers aren't mislabeled
  // "$" when they're actually e.g. PKR. Blending spend across platforms
  // that report in genuinely DIFFERENT currencies would still be wrong
  // math, not just a wrong label — not a concern today since only one
  // platform is typically connected, but worth knowing if that changes.
  const blendedCurrency = PLATFORMS.map((p) => connections[p].extra?.currency).find(Boolean);

  const tabs = PLATFORMS.map((p) => ({
    id: p,
    content: `${PLATFORM_LABEL[p]}${connections[p].connected ? " ✓" : ""}${
      (unlocked as readonly string[]).includes(p) ? "" : " 🔒"
    }`,
  }));

  const view = useMemo(() => {
    const curTotals = PLATFORMS.map((p) => sum(daily[p]));
    const combinedCur = round2(curTotals.reduce((a, b) => a + b, 0));
    const combinedPrev = round2(PLATFORMS.reduce((s, p) => s + (prevTotals[p] ?? 0), 0));
    const deltaPct = combinedPrev > 0 ? ((combinedCur - combinedPrev) / combinedPrev) * 100 : null;
    const connectedCount = PLATFORMS.filter((p) => connections[p].connected).length;

    const metaImpr = daily.meta.reduce((s, p) => s + (p.impressions ?? 0), 0);
    const metaClicks = daily.meta.reduce((s, p) => s + (p.clicks ?? 0), 0);
    const metaRevenue = daily.meta.reduce((s, p) => s + (p.revenue ?? 0), 0);
    const metaSpend = curTotals[0];
    const metaCtr = metaImpr > 0 ? (metaClicks / metaImpr) * 100 : null;
    const metaRoas = metaSpend > 0 ? metaRevenue / metaSpend : null;

    const campaignRows = PLATFORMS.flatMap((p) =>
      (campaigns[p] ?? []).map((c) => ({ ...c, platform: p })),
    ).sort((a, b) => b.spend - a.spend);

    const taxCur = round2(dailyTax.reduce((a, b) => a + b, 0));

    return { curTotals, combinedCur, deltaPct, connectedCount, metaCtr, metaRoas, campaignRows, taxCur };
  }, [daily, dailyTax, campaigns, prevTotals, connections]);

  return (
    <Page
      title="Ad Spend"
      subtitle="Connect your ad platforms to calculate true ROAS across all of them"
    >
      <BlockStack gap="400">
        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">
              {range.fromLabel} to {range.toLabel}
            </Text>
            <DateRangePicker fromLabel={range.fromLabel} toLabel={range.toLabel} />
          </BlockStack>
        </Card>

        {actionData && "message" in actionData && actionData.message && (
          <Banner tone="success">{actionData.message}</Banner>
        )}
        {actionData && "error" in actionData && actionData.error && (
          <Banner tone="critical">{actionData.error}</Banner>
        )}

        {/* HERO: combined spend */}
        <div style={{ background: "#FFFFFF", border: "1px solid #E3E8EF", borderTop: `4px solid ${BRAND.navy}`, borderRadius: 12, padding: 24 }}>
          <BlockStack gap="500">
            <InlineStack align="space-between" blockAlign="start" wrap>
              <InlineStack gap="400" blockAlign="center" wrap={false}>
                <IconBadge icon={CashDollarIcon} size={52} />
                <BlockStack gap="0">
                  <Text as="p" tone="subdued" variant="bodyMd">
                    Total ad spend · {range.fromLabel} to {range.toLabel} · all platforms
                  </Text>
                  <Text as="p" variant="heading2xl" fontWeight="bold">
                    {money(view.combinedCur, blendedCurrency)}
                  </Text>
                  {view.deltaPct !== null && (
                    <Text as="span" variant="bodySm" tone={view.deltaPct >= 0 ? "success" : "critical"}>
                      {view.deltaPct >= 0 ? "▲" : "▼"} {Math.abs(view.deltaPct).toFixed(1)}% vs previous {range.days} days
                    </Text>
                  )}
                </BlockStack>
              </InlineStack>
              <InlineStack gap="600" wrap>
                <StatMini label="Platforms connected" value={`${view.connectedCount} of ${PLATFORMS.length}`} />
                <StatMini
                  label="Blended ROAS"
                  value={view.metaRoas !== null ? `${view.metaRoas.toFixed(2)}x` : "—"}
                  badge="Meta"
                />
                <StatMini
                  label="Blended CTR"
                  value={view.metaCtr !== null ? `${view.metaCtr.toFixed(2)}%` : "—"}
                  badge="Meta"
                />
                <StatMini
                  label="Ecommerce transaction tax"
                  value={money(view.taxCur, blendedCurrency)}
                  badge={currentTaxPercent > 0 ? `${currentTaxPercent}%` : undefined}
                />
              </InlineStack>
            </InlineStack>
            <SpendMixBar
              segments={PLATFORMS.map((p, i) => ({
                label: PLATFORM_LABEL[p],
                value: view.curTotals[i],
                color: PLATFORM_COLOR[p],
              }))}
              money={(n) => money(n, blendedCurrency)}
            />
            <Text as="p" tone="subdued" variant="bodySm">
              Ecommerce transaction tax is the government tax on card/processing payments to Meta, Google, TikTok and
              Snapchat — one blended rate across all four, applied to total ad spend. Set or change the rate in{" "}
              <a href="/app/settings" style={{ color: BRAND.navy, fontWeight: 600 }}>
                Cost Settings → Ecommerce Transaction Taxes
              </a>
              .
            </Text>
          </BlockStack>
        </div>

        {/* PLATFORM BREAKDOWN */}
        <BlockStack gap="300">
          <SectionHeading
            icon={LinkIcon}
            title="Spend by platform"
            subtitle="How your budget is split, with ROAS & CTR where each platform's data supports it."
          />
          <InlineGridFour>
            {PLATFORMS.map((p) => {
              const locked = !(unlocked as readonly string[]).includes(p);
              const connected = connections[p].connected;
              const spendVal = view.curTotals[PLATFORMS.indexOf(p)];
              const share = view.combinedCur > 0 ? (spendVal / view.combinedCur) * 100 : 0;
              return (
                <div
                  key={p}
                  style={{
                    background: connected ? "#FFFFFF" : "#FBFBFC",
                    border: "1px solid #E3E8EF",
                    borderTop: `3px solid ${connected ? PLATFORM_COLOR[p] : "#E3E8EF"}`,
                    borderRadius: 12,
                    padding: 18,
                  }}
                >
                  <BlockStack gap="300">
                    <InlineStack align="space-between" blockAlign="center">
                      <InlineStack gap="150" blockAlign="center">
                        <span style={{ width: 9, height: 9, borderRadius: 3, background: PLATFORM_COLOR[p], flexShrink: 0 }} />
                        <Text as="span" fontWeight="bold">{PLATFORM_LABEL[p]}</Text>
                      </InlineStack>
                      {connected && <Text as="span" tone="subdued" variant="bodySm">{share.toFixed(0)}% of spend</Text>}
                    </InlineStack>

                    {locked ? (
                      <>
                        <InlineStack gap="150" blockAlign="center">
                          <IconBadge icon={LockIcon} size={28} />
                          <Text as="span" tone="subdued" variant="bodySm">Included in Growth &amp; Pro</Text>
                        </InlineStack>
                        <Button url="/app/billing" size="slim">Upgrade to unlock</Button>
                      </>
                    ) : connected ? (
                      <>
                        <Text as="p" variant="headingLg" fontWeight="bold">{money(spendVal, connections[p].extra?.currency)}</Text>
                        <InlineStack gap="400">
                          <div style={{ flex: 1 }}>
                            <Text as="p" tone="subdued" variant="bodySm">CTR</Text>
                            {p === "meta" ? (
                              <Text as="p" fontWeight="semibold">
                                {view.metaCtr !== null ? `${view.metaCtr.toFixed(2)}%` : "—"}
                              </Text>
                            ) : (
                              <Badge tone="info" size="small">Needs clicks</Badge>
                            )}
                          </div>
                          <div style={{ flex: 1 }}>
                            <Text as="p" tone="subdued" variant="bodySm">ROAS</Text>
                            {p === "meta" ? (
                              <Text as="p" fontWeight="semibold">
                                {view.metaRoas !== null ? `${view.metaRoas.toFixed(2)}x` : "—"}
                              </Text>
                            ) : (
                              <Badge tone="info" size="small">Needs revenue</Badge>
                            )}
                          </div>
                        </InlineStack>
                      </>
                    ) : (
                      <>
                        <Text as="p" tone="subdued" variant="bodyMd">Not connected</Text>
                        <Text as="p" tone="subdued" variant="bodySm">Connect it in the section below.</Text>
                      </>
                    )}
                  </BlockStack>
                </div>
              );
            })}
          </InlineGridFour>
        </BlockStack>

        {/* TREND CHART */}
        <Card padding="0">
          <Box padding="400">
            <BlockStack gap="300">
              <SectionHeading
                icon={ChartLineIcon}
                title="Daily spend trend"
                subtitle="Hover the chart to compare platforms on any day."
              />
              <AdSpendTrendChart
                series={PLATFORMS.filter((p) => connections[p].connected).map((p) => ({
                  key: p,
                  label: PLATFORM_LABEL[p],
                  color: PLATFORM_COLOR[p],
                  points: daily[p].map((pt) => ({ date: pt.date, spend: pt.spend })),
                }))}
                money={(n) => money(n, blendedCurrency)}
              />
            </BlockStack>
          </Box>
        </Card>

        {/* CAMPAIGN TABLE */}
        <Card padding="0">
          <Box padding="400">
            <SectionHeading
              icon={DataTableIcon}
              title="Campaign performance"
              subtitle="Spend for the selected range; CTR & ROAS shown wherever the platform's synced fields support them."
            />
          </Box>
          {view.campaignRows.length > 0 ? (
            <Box padding="0">
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13.5 }}>
                <thead>
                  <tr>
                    {["Platform", "Campaign", "Spend", "CTR", "ROAS"].map((h, i) => (
                      <th
                        key={h}
                        style={{
                          textAlign: i >= 2 ? "right" : "left",
                          fontSize: 11.5,
                          textTransform: "uppercase",
                          letterSpacing: "0.03em",
                          color: BRAND.slate,
                          fontWeight: 700,
                          padding: "0 20px 10px",
                          borderBottom: "1px solid #E3E8EF",
                        }}
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {view.campaignRows.map((r, i) => (
                    <tr key={`${r.platform}-${r.campaign}-${i}`}>
                      <td style={{ padding: "12px 20px", borderBottom: "1px solid #F1F2F4" }}>
                        <InlineStack gap="150" blockAlign="center" wrap={false}>
                          <span style={{ width: 8, height: 8, borderRadius: 2, background: PLATFORM_COLOR[r.platform], flexShrink: 0 }} />
                          <Text as="span" tone="subdued" variant="bodySm">{PLATFORM_LABEL[r.platform]}</Text>
                        </InlineStack>
                      </td>
                      <td style={{ padding: "12px 20px", borderBottom: "1px solid #F1F2F4", fontWeight: 600 }}>
                        {r.campaign}
                      </td>
                      <td style={{ padding: "12px 20px", borderBottom: "1px solid #F1F2F4", textAlign: "right", fontVariantNumeric: "tabular-nums", fontWeight: 600 }}>
                        {money(r.spend, connections[r.platform].extra?.currency)}
                      </td>
                      <td style={{ padding: "12px 20px", borderBottom: "1px solid #F1F2F4", textAlign: "right" }}>
                        {r.ctr !== null ? (
                          <span style={{ fontVariantNumeric: "tabular-nums", fontWeight: 600 }}>{r.ctr.toFixed(2)}%</span>
                        ) : (
                          <Badge tone="info" size="small">Needs clicks</Badge>
                        )}
                      </td>
                      <td style={{ padding: "12px 20px", borderBottom: "1px solid #F1F2F4", textAlign: "right" }}>
                        {r.roas !== null ? (
                          <Badge tone={roasBadgeTone(r.roas)} size="small">{`${r.roas.toFixed(2)}x`}</Badge>
                        ) : (
                          <Badge tone="info" size="small">Needs revenue</Badge>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Box>
          ) : (
            <Box padding="400" paddingBlockStart="0">
              <Text as="p" tone="subdued">No campaign data yet for this range — connect and sync a platform below.</Text>
            </Box>
          )}
          <Box padding="400">
            <Text as="p" variant="bodySm" tone="subdued">
              CTR and ROAS are live for Meta because impressions, clicks and purchase value are already part of its
              sync. Google, TikTok and Snapchat need those same fields added to their API calls before this table can
              show real numbers for them — spend and campaign names are accurate for all three today.
            </Text>
          </Box>
        </Card>

        {/* CONNECTIONS */}
        <Card padding="0">
          <Box padding="400" paddingBlockEnd="0">
            <SectionHeading
              icon={MegaphoneIcon}
              title="Ad platform connections"
              subtitle="Connect each platform's ad account to calculate true ROAS across all of them."
            />
          </Box>
          <Tabs tabs={tabs} selected={selected} onSelect={setSelected} />
          <Box padding="400">
            {platformUnlocked ? (
              <PlatformPanel
                platform={platform}
                connected={connections[platform].connected}
                accountId={connections[platform].accountId}
                extra={connections[platform].extra}
                busy={busy}
              />
            ) : (
              <UpgradePrompt
                feature={`${PLATFORM_LABEL[platform]} ad spend tracking`}
                currentTier={tier}
                detail="The Starter plan includes Meta only. Growth and Pro unlock all four ad platforms."
              />
            )}
          </Box>
        </Card>
      </BlockStack>
    </Page>
  );
}

// A 4-column responsive grid without pulling in Polaris's InlineGrid column
// prop quirks — plain CSS grid, matches the platform card sizing used
// throughout this page.
function InlineGridFour({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))", gap: 16 }}>
      {children}
    </div>
  );
}

function PlatformPanel({
  platform,
  connected,
  accountId,
  extra,
  busy,
}: {
  platform: Platform;
  connected: boolean;
  accountId: string;
  extra: Record<string, string>;
  busy: boolean;
}) {
  const [accountIdValue, setAccountIdValue] = useState(accountId);
  const [accessTokenValue, setAccessTokenValue] = useState("");
  const [developerToken, setDeveloperToken] = useState(extra.developerToken ?? "");
  const [clientId, setClientId] = useState(extra.clientId ?? "");
  const [clientSecret, setClientSecret] = useState(extra.clientSecret ?? "");
  const [refreshToken, setRefreshToken] = useState("");

  return (
    <BlockStack gap="400">
      <Form method="post" key={platform}>
        <input type="hidden" name="intent" value="connect" />
        <input type="hidden" name="platform" value={platform} />
        <FormLayout>
          {platform === "meta" && (
            <Text as="p" tone="subdued">
              Generate a long-lived access token for your ad account in Meta
              Events Manager / Graph API Explorer with the ads_read
              permission, then paste it here along with your ad account ID
              (found in Ads Manager, formatted like 123456789012345).
            </Text>
          )}
          {platform === "tiktok" && (
            <Text as="p" tone="subdued">
              From TikTok Ads Manager → Business Center → Developer Center,
              get an Access Token and your Advertiser ID for the ad account
              you want to track.
            </Text>
          )}
          {platform === "snapchat" && (
            <Text as="p" tone="subdued">
              From Snapchat Ads Manager → Business Details, get an OAuth
              access token and your Ad Account ID. Snapchat's standard tokens
              expire after ~30 minutes — you'll need to refresh and reconnect
              periodically until this is upgraded to full OAuth.
            </Text>
          )}
          {platform === "google" && (
            <Text as="p" tone="subdued">
              Google Ads needs four pieces: a developer token (approved by
              Google at ads.google.com/aw/apicenter — approval can take days
              to weeks), an OAuth client ID + secret (from a Google Cloud
              project), and a refresh token (from Google's OAuth consent
              flow), plus the target Customer ID.
            </Text>
          )}

          <TextField
            label={platform === "google" ? "Customer ID" : "Ad account ID"}
            name="accountId"
            autoComplete="off"
            value={accountIdValue}
            onChange={setAccountIdValue}
            placeholder={platform === "google" ? "1234567890" : "123456789012345"}
          />

          {platform === "google" ? (
            <>
              <TextField
                label="Developer token"
                name="developerToken"
                type="password"
                autoComplete="off"
                value={developerToken}
                onChange={setDeveloperToken}
              />
              <TextField
                label="OAuth client ID"
                name="clientId"
                autoComplete="off"
                value={clientId}
                onChange={setClientId}
              />
              <TextField
                label="OAuth client secret"
                name="clientSecret"
                type="password"
                autoComplete="off"
                value={clientSecret}
                onChange={setClientSecret}
              />
              <TextField
                label="Refresh token"
                name="refreshToken"
                type="password"
                autoComplete="off"
                value={refreshToken}
                onChange={setRefreshToken}
                placeholder={connected ? "•••••••• (leave blank to keep current token)" : ""}
              />
            </>
          ) : (
            <TextField
              label="Access token"
              name="accessToken"
              type="password"
              autoComplete="off"
              value={accessTokenValue}
              onChange={setAccessTokenValue}
              placeholder={connected ? "•••••••• (leave blank to keep current token)" : ""}
            />
          )}

          <Button submit loading={busy}>
            {connected ? `Update ${PLATFORM_LABEL[platform]} connection` : `Connect ${PLATFORM_LABEL[platform]}`}
          </Button>
        </FormLayout>
      </Form>

      {connected && (
        <Form method="post">
          <input type="hidden" name="intent" value="sync" />
          <input type="hidden" name="platform" value={platform} />
          <Button submit loading={busy}>
            Sync last 30 days now
          </Button>
        </Form>
      )}
    </BlockStack>
  );
}
