import { startTransition, StrictMode } from "react";
import { hydrateRoot } from "react-dom/client";
import { HydratedRouter } from "react-router/dom";

// ── Offline Detection & Recovery ──
// App Bridge intercepts ALL failed fetch calls in the embedded iframe and shows
// a raw "Application Error: TypeError: Failed to fetch" screen that we cannot
// override via React error boundaries. This is a known Shopify issue (#542).
//
// The problem: our overlay shows correctly, but ~5 seconds later App Bridge
// replaces the ENTIRE document body with its own error screen, destroying our overlay.
//
// Our strategy (3 layers):
// 1. Patch window.fetch to swallow network errors when offline (prevents App Bridge from seeing them)
// 2. Show our overlay on offline event
// 3. Use MutationObserver to re-inject overlay if App Bridge replaces the DOM

let isOffline = false;
let overlayElement = null;

const OVERLAY_HTML = `
  <div id="offline-overlay" style="
    position: fixed; top: 0; left: 0; right: 0; bottom: 0;
    background: rgba(255,255,255,0.97);
    display: flex; align-items: center; justify-content: center;
    z-index: 2147483647; font-family: Inter, -apple-system, BlinkMacSystemFont, sans-serif;
  ">
    <div style="
      text-align: center; max-width: 420px; padding: 32px;
      background: white; border-radius: 16px;
      box-shadow: 0 4px 24px rgba(0,0,0,0.12);
    ">
      <div style="font-size: 48px; margin-bottom: 16px;">&#128225;</div>
      <div style="font-size: 20px; font-weight: 700; color: #202223; margin-bottom: 8px;">
        Connection Lost
      </div>
      <div style="font-size: 14px; color: #637381; line-height: 1.5; margin-bottom: 24px;">
        Your internet connection was interrupted. Any changes that were already
        sent to Shopify have been saved. Please check your connection and reload.
      </div>
      <div style="display: flex; gap: 8px; justify-content: center; flex-wrap: wrap;">
        <button onclick="window.location.reload()" style="
          padding: 10px 20px; border-radius: 8px; border: none;
          background: #2c6ecb; color: white; font-size: 14px;
          font-weight: 600; cursor: pointer;
        ">
          Reload Page
        </button>
        <button onclick="window.location.href='/app/history'" style="
          padding: 10px 20px; border-radius: 8px;
          border: 1px solid #c4cdd5; background: white;
          color: #202223; font-size: 14px; font-weight: 600;
          cursor: pointer;
        ">
          View History
        </button>
      </div>
      <div style="margin-top: 16px; font-size: 12px; color: #8c9196;">
        Tip: Check the History page to see which changes were saved before the interruption.
      </div>
    </div>
  </div>
`;

function ensureOverlay() {
  if (!isOffline) return;
  // Check if overlay exists in the current DOM
  if (!document.getElementById("offline-overlay")) {
    const container = document.createElement("div");
    container.innerHTML = OVERLAY_HTML;
    overlayElement = container.firstElementChild;
    // Append to body, or to documentElement if body was replaced
    const target = document.body || document.documentElement;
    target.appendChild(overlayElement);
  }
}

function removeOverlay() {
  const existing = document.getElementById("offline-overlay");
  if (existing) existing.remove();
  overlayElement = null;
}

// ── Layer 1: Patch fetch to swallow network errors when offline ──
// This prevents the TypeError from ever reaching App Bridge's error handler.
const originalFetch = window.fetch;
window.fetch = function (...args) {
  return originalFetch.apply(this, args).catch((error) => {
    if (
      !navigator.onLine ||
      isOffline ||
      (error instanceof TypeError && error.message === "Failed to fetch")
    ) {
      // We're offline — don't let this error propagate to App Bridge.
      // Return a synthetic "offline" Response so callers don't crash.
      console.warn("[Offline Guard] Suppressed fetch error:", args[0]);
      isOffline = true;
      ensureOverlay();
      // Return a Response that signals failure without throwing
      return new Response(
        JSON.stringify({ error: "offline", message: "Network connection lost" }),
        { status: 503, statusText: "Service Unavailable", headers: { "Content-Type": "application/json" } }
      );
    }
    // Not a network error — rethrow normally
    throw error;
  });
};

// ── Layer 2: Offline/Online event listeners ──
window.addEventListener("offline", () => {
  isOffline = true;
  ensureOverlay();
});

window.addEventListener("online", () => {
  isOffline = false;
  removeOverlay();
});

// ── Layer 3: MutationObserver to re-inject overlay if App Bridge replaces the DOM ──
// App Bridge replaces the entire body content with its error screen.
// We watch for DOM changes and re-inject our overlay immediately.
const observer = new MutationObserver((mutations) => {
  if (!isOffline) return;
  // If our overlay was removed (App Bridge replaced the body), put it back
  if (!document.getElementById("offline-overlay")) {
    ensureOverlay();
  }
});

// Start observing once the DOM is ready
if (document.body) {
  observer.observe(document.body, { childList: true, subtree: true });
} else {
  document.addEventListener("DOMContentLoaded", () => {
    observer.observe(document.body, { childList: true, subtree: true });
  });
}

// ── Layer 4: Catch any errors that still slip through ──
window.addEventListener("error", (event) => {
  if (
    event.error instanceof TypeError &&
    event.error.message === "Failed to fetch"
  ) {
    event.preventDefault();
    event.stopImmediatePropagation();
    isOffline = true;
    ensureOverlay();
    return true;
  }
}, true); // Use capture phase to intercept before App Bridge

window.addEventListener("unhandledrejection", (event) => {
  if (
    event.reason instanceof TypeError &&
    event.reason.message === "Failed to fetch"
  ) {
    event.preventDefault();
    event.stopImmediatePropagation();
    isOffline = true;
    ensureOverlay();
  }
}, true); // Use capture phase to intercept before App Bridge

// ── Standard React Router Hydration ──
startTransition(() => {
  hydrateRoot(
    document,
    <StrictMode>
      <HydratedRouter />
    </StrictMode>
  );
});
