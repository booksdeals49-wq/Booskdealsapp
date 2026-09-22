import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { Links, Meta, Outlet, Scripts, ScrollRestoration, useLoaderData } from "@remix-run/react";

// Needed so the App Bridge CDN script below (loaded on every page, not just
// /app/*) can identify which app it's running as — see the script tag's
// comment. Safe to expose: it's the app's public client ID, the same value
// Shopify itself hands to the storefront/admin when embedding the app.
export const loader = async (_args: LoaderFunctionArgs) => {
  return json({ apiKey: process.env.SHOPIFY_API_KEY || "" });
};

export default function App() {
  const { apiKey } = useLoaderData<typeof loader>();

  return (
    <html>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        {/* Required by the App Bridge script tag below. */}
        <meta name="shopify-api-key" content={apiKey} />
        <link rel="preconnect" href="https://cdn.shopify.com/" />
        <link
          rel="stylesheet"
          href="https://cdn.shopify.com/static/fonts/inter/v4/styles.css"
        />
        {/* Loads App Bridge straight from Shopify's CDN, always the latest
            version — this is what lets Shopify actually collect the
            in-admin Core Web Vitals (LCP/CLS/INP) numbers behind the "Built
            for Shopify" Performance criteria. It coexists fine with
            @shopify/app-bridge-react's <AppProvider> in app.tsx (still
            needed for NavMenu/Polaris integration) — no migration, this is
            purely additive. Loaded here in the root so it's present on
            every page, not just /app/*. */}
        <script src="https://cdn.shopify.com/shopifycloud/app-bridge.js"></script>
        <Meta />
        <Links />
      </head>
      <body>
        <Outlet />
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}
