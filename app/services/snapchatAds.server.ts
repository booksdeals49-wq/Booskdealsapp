// Snapchat Marketing API client for pulling daily ad spend.
//
// Uses the merchant's own OAuth access token + ad_account_id, entered
// in-app — obtained from Snapchat Ads Manager / Business Details settings.
// Note: Snapchat's standard OAuth access tokens are short-lived (~30 min);
// what merchants paste here needs to be a token they refresh periodically,
// or (for a production rollout) this should be upgraded to a full OAuth
// authorize + refresh-token flow rather than a pasted token, the same
// caveat as the Meta and TikTok integrations above.

const SNAPCHAT_API_BASE = "https://adsapi.snapchat.com/v1";

export type DailySpend = { date: string; spend: number; campaign?: string };

export async function fetchSnapchatDailySpend(
  accessToken: string,
  adAccountId: string,
  days = 30,
): Promise<DailySpend[]> {
  const startTime = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const endTime = new Date().toISOString();

  const url = new URL(`${SNAPCHAT_API_BASE}/adaccounts/${adAccountId}/stats`);
  url.searchParams.set("granularity", "DAY");
  url.searchParams.set("fields", "spend");
  url.searchParams.set("start_time", startTime);
  url.searchParams.set("end_time", endTime);

  const response = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Snapchat API error (${response.status}): ${body}`);
  }
  const json = await response.json();
  const timeseries =
    json?.total_stats?.[0]?.total_stat?.timeseries_stats ??
    json?.timeseries_stats ??
    [];

  return timeseries.map((row: any) => {
    const stats = row.timeseries_stat ?? row;
    return {
      date: (stats.start_time ?? "").slice(0, 10),
      // Snapchat reports spend in micro-currency units (millionths).
      spend: Number(stats.stats?.spend ?? 0) / 1_000_000,
    };
  });
}
