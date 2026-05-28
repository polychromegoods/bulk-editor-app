import { useState, useEffect, useMemo } from "react";
import { useLoaderData, useFetcher, useNavigate, useRouteError, isRouteErrorResponse } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;

  let shopPlan = await prisma.shopPlan.findUnique({ where: { shop } });
  if (!shopPlan) {
    shopPlan = await prisma.shopPlan.create({ data: { shop } });
  }
  const plan = shopPlan.plan || "free";

  // Fetch products for filter preview (wrapped in try/catch to prevent 500 crashes)
  let products = [];
  try {
    const response = await admin.graphql(
      `#graphql
      query ($first: Int!) {
        products(first: $first) {
          edges {
            node {
              id
              title
              handle
              status
              productType
              vendor
              tags
              featuredMedia {
                preview {
                  image {
                    url
                    altText
                  }
                }
              }
              variants(first: 100) {
                edges {
                  node {
                    id
                    title
                    price
                    compareAtPrice
                    sku
                    barcode
                    inventoryQuantity
                  }
                }
              }
            }
          }
        }
      }`,
      { variables: { first: 250 } }
    );
    const data = await response.json();
    products = (data.data?.products?.edges || []).map((e) => e.node);
  } catch (err) {
    console.error("[Automations] Failed to fetch products:", err.message);
    // Continue with empty products — the page can still load and show rules
  }

  let rules = [];
    try {
    const rawRules = await prisma.automationRule.findMany({
      where: { shop },
      orderBy: { createdAt: "desc" },
    });
    // Serialize dates to ISO strings to prevent React Router serialization errors
    rules = rawRules.map(r => ({
      ...r,
      createdAt: r.createdAt?.toISOString(),
      updatedAt: r.updatedAt?.toISOString(),
      lastRun: r.lastRun?.toISOString() || null,
    }));
  } catch (err) {
    console.error("[Automations] Failed to fetch rules:", err.message);
  }
  return { products, rules, currentPlan: plan };
};

// Allow revalidation after mutations so the rules list refreshes.
// The loader has proper try/catch error handling to prevent crashes.
export function shouldRevalidate({ defaultShouldRevalidate }) {
  return defaultShouldRevalidate;
}

export const action = async ({ request }) => {
  let session;
  try {
    ({ session } = await authenticate.admin(request));
  } catch (authErr) {
    console.error("[Automations] Authentication failed:", authErr.message);
    return { error: "Authentication failed. Please reload the page and try again." };
  }
  const shop = session.shop;

  const shopPlan = await prisma.shopPlan.findUnique({ where: { shop } });
  const plan = shopPlan?.plan || "free";
  if (plan !== "pro" && plan !== "premium") {
    return { error: "Automation rules require the Pro or Premium Pro plan." };
  }

  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "create_rule") {
    // Enforce automation limit for Pro plan (max 3 rules)
    if (plan === "pro") {
      const existingRules = await prisma.automationRule.count({ where: { shop } });
      if (existingRules >= 3) {
        return { error: "Pro plan allows up to 3 automation rules. Upgrade to Premium Pro for unlimited rules." };
      }
    }

    const name = formData.get("name");
    const filterRules = formData.get("filterRules") || "[]";
    const modifications = formData.get("modifications") || "[]";
    const trigger = formData.get("trigger") || "product_updated_or_created";

    try {
      const rule = await prisma.automationRule.create({
        data: {
          shop,
          name: name || "Untitled Rule",
          enabled: true,
          conditions: filterRules,
          actions: modifications,
          trigger,
        },
      });
      // Serialize dates to ISO strings to prevent React Router serialization errors
      return { success: true, rule: { ...rule, createdAt: rule.createdAt?.toISOString(), updatedAt: rule.updatedAt?.toISOString(), lastRun: rule.lastRun?.toISOString() || null } };
    } catch (dbErr) {
      console.error("[Automations] Failed to create rule:", dbErr.message);
      return { error: "Failed to save automation rule. Please try again." };
    }
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

  return { success: false };
};

/* ═══════════════════════════════════════════════════════════════
   FIELD DEFINITIONS (same as bulk edit)
   ═══════════════════════════════════════════════════════════════ */
