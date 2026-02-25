import { useState, useEffect, useCallback, useMemo } from "react";
import { useLoaderData, useFetcher, useNavigate } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);

  // Product query WITH weight (requires read_inventory scope)
  const PRODUCTS_QUERY_WITH_WEIGHT = `#graphql
    query ($first: Int!, $after: String) {
      products(first: $first, after: $after) {
        pageInfo { hasNextPage endCursor }
        edges {
          node {
            id title handle status productType vendor tags
            featuredMedia { preview { image { url altText } } }
            variants(first: 100) {
              edges {
                node {
                  id title price compareAtPrice sku barcode inventoryQuantity
                  inventoryItem { measurement { weight { value unit } } }
                }
              }
            }
          }
        }
      }
    }`;

  // Fallback query WITHOUT weight (if read_inventory scope not granted)
  const PRODUCTS_QUERY_NO_WEIGHT = `#graphql
    query ($first: Int!, $after: String) {
      products(first: $first, after: $after) {
        pageInfo { hasNextPage endCursor }
        edges {
          node {
            id title handle status productType vendor tags
            featuredMedia { preview { image { url altText } } }
            variants(first: 100) {
              edges {
                node {
                  id title price compareAtPrice sku barcode inventoryQuantity
                }
              }
            }
          }
        }
      }
    }`;

  // Paginate through ALL products, fallback to no-weight query if scope missing
  let allProducts = [];
  let hasNextPage = true;
  let cursor = null;
  let useWeightQuery = true;
  while (hasNextPage) {
    try {
      const response = await admin.graphql(
        useWeightQuery ? PRODUCTS_QUERY_WITH_WEIGHT : PRODUCTS_QUERY_NO_WEIGHT,
        { variables: { first: 250, after: cursor } }
      );
      const data = await response.json();
      // Check for GraphQL errors (e.g., scope issues)
      if (data.errors && data.errors.length > 0 && useWeightQuery) {
        console.warn("Weight query failed, falling back to no-weight query:", data.errors[0]?.message);
        useWeightQuery = false;
        continue; // retry this page with fallback query
      }
      const edges = data.data?.products?.edges || [];
      allProducts = allProducts.concat(edges.map((e) => e.node));
      hasNextPage = data.data?.products?.pageInfo?.hasNextPage || false;
      cursor = data.data?.products?.pageInfo?.endCursor || null;
    } catch (err) {
      if (useWeightQuery) {
        console.warn("Weight query threw error, falling back to no-weight query:", err.message);
        useWeightQuery = false;
        continue; // retry this page with fallback query
      }
      throw err; // re-throw if fallback also fails
    }
  }
  const products = allProducts;

  const vendors = [...new Set(products.map((p) => p.vendor).filter(Boolean))].sort();
  const productTypes = [...new Set(products.map((p) => p.productType).filter(Boolean))].sort();
  const allTags = [...new Set(products.flatMap((p) => p.tags || []))].sort();

  const collectionResponse = await admin.graphql(
    `#graphql
    query {
      collections(first: 100) {
        edges { node { id title } }
      }
    }`
  );
  const collectionData = await collectionResponse.json();
  const collections = (collectionData.data?.collections?.edges || []).map((e) => e.node);

  const recentEdits = await prisma.bulkEdit.findMany({
    where: { shop: session.shop },
    orderBy: { createdAt: "desc" },
    take: 5,
  });

  let shopPlan = await prisma.shopPlan.findUnique({ where: { shop: session.shop } });
  if (!shopPlan) {
    shopPlan = await prisma.shopPlan.create({ data: { shop: session.shop } });
  }

  const now = new Date();
  const resetDate = new Date(shopPlan.monthlyEditReset);
  if (now.getMonth() !== resetDate.getMonth() || now.getFullYear() !== resetDate.getFullYear()) {
    shopPlan = await prisma.shopPlan.update({
      where: { shop: session.shop },
      data: { monthlyEdits: 0, monthlyEditReset: now },
    });
  }

  const PLAN_LIMITS = { free: 3, pro: 50, plus: Infinity };
  const plan = shopPlan.plan || "free";
  const editsLimit = PLAN_LIMITS[plan] || 3;
  const monthlyEdits = shopPlan.monthlyEdits || 0;
  const editsRemaining = editsLimit === Infinity ? Infinity : Math.max(0, editsLimit - monthlyEdits);

  return {
    products, vendors, productTypes, allTags, collections,
    shop: session.shop, recentEdits,
    currentPlan: plan, monthlyEdits, editsLimit, editsRemaining,
  };
};

