import { useState, useEffect, useCallback, useMemo } from "react";
import { useLoaderData, useFetcher, useNavigate } from "react-router";
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

  // Fetch products for filter preview (same as bulk edit)
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
  const products = (data.data?.products?.edges || []).map((e) => e.node);

  const rules = await prisma.automationRule.findMany({
    where: { shop },
    orderBy: { createdAt: "desc" },
  });

  return { products, rules, currentPlan: plan };
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const shopPlan = await prisma.shopPlan.findUnique({ where: { shop } });
  if (!shopPlan || shopPlan.plan !== "plus") {
    return { error: "Automation rules require the Plus plan." };
  }

  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "create_rule") {
    const name = formData.get("name");
    const filterRules = formData.get("filterRules") || "[]";
    const modifications = formData.get("modifications") || "[]";

    const rule = await prisma.automationRule.create({
      data: {
        shop,
        name: name || "Untitled Rule",
        enabled: true,
        conditions: filterRules,
        actions: modifications,
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
   STYLES
   ═══════════════════════════════════════════════════════════════ */
const styles = {
  stepIndicator: (active, completed, enabled) => ({
    display: "flex", alignItems: "center", gap: "8px", padding: "10px 20px", borderRadius: "24px", border: "none",
    cursor: enabled ? "pointer" : "default", fontWeight: active ? "700" : "500",
    backgroundColor: active ? "#2c6ecb" : completed ? "#e3f1df" : "transparent",
    color: active ? "white" : completed ? "#1a7f37" : enabled ? "#202223" : "#babec3",
    fontSize: "14px", transition: "all 0.2s ease", opacity: enabled ? 1 : 0.5,
  }),
  stepNumber: (active, completed) => ({
    display: "inline-flex", alignItems: "center", justifyContent: "center", width: "24px", height: "24px",
    borderRadius: "50%", fontSize: "12px", fontWeight: "700",
    backgroundColor: active ? "rgba(255,255,255,0.2)" : completed ? "#1a7f37" : "#e4e5e7",
    color: active ? "white" : completed ? "white" : "#637381",
  }),
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
};

/* ═══════════════════════════════════════════════════════════════
   COMPONENT
   ═══════════════════════════════════════════════════════════════ */
export default function Automations() {
  const { products, rules, currentPlan } = useLoaderData();
  const fetcher = useFetcher();
  const navigate = useNavigate();
  const shopify = useAppBridge();

  const [showCreator, setShowCreator] = useState(false);
  const [step, setStep] = useState(1);

  // Step 1: Filter conditions
  const [filterRules, setFilterRules] = useState([]);
  // Step 2: Modifications
  const [ruleName, setRuleName] = useState("");
  const [modifications, setModifications] = useState([]);

  const isSubmitting = fetcher.state !== "idle";
  const actionData = fetcher.data;

  // Reset form after successful creation
  useEffect(() => {
    if (actionData?.success && actionData?.rule) {
      setShowCreator(false);
      setStep(1);
      setFilterRules([]);
      setModifications([]);
      setRuleName("");
      shopify.toast.show("Automation rule created!");
    }
    if (actionData?.error) {
      shopify.toast.show(actionData.error, { isError: true });
    }
  }, [actionData]);

  // Plan gating
  if (currentPlan !== "plus") {
    return (
      <s-page title="Automation Rules">
        <s-section>
          <s-box padding="loose">
            <div style={{ textAlign: "center", padding: "40px 20px" }}>
              <div style={{ fontSize: "48px", marginBottom: "16px" }}>🤖</div>
              <div style={{ fontSize: "20px", fontWeight: 700, marginBottom: "8px" }}>Automation Rules</div>
              <div style={{ fontSize: "14px", color: "#637381", marginBottom: "24px", maxWidth: "480px", margin: "0 auto 24px" }}>
                Automation rules automatically adjust prices when products are created or updated.
                Set conditions and actions once — they run automatically via webhooks.
              </div>
              <div style={{ padding: "16px", backgroundColor: "#fef8e8", borderRadius: "12px", marginBottom: "24px", maxWidth: "400px", margin: "0 auto 24px" }}>
                <div style={{ fontSize: "14px", fontWeight: 600, color: "#916a00" }}>Plus Plan Required</div>
                <div style={{ fontSize: "13px", color: "#916a00", marginTop: "4px" }}>Upgrade to Plus ($19.99/mo) to unlock automation rules.</div>
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
      shopify.toast.show("Please add at least one filter condition", { isError: true });
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

  return (
    <s-page title="Automation Rules">
      {/* Info banner */}
      <s-section>
        <s-box padding="base">
          <div style={{ display: "flex", alignItems: "center", gap: "12px", padding: "12px 16px", backgroundColor: "#f0f5ff", borderRadius: "10px", border: "1px solid #c9d8f0" }}>
            <span style={{ fontSize: "20px" }}>🤖</span>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: "14px", fontWeight: 600, color: "#202223" }}>Automation rules run automatically</div>
              <div style={{ fontSize: "13px", color: "#637381", marginTop: "2px" }}>
                When a product is created or updated in your store, all enabled rules are checked. If a product matches a rule's filters, the modifications are applied automatically.
              </div>
            </div>
          </div>
        </s-box>
      </s-section>

      {/* Create new rule button */}
      {!showCreator && (
        <s-section>
          <s-box padding="base">
            <button style={styles.primaryBtn(true)} onClick={() => setShowCreator(true)}>
              + Create New Automation Rule
            </button>
          </s-box>
        </s-section>
      )}

      {/* ════════════════════ RULE CREATOR WIZARD ════════════════════ */}
      {showCreator && (
        <>
          {/* Step indicators */}
          <s-section>
            <s-box padding="base">
              <div style={{ display: "flex", gap: "4px", justifyContent: "center", flexWrap: "wrap" }}>
                {[
                  { num: 1, label: "Filter Products" },
                  { num: 2, label: "Set Modifications" },
                  { num: 3, label: "Review & Save" },
                ].map(({ num, label }) => {
                  const active = step === num;
                  const completed = step > num;
                  const enabled = num <= step;
                  return (
                    <button key={num} style={styles.stepIndicator(active, completed, enabled)} onClick={() => enabled && setStep(num)}>
                      <span style={styles.stepNumber(active, completed)}>{completed ? "✓" : num}</span>
                      {label}
                    </button>
                  );
                })}
              </div>
            </s-box>
          </s-section>

          {/* ──── STEP 1: FILTER CONDITIONS ──── */}
          {step === 1 && (
            <s-section>
              <s-box padding="base">
                <div style={{ marginBottom: "16px" }}>
                  <div style={{ fontSize: "16px", fontWeight: 700, marginBottom: "4px" }}>Filter Conditions</div>
                  <div style={{ fontSize: "13px", color: "#637381" }}>
                    Define which products this rule applies to. Products matching ALL conditions will be affected when they are created or updated.
                  </div>
                </div>

                {/* Filter rules */}
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

                <div style={{ display: "flex", gap: "8px", marginTop: "12px" }}>
                  <button style={styles.secondaryBtn} onClick={addFilterRule}>+ Add Condition</button>
                </div>

                {/* Preview of matched products */}
                <div style={{ marginTop: "20px", padding: "12px 16px", backgroundColor: "#f9fafb", borderRadius: "8px", border: "1px solid #e1e3e5" }}>
                  <div style={{ fontSize: "13px", fontWeight: 600, color: "#202223" }}>
                    Preview: {matchedProducts.length} product{matchedProducts.length !== 1 ? "s" : ""} currently match{matchedProducts.length === 1 ? "es" : ""}
                  </div>
                  {matchedProducts.length > 0 && matchedProducts.length <= 10 && (
                    <div style={{ marginTop: "8px", fontSize: "13px", color: "#637381" }}>
                      {matchedProducts.map((p) => p.title).join(", ")}
                    </div>
                  )}
                  {matchedProducts.length > 10 && (
                    <div style={{ marginTop: "8px", fontSize: "13px", color: "#637381" }}>
                      {matchedProducts.slice(0, 10).map((p) => p.title).join(", ")} and {matchedProducts.length - 10} more...
                    </div>
                  )}
                </div>

                <div style={{ display: "flex", gap: "8px", marginTop: "16px", justifyContent: "flex-end" }}>
                  <button style={styles.secondaryBtn} onClick={() => { setShowCreator(false); setStep(1); setFilterRules([]); setModifications([]); setRuleName(""); }}>Cancel</button>
                  <button style={styles.primaryBtn(filterRules.length > 0)} onClick={() => filterRules.length > 0 && setStep(2)} disabled={filterRules.length === 0}>
                    Next: Set Modifications →
                  </button>
                </div>
              </s-box>
            </s-section>
          )}

          {/* ──── STEP 2: MODIFICATIONS ──── */}
          {step === 2 && (
            <s-section>
              <s-box padding="base">
                <div style={{ marginBottom: "16px" }}>
                  <div style={{ fontSize: "16px", fontWeight: 700, marginBottom: "4px" }}>Modifications</div>
                  <div style={{ fontSize: "13px", color: "#637381" }}>
                    Define what changes to apply when a matching product is created or updated.
                  </div>
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

                <button style={styles.secondaryBtn} onClick={addMod}>+ Add Modification</button>

                <div style={{ display: "flex", gap: "8px", marginTop: "16px", justifyContent: "flex-end" }}>
                  <button style={styles.secondaryBtn} onClick={() => setStep(1)}>← Back</button>
                  <button style={styles.primaryBtn(modifications.length > 0)} onClick={() => modifications.length > 0 && setStep(3)} disabled={modifications.length === 0}>
                    Next: Review & Save →
                  </button>
                </div>
              </s-box>
            </s-section>
          )}

          {/* ──── STEP 3: REVIEW & SAVE ──── */}
          {step === 3 && (
            <s-section>
              <s-box padding="base">
                <div style={{ marginBottom: "16px" }}>
                  <div style={{ fontSize: "16px", fontWeight: 700, marginBottom: "4px" }}>Review & Save Rule</div>
                  <div style={{ fontSize: "13px", color: "#637381" }}>
                    Give your rule a name and review the configuration before saving.
                  </div>
                </div>

                {/* Rule name */}
                <div style={{ marginBottom: "20px" }}>
                  <label style={{ fontSize: "13px", fontWeight: 600, color: "#202223", marginBottom: "6px", display: "block" }}>Rule Name</label>
                  <input style={styles.input} type="text" placeholder="e.g., Tag 'sale' → 20% off" value={ruleName} onChange={(e) => setRuleName(e.target.value)} />
                </div>

                {/* Summary */}
                <div style={styles.card}>
                  <div style={{ fontSize: "14px", fontWeight: 700, marginBottom: "12px" }}>When a product matches:</div>
                  {filterRules.map((rule, i) => {
                    const fieldDef = FILTER_FIELDS.find((f) => f.value === rule.field);
                    const opDef = getOperatorsForField(rule.field).find((o) => o.value === rule.operator);
                    return (
                      <div key={i} style={{ padding: "6px 12px", backgroundColor: "#f0f5ff", borderRadius: "6px", marginBottom: "4px", fontSize: "13px" }}>
                        <strong>{fieldDef?.label || rule.field}</strong> {opDef?.label || rule.operator} <strong>{rule.value}</strong>
                        {rule.operator === "between" && <> and <strong>{rule.value2}</strong></>}
                      </div>
                    );
                  })}
                </div>

                <div style={styles.card}>
                  <div style={{ fontSize: "14px", fontWeight: 700, marginBottom: "12px" }}>Apply these changes:</div>
                  {modifications.map((mod, i) => {
                    const fieldDef = getFieldDef(mod.field);
                    const typeDef = getChangeTypes(mod.field).find((ct) => ct.value === mod.type);
                    return (
                      <div key={i} style={{ padding: "6px 12px", backgroundColor: "#e3f1df", borderRadius: "6px", marginBottom: "4px", fontSize: "13px" }}>
                        <strong>{fieldDef?.label || mod.field}</strong>: {typeDef?.label || mod.type} — <strong>{mod.value}</strong>
                        {mod.rounding && mod.rounding !== "none" && <> (round to .{mod.rounding})</>}
                        {mod.type === "find_replace" && <> → <strong>{mod.value2}</strong></>}
                      </div>
                    );
                  })}
                </div>

                <div style={{ padding: "12px 16px", backgroundColor: "#f9fafb", borderRadius: "8px", border: "1px solid #e1e3e5", marginBottom: "16px" }}>
                  <div style={{ fontSize: "13px", color: "#637381" }}>
                    Currently <strong>{matchedProducts.length}</strong> product{matchedProducts.length !== 1 ? "s" : ""} match this rule. The rule will also apply to future products that match these conditions.
                  </div>
                </div>

                <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
                  <button style={styles.secondaryBtn} onClick={() => setStep(2)}>← Back</button>
                  <button style={styles.secondaryBtn} onClick={() => { setShowCreator(false); setStep(1); setFilterRules([]); setModifications([]); setRuleName(""); }}>Cancel</button>
                  <button style={styles.primaryBtn(!!ruleName.trim())} onClick={handleSaveRule} disabled={!ruleName.trim() || isSubmitting}>
                    {isSubmitting ? "Saving..." : "💾 Save Automation Rule"}
                  </button>
                </div>
              </s-box>
            </s-section>
          )}
        </>
      )}

      {/* ════════════════════ EXISTING RULES LIST ════════════════════ */}
      <s-section heading={`Rules (${rules.length})`}>
        {rules.length === 0 ? (
          <s-box padding="loose" borderWidth="base" borderRadius="base">
            <div style={{ textAlign: "center", padding: "20px" }}>
              <div style={{ fontSize: "32px", marginBottom: "8px" }}>📋</div>
              <div style={{ fontSize: "14px", color: "#637381" }}>
                No automation rules yet. Create one to automatically adjust prices when products are created or updated.
              </div>
            </div>
          </s-box>
        ) : (
          <s-section padding="none">
            {rules.map((rule) => {
              const { conditions, actions } = parseRuleDisplay(rule);
              return (
                <div key={rule.id} style={{ ...styles.card, display: "flex", alignItems: "flex-start", gap: "16px" }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "8px" }}>
                      <div style={{ fontSize: "15px", fontWeight: 700 }}>{rule.name}</div>
                      <span style={styles.badge(rule.enabled ? "success" : "info")}>
                        {rule.enabled ? "Active" : "Paused"}
                      </span>
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
                    <div style={{ fontSize: "12px", color: "#919eab", marginTop: "4px" }}>
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
          </s-section>
        )}
      </s-section>
    </s-page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
