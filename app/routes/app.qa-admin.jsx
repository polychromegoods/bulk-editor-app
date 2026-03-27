import { useLoaderData, useFetcher, useNavigate } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const ErrorBoundary = boundary.error;

/* ═══════════════════════════════════════════════════════════
   QA ADMIN — Plan & Trial Reset Tool
   Protected route for QA testers to reset billing state.
   ═══════════════════════════════════════════════════════════ */

// Helper: check if the current store is a development store
async function isDevStore(admin) {
  try {
    const response = await admin.graphql(`{ shop { plan { partnerDevelopment } } }`);
    const { data } = await response.json();
    return data?.shop?.plan?.partnerDevelopment === true;
  } catch {
    return false;
  }
}

export const loader = async ({ request }) => {
  const { session, admin } = await authenticate.admin(request);
  const shop = session.shop;

  // Only allow access on development stores
  const isDev = await isDevStore(admin);
  if (!isDev) {
    throw new Response("Not Found", { status: 404 });
  }

  // Get current shop plan
  const shopPlan = await prisma.shopPlan.findUnique({ where: { shop } });

  // Get all shop plans (for multi-store visibility)
  const allPlans = await prisma.shopPlan.findMany({
    orderBy: { updatedAt: "desc" },
    take: 20,
  });

  return { shop, shopPlan, allPlans };
};

export const action = async ({ request }) => {
  const { session, admin } = await authenticate.admin(request);
  const shop = session.shop;

  // Only allow actions on development stores
  const isDev = await isDevStore(admin);
  if (!isDev) {
    throw new Response("Not Found", { status: 404 });
  }
  const formData = await request.formData();
  const intent = formData.get("intent");
  const targetShop = formData.get("targetShop") || shop;

  try {
    if (intent === "reset_to_free") {
      await prisma.shopPlan.update({
        where: { shop: targetShop },
        data: {
          plan: "free",
          chargeId: null,
          trialUsed: false,
          monthlyEdits: 0,
          monthlyEditReset: new Date(),
        },
      });
      return { success: true, message: `${targetShop} reset to Free plan (trial flag cleared)` };
    }

    if (intent === "set_plan") {
      const plan = formData.get("plan");
      if (!["free", "unlimited", "pro", "premium"].includes(plan)) {
        return { success: false, message: "Invalid plan name" };
      }
      await prisma.shopPlan.update({
        where: { shop: targetShop },
        data: { plan },
      });
      return { success: true, message: `${targetShop} set to ${plan} plan` };
    }

    if (intent === "reset_trial") {
      await prisma.shopPlan.update({
        where: { shop: targetShop },
        data: { trialUsed: false },
      });
      return { success: true, message: `${targetShop} trial flag reset (can use trial again)` };
    }

    if (intent === "mark_trial_used") {
      await prisma.shopPlan.update({
        where: { shop: targetShop },
        data: { trialUsed: true },
      });
      return { success: true, message: `${targetShop} trial marked as used` };
    }

    if (intent === "reset_monthly_edits") {
      await prisma.shopPlan.update({
        where: { shop: targetShop },
        data: { monthlyEdits: 0, monthlyEditReset: new Date() },
      });
      return { success: true, message: `${targetShop} monthly edit counter reset to 0` };
    }

    if (intent === "full_reset") {
      await prisma.shopPlan.update({
        where: { shop: targetShop },
        data: {
          plan: "free",
          chargeId: null,
          trialUsed: false,
          monthlyEdits: 0,
          monthlyEditReset: new Date(),
        },
      });
      // Also delete all automation rules, bulk edits, and price history for this store
      await prisma.automationRule.deleteMany({ where: { shop: targetShop } });
      await prisma.bulkEdit.deleteMany({ where: { shop: targetShop } });
      await prisma.priceHistory.deleteMany({ where: { shop: targetShop } });
      await prisma.scheduledEdit.deleteMany({ where: { shop: targetShop } });
      await prisma.savedSearch.deleteMany({ where: { shop: targetShop } });
      return { success: true, message: `${targetShop} FULL RESET — plan, trial, edits, history, rules all cleared` };
    }

    return { success: false, message: "Unknown intent" };
  } catch (e) {
    return { success: false, message: `Error: ${e.message}` };
  }
};