export const action = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "execute") {
    let shopPlan = await prisma.shopPlan.findUnique({ where: { shop: session.shop } });
    if (!shopPlan) {
      shopPlan = await prisma.shopPlan.create({ data: { shop: session.shop } });
    }
    const PLAN_LIMITS = { free: 3, pro: 50, plus: Infinity };
    const plan = shopPlan.plan || "free";
    const editsLimit = PLAN_LIMITS[plan] || 3;
    if (editsLimit !== Infinity && shopPlan.monthlyEdits >= editsLimit) {
      return { success: false, limitReached: true, currentPlan: plan, monthlyEdits: shopPlan.monthlyEdits, editsLimit };
    }

    const changesRaw = formData.get("changes");
    const editName = formData.get("editName") || "Bulk Edit";
    const changes = JSON.parse(changesRaw);

    let successCount = 0;
    let errorCount = 0;
    const errors = [];
    const historyRecords = [];

    // Group changes by product
    const changesByProduct = {};
    for (const change of changes) {
      if (!changesByProduct[change.productId]) {
        changesByProduct[change.productId] = [];
      }
      changesByProduct[change.productId].push(change);
    }

    for (const [productId, productChanges] of Object.entries(changesByProduct)) {
      try {
        // Separate product-level and variant-level changes
        const productLevelChanges = productChanges.filter(c => ["title", "vendor", "productType", "status", "tags", "templateSuffix"].includes(c.field));
        const variantLevelChanges = productChanges.filter(c => ["price", "compareAtPrice", "sku", "barcode", "weight", "taxable"].includes(c.field));

        // Apply product-level changes
        if (productLevelChanges.length > 0) {
          const productInput = {};
          for (const change of productLevelChanges) {
            if (change.field === "title") productInput.title = change.newValue;
            else if (change.field === "vendor") productInput.vendor = change.newValue;
            else if (change.field === "productType") productInput.productType = change.newValue;
            else if (change.field === "status") productInput.status = change.newValue;
            else if (change.field === "tags") productInput.tags = change.newValue.split(",").map(t => t.trim()).filter(Boolean);
            else if (change.field === "templateSuffix") productInput.templateSuffix = change.newValue;
          }

          const productMutation = `#graphql
            mutation productUpdate($input: ProductInput!) {
              productUpdate(input: $input) {
                product { id title vendor productType status tags templateSuffix }
                userErrors { field message }
              }
            }`;

          const result = await admin.graphql(productMutation, {
            variables: { input: { id: productId, ...productInput } },
          });
          const resultData = await result.json();
          const userErrors = resultData.data?.productUpdate?.userErrors || [];
          if (userErrors.length > 0) {
            errorCount += productLevelChanges.length;
            errors.push({ product: productChanges[0]?.productTitle, errors: userErrors.map(e => e.message) });
          } else {
            successCount += productLevelChanges.length;
            for (const change of productLevelChanges) {
              historyRecords.push({
                shop: session.shop,
                productId: change.productId,
                variantId: change.variantId || productId,
                productTitle: change.productTitle,
                variantTitle: change.variantTitle || null,
                oldPrice: change.oldValue,
                newPrice: change.newValue,
                changeType: change.field,
                changeSource: "bulk_edit",
              });
            }
          }
        }

        // Apply variant-level changes
        if (variantLevelChanges.length > 0) {
          const variantMap = {};
          for (const change of variantLevelChanges) {
            if (!variantMap[change.variantId]) variantMap[change.variantId] = { id: change.variantId };
            const v = variantMap[change.variantId];
            if (change.field === "price") v.price = change.newValue;
            else if (change.field === "compareAtPrice") v.compareAtPrice = change.newValue;
            else if (change.field === "sku") v.sku = change.newValue;
            else if (change.field === "barcode") v.barcode = change.newValue;
            else if (change.field === "weight") {
              v.inventoryItem = v.inventoryItem || {};
              v.inventoryItem.measurement = v.inventoryItem.measurement || {};
              v.inventoryItem.measurement.weight = {
                value: parseFloat(change.newValue),
                unit: "POUNDS",
              };
            }

          }

          const variants = Object.values(variantMap);

          const mutation = `#graphql
            mutation productVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
              productVariantsBulkUpdate(productId: $productId, variants: $variants) {
                product { id }
                productVariants { id price compareAtPrice sku barcode inventoryItem { measurement { weight { value unit } } } }
                userErrors { field message }
              }
            }`;

          const result = await admin.graphql(mutation, {
            variables: { productId, variants },
          });
          const resultData = await result.json();
          const userErrors = resultData.data?.productVariantsBulkUpdate?.userErrors || [];
          if (userErrors.length > 0) {
            errorCount += variantLevelChanges.length;
            errors.push({ product: productChanges[0]?.productTitle, errors: userErrors.map(e => e.message) });
          } else {
            successCount += variantLevelChanges.length;
            for (const change of variantLevelChanges) {
              historyRecords.push({
                shop: session.shop,
                productId: change.productId,
                variantId: change.variantId,
                productTitle: change.productTitle,
                variantTitle: change.variantTitle || null,
                oldPrice: change.oldValue,
                newPrice: change.newValue,
                changeType: change.field,
                changeSource: "bulk_edit",
              });
            }
          }
        }
      } catch (err) {
        errorCount += productChanges.length;
        errors.push({ product: productChanges[0]?.productTitle, errors: [err.message || "Unknown error"] });
      }
    }

    if (historyRecords.length > 0) {
      await prisma.priceHistory.createMany({ data: historyRecords });
    }

    await prisma.bulkEdit.create({
      data: {
        shop: session.shop,
        name: editName,
        status: errorCount === 0 ? "completed" : "partial",
        productCount: successCount,
        changes: JSON.stringify(changes.slice(0, 50)),
      },
    });

    await prisma.shopPlan.update({
      where: { shop: session.shop },
      data: { monthlyEdits: { increment: 1 } },
    });

    return { success: true, successCount, errorCount, errors, totalProducts: Object.keys(changesByProduct).length };
  }

  if (intent === "revert") {
    const changesRaw = formData.get("changes");
    const changes = JSON.parse(changesRaw);
    let successCount = 0;
    let errorCount = 0;

    const changesByProduct = {};
    for (const change of changes) {
      if (!changesByProduct[change.productId]) changesByProduct[change.productId] = [];
      changesByProduct[change.productId].push(change);
    }

    for (const [productId, productChanges] of Object.entries(changesByProduct)) {
      try {
        const productLevelChanges = productChanges.filter(c => ["title", "vendor", "productType", "status", "tags"].includes(c.field));
        const variantLevelChanges = productChanges.filter(c => !["title", "vendor", "productType", "status", "tags"].includes(c.field));

        if (productLevelChanges.length > 0) {
          const productInput = {};
          for (const change of productLevelChanges) {
            if (change.field === "title") productInput.title = change.oldValue;
            else if (change.field === "vendor") productInput.vendor = change.oldValue;
            else if (change.field === "productType") productInput.productType = change.oldValue;
            else if (change.field === "status") productInput.status = change.oldValue;
            else if (change.field === "tags") productInput.tags = change.oldValue.split(",").map(t => t.trim()).filter(Boolean);
          }
          await admin.graphql(`#graphql
            mutation productUpdate($input: ProductInput!) {
              productUpdate(input: $input) { product { id } userErrors { field message } }
            }`, { variables: { input: { id: productId, ...productInput } } });
          successCount += productLevelChanges.length;
        }

        if (variantLevelChanges.length > 0) {
          const variants = variantLevelChanges.map(c => {
            const v = { id: c.variantId };
            if (c.field === "price") v.price = c.oldValue;
            else if (c.field === "compareAtPrice") v.compareAtPrice = c.oldValue;
            else if (c.field === "sku") v.sku = c.oldValue;
            else if (c.field === "barcode") v.barcode = c.oldValue;
            return v;
          });
          await admin.graphql(`#graphql
            mutation productVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
              productVariantsBulkUpdate(productId: $productId, variants: $variants) { product { id } userErrors { field message } }
            }`, { variables: { productId, variants } });
          successCount += variantLevelChanges.length;
        }
      } catch (err) {
        errorCount += productChanges.length;
      }
    }

    return { success: true, successCount, errorCount, reverted: true };
  }

  return { success: false };
};

/* ═══════════════════════════════════════════════════════════════
   FIELD DEFINITIONS — determines what can be edited and how
   ═══════════════════════════════════════════════════════════════ */

const EDITABLE_FIELDS = [
  // Numeric (variant-level)
  { value: "price", label: "Price", icon: "💰", category: "numeric", level: "variant", accessor: (v) => v.price },
  { value: "compareAtPrice", label: "Compare-at Price", icon: "🏷", category: "numeric", level: "variant", accessor: (v) => v.compareAtPrice },

  // Text (variant-level)
  { value: "sku", label: "SKU", icon: "🔢", category: "text", level: "variant", accessor: (v) => v.sku || "" },
  { value: "barcode", label: "Barcode", icon: "📊", category: "text", level: "variant", accessor: (v) => v.barcode || "" },
  { value: "weight", label: "Weight", icon: "⚖️", category: "numeric", level: "variant", accessor: (v) => { const w = v.inventoryItem?.measurement?.weight?.value; return w != null ? String(w) : "0"; } },
  // Text (product-level)
  { value: "title", label: "Title", icon: "📝", category: "text", level: "product", accessor: null },
  { value: "vendor", label: "Vendor", icon: "🏢", category: "text", level: "product", accessor: null },
  { value: "productType", label: "Product Type", icon: "📂", category: "text", level: "product", accessor: null },
  // Tags (product-level)
  { value: "tags", label: "Tags", icon: "🏷️", category: "tags", level: "product", accessor: null },
  // Select (product-level)
  { value: "status", label: "Status", icon: "🔄", category: "select", level: "product", accessor: null, options: ["ACTIVE", "DRAFT", "ARCHIVED"] },
  { value: "templateSuffix", label: "Product Template", icon: "📄", category: "text", level: "product", accessor: null },
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
  const field = EDITABLE_FIELDS.find(f => f.value === fieldValue);
  if (!field) return NUMERIC_CHANGE_TYPES;
  if (field.category === "numeric") return NUMERIC_CHANGE_TYPES;
  if (field.category === "text") return TEXT_CHANGE_TYPES;
  if (field.category === "tags") return TAG_CHANGE_TYPES;
  if (field.category === "select") return SELECT_CHANGE_TYPES;
  return NUMERIC_CHANGE_TYPES;
}

function getFieldDef(fieldValue) {
  return EDITABLE_FIELDS.find(f => f.value === fieldValue);
}

/* ═══════════════════════════════════════════════════════════════
   FILTER DEFINITIONS
   ═══════════════════════════════════════════════════════════════ */

const FILTER_FIELDS = [
  { value: "title", label: "Title", type: "text" },
  { value: "vendor", label: "Vendor", type: "text" },
  { value: "productType", label: "Product Type", type: "text" },
  { value: "status", label: "Status", type: "select", options: ["ACTIVE", "DRAFT", "ARCHIVED"] },
  { value: "tags", label: "Tags", type: "text" },
  { value: "sku", label: "SKU", type: "text" },
  { value: "variantTitle", label: "Variant Title", type: "text" },
  { value: "price", label: "Price", type: "number" },
  { value: "compareAtPrice", label: "Compare-at Price", type: "number" },
  { value: "inventoryQuantity", label: "Inventory", type: "number" },
  { value: "weight", label: "Weight", type: "number" },
  { value: "templateSuffix", label: "Product Template", type: "text" },
];

const TEXT_OPERATORS = [
  { value: "contains", label: "contains" },
  { value: "not_contains", label: "does not contain" },
  { value: "equals", label: "equals" },
  { value: "not_equals", label: "does not equal" },
  { value: "starts_with", label: "starts with" },
  { value: "ends_with", label: "ends with" },
  { value: "is_empty", label: "is empty" },
  { value: "is_not_empty", label: "is not empty" },
];

