import { useState } from "react";
import { useLoaderData, useFetcher } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  // Get the shop owner's email from the session table
  const sessionData = await prisma.session.findFirst({
    where: { shop, isOnline: true },
    select: { email: true },
    orderBy: { id: "desc" },
  });

  // Get previous tickets for this shop
  const tickets = await prisma.supportTicket.findMany({
    where: { shop },
    orderBy: { createdAt: "desc" },
    take: 10,
  });

  return {
    shop,
    shopEmail: sessionData?.email || "",
    tickets,
  };
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "submit-ticket") {
    const email = (formData.get("email") || "").trim();
    const subject = (formData.get("subject") || "").trim();
    const message = (formData.get("message") || "").trim();

    if (!email) return { error: "Please enter your email address" };
    if (!subject) return { error: "Please enter a subject" };
    if (!message) return { error: "Please describe your issue or question" };

    try {
      // Save ticket to database
      const ticket = await prisma.supportTicket.create({
        data: { shop, email, subject, message },
      });

      // Send email notification via Shopify's admin GraphQL (using a simple fetch to an email service)
      // For now, we log it and the owner can check the database
      console.log(`[Support] New ticket from ${shop} (${email}): ${subject}`);
      console.log(`[Support] Ticket ID: ${ticket.id}`);
      console.log(`[Support] Message: ${message}`);

      // Try to send email notification to hello@polychromegoods.com
      try {
        const emailBody = [
          `New Support Ticket from Bulk Editor ProX`,
          ``,
          `Shop: ${shop}`,
          `Email: ${email}`,
          `Subject: ${subject}`,
          ``,
          `Message:`,
          message,
          ``,
          `Ticket ID: ${ticket.id}`,
          `Submitted: ${new Date().toISOString()}`,
        ].join("\n");

        // Use a simple webhook/email approach - send via fetch to a mail endpoint
        // This uses Shopify's built-in email capability through the admin API
        // For production, you'd integrate with SendGrid, Mailgun, etc.
        // For now, tickets are stored in the database and logged
        console.log(`[Support] Email notification would be sent to hello@polychromegoods.com`);
        console.log(`[Support] Body:\n${emailBody}`);
      } catch (emailErr) {
        console.error("[Support] Failed to send email notification:", emailErr.message);
        // Don't fail the ticket submission if email fails
      }

      return { success: true, ticketId: ticket.id };
    } catch (err) {
      console.error("[Support] Failed to create ticket:", err);
      return { error: "Failed to submit your request. Please try again." };
    }
  }

  return { error: "Unknown action" };
};

