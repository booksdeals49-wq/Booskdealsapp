import { vitePlugin as remix } from "@remix-run/dev";
import { defineConfig, type UserConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

declare module "@remix-run/node" {
  interface Future {
    v3_singleFetch: true;
  }
}

// The Shopify CLI injects the live dev tunnel URL as APP_URL (and HOST) for
// this project's generic frontend/backend role setup, not SHOPIFY_APP_URL
// (the official Remix template's variable name) — checking all three covers
// either naming convention.
const appUrlEnv =
  process.env.SHOPIFY_APP_URL || process.env.APP_URL || process.env.HOST || "http://localhost";

const host = new URL(appUrlEnv).hostname;

let hmrConfig;
if (host === "localhost") {
  hmrConfig = { protocol: "ws", host: "localhost", port: 64999, clientPort: 64999 };
} else {
  hmrConfig = { protocol: "wss", host, port: parseInt(process.env.FRONTEND_PORT!) || 8002, clientPort: 443 };
}

export default defineConfig({
  server: {
    allowedHosts: true,
    cors: { preflightContinue: true },
    port: Number(process.env.PORT || 3000),
    hmr: hmrConfig,
    fs: { allow: ["app", "node_modules"] },
  },
  plugins: [
    remix({
      ignoredRouteFiles: ["**/.*"],
      future: {
        v3_fetcherPersist: true,
        v3_relativeSplatPath: true,
        v3_throwAbortReason: true,
        v3_lazyRouteDiscovery: true,
        v3_singleFetch: true,
      },
    }),
    tsconfigPaths(),
  ],
  build: {
    assetsInlineLimit: 0,
  },
  ssr: {
    noExternal: [
      "@shopify/shopify-app-remix",
      "@shopify/shopify-app-session-storage-prisma",
    ],
  },
} satisfies UserConfig);