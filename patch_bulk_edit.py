#!/usr/bin/env python3
import sys

filepath = "app/routes/app.bulk-edit.jsx"
with open(filepath, "r") as f:
    content = f.read()

# ============================================================
# CHANGE 1: Replace the single products query with pagination
# ============================================================

old_loader_query = """  const response = await admin.graphql(
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
  const products = (data.data?.products?.edges || []).map((e) => e.node);"""

new_loader_query = """  // Paginate through ALL products
  let allProducts = [];
  let hasNextPage = true;
  let cursor = null;
  while (hasNextPage) {
    const response = await admin.graphql(
      `#graphql
      query ($first: Int!, $after: String) {
        products(first: $first, after: $after) {
          pageInfo {
            hasNextPage
            endCursor
          }
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
      { variables: { first: 250, after: cursor } }
    );
    const data = await response.json();
    const edges = data.data?.products?.edges || [];
    allProducts = allProducts.concat(edges.map((e) => e.node));
    hasNextPage = data.data?.products?.pageInfo?.hasNextPage || false;
    cursor = data.data?.products?.pageInfo?.endCursor || null;
  }
  const products = allProducts;"""

if old_loader_query in content:
    content = content.replace(old_loader_query, new_loader_query)
    print("OK Replaced product query with paginated version")
else:
    print("WARN Could not find the exact product query to replace")

# ============================================================
# CHANGE 2: Add "Variant Title" to FILTER_FIELDS
# ============================================================

old_filter = '  { value: "sku", label: "SKU", type: "text" },'
new_filter = '  { value: "sku", label: "SKU", type: "text" },\n  { value: "variantTitle", label: "Variant Title", type: "text" },'

if old_filter in content and '"variantTitle", label: "Variant Title"' not in content:
    content = content.replace(old_filter, new_filter, 1)
    print("OK Added Variant Title to FILTER_FIELDS")
elif '"variantTitle", label: "Variant Title"' in content:
    print("INFO Variant Title already in FILTER_FIELDS")
else:
    print("WARN Could not find FILTER_FIELDS SKU entry")

# ============================================================
# CHANGE 3: Add variantTitle case to evaluateFilter
# ============================================================

old_eval = '    case "sku":\n      value = product.variants?.edges?.[0]?.node?.sku || "";\n      break;\n    case "tags":'
new_eval = '    case "sku":\n      value = product.variants?.edges?.[0]?.node?.sku || "";\n      break;\n    case "variantTitle":\n      value = (product.variants?.edges || []).map(e => e.node?.title || "").join(", ");\n      break;\n    case "tags":'

if old_eval in content:
    content = content.replace(old_eval, new_eval, 1)
    print("OK Added variantTitle case to evaluateFilter")
else:
    print("WARN Could not find evaluateFilter SKU case")

with open(filepath, "w") as f:
    f.write(content)

print("\nDone! All changes applied to", filepath)
