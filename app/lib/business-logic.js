/**
 * Shared business logic — extracted from route handlers so it can be
 * unit-tested without Shopify or Prisma dependencies.
 */

/* ───────── Plan Definitions ───────── */
export const PLAN_LIMITS = {
  free: { editsPerMonth: 3, automations: false, scheduled: false },
  pro: { editsPerMonth: 50, automations: false, scheduled: false },
  plus: { editsPerMonth: Infinity, automations: true, scheduled: true },
};

export const PLAN_NAMES = {
  PRO: "Pro Plan",
  PLUS: "Plus Plan",
};

/* ───────── Editable Fields ───────── */
export const EDITABLE_FIELDS = [
  { value: "price", label: "Price", category: "numeric", level: "variant", accessor: (v) => v.price },
  { value: "compareAtPrice", label: "Compare-at Price", category: "numeric", level: "variant", accessor: (v) => v.compareAtPrice },
  { value: "sku", label: "SKU", category: "text", level: "variant", accessor: (v) => v.sku || "" },
  { value: "barcode", label: "Barcode", category: "text", level: "variant", accessor: (v) => v.barcode || "" },
  { value: "title", label: "Title", category: "text", level: "product", accessor: null },
  { value: "vendor", label: "Vendor", category: "text", level: "product", accessor: null },
  { value: "productType", label: "Product Type", category: "text", level: "product", accessor: null },
  { value: "tags", label: "Tags", category: "tags", level: "product", accessor: null },
  { value: "status", label: "Status", category: "select", level: "product", accessor: null, options: ["ACTIVE", "DRAFT", "ARCHIVED"] },
];

export function getFieldDef(f) {
  return EDITABLE_FIELDS.find((e) => e.value === f);
}

/* ───────── Filter / Rule Matching ───────── */
export function evaluateFilter(product, rule) {
  if (["price", "compareAtPrice", "sku", "barcode", "inventoryQuantity"].includes(rule.field)) {
    const variants = product.variants?.edges?.map((e) => e.node) || [];
    return variants.some((v) => matchValue(String(v[rule.field] || ""), rule));
  }
  const value = rule.field === "tags" ? (product.tags || []).join(", ") : (product[rule.field] || "");
  return matchValue(String(value), rule);
}

export function matchValue(value, rule) {
  const v = value.toLowerCase();
  const rv = String(rule.value || "").toLowerCase();
  const rv2 = String(rule.value2 || "").toLowerCase();
  switch (rule.operator) {
    case "contains": return v.includes(rv);
    case "not_contains": return !v.includes(rv);
    case "equals":
      return ["price", "compareAtPrice", "inventoryQuantity"].includes(rule.field)
        ? parseFloat(value) === parseFloat(rule.value)
        : v === rv;
    case "not_equals":
      return ["price", "compareAtPrice", "inventoryQuantity"].includes(rule.field)
        ? parseFloat(value) !== parseFloat(rule.value)
        : v !== rv;
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

/* ───────── Price / Value Calculations ───────── */
export function calcValue(current, mod) {
  const fieldDef = getFieldDef(mod.field);
  if (!fieldDef) return null;

  if (fieldDef.category === "numeric") {
    const c = parseFloat(current || "0");
    const v = parseFloat(mod.value);
    if (isNaN(v)) return null;
    let r;
    switch (mod.type) {
      case "exact": r = v; break;
      case "increase_percent": r = c * (1 + v / 100); break;
      case "decrease_percent": r = c * (1 - v / 100); break;
      case "increase_fixed": r = c + v; break;
      case "decrease_fixed": r = c - v; break;
      default: r = c;
    }
    if (mod.rounding === "99") r = Math.floor(r) + 0.99;
    else if (mod.rounding === "95") r = Math.floor(r) + 0.95;
    else if (mod.rounding === "whole") r = Math.round(r);
    return Math.max(0, r).toFixed(2);
  }

  if (fieldDef.category === "text") {
    const cur = current || "";
    switch (mod.type) {
      case "set": return mod.value;
      case "prepend": return mod.value + cur;
      case "append": return cur + mod.value;
      case "find_replace": return cur.split(mod.value).join(mod.value2 || "");
      default: return cur;
    }
  }

  if (fieldDef.category === "tags") {
    const curTags = (current || "").split(",").map((t) => t.trim()).filter(Boolean);
    const newTags = (mod.value || "").split(",").map((t) => t.trim()).filter(Boolean);
    switch (mod.type) {
      case "add": return [...new Set([...curTags, ...newTags])].join(", ");
      case "remove": return curTags.filter((t) => !newTags.includes(t)).join(", ");
      case "set": return newTags.join(", ");
      default: return current;
    }
  }

  if (fieldDef.category === "select" && mod.type === "set") return mod.value;
  return null;
}

/* ───────── Plan Limit Checks ───────── */
export function canPerformEdit(plan, monthlyEdits) {
  const limits = PLAN_LIMITS[plan] || PLAN_LIMITS.free;
  if (limits.editsPerMonth === Infinity) return true;
  return monthlyEdits < limits.editsPerMonth;
}

export function shouldResetMonthlyEdits(lastResetDate) {
  const now = new Date();
  const resetDate = new Date(lastResetDate);
  return now.getMonth() !== resetDate.getMonth() || now.getFullYear() !== resetDate.getFullYear();
}

/* ───────── Modification Builder (for webhook) ───────── */
export function buildModifications(product, actions) {
  const productInput = {};
  const variantUpdates = [];

  for (const mod of actions) {
    const fieldDef = getFieldDef(mod.field);
    if (!fieldDef) continue;

    if (fieldDef.level === "product") {
      const currentValue = mod.field === "tags" ? (product.tags || []).join(", ") : (product[mod.field] || "");
      const newValue = calcValue(currentValue, mod);
      if (newValue === null) continue;
      if (mod.field === "tags") {
        productInput.tags = typeof newValue === "string" ? newValue.split(",").map((t) => t.trim()) : newValue;
      } else {
        productInput[mod.field] = newValue;
      }
    } else if (fieldDef.level === "variant") {
      for (const edge of product.variants?.edges || []) {
        const variant = edge.node;
        const currentValue = fieldDef.accessor ? fieldDef.accessor(variant) : variant[mod.field];
        const newValue = calcValue(currentValue, mod);
        if (newValue === null) continue;
        let existing = variantUpdates.find((v) => v.id === variant.id);
        if (!existing) { existing = { id: variant.id }; variantUpdates.push(existing); }
        existing[mod.field] = newValue;
      }
    }
  }

  return { productInput, variantUpdates };
}