/* ───────── Styles ───────── */
const styles = {
  card: {
    backgroundColor: "white",
    borderRadius: "12px",
    border: "1px solid #e1e3e5",
    padding: "20px",
    marginBottom: "16px",
  },
  heading: { fontSize: "16px", fontWeight: 700, color: "#202223", marginBottom: "12px" },
  subheading: { fontSize: "13px", fontWeight: 600, color: "#637381", marginBottom: "8px", textTransform: "uppercase", letterSpacing: "0.5px" },
  btn: (color = "#2c6ecb") => ({
    padding: "8px 16px",
    borderRadius: "8px",
    border: "none",
    backgroundColor: color,
    color: "white",
    fontSize: "13px",
    fontWeight: 600,
    cursor: "pointer",
    marginRight: "8px",
    marginBottom: "8px",
  }),
  btnOutline: {
    padding: "8px 16px",
    borderRadius: "8px",
    border: "1px solid #c4cdd5",
    backgroundColor: "white",
    color: "#202223",
    fontSize: "13px",
    fontWeight: 600,
    cursor: "pointer",
    marginRight: "8px",
    marginBottom: "8px",
  },
  dangerBtn: {
    padding: "8px 16px",
    borderRadius: "8px",
    border: "none",
    backgroundColor: "#d72c0d",
    color: "white",
    fontSize: "13px",
    fontWeight: 600,
    cursor: "pointer",
    marginRight: "8px",
    marginBottom: "8px",
  },
  badge: (color) => ({
    display: "inline-block",
    padding: "2px 10px",
    borderRadius: "10px",
    fontSize: "12px",
    fontWeight: 700,
    backgroundColor: color,
    color: "white",
    marginRight: "8px",
  }),
  toast: (success) => ({
    padding: "12px 16px",
    borderRadius: "8px",
    backgroundColor: success ? "#e3f1df" : "#fbeae5",
    border: `1px solid ${success ? "#95c990" : "#e0b3b2"}`,
    color: success ? "#1a7a1a" : "#d72c0d",
    fontSize: "14px",
    fontWeight: 600,
    marginBottom: "16px",
  }),
  table: {
    width: "100%",
    borderCollapse: "collapse",
    fontSize: "13px",
  },
  th: {
    textAlign: "left",
    padding: "8px 12px",
    borderBottom: "2px solid #e1e3e5",
    color: "#637381",
    fontWeight: 600,
    fontSize: "12px",
    textTransform: "uppercase",
  },
  td: {
    padding: "8px 12px",
    borderBottom: "1px solid #f1f1f1",
    color: "#202223",
  },
};

const PLAN_COLORS = {
  free: "#8c9196",
  unlimited: "#2c6ecb",
  pro: "#7c3aed",
  premium: "#d97706",
};