const EDITABLE_FIELDS = [
  { value: "price", label: "Price", icon: "💰", category: "numeric", level: "variant", accessor: (v) => v.price },
  { value: "compareAtPrice", label: "Compare-at Price", icon: "🏷", category: "numeric", level: "variant", accessor: (v) => v.compareAtPrice },
  { value: "sku", label: "SKU", icon: "🔢", category: "text", level: "variant", accessor: (v) => v.sku || "" },
  { value: "barcode", label: "Barcode", icon: "📊", category: "text", level: "variant", accessor: (v) => v.barcode || "" },
  { value: "title", label: "Title", icon: "📝", category: "text", level: "product", accessor: null },
  { value: "vendor", label: "Vendor", icon: "🏢", category: "text", level: "product", accessor: null },
  { value: "productType", label: "Product Type", icon: "📂", category: "text", level: "product", accessor: null },
  { value: "tags", label: "Tags", icon: "🏷️", category: "tags", level: "product", accessor: null },
  { value: "status", label: "Status", icon: "🔄", category: "select", level: "product", accessor: null, options: ["ACTIVE", "DRAFT", "ARCHIVED"] },
];

const NUMERIC_CHANGE_TYPES = [
  { value: "exact", label: "Set to exact value" },
  { value: "increase_percent", label: "Increase by percentage (%)" },
  { value: "decrease_percent", label: "Decrease by percentage (%)" },
  { value: "increase_fixed", label: "Increase by fixed amount" },
  { value: "decrease_fixed", label: "Decrease by fixed amount" },
];
const TEXT_CHANGE_TYPES = [
  { value: "set", label: "Set to value" },
  { value: "prepend", label: "Prepend text" },
  { value: "append", label: "Append text" },
  { value: "find_replace", label: "Find & Replace" },
];
const TAG_CHANGE_TYPES = [
  { value: "add", label: "Add tags" },
  { value: "remove", label: "Remove tags" },
  { value: "set", label: "Replace all tags" },
];
const SELECT_CHANGE_TYPES = [
  { value: "set", label: "Set to" },
];

function getChangeTypes(fieldValue) {
  const field = EDITABLE_FIELDS.find((f) => f.value === fieldValue);
  if (!field) return NUMERIC_CHANGE_TYPES;
  if (field.category === "numeric") return NUMERIC_CHANGE_TYPES;
  if (field.category === "text") return TEXT_CHANGE_TYPES;
  if (field.category === "tags") return TAG_CHANGE_TYPES;
  if (field.category === "select") return SELECT_CHANGE_TYPES;
  return NUMERIC_CHANGE_TYPES;
}
function getFieldDef(fieldValue) {
  return EDITABLE_FIELDS.find((f) => f.value === fieldValue);
}

/* ═══════════════════════════════════════════════════════════════
   FILTER DEFINITIONS (same as bulk edit)
   ═══════════════════════════════════════════════════════════════ */
const FILTER_FIELDS = [
  { value: "title", label: "Title", type: "text" },
  { value: "vendor", label: "Vendor", type: "text" },
  { value: "productType", label: "Product Type", type: "text" },
  { value: "status", label: "Status", type: "select", options: ["ACTIVE", "DRAFT", "ARCHIVED"] },
  { value: "tags", label: "Tags", type: "text" },
  { value: "sku", label: "SKU", type: "text" },
  { value: "price", label: "Price", type: "number" },
  { value: "compareAtPrice", label: "Compare-at Price", type: "number" },
  { value: "inventoryQuantity", label: "Inventory", type: "number" },
];

function getOperatorsForField(fieldValue) {
  const field = FILTER_FIELDS.find((f) => f.value === fieldValue);
  if (!field) return [{ value: "contains", label: "contains" }];
  if (field.type === "number") {
    return [
      { value: "equals", label: "equals" },
      { value: "not_equals", label: "does not equal" },
      { value: "greater_than", label: "greater than" },
      { value: "less_than", label: "less than" },
      { value: "greater_or_equal", label: "greater or equal" },
      { value: "less_or_equal", label: "less or equal" },
      { value: "between", label: "between" },
    ];
  }
  if (field.type === "select") {
    return [
      { value: "equals", label: "is" },
      { value: "not_equals", label: "is not" },
    ];
  }
  return [
    { value: "contains", label: "contains" },
    { value: "not_contains", label: "does not contain" },
    { value: "equals", label: "equals" },
    { value: "not_equals", label: "does not equal" },
    { value: "starts_with", label: "starts with" },
    { value: "ends_with", label: "ends with" },
    { value: "is_empty", label: "is empty" },
    { value: "is_not_empty", label: "is not empty" },
  ];
}

