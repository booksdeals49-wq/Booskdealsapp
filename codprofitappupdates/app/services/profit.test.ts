// Standalone test for the profit engine — no test framework dependency
// needed. Run with: node --experimental-strip-types app/services/profit.test.ts
// (or `npm run test:profit`).

import assert from "node:assert/strict";
import {
  computeOrderProfit,
  summarizeProfit,
  computeRoas,
  type CostSettings,
  type OrderInput,
} from "./profit.server.ts";

const costSettings: CostSettings = {
  defaultCogsPercent: 40,
  deliveryFeeFlat: 3,
  rtoFeeFlat: 4,
  cashHandlingPercent: 2,
  taxPercent: 5,
  packagingFeeFlat: 1,
  rtoRestockable: false,
};

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

console.log("Profit engine tests");

check("delivered order: full revenue, standard cost stack", () => {
  const order: OrderInput = {
    orderId: "1",
    totalPrice: 100,
    subtotalPrice: 100,
    isCod: true,
    isRto: false,
    lineItems: [
      { variantId: "v1", productId: "p1", title: "Item", quantity: 1, price: 100 },
    ],
  };
  const b = computeOrderProfit(order, costSettings, []);
  // cogs = 100 * 40% = 40
  assert.equal(b.cogs, 40);
  assert.equal(b.deliveryFee, 3);
  assert.equal(b.rtoCost, 0);
  assert.equal(b.cashHandlingFee, 2); // 2% of 100
  assert.equal(b.tax, 5); // 5% of 100
  assert.equal(b.packagingFee, 1);
  assert.equal(b.totalCost, 40 + 3 + 0 + 2 + 5 + 1);
  assert.equal(b.revenue, 100);
  assert.equal(b.netProfit, 100 - b.totalCost);
});

check("RTO order: zero revenue, no cash handling/tax, but delivery + RTO cost apply", () => {
  const order: OrderInput = {
    orderId: "2",
    totalPrice: 100,
    subtotalPrice: 100,
    isCod: true,
    isRto: true,
    lineItems: [
      { variantId: "v1", productId: "p1", title: "Item", quantity: 1, price: 100 },
    ],
  };
  const b = computeOrderProfit(order, costSettings, []);
  assert.equal(b.revenue, 0);
  assert.equal(b.cashHandlingFee, 0);
  assert.equal(b.tax, 0);
  assert.equal(b.deliveryFee, 3);
  assert.equal(b.rtoCost, 4);
  assert.equal(b.cogs, 40);
  // rtoRestockable is false in the shared costSettings, so the full COGS
  // is written off just like before this setting existed.
  assert.equal(b.cogsLoss, 40);
  // netProfit should be negative: 0 - (40+3+4+0+0+1)
  assert.equal(b.netProfit, -48);
});

check("RTO order with rtoRestockable: true does NOT write off COGS", () => {
  const order: OrderInput = {
    orderId: "2b",
    totalPrice: 100,
    subtotalPrice: 100,
    isCod: true,
    isRto: true,
    lineItems: [
      { variantId: "v1", productId: "p1", title: "Item", quantity: 1, price: 100 },
    ],
  };
  const restockableSettings: CostSettings = { ...costSettings, rtoRestockable: true };
  const b = computeOrderProfit(order, restockableSettings, []);
  assert.equal(b.revenue, 0);
  // Raw product cost is still calculated/reported...
  assert.equal(b.cogs, 40);
  // ...but not counted as a loss, since the item goes back into stock.
  assert.equal(b.cogsLoss, 0);
  // Only delivery + RTO shipping + the flat packaging fee (unconditional,
  // charged on every order) are real losses here: 3 + 4 + 1 = 8
  assert.equal(b.totalCost, 3 + 4 + 1);
  assert.equal(b.netProfit, -8);
});

