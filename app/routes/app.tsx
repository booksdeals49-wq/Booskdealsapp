import type { LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { Link, Outlet, useLoaderData, useRouteError } from "@remix-run/react";
import { boundary } from "@shopify/shopify-app-remix/server";
import { AppProvider } from "@shopify/shopify-app-remix/react";
import { NavMenu } from "@shopify/app-bridge-react";
import polarisStyles from "@shopify/polaris/build/esm/styles.css?url";
import { authenticate } from "../shopify.server";
import { getBillingState, currentTier, isOverFreeLimit } from "../services/billing.server";

export const links = () => [{ rel: "stylesheet", href: polarisStyles }];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);

  // Free plan is capped at FREE_ORDER_LIMIT orders/month — once a shop
  // crosses that on Free, send them to the plan picker to choose a paid
  // plan. Anyone already on an active paid plan sails through. Skip the
  // check on the billing route itself to avoid a redirect loop.
  if (!url.pathname.startsWith("/app/billing")) {
    const state = await getBillingState(session.shop);
    if (currentTier(state) === "free" && isOverFreeLimit(state)) {
      throw redirect("/app/billing");
    }
  }

  return json({ apiKey: process.env.SHOPIFY_API_KEY || "" });
};

export default function App() {
  const { apiKey } = useLoaderData<typeof loader>();

  return (
    <AppProvider isEmbeddedApp apiKey={apiKey}>
      <NavMenu>
        <Link to="/app" rel="home">
          Dashboard
        </Link>
        <Link to="/app/orders">Orders</Link>
        <Link to="/app/reports">Reports</Link>
        <Link to="/app/ad-spend">Ad Spend</Link>
        <Link to="/app/settings">Cost Settings</Link>
        <Link to="/app/billing">Plan &amp; Billing</Link>
      </NavMenu>
      <Outlet />
    </AppProvider>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers = (headersArgs: Parameters<typeof boundary.headers>[0]) => {
  return boundary.headers(headersArgs);
};
