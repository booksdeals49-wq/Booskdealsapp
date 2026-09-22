// Marketing-channel classification — turns the raw referring URL captured
// at checkout (or, failing that, Shopify's order source) into the same kind
// of human-readable channel names ad-spend dashboards use: "Facebook",
// "TikTok", "Snapchat", "Google", "Direct", or the referring domain itself
// for organic/unrecognized traffic (e.g. a link shared on a blog).
//
// Framework-free/pure so it's reusable and unit-testable without Prisma.
//
// Caveat (documented here so it isn't lost): `referringSite` is only
// populated going forward, from the orders/create and orders/updated
// webhooks — Shopify's REST order payload includes it, but the GraphQL
// backfill query used for first-run history does not currently request it
// (that field lives behind additional API surface we haven't wired up), so
// orders synced via the initial backfill classify by `sourceName` alone
// until a webhook re-syncs them.

const PLATFORM_HOSTNAME_HINTS: Array<{ match: string[]; label: string }> = [
  { match: ["facebook.", "fb.com", "fb.me", "l.facebook."], label: "Facebook" },
  { match: ["instagram."], label: "Instagram" },
  { match: ["tiktok."], label: "TikTok" },
  { match: ["snapchat.", "snap.com"], label: "Snapchat" },
  {
    match: ["google.", "googleads.", "googleadservices.", "doubleclick.", "googlesyndication."],
    label: "Google",
  },
  { match: ["youtube.", "youtu.be"], label: "YouTube" },
  { match: ["whatsapp."], label: "WhatsApp" },
];

function hostnameOf(url: string): string | null {
  try {
    // Tolerate bare domains without a scheme, which some Shopify payloads send.
    const withScheme = /^https?:\/\//i.test(url) ? url : `https://${url}`;
    return new URL(withScheme).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

function prettifyDomain(hostname: string): string {
  // "fastvolt.pk" -> "Fastvolt.pk" — same style Financify uses for unrecognized referrers.
  return hostname.charAt(0).toUpperCase() + hostname.slice(1);
}

function prettifySourceName(sourceName: string): string {
  const map: Record<string, string> = {
    web: "Direct",
    pos: "POS",
    shopify_draft_order: "Draft order",
    iphone: "Shopify POS (iPhone)",
    android: "Shopify POS (Android)",
  };
  return map[sourceName.toLowerCase()] ?? sourceName;
}

export function classifyChannel(order: {
  referringSite?: string | null;
  channel?: string | null; // raw sourceName, as stored on OrderRecord
}): string {
  const referringSite = order.referringSite?.trim();
  if (referringSite) {
    const host = hostnameOf(referringSite);
    if (host) {
      const hit = PLATFORM_HOSTNAME_HINTS.find((p) =>
        p.match.some((needle) => host.includes(needle)),
      );
      if (hit) return hit.label;
      return prettifyDomain(host);
    }
  }

  const sourceName = order.channel?.trim();
  if (!sourceName || sourceName.toLowerCase() === "web") return "Direct";
  return prettifySourceName(sourceName);
}
