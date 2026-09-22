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
  type CourierRateOverride,
} from "./profit.server.ts";

const costSettings: CostSettings = {
  defaultCogsPercent: 40,
  deliveryFeeFlat: 3,
  rtoFeeFlat: 4,
  cashHandlingPercent: 2,
  taxPercent: 5,
  packagingFeeFlat: 1,
  rtoRestockable: false,
  ecommerceTransactionTaxPercent: 0,
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
    isCancelled: false,
    isDelivered: true,
    isDispatched: true,
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

check("courier-specific cost replaces the flat delivery fee when the order's courier matches a configured rate", () => {
  const order: OrderInput = {
    orderId: "1b",
    totalPrice: 100,
    subtotalPrice: 100,
    isCod: true,
    isRto: false,
    isCancelled: false,
    isDelivered: true,
    isDispatched: true,
    courierName: "TCS",
    lineItems: [
      { variantId: "v1", productId: "p1", title: "Item", quantity: 1, price: 100 },
    ],
  };
  const courierRates: CourierRateOverride[] = [
    { courierName: "TCS", cost: 7 },
    { courierName: "Leopards", cost: 5 },
  ];
  const b = computeOrderProfit(order, costSettings, [], courierRates);
  // 7 (TCS's configured cost), not the flat 3 — the courier-specific rate wins.
  assert.equal(b.deliveryFee, 7);
});

check("courier matching is case-insensitive and tolerant of either name being a substring of the other", () => {
  const order: OrderInput = {
    orderId: "1c",
    totalPrice: 100,
    subtotalPrice: 100,
    isCod: true,
    isRto: false,
    isCancelled: false,
    isDelivered: true,
    isDispatched: true,
    // Shopify's tracking_company often comes back fuller/differently-cased
    // than what a merchant would type into Cost Settings.
    courierName: "TCS Express",
    lineItems: [
      { variantId: "v1", productId: "p1", title: "Item", quantity: 1, price: 100 },
    ],
  };
  const b = computeOrderProfit(order, costSettings, [], [{ courierName: "tcs", cost: 7 }]);
  assert.equal(b.deliveryFee, 7);
});

check("an order's courier that matches no configured rate falls back to the flat delivery fee", () => {
  const order: OrderInput = {
    orderId: "1d",
    totalPrice: 100,
    subtotalPrice: 100,
    isCod: true,
    isRto: false,
    isCancelled: false,
    isDelivered: true,
    isDispatched: true,
    courierName: "Some Unlisted Courier",
    lineItems: [
      { variantId: "v1", productId: "p1", title: "Item", quantity: 1, price: 100 },
    ],
  };
  const b = computeOrderProfit(order, costSettings, [], [{ courierName: "TCS", cost: 7 }]);
  assert.equal(b.deliveryFee, 3); // unchanged flat fee — no match
});

check("an order with no detected courier uses the flat delivery fee even when courier rates are configured", () => {
  const order: OrderInput = {
    orderId: "1e",
    totalPrice: 100,
    subtotalPrice: 100,
    isCod: true,
    isRto: false,
    isCancelled: false,
    isDelivered: true,
    isDispatched: true,
    lineItems: [
      { variantId: "v1", productId: "p1", title: "Item", quantity: 1, price: 100 },
    ],
  };
  const b = computeOrderProfit(order, costSettings, [], [{ courierName: "TCS", cost: 7 }]);
  assert.equal(b.deliveryFee, 3);
});

check("RTO order: zero revenue, no cash handling/tax, but delivery + RTO cost apply", () => {
  const order: OrderInput = {
    orderId: "2",
    totalPrice: 100,
    subtotalPrice: 100,
    isCod: true,
    isRto: true,
    isCancelled: false,
    isDelivered: true,
    isDispatched: true,
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
    isCancelled: false,
    isDelivered: true,
    isDispatched: true,
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

check("cancelled order: zero revenue, zero cost, distinct from RTO", () => {
  const order: OrderInput = {
    orderId: "2d",
    totalPrice: 100,
    subtotalPrice: 100,
    isCod: true,
    isRto: false,
    isCancelled: true,
    isDelivered: true,
    isDispatched: true,
    lineItems: [
      { variantId: "v1", productId: "p1", title: "Item", quantity: 1, price: 100 },
    ],
  };
  const b = computeOrderProfit(order, costSettings, []);
  // No sale happened and nothing was dispatched, so this is a total no-op —
  // unlike an RTO order, which still incurs delivery + return shipping cost.
  assert.equal(b.revenue, 0);
  assert.equal(b.cogs, 0);
  assert.equal(b.cogsLoss, 0);
  assert.equal(b.deliveryFee, 0);
  assert.equal(b.rtoCost, 0);
  assert.equal(b.cashHandlingFee, 0);
  assert.equal(b.tax, 0);
  assert.equal(b.packagingFee, 0);
  assert.equal(b.totalCost, 0);
  assert.equal(b.netProfit, 0);
});

check("placed but not yet dispatched COD order: nothing charged yet, revenue is pending fulfillment (not pipeline)", () => {
  const order: OrderInput = {
    orderId: "2e",
    totalPrice: 100,
    subtotalPrice: 100,
    isCod: true,
    isRto: false,
    isCancelled: false,
    isDelivered: false,
    isDispatched: false,
    lineItems: [
      { variantId: "v1", productId: "p1", title: "Item", quantity: 1, price: 100 },
    ],
  };
  const b = computeOrderProfit(order, costSettings, []);
  // Just placed, not yet handed to the courier — nothing has actually been
  // spent yet (no shipping, no packaging), so cost is genuinely zero, not
  // just deferred. And since it hasn't shipped, this money belongs in
  // pendingFulfillmentRevenue ("go ship this"), NOT pipelineRevenue, which
  // is reserved for orders already in transit — see the next test.
  assert.equal(b.revenue, 0);
  assert.equal(b.pendingFulfillmentRevenue, 100);
  assert.equal(b.pipelineRevenue, 0);
  assert.equal(b.deliveryFee, 0);
  assert.equal(b.packagingFee, 0);
  assert.equal(b.cogsLoss, 0);
  assert.equal(b.cashHandlingFee, 0);
  assert.equal(b.tax, 0);
  assert.equal(b.rtoCost, 0);
  assert.equal(b.totalCost, 0);
  assert.equal(b.netProfit, 0);
  // Raw cogs (informational) is still calculated regardless of dispatch
  // status — it just isn't counted as a real loss (cogsLoss) yet.
  assert.equal(b.cogs, 40);
  // Nothing committed yet, so there's nothing to explain a dip with either.
  assert.equal(b.inTransitCost, 0);
});

check("dispatched but not yet delivered COD order: delivery + packaging + COGS already incurred", () => {
  const order: OrderInput = {
    orderId: "2e2",
    totalPrice: 100,
    subtotalPrice: 100,
    isCod: true,
    isRto: false,
    isCancelled: false,
    isDelivered: false,
    isDispatched: true,
    lineItems: [
      { variantId: "v1", productId: "p1", title: "Item", quantity: 1, price: 100 },
    ],
  };
  const b = computeOrderProfit(order, costSettings, []);
  // Handed to the courier: the trip is charged and the product has left
  // inventory regardless of how the delivery attempt turns out, so these
  // are real costs now, same as an RTO order already treats them —
  // whether or not the cash has been collected yet (it hasn't: revenue is
  // still 0/pipeline). That means net profit is a genuine negative here —
  // real committed spend against not-yet-collected cash, not a deferred
  // zero.
  assert.equal(b.revenue, 0);
  assert.equal(b.pipelineRevenue, 100);
  assert.equal(b.deliveryFee, 3);
  assert.equal(b.packagingFee, 1);
  assert.equal(b.cogs, 40);
  assert.equal(b.cogsLoss, 40);
  // Cash handling and tax are still deferred — those are charges on cash
  // actually collected, which hasn't happened yet.
  assert.equal(b.cashHandlingFee, 0);
  assert.equal(b.tax, 0);
  assert.equal(b.rtoCost, 0);
  assert.equal(b.totalCost, 40 + 3 + 1);
  assert.equal(b.netProfit, -(40 + 3 + 1));
  // This is exactly what should show up in a "why did net profit dip"
  // explanation — the whole -44 is cost committed to an order still in
  // transit, matched against pipelineRevenue of 100 once it's delivered.
  assert.equal(b.inTransitCost, 40 + 3 + 1);
});

check("prepaid (non-COD) order realizes revenue immediately, regardless of delivery status", () => {
  const order: OrderInput = {
    orderId: "2f",
    totalPrice: 100,
    subtotalPrice: 100,
    isCod: false,
    isRto: false,
    isCancelled: false,
    isDelivered: false,
    isDispatched: true,
    lineItems: [
      { variantId: "v1", productId: "p1", title: "Item", quantity: 1, price: 100 },
    ],
  };
  const b = computeOrderProfit(order, costSettings, []);
  // Prepaid: cash was already collected at checkout, so this is fully
  // realized revenue even though the courier hasn't delivered it yet.
  assert.equal(b.revenue, 100);
  assert.equal(b.pipelineRevenue, 0);
  assert.equal(b.cashHandlingFee, 2);
  assert.equal(b.tax, 5);
});

check("COD order moves from pipeline to realized once isDelivered flips true", () => {
  const pending = computeOrderProfit(
    {
      orderId: "2g",
      totalPrice: 100,
      subtotalPrice: 100,
      isCod: true,
      isRto: false,
      isCancelled: false,
      isDelivered: false,
      isDispatched: true,
      lineItems: [{ variantId: "v1", productId: "p1", title: "Item", quantity: 1, price: 100 }],
    },
    costSettings,
    [],
  );
  const delivered = computeOrderProfit(
    {
      orderId: "2g",
      totalPrice: 100,
      subtotalPrice: 100,
      isCod: true,
      isRto: false,
      isCancelled: false,
      isDelivered: true,
      isDispatched: true,
      lineItems: [{ variantId: "v1", productId: "p1", title: "Item", quantity: 1, price: 100 }],
    },
    costSettings,
    [],
  );
  assert.equal(pending.revenue, 0);
  assert.equal(pending.pipelineRevenue, 100);
  // Already dispatched, so delivery + packaging + COGS are already real
  // costs while pending — only cash handling/tax and the revenue itself
  // wait for delivery confirmation.
  assert.equal(pending.netProfit, -(40 + 3 + 1));
  assert.equal(delivered.revenue, 100);
  assert.equal(delivered.pipelineRevenue, 0);
  // Once delivered, the same costs are still there, but now cash handling
  // and tax also apply and the revenue lands to net against all of it.
  assert.equal(delivered.netProfit, 100 - (40 + 3 + 2 + 5 + 1)); // cogs+delivery+cashHandling+tax+packaging
});

check("summarizeProfit aggregates pipelineRevenue across pending COD orders", () => {
  const delivered = computeOrderProfit(
    {
      orderId: "7",
      totalPrice: 100,
      subtotalPrice: 100,
      isCod: true,
      isRto: false,
      isCancelled: false,
      isDelivered: true,
      isDispatched: true,
      lineItems: [{ variantId: "v1", productId: "p1", title: "Item", quantity: 1, price: 100 }],
    },
    costSettings,
    [],
  );
  const pending = computeOrderProfit(
    {
      orderId: "8",
      totalPrice: 50,
      subtotalPrice: 50,
      isCod: true,
      isRto: false,
      isCancelled: false,
      isDelivered: false,
      isDispatched: true,
      lineItems: [{ variantId: "v1", productId: "p1", title: "Item", quantity: 1, price: 50 }],
    },
    costSettings,
    [],
  );
  const summary = summarizeProfit([delivered, pending], [false, false]);
  assert.equal(summary.revenue, 100);
  assert.equal(summary.pipelineRevenue, 50);
  // The pending order (totalPrice 50, dispatched) has already had
  // cogs(20) + delivery(3) + packaging(1) = 24 deducted from netProfit —
  // that's exactly what inTransitCost should surface, so a merchant can
  // see the dip is "24 committed to an order still in transit, 50 in
  // matching revenue coming" rather than a flat loss.
  assert.equal(summary.inTransitCost, 24);
});

check("summarizeProfit keeps pendingFulfillmentRevenue and pipelineRevenue separate across a mixed batch", () => {
  // Three COD orders in three different real-life stages, exactly the
  // scenario the merchant reported: a freshly placed order should show up
  // as "pending fulfillment" (go ship this), a dispatched-but-not-yet-
  // delivered order should show up as "pipeline" (in transit), and a
  // delivered order should be realized revenue. Before this fix, the
  // not-yet-dispatched order was incorrectly lumped into pipelineRevenue
  // alongside the in-transit order.
  const delivered = computeOrderProfit(
    {
      orderId: "9",
      totalPrice: 100,
      subtotalPrice: 100,
      isCod: true,
      isRto: false,
      isCancelled: false,
      isDelivered: true,
      isDispatched: true,
      lineItems: [{ variantId: "v1", productId: "p1", title: "Item", quantity: 1, price: 100 }],
    },
    costSettings,
    [],
  );
  const inTransit = computeOrderProfit(
    {
      orderId: "10",
      totalPrice: 50,
      subtotalPrice: 50,
      isCod: true,
      isRto: false,
      isCancelled: false,
      isDelivered: false,
      isDispatched: true,
      lineItems: [{ variantId: "v1", productId: "p1", title: "Item", quantity: 1, price: 50 }],
    },
    costSettings,
    [],
  );
  const justPlaced = computeOrderProfit(
    {
      orderId: "11",
      totalPrice: 30,
      subtotalPrice: 30,
      isCod: true,
      isRto: false,
      isCancelled: false,
      isDelivered: false,
      isDispatched: false,
      lineItems: [{ variantId: "v1", productId: "p1", title: "Item", quantity: 1, price: 30 }],
    },
    costSettings,
    [],
  );
  const summary = summarizeProfit([delivered, inTransit, justPlaced], [false, false, false]);
  assert.equal(summary.revenue, 100);
  assert.equal(summary.pendingFulfillmentRevenue, 30);
  assert.equal(summary.pipelineRevenue, 50);
  // Not-yet-dispatched order hasn't incurred any cost yet, so inTransitCost
  // should only reflect the dispatched-but-undelivered order (24, as above).
  assert.equal(summary.inTransitCost, 24);
});

check("rtoRestockable only changes RTO orders, never delivered ones", () => {
  const order: OrderInput = {
    orderId: "2c",
    totalPrice: 100,
    subtotalPrice: 100,
    isCod: true,
    isRto: false,
    isCancelled: false,
    isDelivered: true,
    isDispatched: true,
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
    isCancelled: false,
    isDelivered: true,
    isDispatched: true,
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
    isCancelled: false,
    isDelivered: true,
    isDispatched: true,
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

check("Shopify's own per-item cost is used when no manual override exists", () => {
  const order: OrderInput = {
    orderId: "9",
    totalPrice: 200,
    subtotalPrice: 200,
    isCod: true,
    isRto: false,
    isCancelled: false,
    isDelivered: true,
    isDispatched: true,
    lineItems: [
      {
        variantId: "v-shopify-cost",
        productId: "p1",
        title: "Item",
        quantity: 2,
        price: 100,
        shopifyUnitCost: 30,
      },
    ],
  };
  const b = computeOrderProfit(order, costSettings, []);
  // 30 * 2 = 60 — NOT the default-COGS-% guess (100 * 40% * 2 = 80).
  assert.equal(b.cogs, 60);
});

check("manual override still beats Shopify's own per-item cost", () => {
  const order: OrderInput = {
    orderId: "9b",
    totalPrice: 100,
    subtotalPrice: 100,
    isCod: true,
    isRto: false,
    isCancelled: false,
    isDelivered: true,
    isDispatched: true,
    lineItems: [
      {
        variantId: "v-both",
        productId: "p1",
        title: "Item",
        quantity: 1,
        price: 100,
        shopifyUnitCost: 30,
      },
    ],
  };
  const b = computeOrderProfit(order, costSettings, [
    { variantId: "v-both", costPerUnit: 12 },
  ]);
  assert.equal(b.cogs, 12);
});

check("falls back to default COGS % when Shopify has no cost on file", () => {
  const order: OrderInput = {
    orderId: "9c",
    totalPrice: 100,
    subtotalPrice: 100,
    isCod: true,
    isRto: false,
    isCancelled: false,
    isDelivered: true,
    isDispatched: true,
    lineItems: [
      {
        variantId: "v-no-cost",
        productId: "p1",
        title: "Item",
        quantity: 1,
        price: 100,
        shopifyUnitCost: null,
      },
    ],
  };
  const b = computeOrderProfit(order, costSettings, []);
  assert.equal(b.cogs, 40); // 100 * 40%
});

check("line items synced before shopifyUnitCost existed (field absent) fall back to default COGS %", () => {
  const order: OrderInput = {
    orderId: "9d",
    totalPrice: 100,
    subtotalPrice: 100,
    isCod: true,
    isRto: false,
    isCancelled: false,
    isDelivered: true,
    isDispatched: true,
    lineItems: [
      { variantId: "v-old", productId: "p1", title: "Item", quantity: 1, price: 100 },
    ],
  };
  const b = computeOrderProfit(order, costSettings, []);
  assert.equal(b.cogs, 40);
});

check("summarizeProfit aggregates revenue, cost, RTO rate correctly", () => {
  const delivered = computeOrderProfit(
    {
      orderId: "5",
      totalPrice: 100,
      subtotalPrice: 100,
      isCod: true,
      isRto: false,
      isCancelled: false,
      isDelivered: true,
      isDispatched: true,
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
      isCancelled: false,
      isDelivered: true,
      isDispatched: true,
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
