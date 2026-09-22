// TikTok Marketing API client for pulling daily ad spend.
//
// Uses the merchant's own long-lived Access Token + advertiser_id, entered
// in-app — obtained from TikTok Ads Manager (Business Center > Assets >
// Developer Center, or via a registered TikTok for Business app). Like the
// Meta integration, this reads the merchant's own account and doesn't
// require TikTok's marketing-partner app review for that alone; scaling
// this to onboard many merchants automatically would need a registered
// TikTok Marketing API app and a proper OAuth authorize flow instead of a
// pasted token.

const TIKTOK_API_BASE = "https://business-api.tiktok.com/open_api/v1.3";

export type DailySpend = { date: string; spend: number; campaign?: string };

export async function fetchTiktokDailySpend(
  accessToken: string,
  advertiserId: string,
  days = 30,
): Promise<DailySpend[]> {
  const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  const endDate = new Date().toISOString().slice(0, 10);

  const url = new URL(`${TIKTOK_API_BASE}/report/integrated/get/`);
  url.searchParams.set("advertiser_id", advertiserId);
  url.searchParams.set("report_type", "BASIC");
  // campaign_id dimension gives a real per-campaign breakdown instead of
  // one account-level row per day.
  url.searchParams.set("dimensions", JSON.stringify(["stat_time_day", "campaign_id"]));
  url.searchParams.set("metrics", JSON.stringify(["spend", "campaign_name"]));
  url.searchParams.set("data_level", "AUCTION_CAMPAIGN");
  url.searchParams.set("start_date", startDate);
  url.searchParams.set("end_date", endDate);
  url.searchParams.set("page_size", "1000");

  const response = await fetch(url.toString(), {
    headers: { "Access-Token": accessToken },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`TikTok API error (${response.status}): ${body}`);
  }
  const json = await response.json();
  if (json.code !== 0) {
    throw new Error(`TikTok API error: ${json.message ?? "unknown error"}`);
  }

  const list = json?.data?.list ?? [];
  return list.map((row: any) => {
    const id = row.dimensions?.campaign_id ?? "unknown";
    const name = row.metrics?.campaign_name ?? "Unnamed campaign";
    return {
      date: row.dimensions?.stat_time_day?.slice(0, 10) ?? "",
      spend: Number(row.metrics?.spend ?? 0),
      // "id::name" — same collision-safe convention as Meta, since TikTok
      // campaign names aren't guaranteed unique either.
      campaign: `${id}::${name}`,
    };
  });
}
