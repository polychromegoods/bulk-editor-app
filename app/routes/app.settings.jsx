import { useLoaderData, useFetcher, useNavigate } from "react-router";
import { useState, useEffect } from "react";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

const PLAN_LIMITS = {
  free: { editsPerMonth: 3, name: "Free" },
  pro: { editsPerMonth: 50, name: "Pro" },
  plus: { editsPerMonth: Infinity, name: "Plus" },
};

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  let shopPlan = await prisma.shopPlan.findUnique({ where: { shop } });
  if (!shopPlan) {
    shopPlan = await prisma.shopPlan.create({ data: { shop } });
  }

  const [editCount, historyCount, ruleCount, scheduledCount] = await Promise.all([
    prisma.bulkEdit.count({ where: { shop } }),
    prisma.priceHistory.count({ where: { shop } }),
    prisma.automationRule.count({ where: { shop } }),
    prisma.scheduledEdit.count({ where: { shop } }),
  ]);

  const plan = shopPlan.plan || "free";
  const limits = PLAN_LIMITS[plan] || PLAN_LIMITS.free;

  return {
    shop,
    editCount,
    historyCount,
    ruleCount,
    scheduledCount,
    currentPlan: plan,
    planName: limits.name,
    monthlyEdits: shopPlan.monthlyEdits,
    editsLimit: limits.editsPerMonth,
  };
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "clear_history") {
    await prisma.priceHistory.deleteMany({ where: { shop } });
    return { success: true, message: "Price history cleared." };
  }

  if (intent === "clear_edits") {
    await prisma.bulkEdit.deleteMany({ where: { shop } });
    return { success: true, message: "Bulk edit records cleared." };
  }

  return { error: "Unknown intent" };
};

