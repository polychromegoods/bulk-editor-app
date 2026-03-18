import { describe, it, expect } from "vitest";
import {
  calcValue,
  evaluateFilter,
  matchValue,
  canPerformEdit,
  shouldResetMonthlyEdits,
  buildModifications,
  PLAN_LIMITS,
  getFieldDef,
} from "../app/lib/business-logic.js";

/* ═══════════════════════════════════════════════════════════
   1. Price Calculation Tests
   ═══════════════════════════════════════════════════════════ */
describe("calcValue — numeric (price) calculations", () => {
  it("sets exact price", () => {
    expect(calcValue("25.00", { field: "price", type: "exact", value: "19.99" })).toBe("19.99");
  });

  it("increases by percentage", () => {
    expect(calcValue("100.00", { field: "price", type: "increase_percent", value: "10" })).toBe("110.00");
  });

  it("decreases by percentage", () => {
    expect(calcValue("100.00", { field: "price", type: "decrease_percent", value: "25" })).toBe("75.00");
  });

  it("increases by fixed amount", () => {
    expect(calcValue("50.00", { field: "price", type: "increase_fixed", value: "5.50" })).toBe("55.50");
  });

  it("decreases by fixed amount", () => {
    expect(calcValue("50.00", { field: "price", type: "decrease_fixed", value: "10" })).toBe("40.00");
  });

  it("never goes below zero", () => {
    expect(calcValue("5.00", { field: "price", type: "decrease_fixed", value: "100" })).toBe("0.00");
  });

  it("handles zero starting price", () => {
    expect(calcValue("0", { field: "price", type: "increase_percent", value: "50" })).toBe("0.00");
  });

  it("handles null/undefined starting price", () => {
    expect(calcValue(null, { field: "price", type: "exact", value: "9.99" })).toBe("9.99");
    expect(calcValue(undefined, { field: "price", type: "increase_fixed", value: "5" })).toBe("5.00");
  });

  it("returns null for NaN value", () => {
    expect(calcValue("10.00", { field: "price", type: "exact", value: "abc" })).toBeNull();
  });

  it("returns null for unknown field", () => {
    expect(calcValue("10.00", { field: "nonexistent", type: "exact", value: "5" })).toBeNull();
  });
});

describe("calcValue — rounding modes", () => {
  it("rounds to .99", () => {
    expect(calcValue("100.00", { field: "price", type: "increase_percent", value: "10", rounding: "99" })).toBe("110.99");
  });

  it("rounds to .95", () => {
    expect(calcValue("100.00", { field: "price", type: "increase_percent", value: "10", rounding: "95" })).toBe("110.95");
  });

  it("rounds to whole number", () => {
    expect(calcValue("100.00", { field: "price", type: "increase_percent", value: "10", rounding: "whole" })).toBe("110.00");
  });

  it("rounds .99 on a fractional result", () => {
    // 47.50 * 1.15 = 54.625 → floor(54.625) + 0.99 = 54.99
    expect(calcValue("47.50", { field: "price", type: "increase_percent", value: "15", rounding: "99" })).toBe("54.99");
  });
});

describe("calcValue — compareAtPrice", () => {
  it("sets exact compare-at price", () => {
    expect(calcValue("30.00", { field: "compareAtPrice", type: "exact", value: "49.99" })).toBe("49.99");
  });

  it("increases compare-at price by percentage", () => {
    expect(calcValue("20.00", { field: "compareAtPrice", type: "increase_percent", value: "50" })).toBe("30.00");
  });
});

/* ═══════════════════════════════════════════════════════════
   2. Text Field Calculations
   ═══════════════════════════════════════════════════════════ */
