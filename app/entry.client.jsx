import { startTransition, StrictMode } from "react";
import { hydrateRoot } from "react-dom/client";
import { HydratedRouter } from "react-router/dom";

// ── Offline Detection & Recovery ──
// App Bridge intercepts ALL failed fetch calls in the embedded iframe and shows
// a raw "Application Error: TypeError: Failed to fetch" screen. This is a known
// Shopify App Bridge issue (#542) with no official workaround.
//
// The problem: Our overlay shows, but App Bridge replaces the ENTIRE document body
// with its own error screen ~2 seconds later, destroying our overlay and JS context.
//
// Strategy: Use a non-overridable fetch Proxy + aggressive DOM protection.

let isOffline = false;

const OVERLAY_ID = "offline-overlay-root";

const OVERLAY_HTML = `<div id="${OVERLAY_ID}" style="position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(255,255,255,0.98);display:flex;align-items:center;justify-content:center;z-index:2147483647;font-family:Inter,-apple-system,BlinkMacSystemFont,sans-serif">
<div style="text-align:center;max-width:420px;padding:32px;background:white;border-radius:16px;box-shadow:0 4px 24px rgba(0,0,0,0.12)">
<div style="font-size:48px;margin-bottom:16px">&#128225;</div>
<div style="font-size:20px;font-weight:700;color:#202223;margin-bottom:8px">Connection Lost</div>
<div style="font-size:14px;color:#637381;line-height:1.5;margin-bottom:24px">Your internet connection was interrupted. Any changes that were already sent to Shopify have been saved. Please check your connection and reload.</div>
<div style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap">
<button onclick="window.location.reload()" style="padding:10px 20px;border-radius:8px;border:none;background:#2c6ecb;color:white;font-size:14px;font-weight:600;cursor:pointer">Reload Page</button>
<button onclick="window.location.href='/app/history'" style="padding:10px 20px;border-radius:8px;border:1px solid #c4cdd5;background:white;color:#202223;font-size:14px;font-weight:600;cursor:pointer">View History</button>
</div>
<div style="margin-top:16px;font-size:12px;color:#8c9196">Tip: Check the History page to see which changes were saved before the interruption.</div>
</div></div>`;

function ensureOverlay() {
  if (!isOffline) return;
  if (document.getElementById(OVERLAY_ID)) return;
  const target = document.body || document.documentElement;
  const wrapper = document.createElement("div");
  wrapper.innerHTML = OVERLAY_HTML;
  target.appendChild(wrapper.firstElementChild);
}

function removeOverlay() {
  isOffline = false;
  const el = document.getElementById(OVERLAY_ID);
  if (el) el.remove();
}

// ═══════════════════════════════════════════════════════════════════
// Layer 1: Non-overridable fetch Proxy
// ═══════════════════════════════════════════════════════════════════
// App Bridge may overwrite window.fetch after our code runs.
// Using Object.defineProperty with a Proxy ensures our wrapper persists.

const nativeFetch = window.fetch.bind(window);

function guardedFetch(...args) {
  return nativeFetch(...args).catch((error) => {
    if (
      error instanceof TypeError &&
      (error.message === "Failed to fetch" ||
       error.message.includes("NetworkError") ||
       error.message.includes("network"))
    ) {
      console.warn("[Offline Guard] Suppressed fetch error:", args[0]);
      isOffline = true;
      ensureOverlay();
      // Return synthetic response so callers don't crash
      return new Response(
        JSON.stringify({ error: "offline", message: "Network connection lost" }),
        { status: 503, statusText: "Service Unavailable", headers: { "Content-Type": "application/json" } }
      );
    }
    throw error;
  });
}

// Make fetch non-configurable so App Bridge can't replace it
try {
  Object.defineProperty(window, "fetch", {
    get() { return guardedFetch; },
    set() { /* silently ignore attempts to overwrite */ },
    configurable: false,
    enumerable: true,
  });
} catch (e) {
  // If defineProperty fails (already non-configurable), just assign
  window.fetch = guardedFetch;
}

// ═══════════════════════════════════════════════════════════════════
// Layer 2: Offline/Online event listeners
// ═══════════════════════════════════════════════════════════════════
window.addEventListener("offline", () => {
  isOffline = true;
  ensureOverlay();
});

window.addEventListener("online", () => {
  removeOverlay();
});

// ═══════════════════════════════════════════════════════════════════
// Layer 3: Aggressive MutationObserver
// ═══════════════════════════════════════════════════════════════════
// App Bridge replaces the entire body content. We observe document
// (not just body) so even if body is replaced, we detect it.

function startObserver() {
  const obs = new MutationObserver(() => {
    if (!isOffline) return;
    // Re-inject overlay if it was removed
    if (!document.getElementById(OVERLAY_ID)) {
      ensureOverlay();
    }
  });

  // Observe the entire document to catch body replacement
  obs.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
}

if (document.documentElement) {
  startObserver();
} else {
  document.addEventListener("DOMContentLoaded", startObserver);
}

// ═══════════════════════════════════════════════════════════════════
// Layer 4: Capture-phase error handlers
// ═══════════════════════════════════════════════════════════════════
// Intercept errors before App Bridge's handlers can process them.

window.addEventListener("error", (event) => {
  if (
    event.error instanceof TypeError &&
    (event.error.message === "Failed to fetch" ||
     event.error.message.includes("NetworkError"))
  ) {
    event.preventDefault();
    event.stopImmediatePropagation();
    isOffline = true;
    ensureOverlay();
    return true;
  }
}, true);

window.addEventListener("unhandledrejection", (event) => {
  if (
    event.reason instanceof TypeError &&
    (event.reason.message === "Failed to fetch" ||
     event.reason.message.includes("NetworkError"))
  ) {
    event.preventDefault();
    event.stopImmediatePropagation();
    isOffline = true;
    ensureOverlay();
  }
}, true);

// ═══════════════════════════════════════════════════════════════════
// Layer 5: Periodic check (nuclear option)
// ═══════════════════════════════════════════════════════════════════
// If App Bridge somehow destroys our MutationObserver, this interval
// ensures the overlay is re-injected every 500ms while offline.

setInterval(() => {
  if (isOffline && !document.getElementById(OVERLAY_ID)) {
    ensureOverlay();
  }
}, 500);

// ── Standard React Router Hydration ──
startTransition(() => {
  hydrateRoot(
    document,
    <StrictMode>
      <HydratedRouter />
    </StrictMode>
  );
});
