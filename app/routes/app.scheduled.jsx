import { useState, useEffect, useCallback } from "react";
import { useLoaderData, useFetcher, useNavigate } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  let shopPlan = await prisma.shopPlan.findUnique({ where: { shop } });
  if (!shopPlan) {
    shopPlan = await prisma.shopPlan.create({ data: { shop } });
  }

  const scheduledEdits = await prisma.scheduledEdit.findMany({
    where: { shop },
    orderBy: { scheduledFor: "asc" },
  });

  return { scheduledEdits, currentPlan: shopPlan.plan || "free" };
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  // Check plan
  const shopPlan = await prisma.shopPlan.findUnique({ where: { shop } });
  if (!shopPlan || shopPlan.plan !== "plus") {
    return { error: "Scheduled edits require the Plus plan." };
  }

  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "create_scheduled") {
    const name = formData.get("name");
    const scheduledFor = formData.get("scheduledFor");
    const changes = formData.get("changes") || "[]";
    const productCount = parseInt(formData.get("productCount") || "0", 10);

    await prisma.scheduledEdit.create({
      data: {
        shop,
        name,
        scheduledFor: new Date(scheduledFor),
        changes,
        productCount,
      },
    });

    return { success: true };
  }

  if (intent === "cancel_scheduled") {
    const editId = formData.get("editId");
    const edit = await prisma.scheduledEdit.findUnique({ where: { id: editId } });
    if (edit && edit.shop === shop) {
      await prisma.scheduledEdit.update({
        where: { id: editId },
        data: { status: "cancelled" },
      });
    }
    return { success: true };
  }

  if (intent === "delete_scheduled") {
    const editId = formData.get("editId");
    const edit = await prisma.scheduledEdit.findUnique({ where: { id: editId } });
    if (edit && edit.shop === shop) {
      await prisma.scheduledEdit.delete({ where: { id: editId } });
    }
    return { success: true };
  }

  return { error: "Unknown intent" };
};

