import { useState, useCallback } from "react";
import { useLoaderData, useFetcher, useNavigate } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const url = new URL(request.url);
  const cursor = url.searchParams.get("cursor") || null;
  const direction = url.searchParams.get("direction") || "next";
  const search = url.searchParams.get("search") || "";

  let queryFilter = "";
  if (search) {
    queryFilter = `query: "title:*${search}*"`;
  }

  let query;
  if (direction === "prev" && cursor) {
    query = `#graphql
      query ($last: Int!, $before: String) {
        products(last: $last, before: $before${queryFilter ? ", " + queryFilter : ""}) {
          edges {
            node {
              id
              title
              handle
              status
              productType
              vendor
              totalInventory
              tags
              featuredMedia {
                preview {
                  image {
                    url
                    altText
                  }
                }
              }
              variants(first: 10) {
                edges {
                  node {
                    id
                    title
                    price
                    compareAtPrice
                    sku
                    inventoryQuantity
                  }
                }
              }
            }
          }
          pageInfo {
            hasNextPage
            hasPreviousPage
            startCursor
            endCursor
          }
        }
      }`;
  } else {
    query = `#graphql
      query ($first: Int!, $after: String) {
        products(first: $first, after: $after${queryFilter ? ", " + queryFilter : ""}) {
          edges {
            node {
              id
              title
              handle
              status
              productType
              vendor
              totalInventory
              tags
              featuredMedia {
                preview {
                  image {
                    url
                    altText
                  }
                }
              }
              variants(first: 10) {
                edges {
                  node {
                    id
                    title
                    price
                    compareAtPrice
                    sku
                    inventoryQuantity
                  }
                }
              }
            }
          }
          pageInfo {
            hasNextPage
            hasPreviousPage
            startCursor
            endCursor
          }
        }
      }`;
  }

  const variables =
    direction === "prev" && cursor
      ? { last: 25, before: cursor }
      : { first: 25, after: cursor };

  const response = await admin.graphql(query, { variables });
  const data = await response.json();
  const products = data.data.products;

  return {
    products: products.edges.map((e) => e.node),
    pageInfo: products.pageInfo,
    search,
  };
};

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "update_price") {
    const productId = formData.get("productId");
    const variantId = formData.get("variantId");
    const newPrice = formData.get("newPrice");

    const mutation = `#graphql
      mutation productVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
        productVariantsBulkUpdate(productId: $productId, variants: $variants) {
          productVariants { id price }
          userErrors { field message }
        }
      }`;

    const result = await admin.graphql(mutation, {
      variables: { productId, variants: [{ id: variantId, price: newPrice }] },
    });
    const resultData = await result.json();
    const userErrors = resultData.data?.productVariantsBulkUpdate?.userErrors || [];

    if (userErrors.length > 0) {
      return { success: false, error: userErrors[0].message };
    }
    return { success: true };
  }

  return { success: false };
};

