import { useLoaderData, useNavigate } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

const PLAN_INFO = {
  free:      { productsPerEdit: 15,       automations: 0,        name: "Free" },
  unlimited: { productsPerEdit: Infinity, automations: 0,        name: "Unlimited Edits" },
  pro:       { productsPerEdit: Infinity, automations: 3,        name: "Pro" },
  premium:   { productsPerEdit: Infinity, automations: Infinity, name: "Premium Pro" },
};

/* Map Shopify Managed Pricing plan handles → internal plan keys */
const HANDLE_TO_PLAN = {
  "bulk-editor-free": "free",
  "bulk-editor-unlimited": "unlimited",
  "bulk-editor-pro": "pro",
  "bulk-editor-premium": "premium",
};

/* Plan tier ordering for picking the highest active plan */
const PLAN_TIER = { free: 0, unlimited: 1, pro: 2, premium: 3 };

/* GraphQL query to read the current subscription from Shopify */
const CURRENT_SUBSCRIPTION_QUERY = `
  query {
    currentAppInstallation {
      activeSubscriptions {
        id
        name
        status
        lineItems {
          plan {
            pricingDetails {
              ... on AppRecurringPricing {
                interval
                planHandle
                price { amount currencyCode }
              }
            }
          }
        }
      }
      allSubscriptions(first: 10, sortKey: CREATED_AT) {
        nodes {
          id
          name
          status
          createdAt
          lineItems {
            plan {
              pricingDetails {
                ... on AppRecurringPricing {
                  interval
                  planHandle
                  price { amount currencyCode }
                }
              }
            }
          }
        }
      }
    }
  }
`;

/* Helper: resolve a subscription's lineItem to an internal plan key */
function resolveSubscriptionPlan(sub) {
  const lineItem = sub?.lineItems?.[0];
  if (!lineItem) return null;
  const details = lineItem.plan?.pricingDetails;
  // Try planHandle first (most reliable)
  const handle = details?.planHandle;
  if (handle && HANDLE_TO_PLAN[handle]) return HANDLE_TO_PLAN[handle];
  // Fallback: infer from price (normalize yearly to monthly)
  const rawPrice = parseFloat(details?.price?.amount || "0");
  if (rawPrice === 0) return null;
  const interval = details?.interval;
  const price = interval === "ANNUAL" ? rawPrice / 12 : rawPrice;
  if (price >= 20) return "premium";
  if (price >= 10) return "pro";
  if (price >= 4) return "unlimited";
  return null;
}

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;
  const url = new URL(request.url);
  const chargeId = url.searchParams.get("charge_id");

  // Get or create shop plan
  let shopPlan = await prisma.shopPlan.findUnique({ where: { shop } });
  if (!shopPlan) {
    shopPlan = await prisma.shopPlan.create({ data: { shop } });
  }

  // ─── Sync plan from Shopify (always, but especially important when charge_id is present) ───
  // Shopify Managed Pricing redirects here with ?charge_id=... after plan approval.
  // We query Shopify GraphQL to get the real plan and sync our database.
  // IMPORTANT: When upgrading, multiple subscriptions may coexist briefly (old ACTIVE + new ACCEPTED).
  // We must pick the HIGHEST-TIER plan among all active/accepted subscriptions.
  let shopifyPlan = "free";
  try {
    const response = await admin.graphql(CURRENT_SUBSCRIPTION_QUERY);
    const data = await response.json();
    const installation = data?.data?.currentAppInstallation;

    // 1. Check activeSubscriptions first (Shopify's canonical active list)
    const activeSubs = installation?.activeSubscriptions || [];
    for (const sub of activeSubs) {
      const resolved = resolveSubscriptionPlan(sub);
      if (resolved && (PLAN_TIER[resolved] || 0) > (PLAN_TIER[shopifyPlan] || 0)) {
        shopifyPlan = resolved;
      }
    }

    // 2. Also check allSubscriptions for ACTIVE/ACCEPTED (includes recently approved plans)
    const allSubs = installation?.allSubscriptions?.nodes || [];
    for (const sub of allSubs) {
      if (sub.status === "ACTIVE" || sub.status === "ACCEPTED") {
        const resolved = resolveSubscriptionPlan(sub);
        if (resolved && (PLAN_TIER[resolved] || 0) > (PLAN_TIER[shopifyPlan] || 0)) {
          shopifyPlan = resolved;
        }
      }
    }

    console.log(`[Dashboard] Shop ${shop}: detected Shopify plan=${shopifyPlan}${chargeId ? `, charge_id=${chargeId}` : ""}`);
  } catch (err) {
    console.error("[Dashboard] Failed to query Shopify subscription:", err.message);
  }

  // Sync database with Shopify's plan (Shopify is source of truth)
  // Skip sync if promo is active and not expired
  const promoActive = shopPlan.promoCode && shopPlan.promoExpiresAt && new Date(shopPlan.promoExpiresAt) > new Date();
  if (!promoActive && shopPlan.plan !== shopifyPlan) {
    console.log(`[Dashboard] Syncing plan for ${shop}: DB=${shopPlan.plan} → Shopify=${shopifyPlan}`);
    shopPlan = await prisma.shopPlan.update({
      where: { shop },
      data: {
        plan: shopifyPlan,
        ...(chargeId ? { chargeId } : {}),
        ...(shopifyPlan !== "free" ? { trialUsed: true } : {}),
      },
    });
  } else if (chargeId && shopPlan.plan === shopifyPlan) {
    // Update chargeId even if plan matches
    shopPlan = await prisma.shopPlan.update({
      where: { shop },
      data: { chargeId },
    });
  }

  // Reset monthly edits if new month
  const now = new Date();
  const resetDate = new Date(shopPlan.monthlyEditReset);
  if (now.getMonth() !== resetDate.getMonth() || now.getFullYear() !== resetDate.getFullYear()) {
    shopPlan = await prisma.shopPlan.update({
      where: { shop },
      data: { monthlyEdits: 0, monthlyEditReset: now },
    });
  }

  const [editCount, historyCount, ruleCount, scheduledCount, recentEdits, todayChanges] = await Promise.all([
    prisma.bulkEdit.count({ where: { shop } }),
    prisma.priceHistory.count({ where: { shop } }),
    prisma.automationRule.count({ where: { shop, enabled: true } }),
    prisma.scheduledEdit.count({ where: { shop, status: "pending" } }),
    prisma.bulkEdit.findMany({
      where: { shop },
      orderBy: { createdAt: "desc" },
      take: 5,
    }),
    prisma.priceHistory.count({
      where: {
        shop,
        createdAt: { gte: new Date(new Date().setHours(0, 0, 0, 0)) },
      },
    }),
  ]);

  // Get product count
  let productCount = 0;
  try {
    const response = await admin.graphql(`#graphql
      query { productsCount { count } }
    `);
    const data = await response.json();
    productCount = data.data?.productsCount?.count || 0;
  } catch (e) {
    productCount = 0;
  }

  const plan = shopPlan.plan || "free";
  const info = PLAN_INFO[plan] || PLAN_INFO.free;

  return {
    shop,
    productCount,
    editCount,
    historyCount,
    ruleCount,
    scheduledCount,
    recentEdits,
    todayChanges,
    currentPlan: plan,
    planName: info.name,
    productsPerEdit: info.productsPerEdit,
    automationLimit: info.automations,
    monthlyEdits: shopPlan.monthlyEdits,
  };
};