const NUMBER_OPERATORS = [
  { value: "equals", label: "equals" },
  { value: "not_equals", label: "does not equal" },
  { value: "greater_than", label: "is greater than" },
  { value: "less_than", label: "is less than" },
  { value: "greater_or_equal", label: "is greater than or equal to" },
  { value: "less_or_equal", label: "is less than or equal to" },
  { value: "between", label: "is between" },
];

const SELECT_OPERATORS = [
  { value: "equals", label: "is" },
  { value: "not_equals", label: "is not" },
];

function getOperatorsForField(fieldValue) {
  const field = FILTER_FIELDS.find((f) => f.value === fieldValue);
  if (!field) return TEXT_OPERATORS;
  if (field.type === "number") return NUMBER_OPERATORS;
  if (field.type === "select") return SELECT_OPERATORS;
  return TEXT_OPERATORS;
}

function evaluateFilter(product, rule) {
  let value;
  switch (rule.field) {
    case "price":
      value = product.variants?.edges?.[0]?.node?.price || "";
      break;
    case "compareAtPrice":
      value = product.variants?.edges?.[0]?.node?.compareAtPrice || "";
      break;
    case "inventoryQuantity":
      value = String(product.variants?.edges?.[0]?.node?.inventoryQuantity ?? "");
      break;
    case "sku":
      value = product.variants?.edges?.[0]?.node?.sku || "";
      break;
    case "weight":
      value = String(product.variants?.edges?.[0]?.node?.inventoryItem?.measurement?.weight?.value ?? "0");
      break;
    case "templateSuffix":
      value = product.templateSuffix || "";
      break;
    case "variantTitle":
      value = (product.variants?.edges || []).map(e => e.node?.title || "").join(", ");
      break;
    case "tags":
      value = (product.tags || []).join(", ");
      break;
    default:
      value = product[rule.field] || "";
  }

  const v = String(value).toLowerCase();
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
   QUICK PRESETS
   ═══════════════════════════════════════════════════════════════ */

const QUICK_PRESETS = [
  { label: "10% Off", icon: "🏷", mods: [{ field: "price", type: "decrease_percent", value: "10", rounding: "99" }] },
  { label: "20% Off", icon: "🔥", mods: [{ field: "price", type: "decrease_percent", value: "20", rounding: "99" }] },
  { label: "25% Off", icon: "💥", mods: [{ field: "price", type: "decrease_percent", value: "25", rounding: "99" }] },
  { label: "50% Off", icon: "⚡", mods: [{ field: "price", type: "decrease_percent", value: "50", rounding: "99" }] },
  { label: "+10%", icon: "📈", mods: [{ field: "price", type: "increase_percent", value: "10", rounding: "99" }] },
  { label: "+$5", icon: "💵", mods: [{ field: "price", type: "increase_fixed", value: "5", rounding: "none" }] },
  { label: "Set Compare-at", icon: "🏪", mods: [{ field: "compareAtPrice", type: "increase_percent", value: "20", rounding: "99" }], description: "Set compare-at price 20% above current price" },
  { label: "Round to .99", icon: "🎯", mods: [{ field: "price", type: "increase_fixed", value: "0", rounding: "99" }], description: "Round all prices to X.99" },
];

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
  select: { width: "100%", padding: "10px 12px", borderRadius: "8px", border: "1px solid #c4cdd5", fontSize: "14px", outline: "none", backgroundColor: "white", boxSizing: "border-box" },
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
  productRow: (selected) => ({
    display: "flex", alignItems: "center", gap: "12px", padding: "10px 16px", borderBottom: "1px solid #f1f2f3",
    cursor: "pointer", backgroundColor: selected ? "#f0f5ff" : "transparent", transition: "background-color 0.1s",
  }),
  presetBtn: (active) => ({
    display: "flex", flexDirection: "column", alignItems: "center", gap: "4px", padding: "12px 16px", borderRadius: "10px",
    border: active ? "2px solid #2c6ecb" : "1px solid #e1e3e5", backgroundColor: active ? "#f0f5ff" : "white",
    cursor: "pointer", minWidth: "80px", transition: "all 0.15s", fontSize: "12px", fontWeight: "600", color: "#202223",
  }),
  summaryCard: (color) => ({
    flex: 1, minWidth: "120px", padding: "20px", border: "1px solid #e1e3e5", borderRadius: "12px",
    textAlign: "center", borderTop: `3px solid ${color || "#e1e3e5"}`, backgroundColor: "white",
  }),
  badge: (tone) => ({
    display: "inline-block", padding: "2px 8px", borderRadius: "10px", fontSize: "11px", fontWeight: "600",
    backgroundColor: tone === "success" ? "#e3f1df" : tone === "critical" ? "#fef3f2" : tone === "warning" ? "#fef8e8" : "#e4e5e7",
    color: tone === "success" ? "#1a7f37" : tone === "critical" ? "#d72c0d" : tone === "warning" ? "#916a00" : "#637381",
  }),
  filterRule: { display: "flex", gap: "8px", alignItems: "center", padding: "8px 12px", backgroundColor: "#f9fafb", borderRadius: "8px", marginBottom: "6px", border: "1px solid #e1e3e5", flexWrap: "wrap" },
};

/* ═══════════════════════════════════════════════════════════════
   COMPONENT
   ═══════════════════════════════════════════════════════════════ */