describe("calcValue — text fields", () => {
  it("sets title", () => {
    expect(calcValue("Old Title", { field: "title", type: "set", value: "New Title" })).toBe("New Title");
  });

  it("prepends to title", () => {
    expect(calcValue("Widget", { field: "title", type: "prepend", value: "[SALE] " })).toBe("[SALE] Widget");
  });

  it("appends to title", () => {
    expect(calcValue("Widget", { field: "title", type: "append", value: " - On Sale" })).toBe("Widget - On Sale");
  });

  it("find and replace in vendor", () => {
    expect(calcValue("Acme Corp", { field: "vendor", type: "find_replace", value: "Acme", value2: "Beta" })).toBe("Beta Corp");
  });

  it("find and replace removes when value2 is empty", () => {
    expect(calcValue("Acme Corp", { field: "vendor", type: "find_replace", value: " Corp" })).toBe("Acme");
  });
});

/* ═══════════════════════════════════════════════════════════
   3. Tag Calculations
   ═══════════════════════════════════════════════════════════ */
describe("calcValue — tags", () => {
  it("adds tags", () => {
    expect(calcValue("sale, featured", { field: "tags", type: "add", value: "new, sale" })).toBe("sale, featured, new");
  });

  it("removes tags", () => {
    expect(calcValue("sale, featured, clearance", { field: "tags", type: "remove", value: "sale, clearance" })).toBe("featured");
  });

  it("sets tags (replaces all)", () => {
    expect(calcValue("old1, old2", { field: "tags", type: "set", value: "new1, new2" })).toBe("new1, new2");
  });

  it("adds tags to empty", () => {
    expect(calcValue("", { field: "tags", type: "add", value: "tag1, tag2" })).toBe("tag1, tag2");
  });
});

/* ═══════════════════════════════════════════════════════════
   4. Status / Select Calculations
   ═══════════════════════════════════════════════════════════ */
describe("calcValue — status (select)", () => {
  it("sets status", () => {
    expect(calcValue("ACTIVE", { field: "status", type: "set", value: "DRAFT" })).toBe("DRAFT");
  });
});

/* ═══════════════════════════════════════════════════════════
   5. Filter / Rule Matching Tests
   ═══════════════════════════════════════════════════════════ */
const sampleProduct = {
  id: "gid://shopify/Product/123",
  title: "Premium Cotton T-Shirt",
  vendor: "Acme Clothing",
  productType: "Apparel",
  status: "ACTIVE",
  tags: ["sale", "featured", "cotton"],
  variants: {
    edges: [
      {
        node: {
          id: "gid://shopify/ProductVariant/456",
          title: "Small / Red",
          price: "29.99",
          compareAtPrice: "39.99",
          sku: "TSHIRT-S-RED",
          barcode: "1234567890",
          inventoryQuantity: 50,
        },
      },
      {
        node: {
          id: "gid://shopify/ProductVariant/789",
          title: "Large / Blue",
          price: "34.99",
          compareAtPrice: null,
          sku: "TSHIRT-L-BLUE",
          barcode: "",
          inventoryQuantity: 0,
        },
      },
    ],
  },
};

describe("matchValue — string operators", () => {
  it("contains", () => {
    expect(matchValue("hello world", { operator: "contains", value: "world" })).toBe(true);
    expect(matchValue("hello world", { operator: "contains", value: "xyz" })).toBe(false);
  });

  it("not_contains", () => {
    expect(matchValue("hello world", { operator: "not_contains", value: "xyz" })).toBe(true);
    expect(matchValue("hello world", { operator: "not_contains", value: "hello" })).toBe(false);
  });

  it("equals (case insensitive for text)", () => {
    expect(matchValue("Hello", { field: "title", operator: "equals", value: "hello" })).toBe(true);
    expect(matchValue("Hello", { field: "title", operator: "equals", value: "world" })).toBe(false);
  });

  it("equals (numeric comparison for price)", () => {
    expect(matchValue("29.99", { field: "price", operator: "equals", value: "29.99" })).toBe(true);
    expect(matchValue("29.990", { field: "price", operator: "equals", value: "29.99" })).toBe(true);
  });

  it("starts_with", () => {
    expect(matchValue("TSHIRT-S-RED", { operator: "starts_with", value: "tshirt" })).toBe(true);
    expect(matchValue("TSHIRT-S-RED", { operator: "starts_with", value: "pants" })).toBe(false);
  });

  it("ends_with", () => {
    expect(matchValue("TSHIRT-S-RED", { operator: "ends_with", value: "red" })).toBe(true);
  });

  it("is_empty / is_not_empty", () => {
    expect(matchValue("", { operator: "is_empty" })).toBe(true);
    expect(matchValue("hello", { operator: "is_empty" })).toBe(false);
    expect(matchValue("hello", { operator: "is_not_empty" })).toBe(true);
    expect(matchValue("", { operator: "is_not_empty" })).toBeFalsy();
  });
});

