import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const action = async ({ request }) => {
  const { shop, topic, payload, admin } = await authenticate.webhook(request);
  if (!admin) { throw new Response(); }
  console.log(`[Webhook] products/update received for shop: ${shop}, product: ${payload.id}`);
  try {
    const shopPlan = await prisma.shopPlan.findUnique({ where: { shop } });
    if (!shopPlan || shopPlan.plan !== "plus") {
      console.log(`[Webhook] Shop ${shop} is not on Plus plan, skipping automations`);
      return new Response("OK", { status: 200 });
    }
    const rules = await prisma.automationRule.findMany({ where: { shop, enabled: true } });
    if (rules.length === 0) {
      return new Response("OK", { status: 200 });
    }
    const product = {
      id: `gid://shopify/Product/${payload.id}`,
      title: payload.title || "",
      vendor: payload.vendor || "",
      productType: payload.product_type || "",
      status: (payload.status || "active").toUpperCase(),
      tags: (payload.tags || "").split(",").map((t) => t.trim()).filter(Boolean),
      variants: {
        edges: (payload.variants || []).map((v) => ({
          node: {
            id: `gid://shopify/ProductVariant/${v.id}`,
            title: v.title || "",
            price: v.price || "0",
            compareAtPrice: v.compare_at_price || null,
            sku: v.sku || "",
            barcode: v.barcode || "",
            inventoryQuantity: v.inventory_quantity || 0,
          },
        })),
      },
    };
    for (const rule of rules) {
      let conditions = []; let actions = [];
      try { conditions = JSON.parse(rule.conditions); } catch {}
      try { actions = JSON.parse(rule.actions); } catch {}
      const matches = conditions.every((condition) => evaluateFilter(product, condition));
      if (!matches) continue;
      console.log(`[Webhook] Product ${payload.id} matches rule "${rule.name}"`);
      try {
        await applyModifications(admin, product, actions);
        await prisma.automationRule.update({ where: { id: rule.id }, data: { runCount: (rule.runCount || 0) + 1 } });
        await prisma.priceHistory.create({
          data: { shop, editName: `Auto: ${rule.name}`, productsAffected: 1, changesApplied: actions.length, status: "completed",
            changes: JSON.stringify({ productId: product.id, productTitle: product.title, actions, automationRuleId: rule.id }) },
        });
      } catch (err) { console.error(`[Webhook] Error applying rule "${rule.name}":`, err); }
    }
  } catch (err) { console.error(`[Webhook] Error processing products/update:`, err); }
  return new Response("OK", { status: 200 });
};

function evaluateFilter(product, rule) {
  if (["price", "compareAtPrice", "sku", "barcode", "inventoryQuantity"].includes(rule.field)) {
    const variants = product.variants?.edges?.map((e) => e.node) || [];
    return variants.some((v) => matchValue(String(v[rule.field] || ""), rule));
  }
  const value = rule.field === "tags" ? (product.tags || []).join(", ") : (product[rule.field] || "");
  return matchValue(String(value), rule);
}

function matchValue(value, rule) {
  const v = value.toLowerCase(), rv = String(rule.value || "").toLowerCase(), rv2 = String(rule.value2 || "").toLowerCase();
  switch (rule.operator) {
    case "contains": return v.includes(rv);
    case "not_contains": return !v.includes(rv);
    case "equals": return ["price","compareAtPrice","inventoryQuantity"].includes(rule.field) ? parseFloat(value)===parseFloat(rule.value) : v===rv;
    case "not_equals": return ["price","compareAtPrice","inventoryQuantity"].includes(rule.field) ? parseFloat(value)!==parseFloat(rule.value) : v!==rv;
    case "starts_with": return v.startsWith(rv);
    case "ends_with": return v.endsWith(rv);
    case "is_empty": return !value || value==="";
    case "is_not_empty": return value && value!=="";
    case "greater_than": return parseFloat(value)>parseFloat(rule.value);
    case "less_than": return parseFloat(value)<parseFloat(rule.value);
    case "greater_or_equal": return parseFloat(value)>=parseFloat(rule.value);
    case "less_or_equal": return parseFloat(value)<=parseFloat(rule.value);
    case "between": return parseFloat(value)>=parseFloat(rule.value) && parseFloat(value)<=parseFloat(rv2);
    default: return true;
  }
}

