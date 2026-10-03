// ---------- Milestone 1: page detection ----------
console.log("[CodeSync] Codeforces page detected");

// ---------- Submission detection ----------

let lastSentAt = 0;

// Read the logged-in user's handle from the page header
function getHandle() {
  const link = document.querySelector('#header a[href^="/profile/"]');
  if (!link) return null;
  const href = link.getAttribute("href");
  return decodeURIComponent(href.split("/profile/")[1].split(/[/?#]/)[0]);
}

function notifySubmission() {
  const now = Date.now();
  if (now - lastSentAt < 3000) return; // ignore duplicate events
  lastSentAt = now;

  try {
    chrome.runtime.sendMessage(
      {
        type: "SUBMISSION_DETECTED",
        url: window.location.href,
        handle: getHandle(),
        submittedAt: now // when the user clicked Submit (ms since 1970)
      },
      (response) => {
        if (chrome.runtime.lastError) {
          console.warn("[CodeSync] Message failed:", chrome.runtime.lastError.message);
          return;
        }
        console.log("[CodeSync] Background replied:", response);
      }
    );
  } catch (err) {
    console.warn("[CodeSync] Could not reach extension. Refresh the page.", err);
  }
}

function isSubmitForm(form) {
  if (!form || form.tagName !== "FORM") return false;
  const action = form.getAttribute("action") || "";
  const hasSourceField = form.querySelector(
    'textarea[name="source"], input[name="programTypeId"], select[name="programTypeId"]'
  );
  return action.includes("submit") || Boolean(hasSourceField);
}

document.addEventListener(
  "submit",
  (event) => {
    if (isSubmitForm(event.target)) notifySubmission();
  },
  true
);

document.addEventListener(
  "click",
  (event) => {
    const button = event.target.closest(
      '#singlePageSubmitButton, input[type="submit"], button[type="submit"]'
    );
    if (button && isSubmitForm(button.closest("form"))) notifySubmission();
  },
  true
);

// ---------- Source code retrieval (asked for by background.js) ----------

// Codeforces puts a CSRF token on every page when you're logged in
function getCsrfToken() {
  const meta = document.querySelector('meta[name="X-Csrf-Token"]');
  if (meta && meta.content) return meta.content;

  const input = document.querySelector('input[name="csrf_token"]');
  return input ? input.value : null;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type !== "FETCH_SOURCE") return;

  const csrfToken = getCsrfToken();
  if (!csrfToken) {
    sendResponse({
      ok: false,
      error: "could not find the page's CSRF token (are you logged in?)"
    });
    return;
  }

  // The same request Codeforces' own "view source" button makes
  fetch("/data/submitSource", {
    method: "POST",
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      "X-Csrf-Token": csrfToken,
      "X-Requested-With": "XMLHttpRequest"
    },
    body: new URLSearchParams({
      submissionId: String(message.submissionId),
      csrf_token: csrfToken
    })
  })
    .then(async (response) => {
      if (!response.ok) {
        throw new Error("Codeforces returned HTTP " + response.status);
      }
      const data = await response.json();
      if (typeof data.source !== "string") {
        throw new Error("the response did not contain a source field");
      }
      sendResponse({ ok: true, source: data.source });
    })
    .catch((error) => sendResponse({ ok: false, error: error.message }));

  return true; // tells Chrome we will reply later (asynchronously)
});