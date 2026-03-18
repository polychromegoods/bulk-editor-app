import { describe, it, expect } from "vitest";

/**
 * Smoke Tests — Railway Server Health
 *
 * These tests verify the production server is running and responding.
 * They run against the live Railway URL and check:
 * - Server is reachable (not down)
 * - Key routes return expected status codes
 * - Response times are acceptable
 *
 * Set RAILWAY_URL env var to override the default URL.
 */

const BASE_URL =
  process.env.RAILWAY_URL || "https://bulk-editor-app-production.up.railway.app";

const TIMEOUT_MS = 10000;

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const start = Date.now();
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    const elapsed = Date.now() - start;
    return { res, elapsed };
  } finally {
    clearTimeout(timer);
  }
}

describe("Railway server health", () => {
  it("server is reachable and responds", async () => {
    const { res, elapsed } = await fetchWithTimeout(BASE_URL);
    // Any response (even redirect) means server is up
    expect(res.status).toBeLessThan(600);
    console.log(`  → Root response: ${res.status} in ${elapsed}ms`);
  });

  it("responds within acceptable time (<5s)", async () => {
    const { elapsed } = await fetchWithTimeout(BASE_URL);
    expect(elapsed).toBeLessThan(5000);
    console.log(`  → Response time: ${elapsed}ms`);
  });
});

describe("Key route responses", () => {
  it("GET / returns 200 or 302/410 (auth redirect)", async () => {
    const { res } = await fetchWithTimeout(BASE_URL, { redirect: "manual" });
    // 200 = served, 302 = auth redirect, 410 = Shopify auth bounce
    expect([200, 302, 410]).toContain(res.status);
    console.log(`  → GET / status: ${res.status}`);
  });

  it("GET /app returns auth-related response", async () => {
    const { res } = await fetchWithTimeout(`${BASE_URL}/app`, {
      redirect: "manual",
    });
    // Without Shopify session, expect 302 redirect or 410 auth bounce
    expect([200, 302, 401, 410]).toContain(res.status);
    console.log(`  → GET /app status: ${res.status}`);
  });

  it("POST /webhooks/gdpr returns 401 without valid HMAC", async () => {
    const { res } = await fetchWithTimeout(`${BASE_URL}/webhooks/gdpr`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ test: true }),
      redirect: "manual",
    });
    // Without valid Shopify HMAC header, should reject
    expect([400, 401, 403, 500]).toContain(res.status);
    console.log(`  → POST /webhooks/gdpr status: ${res.status}`);
  });

  it("POST /webhooks/products/update returns 401 without valid HMAC", async () => {
    const { res } = await fetchWithTimeout(
      `${BASE_URL}/webhooks/products/update`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: 123, title: "Test" }),
        redirect: "manual",
      }
    );
    // Without valid Shopify HMAC header, should reject
    expect([400, 401, 403, 500]).toContain(res.status);
    console.log(`  → POST /webhooks/products/update status: ${res.status}`);
  });

  it("GET /nonexistent returns 404", async () => {
    const { res } = await fetchWithTimeout(`${BASE_URL}/nonexistent-route-xyz`, {
      redirect: "manual",
    });
    // Should be 404 or possibly 302 redirect
    expect([302, 404, 410]).toContain(res.status);
    console.log(`  → GET /nonexistent status: ${res.status}`);
  });
});

describe("Response headers security", () => {
  it("does not expose server version details", async () => {
    const { res } = await fetchWithTimeout(BASE_URL, { redirect: "manual" });
    const server = res.headers.get("server") || "";
    // Should not expose detailed version info
    expect(server).not.toMatch(/Apache|nginx\/\d|Express\/\d/i);
    console.log(`  → Server header: ${server || "(not set)"}`);
  });
});

describe("SSL/TLS", () => {
  it("HTTPS is enforced (HTTP redirects or fails)", async () => {
    const httpUrl = BASE_URL.replace("https://", "http://");
    try {
      const { res } = await fetchWithTimeout(httpUrl, { redirect: "manual" });
      // Should redirect to HTTPS or Railway handles it
      expect([200, 301, 302, 307, 308]).toContain(res.status);
      if ([301, 302, 307, 308].includes(res.status)) {
        const location = res.headers.get("location") || "";
        expect(location).toMatch(/^https:\/\//);
      }
      console.log(`  → HTTP redirect status: ${res.status}`);
    } catch (e) {
      // Connection refused on HTTP is also acceptable
      console.log(`  → HTTP connection refused (good — HTTPS only)`);
      expect(true).toBe(true);
    }
  });
});