function evaluateFilter(product, rule) {
  let value;
  if (rule.field === "price" || rule.field === "compareAtPrice" || rule.field === "sku" || rule.field === "barcode" || rule.field === "inventoryQuantity") {
    const variants = product.variants?.edges?.map((e) => e.node) || [];
    return variants.some((v) => {
      const vv = String(v[rule.field] || "");
      return matchValue(vv, rule);
    });
  }
  if (rule.field === "tags") {
    value = (product.tags || []).join(", ");
  } else {
    value = product[rule.field] || "";
  }
  return matchValue(String(value), rule);
}

function matchValue(value, rule) {
  const v = value.toLowerCase();
  const rv = String(rule.value || "").toLowerCase();
  const rv2 = String(rule.value2 || "").toLowerCase();
  switch (rule.operator) {
    case "contains": return v.includes(rv);
    case "not_contains": return !v.includes(rv);
    case "equals": return rule.field === "price" || rule.field === "compareAtPrice" || rule.field === "inventoryQuantity"
      ? parseFloat(value) === parseFloat(rule.value) : v === rv;
    case "not_equals": return rule.field === "price" || rule.field === "compareAtPrice" || rule.field === "inventoryQuantity"
      ? parseFloat(value) !== parseFloat(rule.value) : v !== rv;
    case "starts_with": return v.startsWith(rv);
    case "ends_with": return v.endsWith(rv);
    case "is_empty": return !value || value === "";
    case "is_not_empty": return value && value !== "";
    case "greater_than": return parseFloat(value) > parseFloat(rule.value);
    case "less_than": return parseFloat(value) < parseFloat(rule.value);
    case "greater_or_equal": return parseFloat(value) >= parseFloat(rule.value);
    case "less_or_equal": return parseFloat(value) <= parseFloat(rule.value);
    case "between": return parseFloat(value) >= parseFloat(rule.value) && parseFloat(value) <= parseFloat(rv2);
    default: return true;
  }
}

/* ═══════════════════════════════════════════════════════════════
   TRIGGER OPTIONS
   ═══════════════════════════════════════════════════════════════ */
const TRIGGER_OPTIONS = [
  { value: "product_updated_or_created", label: "When a product is updated or created" },
  { value: "product_created", label: "When a product is created" },
];

function getTriggerLabel(triggerValue) {
  const opt = TRIGGER_OPTIONS.find((t) => t.value === triggerValue);
  return opt ? opt.label : "When a product is updated or created";
}

/* ═══════════════════════════════════════════════════════════════
   STYLES
   ═══════════════════════════════════════════════════════════════ */
const styles = {
  input: { width: "100%", padding: "10px 12px", borderRadius: "8px", border: "1px solid #c4cdd5", fontSize: "14px", outline: "none", boxSizing: "border-box" },
  select: { width: "100%", padding: "10px 12px", borderRadius: "8px", border: "1px solid #c4cdd5", fontSize: "14px", outline: "none", backgroundColor: "white", boxSizing: "border-box", appearance: "auto", WebkitAppearance: "auto" },
  primaryBtn: (enabled) => ({
    padding: "10px 24px", borderRadius: "8px", border: "none",
    backgroundColor: enabled ? "#2c6ecb" : "#c4cdd5", color: "white",
    fontSize: "14px", fontWeight: "600", cursor: enabled ? "pointer" : "default", transition: "all 0.15s",
  }),
  secondaryBtn: { padding: "10px 24px", borderRadius: "8px", border: "1px solid #c4cdd5", backgroundColor: "white", fontSize: "14px", cursor: "pointer", transition: "all 0.15s" },
  dangerBtn: (enabled) => ({
    padding: "10px 24px", borderRadius: "8px", border: "none",
    backgroundColor: enabled ? "#d72c0d" : "#c4cdd5", color: "white",
    fontSize: "14px", fontWeight: "600", cursor: enabled ? "pointer" : "default",
  }),
  card: { border: "1px solid #e1e3e5", borderRadius: "12px", padding: "16px", marginBottom: "12px", backgroundColor: "white" },
  filterRule: { display: "flex", gap: "8px", alignItems: "center", padding: "8px 12px", backgroundColor: "#f9fafb", borderRadius: "8px", marginBottom: "6px", border: "1px solid #e1e3e5", flexWrap: "wrap" },
  badge: (tone) => ({
    display: "inline-block", padding: "2px 8px", borderRadius: "10px", fontSize: "11px", fontWeight: "600",
    backgroundColor: tone === "success" ? "#e3f1df" : tone === "critical" ? "#fef3f2" : tone === "warning" ? "#fef8e8" : "#e4e5e7",
    color: tone === "success" ? "#1a7f37" : tone === "critical" ? "#d72c0d" : tone === "warning" ? "#916a00" : "#637381",
  }),
  sectionTitle: { fontSize: "14px", fontWeight: 700, color: "#202223", marginBottom: "12px" },
  sectionDesc: { fontSize: "13px", color: "#637381", marginBottom: "16px" },
  formField: { marginBottom: "20px" },
  label: { fontSize: "13px", fontWeight: 600, color: "#202223", marginBottom: "6px", display: "block" },
};