export default function QAAdmin() {
  const { shop, shopPlan, allPlans } = useLoaderData();
  const fetcher = useFetcher();
  const navigate = useNavigate();

  const isSubmitting = fetcher.state !== "idle";
  const result = fetcher.data;

  const submitAction = (intent, extra = {}) => {
    fetcher.submit({ intent, targetShop: shop, ...extra }, { method: "POST" });
  };

  return (
    <s-page title="QA Admin Panel">
      <s-button slot="primary-action" onClick={() => navigate("/app")}>
        Back to Dashboard
      </s-button>

      {/* Result toast */}
      {result && (
        <s-section>
          <div style={styles.toast(result.success)}>
            {result.success ? "\u2705" : "\u274c"} {result.message}
          </div>
        </s-section>
      )}

      {/* Current Store Status */}
      <s-section heading="Current Store">
        <div style={styles.card}>
          <div style={{ display: "flex", alignItems: "center", gap: "12px", marginBottom: "16px" }}>
            <span style={{ fontSize: "14px", fontWeight: 600, color: "#202223" }}>{shop}</span>
            <span style={styles.badge(PLAN_COLORS[shopPlan?.plan] || "#8c9196")}>
              {(shopPlan?.plan || "free").toUpperCase()}
            </span>
            {shopPlan?.trialUsed && <span style={styles.badge("#b98900")}>TRIAL USED</span>}
            {!shopPlan?.trialUsed && <span style={styles.badge("#008060")}>TRIAL AVAILABLE</span>}
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: "12px", marginBottom: "16px" }}>
            <div style={{ padding: "12px", backgroundColor: "#f6f6f7", borderRadius: "8px" }}>
              <div style={{ fontSize: "11px", color: "#637381", textTransform: "uppercase" }}>Plan</div>
              <div style={{ fontSize: "18px", fontWeight: 700 }}>{shopPlan?.plan || "free"}</div>
            </div>
            <div style={{ padding: "12px", backgroundColor: "#f6f6f7", borderRadius: "8px" }}>
              <div style={{ fontSize: "11px", color: "#637381", textTransform: "uppercase" }}>Monthly Edits</div>
              <div style={{ fontSize: "18px", fontWeight: 700 }}>{shopPlan?.monthlyEdits || 0}</div>
            </div>
            <div style={{ padding: "12px", backgroundColor: "#f6f6f7", borderRadius: "8px" }}>
              <div style={{ fontSize: "11px", color: "#637381", textTransform: "uppercase" }}>Trial Used</div>
              <div style={{ fontSize: "18px", fontWeight: 700 }}>{shopPlan?.trialUsed ? "Yes" : "No"}</div>
            </div>
            <div style={{ padding: "12px", backgroundColor: "#f6f6f7", borderRadius: "8px" }}>
              <div style={{ fontSize: "11px", color: "#637381", textTransform: "uppercase" }}>Charge ID</div>
              <div style={{ fontSize: "14px", fontWeight: 700, wordBreak: "break-all" }}>{shopPlan?.chargeId || "None"}</div>
            </div>
          </div>
        </div>
      </s-section>

      {/* Quick Actions */}
      <s-section heading="Quick Actions">
        <div style={styles.card}>
          <div style={styles.subheading}>Set Plan</div>
          <div style={{ marginBottom: "16px" }}>
            <button style={styles.btn("#8c9196")} onClick={() => submitAction("set_plan", { plan: "free" })} disabled={isSubmitting}>
              Set Free
            </button>
            <button style={styles.btn("#2c6ecb")} onClick={() => submitAction("set_plan", { plan: "unlimited" })} disabled={isSubmitting}>
              Set Unlimited
            </button>
            <button style={styles.btn("#7c3aed")} onClick={() => submitAction("set_plan", { plan: "pro" })} disabled={isSubmitting}>
              Set Pro
            </button>
            <button style={styles.btn("#d97706")} onClick={() => submitAction("set_plan", { plan: "premium" })} disabled={isSubmitting}>
              Set Premium
            </button>
          </div>

          <div style={styles.subheading}>Trial</div>
          <div style={{ marginBottom: "16px" }}>
            <button style={styles.btn("#008060")} onClick={() => submitAction("reset_trial")} disabled={isSubmitting}>
              Reset Trial (can use again)
            </button>
            <button style={styles.btnOutline} onClick={() => submitAction("mark_trial_used")} disabled={isSubmitting}>
              Mark Trial Used
            </button>
          </div>

          <div style={styles.subheading}>Counters</div>
          <div style={{ marginBottom: "16px" }}>
            <button style={styles.btnOutline} onClick={() => submitAction("reset_monthly_edits")} disabled={isSubmitting}>
              Reset Monthly Edit Counter
            </button>
          </div>

          <div style={styles.subheading}>Reset</div>
          <div style={{ marginBottom: "16px" }}>
            <button style={styles.btn("#2c6ecb")} onClick={() => submitAction("reset_to_free")} disabled={isSubmitting}>
              Reset to Free (clear trial + charge)
            </button>
            <button
              style={styles.dangerBtn}
              onClick={() => {
                if (confirm("This will delete ALL data for this store (plan, edits, history, rules, saved searches). Are you sure?")) {
                  submitAction("full_reset");
                }
              }}
              disabled={isSubmitting}
            >
              FULL RESET (delete all store data)
            </button>
          </div>
        </div>
      </s-section>

      {/* All Stores */}
      <s-section heading="All Stores">
        <div style={styles.card}>
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th}>Store</th>
                <th style={styles.th}>Plan</th>
                <th style={styles.th}>Trial</th>
                <th style={styles.th}>Monthly Edits</th>
                <th style={styles.th}>Charge ID</th>
                <th style={styles.th}>Updated</th>
              </tr>
            </thead>
            <tbody>
              {allPlans.map((p) => (
                <tr key={p.id}>
                  <td style={{ ...styles.td, fontWeight: p.shop === shop ? 700 : 400 }}>
                    {p.shop}
                    {p.shop === shop && <span style={{ fontSize: "11px", color: "#637381" }}> (current)</span>}
                  </td>
                  <td style={styles.td}>
                    <span style={styles.badge(PLAN_COLORS[p.plan] || "#8c9196")}>{p.plan.toUpperCase()}</span>
                  </td>
                  <td style={styles.td}>{p.trialUsed ? "Used" : "Available"}</td>
                  <td style={styles.td}>{p.monthlyEdits}</td>
                  <td style={{ ...styles.td, fontSize: "11px", maxWidth: "120px", overflow: "hidden", textOverflow: "ellipsis" }}>{p.chargeId || "—"}</td>
                  <td style={{ ...styles.td, fontSize: "12px", color: "#637381" }}>{new Date(p.updatedAt).toLocaleDateString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </s-section>

      {/* Instructions */}
      <s-section heading="Testing Instructions">
        <div style={styles.card}>
          <div style={{ fontSize: "14px", color: "#202223", lineHeight: "1.6" }}>
            <p style={{ marginBottom: "12px" }}><strong>How to test billing tiers:</strong></p>
            <ol style={{ paddingLeft: "20px", marginBottom: "16px" }}>
              <li style={{ marginBottom: "6px" }}>Use <strong>Set Plan</strong> buttons above to switch between tiers instantly (bypasses Shopify billing)</li>
              <li style={{ marginBottom: "6px" }}>Test feature gating: Free = 15 products max, no automations. Unlimited = unlimited products, no automations. Pro = unlimited + 3 automations. Premium = unlimited everything.</li>
              <li style={{ marginBottom: "6px" }}>To test the actual Shopify billing flow (subscribe button, trial, approval screen), use <strong>Reset to Free</strong> first, then go to the Billing page and subscribe normally.</li>
              <li style={{ marginBottom: "6px" }}>To re-test trials, click <strong>Reset Trial</strong> — this lets the store use the 7-day trial again.</li>
              <li style={{ marginBottom: "6px" }}><strong>FULL RESET</strong> deletes everything (plan, edits, history, rules) — use for a completely clean slate.</li>
            </ol>
            <p style={{ fontSize: "13px", color: "#637381" }}>
              Note: "Set Plan" changes the database directly without going through Shopify billing. 
              This is useful for testing feature gating, but the Shopify admin billing page won't reflect the change.
              To test the full billing flow, always start from Free and use the in-app Subscribe button.
            </p>
          </div>
        </div>
      </s-section>
    </s-page>
  );
}