describe("matchValue — numeric operators", () => {
  it("greater_than", () => {
    expect(matchValue("30", { operator: "greater_than", value: "25" })).toBe(true);
    expect(matchValue("20", { operator: "greater_than", value: "25" })).toBe(false);
  });

  it("less_than", () => {
    expect(matchValue("20", { operator: "less_than", value: "25" })).toBe(true);
    expect(matchValue("30", { operator: "less_than", value: "25" })).toBe(false);
  });

  it("greater_or_equal", () => {
    expect(matchValue("25", { operator: "greater_or_equal", value: "25" })).toBe(true);
    expect(matchValue("24.99", { operator: "greater_or_equal", value: "25" })).toBe(false);
  });

  it("less_or_equal", () => {
    expect(matchValue("25", { operator: "less_or_equal", value: "25" })).toBe(true);
    expect(matchValue("25.01", { operator: "less_or_equal", value: "25" })).toBe(false);
  });

  it("between", () => {
    expect(matchValue("15", { operator: "between", value: "10", value2: "20" })).toBe(true);
    expect(matchValue("10", { operator: "between", value: "10", value2: "20" })).toBe(true);
    expect(matchValue("20", { operator: "between", value: "10", value2: "20" })).toBe(true);
    expect(matchValue("25", { operator: "between", value: "10", value2: "20" })).toBe(false);
  });

  it("unknown operator defaults to true", () => {
    expect(matchValue("anything", { operator: "unknown_op", value: "x" })).toBe(true);
  });
});

describe("evaluateFilter — product-level fields", () => {
  it("matches title contains", () => {
    expect(evaluateFilter(sampleProduct, { field: "title", operator: "contains", value: "Cotton" })).toBe(true);
  });

  it("matches vendor equals", () => {
    expect(evaluateFilter(sampleProduct, { field: "vendor", operator: "equals", value: "acme clothing" })).toBe(true);
  });

  it("matches tags contains", () => {
    expect(evaluateFilter(sampleProduct, { field: "tags", operator: "contains", value: "sale" })).toBe(true);
    expect(evaluateFilter(sampleProduct, { field: "tags", operator: "contains", value: "luxury" })).toBe(false);
  });

  it("matches status equals", () => {
    expect(evaluateFilter(sampleProduct, { field: "status", operator: "equals", value: "active" })).toBe(true);
  });
});

describe("evaluateFilter — variant-level fields", () => {
  it("matches price greater_than (any variant)", () => {
    expect(evaluateFilter(sampleProduct, { field: "price", operator: "greater_than", value: "30" })).toBe(true); // 34.99 > 30
  });

  it("matches price less_than (any variant)", () => {
    expect(evaluateFilter(sampleProduct, { field: "price", operator: "less_than", value: "30" })).toBe(true); // 29.99 < 30
  });

  it("matches sku starts_with (any variant)", () => {
    expect(evaluateFilter(sampleProduct, { field: "sku", operator: "starts_with", value: "tshirt" })).toBe(true);
  });

  it("matches barcode is_empty (any variant has empty barcode)", () => {
    expect(evaluateFilter(sampleProduct, { field: "barcode", operator: "is_empty" })).toBe(true); // variant 789 has empty barcode
  });

  it("matches inventoryQuantity equals (via string match on variant field)", () => {
    // inventoryQuantity is in the evaluateFilter variant fields list
    // but the variant data uses inventoryQuantity as a number, matchValue receives String(0) = "0"
    expect(evaluateFilter(sampleProduct, { field: "inventoryQuantity", operator: "equals", value: "50" })).toBe(true); // variant 456 has 50
  });
});

