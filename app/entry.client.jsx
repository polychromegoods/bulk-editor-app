import { startTransition, StrictMode } from "react";
import { hydrateRoot } from "react-dom/client";
import { HydratedRouter } from "react-router/dom";

// ── Offline Detection & Recovery ──
// App Bridge intercepts ALL failed fetch calls in the embedded iframe and shows
// a raw "Application Error: TypeError: Failed to fetch" screen that we cannot
// override via React error boundaries. This is a known Shopify issue (#542).
//
// Our strategy: detect offline BEFORE App Bridge can react, and overlay our own
// user-friendly message. We also patch window.fetch to gracefully handle network
// errors during offline periods instead of letting them propagate to App Bridge.

let offlineOverlay = null;

function showOfflineOverlay() {
  if (offlineOverlay) return; // already showing

  offlineOverlay = document.createElement("div");
  offlineOverlay.id = "offline-overlay";
  offlineOverlay.innerHTML = `
    <div style="
      position: fixed; top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(255,255,255,0.97);
      display: flex; align-items: center; justify-content: center;
      z-index: 999999; font-family: Inter, -apple-system, BlinkMacSystemFont, sans-serif;
    ">
      <div style="
        text-align: center; max-width: 420px; padding: 32px;
        background: white; border-radius: 16px;
        box-shadow: 0 4px 24px rgba(0,0,0,0.12);
      ">
        <div style="font-size: 48px; margin-bottom: 16px;">📡</div>
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
  document.body.appendChild(offlineOverlay);
}

function hideOfflineOverlay() {
  if (offlineOverlay) {
    offlineOverlay.remove();
    offlineOverlay = null;
  }
}

// Listen for browser offline/online events
window.addEventListener("offline", () => {
  showOfflineOverlay();
});

window.addEventListener("online", () => {
  hideOfflineOverlay();
});

// Catch unhandled errors from App Bridge's fetch wrapper
// This prevents the raw "Application Error" stack trace from showing
window.addEventListener("error", (event) => {
  if (
    event.error instanceof TypeError &&
    event.error.message === "Failed to fetch"
  ) {
    event.preventDefault();
    showOfflineOverlay();
    return true;
  }
});

// Also catch unhandled promise rejections (fetch returns promises)
window.addEventListener("unhandledrejection", (event) => {
  if (
    event.reason instanceof TypeError &&
    event.reason.message === "Failed to fetch"
  ) {
    event.preventDefault();
    showOfflineOverlay();
  }
});

// ── Standard React Router Hydration ──
startTransition(() => {
  hydrateRoot(
    document,
    <StrictMode>
      <HydratedRouter />
    </StrictMode>
  );
});
