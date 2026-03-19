import { describe, it, expect, vi } from "vitest";
import {
  evaluateFilter,
  buildModifications,
  calcValue,
} from "../app/lib/business-logic.js";

/* ═══════════════════════════════════════════════════════════
   Webhook Handler Integration Tests
   
   These tests simulate the webhook flow:
   1. Product update received → evaluate automation rules
   2. Matching rules → build modifications
   3. Modifications → generate GraphQL mutations
   ═══════════════════════════════════════════════════════════ */

/* ───────── Test Data ───────── */
const incomingProduct = {
  id: "gid://shopify/Product/15061971927404",
  title: "QA Test Product with Long Name for Testing Purposes",
  vendor: "TestVendor",
  productType: "Electronics",
  status: "ACTIVE",
  tags: ["test", "electronics", "sale"],
  variants: {
    edges: [
      {
        node: {
          id: "gid://shopify/ProductVariant/100001",
          title: "Default",
          price: "49.99",
          compareAtPrice: "69.99",
          sku: "QA-ELEC-001",
          barcode: "9876543210",
          inventoryQuantity: 25,
        },
      },
      {
        node: {
          id: "gid://shopify/ProductVariant/100002",
          title: "Premium",
          price: "79.99",
          compareAtPrice: "99.99",
          sku: "QA-ELEC-002",
          barcode: "9876543211",
          inventoryQuantity: 10,
        },
      },
    ],
  },
};

/* ───────── Automation Rule Definitions ───────── */
const automationRules = [
  {
    name: "QA 1 - Discount electronics over $40",
    conditions: [
      { field: "productType", operator: "equals", value: "Electronics" },
      { field: "price", operator: "greater_than", value: "40" },
    ],
    actions: [
      { field: "price", type: "decrease_percent", value: "10" },
    ],
  },
  {
    name: "QA 2 - Tag sale items with clearance",
    conditions: [
      { field: "tags", operator: "contains", value: "sale" },
    ],
    actions: [
      { field: "tags", type: "add", value: "clearance" },
    ],
  },
  {
    name: "QA 3 - Update vendor for luxury items",
    conditions: [
      { field: "price", operator: "greater_than", value: "100" },
    ],
    actions: [
      { field: "vendor", type: "set", value: "Premium Brand" },
    ],
  },
  {
    name: "QA 4 - No match rule",
    conditions: [
      { field: "productType", operator: "equals", value: "Clothing" },
    ],
    actions: [
      { field: "price", type: "decrease_percent", value: "50" },
    ],
  },
];

/* ═══════════════════════════════════════════════════════════
   1. Rule Matching Simulation
   ═══════════════════════════════════════════════════════════ */
describe("Webhook flow — rule matching", () => {
  it("matches rules where ALL conditions are met", () => {
    const matchingRules = automationRules.filter((rule) =>
      rule.conditions.every((cond) => evaluateFilter(incomingProduct, cond))
    );

    const matchedNames = matchingRules.map((r) => r.name);
    expect(matchedNames).toContain("QA 1 - Discount electronics over $40");
    expect(matchedNames).toContain("QA 2 - Tag sale items with clearance");
    expect(matchedNames).not.toContain("QA 3 - Update vendor for luxury items"); // no variant > $100
    expect(matchedNames).not.toContain("QA 4 - No match rule"); // not Clothing
  });

  it("returns empty when no rules match", () => {
    const noMatchProduct = { ...incomingProduct, productType: "Food", tags: [] };
    noMatchProduct.variants = {
      edges: [
        {
          node: {
            id: "gid://shopify/ProductVariant/999",
            price: "5.00",
            compareAtPrice: null,
            sku: "FOOD-001",
            barcode: "",
            inventoryQuantity: 100,
          },
        },
      ],
    };

    const matchingRules = automationRules.filter((rule) =>
      rule.conditions.every((cond) => evaluateFilter(noMatchProduct, cond))
    );

    expect(matchingRules).toHaveLength(0);
  });
});

/* ═══════════════════════════════════════════════════════════
   2. Modification Building from Matched Rules
   ═══════════════════════════════════════════════════════════ */
describe("Webhook flow — modification building", () => {
  it("builds correct price decrease from matched rule", () => {
    const rule = automationRules[0]; // 10% discount on electronics
    const { productInput, variantUpdates } = buildModifications(incomingProduct, rule.actions);

    expect(Object.keys(productInput)).toHaveLength(0); // price is variant-level
    expect(variantUpdates).toHaveLength(2);

    // 49.99 * 0.9 = 44.991 → 44.99
    expect(variantUpdates[0].id).toBe("gid://shopify/ProductVariant/100001");
    expect(variantUpdates[0].price).toBe("44.99");

    // 79.99 * 0.9 = 71.991 → 71.99
    expect(variantUpdates[1].id).toBe("gid://shopify/ProductVariant/100002");
    expect(variantUpdates[1].price).toBe("71.99");
  });

  it("builds correct tag addition from matched rule", () => {
    const rule = automationRules[1]; // add clearance tag
    const { productInput, variantUpdates } = buildModifications(incomingProduct, rule.actions);

    expect(productInput.tags).toContain("clearance");
    expect(productInput.tags).toContain("sale");
    expect(productInput.tags).toContain("test");
    expect(variantUpdates).toHaveLength(0);
  });
});