/* ═══════════════════════════════════════════════════════════
   6. Plan Limit Tests
   ═══════════════════════════════════════════════════════════ */
describe("canPerformEdit — plan limits", () => {
  it("free plan allows up to 3 edits", () => {
    expect(canPerformEdit("free", 0)).toBe(true);
    expect(canPerformEdit("free", 2)).toBe(true);
    expect(canPerformEdit("free", 3)).toBe(false);
    expect(canPerformEdit("free", 10)).toBe(false);
  });

  it("pro plan allows up to 50 edits", () => {
    expect(canPerformEdit("pro", 0)).toBe(true);
    expect(canPerformEdit("pro", 49)).toBe(true);
    expect(canPerformEdit("pro", 50)).toBe(false);
  });

  it("plus plan allows unlimited edits", () => {
    expect(canPerformEdit("plus", 0)).toBe(true);
    expect(canPerformEdit("plus", 999999)).toBe(true);
  });

  it("unknown plan defaults to free limits", () => {
    expect(canPerformEdit("unknown", 3)).toBe(false);
  });
});

describe("shouldResetMonthlyEdits", () => {
  it("returns false if same month", () => {
    const now = new Date();
    expect(shouldResetMonthlyEdits(now.toISOString())).toBe(false);
  });

  it("returns true if different month", () => {
    const lastMonth = new Date();
    lastMonth.setMonth(lastMonth.getMonth() - 1);
    expect(shouldResetMonthlyEdits(lastMonth.toISOString())).toBe(true);
  });

  it("returns true if different year", () => {
    const lastYear = new Date();
    lastYear.setFullYear(lastYear.getFullYear() - 1);
    expect(shouldResetMonthlyEdits(lastYear.toISOString())).toBe(true);
  });
});

describe("PLAN_LIMITS structure", () => {
  it("has all three plans defined", () => {
    expect(PLAN_LIMITS).toHaveProperty("free");
    expect(PLAN_LIMITS).toHaveProperty("pro");
    expect(PLAN_LIMITS).toHaveProperty("plus");
  });

  it("free plan has correct limits", () => {
    expect(PLAN_LIMITS.free.editsPerMonth).toBe(3);
    expect(PLAN_LIMITS.free.automations).toBe(false);
    expect(PLAN_LIMITS.free.scheduled).toBe(false);
  });

  it("pro plan has correct limits", () => {
    expect(PLAN_LIMITS.pro.editsPerMonth).toBe(50);
    expect(PLAN_LIMITS.pro.automations).toBe(false);
  });

  it("plus plan has unlimited edits and automations", () => {
    expect(PLAN_LIMITS.plus.editsPerMonth).toBe(Infinity);
    expect(PLAN_LIMITS.plus.automations).toBe(true);
    expect(PLAN_LIMITS.plus.scheduled).toBe(true);
  });
});

/* ═══════════════════════════════════════════════════════════
   7. Modification Builder Tests
   ═══════════════════════════════════════════════════════════ */
