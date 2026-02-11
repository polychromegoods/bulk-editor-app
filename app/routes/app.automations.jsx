import { useState, useEffect, useCallback } from "react";
import { useLoaderData, useFetcher, useNavigate } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  let shopPlan = await prisma.shopPlan.findUnique({ where: { shop } });
  if (!shopPlan) {
    shopPlan = await prisma.shopPlan.create({ data: { shop } });
  }

  const rules = await prisma.automationRule.findMany({
    where: { shop },
    orderBy: { createdAt: "desc" },
  });

  return { rules, currentPlan: shopPlan.plan || "free" };
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  // Check plan
  const shopPlan = await prisma.shopPlan.findUnique({ where: { shop } });
  if (!shopPlan || shopPlan.plan !== "plus") {
    return { error: "Automations require the Plus plan." };
  }

  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "create_rule") {
    const name = formData.get("name");
    const conditions = formData.get("conditions");
    const actions = formData.get("actions");

    const rule = await prisma.automationRule.create({
      data: {
        shop,
        name,
        conditions: conditions || "[]",
        actions: actions || "[]",
      },
    });

    return { success: true, rule };
  }

  if (intent === "toggle_rule") {
    const ruleId = formData.get("ruleId");
    const rule = await prisma.automationRule.findUnique({ where: { id: ruleId } });
    if (rule && rule.shop === shop) {
      await prisma.automationRule.update({
        where: { id: ruleId },
        data: { enabled: !rule.enabled },
      });
    }
    return { success: true };
  }

  if (intent === "delete_rule") {
    const ruleId = formData.get("ruleId");
    const rule = await prisma.automationRule.findUnique({ where: { id: ruleId } });
    if (rule && rule.shop === shop) {
      await prisma.automationRule.delete({ where: { id: ruleId } });
    }
    return { success: true };
  }

  return { error: "Unknown intent" };
};