export default function Settings() {
  const {
    shop, editCount, historyCount, ruleCount, scheduledCount,
    currentPlan, planName, monthlyEdits, editsLimit,
  } = useLoaderData();
  const fetcher = useFetcher();
  const navigate = useNavigate();
  const shopify = useAppBridge();
  const [showClearConfirm, setShowClearConfirm] = useState(null);

  useEffect(() => {
    if (fetcher.data?.success) {
      shopify.toast.show(fetcher.data.message);
      setShowClearConfirm(null);
    }
  }, [fetcher.data, shopify]);

  return (
    <s-page heading="Settings">
      {/* Plan Info */}
      <s-section heading="Current Plan">
        <s-box padding="base" borderWidth="base" borderRadius="base">
          <s-stack direction="block" gap="base">
            <s-stack direction="inline" gap="base">
              <s-text fontWeight="bold">Plan:</s-text>
              <s-badge tone={currentPlan === "free" ? "info" : "success"}>
                {planName}
              </s-badge>
            </s-stack>
            <s-stack direction="inline" gap="base">
              <s-text fontWeight="bold">Monthly Usage:</s-text>
              <s-text>{monthlyEdits} / {editsLimit === Infinity ? "Unlimited" : editsLimit} bulk edits</s-text>
            </s-stack>
            <s-button onClick={() => navigate("/app/billing")}>
              Manage Plan
            </s-button>
          </s-stack>
        </s-box>
      </s-section>

      <s-section heading="Store Information">
        <s-stack direction="block" gap="base">
          <s-stack direction="inline" gap="base">
            <s-text fontWeight="bold">Connected Store:</s-text>
            <s-text>{shop}</s-text>
          </s-stack>
        </s-stack>
      </s-section>

      <s-section heading="Usage Statistics">
        <s-grid columns="2" gap="base">
          <s-box padding="base" borderWidth="base" borderRadius="base">
            <s-stack direction="block" gap="tight">
              <s-text tone="subdued">Total Bulk Edits</s-text>
              <s-heading>{editCount}</s-heading>
            </s-stack>
          </s-box>
          <s-box padding="base" borderWidth="base" borderRadius="base">
            <s-stack direction="block" gap="tight">
              <s-text tone="subdued">Price Changes Recorded</s-text>
              <s-heading>{historyCount.toLocaleString()}</s-heading>
            </s-stack>
          </s-box>
          <s-box padding="base" borderWidth="base" borderRadius="base">
            <s-stack direction="block" gap="tight">
              <s-text tone="subdued">Automation Rules</s-text>
              <s-heading>{ruleCount}</s-heading>
            </s-stack>
          </s-box>
          <s-box padding="base" borderWidth="base" borderRadius="base">
            <s-stack direction="block" gap="tight">
              <s-text tone="subdued">Scheduled Edits</s-text>
              <s-heading>{scheduledCount}</s-heading>
            </s-stack>
          </s-box>
        </s-grid>
      </s-section>

      <s-section heading="Data Management">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            <s-text tone="subdued">
              Clear stored data from the app. This does not affect your actual Shopify product prices.
            </s-text>
          </s-paragraph>
          <s-stack direction="inline" gap="base">
            <s-button
              tone="critical"
              variant="tertiary"
              onClick={() => setShowClearConfirm("history")}
            >
              Clear Price History ({historyCount.toLocaleString()} records)
            </s-button>
            <s-button
              tone="critical"
              variant="tertiary"
              onClick={() => setShowClearConfirm("edits")}
            >
              Clear Bulk Edit Records ({editCount} records)
            </s-button>
          </s-stack>
        </s-stack>
      </s-section>

      <s-section heading="About">
        <s-paragraph>
          <s-text fontWeight="bold">Bulk Price Editor</s-text>
        </s-paragraph>
        <s-paragraph>
          <s-text>
            A powerful bulk price editing tool for Shopify stores. Edit prices
            across multiple products at once with percentage changes, fixed
            adjustments, or exact price setting. Features include dynamic filtering,
            live preview, undo capability, and complete price change history.
          </s-text>
        </s-paragraph>
        <s-paragraph>
          <s-text tone="subdued">Version 1.1.0</s-text>
        </s-paragraph>
      </s-section>

      <s-section heading="Support">
        <s-paragraph>
          <s-text>
            Need help? Contact us at support@polychrome.com
          </s-text>
        </s-paragraph>
      </s-section>

      {/* Clear Confirmation Dialog */}
      {showClearConfirm && (
        <div style={{ position: "fixed", top: 0, left: 0, right: 0, bottom: 0, backgroundColor: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 9999 }}>
          <div style={{ backgroundColor: "white", borderRadius: "16px", padding: "24px", maxWidth: "420px", width: "90%", boxShadow: "0 20px 60px rgba(0,0,0,0.3)" }}>
            <div style={{ fontSize: "18px", fontWeight: 700, color: "#202223", marginBottom: "8px" }}>
              Clear {showClearConfirm === "history" ? "Price History" : "Bulk Edit Records"}?
            </div>
            <div style={{ fontSize: "14px", color: "#637381", marginBottom: "20px" }}>
              This will permanently delete {showClearConfirm === "history" ? `${historyCount.toLocaleString()} price history records` : `${editCount} bulk edit records`}. This cannot be undone. Your actual Shopify product prices will not be affected.
            </div>
            <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
              <button onClick={() => setShowClearConfirm(null)} style={{ padding: "10px 20px", borderRadius: "8px", border: "1px solid #c4cdd5", backgroundColor: "white", cursor: "pointer", fontSize: "14px" }}>
                Cancel
              </button>
              <button
                onClick={() => {
                  fetcher.submit(
                    { intent: showClearConfirm === "history" ? "clear_history" : "clear_edits" },
                    { method: "POST" }
                  );
                }}
                style={{ padding: "10px 20px", borderRadius: "8px", border: "none", backgroundColor: "#d72c0d", color: "white", cursor: "pointer", fontWeight: 600, fontSize: "14px" }}
              >
                Delete All
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
