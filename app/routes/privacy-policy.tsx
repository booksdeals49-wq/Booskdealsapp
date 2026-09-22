// Public, unauthenticated resource route — deliberately does NOT call
// authenticate.admin, and deliberately has NO default-exported component.
// Remix's root.tsx already wraps every normal route in its own
// <html>/<head>/<body> (see app/root.tsx) — a route that needs a fully
// custom, standalone HTML document (no Shopify admin chrome, no App
// Bridge, reachable by anyone including Shopify's reviewers) has to be a
// resource route instead: a loader that returns a raw Response with the
// complete HTML string, same pattern as app.reports.download.tsx's CSV
// response. This serves at /privacy-policy — link that URL in the Partner
// Dashboard's App Store listing "Privacy policy URL" field.
import type { LoaderFunctionArgs } from "@remix-run/node";
import { BRAND } from "../components/theme";

const APP_NAME = "COD Profit Analytics";
const SUPPORT_EMAIL = "hamzamukaty11@gmail.com";
const LAST_UPDATED = "September 2, 2026";

function renderHtml() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Privacy Policy — ${APP_NAME}</title>
<style>
  :root {
    --navy: ${BRAND.navy};
    --navy-soft: ${BRAND.navySoft};
    --gold: ${BRAND.gold};
    --slate: ${BRAND.slate};
    --slate-bg: ${BRAND.slateBg};
    --pale-navy-bg: ${BRAND.paleNavyBg};
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--pale-navy-bg);
    color: #1A2A3A;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    line-height: 1.6;
  }
  .header { background: var(--navy); color: #fff; padding: 40px 24px; }
  .header-inner { max-width: 760px; margin: 0 auto; }
  .eyebrow {
    display: inline-block; background: var(--gold); color: #fff;
    font-size: 11px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase;
    padding: 3px 10px; border-radius: 4px; margin-bottom: 12px;
  }
  .header h1 { margin: 0 0 6px; font-size: 26px; font-weight: 700; }
  .header p { margin: 0; color: #C7D3E3; font-size: 13px; }
  main { max-width: 760px; margin: 0 auto; padding: 32px 24px 64px; }
  .card { background: #fff; border: 1px solid #E3E8EF; border-radius: 12px; padding: 28px 32px; }
  .intro { font-size: 15px; color: var(--slate); margin-bottom: 8px; }
  h2 {
    font-size: 17px; font-weight: 700; color: var(--navy);
    margin: 32px 0 10px; padding-top: 20px; border-top: 1px solid #E3E8EF;
  }
  h2:first-of-type { border-top: none; padding-top: 0; margin-top: 8px; }
  p { font-size: 14px; margin: 0 0 12px; }
  ul { font-size: 14px; margin: 0 0 12px; padding-left: 20px; }
  li { margin-bottom: 6px; }
  .note { background: var(--slate-bg); border-radius: 8px; padding: 12px 16px; font-size: 13px; color: var(--slate); margin: 12px 0; }
  a { color: var(--navy-soft); }
  .contact-box { background: var(--pale-navy-bg); border-radius: 10px; padding: 18px 20px; margin-top: 8px; }
  .contact-box p { margin: 0; }
  footer { max-width: 760px; margin: 24px auto 0; padding: 0 24px; font-size: 12px; color: var(--slate); text-align: center; }
</style>
</head>
<body>
  <div class="header">
    <div class="header-inner">
      <span class="eyebrow">Privacy Policy</span>
      <h1>${APP_NAME}</h1>
      <p>Last updated: ${LAST_UPDATED}</p>
    </div>
  </div>

  <main>
    <div class="card">
      <p class="intro">
        ${APP_NAME} ("the App", "we", "us") is a Shopify app that helps
        merchants calculate true profit on cash-on-delivery (COD) orders —
        accounting for returns (RTO), delivery costs, cash handling fees,
        taxes, and ad spend. This policy explains what information the App
        collects when a merchant installs it, why, and how it's handled.
      </p>
      <p class="intro">
        This policy covers the App only. Shopify's own handling of your
        store's data is governed separately by
        <a href="https://www.shopify.com/legal/privacy" target="_blank" rel="noreferrer">Shopify's Privacy Policy</a>.
      </p>

      <h2>Information we collect</h2>
      <p>When a store owner installs the App, we access and store:</p>
      <ul>
        <li><strong>Order data</strong> — order totals, line items (product, variant, quantity, price), fulfillment/financial status, tags, and cancellation reason. This is used to calculate per-order and aggregate profit and to detect returned (RTO) orders.</li>
        <li><strong>Product data</strong> — product and variant titles and IDs, used to let the merchant set per-product cost overrides (COGS).</li>
        <li><strong>Store owner/staff account info</strong> — the name and email of the Shopify user who installs or accesses the App, provided by Shopify during login. This is standard session information required to operate any embedded Shopify app securely.</li>
        <li><strong>Cost and settings data you enter directly</strong> — figures like delivery fees, COD cash-handling percentages, tax rates, and packaging costs, which the merchant configures in the App to make profit calculations accurate for their business.</li>
        <li><strong>Ad platform credentials, only if you connect them</strong> — if a merchant chooses to connect a Meta, Google Ads, TikTok, or Snapchat ad account, we store the account ID and access credentials needed to fetch that account's ad spend figures. This is entirely opt-in per platform and is used solely to pull spend data into the App's reports.</li>
      </ul>

      <h2>Information we do not collect</h2>
      <p>The App deliberately does <strong>not</strong> store your customers' names, email addresses, phone numbers, shipping/billing addresses, or payment details — including no geographic detail such as shipping city or country. We do not track your storefront's visitors, and we do not access or store payment card data at any point.</p>

      <h2>How we use this information</h2>
      <p>Order, product, and cost data are used exclusively to power the App's own features for the installing merchant: profit dashboards, cost breakdowns, return-rate analysis, product performance reports, and (where an ad account is connected) blended return-on-ad-spend calculations. We do not use your store's data to train any AI/ML model, and we do not use it for any purpose unrelated to operating the App.</p>

      <h2>Sharing with third parties</h2>
      <p>We do not sell, rent, or share your store's data with any third party for their own marketing or advertising purposes. The only outbound data flow is one the merchant explicitly sets up: when an ad platform (Meta, Google Ads, TikTok, or Snapchat) is connected, the App calls that platform's own API, using the merchant's own credentials, purely to read that merchant's ad spend — no store or order data is sent to those platforms.</p>
      <p>Our infrastructure providers (a hosting provider and a managed database provider) process data on our behalf strictly to run the App, under standard hosting agreements, and do not use it for any purpose of their own.</p>

      <h2>Data retention &amp; deletion</h2>
      <p>We retain a store's data for as long as the App remains installed, so its reports stay accurate and continuous. If the App is uninstalled, all of that store's data — orders, cost settings, product overrides, connected ad account credentials, and session data — is deleted from our database automatically.</p>
      <p>In line with Shopify's mandatory compliance requirements, we also support:</p>
      <ul>
        <li><strong>Customer data requests</strong> — since we don't store any customer-identifying data at all, there is typically nothing further to disclose beyond what's already visible in Shopify admin.</li>
        <li><strong>Customer redaction requests</strong> — since we don't store any customer-identifying data, there is nothing to redact on our side beyond the standard order-level data covered by shop-level deletion below.</li>
        <li><strong>Shop-level redaction</strong> — if requested (or automatically, ~48 hours after uninstall), all of a store's data is permanently deleted from our systems.</li>
      </ul>

      <h2>Security</h2>
      <p>Data is stored in a managed, access-controlled database used exclusively by the App, reachable only over encrypted connections. Access is limited to what's needed to operate the App. As with any software, no method of storage or transmission is 100% guaranteed secure, but we take reasonable, ongoing steps to protect the data we hold.</p>

      <h2>Cookies &amp; tracking</h2>
      <p>The App runs embedded inside Shopify's admin and relies on Shopify's own session mechanism (App Bridge) to authenticate each request. We do not set third-party advertising or cross-site tracking cookies.</p>

      <h2>Children's privacy</h2>
      <p>The App is a business tool intended for use by Shopify merchants and their staff. It is not directed at, and we do not knowingly collect information from, individuals under the age of 16.</p>

      <h2>Changes to this policy</h2>
      <p>We may update this policy as the App's features change. The "Last updated" date at the top will reflect the most recent revision. Material changes will be reflected here before they take effect.</p>

      <h2>Contact us</h2>
      <div class="contact-box">
        <p>Questions about this policy, or a request related to your data (access, correction, deletion)? Reach us at <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a>.</p>
      </div>
      <p class="note">This policy is provided as a general description of the App's data practices and isn't a substitute for legal advice. If your business serves regions with specific requirements (e.g. GDPR in the EU/UK, CCPA in California), consider having this reviewed by a lawyer familiar with those rules before publishing your app publicly.</p>
    </div>
  </main>

  <footer>${APP_NAME} — a Shopify app for merchant profit analytics.</footer>
</body>
</html>`;
}

export const loader = async ({ request: _request }: LoaderFunctionArgs) => {
  return new Response(renderHtml(), {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
};