describe("buildModifications", () => {
  it("builds variant-level price update", () => {
    const actions = [{ field: "price", type: "increase_percent", value: "10" }];
    const { productInput, variantUpdates } = buildModifications(sampleProduct, actions);

    expect(Object.keys(productInput)).toHaveLength(0);
    expect(variantUpdates).toHaveLength(2);
    // 29.99 * 1.1 = 32.989 → 32.99
    expect(variantUpdates[0].price).toBe("32.99");
    // 34.99 * 1.1 = 38.489 → 38.49
    expect(variantUpdates[1].price).toBe("38.49");
  });

  it("builds product-level title update", () => {
    const actions = [{ field: "title", type: "prepend", value: "[SALE] " }];
    const { productInput, variantUpdates } = buildModifications(sampleProduct, actions);

    expect(productInput.title).toBe("[SALE] Premium Cotton T-Shirt");
    expect(variantUpdates).toHaveLength(0);
  });

  it("builds product-level tag update", () => {
    const actions = [{ field: "tags", type: "add", value: "summer" }];
    const { productInput, variantUpdates } = buildModifications(sampleProduct, actions);

    expect(productInput.tags).toContain("summer");
    expect(productInput.tags).toContain("sale");
    expect(variantUpdates).toHaveLength(0);
  });

  it("builds mixed product + variant updates", () => {
    const actions = [
      { field: "title", type: "append", value: " - CLEARANCE" },
      { field: "price", type: "decrease_percent", value: "20" },
    ];
    const { productInput, variantUpdates } = buildModifications(sampleProduct, actions);

    expect(productInput.title).toBe("Premium Cotton T-Shirt - CLEARANCE");
    expect(variantUpdates).toHaveLength(2);
    // 29.99 * 0.8 = 23.992 → 23.99
    expect(variantUpdates[0].price).toBe("23.99");
  });

  it("returns empty when no valid actions", () => {
    const actions = [{ field: "nonexistent", type: "exact", value: "5" }];
    const { productInput, variantUpdates } = buildModifications(sampleProduct, actions);

    expect(Object.keys(productInput)).toHaveLength(0);
    expect(variantUpdates).toHaveLength(0);
  });

  it("handles rounding in variant updates", () => {
    const actions = [{ field: "price", type: "increase_percent", value: "15", rounding: "99" }];
    const { variantUpdates } = buildModifications(sampleProduct, actions);

    // 29.99 * 1.15 = 34.4885 → floor(34.4885) + 0.99 = 34.99
    expect(variantUpdates[0].price).toBe("34.99");
    // 34.99 * 1.15 = 40.2385 → floor(40.2385) + 0.99 = 40.99
    expect(variantUpdates[1].price).toBe("40.99");
  });

  it("handles status change", () => {
    const actions = [{ field: "status", type: "set", value: "DRAFT" }];
    const { productInput } = buildModifications(sampleProduct, actions);
    expect(productInput.status).toBe("DRAFT");
  });
});

/* ═══════════════════════════════════════════════════════════
   8. Edge Cases
   ═══════════════════════════════════════════════════════════ */
describe("Edge cases", () => {
  it("handles product with no variants", () => {
    const emptyProduct = { ...sampleProduct, variants: { edges: [] } };
    const actions = [{ field: "price", type: "exact", value: "10" }];
    const { variantUpdates } = buildModifications(emptyProduct, actions);
    expect(variantUpdates).toHaveLength(0);
  });

  it("handles product with undefined variants", () => {
    const noVariants = { ...sampleProduct, variants: undefined };
    const actions = [{ field: "price", type: "exact", value: "10" }];
    const { variantUpdates } = buildModifications(noVariants, actions);
    expect(variantUpdates).toHaveLength(0);
  });

  it("handles very large price values", () => {
    const result = calcValue("999999999.99", { field: "price", type: "increase_percent", value: "100" });
    expect(parseFloat(result)).toBe(1999999999.98);
  });

  it("handles very small percentage changes", () => {
    const result = calcValue("100.00", { field: "price", type: "increase_percent", value: "0.01" });
    expect(result).toBe("100.01");
  });

  it("multiple conditions must all match (AND logic)", () => {
    const conditions = [
      { field: "title", operator: "contains", value: "Cotton" },
      { field: "price", operator: "greater_than", value: "25" },
      { field: "vendor", operator: "equals", value: "acme clothing" },
    ];
    const allMatch = conditions.every((c) => evaluateFilter(sampleProduct, c));
    expect(allMatch).toBe(true);

    const conditionsWithFail = [
      ...conditions,
      { field: "title", operator: "contains", value: "Silk" },
    ];
    const notAllMatch = conditionsWithFail.every((c) => evaluateFilter(sampleProduct, c));
    expect(notAllMatch).toBe(false);
  });
});
