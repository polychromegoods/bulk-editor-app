import { useState, useEffect } from "react";
import { useLoaderData, useFetcher, useNavigate } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate, PLAN_NAMES } from "../shopify.server";
import prisma from "../db.server";

/* ───────── Plan Definitions ───────── */
const PLAN_LIMITS = {
  free: { editsPerMonth: 3, automations: false, scheduled: false },
  pro: { editsPerMonth: 50, automations: false, scheduled: false },
  plus: { editsPerMonth: Infinity, automations: true, scheduled: true },
};

const PLAN_DETAILS = [
  {
    key: "free",
    name: "Free",
    price: "$0",
    priceDetail: "forever",
    description: "Get started with basic bulk editing",
    features: [
      { text: "3 bulk edits per month", included: true },
      { text: "All filter & modification types", included: true },
      { text: "Price history & undo", included: true },
      { text: "Live preview", included: true },
      { text: "Up to 50 edits per month", included: false },
      { text: "Automation rules", included: false },
      { text: "Scheduled price changes", included: false },
      { text: "Priority support", included: false },
    ],
    highlight: false,
    cta: "Current Plan",
  },
  {
    key: "pro",
    name: "Pro",
    price: "$9.99",
    priceDetail: "per month",
    description: "For growing stores that need more edits",
    features: [
      { text: "50 bulk edits per month", included: true },
      { text: "All filter & modification types", included: true },
      { text: "Price history & undo", included: true },
      { text: "Live preview", included: true },
      { text: "CSV export of history", included: true },
      { text: "Automation rules", included: false },
      { text: "Scheduled price changes", included: false },
      { text: "Priority support", included: true },
    ],
    highlight: true,
    badge: "Most Popular",
    cta: "Start 7-Day Free Trial",
  },
  {
    key: "plus",
    name: "Plus",
    price: "$19.99",
    priceDetail: "per month",
    description: "Unlimited power for high-volume stores",
    features: [
      { text: "Unlimited bulk edits", included: true },
      { text: "All filter & modification types", included: true },
      { text: "Price history & undo", included: true },
      { text: "Live preview", included: true },
      { text: "CSV export of history", included: true },
      { text: "Automation rules", included: true },
      { text: "Scheduled price changes", included: true },
      { text: "Priority support", included: true },
    ],
    highlight: false,
    cta: "Start 7-Day Free Trial",
  },
];

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
    editsLimit: limits.editsPerMonth,
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
    if (!["free", "pro", "plus"].includes(planKey)) {
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
    const planKey = formData.get("plan"); // "pro" or "plus"
    const planName = planKey === "plus" ? PLAN_NAMES.PLUS : PLAN_NAMES.PRO;

    // Check if trial was already used
    const shopPlan = await prisma.shopPlan.findUnique({ where: { shop } });
    const trialDays = shopPlan?.trialUsed ? 0 : 7;

    try {
      const response = await billing.request({
        plan: planName,
        isTest: true,
        returnUrl: `https://${shop}/admin/apps/${process.env.SHOPIFY_API_KEY || "bulk-editor"}/app/billing-callback?plan=${planKey}`,
        trialDays,
      });

      // Mark trial as used
      await prisma.shopPlan.upsert({
        where: { shop },
        update: { trialUsed: true },
        create: { shop, trialUsed: true },
      });

      // billing.request returns the confirmation URL directly or an object with confirmationUrl
      const confirmationUrl = typeof response === "string" ? response : response?.confirmationUrl;
      if (confirmationUrl) {
        return { redirect: confirmationUrl };
      }

      // If billing.request didn't return a URL, the plan might have been auto-approved
      await prisma.shopPlan.upsert({
        where: { shop },
        update: { plan: planKey },
        create: { shop, plan: planKey },
      });
      return { success: true, autoApproved: true };
    } catch (err) {
      console.error("Billing request error:", err);
      return { error: err.message || "Failed to create billing request. Use Test Mode to switch plans for development." };
    }
  }

  if (intent === "cancel") {
    try {
      // Reset to free plan
      await prisma.shopPlan.upsert({
        where: { shop },
        update: { plan: "free", chargeId: null },
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
  const { shop, currentPlan, monthlyEdits, editsLimit, trialUsed, isDev } = useLoaderData();
  const fetcher = useFetcher();
  const navigate = useNavigate();
  const shopify = useAppBridge();
  const [showCancelDialog, setShowCancelDialog] = useState(false);
  const [showTestMode, setShowTestMode] = useState(false);

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
    fetcher.submit({ intent: "subscribe", plan: planKey }, { method: "POST" });
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

  const usagePercent = editsLimit === Infinity ? 0 : Math.min(100, Math.round((monthlyEdits / editsLimit) * 100));

  return (
    <s-page title="Plans & Billing" subtitle="Choose the plan that's right for your store">
      {/* Current Plan Status */}
      <s-section>
        <s-box padding="base">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "16px" }}>
            <div>
              <div style={{ fontSize: "13px", color: "#637381", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: "4px" }}>Current Plan</div>
              <div style={{ fontSize: "28px", fontWeight: 800, color: "#202223" }}>
                {currentPlan === "free" ? "Free" : currentPlan === "pro" ? "Pro" : "Plus"}
              </div>
            </div>
            <div style={{ textAlign: "right" }}>
              <div style={{ fontSize: "13px", color: "#637381", marginBottom: "6px" }}>
                Monthly Usage: <strong>{monthlyEdits}</strong> / {editsLimit === Infinity ? "∞" : editsLimit} edits
              </div>
              <div style={{ width: "200px", height: "8px", backgroundColor: "#e1e3e5", borderRadius: "4px", overflow: "hidden" }}>
                <div style={{
                  width: `${usagePercent}%`,
                  height: "100%",
                  backgroundColor: usagePercent > 80 ? "#d72c0d" : usagePercent > 50 ? "#ffc453" : "#2c6ecb",
                  borderRadius: "4px",
                  transition: "width 0.3s ease",
                }} />
              </div>
              {usagePercent > 80 && currentPlan !== "plus" && (
                <div style={{ fontSize: "12px", color: "#d72c0d", marginTop: "4px", fontWeight: 600 }}>
                  Running low — consider upgrading
                </div>
              )}
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
                  <span style={{ fontSize: "14px", fontWeight: 700, color: "#b98900" }}>🧪 Test Mode</span>
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
                    {["free", "pro", "plus"].map((p) => (
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
                        {currentPlan === p ? `✓ ${p.charAt(0).toUpperCase() + p.slice(1)}` : `Switch to ${p.charAt(0).toUpperCase() + p.slice(1)}`}
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
                    ⚠️ Test mode only appears in development. It will not show in production.
                  </div>
                </div>
              )}
            </div>
          </s-box>
        </s-section>
      )}

      {/* Plan Cards */}
      <s-section>
        <s-box padding="base">
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: "16px" }}>
            {PLAN_DETAILS.map((plan) => {
              const isCurrent = plan.key === currentPlan;
              const isDowngrade = (currentPlan === "plus" && plan.key !== "plus") || (currentPlan === "pro" && plan.key === "free");
              const isUpgrade = (currentPlan === "free" && plan.key !== "free") || (currentPlan === "pro" && plan.key === "plus");

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
                    }}>
                      {plan.badge}
                    </div>
                  )}

                  <div style={{ textAlign: "center", marginBottom: "16px" }}>
                    <div style={{ fontSize: "18px", fontWeight: 700, color: "#202223", marginBottom: "4px" }}>{plan.name}</div>
                    <div style={{ fontSize: "36px", fontWeight: 800, color: "#202223" }}>
                      {plan.price}
                      <span style={{ fontSize: "14px", fontWeight: 400, color: "#637381" }}>/{plan.priceDetail}</span>
                    </div>
                    <div style={{ fontSize: "13px", color: "#637381", marginTop: "4px" }}>{plan.description}</div>
                  </div>

                  <div style={{ flex: 1, marginBottom: "16px" }}>
                    {plan.features.map((feature, i) => (
                      <div key={i} style={{ display: "flex", alignItems: "center", gap: "8px", padding: "6px 0", fontSize: "13px" }}>
                        <span style={{ fontSize: "14px", flexShrink: 0 }}>
                          {feature.included ? "✅" : "—"}
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
                        ✓ Current Plan
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
                        {isSubmitting ? "Redirecting..." : trialUsed ? `Upgrade to ${plan.name}` : plan.cta}
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
            { q: "What counts as a bulk edit?", a: "Each time you execute a bulk change (Step 3 → Apply), that counts as one bulk edit, regardless of how many products or variants are included." },
            { q: "What happens when I hit my limit?", a: "You'll see a notification and won't be able to execute new bulk edits until next month or until you upgrade. Your existing data and history are unaffected." },
            { q: "Can I cancel anytime?", a: "Yes. You can downgrade to Free at any time. Shopify handles all billing — you'll keep your paid features until the end of your current billing cycle." },
            { q: "Is there a free trial?", a: "Yes! Pro and Plus plans include a 7-day free trial. You won't be charged until the trial ends." },
            { q: "Do automations and scheduled edits count toward my limit?", a: "Automations and scheduled edits are only available on the Plus plan, which has unlimited edits." },
          ].map((item, i) => (
            <div key={i} style={{ padding: "12px 0", borderBottom: i < 4 ? "1px solid #f1f2f3" : "none" }}>
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
              You'll lose access to your current plan's features at the end of your billing cycle. Your history and settings will be preserved.
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
