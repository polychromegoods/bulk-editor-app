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

  // ─── Detect if this is a development store ───
  let isDevStore = false;
  try {
    const devCheckRes = await admin.graphql(`{ shop { plan { partnerDevelopment } } }`);
    const devCheckData = await devCheckRes.json();
    isDevStore = devCheckData?.data?.shop?.plan?.partnerDevelopment === true;
  } catch (e) {
    // Silently continue — assume not a dev store
  }

  // ─── Sync plan from Shopify (always, but especially important when charge_id is present) ───
  // Shopify Managed Pricing redirects here with ?charge_id=... after plan approval.
  // We query Shopify GraphQL to get the real plan and sync our database.
  // IMPORTANT: When upgrading, multiple subscriptions may coexist briefly (old ACTIVE + new ACCEPTED).
  // We must pick the HIGHEST-TIER plan among all active/accepted subscriptions.
  // NOTE: On dev stores, skip sync because there's no real Shopify subscription —
  // plan is managed directly in the database via test-switch.
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
  // Skip sync on dev stores (no real Shopify subscription exists — plan is managed via test-switch)
  const promoActive = shopPlan.promoCode && shopPlan.promoExpiresAt && new Date(shopPlan.promoExpiresAt) > new Date();
  if (!isDevStore && !promoActive && shopPlan.plan !== shopifyPlan) {
    console.log(`[Dashboard] Syncing plan for ${shop}: DB=${shopPlan.plan} → Shopify=${shopifyPlan}`);
    shopPlan = await prisma.shopPlan.update({
      where: { shop },
      data: {
        plan: shopifyPlan,
        ...(chargeId ? { chargeId } : {}),
        ...(shopifyPlan !== "free" ? { trialUsed: true } : {}),
      },
    });
  } else if (!isDevStore && chargeId && shopPlan.plan === shopifyPlan) {
    // Update chargeId even if plan matches
    shopPlan = await prisma.shopPlan.update({
      where: { shop },
      data: { chargeId },
    });
  } else if (isDevStore) {
    console.log(`[Dashboard] Dev store ${shop}: skipping Shopify plan sync (DB plan=${shopPlan.plan})`);
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

      {/* ─── HERO: Primary CTA ─── */}
      <s-section>
        <div
          onClick={() => navigate("/app/bulk-edit")}
          style={{
            padding: "28px 32px",
            borderRadius: "14px",
            background: "linear-gradient(135deg, #1a56db 0%, #2c6ecb 50%, #3b82f6 100%)",
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "20px",
            boxShadow: "0 4px 14px rgba(44, 110, 203, 0.3)",
            transition: "transform 0.15s, box-shadow 0.15s",
          }}
        >
          <div>
            <div style={{ fontSize: "22px", fontWeight: 800, color: "white", marginBottom: "6px" }}>
              Start Bulk Edit
            </div>
            <div style={{ fontSize: "14px", color: "rgba(255,255,255,0.85)", maxWidth: "420px" }}>
              Select products, choose fields to change, preview results, and apply — all in one flow.
            </div>
          </div>
          <div style={{
            padding: "14px 28px",
            borderRadius: "10px",
            backgroundColor: "white",
            color: "#1a56db",
            fontWeight: 700,
            fontSize: "15px",
            whiteSpace: "nowrap",
            boxShadow: "0 2px 8px rgba(0,0,0,0.1)",
          }}>
            Open Editor →
          </div>
        </div>
      </s-section>

      {/* ─── HOW IT WORKS: 3-step guide ─── */}
      <s-section heading="How It Works">
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "16px" }}>
          {[
            { step: "1", title: "Select Products", desc: "Pick individual products or load your entire catalog. Filter by vendor, type, tags, or price range.", icon: "☑️" },
            { step: "2", title: "Configure Changes", desc: "Choose a field (price, title, tags, metafields, etc.) and set the modification — percentage, fixed amount, find & replace, and more.", icon: "⚙️" },
            { step: "3", title: "Review & Apply", desc: "Preview every change before applying. See old vs. new values, then execute with one click. Undo anytime from History.", icon: "✅" },
          ].map((s, i) => (
            <div key={i} style={{
              padding: "20px",
              borderRadius: "12px",
              backgroundColor: "#f8fafb",
              border: "1px solid #e8ecf0",
              position: "relative",
            }}>
              <div style={{
                display: "flex", alignItems: "center", gap: "10px", marginBottom: "10px",
              }}>
                <span style={{
                  display: "inline-flex", alignItems: "center", justifyContent: "center",
                  width: "28px", height: "28px", borderRadius: "50%",
                  backgroundColor: "#2c6ecb", color: "white", fontSize: "13px", fontWeight: 700,
                }}>{s.step}</span>
                <span style={{ fontWeight: 700, fontSize: "14px", color: "#202223" }}>{s.title}</span>
              </div>
              <div style={{ fontSize: "13px", color: "#637381", lineHeight: "1.5" }}>{s.desc}</div>
            </div>
          ))}
        </div>
      </s-section>

      {/* ─── QUICK ACTIONS: Button-like cards ─── */}
      <s-section heading="Quick Actions">
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "12px" }}>
          {quickActions.map((action, i) => (
            <button
              key={i}
              onClick={() => !action.locked && navigate(action.path)}
              disabled={action.locked}
              style={{
                padding: "18px 16px",
                borderRadius: "12px",
                border: i === 0 ? "2px solid #2c6ecb" : "1.5px solid #d1d5db",
                cursor: action.locked ? "not-allowed" : "pointer",
                backgroundColor: i === 0 ? "#f0f5ff" : "white",
                opacity: action.locked ? 0.5 : 1,
                transition: "all 0.15s",
                textAlign: "left",
                display: "flex",
                alignItems: "center",
                gap: "14px",
                boxShadow: i === 0 ? "0 2px 8px rgba(44,110,203,0.12)" : "0 1px 3px rgba(0,0,0,0.04)",
              }}
            >
              <span style={{
                display: "inline-flex", alignItems: "center", justifyContent: "center",
                width: "40px", height: "40px", borderRadius: "10px", fontSize: "20px", flexShrink: 0,
                backgroundColor: i === 0 ? "#2c6ecb" : "#f3f4f6",
                color: i === 0 ? "white" : undefined,
              }}>{action.icon}</span>
              <div>
                <div style={{ fontWeight: 700, fontSize: "14px", color: "#202223", marginBottom: "2px" }}>
                  {action.label}
                  {action.locked && <span style={{ fontSize: "11px", color: "#d72c0d", marginLeft: "6px" }}>PRO</span>}
                </div>
                <div style={{ fontSize: "12px", color: "#637381" }}>{action.description}</div>
              </div>
            </button>
          ))}
        </div>
      </s-section>

      {/* ─── RECENT EDITS ─── */}
      <s-section heading="Recent Bulk Edits">
        {recentEdits.length === 0 ? (
          <div style={{ padding: "24px", textAlign: "center", borderRadius: "12px", border: "1px dashed #d1d5db", backgroundColor: "#fafbfc" }}>
            <div style={{ fontSize: "14px", color: "#637381", marginBottom: "12px" }}>No bulk edits yet. Start by editing some products!</div>
            <button
              onClick={() => navigate("/app/bulk-edit")}
              style={{ padding: "10px 24px", borderRadius: "8px", border: "none", backgroundColor: "#2c6ecb", color: "white", fontSize: "14px", fontWeight: 600, cursor: "pointer" }}
            >
              Start Bulk Edit
            </button>
          </div>
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

      {/* ─── STORE OVERVIEW: Moved to bottom ─── */}
      <s-section heading="Store Overview">
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: "10px" }}>
          {statCards.map((stat, i) => (
            <div key={i} style={{
              padding: "16px",
              borderRadius: "10px",
              border: "1px solid #e8ecf0",
              backgroundColor: "#fafbfc",
            }}>
              <div style={{ fontSize: "13px", color: "#637381", marginBottom: "4px" }}>{stat.icon} {stat.label}</div>
              <div style={{ fontSize: "22px", fontWeight: 700, color: "#202223" }}>{stat.value}</div>
            </div>
          ))}
        </div>
      </s-section>

      {/* ─── PLAN BANNER ─── */}
      <s-section>
        <div style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          padding: "14px 18px",
          borderRadius: "10px",
          backgroundColor: "#f8fafb",
          border: "1px solid #e8ecf0",
          flexWrap: "wrap",
          gap: "12px",
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            <span style={{
              display: "inline-block",
              padding: "3px 10px",
              borderRadius: "6px",
              fontSize: "12px",
              fontWeight: 700,
              backgroundColor: currentPlan === "free" ? "#e4e5e7" : currentPlan === "premium" ? "#7c3aed" : "#2c6ecb",
              color: currentPlan === "free" ? "#637381" : "white",
            }}>
              {planName}
            </span>
            <span style={{ fontSize: "13px", color: "#637381" }}>
              {productsPerEdit === Infinity ? "Unlimited" : productsPerEdit} products/edit · {monthlyEdits} edits this month
            </span>
          </div>
          <button
            onClick={() => navigate("/app/billing")}
            style={{
              padding: "6px 16px",
              borderRadius: "6px",
              border: "1px solid #d1d5db",
              backgroundColor: "white",
              color: "#374151",
              fontSize: "12px",
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            {currentPlan === "free" ? "Upgrade Plan" : "Manage Plan"}
          </button>
        </div>
      </s-section>

      {/* ─── ASIDE: Connected Store ─── */}
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

      {/* ─── ASIDE: What You Can Edit ─── */}
      <s-section slot="aside" heading="What You Can Edit">
        <s-unordered-list>
          <s-list-item>Prices & Compare-at Prices</s-list-item>
          <s-list-item>Titles, Vendors, Product Types</s-list-item>
          <s-list-item>Tags (add, remove, replace)</s-list-item>
          <s-list-item>SKUs & Barcodes</s-list-item>
          <s-list-item>Status (Active/Draft/Archived)</s-list-item>
          <s-list-item>Google Shopping Custom Labels</s-list-item>
          <s-list-item>Meta/Facebook Custom Labels</s-list-item>
          <s-list-item>Custom Metafields</s-list-item>
        </s-unordered-list>
      </s-section>

      {/* ─── ASIDE: Tips ─── */}
      <s-section slot="aside" heading="Tips">
        <s-unordered-list>
          <s-list-item>
            Use <s-text fontWeight="bold">Quick Presets</s-text> for common operations like "10% off"
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
