import { useState, useEffect } from "react";
import { useLoaderData, useFetcher, useNavigate } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate, PLAN_NAMES } from "../shopify.server";
import prisma from "../db.server";

/* ───────── Plan Definitions ───────── */
const PLAN_LIMITS = {
  free:     { productsPerEdit: 15, editsPerMonth: Infinity, automations: 0 },
  unlimited:{ productsPerEdit: Infinity, editsPerMonth: Infinity, automations: 0 },
  pro:      { productsPerEdit: Infinity, editsPerMonth: Infinity, automations: 3 },
  premium:  { productsPerEdit: Infinity, editsPerMonth: Infinity, automations: Infinity },
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

/* Plan key → Shopify billing plan name mapping */
const BILLING_PLAN_MAP = {
  unlimited: { monthly: PLAN_NAMES.UNLIMITED_MONTHLY, yearly: PLAN_NAMES.UNLIMITED_YEARLY },
  pro:       { monthly: PLAN_NAMES.PRO_MONTHLY,       yearly: PLAN_NAMES.PRO_YEARLY },
  premium:   { monthly: PLAN_NAMES.PREMIUM_MONTHLY,   yearly: PLAN_NAMES.PREMIUM_YEARLY },
};

/* Plan tier ordering for upgrade/downgrade detection */
const PLAN_ORDER = { free: 0, unlimited: 1, pro: 2, premium: 3 };

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  let shopPlan = await prisma.shopPlan.findUnique({ where: { shop } });
  if (!shopPlan) {
    shopPlan = await prisma.shopPlan.create({ data: { shop } });
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
    currentPlan: plan,
    monthlyEdits: shopPlan.monthlyEdits,
    productsPerEdit: limits.productsPerEdit,
    automationLimit: limits.automations,
    trialUsed: shopPlan.trialUsed,
    isDev: process.env.NODE_ENV !== "production",
  };
};