/* ═══════════════════════════════════════════════════════════
   3. GraphQL Mutation Structure Validation
   ═══════════════════════════════════════════════════════════ */
describe("Webhook flow — GraphQL mutation structure", () => {
  it("generates valid productUpdate input for product-level changes", () => {
    const { productInput } = buildModifications(incomingProduct, [
      { field: "title", type: "prepend", value: "[SALE] " },
      { field: "status", type: "set", value: "DRAFT" },
    ]);

    // Validate the input structure matches what Shopify expects
    expect(productInput.title).toBe("[SALE] QA Test Product with Long Name for Testing Purposes");
    expect(productInput.status).toBe("DRAFT");

    // Build the mutation input as the webhook handler would
    const mutationInput = { id: incomingProduct.id, ...productInput };
    expect(mutationInput.id).toBe("gid://shopify/Product/15061971927404");
    expect(mutationInput).toHaveProperty("title");
    expect(mutationInput).toHaveProperty("status");
  });

  it("generates valid productVariantsBulkUpdate input for variant-level changes", () => {
    const { variantUpdates } = buildModifications(incomingProduct, [
      { field: "price", type: "exact", value: "24.99" },
      { field: "compareAtPrice", type: "exact", value: "39.99" },
    ]);

    expect(variantUpdates).toHaveLength(2);

    // Each variant update should have id + changed fields
    for (const vu of variantUpdates) {
      expect(vu).toHaveProperty("id");
      expect(vu.id).toMatch(/^gid:\/\/shopify\/ProductVariant\//);
      expect(vu.price).toBe("24.99");
      expect(vu.compareAtPrice).toBe("39.99");
    }

    // Build the mutation variables as the webhook handler would
    const variables = {
      productId: incomingProduct.id,
      variants: variantUpdates,
    };
    expect(variables.productId).toBe("gid://shopify/Product/15061971927404");
    expect(variables.variants).toHaveLength(2);
  });

  it("handles mixed product + variant changes correctly", () => {
    const { productInput, variantUpdates } = buildModifications(incomingProduct, [
      { field: "title", type: "append", value: " - CLEARANCE" },
      { field: "price", type: "decrease_percent", value: "30" },
      { field: "tags", type: "add", value: "clearance" },
    ]);

    // Product-level changes
    expect(productInput.title).toBe("QA Test Product with Long Name for Testing Purposes - CLEARANCE");
    expect(productInput.tags).toContain("clearance");

    // Variant-level changes
    expect(variantUpdates).toHaveLength(2);
    // 49.99 * 0.7 = 34.993 → 34.99
    expect(variantUpdates[0].price).toBe("34.99");
    // 79.99 * 0.7 = 55.993 → 55.99
    expect(variantUpdates[1].price).toBe("55.99");
  });
});

/* ═══════════════════════════════════════════════════════════
   4. Full Webhook Pipeline Simulation
   ═══════════════════════════════════════════════════════════ */
describe("Webhook flow — full pipeline simulation", () => {
  it("processes incoming product through rules and generates all mutations", () => {
    // Step 1: Find matching rules
    const matchingRules = automationRules.filter((rule) =>
      rule.conditions.every((cond) => evaluateFilter(incomingProduct, cond))
    );
    expect(matchingRules.length).toBeGreaterThan(0);

    // Step 2: Build modifications for each matching rule
    const allProductInputs = {};
    const allVariantUpdates = new Map();

    for (const rule of matchingRules) {
      const { productInput, variantUpdates } = buildModifications(incomingProduct, rule.actions);

      // Merge product-level changes
      Object.assign(allProductInputs, productInput);

      // Merge variant-level changes
      for (const vu of variantUpdates) {
        const existing = allVariantUpdates.get(vu.id) || { id: vu.id };
        Object.assign(existing, vu);
        allVariantUpdates.set(vu.id, existing);
      }
    }

    // Step 3: Verify merged results
    // From QA 2: tags should include clearance
    expect(allProductInputs.tags).toContain("clearance");

    // From QA 1: prices should be discounted 10%
    const variant1 = allVariantUpdates.get("gid://shopify/ProductVariant/100001");
    expect(variant1).toBeDefined();
    expect(variant1.price).toBe("44.99");

    const variant2 = allVariantUpdates.get("gid://shopify/ProductVariant/100002");
    expect(variant2).toBeDefined();
    expect(variant2.price).toBe("71.99");
  });

  it("skips processing when no rules match", () => {
    const unmatchedProduct = {
      ...incomingProduct,
      productType: "Furniture",
      tags: [],
      variants: {
        edges: [
          {
            node: {
              id: "gid://shopify/ProductVariant/999",
              price: "5.00",
              compareAtPrice: null,
              sku: "FURN-001",
              barcode: "",
              inventoryQuantity: 0,
            },
          },
        ],
      },
    };

    const matchingRules = automationRules.filter((rule) =>
      rule.conditions.every((cond) => evaluateFilter(unmatchedProduct, cond))
    );

    expect(matchingRules).toHaveLength(0);
    // No mutations should be generated
  });
});

/* ═══════════════════════════════════════════════════════════
   5. Webhook Edge Cases
   ═══════════════════════════════════════════════════════════ */
describe("Webhook edge cases", () => {
  it("handles product with single variant", () => {
    const singleVariantProduct = {
      ...incomingProduct,
      variants: {
        edges: [incomingProduct.variants.edges[0]],
      },
    };

    const { variantUpdates } = buildModifications(singleVariantProduct, [
      { field: "price", type: "exact", value: "19.99" },
    ]);

    expect(variantUpdates).toHaveLength(1);
    expect(variantUpdates[0].price).toBe("19.99");
  });

  it("handles product with null compareAtPrice", () => {
    const productWithNullCompare = {
      ...incomingProduct,
      variants: {
        edges: [
          {
            node: {
              id: "gid://shopify/ProductVariant/100001",
              price: "49.99",
              compareAtPrice: null,
              sku: "TEST",
              barcode: "",
              inventoryQuantity: 0,
            },
          },
        ],
      },
    };

    const { variantUpdates } = buildModifications(productWithNullCompare, [
      { field: "compareAtPrice", type: "increase_fixed", value: "10" },
    ]);

    // null → 0 + 10 = 10.00
    expect(variantUpdates[0].compareAtPrice).toBe("10.00");
  });

  it("handles concurrent rule modifications to same field", () => {
    // Two rules both modify price — last one wins
    const actions = [
      { field: "price", type: "decrease_percent", value: "10" },
      { field: "price", type: "decrease_fixed", value: "5" },
    ];

    const { variantUpdates } = buildModifications(incomingProduct, actions);

    // First action: 49.99 * 0.9 = 44.99
    // Second action applied to ORIGINAL: 49.99 - 5 = 44.99
    // Both overwrite the same field, last write wins
    expect(variantUpdates[0]).toHaveProperty("price");
  });

  it("handles empty actions array", () => {
    const { productInput, variantUpdates } = buildModifications(incomingProduct, []);
    expect(Object.keys(productInput)).toHaveLength(0);
    expect(variantUpdates).toHaveLength(0);
  });
});

/* ═══════════════════════════════════════════════════════════
   6. PriceHistory Record Building (Bug BE-008-1 fix)
   
   Verifies that automation rules correctly build PriceHistory
   records that match the database schema.
   ═══════════════════════════════════════════════════════════ */
import { buildPriceHistoryRecords } from "../app/lib/business-logic.js";

const SHOP = "polychrome-dev-store-2.myshopify.com";

describe("Webhook flow — PriceHistory record building", () => {
  it("creates PriceHistory records for price changes", () => {
    const actions = [
      { field: "price", type: "exact", value: "12.99" },
    ];

    const records = buildPriceHistoryRecords(incomingProduct, actions, "QA 1", SHOP);

    expect(records).toHaveLength(2); // 2 variants
    for (const record of records) {
      // Verify all required PriceHistory schema fields are present
      expect(record).toHaveProperty("shop", SHOP);
      expect(record).toHaveProperty("productId");
      expect(record).toHaveProperty("variantId");
      expect(record).toHaveProperty("productTitle");
      expect(record).toHaveProperty("oldPrice");
      expect(record).toHaveProperty("newPrice", "12.99");
      expect(record).toHaveProperty("changeType", "automation");
      expect(record).toHaveProperty("changeSource", "automation");
      expect(record).toHaveProperty("bulkEditName", "Auto: QA 1");
    }

    // First variant: 49.99 → 12.99
    expect(records[0].variantId).toBe("gid://shopify/ProductVariant/100001");
    expect(records[0].oldPrice).toBe("49.99");
    expect(records[0].variantTitle).toBe("Default");

    // Second variant: 79.99 → 12.99
    expect(records[1].variantId).toBe("gid://shopify/ProductVariant/100002");
    expect(records[1].oldPrice).toBe("79.99");
    expect(records[1].variantTitle).toBe("Premium");
  });

  it("creates PriceHistory records for percentage decrease", () => {
    const actions = [
      { field: "price", type: "decrease_percent", value: "10" },
    ];

    const records = buildPriceHistoryRecords(incomingProduct, actions, "Discount Rule", SHOP);

    expect(records).toHaveLength(2);

    // 49.99 * 0.9 = 44.991 → 44.99
    expect(records[0].oldPrice).toBe("49.99");
    expect(records[0].newPrice).toBe("44.99");

    // 79.99 * 0.9 = 71.991 → 71.99
    expect(records[1].oldPrice).toBe("79.99");
    expect(records[1].newPrice).toBe("71.99");
  });

  it("creates PriceHistory records for compareAtPrice changes", () => {
    const actions = [
      { field: "compareAtPrice", type: "exact", value: "99.99" },
    ];

    const records = buildPriceHistoryRecords(incomingProduct, actions, "Compare Price Rule", SHOP);

    expect(records).toHaveLength(1); // Only 1 variant has different compareAtPrice (69.99 → 99.99)
    // The second variant already has 99.99 so no change

    expect(records[0].changeType).toBe("automation_compare");
    expect(records[0].changeSource).toBe("automation");
    expect(records[0].oldPrice).toBe("69.99");
    expect(records[0].newPrice).toBe("99.99");
  });

  it("does NOT create records when price doesn't change", () => {
    const actions = [
      { field: "price", type: "exact", value: "49.99" }, // Same as current price of first variant
    ];

    const singleVariantProduct = {
      ...incomingProduct,
      variants: {
        edges: [incomingProduct.variants.edges[0]], // Only first variant with price 49.99
      },
    };

    const records = buildPriceHistoryRecords(singleVariantProduct, actions, "No Change Rule", SHOP);

    expect(records).toHaveLength(0); // Price didn't change, no record
  });

  it("does NOT create records for non-price fields (tags, title, etc.)", () => {
    const actions = [
      { field: "tags", type: "add", value: "clearance" },
      { field: "title", type: "prepend", value: "[SALE] " },
      { field: "vendor", type: "set", value: "New Vendor" },
    ];

    const records = buildPriceHistoryRecords(incomingProduct, actions, "Non-Price Rule", SHOP);

    expect(records).toHaveLength(0); // Only price/compareAtPrice fields create history
  });

  it("creates records for mixed price and non-price actions", () => {
    const actions = [
      { field: "tags", type: "add", value: "clearance" },
      { field: "price", type: "decrease_fixed", value: "5" },
      { field: "title", type: "append", value: " - SALE" },
    ];

    const records = buildPriceHistoryRecords(incomingProduct, actions, "Mixed Rule", SHOP);

    // Only price changes should generate records
    expect(records).toHaveLength(2); // 2 variants with price changes
    expect(records[0].newPrice).toBe("44.99"); // 49.99 - 5
    expect(records[1].newPrice).toBe("74.99"); // 79.99 - 5
  });

  it("handles product with null compareAtPrice", () => {
    const productWithNullCompare = {
      ...incomingProduct,
      variants: {
        edges: [
          {
            node: {
              id: "gid://shopify/ProductVariant/100001",
              title: "Default",
              price: "49.99",
              compareAtPrice: null,
              sku: "TEST",
              barcode: "",
              inventoryQuantity: 0,
            },
          },
        ],
      },
    };

    const actions = [
      { field: "compareAtPrice", type: "exact", value: "69.99" },
    ];

    const records = buildPriceHistoryRecords(productWithNullCompare, actions, "Set Compare", SHOP);

    expect(records).toHaveLength(1);
    expect(records[0].oldPrice).toBe("0"); // null → "0"
    expect(records[0].newPrice).toBe("69.99");
    expect(records[0].changeType).toBe("automation_compare");
  });

  it("includes correct bulkEditName with 'Auto:' prefix", () => {
    const actions = [
      { field: "price", type: "exact", value: "1.00" },
    ];

    const records = buildPriceHistoryRecords(incomingProduct, actions, "My Fancy Rule", SHOP);

    expect(records.length).toBeGreaterThan(0);
    for (const record of records) {
      expect(record.bulkEditName).toBe("Auto: My Fancy Rule");
    }
  });

  it("uses correct productId and productTitle from product", () => {
    const actions = [
      { field: "price", type: "exact", value: "1.00" },
    ];

    const records = buildPriceHistoryRecords(incomingProduct, actions, "Test", SHOP);

    for (const record of records) {
      expect(record.productId).toBe("gid://shopify/Product/15061971927404");
      expect(record.productTitle).toBe("QA Test Product with Long Name for Testing Purposes");
    }
  });
});
