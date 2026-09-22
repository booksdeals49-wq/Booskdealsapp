const META_GRAPH_VERSION = "v21.0";

// impressions/clicks/revenue are only populated for Meta today — Meta's
// /insights endpoint returns them for free alongside spend. revenue is
// derived from Meta's own purchase_roas value (revenue = spend * roas),
// which is exact for that row, not an estimate: it lets the dashboard
// derive a correctly weighted blended CTR/ROAS for any date range by
// summing raw impressions/clicks/revenue rather than averaging percentages.
export type DailySpend = {
  date: string;
  spend: number;
  campaign?: string;
  impressions?: number;
  clicks?: number;
  revenue?: number;
};

// Meta returns purchase_roas as an array of { action_type, value } — one
// entry per conversion-tracking method it recognizes. Prefer the broadest
// "omni_purchase" bucket, fall back to a plain pixel purchase, else just
// take whatever is first rather than silently reporting 0.
function extractRoas(purchaseRoas: any[] | undefined): number {
  if (!Array.isArray(purchaseRoas) || purchaseRoas.length === 0) return 0;
  const preferred =
    purchaseRoas.find((r) => r.action_type === "omni_purchase") ??
    purchaseRoas.find((r) => r.action_type === "purchase") ??
    purchaseRoas.find((r) => r.action_type === "offsite_conversion.fb_pixel_purchase") ??
    purchaseRoas[0];
  return Number(preferred?.value ?? 0);
}

export async function fetchMetaDailySpend(
  accessToken: string,
  adAccountId: string,
  days = 30,
): Promise<DailySpend[]> {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const until = new Date().toISOString().slice(0, 10);
  const accountId = adAccountId.startsWith("act_") ? adAccountId : `act_${adAccountId}`;
  const url = new URL(`https://graph.facebook.com/${META_GRAPH_VERSION}/${accountId}/insights`);
  url.searchParams.set("level", "campaign");
  url.searchParams.set(
    "fields",
    "campaign_id,campaign_name,spend,impressions,clicks,purchase_roas",
  );
  url.searchParams.set("time_increment", "1");
  url.searchParams.set("time_range", JSON.stringify({ since, until }));
  url.searchParams.set("limit", "200");
  url.searchParams.set("access_token", accessToken);

  const results: DailySpend[] = [];
  let nextUrl: string | null = url.toString();
  while (nextUrl) {
    const response: Response = await fetch(nextUrl);
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Meta API error (${response.status}): ${body}`);
    }
    const page = await response.json();
    const data = page?.data ?? [];
    for (const row of data) {
      const id = row.campaign_id ?? "unknown";
      const name = row.campaign_name ?? "Unnamed campaign";
      const spend = Number(row.spend ?? 0);
      const roas = extractRoas(row.purchase_roas);
      results.push({
        date: row.date_start,
        spend,
        campaign: `${id}::${name}`,
        impressions: Number(row.impressions ?? 0),
        clicks: Number(row.clicks ?? 0),
        // Exact per Meta's own purchase_roas for this row — not an estimate.
        revenue: Math.round(spend * roas * 100) / 100,
      });
    }
    nextUrl = page?.paging?.next ?? null;
  }
  return results;
}
