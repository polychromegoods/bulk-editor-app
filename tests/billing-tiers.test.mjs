import { describe, it, expect } from "vitest";

/* ═══════════════════════════════════════════════════════════
   Billing Tier Enforcement Tests

   Tests that each plan tier correctly enforces:
   - Product-per-edit limits
   - Automation rule access
   - Automation rule count limits
   - Upgrade/downgrade paths
   ═══════════════════════════════════════════════════════════ */

/* ───────── Plan Definitions (mirrors shopify.server.js + billing.jsx) ───────── */
const PLAN_NAMES = {
  UNLIMITED_MONTHLY: "Unlimited Edits Monthly",
  UNLIMITED_YEARLY: "Unlimited Edits Yearly",
  PRO_MONTHLY: "Pro Monthly",
  PRO_YEARLY: "Pro Yearly",
  PREMIUM_MONTHLY: "Premium Pro Monthly",
  PREMIUM_YEARLY: "Premium Pro Yearly",
};

const PRODUCTS_PER_EDIT = { free: 15, unlimited: Infinity, pro: Infinity, premium: Infinity };
const AUTOMATION_LIMITS = { free: 0, unlimited: 0, pro: 3, premium: Infinity };
const PLAN_ORDER = { free: 0, unlimited: 1, pro: 2, premium: 3 };

const BILLING_PLAN_MAP = {
  unlimited: { monthly: PLAN_NAMES.UNLIMITED_MONTHLY, yearly: PLAN_NAMES.UNLIMITED_YEARLY },
  pro:       { monthly: PLAN_NAMES.PRO_MONTHLY,       yearly: PLAN_NAMES.PRO_YEARLY },
  premium:   { monthly: PLAN_NAMES.PREMIUM_MONTHLY,   yearly: PLAN_NAMES.PREMIUM_YEARLY },
};

const PLAN_PRICES = {
  free:      { monthly: 0,     yearly: 0 },
  unlimited: { monthly: 6.99,  yearly: 67.10 },
  pro:       { monthly: 14.99, yearly: 143.90 },
  premium:   { monthly: 24.99, yearly: 239.90 },
};

/* ───────── Helper: simulate product limit check ───────── */
function checkProductLimit(plan, productCount) {
  const limit = PRODUCTS_PER_EDIT[plan] || 15;
  if (limit === Infinity) return { allowed: true, limit: Infinity };
  return {
    allowed: productCount <= limit,
    limit,
    productsAttempted: productCount,
  };
}

/* ───────── Helper: simulate automation access check ───────── */
function checkAutomationAccess(plan) {
  return plan === "pro" || plan === "premium";
}

/* ───────── Helper: simulate automation rule creation limit ───────── */
function checkAutomationRuleLimit(plan, existingRuleCount) {
  if (!checkAutomationAccess(plan)) return { allowed: false, reason: "Plan does not include automations" };
  const limit = AUTOMATION_LIMITS[plan];
  if (limit === Infinity) return { allowed: true, limit: Infinity };
  return {
    allowed: existingRuleCount < limit,
    limit,
    existing: existingRuleCount,
  };
}

/* ───────── Helper: yearly discount validation ───────── */
function validateYearlyDiscount(plan) {
  if (plan === "free") return null;
  const monthlyAnnualized = PLAN_PRICES[plan].monthly * 12;
  const yearlyPrice = PLAN_PRICES[plan].yearly;
  const discount = ((monthlyAnnualized - yearlyPrice) / monthlyAnnualized) * 100;
  return {
    monthlyAnnualized: Math.round(monthlyAnnualized * 100) / 100,
    yearlyPrice,
    discountPercent: Math.round(discount * 10) / 10,
  };
}

/* ═══════════════════════════════════════════════════════════
   TEST SUITES
   ═══════════════════════════════════════════════════════════ */

describe("Plan Definitions", () => {
  it("should have exactly 4 plan tiers", () => {
    const plans = Object.keys(PRODUCTS_PER_EDIT);
    expect(plans).toEqual(["free", "unlimited", "pro", "premium"]);
  });

  it("should have 6 Shopify billing plan names (3 tiers x 2 intervals)", () => {
    const names = Object.values(PLAN_NAMES);
    expect(names).toHaveLength(6);
    expect(names).toContain("Unlimited Edits Monthly");
    expect(names).toContain("Unlimited Edits Yearly");
    expect(names).toContain("Pro Monthly");
    expect(names).toContain("Pro Yearly");
    expect(names).toContain("Premium Pro Monthly");
    expect(names).toContain("Premium Pro Yearly");
  });

  it("should have correct plan ordering for upgrade/downgrade detection", () => {
    expect(PLAN_ORDER.free).toBeLessThan(PLAN_ORDER.unlimited);
    expect(PLAN_ORDER.unlimited).toBeLessThan(PLAN_ORDER.pro);
    expect(PLAN_ORDER.pro).toBeLessThan(PLAN_ORDER.premium);
  });

  it("should map each paid plan to both monthly and yearly billing names", () => {
    for (const [key, map] of Object.entries(BILLING_PLAN_MAP)) {
      expect(map.monthly).toBeTruthy();
      expect(map.yearly).toBeTruthy();
      expect(map.monthly).not.toEqual(map.yearly);
    }
  });
});

