import { useState, useEffect } from "react";
import { useLoaderData, useFetcher, useNavigate } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const url = new URL(request.url);
  const page = parseInt(url.searchParams.get("page") || "1", 10);
  const search = url.searchParams.get("search") || "";
  const source = url.searchParams.get("source") || "";
  const pageSize = 50;

  const where = { shop };
  if (search) {
    where.productTitle = { contains: search };
  }
  if (source) {
    where.changeSource = source;
  }

  const [history, totalCount, bulkEdits] = await Promise.all([
    prisma.priceHistory.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.priceHistory.count({ where }),
    prisma.bulkEdit.findMany({
      where: { shop },
      orderBy: { createdAt: "desc" },
      take: 10,
    }),
  ]);

  const totalPages = Math.ceil(totalCount / pageSize);

  // Compute summary stats
  const allHistory = await prisma.priceHistory.findMany({
    where: { shop },
    select: { oldPrice: true, newPrice: true, changeSource: true },
  });

  let totalSaved = 0;
  let totalIncreased = 0;
  let decreaseCount = 0;
  let increaseCount = 0;
  for (const h of allHistory) {
    const diff = parseFloat(h.newPrice) - parseFloat(h.oldPrice);
    if (diff < 0) { totalSaved += Math.abs(diff); decreaseCount++; }
    if (diff > 0) { totalIncreased += diff; increaseCount++; }
  }

  return {
    history,
    totalCount,
    page,
    totalPages,
    search,
    source,
    bulkEdits,
    stats: {
      totalChanges: allHistory.length,
      decreaseCount,
      increaseCount,
      totalSaved: totalSaved.toFixed(2),
      totalIncreased: totalIncreased.toFixed(2),
    },
  };
};