check("rtoRestockable only changes RTO orders, never delivered ones", () => {
  const order: OrderInput = {
    orderId: "2c",
    totalPrice: 100,
    subtotalPrice: 100,
    isCod: true,
    isRto: false,
    lineItems: [
      { variantId: "v1", productId: "p1", title: "Item", quantity: 1, price: 100 },
    ],
  };
  const restockableSettings: CostSettings = { ...costSettings, rtoRestockable: true };
  const b = computeOrderProfit(order, restockableSettings, []);
  // Delivered orders always incur their real COGS regardless of this
  // setting — it only applies to the RTO case.
  assert.equal(b.cogsLoss, b.cogs);
  assert.equal(b.cogsLoss, 40);
});

check("product cost override takes precedence over default COGS %", () => {
  const order: OrderInput = {
    orderId: "3",
    totalPrice: 50,
    subtotalPrice: 50,
    isCod: true,
    isRto: false,
    lineItems: [
      { variantId: "v-override", productId: "p1", title: "Item", quantity: 2, price: 25 },
    ],
  };
  const b = computeOrderProfit(order, costSettings, [
    { variantId: "v-override", costPerUnit: 10 },
  ]);
  // cogs = 10 * 2 = 20 (NOT 25*2*40% = 20 coincidentally same here, use a
  // value that would differ to prove override wins)
  assert.equal(b.cogs, 20);
});

check("product cost override differs from percent-based default (sanity)", () => {
  const order: OrderInput = {
    orderId: "4",
    totalPrice: 200,
    subtotalPrice: 200,
    isCod: true,
    isRto: false,
    lineItems: [
      { variantId: "v-override", productId: "p1", title: "Item", quantity: 1, price: 200 },
    ],
  };
  const withOverride = computeOrderProfit(order, costSettings, [
    { variantId: "v-override", costPerUnit: 15 },
  ]);
  const withoutOverride = computeOrderProfit(order, costSettings, []);
  assert.equal(withOverride.cogs, 15);
  assert.equal(withoutOverride.cogs, 80); // 200 * 40%
  assert.notEqual(withOverride.cogs, withoutOverride.cogs);
});

check("summarizeProfit aggregates revenue, cost, RTO rate correctly", () => {
  const delivered = computeOrderProfit(
    {
      orderId: "5",
      totalPrice: 100,
      subtotalPrice: 100,
      isCod: true,
      isRto: false,
      lineItems: [{ variantId: "v1", productId: "p1", title: "Item", quantity: 1, price: 100 }],
    },
    costSettings,
    [],
  );
  const rto = computeOrderProfit(
    {
      orderId: "6",
      totalPrice: 100,
      subtotalPrice: 100,
      isCod: true,
      isRto: true,
      lineItems: [{ variantId: "v1", productId: "p1", title: "Item", quantity: 1, price: 100 }],
    },
    costSettings,
    [],
  );
  const summary = summarizeProfit([delivered, rto], [false, true]);
  assert.equal(summary.orderCount, 2);
  assert.equal(summary.rtoCount, 1);
  assert.equal(summary.rtoRatePercent, 50);
  assert.equal(summary.revenue, 100); // only the delivered order's revenue
  assert.equal(summary.netProfit, delivered.netProfit + rto.netProfit);
});

check("computeRoas: true ROAS is lower than gross ROAS when RTO exists", () => {
  const roas = computeRoas(
    /* grossOrderRevenue */ 1000,
    /* realizedRevenue */ 600,
    /* netProfit */ 200,
    /* adSpend */ 100,
  );
  assert.equal(roas.grossRoas, 10);
  assert.equal(roas.trueRoas, 6);
  assert.ok(roas.trueRoas < roas.grossRoas);
  assert.equal(roas.profitAfterAdSpend, 100);
});

check("computeRoas: zero ad spend does not divide by zero", () => {
  const roas = computeRoas(500, 300, 50, 0);
  assert.equal(roas.grossRoas, 0);
  assert.equal(roas.trueRoas, 0);
});

console.log(`\n${passed} passed`);