export default function Automations() {
  const { rules, currentPlan } = useLoaderData();
  const fetcher = useFetcher();
  const shopify = useAppBridge();
  const navigate = useNavigate();

  const [showCreate, setShowCreate] = useState(false);
  const [ruleName, setRuleName] = useState("");
  const [conditionType, setConditionType] = useState("tag");
  const [conditionValue, setConditionValue] = useState("");
  const [actionType, setActionType] = useState("percentage");
  const [actionValue, setActionValue] = useState("");
  const [actionField, setActionField] = useState("price");

  const isSubmitting = fetcher.state === "submitting";
  const isLocked = currentPlan !== "plus";

  useEffect(() => {
    if (fetcher.data?.success) {
      shopify.toast.show("Automation rule updated!");
      setShowCreate(false);
      setRuleName("");
      setConditionValue("");
      setActionValue("");
    }
    if (fetcher.data?.error) {
      shopify.toast.show(fetcher.data.error, { isError: true });
    }
  }, [fetcher.data, shopify]);

  const handleCreateRule = useCallback(() => {
    if (!ruleName || !conditionValue || !actionValue) return;

    const conditions = JSON.stringify([
      { type: conditionType, value: conditionValue },
    ]);
    const actions = JSON.stringify([
      { type: actionType, value: actionValue, field: actionField },
    ]);

    fetcher.submit(
      { intent: "create_rule", name: ruleName, conditions, actions },
      { method: "POST" }
    );
  }, [ruleName, conditionType, conditionValue, actionType, actionValue, actionField, fetcher]);

  // Plan gate: show upgrade prompt for non-Plus users
  if (isLocked) {
    return (
      <s-page heading="Automation Rules">
        <s-section>
          <div style={{
            textAlign: "center",
            padding: "60px 24px",
            borderRadius: "16px",
            border: "1px solid #e1e3e5",
            backgroundColor: "#fafbfb",
          }}>
            <div style={{ fontSize: "48px", marginBottom: "16px" }}>🤖</div>
            <div style={{ fontSize: "22px", fontWeight: 800, color: "#202223", marginBottom: "8px" }}>
              Automation Rules
            </div>
            <div style={{ fontSize: "15px", color: "#637381", marginBottom: "8px", maxWidth: "500px", margin: "0 auto 8px" }}>
              Automatically adjust prices when products match certain conditions. Set rules like "Tag 'sale' → 20% off" and let the app handle it.
            </div>
            <div style={{ fontSize: "14px", color: "#637381", marginBottom: "24px" }}>
              Available on the <strong>Plus plan</strong> ($19.99/month).
            </div>
            <div style={{ display: "flex", gap: "12px", justifyContent: "center", flexWrap: "wrap" }}>
              <button
                onClick={() => navigate("/app/billing")}
                style={{
                  padding: "12px 32px",
                  borderRadius: "8px",
                  border: "none",
                  backgroundColor: "#7c3aed",
                  color: "white",
                  fontWeight: 700,
                  fontSize: "14px",
                  cursor: "pointer",
                }}
              >
                Upgrade to Plus →
              </button>
              <button
                onClick={() => navigate("/app/billing")}
                style={{
                  padding: "12px 32px",
                  borderRadius: "8px",
                  border: "1px solid #c4cdd5",
                  backgroundColor: "white",
                  color: "#637381",
                  fontWeight: 600,
                  fontSize: "14px",
                  cursor: "pointer",
                }}
              >
                Compare Plans
              </button>
            </div>

            {/* Feature preview */}
            <div style={{ marginTop: "40px", textAlign: "left", maxWidth: "480px", margin: "40px auto 0" }}>
              <div style={{ fontWeight: 700, fontSize: "14px", color: "#202223", marginBottom: "12px" }}>What you can do with automations:</div>
              {[
                { icon: "🏷️", text: "Auto-discount products by tag (e.g., 'clearance' → 30% off)" },
                { icon: "🏪", text: "Set vendor-specific pricing rules" },
                { icon: "📝", text: "Apply rules when product titles contain keywords" },
                { icon: "📦", text: "Adjust prices by product type" },
                { icon: "⚡", text: "Rules run automatically when products are created or updated" },
              ].map((item, i) => (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: "10px", padding: "8px 0", fontSize: "13px", color: "#637381" }}>
                  <span style={{ fontSize: "16px" }}>{item.icon}</span>
                  <span>{item.text}</span>
                </div>
              ))}
            </div>
          </div>
        </s-section>
      </s-page>
    );
  }

  return (
    <s-page heading="Automation Rules">
      <s-button
        slot="primary-action"
        onClick={() => setShowCreate(!showCreate)}
      >
        {showCreate ? "Cancel" : "Create Rule"}
      </s-button>

      <s-section>
        <s-paragraph>
          <s-text>
            Automation rules automatically adjust prices when products match
            certain conditions. Rules run when products are created or updated
            via webhooks.
          </s-text>
        </s-paragraph>
      </s-section>

      {/* Create Rule Form */}
      {showCreate && (
        <s-section heading="New Automation Rule">
          <s-stack direction="block" gap="base">
            <s-text-field
              label="Rule Name"
              placeholder="e.g., Tag 'sale' → 20% off"
              value={ruleName}
              onInput={(e) => setRuleName(e.target.value)}
            />
            <s-heading>Condition (When)</s-heading>
            <s-stack direction="inline" gap="base">
              <s-select
                label="Condition Type"
                value={conditionType}
                onChange={(e) => setConditionType(e.target.value)}
              >
                <option value="tag">Product has tag</option>
                <option value="type">Product type is</option>
                <option value="vendor">Vendor is</option>
                <option value="title_contains">Title contains</option>
              </s-select>
              <s-text-field
                label="Value"
                placeholder={
                  conditionType === "tag"
                    ? "sale"
                    : conditionType === "type"
                    ? "T-Shirt"
                    : conditionType === "vendor"
                    ? "Nike"
                    : "keyword"
                }
                value={conditionValue}
                onInput={(e) => setConditionValue(e.target.value)}
              />
            </s-stack>
            <s-heading>Action (Then)</s-heading>
            <s-stack direction="inline" gap="base">
              <s-select
                label="Field"
                value={actionField}
                onChange={(e) => setActionField(e.target.value)}
              >
                <option value="price">Price</option>
                <option value="compareAtPrice">Compare-at Price</option>
              </s-select>
              <s-select
                label="Action Type"
                value={actionType}
                onChange={(e) => setActionType(e.target.value)}
              >
                <option value="percentage">Change by Percentage</option>
                <option value="fixed">Change by Fixed Amount</option>
                <option value="set">Set to Exact Price</option>
              </s-select>
              <s-text-field
                label="Value"
                type="number"
                placeholder={
                  actionType === "percentage"
                    ? "-20"
                    : actionType === "fixed"
                    ? "-5.00"
                    : "29.99"
                }
                value={actionValue}
                onInput={(e) => setActionValue(e.target.value)}
              />
            </s-stack>
            <s-button
              variant="primary"
              onClick={handleCreateRule}
              {...(isSubmitting ? { loading: true } : {})}
            >
              Create Rule
            </s-button>
          </s-stack>
        </s-section>
      )}

      {/* Rules List */}
      <s-section heading={`Rules (${rules.length})`}>
        {rules.length === 0 ? (
          <s-box padding="loose" borderWidth="base" borderRadius="base">
            <s-stack direction="block" gap="base" align="center">
              <s-text tone="subdued">
                No automation rules yet. Create one to automatically adjust
                prices based on product conditions.
              </s-text>
            </s-stack>
          </s-box>
        ) : (
          <s-section padding="none">
            <s-table>
              <s-table-header-row>
                <s-table-header>Rule Name</s-table-header>
                <s-table-header>Condition</s-table-header>
                <s-table-header>Action</s-table-header>
                <s-table-header>Status</s-table-header>
                <s-table-header format="numeric">Runs</s-table-header>
                <s-table-header>Controls</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {rules.map((rule) => {
                  let conditions, actions;
                  try {
                    conditions = JSON.parse(rule.conditions);
                    actions = JSON.parse(rule.actions);
                  } catch {
                    conditions = [];
                    actions = [];
                  }
                  const cond = conditions[0] || {};
                  const act = actions[0] || {};
                  return (
                    <s-table-row key={rule.id}>
                      <s-table-cell>
                        <s-text fontWeight="bold">{rule.name}</s-text>
                      </s-table-cell>
                      <s-table-cell>
                        {cond.type === "tag"
                          ? `Has tag "${cond.value}"`
                          : cond.type === "type"
                          ? `Type is "${cond.value}"`
                          : cond.type === "vendor"
                          ? `Vendor is "${cond.value}"`
                          : cond.type === "title_contains"
                          ? `Title contains "${cond.value}"`
                          : "—"}
                      </s-table-cell>
                      <s-table-cell>
                        {act.type === "percentage"
                          ? `${act.value}% on ${act.field || "price"}`
                          : act.type === "fixed"
                          ? `$${act.value} on ${act.field || "price"}`
                          : act.type === "set"
                          ? `Set ${act.field || "price"} to $${act.value}`
                          : "—"}
                      </s-table-cell>
                      <s-table-cell>
                        <s-badge tone={rule.enabled ? "success" : "info"}>
                          {rule.enabled ? "Active" : "Paused"}
                        </s-badge>
                      </s-table-cell>
                      <s-table-cell>{rule.runCount}</s-table-cell>
                      <s-table-cell>
                        <s-stack direction="inline" gap="tight">
                          <s-button
                            variant="tertiary"
                            size="slim"
                            onClick={() =>
                              fetcher.submit(
                                { intent: "toggle_rule", ruleId: rule.id },
                                { method: "POST" }
                              )
                            }
                          >
                            {rule.enabled ? "Pause" : "Enable"}
                          </s-button>
                          <s-button
                            variant="tertiary"
                            tone="critical"
                            size="slim"
                            onClick={() =>
                              fetcher.submit(
                                { intent: "delete_rule", ruleId: rule.id },
                                { method: "POST" }
                              )
                            }
                          >
                            Delete
                          </s-button>
                        </s-stack>
                      </s-table-cell>
                    </s-table-row>
                  );
                })}
              </s-table-body>
            </s-table>
          </s-section>
        )}
      </s-section>
    </s-page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