export default function BulkEdit() {
  const { products, vendors, productTypes, allTags, collections, shop, recentEdits, currentPlan, monthlyEdits, editsLimit, editsRemaining } = useLoaderData();
  const fetcher = useFetcher();
  const navigate = useNavigate();
  const shopify = useAppBridge();

  const [step, setStep] = useState(1);

  // Step 1 state
  const [filterRules, setFilterRules] = useState([]);
  const [selectedIds, setSelectedIds] = useState(new Set());

  // Step 2 state
  const [editName, setEditName] = useState("");
  const [modifications, setModifications] = useState([]);
  const [activePreset, setActivePreset] = useState(null);

  // Post-execution state
  const [executionResult, setExecutionResult] = useState(null);
  const [lastChanges, setLastChanges] = useState(null);
  const [showConfirmDialog, setShowConfirmDialog] = useState(false);

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
  const clearAllFilters = () => setFilterRules([]);

  // Filtered products
  const filtered = useMemo(() => {
    return products.filter((p) => {
      for (const rule of filterRules) {
        if (!evaluateFilter(p, rule)) return false;
      }
      return true;
    });
  }, [products, filterRules]);

  const selected = useMemo(() => filtered.filter((p) => selectedIds.has(p.id)), [filtered, selectedIds]);
  const totalVariants = useMemo(() => selected.reduce((s, p) => s + (p.variants?.edges?.length || 0), 0), [selected]);

  const toggleProduct = (id) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    if (selectedIds.size === filtered.length && filtered.length > 0) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(filtered.map((p) => p.id)));
    }
  };

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
        // When field changes, reset type to first available for that category
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

  const applyPreset = (preset, index) => {
    setActivePreset(index);
    setModifications(preset.mods.map((m, i) => ({ ...m, id: Date.now() + i, value2: "" })));
  };

  // ── Value calculation ──
  const calcValue = (current, mod) => {
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
      const priceFields = ["price", "compareAtPrice", "cost"];
      if (priceFields.includes(mod.field)) {
        if (mod.rounding === "99") r = Math.floor(r) + 0.99;
        else if (mod.rounding === "95") r = Math.floor(r) + 0.95;
        else if (mod.rounding === "whole") r = Math.round(r);
        return Math.max(0, r).toFixed(2);
      }
      // Non-price numeric: no forced decimals
      r = Math.max(0, r);
      return r % 1 === 0 ? String(r) : String(parseFloat(r.toFixed(4)));
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
      const curTags = (current || "").split(",").map(t => t.trim()).filter(Boolean);
      switch (mod.type) {
        case "add": {
          const newTags = mod.value.split(",").map(t => t.trim()).filter(Boolean);
          return [...new Set([...curTags, ...newTags])].join(", ");
        }
        case "remove": {
          const removeTags = mod.value.split(",").map(t => t.trim().toLowerCase());
          return curTags.filter(t => !removeTags.includes(t.toLowerCase())).join(", ");
        }
        case "set": return mod.value;
        default: return current;
      }
    }

    if (fieldDef.category === "select") {
      return mod.value;
    }

    return null;
  };

  // ── Build changes ──
  const changes = useMemo(() => {
    if (step !== 3) return [];
    const result = [];
    for (const product of selected) {
      for (const mod of modifications) {
        const fieldDef = getFieldDef(mod.field);
        if (!fieldDef) continue;

        if (fieldDef.level === "product") {
          // Product-level field — one change per product
          let cur;
          if (mod.field === "tags") cur = (product.tags || []).join(", ");
          else cur = product[mod.field] || "";

          const nv = calcValue(cur, mod);
          if (nv === null) continue;
          if (nv === cur) continue;

          result.push({
            productId: product.id,
            productTitle: product.title,
            variantId: null,
            variantTitle: null,
            field: mod.field,
            oldValue: cur,
            newValue: nv,
            modificationType: mod.type,
          });
        } else {
          // Variant-level field — one change per variant
          for (const edge of product.variants?.edges || []) {
            const variant = edge.node;
            const cur = fieldDef.accessor ? fieldDef.accessor(variant) : "";
            if (!cur && mod.type !== "exact" && mod.type !== "set" && fieldDef.category === "numeric") continue;

            const nv = calcValue(cur || (fieldDef.category === "numeric" ? "0" : ""), mod);
            if (nv === null) continue;

            // Compare
            if (fieldDef.category === "numeric") {
              if (parseFloat(cur || "0") === parseFloat(nv)) continue;
            } else {
              if ((cur || "") === nv) continue;
            }

            result.push({
              productId: product.id,
              productTitle: product.title,
              variantId: variant.id,
              variantTitle: variant.title,
              field: mod.field,
              oldValue: cur || (fieldDef.category === "numeric" ? "0" : ""),
              newValue: nv,
              modificationType: mod.type,
            });
          }
        }
      }
    }
    return result;
  }, [step, selected, modifications]);

  const canConfigure = selectedIds.size > 0;
  const canPreview = canConfigure && modifications.length > 0 && modifications.every((m) => m.value);

  // ── Live preview ──
  const livePreview = useMemo(() => {
    if (modifications.length === 0 || !modifications.every(m => m.value)) return [];
    const examples = [];
    for (const product of selected.slice(0, 8)) {
      for (const mod of modifications) {
        const fieldDef = getFieldDef(mod.field);
        if (!fieldDef) continue;

        if (fieldDef.level === "product") {
          let cur;
          if (mod.field === "tags") cur = (product.tags || []).join(", ");
          else cur = product[mod.field] || "";
          const nv = calcValue(cur, mod);
          if (nv === null || nv === cur) continue;
          examples.push({ title: product.title, variant: null, field: mod.field, oldValue: cur, newValue: nv });
        } else {
          for (const edge of product.variants?.edges || []) {
            const variant = edge.node;
            const cur = fieldDef.accessor ? fieldDef.accessor(variant) : "";
            const nv = calcValue(cur || (fieldDef.category === "numeric" ? "0" : ""), mod);
            if (nv === null) continue;
            if (fieldDef.category === "numeric" ? parseFloat(cur || "0") === parseFloat(nv) : (cur || "") === nv) continue;
            examples.push({
              title: product.title,
              variant: variant.title !== "Default Title" ? variant.title : null,
              field: mod.field,
              oldValue: cur || (fieldDef.category === "numeric" ? "0" : "(empty)"),
              newValue: nv,
            });
            if (examples.length >= 10) break;
          }
        }
        if (examples.length >= 10) break;
      }
      if (examples.length >= 10) break;
    }
    return examples;
  }, [selected, modifications]);

  // ── Execution ──
  const handleExecute = () => setShowConfirmDialog(true);

  const confirmExecute = () => {
    setShowConfirmDialog(false);
    // Build changes fresh
    const changesToSubmit = [];
    for (const product of selected) {
      for (const mod of modifications) {
        const fieldDef = getFieldDef(mod.field);
        if (!fieldDef) continue;
        if (fieldDef.level === "product") {
          let cur;
          if (mod.field === "tags") cur = (product.tags || []).join(", ");
          else cur = product[mod.field] || "";
          const nv = calcValue(cur, mod);
          if (nv === null || nv === cur) continue;
          changesToSubmit.push({ productId: product.id, productTitle: product.title, variantId: null, variantTitle: null, field: mod.field, oldValue: cur, newValue: nv, modificationType: mod.type });
        } else {
          for (const edge of product.variants?.edges || []) {
            const variant = edge.node;
            const cur = fieldDef.accessor ? fieldDef.accessor(variant) : "";
            const nv = calcValue(cur || (fieldDef.category === "numeric" ? "0" : ""), mod);
            if (nv === null) continue;
            if (fieldDef.category === "numeric" ? parseFloat(cur || "0") === parseFloat(nv) : (cur || "") === nv) continue;
            changesToSubmit.push({ productId: product.id, productTitle: product.title, variantId: variant.id, variantTitle: variant.title, field: mod.field, oldValue: cur || (fieldDef.category === "numeric" ? "0" : ""), newValue: nv, modificationType: mod.type });
          }
        }
      }
    }
    if (changesToSubmit.length === 0) { shopify.toast.show("No changes to apply"); return; }
    setLastChanges(changesToSubmit);
    fetcher.submit(
      { intent: "execute", changes: JSON.stringify(changesToSubmit), editName: editName || "Bulk Edit" },
      { method: "POST" }
    );
  };

  const handleRevert = () => {
    if (!lastChanges) return;
    fetcher.submit({ intent: "revert", changes: JSON.stringify(lastChanges) }, { method: "POST" });
  };

  useEffect(() => {
    if (fetcher.data?.limitReached) {
      shopify.toast.show("Monthly edit limit reached! Upgrade your plan.", { isError: true });
    }
    if (fetcher.data?.success && !fetcher.data?.reverted) {
      setExecutionResult(fetcher.data);
      setStep(4);
      shopify.toast.show(fetcher.data.successCount + " changes applied" + (fetcher.data.errorCount > 0 ? ", " + fetcher.data.errorCount + " errors" : ""));
    }
    if (fetcher.data?.reverted) {
      shopify.toast.show("Reverted " + fetcher.data.successCount + " changes to original values");
      setExecutionResult(null);
      setLastChanges(null);
      setStep(1);
    }
  }, [fetcher.data]);

  const isExecuting = fetcher.state !== "idle";

  // ── Field label helper ──
  const fieldLabel = (fieldValue) => {
    const f = EDITABLE_FIELDS.find(fd => fd.value === fieldValue);
    return f ? `${f.icon} ${f.label}` : fieldValue;
  };

  // ── Format display value ──
  const formatValue = (fieldValue, val) => {
    const f = getFieldDef(fieldValue);
    if (!f) return val;
    if (f.category === "numeric") {
      const priceFields = ["price", "compareAtPrice", "cost"];
      if (priceFields.includes(fieldValue)) return `$${val}`;
      // Non-price numeric fields: show plain number
      return val === "" || val === null || val === undefined ? "0" : String(val);
    }
    if (val === "") return "(empty)";
    if (val && val.length > 50) return val.substring(0, 50) + "...";
    return val;
  };

  // ── Impact summary for numeric changes ──
  const priceImpact = useMemo(() => {
    const numericChanges = changes.filter(c => {
      const f = getFieldDef(c.field);
      return f?.category === "numeric";
    });
    if (numericChanges.length === 0) return null;
    let totalOld = 0, totalNew = 0, increases = 0, decreases = 0, unchanged = 0;
    for (const c of numericChanges) {
      const o = parseFloat(c.oldValue);
      const n = parseFloat(c.newValue);
      totalOld += o;
      totalNew += n;
      if (n > o) increases++;
      else if (n < o) decreases++;
      else unchanged++;
    }
    const netChange = (totalNew - totalOld).toFixed(2);
    const pctChange = totalOld > 0 ? ((totalNew - totalOld) / totalOld * 100).toFixed(1) : "0.0";
    const avgOld = numericChanges.length > 0 ? (totalOld / numericChanges.length).toFixed(2) : "0.00";
    const avgNew = numericChanges.length > 0 ? (totalNew / numericChanges.length).toFixed(2) : "0.00";
    const hasPriceFields = numericChanges.some(c => ["price", "compareAtPrice", "cost"].includes(c.field));
    return { netChange, pctChange, avgOld, avgNew, increases, decreases, unchanged, hasPriceFields };
  }, [changes]);

  return (
    <s-page title="Bulk Editor" subtitle="Edit any product field in bulk">
      {/* Billing banner */}
      {currentPlan === "free" && (
        <s-box padding="base">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 16px", backgroundColor: "#f0f5ff", borderRadius: "10px", border: "1px solid #c4d7f2" }}>
            <span style={{ fontSize: "14px", color: "#1a3a6b" }}>
              <strong>{editsRemaining}</strong> bulk edit{editsRemaining !== 1 ? "s" : ""} remaining this month ({currentPlan.charAt(0).toUpperCase() + currentPlan.slice(1)} plan)
            </span>
            <button style={{ ...styles.primaryBtn(true), padding: "6px 16px", fontSize: "13px" }} onClick={() => navigate("/app/billing")}>View Plans</button>
          </div>
        </s-box>
      )}

      {/* Step indicator */}
      <s-box padding="base">
        <div style={{ display: "flex", justifyContent: "center", alignItems: "center", gap: "8px" }}>
          {[
            { num: 1, label: "Select Products" },
            { num: 2, label: "Configure" },
            { num: 3, label: "Review & Execute" },
          ].map((s, i) => (
            <div key={s.num} style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <button
                style={styles.stepIndicator(step === s.num, step > s.num, step >= s.num)}
                onClick={() => { if (step > s.num) setStep(s.num); }}
              >
                <span style={styles.stepNumber(step === s.num, step > s.num)}>
                  {step > s.num ? "✓" : s.num}
                </span>
                {s.label}
              </button>
              {i < 2 && <span style={{ color: "#babec3", fontSize: "18px" }}>›</span>}
            </div>
          ))}
        </div>
      </s-box>

      {/* ════════════════════ STEP 1: SELECT PRODUCTS ════════════════════ */}
      {step === 1 && (
        <s-section>
          {/* Filter builder */}
          <s-box padding="base">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px" }}>
              <div>
                <div style={{ fontWeight: 600, fontSize: "15px", color: "#202223" }}>Filter Products</div>
                <div style={{ fontSize: "12px", color: "#637381" }}>Add rules to narrow down which products to edit</div>
              </div>
              <div style={{ display: "flex", gap: "8px" }}>
                {filterRules.length > 0 && (
                  <button onClick={clearAllFilters} style={{ ...styles.secondaryBtn, padding: "6px 12px", fontSize: "12px", color: "#d72c0d" }}>Clear All</button>
                )}
                <button onClick={addFilterRule} style={{ ...styles.primaryBtn(true), padding: "6px 16px", fontSize: "13px" }}>+ Add Filter</button>
              </div>
            </div>

            {filterRules.map((rule, idx) => {
              const ops = getOperatorsForField(rule.field);
              const fieldType = FILTER_FIELDS.find(f => f.value === rule.field)?.type || "text";
              const fieldOptions = FILTER_FIELDS.find(f => f.value === rule.field)?.options || [];
              return (
                <div key={rule.id} style={styles.filterRule}>
                  <span style={{ fontSize: "12px", fontWeight: 600, color: "#637381", minWidth: "40px" }}>{idx === 0 ? "Where" : "AND"}</span>
                  <select value={rule.field} onChange={(e) => updateFilterRule(rule.id, "field", e.target.value)} style={{ ...styles.select, width: "auto", minWidth: "120px" }}>
                    {FILTER_FIELDS.map(f => <option key={f.value} value={f.value}>{f.label}</option>)}
                  </select>
                  <select value={rule.operator} onChange={(e) => updateFilterRule(rule.id, "operator", e.target.value)} style={{ ...styles.select, width: "auto", minWidth: "140px" }}>
                    {ops.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                  {!["is_empty", "is_not_empty"].includes(rule.operator) && (
                    fieldType === "select" ? (
                      <select value={rule.value} onChange={(e) => updateFilterRule(rule.id, "value", e.target.value)} style={{ ...styles.select, width: "auto", minWidth: "120px" }}>
                        <option value="">Select...</option>
                        {fieldOptions.map(o => <option key={o} value={o}>{o}</option>)}
                      </select>
                    ) : (
                      <input type={fieldType === "number" ? "number" : "text"} placeholder="Value..." value={rule.value} onChange={(e) => updateFilterRule(rule.id, "value", e.target.value)} style={{ ...styles.input, width: "auto", minWidth: "120px" }} />
                    )
                  )}
                  {rule.operator === "between" && (
                    <>
                      <span style={{ fontSize: "12px", color: "#637381" }}>and</span>
                      <input type="number" placeholder="Max..." value={rule.value2} onChange={(e) => updateFilterRule(rule.id, "value2", e.target.value)} style={{ ...styles.input, width: "auto", minWidth: "80px" }} />
                    </>
                  )}
                  <button onClick={() => removeFilterRule(rule.id)} style={{ border: "none", background: "none", cursor: "pointer", color: "#bf0711", fontSize: "16px", padding: "4px" }}>✕</button>
                </div>
              );
            })}

            {filterRules.length > 0 && (
              <div style={{ fontSize: "12px", color: "#637381", marginTop: "6px" }}>
                {filterRules.length} filter{filterRules.length !== 1 ? "s" : ""} active — showing {filtered.length} of {products.length} products
              </div>
            )}
          </s-box>

          {/* Select all */}
          <s-box padding="base">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <label style={{ display: "flex", alignItems: "center", gap: "8px", cursor: "pointer" }}>
                <input type="checkbox" checked={selectedIds.size === filtered.length && filtered.length > 0} onChange={toggleAll} style={{ width: "18px", height: "18px" }} />
                <span style={{ fontWeight: 600, fontSize: "14px" }}>
                  {selectedIds.size === filtered.length && filtered.length > 0 ? "Deselect All" : "Select All"} ({filtered.length})
                </span>
              </label>
              <div style={{ display: "flex", gap: "16px", fontSize: "13px", color: "#637381" }}>
                <span>{selectedIds.size} selected</span>
                <span>{totalVariants} variant{totalVariants !== 1 ? "s" : ""}</span>
              </div>
            </div>
          </s-box>

          {/* Product list */}
          <div style={{ maxHeight: "520px", overflowY: "auto", border: "1px solid #e1e3e5", borderRadius: "10px" }}>
            {filtered.map((product) => {
              const sel = selectedIds.has(product.id);
              const variants = product.variants?.edges || [];
              const vc = variants.length;
              const img = product.featuredMedia?.preview?.image?.url;
              const priceDisplay = vc === 1
                ? `$${variants[0]?.node.price}`
                : `$${variants[0]?.node.price} – $${variants[variants.length - 1]?.node.price}`;
              return (
                <div key={product.id} style={styles.productRow(sel)} onClick={() => toggleProduct(product.id)}>
                  <input type="checkbox" checked={sel} readOnly style={{ width: "18px", height: "18px", cursor: "pointer", flexShrink: 0 }} />
                  {img ? (
                    <img src={img} alt="" style={{ width: "44px", height: "44px", borderRadius: "8px", objectFit: "cover", flexShrink: 0, border: "1px solid #e1e3e5" }} />
                  ) : (
                    <div style={{ width: "44px", height: "44px", borderRadius: "8px", backgroundColor: "#f1f2f3", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: "18px", color: "#babec3" }}>📦</div>
                  )}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600, fontSize: "14px", color: "#202223", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{product.title}</div>
                    <div style={{ fontSize: "12px", color: "#637381", display: "flex", gap: "8px", flexWrap: "wrap", marginTop: "2px" }}>
                      <span>{vc} variant{vc !== 1 ? "s" : ""}</span>
                      {product.vendor && <span>· {product.vendor}</span>}
                      {product.productType && <span>· {product.productType}</span>}
                    </div>
                  </div>
                  <div style={{ textAlign: "right", flexShrink: 0 }}>
                    <div style={{ fontWeight: 600, fontSize: "14px", color: "#202223" }}>{priceDisplay}</div>
                    <span style={styles.badge(product.status === "ACTIVE" ? "success" : product.status === "DRAFT" ? "warning" : "default")}>
                      {product.status.charAt(0) + product.status.slice(1).toLowerCase()}
                    </span>
                  </div>
                </div>
              );
            })}
            {filtered.length === 0 && (
              <div style={{ padding: "60px 20px", textAlign: "center" }}>
                <div style={{ fontSize: "32px", marginBottom: "8px" }}>🔍</div>
                <div style={{ fontSize: "15px", color: "#637381" }}>No products match your filters</div>
              </div>
            )}
          </div>

          <s-box padding="base">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div style={{ fontSize: "13px", color: "#637381" }}>
                {selectedIds.size > 0 ? `Ready to configure ${selectedIds.size} product${selectedIds.size !== 1 ? "s" : ""}` : "Select at least one product to continue"}
              </div>
              <button style={styles.primaryBtn(canConfigure)} onClick={() => canConfigure && setStep(2)} disabled={!canConfigure}>
                Continue to Configure →
              </button>
            </div>
          </s-box>
        </s-section>
      )}

      {/* ════════════════════ STEP 2: CONFIGURE ════════════════════ */}
      {step === 2 && (
        <s-section>
          <s-box padding="base">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
              <div>
                <s-text variant="headingMd" fontWeight="bold">Configure Changes</s-text>
                <s-text tone="subdued" variant="bodySm">
                  Editing {selectedIds.size} product{selectedIds.size !== 1 ? "s" : ""} ({totalVariants} variant{totalVariants !== 1 ? "s" : ""})
                </s-text>
              </div>
              <button style={styles.secondaryBtn} onClick={() => setStep(1)}>← Change Selection</button>
            </div>
          </s-box>

          {/* Quick Presets */}
          <s-box padding="base">
            <div style={{ fontWeight: 600, fontSize: "14px", color: "#202223", marginBottom: "10px" }}>Quick Presets (Price)</div>
            <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
              {QUICK_PRESETS.map((preset, idx) => (
                <button key={idx} style={styles.presetBtn(activePreset === idx)} onClick={() => applyPreset(preset, idx)} title={preset.description || preset.label}>
                  <span style={{ fontSize: "20px" }}>{preset.icon}</span>
                  <span>{preset.label}</span>
                </button>
              ))}
            </div>
          </s-box>

          {/* Edit name */}
          <s-box padding="base">
            <div style={styles.card}>
              <div style={{ marginBottom: "4px", fontWeight: 600, fontSize: "13px" }}>Edit Name (optional)</div>
              <input type="text" placeholder="e.g., Summer Sale, Vendor Update, Tag Cleanup" value={editName} onChange={(e) => setEditName(e.target.value)} style={styles.input} />
            </div>
          </s-box>

          {/* Modifications */}
          <s-box padding="base">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px" }}>
              <div>
                <div style={{ fontWeight: 600, fontSize: "15px", color: "#202223" }}>Modifications</div>
                <div style={{ fontSize: "12px", color: "#637381" }}>Add one or more field changes to apply to selected products</div>
              </div>
              <button onClick={() => { addMod(); setActivePreset(null); }} style={styles.secondaryBtn}>+ Add Modification</button>
            </div>

            {modifications.length === 0 ? (
              <div style={{ textAlign: "center", padding: "40px 20px", border: "2px dashed #d2d5d8", borderRadius: "12px", backgroundColor: "#fafbfb" }}>
                <div style={{ fontSize: "32px", marginBottom: "8px" }}>⚡</div>
                <div style={{ fontSize: "15px", fontWeight: 600, marginBottom: "4px" }}>Choose a preset above or add a custom modification</div>
                <div style={{ fontSize: "13px", color: "#637381", marginBottom: "16px" }}>You can edit any product field: price, title, vendor, tags, status, SKU, and more</div>
                <button onClick={() => { addMod(); setActivePreset(null); }} style={styles.primaryBtn(true)}>Add Custom Modification</button>
              </div>
            ) : (
              modifications.map((mod, idx) => {
                const fieldDef = getFieldDef(mod.field);
                const changeTypes = getChangeTypes(mod.field);
                const isNumeric = fieldDef?.category === "numeric";
                const isSelect = fieldDef?.category === "select";
                const isFindReplace = mod.type === "find_replace";

                return (
                  <div key={mod.id} style={{ ...styles.card, borderLeft: "3px solid #2c6ecb" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px" }}>
                      <div style={{ fontWeight: 600, fontSize: "14px", color: "#2c6ecb" }}>
                        {fieldDef?.icon || "📝"} {fieldDef?.label || mod.field} — Modification {idx + 1}
                        <span style={{ fontSize: "11px", color: "#637381", fontWeight: 400, marginLeft: "8px" }}>
                          ({fieldDef?.level === "product" ? "product-level" : "per variant"})
                        </span>
                      </div>
                      <button onClick={() => { removeMod(mod.id); setActivePreset(null); }} style={{ border: "none", background: "none", cursor: "pointer", color: "#bf0711", fontSize: "20px", padding: "4px 8px" }}>✕</button>
                    </div>

                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
                      <div>
                        <div style={{ fontSize: "13px", fontWeight: 600, marginBottom: "4px" }}>Field to Edit</div>
                        <select value={mod.field} onChange={(e) => { updateMod(mod.id, "field", e.target.value); setActivePreset(null); }} style={styles.select}>
                          <optgroup label="Pricing (per variant)">
                            <option value="price">Price</option>
                            <option value="compareAtPrice">Compare-at Price</option>
                          </optgroup>
                          <optgroup label="Variant Fields">
                            <option value="sku">SKU</option>
                            <option value="barcode">Barcode</option>
                            <option value="weight">Weight</option>
                          </optgroup>
                          <optgroup label="Product Fields">
                            <option value="title">Title</option>
                            <option value="vendor">Vendor</option>
                            <option value="productType">Product Type</option>
                            <option value="tags">Tags</option>
                            <option value="status">Status</option>
                            <option value="templateSuffix">Product Template</option>
                          </optgroup>
                        </select>
                      </div>
                      <div>
                        <div style={{ fontSize: "13px", fontWeight: 600, marginBottom: "4px" }}>Change Type</div>
                        <select value={mod.type} onChange={(e) => { updateMod(mod.id, "type", e.target.value); setActivePreset(null); }} style={styles.select}>
                          {changeTypes.map(ct => <option key={ct.value} value={ct.value}>{ct.label}</option>)}
                        </select>
                      </div>
                    </div>

                    <div style={{ display: "grid", gridTemplateColumns: isFindReplace ? "1fr 1fr" : isNumeric ? "1fr 1fr" : "1fr", gap: "12px", marginTop: "12px" }}>
                      <div>
                        <div style={{ fontSize: "13px", fontWeight: 600, marginBottom: "4px" }}>
                          {isFindReplace ? "Find" : "Value"} {isNumeric && mod.type.includes("percent") ? "(%)" : (mod.field === "price" || mod.field === "compareAtPrice" || mod.field === "cost") ? "($)" : ""}
                        </div>
                        {isSelect ? (
                          <select value={mod.value} onChange={(e) => { updateMod(mod.id, "value", e.target.value); setActivePreset(null); }} style={styles.select}>
                            <option value="">Select...</option>
                            {(fieldDef.options || []).map(o => <option key={o} value={o}>{o}</option>)}
                          </select>
                        ) : (
                          <input
                            type={isNumeric ? "number" : "text"}
                            placeholder={isNumeric ? (mod.type.includes("percent") ? "e.g., 10" : mod.field === "weight" ? "e.g., 1.5" : mod.field === "inventoryQuantity" ? "e.g., 100" : mod.type === "exact" ? "e.g., 29.99" : "e.g., 5.00") : mod.field === "tags" ? "e.g., sale, clearance" : "Enter value..."}
                            value={mod.value}
                            onChange={(e) => { updateMod(mod.id, "value", e.target.value); setActivePreset(null); }}
                            style={styles.input}
                            min={isNumeric ? "0" : undefined}
                            step={isNumeric ? (mod.type.includes("percent") ? "1" : "0.01") : undefined}
                          />
                        )}
                      </div>
                      {isFindReplace && (
                        <div>
                          <div style={{ fontSize: "13px", fontWeight: 600, marginBottom: "4px" }}>Replace with</div>
                          <input type="text" placeholder="Replacement text..." value={mod.value2 || ""} onChange={(e) => updateMod(mod.id, "value2", e.target.value)} style={styles.input} />
                        </div>
                      )}
                      {isNumeric && !isFindReplace && (mod.field === "price" || mod.field === "compareAtPrice" || mod.field === "cost") && (
                        <div>
                          <div style={{ fontSize: "13px", fontWeight: 600, marginBottom: "4px" }}>Rounding</div>
                          <select value={mod.rounding} onChange={(e) => { updateMod(mod.id, "rounding", e.target.value); setActivePreset(null); }} style={styles.select}>
                            <option value="none">No rounding (exact result)</option>
                            <option value="99">Round to X.99</option>
                            <option value="95">Round to X.95</option>
                            <option value="whole">Round to whole number</option>
                          </select>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </s-box>

          {/* Live Preview */}
          {livePreview.length > 0 && (
            <s-box padding="base">
              <div style={{ ...styles.card, borderLeft: "3px solid #2c6ecb", backgroundColor: "#f9fafb" }}>
                <div style={{ fontWeight: 600, fontSize: "14px", color: "#2c6ecb", marginBottom: "10px" }}>
                  👁 Live Preview — How fields will change
                </div>
                <div style={{ borderRadius: "8px", border: "1px solid #e1e3e5", overflow: "hidden" }}>
                  <div style={{ display: "flex", padding: "8px 12px", backgroundColor: "#f6f6f7", fontSize: "11px", fontWeight: 700, color: "#637381", textTransform: "uppercase", letterSpacing: "0.5px" }}>
                    <div style={{ flex: 2 }}>Product</div>
                    <div style={{ flex: 1, textAlign: "center" }}>Field</div>
                    <div style={{ flex: 2, textAlign: "right" }}>Change</div>
                  </div>
                  {livePreview.map((item, i) => (
                    <div key={i} style={{ display: "flex", alignItems: "center", padding: "8px 12px", borderBottom: "1px solid #f1f2f3", fontSize: "13px" }}>
                      <div style={{ flex: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        <span style={{ fontWeight: 600 }}>{item.title}</span>
                        {item.variant && <span style={{ color: "#637381" }}> — {item.variant}</span>}
                      </div>
                      <div style={{ flex: 1, textAlign: "center" }}>
                        <span style={styles.badge("default")}>{getFieldDef(item.field)?.label || item.field}</span>
                      </div>
                      <div style={{ flex: 2, textAlign: "right" }}>
                        <span style={{ textDecoration: "line-through", color: "#8c9196" }}>{formatValue(item.field, item.oldValue)}</span>
                        <span style={{ color: "#8c9196", margin: "0 8px" }}>→</span>
                        <span style={{ fontWeight: 700, color: "#202223" }}>{formatValue(item.field, item.newValue)}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </s-box>
          )}

          {/* Navigation */}
          <s-box padding="base">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <button style={styles.secondaryBtn} onClick={() => setStep(1)}>← Back to Selection</button>
              <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                {!canPreview && modifications.length > 0 && (
                  <span style={{ fontSize: "13px", color: "#d72c0d" }}>Enter a value for all modifications</span>
                )}
                <button style={styles.primaryBtn(canPreview)} onClick={() => canPreview && setStep(3)} disabled={!canPreview}>
                  Review Changes →
                </button>
              </div>
            </div>
          </s-box>
        </s-section>
      )}

      {/* ════════════════════ STEP 3: REVIEW & EXECUTE ════════════════════ */}
      {step === 3 && (
        <s-section>
          <s-box padding="base">
            <s-text variant="headingMd" fontWeight="bold">Review & Execute</s-text>
            <s-text tone="subdued" variant="bodySm">Double-check everything before applying changes. You can undo after execution.</s-text>
            <div style={{ marginTop: "8px", fontSize: "13px", color: "#637381" }}>
              {selected.length} product{selected.length !== 1 ? "s" : ""} selected • {totalVariants} variant{totalVariants !== 1 ? "s" : ""} total • {modifications.length} modification{modifications.length !== 1 ? "s" : ""} configured
            </div>
          </s-box>

          {/* Active Filters */}
          {filterRules.length > 0 && (
            <s-box padding="base">
              <div style={{ fontWeight: 600, fontSize: "14px", marginBottom: "8px" }}>🔍 Active Filters</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
                {filterRules.map((rule, idx) => {
                  const fieldDef2 = FILTER_FIELDS.find(f => f.value === rule.field);
                  const ops = getOperatorsForField(rule.field);
                  const opDef = ops.find(o => o.value === rule.operator);
                  return (
                    <span key={rule.id} style={{ display: "inline-flex", alignItems: "center", gap: "4px", padding: "6px 12px", borderRadius: "20px", backgroundColor: "#e8f0fe", border: "1px solid #c4d7f2", fontSize: "13px", color: "#1a3a6b" }}>
                      {idx > 0 && <span style={{ fontWeight: 600, marginRight: "2px" }}>AND</span>}
                      <span style={{ fontWeight: 600 }}>{fieldDef2?.label || rule.field}</span>
                      <span>{opDef?.label || rule.operator}</span>
                      {rule.value && <span style={{ fontWeight: 700 }}>"{rule.value}"</span>}
                      {rule.value2 && <span> and <span style={{ fontWeight: 700 }}>"{rule.value2}"</span></span>}
                    </span>
                  );
                })}
              </div>
            </s-box>
          )}

          {/* Diagnostic when 0 changes */}
          {changes.length === 0 && selected.length > 0 && modifications.length > 0 && (
            <s-box padding="base">
              <div style={{ padding: "16px", backgroundColor: "#fff8e6", border: "1px solid #f5d680", borderRadius: "10px" }}>
                <div style={{ fontWeight: 700, color: "#916a00", marginBottom: "8px" }}>⚠️ No changes detected</div>
                <div style={{ fontSize: "13px", color: "#4a3800" }}>
                  The modification produces no changes. Products may already have the target value, or the field is empty.
                </div>
                <div style={{ fontSize: "12px", color: "#637381", marginTop: "8px", borderTop: "1px solid #f0e4c0", paddingTop: "8px" }}>
                  Sample: {selected.slice(0, 2).map(p => `"${p.title}"`).join(", ")}
                </div>
              </div>
            </s-box>
          )}

          {/* Impact Summary (numeric only) */}
          {priceImpact && (
            <s-box padding="base">
              <div style={{ display: "flex", gap: "12px", flexWrap: "wrap" }}>
                <div style={styles.summaryCard("#2c6ecb")}>
                  <div style={{ fontSize: "28px", fontWeight: 700 }}>{changes.length}</div>
                  <div style={{ fontSize: "12px", color: "#637381", marginTop: "4px" }}>Total Changes</div>
                </div>
                <div style={styles.summaryCard("#2c6ecb")}>
                  <div style={{ fontSize: "28px", fontWeight: 700 }}>{selected.length}</div>
                  <div style={{ fontSize: "12px", color: "#637381", marginTop: "4px" }}>Products</div>
                </div>
                <div style={styles.summaryCard("#2c6ecb")}>
                  <div style={{ fontSize: "28px", fontWeight: 700 }}>
                    {parseFloat(priceImpact.netChange) > 0 ? "+" : ""}{priceImpact.hasPriceFields ? "$" : ""}{priceImpact.netChange}
                  </div>
                  <div style={{ fontSize: "12px", color: "#637381", marginTop: "4px" }}>Net Change ({priceImpact.pctChange}%)</div>
                </div>
              </div>
            </s-box>
          )}

          {/* Modifications applied */}
          <s-box padding="base">
            <div style={{ fontWeight: 600, fontSize: "14px", marginBottom: "8px" }}>Modifications Applied</div>
            {modifications.map((mod, idx) => {
              const fd = getFieldDef(mod.field);
              return (
                <div key={mod.id} style={{ padding: "10px 14px", marginBottom: "6px", borderRadius: "8px", backgroundColor: "#f6f6f7", fontSize: "14px" }}>
                  <strong>{idx + 1}.</strong> {fd?.icon} {fd?.label} → {getChangeTypes(mod.field).find(ct => ct.value === mod.type)?.label}: <strong>{mod.value}</strong>
                  {mod.type === "find_replace" && <> → <strong>{mod.value2 || "(empty)"}</strong></>}
                  {mod.rounding && mod.rounding !== "none" && <span style={{ color: "#637381" }}> (round to .{mod.rounding === "whole" ? "00" : mod.rounding})</span>}
                </div>
              );
            })}
          </s-box>

          {/* Full change table */}
          <s-box padding="base">
            <div style={{ fontWeight: 600, fontSize: "14px", marginBottom: "8px" }}>All Changes ({changes.length})</div>
            <div style={{ maxHeight: "400px", overflowY: "auto", borderRadius: "10px", border: "1px solid #e1e3e5" }}>
              <div style={{ display: "flex", padding: "8px 12px", backgroundColor: "#f6f6f7", fontSize: "11px", fontWeight: 700, color: "#637381", textTransform: "uppercase", letterSpacing: "0.5px", position: "sticky", top: 0, zIndex: 1 }}>
                <div style={{ flex: 2 }}>Product / Variant</div>
                <div style={{ flex: 0.5, textAlign: "center" }}>Field</div>
                <div style={{ flex: 2, textAlign: "right" }}>Update</div>
              </div>
              {changes.length === 0 ? (
                <div style={{ padding: "24px", textAlign: "center", color: "#637381", fontSize: "14px" }}>
                  <div style={{ fontSize: "24px", marginBottom: "8px" }}>⚠️</div>
                  <div style={{ fontWeight: 600 }}>No changes detected</div>
                  <div style={{ fontSize: "13px" }}>Go back and adjust your settings.</div>
                </div>
              ) : (
                changes.map((c, i) => (
                  <div key={i} style={{ display: "flex", alignItems: "center", padding: "10px 12px", borderBottom: "1px solid #f1f2f3", fontSize: "13px", backgroundColor: "white" }}>
                    <div style={{ flex: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      <span style={{ fontWeight: 600 }}>{c.productTitle}</span>
                      {c.variantTitle && c.variantTitle !== "Default Title" && (
                        <span style={{ color: "#637381" }}> — {c.variantTitle}</span>
                      )}
                    </div>
                    <div style={{ flex: 0.5, textAlign: "center" }}>
                      <span style={styles.badge("default")}>{getFieldDef(c.field)?.label || c.field}</span>
                    </div>
                    <div style={{ flex: 2, textAlign: "right" }}>
                      <span style={{ textDecoration: "line-through", color: "#8c9196" }}>{formatValue(c.field, c.oldValue)}</span>
                      <span style={{ color: "#8c9196", margin: "0 8px" }}>→</span>
                      <span style={{ fontWeight: 700, color: "#202223" }}>{formatValue(c.field, c.newValue)}</span>
                    </div>
                  </div>
                ))
              )}
            </div>
          </s-box>

          {/* Warning */}
          <s-box padding="base">
            <div style={{ padding: "14px 16px", backgroundColor: "#fef8e8", border: "1px solid #f5d680", borderRadius: "10px" }}>
              <div style={{ fontWeight: 700, color: "#916a00", marginBottom: "4px" }}>Before you execute</div>
              <div style={{ fontSize: "13px", color: "#4a3800" }}>
                This will update <strong>{changes.length}</strong> field{changes.length !== 1 ? "s" : ""} across <strong>{selected.length}</strong> product{selected.length !== 1 ? "s" : ""}. Changes take effect immediately. You can undo from the results page.
              </div>
            </div>
          </s-box>

          {/* Navigation */}
          <s-box padding="base">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <button style={styles.secondaryBtn} onClick={() => setStep(2)}>← Back to Configure</button>
              <button
                style={{ ...styles.primaryBtn(changes.length > 0 && !isExecuting), backgroundColor: changes.length > 0 && !isExecuting ? "#008060" : "#c4cdd5" }}
                onClick={handleExecute}
                disabled={changes.length === 0 || isExecuting}
              >
                {isExecuting ? "Executing..." : editsRemaining <= 0 && currentPlan === "free" ? "Limit Reached — Upgrade" : `Apply ${changes.length} Change${changes.length !== 1 ? "s" : ""}`}
              </button>
            </div>
          </s-box>

          {/* Confirm dialog */}
          {showConfirmDialog && (
            <div style={{ position: "fixed", top: 0, left: 0, right: 0, bottom: 0, backgroundColor: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 9999 }}>
              <div style={{ backgroundColor: "white", borderRadius: "16px", padding: "24px", maxWidth: "420px", width: "90%", boxShadow: "0 20px 60px rgba(0,0,0,0.3)" }}>
                <div style={{ fontSize: "18px", fontWeight: 700, marginBottom: "8px" }}>Confirm Bulk Update</div>
                <div style={{ fontSize: "14px", color: "#637381", marginBottom: "20px" }}>
                  You are about to update <strong>{changes.length}</strong> field{changes.length !== 1 ? "s" : ""} across <strong>{selected.length}</strong> product{selected.length !== 1 ? "s" : ""}. This takes effect immediately.
                </div>
                <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
                  <button style={styles.secondaryBtn} onClick={() => setShowConfirmDialog(false)}>Cancel</button>
                  <button style={{ ...styles.primaryBtn(true), backgroundColor: "#008060" }} onClick={confirmExecute}>Yes, Apply Changes</button>
                </div>
              </div>
            </div>
          )}
        </s-section>
      )}

      {/* ════════════════════ STEP 4: RESULTS ════════════════════ */}
      {step === 4 && executionResult && (
        <s-section>
          <s-box padding="base">
            <div style={{ textAlign: "center", padding: "20px 0" }}>
              <div style={{ fontSize: "48px", marginBottom: "8px" }}>{executionResult.errorCount === 0 ? "✅" : "⚠️"}</div>
              <s-text variant="headingLg" fontWeight="bold">
                {executionResult.errorCount === 0 ? "All Changes Applied Successfully" : "Changes Applied with Some Errors"}
              </s-text>
            </div>
          </s-box>

          <s-box padding="base">
            <div style={{ display: "flex", gap: "16px", flexWrap: "wrap", justifyContent: "center" }}>
              <div style={styles.summaryCard("#2c6ecb")}>
                <div style={{ fontSize: "32px", fontWeight: 700 }}>{executionResult.successCount}</div>
                <div style={{ fontSize: "13px", color: "#637381", marginTop: "4px" }}>Changes Applied</div>
              </div>
              {executionResult.errorCount > 0 && (
                <div style={styles.summaryCard("#d72c0d")}>
                  <div style={{ fontSize: "32px", fontWeight: 700, color: "#d72c0d" }}>{executionResult.errorCount}</div>
                  <div style={{ fontSize: "13px", color: "#637381", marginTop: "4px" }}>Errors</div>
                </div>
              )}
              <div style={styles.summaryCard("#2c6ecb")}>
                <div style={{ fontSize: "32px", fontWeight: 700 }}>{executionResult.totalProducts}</div>
                <div style={{ fontSize: "13px", color: "#637381", marginTop: "4px" }}>Products Processed</div>
              </div>
            </div>
          </s-box>

          {executionResult.errors?.length > 0 && (
            <s-box padding="base">
              <div style={{ ...styles.card, borderLeft: "3px solid #d72c0d" }}>
                <div style={{ fontWeight: 600, fontSize: "14px", color: "#d72c0d", marginBottom: "8px" }}>Errors</div>
                {executionResult.errors.map((err, i) => (
                  <div key={i} style={{ padding: "6px 0", borderBottom: i < executionResult.errors.length - 1 ? "1px solid #f1f2f3" : "none", fontSize: "13px" }}>
                    <strong>{err.product}</strong>: {err.errors.join(", ")}
                  </div>
                ))}
              </div>
            </s-box>
          )}

          <s-box padding="base">
            <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", justifyContent: "center" }}>
              {lastChanges && (
                <button style={styles.dangerBtn(true)} onClick={handleRevert} disabled={isExecuting}>
                  {isExecuting ? "Reverting..." : "↩ Undo All Changes"}
                </button>
              )}
              <button style={styles.primaryBtn(true)} onClick={() => {
                setExecutionResult(null); setLastChanges(null); setSelectedIds(new Set());
                setModifications([]); setActivePreset(null); setEditName(""); setStep(1);
              }}>Start New Bulk Edit</button>
              <button style={styles.secondaryBtn} onClick={() => navigate("/app/history")}>View History</button>
              <button style={styles.secondaryBtn} onClick={() => navigate("/app")}>Back to Dashboard</button>
            </div>
          </s-box>
        </s-section>
      )}
    </s-page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