const EDITABLE_FIELDS = [
  { value: "price", label: "Price", category: "numeric", level: "variant", accessor: (v) => v.price },
  { value: "compareAtPrice", label: "Compare-at Price", category: "numeric", level: "variant", accessor: (v) => v.compareAtPrice },
  { value: "sku", label: "SKU", category: "text", level: "variant", accessor: (v) => v.sku || "" },
  { value: "barcode", label: "Barcode", category: "text", level: "variant", accessor: (v) => v.barcode || "" },
  { value: "title", label: "Title", category: "text", level: "product", accessor: null },
  { value: "vendor", label: "Vendor", category: "text", level: "product", accessor: null },
  { value: "productType", label: "Product Type", category: "text", level: "product", accessor: null },
  { value: "tags", label: "Tags", category: "tags", level: "product", accessor: null },
  { value: "status", label: "Status", category: "select", level: "product", accessor: null, options: ["ACTIVE","DRAFT","ARCHIVED"] },
];
function getFieldDef(f) { return EDITABLE_FIELDS.find((e) => e.value === f); }

function calcValue(current, mod) {
  const fieldDef = getFieldDef(mod.field);
  if (!fieldDef) return null;
  if (fieldDef.category === "numeric") {
    const c = parseFloat(current||"0"), v = parseFloat(mod.value);
    if (isNaN(v)) return null;
    let r;
    switch(mod.type) { case "exact":r=v;break; case "increase_percent":r=c*(1+v/100);break; case "decrease_percent":r=c*(1-v/100);break; case "increase_fixed":r=c+v;break; case "decrease_fixed":r=c-v;break; default:r=c; }
    if(mod.rounding==="99")r=Math.floor(r)+0.99; else if(mod.rounding==="95")r=Math.floor(r)+0.95; else if(mod.rounding==="whole")r=Math.round(r);
    return Math.max(0,r).toFixed(2);
  }
  if (fieldDef.category === "text") {
    const cur = current||"";
    switch(mod.type) { case "set":return mod.value; case "prepend":return mod.value+cur; case "append":return cur+mod.value; case "find_replace":return cur.split(mod.value).join(mod.value2||""); default:return cur; }
  }
  if (fieldDef.category === "tags") {
    const curTags=(current||"").split(",").map(t=>t.trim()).filter(Boolean), newTags=(mod.value||"").split(",").map(t=>t.trim()).filter(Boolean);
    switch(mod.type) { case "add":return[...new Set([...curTags,...newTags])].join(", "); case "remove":return curTags.filter(t=>!newTags.includes(t)).join(", "); case "set":return newTags.join(", "); default:return current; }
  }
  if (fieldDef.category === "select" && mod.type === "set") return mod.value;
  return null;
}

async function applyModifications(admin, product, actions) {
  const productInput = {}, variantUpdates = [];
  for (const mod of actions) {
    const fieldDef = getFieldDef(mod.field);
    if (!fieldDef) continue;
    if (fieldDef.level === "product") {
      const currentValue = mod.field === "tags" ? (product.tags||[]).join(", ") : (product[mod.field]||"");
      const newValue = calcValue(currentValue, mod);
      if (newValue === null) continue;
      if (mod.field === "tags") { productInput.tags = typeof newValue === "string" ? newValue.split(",").map(t=>t.trim()) : newValue; }
      else { productInput[mod.field] = newValue; }
    } else if (fieldDef.level === "variant") {
      for (const edge of product.variants?.edges||[]) {
        const variant = edge.node, currentValue = fieldDef.accessor ? fieldDef.accessor(variant) : variant[mod.field];
        const newValue = calcValue(currentValue, mod);
        if (newValue === null) continue;
        let existing = variantUpdates.find(v => v.id === variant.id);
        if (!existing) { existing = { id: variant.id }; variantUpdates.push(existing); }
        existing[mod.field] = newValue;
      }
    }
  }
  if (Object.keys(productInput).length > 0) {
    await admin.graphql(`#graphql mutation productUpdate($input: ProductInput!) { productUpdate(input: $input) { product { id } userErrors { field message } } }`, { variables: { input: { id: product.id, ...productInput } } });
  }
  if (variantUpdates.length > 0) {
    await admin.graphql(`#graphql mutation productVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) { productVariantsBulkUpdate(productId: $productId, variants: $variants) { product { id } userErrors { field message } } }`, { variables: { productId: product.id, variants: variantUpdates } });
  }
}