export const action = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "clear_history") {
    await prisma.priceHistory.deleteMany({ where: { shop } });
    return { success: true, cleared: true };
  }

  if (intent === "revert_single") {
    const productId = formData.get("productId");
    const variantId = formData.get("variantId");
    const oldPrice = formData.get("oldPrice");

    try {
      const mutation = `#graphql
        mutation productVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
          productVariantsBulkUpdate(productId: $productId, variants: $variants) {
            productVariants { id price }
            userErrors { field message }
          }
        }`;

      const result = await admin.graphql(mutation, {
        variables: { productId, variants: [{ id: variantId, price: oldPrice }] },
      });
      const resultData = await result.json();
      const userErrors = resultData.data?.productVariantsBulkUpdate?.userErrors || [];

      if (userErrors.length > 0) {
        return { success: false, error: userErrors[0].message };
      }

      // Record the revert in history
      await prisma.priceHistory.create({
        data: {
          shop,
          productId,
          variantId,
          productTitle: formData.get("productTitle") || "Unknown",
          variantTitle: formData.get("variantTitle") || null,
          oldPrice: formData.get("currentPrice"),
          newPrice: oldPrice,
          changeType: "revert",
          changeSource: "manual_revert",
        },
      });

      return { success: true, reverted: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  return { error: "Unknown intent" };
};

export default function History() {
  const { history, totalCount, page, totalPages, search, source, bulkEdits, stats } = useLoaderData();
  const fetcher = useFetcher();
  const navigate = useNavigate();
  const shopify = useAppBridge();
  const [searchValue, setSearchValue] = useState(search);
  const [showClearConfirm, setShowClearConfirm] = useState(false);

  useEffect(() => {
    if (fetcher.data?.success && fetcher.data?.reverted) {
      shopify.toast.show("Price reverted to original value!");
    }
    if (fetcher.data?.success && fetcher.data?.cleared) {
      shopify.toast.show("History cleared!");
    }
    if (fetcher.data?.error) {
      shopify.toast.show("Error: " + fetcher.data.error);
    }
  }, [fetcher.data, shopify]);

  const handleSearch = () => {
    const params = new URLSearchParams();
    if (searchValue) params.set("search", searchValue);
    if (source) params.set("source", source);
    navigate(`/app/history?${params.toString()}`);
  };

  const handleSourceFilter = (newSource) => {
    const params = new URLSearchParams();
    if (searchValue) params.set("search", searchValue);
    if (newSource) params.set("source", newSource);
    navigate(`/app/history?${params.toString()}`);
  };

  const badgeStyle = (tone) => ({
    display: "inline-block",
    padding: "2px 8px",
    borderRadius: "10px",
    fontSize: "11px",
    fontWeight: "600",
    backgroundColor: tone === "success" ? "#e3f1df" : tone === "critical" ? "#fef3f2" : tone === "warning" ? "#fef8e8" : "#e4e5e7",
    color: tone === "success" ? "#1a7f37" : tone === "critical" ? "#d72c0d" : tone === "warning" ? "#916a00" : "#637381",
  });

  return (
    <s-page heading="Price History">
      {totalCount > 0 && (
        <s-button
          slot="secondary-action"
          tone="critical"
          onClick={() => setShowClearConfirm(true)}
        >
          Clear History
        </s-button>
      )}

      {/* Stats summary */}
      {stats.totalChanges > 0 && (
        <s-section>
          <div style={{ display: "flex", gap: "12px", flexWrap: "wrap" }}>
            <div style={{ flex: 1, minWidth: "120px", padding: "16px", border: "1px solid #e1e3e5", borderRadius: "10px", textAlign: "center", borderTop: "3px solid #2c6ecb" }}>
              <div style={{ fontSize: "24px", fontWeight: 700, color: "#202223" }}>{stats.totalChanges.toLocaleString()}</div>
              <div style={{ fontSize: "12px", color: "#637381" }}>Total Changes</div>
            </div>
            <div style={{ flex: 1, minWidth: "120px", padding: "16px", border: "1px solid #e1e3e5", borderRadius: "10px", textAlign: "center", borderTop: "3px solid #1a7f37" }}>
              <div style={{ fontSize: "24px", fontWeight: 700, color: "#1a7f37" }}>{stats.decreaseCount.toLocaleString()}</div>
              <div style={{ fontSize: "12px", color: "#637381" }}>Price Decreases</div>
            </div>
            <div style={{ flex: 1, minWidth: "120px", padding: "16px", border: "1px solid #e1e3e5", borderRadius: "10px", textAlign: "center", borderTop: "3px solid #d72c0d" }}>
              <div style={{ fontSize: "24px", fontWeight: 700, color: "#d72c0d" }}>{stats.increaseCount.toLocaleString()}</div>
              <div style={{ fontSize: "12px", color: "#637381" }}>Price Increases</div>
            </div>
            <div style={{ flex: 1, minWidth: "120px", padding: "16px", border: "1px solid #e1e3e5", borderRadius: "10px", textAlign: "center", borderTop: "3px solid #637381" }}>
              <div style={{ fontSize: "24px", fontWeight: 700, color: "#202223" }}>{bulkEdits.length}</div>
              <div style={{ fontSize: "12px", color: "#637381" }}>Bulk Edits</div>
            </div>
          </div>
        </s-section>
      )}

      {/* Search and filters */}
      <s-section>
        <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
          <div style={{ flex: 1, minWidth: "200px" }}>
            <input
              type="text"
              placeholder="Search by product name..."
              value={searchValue}
              onChange={(e) => setSearchValue(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSearch()}
              style={{ width: "100%", padding: "8px 12px", border: "1px solid #c4cdd5", borderRadius: "8px", fontSize: "14px", boxSizing: "border-box" }}
            />
          </div>
          <button onClick={handleSearch} style={{ padding: "8px 16px", borderRadius: "8px", border: "1px solid #c4cdd5", backgroundColor: "white", cursor: "pointer", fontSize: "14px" }}>Search</button>
          <select
            value={source}
            onChange={(e) => handleSourceFilter(e.target.value)}
            style={{ padding: "8px 12px", border: "1px solid #c4cdd5", borderRadius: "8px", fontSize: "14px", backgroundColor: "white", cursor: "pointer" }}
          >
            <option value="">All Sources</option>
            <option value="bulk_edit">Bulk Edit</option>
            <option value="manual_revert">Manual Revert</option>
            <option value="automation">Automation</option>
          </select>
          {(search || source) && (
            <button
              onClick={() => { setSearchValue(""); navigate("/app/history"); }}
              style={{ padding: "4px 10px", borderRadius: "16px", border: "1px solid #d72c0d", backgroundColor: "#fef3f2", color: "#d72c0d", fontSize: "12px", cursor: "pointer" }}
            >
              Clear filters ✕
            </button>
          )}
        </div>
      </s-section>

      {history.length === 0 ? (
        <s-section>
          <s-box padding="loose" borderWidth="base" borderRadius="base">
            <s-stack direction="block" gap="base" align="center">
              <div style={{ fontSize: "32px" }}>📋</div>
              <s-text tone="subdued">
                {search || source
                  ? "No price changes match your filters."
                  : "No price changes recorded yet. Use Bulk Edit to make changes and they will appear here."}
              </s-text>
              <s-button onClick={() => navigate("/app/bulk-edit")}>
                Go to Bulk Edit
              </s-button>
            </s-stack>
          </s-box>
        </s-section>
      ) : (
        <s-section padding="none">
          <s-table
            paginate={totalPages > 1}
            hasNextPage={page < totalPages}
            hasPreviousPage={page > 1}
          >
            <s-table-header-row>
              <s-table-header>Product</s-table-header>
              <s-table-header>Variant</s-table-header>
              <s-table-header format="currency">Old Price</s-table-header>
              <s-table-header format="currency">New Price</s-table-header>
              <s-table-header>Change</s-table-header>
              <s-table-header>Source</s-table-header>
              <s-table-header>Date</s-table-header>
              <s-table-header>Actions</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {history.map((entry) => {
                const oldPrice = parseFloat(entry.oldPrice);
                const newPrice = parseFloat(entry.newPrice);
                const diff = newPrice - oldPrice;
                const pctChange = oldPrice > 0 ? ((diff / oldPrice) * 100).toFixed(1) : "N/A";
                const isRevert = entry.changeSource === "manual_revert";
                return (
                  <s-table-row key={entry.id}>
                    <s-table-cell>
                      <s-text fontWeight="bold">{entry.productTitle}</s-text>
                    </s-table-cell>
                    <s-table-cell>
                      <s-text tone="subdued">{entry.variantTitle || "Default"}</s-text>
                    </s-table-cell>
                    <s-table-cell>${entry.oldPrice}</s-table-cell>
                    <s-table-cell>
                      <s-text fontWeight="bold">${entry.newPrice}</s-text>
                    </s-table-cell>
                    <s-table-cell>
                      <s-text
                        tone={diff < 0 ? "critical" : diff > 0 ? "success" : "subdued"}
                      >
                        {diff > 0 ? "+" : ""}
                        {diff.toFixed(2)} ({pctChange}%)
                      </s-text>
                    </s-table-cell>
                    <s-table-cell>
                      <span style={badgeStyle(isRevert ? "warning" : "default")}>
                        {entry.changeSource.replace(/_/g, " ")}
                      </span>
                    </s-table-cell>
                    <s-table-cell>
                      {new Date(entry.createdAt).toLocaleString()}
                    </s-table-cell>
                    <s-table-cell>
                      {!isRevert && (
                        <button
                          onClick={() => {
                            fetcher.submit(
                              {
                                intent: "revert_single",
                                productId: entry.productId,
                                variantId: entry.variantId,
                                oldPrice: entry.oldPrice,
                                currentPrice: entry.newPrice,
                                productTitle: entry.productTitle,
                                variantTitle: entry.variantTitle || "",
                              },
                              { method: "POST" }
                            );
                          }}
                          style={{
                            border: "none",
                            background: "none",
                            color: "#2c6ecb",
                            cursor: "pointer",
                            fontSize: "13px",
                            fontWeight: 600,
                            padding: "4px 8px",
                            borderRadius: "4px",
                          }}
                          title={`Revert to $${entry.oldPrice}`}
                        >
                          ↩ Undo
                        </button>
                      )}
                    </s-table-cell>
                  </s-table-row>
                );
              })}
            </s-table-body>
          </s-table>
        </s-section>
      )}

      {totalPages > 1 && (
        <s-section>
          <s-stack direction="inline" gap="base" align="center">
            <s-button
              variant="secondary"
              disabled={page <= 1}
              onClick={() => {
                const params = new URLSearchParams();
                params.set("page", String(page - 1));
                if (search) params.set("search", search);
                if (source) params.set("source", source);
                navigate(`/app/history?${params.toString()}`);
              }}
            >
              ← Previous
            </s-button>
            <s-text>
              Page {page} of {totalPages}
            </s-text>
            <s-button
              variant="secondary"
              disabled={page >= totalPages}
              onClick={() => {
                const params = new URLSearchParams();
                params.set("page", String(page + 1));
                if (search) params.set("search", search);
                if (source) params.set("source", source);
                navigate(`/app/history?${params.toString()}`);
              }}
            >
              Next →
            </s-button>
          </s-stack>
        </s-section>
      )}

      {/* Clear confirmation dialog */}
      {showClearConfirm && (
        <div style={{ position: "fixed", top: 0, left: 0, right: 0, bottom: 0, backgroundColor: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 9999 }}>
          <div style={{ backgroundColor: "white", borderRadius: "16px", padding: "24px", maxWidth: "400px", width: "90%", boxShadow: "0 20px 60px rgba(0,0,0,0.3)" }}>
            <div style={{ fontSize: "18px", fontWeight: 700, color: "#202223", marginBottom: "8px" }}>Clear All History?</div>
            <div style={{ fontSize: "14px", color: "#637381", marginBottom: "20px" }}>
              This will permanently delete all {totalCount.toLocaleString()} price change records. This action cannot be undone.
            </div>
            <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
              <button onClick={() => setShowClearConfirm(false)} style={{ padding: "8px 16px", borderRadius: "8px", border: "1px solid #c4cdd5", backgroundColor: "white", cursor: "pointer", fontSize: "14px" }}>Cancel</button>
              <button
                onClick={() => {
                  setShowClearConfirm(false);
                  fetcher.submit({ intent: "clear_history" }, { method: "POST" });
                }}
                style={{ padding: "8px 16px", borderRadius: "8px", border: "none", backgroundColor: "#d72c0d", color: "white", cursor: "pointer", fontSize: "14px", fontWeight: 600 }}
              >
                Delete All History
              </button>
            </div>
          </div>
        </div>
      )}
    </s-page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
