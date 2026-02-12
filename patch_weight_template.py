#!/usr/bin/env python3
"""
Patch app/routes/app.bulk-edit.jsx to add:
1. Weight (variant-level numeric field)
2. Product Template (product-level text field, maps to templateSuffix)

Also updates:
- GraphQL query to fetch weight + weightUnit + templateSuffix
- Mutation logic to save weight + templateSuffix
- Variant mutation to include weight
"""

filepath = "app/routes/app.bulk-edit.jsx"
with open(filepath, "r") as f:
    content = f.read()

changes_made = 0

# ============================================================
# CHANGE 1: Add weight + templateSuffix to GraphQL query
# ============================================================

# Add templateSuffix to the product node fields (after tags)
old_tags_line = """            tags
            featuredMedia {"""
new_tags_line = """            tags
            templateSuffix
            featuredMedia {"""

if "templateSuffix" not in content.split("featuredMedia")[0]:
    content = content.replace(old_tags_line, new_tags_line, 1)
    print("OK Added templateSuffix to GraphQL product query")
    changes_made += 1
else:
    print("INFO templateSuffix already in query")

# Add weight + weightUnit to variant node fields (after inventoryQuantity)
old_variant_fields = """                  inventoryQuantity
                }"""
new_variant_fields = """                  inventoryQuantity
                  weight
                  weightUnit
                }"""

if "weight\n" not in content and "weight:" not in content.split("EDITABLE_FIELDS")[0]:
    # Only replace the first occurrence (inside the query)
    content = content.replace(old_variant_fields, new_variant_fields, 1)
    print("OK Added weight + weightUnit to GraphQL variant query")
    changes_made += 1
else:
    print("INFO weight already in variant query")

# ============================================================
# CHANGE 2: Add weight + template to EDITABLE_FIELDS
# ============================================================

# Add weight after barcode (variant-level numeric)
old_barcode = '  { value: "barcode", label: "Barcode", icon: "\U0001f4ca", category: "text", level: "variant", accessor: (v) => v.barcode || "" },'
new_barcode = '  { value: "barcode", label: "Barcode", icon: "\U0001f4ca", category: "text", level: "variant", accessor: (v) => v.barcode || "" },\n  { value: "weight", label: "Weight", icon: "\u2696\ufe0f", category: "numeric", level: "variant", accessor: (v) => v.weight || "0" },'

if '"weight", label: "Weight"' not in content:
    content = content.replace(old_barcode, new_barcode, 1)
    print("OK Added Weight to EDITABLE_FIELDS")
    changes_made += 1
else:
    print("INFO Weight already in EDITABLE_FIELDS")

# Add templateSuffix after status (product-level text)
old_status = '  { value: "status", label: "Status", icon: "\U0001f504", category: "select", level: "product", accessor: null, options: ["ACTIVE", "DRAFT", "ARCHIVED"] },'
new_status = '  { value: "status", label: "Status", icon: "\U0001f504", category: "select", level: "product", accessor: null, options: ["ACTIVE", "DRAFT", "ARCHIVED"] },\n  { value: "templateSuffix", label: "Product Template", icon: "\U0001f4c4", category: "text", level: "product", accessor: null },'

if '"templateSuffix", label: "Product Template"' not in content:
    content = content.replace(old_status, new_status, 1)
    print("OK Added Product Template to EDITABLE_FIELDS")
    changes_made += 1
else:
    print("INFO Product Template already in EDITABLE_FIELDS")

# ============================================================
# CHANGE 3: Add weight to variant mutation fields list
# ============================================================

old_variant_filter = 'const variantLevelChanges = productChanges.filter(c => ["price", "compareAtPrice", "sku", "barcode", "weight", "taxable"].includes(c.field));'
# weight is already in the filter list, good!

# But we need to add the weight mapping in the variantMap builder
old_barcode_map = '            else if (change.field === "barcode") v.barcode = change.newValue;'
new_barcode_map = '            else if (change.field === "barcode") v.barcode = change.newValue;\n            else if (change.field === "weight") v.weight = parseFloat(change.newValue);'