export default function Products() {
  const { products, pageInfo, search: initialSearch } = useLoaderData();
  const navigate = useNavigate();
  const shopify = useAppBridge();
  const fetcher = useFetcher();
  const [searchValue, setSearchValue] = useState(initialSearch);
  const [editingVariant, setEditingVariant] = useState(null);
  const [editPrice, setEditPrice] = useState("");
  const [expandedProduct, setExpandedProduct] = useState(null);

  const handleSearch = useCallback(() => {
    const params = new URLSearchParams();
    if (searchValue) params.set("search", searchValue);
    navigate(`/app/products?${params.toString()}`);
  }, [searchValue, navigate]);

  const handleNextPage = useCallback(() => {
    const params = new URLSearchParams();
    params.set("cursor", pageInfo.endCursor);
    params.set("direction", "next");
    if (searchValue) params.set("search", searchValue);
    navigate(`/app/products?${params.toString()}`);
  }, [pageInfo, searchValue, navigate]);

  const handlePrevPage = useCallback(() => {
    const params = new URLSearchParams();
    params.set("cursor", pageInfo.startCursor);
    params.set("direction", "prev");
    if (searchValue) params.set("search", searchValue);
    navigate(`/app/products?${params.toString()}`);
  }, [pageInfo, searchValue, navigate]);

  const startEditing = (productId, variantId, currentPrice) => {
    setEditingVariant(`${productId}:${variantId}`);
    setEditPrice(currentPrice);
  };

  const savePrice = (productId, variantId) => {
    fetcher.submit(
      { intent: "update_price", productId, variantId, newPrice: editPrice },
      { method: "POST" }
    );
    setEditingVariant(null);
    shopify.toast.show("Price updated!");
  };

  const cancelEditing = () => {
    setEditingVariant(null);
    setEditPrice("");
  };

  return (
    <s-page heading="Products">
      <s-button slot="primary-action" onClick={() => navigate("/app/bulk-edit")}>
        Bulk Edit Prices
      </s-button>

      <s-section>
        <s-stack direction="inline" gap="base">
          <div style={{ flex: 1 }}>
            <s-search-field
              placeholder="Search products by title..."
              value={searchValue}
              onInput={(e) => setSearchValue(e.target.value)}
              onClear={() => {
                setSearchValue("");
                navigate("/app/products");
              }}
            />
          </div>
          <s-button onClick={handleSearch}>Search</s-button>
        </s-stack>
      </s-section>

      <s-section>
        <s-text tone="subdued" variant="bodySm">
          Click any price to edit it inline. For bulk changes, use the Bulk Edit button above.
        </s-text>
      </s-section>

      <s-section padding="none">
        <s-table
          paginate
          hasNextPage={pageInfo.hasNextPage}
          hasPreviousPage={pageInfo.hasPreviousPage}
        >
          <s-table-header-row>
            <s-table-header>Product</s-table-header>
            <s-table-header>Status</s-table-header>
            <s-table-header>Vendor</s-table-header>
            <s-table-header format="currency">Price</s-table-header>
            <s-table-header format="currency">Compare-at</s-table-header>
            <s-table-header format="numeric">Inventory</s-table-header>
          </s-table-header-row>
          <s-table-body>
            {products.map((product) => {
              const variants = product.variants.edges;
              const firstVariant = variants[0]?.node;
              const imageUrl = product.featuredMedia?.preview?.image?.url;
              const hasMultipleVariants = variants.length > 1;
              const isExpanded = expandedProduct === product.id;

              return [
                <s-table-row key={product.id} onClick={() => hasMultipleVariants && setExpandedProduct(isExpanded ? null : product.id)}>
                  <s-table-cell>
                    <s-stack direction="inline" gap="tight" align="center">
                      {imageUrl && (
                        <s-thumbnail src={imageUrl} alt={product.title} size="small" />
                      )}
                      <s-stack direction="block" gap="none">
                        <s-text fontWeight="bold">{product.title}</s-text>
                        <s-text tone="subdued" variant="bodySm">
                          {firstVariant?.sku ? `SKU: ${firstVariant.sku}` : ""}
                          {hasMultipleVariants ? ` · ${variants.length} variants` : ""}
                          {hasMultipleVariants && !isExpanded ? " (click to expand)" : ""}
                        </s-text>
                      </s-stack>
                    </s-stack>
                  </s-table-cell>
                  <s-table-cell>
                    <s-badge tone={product.status === "ACTIVE" ? "success" : "info"}>
                      {product.status.toLowerCase()}
                    </s-badge>
                  </s-table-cell>
                  <s-table-cell>{product.vendor || "—"}</s-table-cell>
                  <s-table-cell>
                    {!hasMultipleVariants ? (
                      editingVariant === `${product.id}:${firstVariant?.id}` ? (
                        <div style={{ display: "flex", gap: "4px", alignItems: "center" }}>
                          <input
                            type="number"
                            value={editPrice}
                            onChange={(e) => setEditPrice(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") savePrice(product.id, firstVariant.id);
                              if (e.key === "Escape") cancelEditing();
                            }}
                            style={{ width: "80px", padding: "4px 6px", border: "2px solid #2c6ecb", borderRadius: "6px", fontSize: "14px" }}
                            autoFocus
                          />
                          <button onClick={() => savePrice(product.id, firstVariant.id)} style={{ border: "none", background: "#008060", color: "white", borderRadius: "4px", padding: "4px 8px", cursor: "pointer", fontSize: "12px" }}>✓</button>
                          <button onClick={cancelEditing} style={{ border: "none", background: "#e1e3e5", borderRadius: "4px", padding: "4px 8px", cursor: "pointer", fontSize: "12px" }}>✕</button>
                        </div>
                      ) : (
                        <span
                          onClick={(e) => { e.stopPropagation(); startEditing(product.id, firstVariant.id, firstVariant.price); }}
                          style={{ cursor: "pointer", padding: "2px 6px", borderRadius: "4px", border: "1px dashed transparent", transition: "all 0.15s" }}
                          onMouseEnter={(e) => e.target.style.borderColor = "#2c6ecb"}
                          onMouseLeave={(e) => e.target.style.borderColor = "transparent"}
                          title="Click to edit price"
                        >
                          ${firstVariant?.price}
                        </span>
                      )
                    ) : (
                      <s-text tone="subdued">${firstVariant?.price} – ${variants[variants.length - 1]?.node.price}</s-text>
                    )}
                  </s-table-cell>
                  <s-table-cell>
                    {firstVariant?.compareAtPrice ? `$${firstVariant.compareAtPrice}` : "—"}
                  </s-table-cell>
                  <s-table-cell>{product.totalInventory ?? "—"}</s-table-cell>
                </s-table-row>,
                // Expanded variant rows
                ...(isExpanded ? variants.map((edge) => {
                  const v = edge.node;
                  const editKey = `${product.id}:${v.id}`;
                  return (
                    <s-table-row key={v.id}>
                      <s-table-cell>
                        <s-stack direction="inline" gap="tight" align="center">
                          <div style={{ width: "32px" }}></div>
                          <s-text tone="subdued">↳ {v.title}</s-text>
                          {v.sku && <s-text tone="subdued" variant="bodySm">({v.sku})</s-text>}
                        </s-stack>
                      </s-table-cell>
                      <s-table-cell></s-table-cell>
                      <s-table-cell></s-table-cell>
                      <s-table-cell>
                        {editingVariant === editKey ? (
                          <div style={{ display: "flex", gap: "4px", alignItems: "center" }}>
                            <input
                              type="number"
                              value={editPrice}
                              onChange={(e) => setEditPrice(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") savePrice(product.id, v.id);
                                if (e.key === "Escape") cancelEditing();
                              }}
                              style={{ width: "80px", padding: "4px 6px", border: "2px solid #2c6ecb", borderRadius: "6px", fontSize: "14px" }}
                              autoFocus
                            />
                            <button onClick={() => savePrice(product.id, v.id)} style={{ border: "none", background: "#008060", color: "white", borderRadius: "4px", padding: "4px 8px", cursor: "pointer", fontSize: "12px" }}>✓</button>
                            <button onClick={cancelEditing} style={{ border: "none", background: "#e1e3e5", borderRadius: "4px", padding: "4px 8px", cursor: "pointer", fontSize: "12px" }}>✕</button>
                          </div>
                        ) : (
                          <span
                            onClick={(e) => { e.stopPropagation(); startEditing(product.id, v.id, v.price); }}
                            style={{ cursor: "pointer", padding: "2px 6px", borderRadius: "4px", border: "1px dashed transparent", transition: "all 0.15s" }}
                            onMouseEnter={(e) => e.target.style.borderColor = "#2c6ecb"}
                            onMouseLeave={(e) => e.target.style.borderColor = "transparent"}
                            title="Click to edit price"
                          >
                            ${v.price}
                          </span>
                        )}
                      </s-table-cell>
                      <s-table-cell>
                        {v.compareAtPrice ? `$${v.compareAtPrice}` : "—"}
                      </s-table-cell>
                      <s-table-cell>{v.inventoryQuantity ?? "—"}</s-table-cell>
                    </s-table-row>
                  );
                }) : [])
              ];
            }).flat()}
          </s-table-body>
        </s-table>
      </s-section>

      {products.length === 0 && (
        <s-section>
          <s-box padding="loose">
            <s-text tone="subdued">No products found. Try a different search.</s-text>
          </s-box>
        </s-section>
      )}
    </s-page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
