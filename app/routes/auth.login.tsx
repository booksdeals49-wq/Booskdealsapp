// Shopify's auth library requires the exact "/auth/login" path (matching
// authPathPrefix + "/login" in shopify.server.ts) to call login(), not
// authenticate.admin(). Without this dedicated route, that path was falling
// through to the auth.$.tsx catch-all, which calls authenticate.admin() for
// everything under /auth/* — this file fixes that by handling /auth/login
// specifically.
import { json } from "@remix-run/node";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { login } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const errors = await login(request);
  return json(errors);
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const errors = await login(request);
  return json(errors);
};

export default function Auth() {
  return null;
}
