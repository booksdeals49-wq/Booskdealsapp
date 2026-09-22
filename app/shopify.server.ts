// Forceful workaround for a Windows-specific Node/Vite bug resolving this
// package's wildcard subpath export ("./adapters/*" in its package.json
// "exports" map). Bare-specifier imports like
// "@shopify/shopify-app-remix/adapters/node" go through Node's/Vite's
// package-exports resolver, which is where the bug lives. A *relative
// filesystem path* import bypasses the "exports" map entirely (exports
// maps only govern bare package-name resolution, never plain relative or
// absolute file paths), so this is resolved as a normal file on disk
// instead, sidestepping the bug completely regardless of OS.
import "../node_modules/@shopify/shopify-app-remix/dist/esm/server/adapters/node/index.mjs";
import {
  ApiVersion,
  AppDistribution,
  DeliveryMethod,
  shopifyApp,
} from "@shopify/shopify-app-remix/server";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import prisma from "./db.server";

// The Shopify CLI injects the live dev tunnel URL under different env var
// names depending on how it classifies the project's roles. The official
// Remix template convention is SHOPIFY_APP_URL, but this project's
// shopify.web.toml uses generic frontend/backend roles, and in that mode
// the CLI hands the URL over as APP_URL (also duplicated as HOST) instead.
// Checking all three keeps this working regardless of which one shows up.
const appUrl =
  process.env.SHOPIFY_APP_URL || process.env.APP_URL || process.env.HOST || "";

const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET || "",
  apiVersion: ApiVersion.October25,
  scopes: process.env.SCOPES?.split(","),
  appUrl,
  authPathPrefix: "/auth",
  sessionStorage: new PrismaSessionStorage(prisma),
  distribution: AppDistribution.AppStore,
  future: {
    unstable_newEmbeddedAuthStrategy: true,
    // `removeRest` used to live here, opting the app out of the REST API
    // ahead of it being removed entirely. As of this shopify-app-remix
    // version, REST is gone by default and the flag itself no longer
    // exists on FutureFlags — nothing else needs to change since this app
    // was already GraphQL-only.
    // This is the actual root cause fix for the persistent 403 "GraphQL
    // Client: Forbidden" on every Admin API call: Shopify stopped accepting
    // non-expiring offline access tokens for the Admin API entirely (public
    // apps created after April 1, 2026 — this app included — are already
    // blocked, not just facing a future deadline). Without this flag, the
    // library keeps requesting the old non-expiring token type, which
    // Shopify now flat-out rejects, regardless of which query is sent or
    // what scopes/permissions are otherwise correct. Enabling it makes the
    // library request a proper short-lived token + refresh token instead,
    // and transparently refresh it before it expires from then on.
    expiringOfflineAccessTokens: true,
  },
  webhooks: {
    APP_UNINSTALLED: {
      deliveryMethod: DeliveryMethod.Http,
      callbackUrl: "/webhooks/app/uninstalled",
    },
    ORDERS_CREATE: {
      deliveryMethod: DeliveryMethod.Http,
      callbackUrl: "/webhooks/orders/create",
    },
    ORDERS_UPDATED: {
      deliveryMethod: DeliveryMethod.Http,
      callbackUrl: "/webhooks/orders/updated",
    },
    ORDERS_CANCELLED: {
      deliveryMethod: DeliveryMethod.Http,
      callbackUrl: "/webhooks/orders/updated",
    },
    // Fires whenever a courier/tracking integration posts a status update
    // onto a fulfillment — this is what actually carries "delivered" in
    // near-real-time. ORDERS_UPDATED isn't a reliable signal for this on
    // its own (Shopify doesn't always re-fire it for every fulfillment
    // tracking change), and relying solely on the next Dashboard reload
    // (backfillRecentOrders' reconciliation pass) means revenue could sit
    // in "unrealized" for a while after a real delivery. This closes that
    // gap; the reconciliation pass still runs on every load as a fallback
    // in case this webhook is ever missed.
    FULFILLMENTS_UPDATE: {
      deliveryMethod: DeliveryMethod.Http,
      callbackUrl: "/webhooks/fulfillments/update",
    },
    CUSTOMERS_DATA_REQUEST: {
      deliveryMethod: DeliveryMethod.Http,
      callbackUrl: "/webhooks/customers/data_request",
    },
    CUSTOMERS_REDACT: {
      deliveryMethod: DeliveryMethod.Http,
      callbackUrl: "/webhooks/customers/redact",
    },
    SHOP_REDACT: {
      deliveryMethod: DeliveryMethod.Http,
      callbackUrl: "/webhooks/shop/redact",
    },
  },
  hooks: {
    afterAuth: async ({ session }) => {
      // Register webhooks for this shop right after install/auth.
      await shopify.registerWebhooks({ session });
      // Seed default cost settings so the dashboard has sane numbers before
      // the merchant visits Settings for the first time — only if this shop
      // has no CostSettings version at all yet. CostSettings is versioned
      // (see costSettingsHistory.server.ts), so `shop` is no longer unique
      // here and this can't be a plain upsert; afterAuth can also re-fire
      // on reinstall/re-auth for a shop that already has history, which
      // must NOT insert another version on top of it.
      const hasSettings = await prisma.costSettings.findFirst({
        where: { shop: session.shop },
        select: { id: true },
      });
      if (!hasSettings) {
        await prisma.costSettings.create({
          data: { shop: session.shop, effectiveFrom: new Date(0) },
        });
      }
    },
  },
});

export default shopify;
export const apiVersion = ApiVersion.October25;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
export const authenticate = shopify.authenticate;
export const unauthenticated = shopify.unauthenticated;
export const login = shopify.login;
export const registerWebhooks = shopify.registerWebhooks;
export const sessionStorage = shopify.sessionStorage;
