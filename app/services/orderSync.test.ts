// Standalone test for wasDispatched — no test framework or database needed,
// since it's a pure function. Run with: npm run test:order-sync
//
// Regression coverage for a real bug: wasDispatched used to check
// `status.includes("fulfil")`, which is a substring match — and "unfulfilled"
// literally contains the substring "fulfil" (u-n-[fulfil]-led). That silently
// classified a freshly-placed, never-touched order as dispatched, which sent
// its revenue straight into "Unrealized revenue (pipeline)" instead of
// "Pending fulfillment" the moment Shopify's GraphQL backfill wrote back its
// displayFulfillmentStatus of "UNFULFILLED" (the REST webhook path never hit
// this, since REST leaves fulfillment_status null pre-fulfillment — only
// GraphQL spells it out as the literal string "UNFULFILLED").

import assert from "node:assert/strict";
import { wasDispatched } from "./fulfillmentStatus.ts";

let passed = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ok  - ${name}`);
  } catch (err) {
    console.error(`FAIL - ${name}`);
    throw err;
  }
}

console.log("wasDispatched tests");

check("null/undefined/empty fulfillment status is not dispatched", () => {
  assert.equal(wasDispatched(null), false);
  assert.equal(wasDispatched(undefined), false);
  assert.equal(wasDispatched(""), false);
});

check("REST 'fulfilled'/'partial'/'restocked' are dispatched", () => {
  assert.equal(wasDispatched("fulfilled"), true);
  assert.equal(wasDispatched("partial"), true);
  assert.equal(wasDispatched("restocked"), true);
});

check("GraphQL FULFILLED/PARTIALLY_FULFILLED/RESTOCKED (any case) are dispatched", () => {
  assert.equal(wasDispatched("FULFILLED"), true);
  assert.equal(wasDispatched("PARTIALLY_FULFILLED"), true);
  assert.equal(wasDispatched("RESTOCKED"), true);
});

check("REGRESSION: GraphQL's UNFULFILLED is NOT dispatched (used to false-positive on substring 'fulfil')", () => {
  assert.equal(wasDispatched("UNFULFILLED"), false);
  assert.equal(wasDispatched("unfulfilled"), false);
});

check("REGRESSION: PENDING_FULFILLMENT is NOT dispatched (also used to false-positive)", () => {
  assert.equal(wasDispatched("PENDING_FULFILLMENT"), false);
});

check("IN_PROGRESS/ON_HOLD/OPEN/SCHEDULED are NOT dispatched — nothing has shipped yet", () => {
  assert.equal(wasDispatched("IN_PROGRESS"), false);
  assert.equal(wasDispatched("ON_HOLD"), false);
  assert.equal(wasDispatched("OPEN"), false);
  assert.equal(wasDispatched("SCHEDULED"), false);
});

console.log(`\n${passed} passed`);