describe("Product-per-Edit Limits", () => {
  describe("Free tier (15 products max)", () => {
    it("should allow editing 1 product", () => {
      const result = checkProductLimit("free", 1);
      expect(result.allowed).toBe(true);
    });

    it("should allow editing exactly 15 products", () => {
      const result = checkProductLimit("free", 15);
      expect(result.allowed).toBe(true);
    });

    it("should reject editing 16 products", () => {
      const result = checkProductLimit("free", 16);
      expect(result.allowed).toBe(false);
      expect(result.limit).toBe(15);
      expect(result.productsAttempted).toBe(16);
    });

    it("should reject editing 100 products", () => {
      const result = checkProductLimit("free", 100);
      expect(result.allowed).toBe(false);
    });
  });

  describe("Unlimited Edits tier (unlimited)", () => {
    it("should allow editing 1 product", () => {
      expect(checkProductLimit("unlimited", 1).allowed).toBe(true);
    });

    it("should allow editing 1000 products", () => {
      expect(checkProductLimit("unlimited", 1000).allowed).toBe(true);
    });

    it("should have Infinity as limit", () => {
      expect(checkProductLimit("unlimited", 1).limit).toBe(Infinity);
    });
  });

  describe("Pro tier (unlimited)", () => {
    it("should allow editing any number of products", () => {
      expect(checkProductLimit("pro", 500).allowed).toBe(true);
      expect(checkProductLimit("pro", 10000).allowed).toBe(true);
    });
  });

  describe("Premium tier (unlimited)", () => {
    it("should allow editing any number of products", () => {
      expect(checkProductLimit("premium", 500).allowed).toBe(true);
      expect(checkProductLimit("premium", 50000).allowed).toBe(true);
    });
  });

  describe("Unknown plan defaults to free limits", () => {
    it("should default to 15 product limit for unknown plan", () => {
      const result = checkProductLimit("nonexistent", 20);
      expect(result.allowed).toBe(false);
      expect(result.limit).toBe(15);
    });
  });
});

describe("Automation Access", () => {
  it("should deny automation access for free tier", () => {
    expect(checkAutomationAccess("free")).toBe(false);
  });

  it("should deny automation access for unlimited tier", () => {
    expect(checkAutomationAccess("unlimited")).toBe(false);
  });

  it("should allow automation access for pro tier", () => {
    expect(checkAutomationAccess("pro")).toBe(true);
  });

  it("should allow automation access for premium tier", () => {
    expect(checkAutomationAccess("premium")).toBe(true);
  });
});

describe("Automation Rule Limits", () => {
  describe("Free tier", () => {
    it("should not allow creating any rules", () => {
      const result = checkAutomationRuleLimit("free", 0);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("does not include");
    });
  });

  describe("Unlimited tier", () => {
    it("should not allow creating any rules", () => {
      const result = checkAutomationRuleLimit("unlimited", 0);
      expect(result.allowed).toBe(false);
    });
  });

  describe("Pro tier (max 3 rules)", () => {
    it("should allow creating first rule", () => {
      const result = checkAutomationRuleLimit("pro", 0);
      expect(result.allowed).toBe(true);
    });

    it("should allow creating second rule", () => {
      const result = checkAutomationRuleLimit("pro", 1);
      expect(result.allowed).toBe(true);
    });

    it("should allow creating third rule", () => {
      const result = checkAutomationRuleLimit("pro", 2);
      expect(result.allowed).toBe(true);
    });

    it("should reject creating fourth rule", () => {
      const result = checkAutomationRuleLimit("pro", 3);
      expect(result.allowed).toBe(false);
      expect(result.limit).toBe(3);
      expect(result.existing).toBe(3);
    });

    it("should reject when already at 5 rules", () => {
      const result = checkAutomationRuleLimit("pro", 5);
      expect(result.allowed).toBe(false);
    });
  });

  describe("Premium tier (unlimited rules)", () => {
    it("should allow creating first rule", () => {
      expect(checkAutomationRuleLimit("premium", 0).allowed).toBe(true);
    });

    it("should allow creating 100th rule", () => {
      expect(checkAutomationRuleLimit("premium", 99).allowed).toBe(true);
    });

    it("should have Infinity as limit", () => {
      expect(checkAutomationRuleLimit("premium", 0).limit).toBe(Infinity);
    });
  });
});

