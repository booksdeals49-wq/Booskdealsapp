// Google Ads API client for pulling daily ad spend.
//
// Unlike Meta/TikTok/Snapchat, Google Ads has no simple "paste one
// long-lived token" option: every call needs a short-lived OAuth access
// token (exchanged here from a merchant-obtained refresh token), PLUS a
// Google Ads developer token tied to an approved Google Ads API app (this
// approval step is entirely on Google's side — apply at
// https://ads.google.com/aw/apicenter — and can take days to weeks; there
// is no way to skip it). What merchants provide in-app is therefore four
// pieces, not one: the developer token, an OAuth client id + secret (from a
// Google Cloud project), a refresh token (obtained once via Google's OAuth
// consent flow), and the target Google Ads customer id.

const GOOGLE_ADS_API_VERSION = "v17";
const OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";

export type DailySpend = { date: string; spend: number; campaign?: string };

export type GoogleAdsCredentials = {
  developerToken: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  customerId: string; // digits only, e.g. "1234567890"
};

async function getAccessToken(creds: GoogleAdsCredentials): Promise<string> {
  const response = await fetch(OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      refresh_token: creds.refreshToken,
      grant_type: "refresh_token",
    }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Google OAuth token refresh failed (${response.status}): ${body}`);
  }
  const json = await response.json();
  return json.access_token as string;
}

export async function fetchGoogleAdsDailySpend(
  creds: GoogleAdsCredentials,
  days = 30,
): Promise<DailySpend[]> {
  const accessToken = await getAccessToken(creds);
  const customerId = creds.customerId.replace(/-/g, "");

  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  const until = new Date().toISOString().slice(0, 10);

  // GAQL: cost_micros is in millionths of the account's currency unit.
  // Querying FROM campaign (instead of FROM customer) gives a real
  // per-campaign breakdown instead of one account-level row per day.
  const query = `
    SELECT campaign.id, campaign.name, segments.date, metrics.cost_micros
    FROM campaign
    WHERE segments.date BETWEEN '${since}' AND '${until}'
  `.trim();

  const response = await fetch(
    `https://googleads.googleapis.com/${GOOGLE_ADS_API_VERSION}/customers/${customerId}/googleAds:searchStream`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "developer-token": creds.developerToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query }),
    },
  );
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Google Ads API error (${response.status}): ${body}`);
  }
  const chunks = await response.json();

  const rows: DailySpend[] = [];
  for (const chunk of Array.isArray(chunks) ? chunks : [chunks]) {
    for (const result of chunk.results ?? []) {
      const id = result.campaign?.id ?? "unknown";
      const name = result.campaign?.name ?? "Unnamed campaign";
      rows.push({
        date: result.segments?.date ?? "",
        spend: Number(result.metrics?.costMicros ?? 0) / 1_000_000,
        // "id::name" — same collision-safe convention as Meta/TikTok.
        campaign: `${id}::${name}`,
      });
    }
  }
  return rows;
}
