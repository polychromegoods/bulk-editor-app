import { useState, useEffect } from "react";
import { useLoaderData, useFetcher, useNavigate } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

/* ───────── Plan Definitions ───────── */
const PLAN_LIMITS = {
  free:     { productsPerEdit: 15, editsPerMonth: Infinity, automations: 0 },
  unlimited:{ productsPerEdit: Infinity, editsPerMonth: Infinity, automations: 0 },
  pro:      { productsPerEdit: Infinity, editsPerMonth: Infinity, automations: 3 },
  premium:  { productsPerEdit: Infinity, editsPerMonth: Infinity, automations: Infinity },
};

/* Map Shopify Managed Pricing plan handles → internal plan keys */
const HANDLE_TO_PLAN = {
  "bulk-editor-free": "free",
  "bulk-editor-unlimited": "unlimited",
  "bulk-editor-pro": "pro",
  "bulk-editor-premium": "premium",
};

const PLAN_DETAILS = [
  {
    key: "free",
    name: "Free",
    monthlyPrice: 0,
    yearlyPrice: 0,
    description: "Get started with basic bulk editing",
    features: [
      { text: "Up to 15 products per edit", included: true },
      { text: "Unlimited edits per month", included: true },
      { text: "All filter & modification types", included: true },
      { text: "Price history & undo", included: true },
      { text: "Live preview", included: true },
      { text: "Unlimited products per edit", included: false },
      { text: "Automation rules", included: false },
      { text: "Priority support", included: false },
    ],
    highlight: false,
  },
  {
    key: "unlimited",
    name: "Unlimited Edits",
    monthlyPrice: 6.99,
    yearlyPrice: 67.10,
    description: "Unlimited products per edit, no restrictions",
    features: [
      { text: "Unlimited products per edit", included: true },
      { text: "Unlimited edits per month", included: true },
      { text: "All filter & modification types", included: true },
      { text: "Price history & undo", included: true },
      { text: "Live preview", included: true },
      { text: "CSV export of history", included: true },
      { text: "Automation rules", included: false },
      { text: "Priority support", included: true },
    ],
    highlight: false,
  },
  {
    key: "pro",
    name: "Pro",
    monthlyPrice: 14.99,
    yearlyPrice: 143.90,
    description: "Automate your pricing with rules",
    features: [
      { text: "Unlimited products per edit", included: true },
      { text: "Unlimited edits per month", included: true },
      { text: "All filter & modification types", included: true },
      { text: "Price history & undo", included: true },
      { text: "Live preview", included: true },
      { text: "CSV export of history", included: true },
      { text: "Up to 3 automation rules", included: true },
      { text: "Priority support", included: true },
    ],
    highlight: true,
    badge: "Most Popular",
  },
  {
    key: "premium",
    name: "Premium Pro",
    monthlyPrice: 24.99,
    yearlyPrice: 239.90,
    description: "Unlimited power for high-volume stores",
    features: [
      { text: "Unlimited products per edit", included: true },
      { text: "Unlimited edits per month", included: true },
      { text: "All filter & modification types", included: true },
      { text: "Price history & undo", included: true },
      { text: "Live preview", included: true },
      { text: "CSV export of history", included: true },
      { text: "Unlimited automation rules", included: true },
      { text: "Priority support", included: true },
    ],
    highlight: false,
  },
];

/* Plan tier ordering for upgrade/downgrade detection */
const PLAN_ORDER = { free: 0, unlimited: 1, pro: 2, premium: 3 };

/* ───────── GraphQL query to read current subscription ───────── */
const CURRENT_SUBSCRIPTION_QUERY = `
  query {
    currentAppInstallation {
      activeSubscriptions {
        id
        name
        status
        currentPeriodEnd
        lineItems {
          id
          plan {
            pricingDetails {
              ... on AppRecurringPricing {
                interval
                price {
                  amount
                  currencyCode
                }
              }
            }
          }
        }
      }
      allSubscriptions(first: 5, sortKey: CREATED_AT) {
        nodes {
          id
          name
          status
          lineItems {
            plan {
              pricingDetails {
                ... on AppRecurringPricing {
                  interval
                  planHandle
                  price {
                    amount
                    currencyCode
                  }
                }
              }
            }
          }
        }
      }
    }
  }
`;