/* ═══════════════════════════════════════════════════════════════
   COMPONENT
   ═══════════════════════════════════════════════════════════════ */
export default function Automations() {
  const { products, rules, currentPlan } = useLoaderData();
  const fetcher = useFetcher();
  const navigate = useNavigate();
  const shopify = useAppBridge();

  // Views: "landing" | "creator"
  const [view, setView] = useState("landing");

  // Rule form state (single-page form)
  const [ruleName, setRuleName] = useState("");
  const [ruleEnabled, setRuleEnabled] = useState(true);
  const [trigger, setTrigger] = useState("product_updated_or_created");
  const [filterRules, setFilterRules] = useState([]);
  const [modifications, setModifications] = useState([]);

  const isSubmitting = fetcher.state !== "idle";
  const actionData = fetcher.data;

  // Reset form after successful creation
  useEffect(() => {
    if (actionData?.success && actionData?.rule) {
      setView("landing");
      resetForm();
      shopify.toast.show("Rule created successfully!");
    }
    if (actionData?.error) {
      shopify.toast.show(actionData.error, { isError: true });
    }
  }, [actionData]);

  const resetForm = () => {
    setRuleName("");
    setRuleEnabled(true);
    setTrigger("product_updated_or_created");
    setFilterRules([]);
    setModifications([]);
  };

  // Plan gating
  if (currentPlan !== "pro" && currentPlan !== "premium") {
    return (
      <s-page title="Automations">
        <s-section>
          <s-box padding="loose">
            <div style={{ textAlign: "center", padding: "40px 20px" }}>
              <div style={{ fontSize: "48px", marginBottom: "16px" }}>🤖</div>
              <div style={{ fontSize: "20px", fontWeight: 700, marginBottom: "8px" }}>Automation Rules</div>
              <div style={{ fontSize: "14px", color: "#637381", marginBottom: "24px", maxWidth: "480px", margin: "0 auto 24px" }}>
                Automation rules automatically adjust product data when products are created or updated.
                Set conditions and actions once — they run automatically via webhooks.
              </div>
              <div style={{ padding: "16px", backgroundColor: "#fef8e8", borderRadius: "12px", marginBottom: "24px", maxWidth: "400px", margin: "0 auto 24px" }}>
                <div style={{ fontSize: "14px", fontWeight: 600, color: "#916a00" }}>Pro Plan Required</div>
                <div style={{ fontSize: "13px", color: "#916a00", marginTop: "4px" }}>Upgrade to Pro ($14.99/mo) for up to 3 automation rules, or Premium Pro ($24.99/mo) for unlimited.</div>
              </div>
              <button style={styles.primaryBtn(true)} onClick={() => navigate("/app/billing")}>
                View Plans
              </button>
            </div>
          </s-box>
        </s-section>
      </s-page>
    );
  }

  // ── Filter rule management ──
  const addFilterRule = () => {
    setFilterRules((prev) => [...prev, { id: Date.now(), field: "title", operator: "contains", value: "", value2: "" }]);
  };
  const updateFilterRule = (id, key, val) => {
    setFilterRules((prev) =>
      prev.map((r) => {
        if (r.id !== id) return r;
        const updated = { ...r, [key]: val };
        if (key === "field") {
          const ops = getOperatorsForField(val);
          updated.operator = ops[0]?.value || "contains";
          updated.value = "";
          updated.value2 = "";
        }
        if (key === "operator" && ["is_empty", "is_not_empty"].includes(val)) {
          updated.value = "";
          updated.value2 = "";
        }
        return updated;
      })
    );
  };
  const removeFilterRule = (id) => setFilterRules((prev) => prev.filter((r) => r.id !== id));

  // Filtered products (preview of what this rule would match)
  const matchedProducts = useMemo(() => {
    if (filterRules.length === 0) return products;
    return products.filter((p) => {
      for (const rule of filterRules) {
        if (!rule.value && !["is_empty", "is_not_empty"].includes(rule.operator)) continue;
        if (!evaluateFilter(p, rule)) return false;
      }
      return true;
    });
  }, [products, filterRules]);

  // ── Modification management ──
  const addMod = () =>
    setModifications((prev) => [
      ...prev,
      { id: Date.now(), field: "price", type: "exact", value: "", value2: "", rounding: "none" },
    ]);
  const updateMod = (id, key, val) =>
    setModifications((prev) =>
      prev.map((m) => {
        if (m.id !== id) return m;
        const updated = { ...m, [key]: val };
        if (key === "field") {
          const types = getChangeTypes(val);
          updated.type = types[0]?.value || "exact";
          updated.value = "";
          updated.value2 = "";
          updated.rounding = "none";
        }
        return updated;
      })
    );
  const removeMod = (id) => setModifications((prev) => prev.filter((m) => m.id !== id));

  const handleSaveRule = () => {
    if (!ruleName.trim()) {
      shopify.toast.show("Please enter a rule name", { isError: true });
      return;
    }
    if (filterRules.length === 0) {
      shopify.toast.show("Please add at least one search parameter", { isError: true });
      return;
    }
    if (modifications.length === 0) {
      shopify.toast.show("Please add at least one modification", { isError: true });
      return;
    }
    fetcher.submit(
      {
        intent: "create_rule",
        name: ruleName,
        trigger,
        filterRules: JSON.stringify(filterRules),
        modifications: JSON.stringify(modifications),
      },
      { method: "POST" }
    );
  };

  // Parse existing rule data for display
  const parseRuleDisplay = (rule) => {
    let conditions = [];
    let actions = [];
    try { conditions = JSON.parse(rule.conditions); } catch {}
    try { actions = JSON.parse(rule.actions); } catch {}
    return { conditions, actions };
  };

  /* ════════════════════════════════════════════════════════════════
     LANDING VIEW — "Product data" category with "Product rules"
     ════════════════════════════════════════════════════════════════ */
  if (view === "landing") {
    return (
      <s-page title="Automations">
        {/* Category header */}
        <s-section>
          <s-box padding="base">
            <div style={{ marginBottom: "20px" }}>
              <div style={{ fontSize: "13px", color: "#637381", textTransform: "uppercase", letterSpacing: "0.5px", fontWeight: 600, marginBottom: "8px" }}>Product data</div>
              <div style={{ fontSize: "13px", color: "#637381" }}>
                Automatically update product information when products are created or updated in your store.
              </div>
            </div>

            {/* Product rules card */}
            <div style={{ border: "1px solid #e1e3e5", borderRadius: "12px", padding: "20px", backgroundColor: "white", display: "flex", alignItems: "center", gap: "16px", cursor: "pointer", transition: "border-color 0.15s" }} onClick={() => setView("creator")}>
              <div style={{ width: "48px", height: "48px", borderRadius: "10px", backgroundColor: "#f0f5ff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "24px", flexShrink: 0 }}>
                📋
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: "15px", fontWeight: 700, color: "#202223", marginBottom: "4px" }}>Product rules</div>
                <div style={{ fontSize: "13px", color: "#637381" }}>
                  Create rules that automatically modify product data when products match specific conditions.
                </div>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: "12px", flexShrink: 0 }}>
                {rules.length > 0 && (
                  <span style={{ fontSize: "13px", color: "#637381", fontWeight: 500 }}>{rules.length} rule{rules.length !== 1 ? "s" : ""}</span>
                )}
                <button style={styles.primaryBtn(true)} onClick={(e) => { e.stopPropagation(); setView("creator"); }}>
                  Create rule
                </button>
              </div>
            </div>
          </s-box>
        </s-section>

        {/* ════════════════════ EXISTING RULES LIST ════════════════════ */}
        {rules.length > 0 && (
          <s-section heading={`Your rules (${rules.length})`}>
            <s-box padding="base">
              {rules.map((rule) => {
                const { conditions, actions } = parseRuleDisplay(rule);
                return (
                  <div key={rule.id} style={{ ...styles.card, display: "flex", alignItems: "flex-start", gap: "16px" }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "6px" }}>
                        <div style={{ fontSize: "15px", fontWeight: 700, color: "#202223" }}>{rule.name}</div>
                        <span style={styles.badge(rule.enabled ? "success" : "info")}>
                          {rule.enabled ? "Active" : "Paused"}
                        </span>
                      </div>
                      {/* Trigger info */}
                      <div style={{ fontSize: "12px", color: "#2c6ecb", fontWeight: 500, marginBottom: "6px", display: "flex", alignItems: "center", gap: "4px" }}>
                        <span>⚡</span> {getTriggerLabel(rule.trigger || "product_updated_or_created")}
                      </div>
                      <div style={{ fontSize: "13px", color: "#637381", marginBottom: "4px" }}>
                        <strong>When:</strong>{" "}
                        {conditions.map((c, i) => {
                          const fieldDef = FILTER_FIELDS.find((f) => f.value === c.field);
                          const opDef = getOperatorsForField(c.field).find((o) => o.value === c.operator);
                          return (
                            <span key={i}>
                              {i > 0 && " AND "}
                              {fieldDef?.label || c.field} {opDef?.label || c.operator} "{c.value}"
                            </span>
                          );
                        })}
                        {conditions.length === 0 && "All products"}
                      </div>
                      <div style={{ fontSize: "13px", color: "#637381", marginBottom: "4px" }}>
                        <strong>Then:</strong>{" "}
                        {actions.map((a, i) => {
                          const fieldDef = getFieldDef(a.field);
                          const typeDef = getChangeTypes(a.field).find((ct) => ct.value === a.type);
                          return (
                            <span key={i}>
                              {i > 0 && ", "}
                              {fieldDef?.label || a.field}: {typeDef?.label || a.type} {a.value}
                              {a.rounding && a.rounding !== "none" && ` (round to .${a.rounding})`}
                            </span>
                          );
                        })}
                      </div>
                      <div style={{ fontSize: "12px", color: "#919eab", marginTop: "6px" }}>
                        Runs: {rule.runCount || 0} · Created: {new Date(rule.createdAt).toLocaleDateString()}
                      </div>
                    </div>
                    <div style={{ display: "flex", gap: "6px", flexShrink: 0 }}>
                      <button style={styles.secondaryBtn} onClick={() => fetcher.submit({ intent: "toggle_rule", ruleId: rule.id }, { method: "POST" })}>
                        {rule.enabled ? "Pause" : "Enable"}
                      </button>
                      <button style={styles.dangerBtn(true)} onClick={() => fetcher.submit({ intent: "delete_rule", ruleId: rule.id }, { method: "POST" })}>
                        Delete
                      </button>
                    </div>
                  </div>
                );
              })}
            </s-box>
          </s-section>
        )}
      </s-page>
    );
  }

  /* ════════════════════════════════════════════════════════════════
     CREATOR VIEW — Single-page form (Ablestar-style)
     ════════════════════════════════════════════════════════════════ */
  return (
    <s-page title="Create product rule" backAction={{ url: "#", onAction: () => setView("landing") }}>
      {/* ─── Rule Name & Status ─── */}
      <s-section>
        <s-box padding="base">
          <div style={{ display: "flex", gap: "16px", alignItems: "flex-start" }}>
            {/* Name */}
            <div style={{ flex: 1 }}>
              <label style={styles.label}>Rule name</label>
              <input
                style={styles.input}
                type="text"
                placeholder="e.g., Tag 'sale' products get 20% off"
                value={ruleName}
                onChange={(e) => setRuleName(e.target.value)}
              />
            </div>
            {/* Status toggle */}
            <div style={{ flexShrink: 0, paddingTop: "24px" }}>
              <label style={{ display: "flex", alignItems: "center", gap: "8px", cursor: "pointer", fontSize: "14px", fontWeight: 500, color: "#202223" }}>
                <input
                  type="checkbox"
                  checked={ruleEnabled}
                  onChange={(e) => setRuleEnabled(e.target.checked)}
                  style={{ width: "18px", height: "18px", accentColor: "#2c6ecb" }}
                />
                Enabled
              </label>
            </div>
          </div>
        </s-box>
      </s-section>

      {/* ─── Trigger ─── */}
      <s-section heading="Trigger">
        <s-box padding="base">
          <div style={styles.formField}>
            <label style={styles.label}>Run this rule</label>
            <select
              style={styles.select}
              value={trigger}
              onChange={(e) => setTrigger(e.target.value)}
            >
              {TRIGGER_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
            <div style={{ fontSize: "12px", color: "#637381", marginTop: "6px" }}>
              {trigger === "product_created"
                ? "This rule will only run when a new product is created in your store."
                : "This rule will run when a product is created or when an existing product is updated."
              }
            </div>
          </div>
        </s-box>
      </s-section>

      {/* ─── Search Parameters (Filters) ─── */}
      <s-section heading="Search parameters">
        <s-box padding="base">
          <div style={{ fontSize: "13px", color: "#637381", marginBottom: "16px" }}>
            Define which products this rule applies to. Products matching ALL conditions will be affected.
          </div>

          {filterRules.map((rule) => {
            const fieldDef = FILTER_FIELDS.find((f) => f.value === rule.field);
            const operators = getOperatorsForField(rule.field);
            const needsValue = !["is_empty", "is_not_empty"].includes(rule.operator);
            const needsValue2 = rule.operator === "between";
            return (
              <div key={rule.id} style={styles.filterRule}>
                <select style={{ ...styles.select, flex: "0 0 150px" }} value={rule.field} onChange={(e) => updateFilterRule(rule.id, "field", e.target.value)}>
                  {FILTER_FIELDS.map((f) => (
                    <option key={f.value} value={f.value}>{f.label}</option>
                  ))}
                </select>
                <select style={{ ...styles.select, flex: "0 0 160px" }} value={rule.operator} onChange={(e) => updateFilterRule(rule.id, "operator", e.target.value)}>
                  {operators.map((op) => (
                    <option key={op.value} value={op.value}>{op.label}</option>
                  ))}
                </select>
                {needsValue && fieldDef?.type === "select" ? (
                  <select style={{ ...styles.select, flex: 1 }} value={rule.value} onChange={(e) => updateFilterRule(rule.id, "value", e.target.value)}>
                    <option value="">Select...</option>
                    {fieldDef.options.map((opt) => (
                      <option key={opt} value={opt}>{opt}</option>
                    ))}
                  </select>
                ) : needsValue ? (
                  <input style={{ ...styles.input, flex: 1 }} type={fieldDef?.type === "number" ? "number" : "text"} placeholder="Value..." value={rule.value} onChange={(e) => updateFilterRule(rule.id, "value", e.target.value)} />
                ) : null}
                {needsValue2 && (
                  <input style={{ ...styles.input, flex: 1 }} type="number" placeholder="Max..." value={rule.value2} onChange={(e) => updateFilterRule(rule.id, "value2", e.target.value)} />
                )}
                <button style={{ border: "none", background: "none", cursor: "pointer", fontSize: "18px", color: "#637381", padding: "4px" }} onClick={() => removeFilterRule(rule.id)}>✕</button>
              </div>
            );
          })}

          <button style={{ ...styles.secondaryBtn, marginTop: "8px" }} onClick={addFilterRule}>+ Add condition</button>

          {/* Match preview */}
          {filterRules.length > 0 && (
            <div style={{ marginTop: "16px", padding: "10px 14px", backgroundColor: "#f9fafb", borderRadius: "8px", border: "1px solid #e1e3e5" }}>
              <div style={{ fontSize: "13px", color: "#637381" }}>
                <strong>{matchedProducts.length}</strong> existing product{matchedProducts.length !== 1 ? "s" : ""} currently match{matchedProducts.length === 1 ? "es" : ""} these conditions
              </div>
            </div>
          )}
        </s-box>
      </s-section>

      {/* ─── Modifications ─── */}
      <s-section heading="Modifications">
        <s-box padding="base">
          <div style={{ fontSize: "13px", color: "#637381", marginBottom: "16px" }}>
            Define what changes to apply when a matching product triggers this rule.
          </div>

          {modifications.map((mod) => {
            const fieldDef = getFieldDef(mod.field);
            const changeTypes = getChangeTypes(mod.field);
            return (
              <div key={mod.id} style={{ ...styles.card, position: "relative" }}>
                <button style={{ position: "absolute", top: "8px", right: "8px", border: "none", background: "none", cursor: "pointer", fontSize: "18px", color: "#637381" }} onClick={() => removeMod(mod.id)}>✕</button>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px", marginBottom: "12px" }}>
                  <div>
                    <label style={{ fontSize: "12px", fontWeight: 600, color: "#637381", marginBottom: "4px", display: "block" }}>Field</label>
                    <select style={styles.select} value={mod.field} onChange={(e) => updateMod(mod.id, "field", e.target.value)}>
                      {EDITABLE_FIELDS.map((f) => (
                        <option key={f.value} value={f.value}>{f.icon} {f.label}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label style={{ fontSize: "12px", fontWeight: 600, color: "#637381", marginBottom: "4px", display: "block" }}>Change Type</label>
                    <select style={styles.select} value={mod.type} onChange={(e) => updateMod(mod.id, "type", e.target.value)}>
                      {changeTypes.map((ct) => (
                        <option key={ct.value} value={ct.value}>{ct.label}</option>
                      ))}
                    </select>
                  </div>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: fieldDef?.category === "numeric" ? "1fr 1fr" : "1fr", gap: "12px" }}>
                  <div>
                    <label style={{ fontSize: "12px", fontWeight: 600, color: "#637381", marginBottom: "4px", display: "block" }}>Value</label>
                    {fieldDef?.category === "select" ? (
                      <select style={styles.select} value={mod.value} onChange={(e) => updateMod(mod.id, "value", e.target.value)}>
                        <option value="">Select...</option>
                        {fieldDef.options.map((opt) => (
                          <option key={opt} value={opt}>{opt}</option>
                        ))}
                      </select>
                    ) : (
                      <input style={styles.input} type={fieldDef?.category === "numeric" ? "number" : "text"} placeholder={fieldDef?.category === "numeric" ? "0.00" : "Value..."} value={mod.value} onChange={(e) => updateMod(mod.id, "value", e.target.value)} />
                    )}
                  </div>
                  {fieldDef?.category === "numeric" && (
                    <div>
                      <label style={{ fontSize: "12px", fontWeight: 600, color: "#637381", marginBottom: "4px", display: "block" }}>Rounding</label>
                      <select style={styles.select} value={mod.rounding} onChange={(e) => updateMod(mod.id, "rounding", e.target.value)}>
                        <option value="none">No rounding</option>
                        <option value="99">Round to .99</option>
                        <option value="95">Round to .95</option>
                        <option value="whole">Round to whole</option>
                      </select>
                    </div>
                  )}
                </div>
                {mod.type === "find_replace" && (
                  <div style={{ marginTop: "12px" }}>
                    <label style={{ fontSize: "12px", fontWeight: 600, color: "#637381", marginBottom: "4px", display: "block" }}>Replace With</label>
                    <input style={styles.input} type="text" placeholder="Replacement text..." value={mod.value2 || ""} onChange={(e) => updateMod(mod.id, "value2", e.target.value)} />
                  </div>
                )}
              </div>
            );
          })}

          <button style={{ ...styles.primaryBtn(true), backgroundColor: "#2c6ecb" }} onClick={addMod}>+ Add modification</button>
        </s-box>
      </s-section>

      {/* ─── Save / Cancel ─── */}
      <s-section>
        <s-box padding="base">
          <div style={{ display: "flex", gap: "12px", justifyContent: "flex-end" }}>
            <button style={styles.secondaryBtn} onClick={() => { setView("landing"); resetForm(); }}>
              Cancel
            </button>
            <button
              style={styles.primaryBtn(!!ruleName.trim() && filterRules.length > 0 && modifications.length > 0)}
              onClick={handleSaveRule}
              disabled={isSubmitting || !ruleName.trim() || filterRules.length === 0 || modifications.length === 0}
            >
              {isSubmitting ? "Saving..." : "Save rule"}
            </button>
          </div>
        </s-box>
      </s-section>
    </s-page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};

export function ErrorBoundary() {
  const error = useRouteError();
  const navigate = useNavigate();
  const isResponse = isRouteErrorResponse(error);
  const title = isResponse
    ? `${error.status} — ${error.statusText || "Something went wrong"}`
    : "Something Went Wrong";
  const message = isResponse
    ? "The server returned an unexpected response. This may be caused by a temporary network issue."
    : (error?.message || "An unexpected error occurred. Please try reloading the page.");
  return (
    <div style={{ textAlign: "center", padding: "60px 20px" }}>
      <div style={{ fontSize: "48px", marginBottom: "12px" }}>⚠️</div>
      <div style={{ fontSize: "20px", fontWeight: 700, color: "#202223", marginBottom: "8px" }}>{title}</div>
      <div style={{ fontSize: "14px", color: "#637381", maxWidth: "480px", margin: "0 auto 24px", lineHeight: "1.6" }}>
        {message}
      </div>
      <div style={{ display: "flex", gap: "12px", justifyContent: "center" }}>
        <button
          onClick={() => window.location.reload()}
          style={{ padding: "10px 24px", borderRadius: "8px", border: "none", backgroundColor: "#2c6ecb", color: "white", fontSize: "14px", fontWeight: 600, cursor: "pointer" }}
        >
          Reload Page
        </button>
        <button
          onClick={() => navigate("/app")}
          style={{ padding: "10px 24px", borderRadius: "8px", border: "1px solid #c4cdd5", backgroundColor: "white", fontSize: "14px", cursor: "pointer" }}
        >
          Go to Dashboard
        </button>
      </div>
    </div>
  );
}