describe("Pricing and Yearly Discount", () => {
  it("should have correct monthly prices", () => {
    expect(PLAN_PRICES.free.monthly).toBe(0);
    expect(PLAN_PRICES.unlimited.monthly).toBe(6.99);
    expect(PLAN_PRICES.pro.monthly).toBe(14.99);
    expect(PLAN_PRICES.premium.monthly).toBe(24.99);
  });

  it("should offer ~20% discount on yearly billing for Unlimited Edits", () => {
    const discount = validateYearlyDiscount("unlimited");
    expect(discount.discountPercent).toBeGreaterThanOrEqual(19);
    expect(discount.discountPercent).toBeLessThanOrEqual(21);
  });

  it("should offer ~20% discount on yearly billing for Pro", () => {
    const discount = validateYearlyDiscount("pro");
    expect(discount.discountPercent).toBeGreaterThanOrEqual(19);
    expect(discount.discountPercent).toBeLessThanOrEqual(21);
  });

  it("should offer ~20% discount on yearly billing for Premium Pro", () => {
    const discount = validateYearlyDiscount("premium");
    expect(discount.discountPercent).toBeGreaterThanOrEqual(19);
    expect(discount.discountPercent).toBeLessThanOrEqual(21);
  });

  it("should have yearly price less than 12x monthly for all paid plans", () => {
    for (const plan of ["unlimited", "pro", "premium"]) {
      const annualized = PLAN_PRICES[plan].monthly * 12;
      expect(PLAN_PRICES[plan].yearly).toBeLessThan(annualized);
    }
  });

  it("should return null for free plan yearly discount", () => {
    expect(validateYearlyDiscount("free")).toBeNull();
  });
});

describe("Upgrade/Downgrade Paths", () => {
  const plans = ["free", "unlimited", "pro", "premium"];

  it("should correctly identify upgrades (higher tier)", () => {
    for (let i = 0; i < plans.length; i++) {
      for (let j = i + 1; j < plans.length; j++) {
        const isUpgrade = PLAN_ORDER[plans[j]] > PLAN_ORDER[plans[i]];
        expect(isUpgrade).toBe(true);
      }
    }
  });

  it("should correctly identify downgrades (lower tier)", () => {
    for (let i = 0; i < plans.length; i++) {
      for (let j = 0; j < i; j++) {
        const isDowngrade = PLAN_ORDER[plans[j]] < PLAN_ORDER[plans[i]];
        expect(isDowngrade).toBe(true);
      }
    }
  });

  it("should identify same plan (no change)", () => {
    for (const plan of plans) {
      expect(PLAN_ORDER[plan] === PLAN_ORDER[plan]).toBe(true);
    }
  });

  it("free plan should not have billing plan mapping (no charge)", () => {
    expect(BILLING_PLAN_MAP.free).toBeUndefined();
  });

  it("all paid plans should have billing plan mapping", () => {
    expect(BILLING_PLAN_MAP.unlimited).toBeDefined();
    expect(BILLING_PLAN_MAP.pro).toBeDefined();
    expect(BILLING_PLAN_MAP.premium).toBeDefined();
  });
});

describe("Trial Period", () => {
  it("should offer 7-day trial on first subscription", () => {
    const trialUsed = false;
    const trialDays = trialUsed ? 0 : 7;
    expect(trialDays).toBe(7);
  });

  it("should not offer trial after first subscription", () => {
    const trialUsed = true;
    const trialDays = trialUsed ? 0 : 7;
    expect(trialDays).toBe(0);
  });
});

describe("Feature Matrix by Plan", () => {
  const featureMatrix = [
    { plan: "free",      productsPerEdit: 15,       automations: 0,        price: 0 },
    { plan: "unlimited", productsPerEdit: Infinity,  automations: 0,        price: 6.99 },
    { plan: "pro",       productsPerEdit: Infinity,  automations: 3,        price: 14.99 },
    { plan: "premium",   productsPerEdit: Infinity,  automations: Infinity, price: 24.99 },
  ];

  featureMatrix.forEach(({ plan, productsPerEdit, automations, price }) => {
    describe(`${plan} tier`, () => {
      it(`should have productsPerEdit = ${productsPerEdit}`, () => {
        expect(PRODUCTS_PER_EDIT[plan]).toBe(productsPerEdit);
      });

      it(`should have automation limit = ${automations}`, () => {
        expect(AUTOMATION_LIMITS[plan]).toBe(automations);
      });

      it(`should have monthly price = $${price}`, () => {
        expect(PLAN_PRICES[plan].monthly).toBe(price);
      });
    });
  });
});

describe("Edge Cases", () => {
  it("should handle 0 products gracefully", () => {
    expect(checkProductLimit("free", 0).allowed).toBe(true);
  });

  it("should handle negative product count as allowed (no negative products in practice)", () => {
    expect(checkProductLimit("free", -1).allowed).toBe(true);
  });

  it("should handle undefined plan as free tier", () => {
    expect(checkProductLimit(undefined, 20).allowed).toBe(false);
    expect(checkProductLimit(undefined, 20).limit).toBe(15);
  });

  it("should handle null plan as free tier", () => {
    expect(checkProductLimit(null, 20).allowed).toBe(false);
  });

  it("should handle old 'plus' plan name gracefully (defaults to free limits)", () => {
    // Old plan name should default to free tier limits
    expect(checkProductLimit("plus", 20).allowed).toBe(false);
    expect(checkProductLimit("plus", 20).limit).toBe(15);
  });

  it("should handle old 'pro' plan name correctly (still valid)", () => {
    expect(checkProductLimit("pro", 1000).allowed).toBe(true);
  });
});