export const loader = async ({ request }) => {
  const { session, admin } = await authenticate.admin(request);
  const shop = session.shop;
  const storeHandle = shop.replace(".myshopify.com", "");

  // 1. Query Shopify GraphQL for current subscription
  let shopifyPlan = "free";
  let subscriptionStatus = null;
  let billingInterval = null;

  try {
    const response = await admin.graphql(CURRENT_SUBSCRIPTION_QUERY);
    const data = await response.json();
    const installation = data?.data?.currentAppInstallation;

    // Check active subscriptions first
    const activeSubs = installation?.activeSubscriptions || [];
    if (activeSubs.length > 0) {
      const activeSub = activeSubs[0];
      subscriptionStatus = activeSub.status;

      // Try to get planHandle from allSubscriptions (more reliable)
      const allSubs = installation?.allSubscriptions?.nodes || [];
      for (const sub of allSubs) {
        if (sub.status === "ACTIVE" || sub.status === "ACCEPTED") {
          const lineItem = sub.lineItems?.[0];
          const pricingDetails = lineItem?.plan?.pricingDetails;
          const handle = pricingDetails?.planHandle;
          if (handle && HANDLE_TO_PLAN[handle]) {
            shopifyPlan = HANDLE_TO_PLAN[handle];
            billingInterval = pricingDetails?.interval === "ANNUAL" ? "yearly" : "monthly";
            break;
          }
        }
      }

      // Fallback: infer plan from price if no planHandle
      if (shopifyPlan === "free" && activeSubs.length > 0) {
        const lineItem = activeSub.lineItems?.[0];
        const price = parseFloat(lineItem?.plan?.pricingDetails?.price?.amount || "0");
        if (price >= 24) shopifyPlan = "premium";
        else if (price >= 14) shopifyPlan = "pro";
        else if (price >= 6) shopifyPlan = "unlimited";
        billingInterval = lineItem?.plan?.pricingDetails?.interval === "ANNUAL" ? "yearly" : "monthly";
      }
    }

    console.log(`[Billing] Shop ${shop}: Shopify plan = ${shopifyPlan}, status = ${subscriptionStatus}, interval = ${billingInterval}`);
  } catch (err) {
    console.error("[Billing] Failed to query Shopify subscription:", err.message);
  }

  // 2. Sync with our database
  let shopPlan = await prisma.shopPlan.findUnique({ where: { shop } });
  if (!shopPlan) {
    shopPlan = await prisma.shopPlan.create({ data: { shop, plan: shopifyPlan } });
  } else if (shopPlan.plan !== shopifyPlan && shopifyPlan !== "free") {
    // Shopify is the source of truth — sync if different (unless promo is active)
    if (!shopPlan.promoExpiresAt || new Date(shopPlan.promoExpiresAt) < new Date()) {
      shopPlan = await prisma.shopPlan.update({
        where: { shop },
        data: { plan: shopifyPlan },
      });
    }
  }

  // Check if promo has expired
  let promoActive = false;
  let promoExpiresAt = null;
  if (shopPlan.promoCode && shopPlan.promoExpiresAt) {
    if (new Date(shopPlan.promoExpiresAt) > new Date()) {
      // Promo still active — ensure plan matches promo level
      promoActive = true;
      promoExpiresAt = shopPlan.promoExpiresAt;
      if (shopPlan.plan !== shopPlan.promoPlan) {
        shopPlan = await prisma.shopPlan.update({
          where: { shop },
          data: { plan: shopPlan.promoPlan },
        });
      }
    } else {
      // Promo expired — clear promo fields and revert to Shopify plan
      console.log(`[Promo] Promo expired for ${shop}, reverting to Shopify plan: ${shopifyPlan}`);
      shopPlan = await prisma.shopPlan.update({
        where: { shop },
        data: {
          plan: shopifyPlan,
          promoCode: null,
          promoPlan: null,
          promoExpiresAt: null,
        },
      });
    }
  }

  // Reset monthly edits if we're in a new month
  const now = new Date();
  const resetDate = new Date(shopPlan.monthlyEditReset);
  if (now.getMonth() !== resetDate.getMonth() || now.getFullYear() !== resetDate.getFullYear()) {
    shopPlan = await prisma.shopPlan.update({
      where: { shop },
      data: { monthlyEdits: 0, monthlyEditReset: now },
    });
  }

  const plan = shopPlan.plan || "free";
  const limits = PLAN_LIMITS[plan] || PLAN_LIMITS.free;

  return {
    shop,
    storeHandle,
    currentPlan: plan,
    monthlyEdits: shopPlan.monthlyEdits,
    productsPerEdit: limits.productsPerEdit,
    automationLimit: limits.automations,
    subscriptionStatus,
    billingInterval,
    promoActive,
    promoExpiresAt: promoExpiresAt ? new Date(promoExpiresAt).toISOString() : null,
    promoCode: shopPlan.promoCode || null,
    isDev: process.env.NODE_ENV !== "production",
  };
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const intent = formData.get("intent");

  /* ── Test mode: directly switch plans in the database ── */
  if (intent === "test-switch") {
    const planKey = formData.get("plan");
    if (!["free", "unlimited", "pro", "premium"].includes(planKey)) {
      return { error: "Invalid plan" };
    }
    await prisma.shopPlan.upsert({
      where: { shop },
      update: { plan: planKey },
      create: { shop, plan: planKey },
    });
    return { success: true, testSwitch: planKey };
  }

  /* ── Test mode: reset monthly edit counter ── */
  if (intent === "test-reset") {
    await prisma.shopPlan.upsert({
      where: { shop },
      update: { monthlyEdits: 0, monthlyEditReset: new Date() },
      create: { shop },
    });
    return { success: true, testReset: true };
  }

  /* ── Promo code redemption ── */
  if (intent === "redeem-promo") {
    const code = (formData.get("promoCode") || "").trim().toUpperCase();
    if (!code) return { error: "Please enter a promo code" };

    try {
      // Look up the promo code
      const promo = await prisma.promoCode.findUnique({ where: { code } });
      if (!promo) return { error: "Invalid promo code" };
      if (!promo.active) return { error: "This promo code is no longer active" };
      if (promo.usedCount >= promo.maxUses) return { error: "This promo code has reached its maximum uses" };

      // Check if shop already used this code
      const existing = await prisma.shopPlan.findUnique({ where: { shop } });
      if (existing?.promoCode === code) return { error: "You've already redeemed this promo code" };

      // Calculate expiration
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + promo.durationDays);

      // Apply promo to shop
      await prisma.shopPlan.upsert({
        where: { shop },
        update: {
          plan: promo.plan,
          promoCode: code,
          promoPlan: promo.plan,
          promoExpiresAt: expiresAt,
        },
        create: {
          shop,
          plan: promo.plan,
          promoCode: code,
          promoPlan: promo.plan,
          promoExpiresAt: expiresAt,
        },
      });

      // Increment usage count
      await prisma.promoCode.update({
        where: { code },
        data: { usedCount: { increment: 1 } },
      });

      console.log(`[Promo] Shop ${shop} redeemed code ${code} for ${promo.plan} plan until ${expiresAt.toISOString()}`);
      return { success: true, promoRedeemed: true, promoPlan: promo.plan, promoExpires: expiresAt.toISOString() };
    } catch (err) {
      console.error("[Promo] Redemption error:", err);
      return { error: "Failed to redeem promo code. Please try again." };
    }
  }

  /* ── Cancel: downgrade to free in our database ── */
  if (intent === "cancel") {
    try {
      await prisma.shopPlan.upsert({
        where: { shop },
        update: { plan: "free", chargeId: null, monthlyEdits: 0, monthlyEditReset: new Date() },
        create: { shop, plan: "free" },
      });
      return { success: true, cancelled: true };
    } catch (err) {
      console.error("Cancel error:", err);
      return { error: err.message || "Failed to cancel subscription" };
    }
  }

  return { error: "Unknown intent" };
};

