import { useState, useEffect, useRef, useCallback } from "react";
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

  // Get history grouped by bulkEditId
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
      take: 50,
    }),
  ]);

  const totalPages = Math.ceil(totalCount / pageSize);

  // Compute summary stats
  let stats = { totalChanges: 0, decreaseCount: 0, increaseCount: 0, totalSaved: "0.00", totalIncreased: "0.00" };
  try {
    const totalChanges = await prisma.priceHistory.count({ where: { shop } });
    const statsResult = await prisma.$queryRawUnsafe(
      `SELECT 
        COALESCE(SUM(CASE WHEN CAST("newPrice" AS DOUBLE PRECISION) < CAST("oldPrice" AS DOUBLE PRECISION) THEN 1 ELSE 0 END), 0) as decrease_count,
        COALESCE(SUM(CASE WHEN CAST("newPrice" AS DOUBLE PRECISION) > CAST("oldPrice" AS DOUBLE PRECISION) THEN 1 ELSE 0 END), 0) as increase_count,
        COALESCE(SUM(CASE WHEN CAST("newPrice" AS DOUBLE PRECISION) < CAST("oldPrice" AS DOUBLE PRECISION) THEN CAST("oldPrice" AS DOUBLE PRECISION) - CAST("newPrice" AS DOUBLE PRECISION) ELSE 0 END), 0) as total_saved,
        COALESCE(SUM(CASE WHEN CAST("newPrice" AS DOUBLE PRECISION) > CAST("oldPrice" AS DOUBLE PRECISION) THEN CAST("newPrice" AS DOUBLE PRECISION) - CAST("oldPrice" AS DOUBLE PRECISION) ELSE 0 END), 0) as total_increased
      FROM "PriceHistory" WHERE shop = $1
        AND "changeType" IN ('price', 'compareAtPrice', 'automation', 'automation_compare')
        AND "oldPrice" ~ '^[0-9]+(\\.[0-9]+)?$'
        AND "newPrice" ~ '^[0-9]+(\\.[0-9]+)?$'`,
      shop
    );
    if (statsResult && statsResult.length > 0) {
      const row = statsResult[0];
      stats = {
        totalChanges,
        decreaseCount: Number(row.decrease_count),
        increaseCount: Number(row.increase_count),
        totalSaved: Number(row.total_saved).toFixed(2),
        totalIncreased: Number(row.total_increased).toFixed(2),
      };
    }
  } catch (err) {
    console.error("Stats query failed, using fallback:", err.message);
    stats.totalChanges = totalCount;
  }

  return {
    history,
    totalCount,
    page,
    totalPages,
    search,
    source,
    bulkEdits,
    stats,
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

  if (intent === "revert_run") {
    const bulkEditId = formData.get("bulkEditId");
    if (!bulkEditId) return { success: false, error: "No bulk edit ID provided" };

    // Get all history records for this run
    const records = await prisma.priceHistory.findMany({
      where: { shop, bulkEditId, changeSource: { not: "manual_revert" } },
      orderBy: { createdAt: "desc" },
    });

    if (records.length === 0) return { success: false, error: "No changes found for this run" };

    let successCount = 0;
    let errorCount = 0;

    // Group by product for efficient mutation
    const byProduct = {};
    for (const rec of records) {
      if (!byProduct[rec.productId]) byProduct[rec.productId] = [];
      byProduct[rec.productId].push(rec);
    }

    for (const [productId, recs] of Object.entries(byProduct)) {
      try {
        const variants = recs
          .filter(r => r.variantId && r.variantId !== productId)
          .map(r => ({ id: r.variantId, price: r.oldPrice }));

        if (variants.length > 0) {
          const mutation = `#graphql
            mutation productVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
              productVariantsBulkUpdate(productId: $productId, variants: $variants) {
                productVariants { id price }
                userErrors { field message }
              }
            }`;

          const result = await admin.graphql(mutation, {
            variables: { productId, variants },
          });
          const resultData = await result.json();
          const userErrors = resultData.data?.productVariantsBulkUpdate?.userErrors || [];

          if (userErrors.length > 0) {
            errorCount += variants.length;
          } else {
            successCount += variants.length;
            // Record reverts in history
            for (const rec of recs.filter(r => r.variantId && r.variantId !== productId)) {
              await prisma.priceHistory.create({
                data: {
                  shop,
                  productId: rec.productId,
                  variantId: rec.variantId,
                  productTitle: rec.productTitle,
                  variantTitle: rec.variantTitle,
                  oldPrice: rec.newPrice,
                  newPrice: rec.oldPrice,
                  changeType: "revert",
                  changeSource: "manual_revert",
                  bulkEditName: `Undo: ${rec.bulkEditName || "Bulk Edit"}`,
                },
              });
            }
          }
        }
      } catch (err) {
        errorCount += recs.length;
        console.error(`[History] Revert error for product ${productId}:`, err.message);
      }
    }

    return { success: true, reverted: true, successCount, errorCount };
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
  const [expandedRuns, setExpandedRuns] = useState(new Set());
  const [revertingRun, setRevertingRun] = useState(null);

  // Group history entries by bulkEditId (or by date if no bulkEditId)
  const groupedHistory = (() => {
    const groups = [];
    const byEditId = {};
    const ungrouped = [];

    for (const entry of history) {
      if (entry.bulkEditId) {
        if (!byEditId[entry.bulkEditId]) {
          byEditId[entry.bulkEditId] = {
            id: entry.bulkEditId,
            name: entry.bulkEditName || "Bulk Edit",
            source: entry.changeSource,
            entries: [],
            createdAt: entry.createdAt,
          };
        }
        byEditId[entry.bulkEditId].entries.push(entry);
      } else {
        ungrouped.push(entry);
      }
    }

    // Add grouped runs
    for (const group of Object.values(byEditId)) {
      groups.push(group);
    }

    // Add ungrouped entries as individual "runs"
    for (const entry of ungrouped) {
      groups.push({
        id: entry.id,
        name: entry.bulkEditName || "Single Edit",
        source: entry.changeSource,
        entries: [entry],
        createdAt: entry.createdAt,
      });
    }

    // Sort by most recent first
    groups.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    return groups;
  })();

  const formatPrice = (priceStr) => {
    const num = parseFloat(priceStr);
    if (isNaN(num)) return priceStr;
    if (Math.abs(num) >= 1e6) return `$${(num / 1e6).toFixed(1)}M`;
    if (Math.abs(num) >= 1e4) return `$${num.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    return `$${priceStr}`;
  };

  const formatDiff = (diff) => {
    const abs = Math.abs(diff);
    const sign = diff > 0 ? "+" : diff < 0 ? "-" : "";
    if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(1)}M`;
    return `${diff > 0 ? "+" : ""}${diff.toFixed(2)}`;
  };

  const toggleExpand = (runId) => {
    setExpandedRuns(prev => {
      const next = new Set(prev);
      next.has(runId) ? next.delete(runId) : next.add(runId);
      return next;
    });
  };

  useEffect(() => {
    if (fetcher.data?.success && fetcher.data?.reverted) {
      shopify.toast.show(`Reverted ${fetcher.data.successCount} changes!`);
      setRevertingRun(null);
    }
    if (fetcher.data?.success && fetcher.data?.cleared) {
      shopify.toast.show("History cleared!");
    }
    if (fetcher.data?.error) {
      shopify.toast.show("Error: " + fetcher.data.error);
      setRevertingRun(null);
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

  const handleRevertRun = (bulkEditId) => {
    setRevertingRun(bulkEditId);
    fetcher.submit({ intent: "revert_run", bulkEditId }, { method: "POST" });
  };

  const handleCloneRun = (bulkEditId) => {
    // Navigate to bulk edit with clone parameter
    navigate(`/app/bulk-edit?clone=${bulkEditId}`);
  };

  const handleNextPage = useCallback(() => {
    if (page >= totalPages) return;
    const params = new URLSearchParams();
    params.set("page", String(page + 1));
    if (search) params.set("search", search);
    if (source) params.set("source", source);
    navigate(`/app/history?${params.toString()}`);
  }, [page, totalPages, search, source, navigate]);

  const handlePrevPage = useCallback(() => {
    if (page <= 1) return;
    const params = new URLSearchParams();
    params.set("page", String(page - 1));
    if (search) params.set("search", search);
    if (source) params.set("source", source);
    navigate(`/app/history?${params.toString()}`);
  }, [page, search, source, navigate]);

  const badgeStyle = (tone) => ({
    display: "inline-block",
    padding: "2px 8px",
    borderRadius: "10px",
    fontSize: "11px",
    fontWeight: "600",
    backgroundColor: tone === "success" ? "#e3f1df" : tone === "critical" ? "#fef3f2" : tone === "warning" ? "#fef8e8" : "#e4e5e7",
    color: tone === "success" ? "#1a7f37" : tone === "critical" ? "#d72c0d" : tone === "warning" ? "#916a00" : "#637381",
  });

  const isReverting = fetcher.state !== "idle";

  return (
    <s-page heading="Edit History">
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
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(100px, 1fr))", gap: "8px" }}>
            <div style={{ padding: "12px", border: "1px solid #e1e3e5", borderRadius: "10px", textAlign: "center", borderTop: "3px solid #2c6ecb" }}>
              <div style={{ fontSize: "20px", fontWeight: 700, color: "#202223" }}>{stats.totalChanges.toLocaleString()}</div>
              <div style={{ fontSize: "11px", color: "#637381" }}>Total Changes</div>
            </div>
            <div style={{ padding: "12px", border: "1px solid #e1e3e5", borderRadius: "10px", textAlign: "center", borderTop: "3px solid #1a7f37" }}>
              <div style={{ fontSize: "20px", fontWeight: 700, color: "#1a7f37" }}>{stats.decreaseCount.toLocaleString()}</div>
              <div style={{ fontSize: "11px", color: "#637381" }}>Decreases</div>
            </div>
            <div style={{ padding: "12px", border: "1px solid #e1e3e5", borderRadius: "10px", textAlign: "center", borderTop: "3px solid #d72c0d" }}>
              <div style={{ fontSize: "20px", fontWeight: 700, color: "#d72c0d" }}>{stats.increaseCount.toLocaleString()}</div>
              <div style={{ fontSize: "11px", color: "#637381" }}>Increases</div>
            </div>
            <div style={{ padding: "12px", border: "1px solid #e1e3e5", borderRadius: "10px", textAlign: "center", borderTop: "3px solid #637381" }}>
              <div style={{ fontSize: "20px", fontWeight: 700, color: "#202223" }}>{bulkEdits.length}</div>
              <div style={{ fontSize: "11px", color: "#637381" }}>Bulk Edits</div>
            </div>
          </div>
        </s-section>
      )}

      {/* Search and filters */}
      <s-section>
        <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
          <div style={{ flex: 1, minWidth: "150px" }}>
            <input
              type="text"
              placeholder="Search by product name..."
              value={searchValue}
              onChange={(e) => setSearchValue(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSearch()}
              style={{ width: "100%", padding: "8px 12px", border: "1px solid #c4cdd5", borderRadius: "8px", fontSize: "14px", boxSizing: "border-box" }}
            />
          </div>
          <button onClick={handleSearch} style={{ padding: "8px 12px", borderRadius: "8px", border: "1px solid #c4cdd5", backgroundColor: "white", cursor: "pointer", fontSize: "14px" }}>Search</button>
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
              Clear ✕
            </button>
          )}
        </div>
      </s-section>

      {/* Grouped edit runs */}
      {groupedHistory.length === 0 ? (
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
        <s-section>
          <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
            {groupedHistory.map((run) => {
              const isExpanded = expandedRuns.has(run.id);
              const changeCount = run.entries.length;
              const isRevert = run.source === "manual_revert";
              const uniqueProducts = [...new Set(run.entries.map(e => e.productTitle))];
              const netChange = run.entries.reduce((sum, e) => {
                return sum + (parseFloat(e.newPrice) - parseFloat(e.oldPrice));
              }, 0);

              return (
                <div key={run.id} style={{ border: "1px solid #e1e3e5", borderRadius: "12px", overflow: "hidden", backgroundColor: "white" }}>
                  {/* Run header - always visible */}
                  <div
                    style={{ padding: "12px 16px", cursor: "pointer", backgroundColor: isExpanded ? "#f9fafb" : "white", transition: "background-color 0.15s" }}
                    onClick={() => toggleExpand(run.id)}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
                      <span style={{ fontSize: "14px", transform: isExpanded ? "rotate(90deg)" : "rotate(0deg)", transition: "transform 0.15s", flexShrink: 0 }}>▶</span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                          <span style={{ fontWeight: 700, fontSize: "14px", color: "#202223" }}>{run.name}</span>
                          <span style={badgeStyle(isRevert ? "warning" : "success")}>
                            {changeCount} change{changeCount !== 1 ? "s" : ""}
                          </span>
                          <span style={badgeStyle(isRevert ? "warning" : "default")}>
                            {run.source.replace(/_/g, " ")}
                          </span>
                        </div>
                        <div style={{ fontSize: "12px", color: "#637381", marginTop: "2px" }}>
                          {uniqueProducts.length} product{uniqueProducts.length !== 1 ? "s" : ""} • {new Date(run.createdAt).toLocaleString()}
                          {netChange !== 0 && (
                            <span style={{ marginLeft: "8px", color: netChange < 0 ? "#d72c0d" : "#1a7f37", fontWeight: 600 }}>
                              Net: {netChange > 0 ? "+" : ""}{formatDiff(netChange)}
                            </span>
                          )}
                        </div>
                      </div>
                      {/* Action buttons */}
                      <div style={{ display: "flex", gap: "6px", flexShrink: 0 }} onClick={(e) => e.stopPropagation()}>
                        {!isRevert && run.entries.length > 0 && run.entries[0].bulkEditId && (
                          <>
                            <button
                              onClick={() => handleCloneRun(run.entries[0].bulkEditId)}
                              style={{ padding: "4px 10px", borderRadius: "6px", border: "1px solid #c4cdd5", backgroundColor: "white", cursor: "pointer", fontSize: "12px", fontWeight: 600, color: "#2c6ecb" }}
                              title="Clone this edit and run it again"
                            >
                              Clone
                            </button>
                            <button
                              onClick={() => handleRevertRun(run.entries[0].bulkEditId)}
                              disabled={isReverting}
                              style={{ padding: "4px 10px", borderRadius: "6px", border: "1px solid #d72c0d", backgroundColor: revertingRun === run.entries[0].bulkEditId ? "#fef3f2" : "white", cursor: isReverting ? "default" : "pointer", fontSize: "12px", fontWeight: 600, color: "#d72c0d", opacity: isReverting ? 0.6 : 1 }}
                              title="Undo all changes in this run"
                            >
                              {revertingRun === run.entries[0].bulkEditId ? "Undoing..." : "Undo Run"}
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Expanded detail */}
                  {isExpanded && (
                    <div style={{ borderTop: "1px solid #e1e3e5" }}>
                      <div style={{ overflowX: "auto" }}>
                        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}>
                          <thead>
                            <tr style={{ backgroundColor: "#f6f6f7" }}>
                              <th style={{ padding: "8px 12px", textAlign: "left", fontWeight: 600, color: "#637381", fontSize: "11px", textTransform: "uppercase" }}>Product</th>
                              <th style={{ padding: "8px 12px", textAlign: "left", fontWeight: 600, color: "#637381", fontSize: "11px", textTransform: "uppercase" }}>Variant</th>
                              <th style={{ padding: "8px 12px", textAlign: "right", fontWeight: 600, color: "#637381", fontSize: "11px", textTransform: "uppercase" }}>Old</th>
                              <th style={{ padding: "8px 12px", textAlign: "right", fontWeight: 600, color: "#637381", fontSize: "11px", textTransform: "uppercase" }}>New</th>
                              <th style={{ padding: "8px 12px", textAlign: "right", fontWeight: 600, color: "#637381", fontSize: "11px", textTransform: "uppercase" }}>Change</th>
                            </tr>
                          </thead>
                          <tbody>
                            {run.entries.map((entry) => {
                              const oldPrice = parseFloat(entry.oldPrice);
                              const newPrice = parseFloat(entry.newPrice);
                              const diff = newPrice - oldPrice;
                              const pctChange = oldPrice > 0 ? ((diff / oldPrice) * 100).toFixed(1) : "N/A";
                              return (
                                <tr key={entry.id} style={{ borderBottom: "1px solid #f1f2f3" }}>
                                  <td style={{ padding: "8px 12px", fontWeight: 600, maxWidth: "150px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={entry.productTitle}>
                                    {entry.productTitle}
                                  </td>
                                  <td style={{ padding: "8px 12px", color: "#637381" }}>
                                    {entry.variantTitle || "Default"}
                                  </td>
                                  <td style={{ padding: "8px 12px", textAlign: "right" }}>{formatPrice(entry.oldPrice)}</td>
                                  <td style={{ padding: "8px 12px", textAlign: "right", fontWeight: 600 }}>{formatPrice(entry.newPrice)}</td>
                                  <td style={{ padding: "8px 12px", textAlign: "right", color: diff < 0 ? "#d72c0d" : diff > 0 ? "#1a7f37" : "#637381", fontWeight: 600 }}>
                                    {formatDiff(diff)} ({pctChange}%)
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </s-section>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <s-section>
          <div style={{ display: "flex", justifyContent: "center", alignItems: "center", gap: "12px", flexWrap: "wrap" }}>
            <button
              onClick={handlePrevPage}
              disabled={page <= 1}
              style={{ padding: "8px 16px", borderRadius: "8px", border: "1px solid #c4cdd5", backgroundColor: "white", cursor: page <= 1 ? "default" : "pointer", fontSize: "14px", opacity: page <= 1 ? 0.5 : 1 }}
            >
              ← Previous
            </button>
            <span style={{ fontSize: "14px", color: "#637381" }}>
              Page {page} of {totalPages}
            </span>
            <button
              onClick={handleNextPage}
              disabled={page >= totalPages}
              style={{ padding: "8px 16px", borderRadius: "8px", border: "1px solid #c4cdd5", backgroundColor: "white", cursor: page >= totalPages ? "default" : "pointer", fontSize: "14px", opacity: page >= totalPages ? 0.5 : 1 }}
            >
              Next →
            </button>
          </div>
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