export const action = async ({ request }) => {
  const { billing, session } = await authenticate.admin(request);
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

  if (intent === "subscribe") {
    const planKey = formData.get("plan"); // "unlimited", "pro", or "premium"
    const interval = formData.get("interval") || "monthly"; // "monthly" or "yearly"

    const billingMap = BILLING_PLAN_MAP[planKey];
    if (!billingMap) {
      return { error: "Invalid plan" };
    }
    const planName = billingMap[interval];
    if (!planName) {
      return { error: "Invalid billing interval" };
    }

    // Check if trial was already used
    const shopPlan = await prisma.shopPlan.findUnique({ where: { shop } });
    const trialDays = shopPlan?.trialUsed ? 0 : 7;

    try {
      const appHandle = process.env.SHOPIFY_API_KEY || "bulk-editor-prox";
      const returnUrl = `https://admin.shopify.com/store/${shop.replace(".myshopify.com", "")}/apps/${appHandle}/app/billing-callback?plan=${planKey}`;

      console.log("[Billing] Requesting billing for shop:", shop, "plan:", planName, "interval:", interval, "returnUrl:", returnUrl, "trialDays:", trialDays);

      await billing.request({
        plan: planName,
        isTest: true,
        returnUrl,
        trialDays,
      });

      // If we somehow get here (shouldn't happen — billing.request always throws),
      // treat as auto-approved
      await prisma.shopPlan.upsert({
        where: { shop },
        update: { plan: planKey, trialUsed: true },
        create: { shop, plan: planKey, trialUsed: true },
      });
      return { success: true, autoApproved: true };
    } catch (err) {
      // billing.request() throws a Response object for the redirect.
      // We MUST re-throw it so React Router handles the redirect to Shopify's billing page.
      if (err instanceof Response) {
        await prisma.shopPlan.upsert({
          where: { shop },
          update: { trialUsed: true },
          create: { shop, trialUsed: true },
        });
        throw err;
      }

      console.error("[Billing] Subscribe error for shop:", shop, "plan:", planName);
      console.error("[Billing] Error:", err?.message);
      if (err?.errorData) {
        console.error("[Billing] Error data:", JSON.stringify(err.errorData, null, 2));
      }

      const errorMsg = err?.errorData?.length
        ? err.errorData.map(e => e.message || JSON.stringify(e)).join("; ")
        : err?.message || "Unknown error";
      return { error: `Billing error: ${errorMsg}. Please try again or contact support.` };
    }
  }

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
  const { shop, currentPlan, monthlyEdits, productsPerEdit, automationLimit, trialUsed, isDev } = useLoaderData();
  const fetcher = useFetcher();
  const navigate = useNavigate();
  const shopify = useAppBridge();
  const [showCancelDialog, setShowCancelDialog] = useState(false);
  const [showTestMode, setShowTestMode] = useState(false);
  const [billingInterval, setBillingInterval] = useState("monthly");

  const isSubmitting = fetcher.state !== "idle";

  useEffect(() => {
    if (fetcher.data?.redirect) {
      window.open(fetcher.data.redirect, "_top");
    }
    if (fetcher.data?.autoApproved) {
      shopify.toast.show("Plan upgraded successfully!");
      navigate("/app/billing", { replace: true });
    }
    if (fetcher.data?.cancelled) {
      shopify.toast.show("Subscription cancelled. You're now on the Free plan.");
      navigate("/app/billing", { replace: true });
    }
    if (fetcher.data?.testSwitch) {
      shopify.toast.show(`Switched to ${fetcher.data.testSwitch} plan (test mode)`);
      navigate("/app/billing", { replace: true });
    }
    if (fetcher.data?.testReset) {
      shopify.toast.show("Monthly edit counter reset to 0");
      navigate("/app/billing", { replace: true });
    }
    if (fetcher.data?.error) {
      shopify.toast.show("Error: " + fetcher.data.error, { isError: true });
    }
  }, [fetcher.data]);

  const handleSubscribe = (planKey) => {
    fetcher.submit(
      { intent: "subscribe", plan: planKey, interval: billingInterval },
      { method: "POST" }
    );
  };

  const handleCancel = () => {
    setShowCancelDialog(false);
    fetcher.submit({ intent: "cancel" }, { method: "POST" });
  };

  const handleTestSwitch = (planKey) => {
    fetcher.submit({ intent: "test-switch", plan: planKey }, { method: "POST" });
  };

  const handleTestReset = () => {
    fetcher.submit({ intent: "test-reset" }, { method: "POST" });
  };

  const formatPrice = (plan) => {
    if (plan.monthlyPrice === 0) return { display: "$0", detail: "forever" };
    if (billingInterval === "yearly") {
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
              </div>
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

      {/* Test Mode Panel */}
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

      {/* Billing Interval Toggle */}
      <s-section>
        <s-box padding="base">
          <div style={{ display: "flex", justifyContent: "center", alignItems: "center", gap: "12px" }}>
            <span style={{
              fontSize: "14px",
              fontWeight: billingInterval === "monthly" ? 700 : 400,
              color: billingInterval === "monthly" ? "#202223" : "#637381",
            }}>
              Monthly
            </span>
            <button
              onClick={() => setBillingInterval(billingInterval === "monthly" ? "yearly" : "monthly")}
              style={{
                width: "52px",
                height: "28px",
                borderRadius: "14px",
                border: "none",
                backgroundColor: billingInterval === "yearly" ? "#2c6ecb" : "#c4cdd5",
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
                left: billingInterval === "yearly" ? "27px" : "3px",
                transition: "left 0.2s ease",
                boxShadow: "0 1px 3px rgba(0,0,0,0.2)",
              }} />
            </button>
            <span style={{
              fontSize: "14px",
              fontWeight: billingInterval === "yearly" ? 700 : 400,
              color: billingInterval === "yearly" ? "#202223" : "#637381",
            }}>
              Yearly
            </span>
            {billingInterval === "yearly" && (
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

      {/* Plan Cards */}
      <s-section>
        <s-box padding="base">
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "16px" }}>
            {PLAN_DETAILS.map((plan) => {
              const isCurrent = plan.key === currentPlan;
              const currentOrder = PLAN_ORDER[currentPlan] || 0;
              const planOrder = PLAN_ORDER[plan.key] || 0;
              const isDowngrade = planOrder < currentOrder;
              const isUpgrade = planOrder > currentOrder;
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
                    {billingInterval === "yearly" && plan.monthlyPrice > 0 && (
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
                        onClick={() => handleSubscribe(plan.key)}
                        disabled={isSubmitting}
                        style={{
                          width: "100%",
                          padding: "12px 24px",
                          borderRadius: "8px",
                          border: "none",
                          backgroundColor: plan.highlight ? "#2c6ecb" : "#202223",
                          color: "white",
                          fontWeight: 700,
                          fontSize: "14px",
                          cursor: isSubmitting ? "wait" : "pointer",
                          opacity: isSubmitting ? 0.7 : 1,
                          transition: "all 0.15s",
                        }}
                      >
                        {isSubmitting ? "Redirecting..." : trialUsed ? `Upgrade to ${plan.name}` : "Start 7-Day Free Trial"}
                      </button>
                    ) : isDowngrade ? (
                      <button
                        onClick={() => plan.key === "free" ? setShowCancelDialog(true) : handleSubscribe(plan.key)}
                        disabled={isSubmitting}
                        style={{
                          width: "100%",
                          padding: "10px 24px",
                          borderRadius: "8px",
                          border: "1px solid #c4cdd5",
                          backgroundColor: "white",
                          color: "#637381",
                          fontWeight: 600,
                          fontSize: "14px",
                          cursor: isSubmitting ? "wait" : "pointer",
                        }}
                      >
                        {plan.key === "free" ? "Downgrade to Free" : `Switch to ${plan.name}`}
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
            { q: "How much do I save with yearly billing?", a: "You save 20% with yearly billing compared to monthly. The discount is applied automatically when you select the yearly toggle." },
            { q: "Can I cancel anytime?", a: "Yes. You can downgrade to Free at any time. Shopify handles all billing — you'll keep your paid features until the end of your current billing cycle." },
            { q: "Can I switch between monthly and yearly?", a: "Yes. When you switch plans, the new billing interval takes effect immediately. Shopify will prorate any remaining balance." },
          ].map((item, i) => (
            <div key={i} style={{ padding: "12px 0", borderBottom: i < 5 ? "1px solid #f1f2f3" : "none" }}>
              <div style={{ fontWeight: 600, fontSize: "14px", color: "#202223", marginBottom: "4px" }}>{item.q}</div>
              <div style={{ fontSize: "13px", color: "#637381" }}>{item.a}</div>
            </div>
          ))}
        </s-box>
      </s-section>

      {/* Cancel Dialog */}
      {showCancelDialog && (
        <div style={{ position: "fixed", top: 0, left: 0, right: 0, bottom: 0, backgroundColor: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 9999 }}>
          <div style={{ backgroundColor: "white", borderRadius: "16px", padding: "24px", maxWidth: "420px", width: "90%", boxShadow: "0 20px 60px rgba(0,0,0,0.3)" }}>
            <div style={{ fontSize: "18px", fontWeight: 700, color: "#202223", marginBottom: "8px" }}>Downgrade to Free?</div>
            <div style={{ fontSize: "14px", color: "#637381", marginBottom: "20px" }}>
              You'll lose access to unlimited products per edit and automation rules. Your history and settings will be preserved.
            </div>
            <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
              <button onClick={() => setShowCancelDialog(false)} style={{ padding: "10px 20px", borderRadius: "8px", border: "1px solid #c4cdd5", backgroundColor: "white", cursor: "pointer", fontSize: "14px" }}>
                Keep Current Plan
              </button>
              <button onClick={handleCancel} style={{ padding: "10px 20px", borderRadius: "8px", border: "none", backgroundColor: "#d72c0d", color: "white", cursor: "pointer", fontWeight: 600, fontSize: "14px" }}>
                Downgrade
              </button>
            </div>
          </div>
        </div>
      )}
    </s-page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