export default function Billing() {
  const {
    shop, storeHandle, currentPlan, monthlyEdits, productsPerEdit,
    automationLimit, subscriptionStatus, billingInterval: currentInterval,
    promoActive, promoExpiresAt, promoCode: activePromoCode,
    isDev,
  } = useLoaderData();
  const fetcher = useFetcher();
  const navigate = useNavigate();
  const shopify = useAppBridge();
  const [showCancelDialog, setShowCancelDialog] = useState(false);
  const [showTestMode, setShowTestMode] = useState(false);
  const [promoInput, setPromoInput] = useState("");
  const [showPromoInput, setShowPromoInput] = useState(false);
  const [displayInterval, setDisplayInterval] = useState("monthly");

  const isSubmitting = fetcher.state !== "idle";

  // Shopify-hosted plan selection page URL
  const planSelectionUrl = `https://admin.shopify.com/store/${storeHandle}/charges/bulk-editor-prox/pricing_plans`;

  useEffect(() => {
    if (fetcher.data?.cancelled) {
      shopify.toast.show("To complete the downgrade, please change your plan on the Shopify billing page.");
      // Open Shopify's plan selection page so they can switch to Free
      window.open(planSelectionUrl, "_top");
    }
    if (fetcher.data?.testSwitch) {
      shopify.toast.show(`Switched to ${fetcher.data.testSwitch} plan (test mode)`);
      navigate("/app/billing", { replace: true });
    }
    if (fetcher.data?.testReset) {
      shopify.toast.show("Monthly edit counter reset to 0");
      navigate("/app/billing", { replace: true });
    }
    if (fetcher.data?.promoRedeemed) {
      shopify.toast.show(`Promo code applied! ${fetcher.data.promoPlan.charAt(0).toUpperCase() + fetcher.data.promoPlan.slice(1)} plan active until ${new Date(fetcher.data.promoExpires).toLocaleDateString()}`);
      setPromoInput("");
      setShowPromoInput(false);
      navigate("/app/billing", { replace: true });
    }
    if (fetcher.data?.error) {
      shopify.toast.show("Error: " + fetcher.data.error, { isError: true });
    }
  }, [fetcher.data]);

  const handleChangePlan = () => {
    // Redirect to Shopify's hosted plan selection page
    window.open(planSelectionUrl, "_top");
  };

  const handleTestSwitch = (planKey) => {
    fetcher.submit({ intent: "test-switch", plan: planKey }, { method: "POST" });
  };

  const handleTestReset = () => {
    fetcher.submit({ intent: "test-reset" }, { method: "POST" });
  };

  const formatPrice = (plan) => {
    if (plan.monthlyPrice === 0) return { display: "$0", detail: "forever" };
    if (displayInterval === "yearly") {
      const yearlyMonthly = (plan.yearlyPrice / 12).toFixed(2);
      return { display: `$${yearlyMonthly}`, detail: "per month, billed yearly" };
    }
    return { display: `$${plan.monthlyPrice.toFixed(2)}`, detail: "per month" };
  };

  const currentPlanName = PLAN_DETAILS.find(p => p.key === currentPlan)?.name || "Free";

  return (
    <s-page title="Plans & Billing" subtitle="Choose the plan that's right for your store">
      {/* Current Plan Status */}
      <s-section>
        <s-box padding="base">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "16px" }}>
            <div>
              <div style={{ fontSize: "13px", color: "#637381", marginBottom: "4px" }}>Current Plan</div>
              <div style={{ fontSize: "24px", fontWeight: 800, color: "#202223" }}>
                {currentPlanName}
                {promoActive && (
                  <span style={{
                    fontSize: "12px",
                    fontWeight: 700,
                    backgroundColor: "#9333ea",
                    color: "white",
                    padding: "3px 10px",
                    borderRadius: "12px",
                    marginLeft: "10px",
                    verticalAlign: "middle",
                  }}>
                    PROMO
                  </span>
                )}
              </div>
              {promoActive && promoExpiresAt && (
                <div style={{ fontSize: "12px", color: "#9333ea", marginTop: "2px", fontWeight: 600 }}>
                  Promo active until {new Date(promoExpiresAt).toLocaleDateString()}
                </div>
              )}
              {subscriptionStatus && !promoActive && (
                <div style={{ fontSize: "12px", color: "#637381", marginTop: "2px" }}>
                  Status: {subscriptionStatus}{currentInterval ? ` (${currentInterval})` : ""}
                </div>
              )}
            </div>
            <div style={{ textAlign: "right" }}>
              <div style={{ fontSize: "13px", color: "#637381", marginBottom: "4px" }}>
                Products per edit: <strong>{productsPerEdit === Infinity ? "Unlimited" : productsPerEdit}</strong>
              </div>
              <div style={{ fontSize: "13px", color: "#637381" }}>
                Automation rules: <strong>{automationLimit === Infinity ? "Unlimited" : automationLimit === 0 ? "None" : `Up to ${automationLimit}`}</strong>
              </div>
            </div>
          </div>
        </s-box>
      </s-section>

      {/* Promo Code Section */}
      <s-section>
        <s-box padding="base">
          <div style={{ textAlign: "center", padding: "8px 0" }}>
            {!promoActive ? (
              <>
                {!showPromoInput ? (
                  <button
                    onClick={() => setShowPromoInput(true)}
                    style={{
                      padding: "8px 20px",
                      borderRadius: "8px",
                      border: "1px dashed #9333ea",
                      backgroundColor: "transparent",
                      color: "#9333ea",
                      fontWeight: 600,
                      fontSize: "13px",
                      cursor: "pointer",
                    }}
                  >
                    Have a promo code?
                  </button>
                ) : (
                  <div style={{ display: "flex", justifyContent: "center", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                    <input
                      type="text"
                      value={promoInput}
                      onChange={(e) => setPromoInput(e.target.value.toUpperCase())}
                      placeholder="Enter promo code"
                      maxLength={20}
                      style={{
                        padding: "10px 16px",
                        borderRadius: "8px",
                        border: "2px solid #9333ea",
                        fontSize: "14px",
                        fontWeight: 700,
                        letterSpacing: "1px",
                        textAlign: "center",
                        width: "200px",
                        textTransform: "uppercase",
                        outline: "none",
                      }}
                    />
                    <button
                      onClick={() => {
                        if (promoInput.trim()) {
                          fetcher.submit(
                            { intent: "redeem-promo", promoCode: promoInput.trim() },
                            { method: "POST" }
                          );
                        }
                      }}
                      disabled={isSubmitting || !promoInput.trim()}
                      style={{
                        padding: "10px 24px",
                        borderRadius: "8px",
                        border: "none",
                        backgroundColor: "#9333ea",
                        color: "white",
                        fontWeight: 700,
                        fontSize: "14px",
                        cursor: promoInput.trim() ? "pointer" : "not-allowed",
                        opacity: isSubmitting || !promoInput.trim() ? 0.6 : 1,
                      }}
                    >
                      {isSubmitting ? "Applying..." : "Apply"}
                    </button>
                    <button
                      onClick={() => { setShowPromoInput(false); setPromoInput(""); }}
                      style={{
                        padding: "10px 16px",
                        borderRadius: "8px",
                        border: "1px solid #c4cdd5",
                        backgroundColor: "white",
                        color: "#637381",
                        fontSize: "13px",
                        cursor: "pointer",
                      }}
                    >
                      Cancel
                    </button>
                  </div>
                )}
              </>
            ) : (
              <div style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "8px",
                padding: "8px 16px",
                borderRadius: "8px",
                backgroundColor: "#f3e8ff",
                border: "1px solid #d8b4fe",
              }}>
                <span style={{ fontSize: "13px", color: "#9333ea", fontWeight: 600 }}>
                  Promo code <strong>{activePromoCode}</strong> applied
                </span>
                <span style={{ fontSize: "12px", color: "#7c3aed" }}>
                  • Expires {new Date(promoExpiresAt).toLocaleDateString()}
                </span>
              </div>
            )}
          </div>
        </s-box>
      </s-section>

      {/* Test Mode Panel — dev stores only */}
      {isDev && (
        <s-section>
          <s-box padding="base">
            <div style={{
              border: "2px dashed #ffc453",
              borderRadius: "12px",
              padding: "16px",
              backgroundColor: "#fffbf0",
            }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: showTestMode ? "12px" : "0" }}>
                <div>
                  <span style={{ fontSize: "14px", fontWeight: 700, color: "#b98900" }}>Test Mode</span>
                  <span style={{ fontSize: "12px", color: "#637381", marginLeft: "8px" }}>Switch plans instantly for development testing</span>
                </div>
                <button
                  onClick={() => setShowTestMode(!showTestMode)}
                  style={{
                    padding: "6px 16px",
                    borderRadius: "6px",
                    border: "1px solid #b98900",
                    backgroundColor: showTestMode ? "#b98900" : "white",
                    color: showTestMode ? "white" : "#b98900",
                    fontSize: "12px",
                    fontWeight: 600,
                    cursor: "pointer",
                  }}
                >
                  {showTestMode ? "Hide" : "Show"}
                </button>
              </div>
              {showTestMode && (
                <div>
                  <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", marginBottom: "12px" }}>
                    {["free", "unlimited", "pro", "premium"].map((p) => (
                      <button
                        key={p}
                        onClick={() => handleTestSwitch(p)}
                        disabled={isSubmitting || currentPlan === p}
                        style={{
                          padding: "8px 20px",
                          borderRadius: "8px",
                          border: currentPlan === p ? "2px solid #2c6ecb" : "1px solid #c4cdd5",
                          backgroundColor: currentPlan === p ? "#f0f5ff" : "white",
                          color: currentPlan === p ? "#2c6ecb" : "#202223",
                          fontWeight: 600,
                          fontSize: "13px",
                          cursor: currentPlan === p ? "default" : "pointer",
                          opacity: isSubmitting ? 0.6 : 1,
                        }}
                      >
                        {currentPlan === p ? `Current` : `${p.charAt(0).toUpperCase() + p.slice(1)}`}
                      </button>
                    ))}
                  </div>
                  <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                    <button
                      onClick={handleTestReset}
                      disabled={isSubmitting}
                      style={{
                        padding: "6px 16px",
                        borderRadius: "6px",
                        border: "1px solid #c4cdd5",
                        backgroundColor: "white",
                        fontSize: "12px",
                        cursor: "pointer",
                      }}
                    >
                      Reset Edit Counter to 0
                    </button>
                    <span style={{ fontSize: "11px", color: "#637381" }}>
                      Current: {monthlyEdits} edits used this month
                    </span>
                  </div>
                  <div style={{ fontSize: "11px", color: "#b98900", marginTop: "8px" }}>
                    Test mode only appears in development. It will not show in production.
                  </div>
                </div>
              )}
            </div>
          </s-box>
        </s-section>
      )}

      {/* Change Plan CTA */}
      <s-section>
        <s-box padding="base">
          <div style={{ textAlign: "center", padding: "8px 0" }}>
            <button
              onClick={handleChangePlan}
              style={{
                padding: "14px 40px",
                borderRadius: "10px",
                border: "none",
                backgroundColor: "#2c6ecb",
                color: "white",
                fontWeight: 700,
                fontSize: "16px",
                cursor: "pointer",
                transition: "all 0.15s",
              }}
            >
              {currentPlan === "free" ? "Upgrade Your Plan" : "Change Plan"}
            </button>
            <div style={{ fontSize: "12px", color: "#637381", marginTop: "8px" }}>
              You'll be taken to Shopify's plan selection page to manage your subscription.
            </div>
          </div>
        </s-box>
      </s-section>

      {/* Billing Interval Toggle (display only) */}
      <s-section>
        <s-box padding="base">
          <div style={{ display: "flex", justifyContent: "center", alignItems: "center", gap: "12px" }}>
            <span style={{
              fontSize: "14px",
              fontWeight: displayInterval === "monthly" ? 700 : 400,
              color: displayInterval === "monthly" ? "#202223" : "#637381",
            }}>
              Monthly
            </span>
            <button
              onClick={() => setDisplayInterval(displayInterval === "monthly" ? "yearly" : "monthly")}
              style={{
                width: "52px",
                height: "28px",
                borderRadius: "14px",
                border: "none",
                backgroundColor: displayInterval === "yearly" ? "#2c6ecb" : "#c4cdd5",
                cursor: "pointer",
                position: "relative",
                transition: "background-color 0.2s ease",
              }}
            >
              <div style={{
                width: "22px",
                height: "22px",
                borderRadius: "11px",
                backgroundColor: "white",
                position: "absolute",
                top: "3px",
                left: displayInterval === "yearly" ? "27px" : "3px",
                transition: "left 0.2s ease",
                boxShadow: "0 1px 3px rgba(0,0,0,0.2)",
              }} />
            </button>
            <span style={{
              fontSize: "14px",
              fontWeight: displayInterval === "yearly" ? 700 : 400,
              color: displayInterval === "yearly" ? "#202223" : "#637381",
            }}>
              Yearly
            </span>
            {displayInterval === "yearly" && (
              <span style={{
                backgroundColor: "#e3f1df",
                color: "#1a7f37",
                padding: "4px 10px",
                borderRadius: "12px",
                fontSize: "12px",
                fontWeight: 700,
              }}>
                Save 20%
              </span>
            )}
          </div>
        </s-box>
      </s-section>

      {/* Plan Cards (display only — subscribe via Shopify) */}
      <s-section>
        <s-box padding="base">
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "16px" }}>
            {PLAN_DETAILS.map((plan) => {
              const isCurrent = plan.key === currentPlan;
              const currentOrder = PLAN_ORDER[currentPlan] || 0;
              const planOrder = PLAN_ORDER[plan.key] || 0;
              const isUpgrade = planOrder > currentOrder;
              const isDowngrade = planOrder < currentOrder;
              const price = formatPrice(plan);

              return (
                <div key={plan.key} style={{
                  border: plan.highlight ? "2px solid #2c6ecb" : "1px solid #e1e3e5",
                  borderRadius: "16px",
                  padding: "24px",
                  backgroundColor: isCurrent ? "#f0f5ff" : "white",
                  position: "relative",
                  transition: "all 0.2s ease",
                  display: "flex",
                  flexDirection: "column",
                }}>
                  {plan.badge && (
                    <div style={{
                      position: "absolute",
                      top: "-12px",
                      left: "50%",
                      transform: "translateX(-50%)",
                      backgroundColor: "#2c6ecb",
                      color: "white",
                      padding: "4px 16px",
                      borderRadius: "12px",
                      fontSize: "12px",
                      fontWeight: 700,
                      whiteSpace: "nowrap",
                    }}>
                      {plan.badge}
                    </div>
                  )}

                  <div style={{ textAlign: "center", marginBottom: "16px" }}>
                    <div style={{ fontSize: "18px", fontWeight: 700, color: "#202223", marginBottom: "4px" }}>{plan.name}</div>
                    <div style={{ fontSize: "32px", fontWeight: 800, color: "#202223" }}>
                      {price.display}
                      <span style={{ fontSize: "13px", fontWeight: 400, color: "#637381" }}>/{price.detail}</span>
                    </div>
                    {displayInterval === "yearly" && plan.monthlyPrice > 0 && (
                      <div style={{ fontSize: "12px", color: "#637381", marginTop: "2px", textDecoration: "line-through" }}>
                        ${plan.monthlyPrice.toFixed(2)}/month
                      </div>
                    )}
                    <div style={{ fontSize: "13px", color: "#637381", marginTop: "4px" }}>{plan.description}</div>
                  </div>

                  <div style={{ flex: 1, marginBottom: "16px" }}>
                    {plan.features.map((feature, i) => (
                      <div key={i} style={{ display: "flex", alignItems: "center", gap: "8px", padding: "5px 0", fontSize: "13px" }}>
                        <span style={{ fontSize: "14px", flexShrink: 0 }}>
                          {feature.included ? "\u2705" : "\u2014"}
                        </span>
                        <span style={{ color: feature.included ? "#202223" : "#babec3" }}>{feature.text}</span>
                      </div>
                    ))}
                  </div>

                  <div style={{ textAlign: "center" }}>
                    {isCurrent ? (
                      <div style={{
                        padding: "10px 24px",
                        borderRadius: "8px",
                        backgroundColor: "#e3f1df",
                        color: "#1a7f37",
                        fontWeight: 700,
                        fontSize: "14px",
                      }}>
                        Current Plan
                      </div>
                    ) : isUpgrade ? (
                      <button
                        onClick={handleChangePlan}
                        style={{
                          width: "100%",
                          padding: "12px 24px",
                          borderRadius: "8px",
                          border: "none",
                          backgroundColor: plan.highlight ? "#2c6ecb" : "#202223",
                          color: "white",
                          fontWeight: 700,
                          fontSize: "14px",
                          cursor: "pointer",
                          transition: "all 0.15s",
                        }}
                      >
                        Upgrade to {plan.name}
                      </button>
                    ) : isDowngrade ? (
                      <button
                        onClick={handleChangePlan}
                        style={{
                          width: "100%",
                          padding: "10px 24px",
                          borderRadius: "8px",
                          border: "1px solid #c4cdd5",
                          backgroundColor: "white",
                          color: "#637381",
                          fontWeight: 600,
                          fontSize: "14px",
                          cursor: "pointer",
                        }}
                      >
                        Switch to {plan.name}
                      </button>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        </s-box>
      </s-section>

      {/* FAQ */}
      <s-section>
        <s-box padding="base">
          <div style={{ fontWeight: 700, fontSize: "18px", color: "#202223", marginBottom: "16px" }}>Frequently Asked Questions</div>

          {[
            { q: "What's the difference between the Free and Unlimited Edits plan?", a: "The Free plan limits you to 15 products per bulk edit. The Unlimited Edits plan removes that limit, so you can edit your entire catalog at once." },
            { q: "What are automation rules?", a: "Automation rules automatically adjust prices when product conditions are met (e.g., reduce price by 10% when inventory drops below 5). Available on Pro (up to 3 rules) and Premium Pro (unlimited rules)." },
            { q: "Is there a free trial?", a: "Yes! All paid plans include a 7-day free trial. You won't be charged until the trial ends." },
            { q: "How much do I save with yearly billing?", a: "You save 20% with yearly billing compared to monthly. The discount is applied automatically when you select the yearly option." },
            { q: "Can I cancel anytime?", a: "Yes. You can downgrade to Free at any time through the Shopify billing page. You'll keep your paid features until the end of your current billing cycle." },
            { q: "How do I change my plan?", a: "Click the 'Upgrade Your Plan' or 'Change Plan' button above. You'll be taken to Shopify's plan selection page where you can choose a new plan. Shopify handles all billing and proration automatically." },
            { q: "I have a promo code. How do I use it?", a: "Click the 'Have a promo code?' button on this page, enter your code, and click Apply. If valid, your plan will be upgraded instantly for the duration specified by the promo. When the promo expires, your plan will revert to your active Shopify subscription or Free." },
          ].map((item, i) => (
            <div key={i} style={{ padding: "12px 0", borderBottom: i < 5 ? "1px solid #f1f2f3" : "none" }}>
              <div style={{ fontWeight: 600, fontSize: "14px", color: "#202223", marginBottom: "4px" }}>{item.q}</div>
              <div style={{ fontSize: "13px", color: "#637381" }}>{item.a}</div>
            </div>
          ))}
        </s-box>
      </s-section>
    </s-page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