export default function Support() {
  const { shop, shopEmail, tickets } = useLoaderData();
  const fetcher = useFetcher();
  const shopify = useAppBridge();

  const [email, setEmail] = useState(shopEmail || "");
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");

  const isSubmitting = fetcher.state !== "idle";

  // Handle form submission result
  if (fetcher.data?.success && !isSubmitting) {
    if (subject || message) {
      // Clear form after successful submission
      setTimeout(() => {
        setSubject("");
        setMessage("");
        shopify.toast.show("Your support request has been submitted! We'll respond within 12–24 hours.");
      }, 100);
    }
  }

  if (fetcher.data?.error && !isSubmitting) {
    setTimeout(() => {
      shopify.toast.show("Error: " + fetcher.data.error, { isError: true });
    }, 100);
  }

  const handleSubmit = () => {
    fetcher.submit(
      { intent: "submit-ticket", email, subject, message },
      { method: "POST" }
    );
  };

  return (
    <s-page title="Support" subtitle="Get help with Bulk Editor ProX">

      {/* Contact Info */}
      <s-section>
        <s-box padding="base">
          <div style={{
            display: "flex",
            alignItems: "flex-start",
            gap: "16px",
            padding: "8px 0",
          }}>
            <div style={{
              width: "48px",
              height: "48px",
              borderRadius: "12px",
              backgroundColor: "#f0f5ff",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: "24px",
              flexShrink: 0,
            }}>
              💬
            </div>
            <div>
              <div style={{ fontSize: "16px", fontWeight: 700, color: "#202223", marginBottom: "4px" }}>
                Need help? We're here for you.
              </div>
              <div style={{ fontSize: "14px", color: "#637381", lineHeight: "1.5" }}>
                Submit a support request below and our team will get back to you within <strong style={{ color: "#202223" }}>12–24 hours</strong> or sooner.
                You can also reach us directly at{" "}
                <a href="mailto:hello@polychromegoods.com" style={{ color: "#2c6ecb", textDecoration: "none", fontWeight: 600 }}>
                  hello@polychromegoods.com
                </a>
              </div>
            </div>
          </div>
        </s-box>
      </s-section>

      {/* Support Form */}
      <s-section>
        <s-box padding="base">
          <div style={{ fontWeight: 700, fontSize: "16px", color: "#202223", marginBottom: "16px" }}>
            Submit a Request
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
            {/* Email */}
            <div>
              <label style={{ display: "block", fontSize: "13px", fontWeight: 600, color: "#202223", marginBottom: "6px" }}>
                Your Email
              </label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="your@email.com"
                style={{
                  width: "100%",
                  padding: "10px 14px",
                  borderRadius: "8px",
                  border: "1px solid #c4cdd5",
                  fontSize: "14px",
                  outline: "none",
                  boxSizing: "border-box",
                  transition: "border-color 0.15s",
                }}
                onFocus={(e) => e.target.style.borderColor = "#2c6ecb"}
                onBlur={(e) => e.target.style.borderColor = "#c4cdd5"}
              />
              <div style={{ fontSize: "12px", color: "#637381", marginTop: "4px" }}>
                We'll reply to this email address
              </div>
            </div>

            {/* Subject */}
            <div>
              <label style={{ display: "block", fontSize: "13px", fontWeight: 600, color: "#202223", marginBottom: "6px" }}>
                Subject
              </label>
              <input
                type="text"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                placeholder="e.g., Issue with bulk price update"
                maxLength={200}
                style={{
                  width: "100%",
                  padding: "10px 14px",
                  borderRadius: "8px",
                  border: "1px solid #c4cdd5",
                  fontSize: "14px",
                  outline: "none",
                  boxSizing: "border-box",
                  transition: "border-color 0.15s",
                }}
                onFocus={(e) => e.target.style.borderColor = "#2c6ecb"}
                onBlur={(e) => e.target.style.borderColor = "#c4cdd5"}
              />
            </div>

            {/* Message */}
            <div>
              <label style={{ display: "block", fontSize: "13px", fontWeight: 600, color: "#202223", marginBottom: "6px" }}>
                How can we help?
              </label>
              <textarea
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder="Describe your issue, question, or feature request in detail..."
                rows={6}
                maxLength={5000}
                style={{
                  width: "100%",
                  padding: "10px 14px",
                  borderRadius: "8px",
                  border: "1px solid #c4cdd5",
                  fontSize: "14px",
                  outline: "none",
                  boxSizing: "border-box",
                  resize: "vertical",
                  fontFamily: "inherit",
                  lineHeight: "1.5",
                  transition: "border-color 0.15s",
                }}
                onFocus={(e) => e.target.style.borderColor = "#2c6ecb"}
                onBlur={(e) => e.target.style.borderColor = "#c4cdd5"}
              />
              <div style={{ fontSize: "12px", color: "#637381", marginTop: "4px", textAlign: "right" }}>
                {message.length}/5000
              </div>
            </div>

            {/* Submit Button */}
            <div>
              <button
                onClick={handleSubmit}
                disabled={isSubmitting || !email.trim() || !subject.trim() || !message.trim()}
                style={{
                  padding: "12px 32px",
                  borderRadius: "8px",
                  border: "none",
                  backgroundColor: (isSubmitting || !email.trim() || !subject.trim() || !message.trim()) ? "#c4cdd5" : "#2c6ecb",
                  color: "white",
                  fontWeight: 700,
                  fontSize: "14px",
                  cursor: (isSubmitting || !email.trim() || !subject.trim() || !message.trim()) ? "not-allowed" : "pointer",
                  transition: "all 0.15s",
                }}
              >
                {isSubmitting ? "Submitting..." : "Submit Request"}
              </button>
            </div>
          </div>
        </s-box>
      </s-section>

      {/* Previous Tickets */}
      {tickets.length > 0 && (
        <s-section>
          <s-box padding="base">
            <div style={{ fontWeight: 700, fontSize: "16px", color: "#202223", marginBottom: "16px" }}>
              Your Previous Requests
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
              {tickets.map((ticket) => (
                <div key={ticket.id} style={{
                  padding: "14px 16px",
                  borderRadius: "10px",
                  border: "1px solid #e1e3e5",
                  backgroundColor: "#fafbfb",
                }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "6px" }}>
                    <div style={{ fontSize: "14px", fontWeight: 600, color: "#202223" }}>
                      {ticket.subject}
                    </div>
                    <span style={{
                      fontSize: "11px",
                      fontWeight: 700,
                      padding: "3px 10px",
                      borderRadius: "10px",
                      backgroundColor: ticket.status === "open" ? "#fff3cd" : ticket.status === "replied" ? "#e3f1df" : "#f1f2f3",
                      color: ticket.status === "open" ? "#856404" : ticket.status === "replied" ? "#1a7f37" : "#637381",
                      textTransform: "uppercase",
                    }}>
                      {ticket.status}
                    </span>
                  </div>
                  <div style={{ fontSize: "13px", color: "#637381", marginBottom: "4px", lineHeight: "1.4" }}>
                    {ticket.message.length > 120 ? ticket.message.substring(0, 120) + "..." : ticket.message}
                  </div>
                  <div style={{ fontSize: "11px", color: "#919eab" }}>
                    {new Date(ticket.createdAt).toLocaleDateString()} at {new Date(ticket.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                  </div>
                </div>
              ))}
            </div>
          </s-box>
        </s-section>
      )}

      {/* Quick Help */}
      <s-section>
        <s-box padding="base">
          <div style={{ fontWeight: 700, fontSize: "16px", color: "#202223", marginBottom: "16px" }}>
            Quick Help
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "12px" }}>
            {[
              { icon: "📦", title: "Bulk Editing", desc: "Learn how to edit prices, weights, and other fields for multiple products at once." },
              { icon: "⚡", title: "Automation Rules", desc: "Set up rules to automatically adjust prices based on tags, inventory, or other conditions." },
              { icon: "💳", title: "Plans & Billing", desc: "Questions about upgrading, downgrading, or managing your subscription." },
              { icon: "🔄", title: "Undo & History", desc: "How to review past edits and undo changes if something goes wrong." },
            ].map((item, i) => (
              <div key={i} style={{
                padding: "16px",
                borderRadius: "10px",
                border: "1px solid #e1e3e5",
                backgroundColor: "white",
              }}>
                <div style={{ fontSize: "24px", marginBottom: "8px" }}>{item.icon}</div>
                <div style={{ fontSize: "14px", fontWeight: 600, color: "#202223", marginBottom: "4px" }}>{item.title}</div>
                <div style={{ fontSize: "13px", color: "#637381", lineHeight: "1.4" }}>{item.desc}</div>
              </div>
            ))}
          </div>
        </s-box>
      </s-section>
    </s-page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