export default function Dashboard() {
  const {
    shop, productCount, editCount, historyCount, ruleCount, scheduledCount,
    recentEdits, todayChanges, currentPlan, planName, productsPerEdit, automationLimit, monthlyEdits,
  } = useLoaderData();
  const navigate = useNavigate();

  const statCards = [
    { label: "Products", value: productCount.toLocaleString(), icon: "📦", color: "#2c6ecb" },
    { label: "Bulk Edits", value: editCount, icon: "✏️", color: "#7c3aed" },
    { label: "Price Changes", value: historyCount.toLocaleString(), icon: "📊", color: "#008060" },
    { label: "Changes Today", value: todayChanges, icon: "📅", color: "#b98900" },
  ];

  const quickActions = [
    { label: "Bulk Edit", description: "Select products and edit any field in bulk", icon: "⚡", path: "/app/bulk-edit", color: "#2c6ecb" },
    { label: "Browse Products", description: "View and search your product catalog", icon: "📦", path: "/app/products", color: "#008060" },
    { label: "Price History", description: "View all past price changes", icon: "📜", path: "/app/history", color: "#7c3aed" },
    { label: "Automation Rules", description: (currentPlan === "pro" || currentPlan === "premium") ? "Manage automatic price rules" : "Requires Pro plan", icon: "🤖", path: "/app/automations", color: "#b98900", locked: currentPlan !== "pro" && currentPlan !== "premium" },
  ];

  return (
    <s-page heading="Dashboard">
      <s-button slot="primary-action" variant="primary" onClick={() => navigate("/app/bulk-edit")}>
        Bulk Edit
      </s-button>

      {/* Plan Status Banner */}
      <s-section>
        <div style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          padding: "16px 20px",
          borderRadius: "12px",
          backgroundColor: currentPlan === "free" ? "#f6f6f7" : currentPlan === "unlimited" ? "#f0f5ff" : currentPlan === "pro" ? "#f0f5ff" : "#faf5ff",
          border: `1px solid ${currentPlan === "free" ? "#e1e3e5" : currentPlan === "premium" ? "#d8c4f0" : "#c4d6f0"}`,
          flexWrap: "wrap",
          gap: "16px",
        }}>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "4px" }}>
              <span style={{
                display: "inline-block",
                padding: "2px 10px",
                borderRadius: "10px",
                fontSize: "12px",
                fontWeight: 700,
                backgroundColor: currentPlan === "free" ? "#e4e5e7" : currentPlan === "premium" ? "#7c3aed" : "#2c6ecb",
                color: currentPlan === "free" ? "#637381" : "white",
              }}>
                {planName} Plan
              </span>
              {currentPlan === "free" && (
                <span style={{ fontSize: "13px", color: "#637381" }}>
                  — <a href="/app/billing" style={{ color: "#2c6ecb", textDecoration: "none", fontWeight: 600 }}>Upgrade for unlimited products</a>
                </span>
              )}
            </div>
            <div style={{ fontSize: "14px", color: "#202223" }}>
              Products per edit: <strong>{productsPerEdit === Infinity ? "Unlimited" : productsPerEdit}</strong>
              {" "}· Automations: <strong>{automationLimit === Infinity ? "Unlimited" : automationLimit === 0 ? "None" : `Up to ${automationLimit}`}</strong>
              {" "}· <strong>{monthlyEdits}</strong> edits this month
            </div>
          </div>
          <button
            onClick={() => navigate("/app/billing")}
            style={{
              padding: "8px 20px",
              borderRadius: "8px",
              border: currentPlan === "free" ? "none" : "1px solid #c4cdd5",
              backgroundColor: currentPlan === "free" ? "#2c6ecb" : "white",
              color: currentPlan === "free" ? "white" : "#637381",
              fontSize: "13px",
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            {currentPlan === "free" ? "Upgrade" : "Manage Plan"}
          </button>
        </div>
      </s-section>

      {/* Welcome banner for new users */}
      {historyCount === 0 && (
        <s-section>
          <div style={{ padding: "24px", background: "linear-gradient(135deg, #f0f5ff 0%, #e3f1df 100%)", borderRadius: "12px", border: "1px solid #c4cdd5" }}>
            <div style={{ fontSize: "20px", fontWeight: 700, color: "#202223", marginBottom: "8px" }}>
              Welcome to Bulk Editor
            </div>
            <div style={{ fontSize: "14px", color: "#637381", marginBottom: "16px", maxWidth: "600px" }}>
              Update any product field across your entire catalog in seconds. Select products, choose what to change (prices, titles, tags, vendor, status, and more), preview the results, and apply with one click.
            </div>
            <div style={{ display: "flex", gap: "8px" }}>
              <button
                onClick={() => navigate("/app/bulk-edit")}
                style={{ padding: "10px 24px", borderRadius: "8px", border: "none", backgroundColor: "#2c6ecb", color: "white", fontSize: "14px", fontWeight: 600, cursor: "pointer" }}
              >
                Start Your First Bulk Edit →
              </button>
              <button
                onClick={() => navigate("/app/products")}
                style={{ padding: "10px 24px", borderRadius: "8px", border: "1px solid #c4cdd5", backgroundColor: "white", fontSize: "14px", cursor: "pointer" }}
              >
                Browse Products
              </button>
            </div>
          </div>
        </s-section>
      )}

      {/* Stats Grid */}
      <s-section heading="Store Overview">
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "12px" }}>
          {statCards.map((stat, i) => (
            <div key={i} style={{
              padding: "20px",
              borderRadius: "12px",
              border: "1px solid #e1e3e5",
              backgroundColor: "white",
              borderTop: `3px solid ${stat.color}`,
            }}>
              <div style={{ fontSize: "24px", marginBottom: "4px" }}>{stat.icon}</div>
              <div style={{ fontSize: "28px", fontWeight: 800, color: "#202223" }}>{stat.value}</div>
              <div style={{ fontSize: "13px", color: "#637381" }}>{stat.label}</div>
            </div>
          ))}
        </div>
      </s-section>

      {/* Quick Actions */}
      <s-section heading="Quick Actions">
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "12px" }}>
          {quickActions.map((action, i) => (
            <div
              key={i}
              onClick={() => !action.locked && navigate(action.path)}
              style={{
                padding: "16px",
                borderRadius: "12px",
                border: "1px solid #e1e3e5",
                borderTop: `3px solid ${action.color}`,
                cursor: action.locked ? "default" : "pointer",
                backgroundColor: action.locked ? "#fafbfb" : "white",
                opacity: action.locked ? 0.6 : 1,
                transition: "all 0.15s",
              }}
            >
              <div style={{ fontSize: "28px", marginBottom: "8px" }}>{action.icon}</div>
              <div style={{ fontWeight: 700, fontSize: "14px", color: "#202223", marginBottom: "2px" }}>{action.label}</div>
              <div style={{ fontSize: "12px", color: "#637381" }}>{action.description}</div>
              {action.locked && (
                <div style={{
                  display: "inline-block",
                  marginTop: "6px",
                  padding: "2px 8px",
                  borderRadius: "8px",
                  fontSize: "11px",
                  fontWeight: 600,
                  backgroundColor: "#fef3f2",
                  color: "#d72c0d",
                }}>
                  Upgrade Required
                </div>
              )}
            </div>
          ))}
        </div>
      </s-section>

      {/* Recent Edits */}
      <s-section heading="Recent Bulk Edits">
        {recentEdits.length === 0 ? (
          <s-box padding="loose" borderWidth="base" borderRadius="base">
            <s-stack direction="block" gap="base" align="center">
              <s-text tone="subdued">No bulk edits yet. Start by editing some prices!</s-text>
              <s-button variant="primary" onClick={() => navigate("/app/bulk-edit")}>
                Start Bulk Edit
              </s-button>
            </s-stack>
          </s-box>
        ) : (
          <s-section padding="none">
            <s-table>
              <s-table-header-row>
                <s-table-header>Edit Name</s-table-header>
                <s-table-header>Status</s-table-header>
                <s-table-header format="numeric">Products</s-table-header>
                <s-table-header>Date</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {recentEdits.map((edit) => (
                  <s-table-row key={edit.id}>
                    <s-table-cell>
                      <s-text fontWeight="bold">{edit.name}</s-text>
                    </s-table-cell>
                    <s-table-cell>
                      <s-badge tone={edit.status === "completed" ? "success" : edit.status === "partial" ? "warning" : "info"}>
                        {edit.status}
                      </s-badge>
                    </s-table-cell>
                    <s-table-cell>{edit.productCount}</s-table-cell>
                    <s-table-cell>{new Date(edit.createdAt).toLocaleString()}</s-table-cell>
                  </s-table-row>
                ))}
              </s-table-body>
            </s-table>
          </s-section>
        )}
      </s-section>

      {/* Upgrade CTA for free users */}
      {currentPlan === "free" && historyCount > 0 && (
        <s-section>
          <div style={{
            padding: "24px",
            borderRadius: "12px",
            background: "linear-gradient(135deg, #2c6ecb 0%, #7c3aed 100%)",
            color: "white",
            textAlign: "center",
          }}>
            <div style={{ fontSize: "20px", fontWeight: 800, marginBottom: "8px" }}>Need more bulk edits?</div>
            <div style={{ fontSize: "14px", opacity: 0.9, marginBottom: "16px" }}>
              Upgrade to Unlimited for unrestricted product edits, or Pro for automation rules.
            </div>
            <button
              onClick={() => navigate("/app/billing")}
              style={{
                padding: "12px 32px",
                borderRadius: "8px",
                border: "2px solid white",
                backgroundColor: "transparent",
                color: "white",
                fontWeight: 700,
                fontSize: "14px",
                cursor: "pointer",
              }}
            >
              View Plans →
            </button>
          </div>
        </s-section>
      )}

      <s-section slot="aside" heading="Connected Store">
        <s-paragraph>
          <s-text fontWeight="bold">{shop}</s-text>
        </s-paragraph>
        <s-paragraph>
          <s-text tone="subdued">
            {productCount.toLocaleString()} products available for editing
          </s-text>
        </s-paragraph>
      </s-section>

      <s-section slot="aside" heading="Tips">
        <s-unordered-list>
          <s-list-item>
            Use <s-text fontWeight="bold">Quick Presets</s-text> in Bulk Edit for common operations like "10% off"
          </s-list-item>
          <s-list-item>
            Click any price on the <s-link href="/app/products">Products page</s-link> to edit it inline
          </s-list-item>
          <s-list-item>
            Every change is recorded in <s-link href="/app/history">History</s-link> and can be undone
          </s-list-item>
          <s-list-item>
            Set up <s-link href="/app/automations">Automations</s-link> to auto-adjust prices by tag or vendor
          </s-list-item>
        </s-unordered-list>
      </s-section>
    </s-page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