if 'change.field === "weight"' not in content:
    content = content.replace(old_barcode_map, new_barcode_map, 1)
    print("OK Added weight to variant mutation mapping")
    changes_made += 1
else:
    print("INFO weight already in variant mutation mapping")

# Add weight to the variant mutation return fields
old_variant_return = "productVariants { id price compareAtPrice sku barcode }"
new_variant_return = "productVariants { id price compareAtPrice sku barcode weight weightUnit }"

if "weight weightUnit" not in content:
    content = content.replace(old_variant_return, new_variant_return, 1)
    print("OK Added weight to variant mutation return fields")
    changes_made += 1
else:
    print("INFO weight already in variant mutation return fields")

# ============================================================
# CHANGE 4: Add templateSuffix to product mutation logic
# ============================================================

# Add templateSuffix to the product-level changes filter
old_product_filter = 'const productLevelChanges = productChanges.filter(c => ["title", "vendor", "productType", "status", "tags"].includes(c.field));'
new_product_filter = 'const productLevelChanges = productChanges.filter(c => ["title", "vendor", "productType", "status", "tags", "templateSuffix"].includes(c.field));'

if '"templateSuffix"' not in content.split("productLevelChanges")[0] + content.split("productLevelChanges")[1].split(";")[0]:
    content = content.replace(old_product_filter, new_product_filter, 1)
    print("OK Added templateSuffix to product-level changes filter")
    changes_made += 1
else:
    print("INFO templateSuffix already in product-level changes filter")

# Add templateSuffix mapping in the productInput builder
old_tags_input = '            else if (change.field === "tags") productInput.tags = change.newValue.split(",").map(t => t.trim()).filter(Boolean);'
new_tags_input = '            else if (change.field === "tags") productInput.tags = change.newValue.split(",").map(t => t.trim()).filter(Boolean);\n            else if (change.field === "templateSuffix") productInput.templateSuffix = change.newValue;'

if 'change.field === "templateSuffix"' not in content:
    content = content.replace(old_tags_input, new_tags_input, 1)
    print("OK Added templateSuffix to product mutation mapping")
    changes_made += 1
else:
    print("INFO templateSuffix already in product mutation mapping")

# Add templateSuffix to the product mutation return fields
old_product_return = "product { id title vendor productType status tags }"
new_product_return = "product { id title vendor productType status tags templateSuffix }"

if "templateSuffix }" not in content:
    content = content.replace(old_product_return, new_product_return, 1)
    print("OK Added templateSuffix to product mutation return fields")
    changes_made += 1
else:
    print("INFO templateSuffix already in product mutation return fields")

# ============================================================
# CHANGE 5: Add weight + templateSuffix to FILTER_FIELDS too
# ============================================================

old_inv_filter = '  { value: "inventoryQuantity", label: "Inventory", type: "number" },'
new_inv_filter = '  { value: "inventoryQuantity", label: "Inventory", type: "number" },\n  { value: "weight", label: "Weight", type: "number" },\n  { value: "templateSuffix", label: "Product Template", type: "text" },'

if '"weight", label: "Weight", type: "number"' not in content:
    content = content.replace(old_inv_filter, new_inv_filter, 1)
    print("OK Added weight + templateSuffix to FILTER_FIELDS")
    changes_made += 1
else:
    print("INFO weight already in FILTER_FIELDS")

# Add weight + templateSuffix cases to evaluateFilter
old_sku_eval = '    case "sku":\n      value = product.variants?.edges?.[0]?.node?.sku || "";\n      break;'
new_sku_eval = '    case "sku":\n      value = product.variants?.edges?.[0]?.node?.sku || "";\n      break;\n    case "weight":\n      value = String(product.variants?.edges?.[0]?.node?.weight ?? "0");\n      break;\n    case "templateSuffix":\n      value = product.templateSuffix || "";\n      break;'

if 'case "weight":' not in content:
    content = content.replace(old_sku_eval, new_sku_eval, 1)
    print("OK Added weight + templateSuffix to evaluateFilter")
    changes_made += 1
else:
    print("INFO weight already in evaluateFilter")

with open(filepath, "w") as f:
    f.write(content)

print(f"\nDone! {changes_made} changes applied to {filepath}")