export default function Scheduled() {
  const { scheduledEdits, currentPlan } = useLoaderData();
  const fetcher = useFetcher();
  const shopify = useAppBridge();
  const navigate = useNavigate();

  const [showCreate, setShowCreate] = useState(false);
  const [editName, setEditName] = useState("");
  const [scheduledDate, setScheduledDate] = useState("");

  const isLocked = currentPlan !== "plus";

  useEffect(() => {
    if (fetcher.data?.success) {
      shopify.toast.show("Scheduled edit updated!");
      setShowCreate(false);
      setEditName("");
      setScheduledDate("");
    }
    if (fetcher.data?.error) {
      shopify.toast.show(fetcher.data.error, { isError: true });
    }
  }, [fetcher.data, shopify]);

  // Plan gate: show upgrade prompt for non-Plus users
  if (isLocked) {
    return (
      <s-page heading="Scheduled Edits">
        <s-section>
          <div style={{
            textAlign: "center",
            padding: "60px 24px",
            borderRadius: "16px",
            border: "1px solid #e1e3e5",
            backgroundColor: "#fafbfb",
          }}>
            <div style={{ fontSize: "48px", marginBottom: "16px" }}>📅</div>
            <div style={{ fontSize: "22px", fontWeight: 800, color: "#202223", marginBottom: "8px" }}>
              Scheduled Price Changes
            </div>
            <div style={{ fontSize: "15px", color: "#637381", marginBottom: "8px", maxWidth: "500px", margin: "0 auto 8px" }}>
              Schedule price changes to happen at a specific date and time. Perfect for sales events, seasonal pricing, or timed promotions.
            </div>
            <div style={{ fontSize: "14px", color: "#637381", marginBottom: "24px" }}>
              Available on the <strong>Plus plan</strong> ($19.99/month).
            </div>
            <div style={{ display: "flex", gap: "12px", justifyContent: "center", flexWrap: "wrap" }}>
              <button
                onClick={() => navigate("/app/billing")}
                style={{
                  padding: "12px 32px",
                  borderRadius: "8px",
                  border: "none",
                  backgroundColor: "#7c3aed",
                  color: "white",
                  fontWeight: 700,
                  fontSize: "14px",
                  cursor: "pointer",
                }}
              >
                Upgrade to Plus →
              </button>
              <button
                onClick={() => navigate("/app/billing")}
                style={{
                  padding: "12px 32px",
                  borderRadius: "8px",
                  border: "1px solid #c4cdd5",
                  backgroundColor: "white",
                  color: "#637381",
                  fontWeight: 600,
                  fontSize: "14px",
                  cursor: "pointer",
                }}
              >
                Compare Plans
              </button>
            </div>

            {/* Feature preview */}
            <div style={{ marginTop: "40px", textAlign: "left", maxWidth: "480px", margin: "40px auto 0" }}>
              <div style={{ fontWeight: 700, fontSize: "14px", color: "#202223", marginBottom: "12px" }}>What you can do with scheduled edits:</div>
              {[
                { icon: "🎉", text: "Schedule Black Friday / Cyber Monday pricing in advance" },
                { icon: "🔄", text: "Set prices to revert after a sale ends" },
                { icon: "📆", text: "Plan seasonal pricing changes weeks ahead" },
                { icon: "⏰", text: "Time price changes to the exact hour" },
                { icon: "📊", text: "Track all scheduled and past changes" },
              ].map((item, i) => (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: "10px", padding: "8px 0", fontSize: "13px", color: "#637381" }}>
                  <span style={{ fontSize: "16px" }}>{item.icon}</span>
                  <span>{item.text}</span>
                </div>
              ))}
            </div>
          </div>
        </s-section>
      </s-page>
    );
  }

  const pendingEdits = scheduledEdits.filter((e) => e.status === "pending");
  const completedEdits = scheduledEdits.filter((e) => e.status !== "pending");

  return (
    <s-page heading="Scheduled Edits">
      <s-button slot="primary-action" onClick={() => setShowCreate(!showCreate)}>
        {showCreate ? "Cancel" : "Schedule Edit"}
      </s-button>

      <s-section>
        <s-paragraph>
          <s-text>
            Schedule price changes to happen at a specific date and time. Great
            for sales events, seasonal pricing, or timed promotions.
          </s-text>
        </s-paragraph>
      </s-section>

      {showCreate && (
        <s-section heading="New Scheduled Edit">
          <s-stack direction="block" gap="base">
            <s-text-field
              label="Edit Name"
              placeholder="e.g., Black Friday Sale"
              value={editName}
              onInput={(e) => setEditName(e.target.value)}
            />
            <s-date-field
              label="Scheduled Date"
              value={scheduledDate}
              onInput={(e) => setScheduledDate(e.target.value)}
            />
            <s-paragraph>
              <s-text tone="subdued">
                To schedule a bulk edit, first go to the Bulk Edit page, configure your
                changes, then come back here to schedule them. (Full scheduling integration
                coming soon.)
              </s-text>
            </s-paragraph>
            <s-button
              variant="primary"
              onClick={() => {
                if (!editName || !scheduledDate) return;
                fetcher.submit(
                  {
                    intent: "create_scheduled",
                    name: editName,
                    scheduledFor: scheduledDate,
                    productCount: 0,
                  },
                  { method: "POST" }
                );
              }}
            >
              Create Scheduled Edit
            </s-button>
          </s-stack>
        </s-section>
      )}

      <s-section heading={`Pending (${pendingEdits.length})`}>
        {pendingEdits.length === 0 ? (
          <s-box padding="loose" borderWidth="base" borderRadius="base">
            <s-text tone="subdued">No pending scheduled edits.</s-text>
          </s-box>
        ) : (
          <s-section padding="none">
            <s-table>
              <s-table-header-row>
                <s-table-header>Name</s-table-header>
                <s-table-header>Scheduled For</s-table-header>
                <s-table-header format="numeric">Products</s-table-header>
                <s-table-header>Status</s-table-header>
                <s-table-header>Actions</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {pendingEdits.map((edit) => (
                  <s-table-row key={edit.id}>
                    <s-table-cell>
                      <s-text fontWeight="bold">{edit.name}</s-text>
                    </s-table-cell>
                    <s-table-cell>
                      {new Date(edit.scheduledFor).toLocaleString()}
                    </s-table-cell>
                    <s-table-cell>{edit.productCount}</s-table-cell>
                    <s-table-cell>
                      <s-badge tone="attention">Pending</s-badge>
                    </s-table-cell>
                    <s-table-cell>
                      <s-button
                        variant="tertiary"
                        tone="critical"
                        size="slim"
                        onClick={() =>
                          fetcher.submit(
                            { intent: "cancel_scheduled", editId: edit.id },
                            { method: "POST" }
                          )
                        }
                      >
                        Cancel
                      </s-button>
                    </s-table-cell>
                  </s-table-row>
                ))}
              </s-table-body>
            </s-table>
          </s-section>
        )}
      </s-section>

      {completedEdits.length > 0 && (
        <s-section heading="Past Scheduled Edits">
          <s-section padding="none">
            <s-table>
              <s-table-header-row>
                <s-table-header>Name</s-table-header>
                <s-table-header>Scheduled For</s-table-header>
                <s-table-header format="numeric">Products</s-table-header>
                <s-table-header>Status</s-table-header>
                <s-table-header>Actions</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {completedEdits.map((edit) => (
                  <s-table-row key={edit.id}>
                    <s-table-cell>{edit.name}</s-table-cell>
                    <s-table-cell>
                      {new Date(edit.scheduledFor).toLocaleString()}
                    </s-table-cell>
                    <s-table-cell>{edit.productCount}</s-table-cell>
                    <s-table-cell>
                      <s-badge
                        tone={
                          edit.status === "completed"
                            ? "success"
                            : edit.status === "cancelled"
                            ? "critical"
                            : "info"
                        }
                      >
                        {edit.status}
                      </s-badge>
                    </s-table-cell>
                    <s-table-cell>
                      <s-button
                        variant="tertiary"
                        tone="critical"
                        size="slim"
                        onClick={() =>
                          fetcher.submit(
                            { intent: "delete_scheduled", editId: edit.id },
                            { method: "POST" }
                          )
                        }
                      >
                        Delete
                      </s-button>
                    </s-table-cell>
                  </s-table-row>
                ))}
              </s-table-body>
            </s-table>
          </s-section>
        </s-section>
      )}
    </s-page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
