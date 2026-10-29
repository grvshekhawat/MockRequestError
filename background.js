const DEFAULT_STATE = {
  armed: false,
  statusCode: 500,
  message: "Internal Server Error",
  contentType: "auto",
  responseBody: "",
  urlFilter: "",
  continuous: false,
  selectedUrl: "",
  selectedMethod: "",
  lastIntercept: null,
  armId: 0,
  lastError: "",
};

/** @type {Map<number, Array<{method: string, url: string, path: string, at: number}>>} */
const recentByTab = new Map();
const MAX_RECENT = 50;

/** @type {Set<number>} */
const attachedTabs = new Set();

async function getState() {
  const data = await chrome.storage.session.get("interceptState");
  return { ...DEFAULT_STATE, ...(data.interceptState || {}) };
}

async function setState(next) {
  const wasArmed = (await getState()).armed;
  const normalized = {
    ...DEFAULT_STATE,
    ...next,
    armed: !!next.armed,
    continuous: !!next.continuous,
    contentType: next.contentType || "auto",
    responseBody:
      typeof next.responseBody === "string" ? next.responseBody : "",
    selectedUrl: next.selectedUrl || "",
    selectedMethod: next.selectedMethod || "",
    lastError: next.lastError || "",
  };

  await chrome.storage.session.set({ interceptState: normalized });
  updateBadge(normalized.armed, normalized.continuous);

  if (normalized.armed && !wasArmed) {
    const result = await attachActiveTabDebugger();
    if (!result.ok) {
      normalized.armed = false;
      normalized.lastError = result.error || "Failed to attach debugger";
      await chrome.storage.session.set({ interceptState: normalized });
      updateBadge(false, false);
      return normalized;
    }
    normalized.lastError = "";
    await chrome.storage.session.set({ interceptState: normalized });
  }

  if (!normalized.armed && wasArmed) {
    await detachAllDebuggers();
  }

  return normalized;
}

async function forceDisarm() {
  const current = await getState();
  return setState({
    ...current,
    armed: false,
  });
}

function recordRecent(tabId, method, url) {
  if (!tabId || tabId < 0 || !url) return;
  if (!/^https?:/i.test(url)) return;

  let path = url;
  try {
    const u = new URL(url);
    path = u.pathname + u.search;
  } catch {
    // keep raw
  }

  const entry = {
    method: (method || "GET").toUpperCase(),
    url,
    path,
    at: Date.now(),
  };

  const list = recentByTab.get(tabId) || [];
  const key = `${entry.method} ${entry.url}`;
  const next = [
    entry,
    ...list.filter((item) => `${item.method} ${item.url}` !== key),
  ];
  recentByTab.set(tabId, next.slice(0, MAX_RECENT));
}

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.type !== "xmlhttprequest") return;
    recordRecent(details.tabId, details.method, details.url);
  },
  { urls: ["<all_urls>"], types: ["xmlhttprequest"] }
);

chrome.tabs.onRemoved.addListener((tabId) => {
  recentByTab.delete(tabId);
  attachedTabs.delete(tabId);
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.session.set({ interceptState: { ...DEFAULT_STATE } });
  updateBadge(false, false);
});

chrome.runtime.onStartup.addListener(() => {
  forceDisarm();
});

getState()
  .then((state) => updateBadge(!!state.armed, !!state.continuous))
  .catch(() => updateBadge(false, false));

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "GET_STATE") {
    getState().then((state) => {
      updateBadge(!!state.armed, !!state.continuous);
      sendResponse(state);
    });
    return true;
  }

  if (message.type === "GET_RECENT_REQUESTS") {
    (async () => {
      let tabId = message.tabId;
      if (!tabId) {
        const [tab] = await chrome.tabs.query({
          active: true,
          currentWindow: true,
        });
        tabId = tab?.id;
      }
      sendResponse({
        tabId,
        requests: tabId ? recentByTab.get(tabId) || [] : [],
      });
    })();
    return true;
  }

  if (message.type === "CLEAR_RECENT_REQUESTS") {
    (async () => {
      const [tab] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });
      if (tab?.id) recentByTab.delete(tab.id);
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (message.type === "SET_STATE") {
    getState()
      .then(async (current) => {
        const incoming = { ...message.state };
        let armId = current.armId || 0;
        if (incoming.armed) armId += 1;

        const next = {
          ...DEFAULT_STATE,
          ...current,
          ...incoming,
          armId,
          armed: !!incoming.armed,
          lastError: "",
        };

        const saved = await setState(next);
        sendResponse({ ok: !saved.lastError, state: saved });
      })
      .catch((err) => {
        console.warn("Mock Request Error: SET_STATE failed", err);
        sendResponse({ ok: false, error: String(err) });
      });
    return true;
  }

  return false;
});

function updateBadge(armed, continuous) {
  if (!armed) {
    chrome.action.setBadgeText({ text: "" });
    return;
  }
  chrome.action.setBadgeText({ text: continuous ? "∞" : "ON" });
  chrome.action.setBadgeBackgroundColor({
    color: continuous ? "#2d6a4f" : "#c0392b",
  });
}

function isHttpUrl(url) {
  return !!url && /^https?:/i.test(url);
}

function matchesSelected(state, url, method) {
  const selected = (state.selectedUrl || "").trim();
  if (!selected) return null;

  const selectedMethod = (state.selectedMethod || "").trim().toUpperCase();
  if (
    selectedMethod &&
    method &&
    selectedMethod !== String(method).toUpperCase()
  ) {
    return false;
  }

  try {
    const actual = new URL(url);
    const target = new URL(selected);
    return (
      actual.origin === target.origin && actual.pathname === target.pathname
    );
  } catch {
    return String(url).includes(selected);
  }
}

function matchesFilter(state, url) {
  const filter = (state.urlFilter || "").trim();
  if (!filter) return true;
  try {
    return new RegExp(filter, "i").test(url);
  } catch {
    return String(url).toLowerCase().includes(filter.toLowerCase());
  }
}

function shouldMock(state, url, method, resourceType) {
  if (!state.armed) return false;
  if (!isHttpUrl(url)) return false;

  const selected = matchesSelected(state, url, method);
  if (selected === true) return true;
  if (selected === false) {
    // Selected API didn't match; allow filter fallback.
    if (!(state.urlFilter || "").trim()) return false;
  }

  // With no targeting, only touch XHR/Fetch so navigations/assets keep working.
  const hasTarget =
    !!(state.selectedUrl || "").trim() || !!(state.urlFilter || "").trim();
  if (!hasTarget) {
    const type = String(resourceType || "");
    if (type && type !== "XHR" && type !== "Fetch") return false;
  }

  return matchesFilter(state, url);
}

function detectContentType(body, explicit) {
  const chosen = (explicit || "auto").trim().toLowerCase();
  if (chosen && chosen !== "auto") return chosen;

  const raw = String(body || "").trim();
  if (!raw) return "application/json";

  if (
    (raw.startsWith("{") && raw.endsWith("}")) ||
    (raw.startsWith("[") && raw.endsWith("]"))
  ) {
    try {
      JSON.parse(raw);
      return "application/json";
    } catch {
      // fall through
    }
  }

  if (raw.startsWith("<?xml") || /^<\w+[\s>]/.test(raw)) {
    if (/^<!doctype html/i.test(raw) || /^<html[\s>]/i.test(raw)) {
      return "text/html";
    }
    return "application/xml";
  }

  if (/^<!doctype html/i.test(raw) || /^<html[\s>]/i.test(raw)) {
    return "text/html";
  }

  return "text/plain";
}

function buildMockBody(state) {
  const status = Number(state.statusCode) || 500;
  const message = (state.message || "").trim() || `Status ${status}`;
  const custom =
    typeof state.responseBody === "string" ? state.responseBody : "";
  const noBody = status === 204 || status === 205 || status === 304;

  if (noBody) {
    return { status, body: null, contentType: null };
  }

  let body;
  if (custom.length > 0) {
    body = custom;
  } else {
    body = JSON.stringify({
      error: status >= 400,
      status,
      message,
    });
  }

  return {
    status,
    body,
    contentType: detectContentType(body, state.contentType),
  };
}

function encodeBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

async function attachActiveTabDebugger() {
  const [tab] = await chrome.tabs.query({
    active: true,
    currentWindow: true,
  });
  if (!tab?.id || !isHttpUrl(tab.url)) {
    return {
      ok: false,
      error: "Open an http(s) page tab, then arm again.",
    };
  }

  const tabId = tab.id;
  const DEVTOOLS_MSG =
    "Close DevTools on this tab (and any other debugger), then click Intercept again.";

  // If some debugger is already on the tab, only continue if it's us.
  try {
    const targets = await chrome.debugger.getTargets();
    const target = targets.find((t) => t.tabId === tabId && t.attached);
    if (target?.attached && !attachedTabs.has(tabId)) {
      // Likely DevTools. We can't take over.
      return { ok: false, error: DEVTOOLS_MSG };
    }
  } catch {
    // getTargets can fail; fall through to attach attempt
  }

  if (!attachedTabs.has(tabId)) {
    try {
      await chrome.debugger.attach({ tabId }, "1.3");
      attachedTabs.add(tabId);
    } catch (err) {
      const msg = String(err?.message || err);
      if (/already attached|another debugger/i.test(msg)) {
        // Might be a stale attach from a previous SW restart — try using it.
        try {
          await chrome.debugger.sendCommand({ tabId }, "Fetch.enable", {
            patterns: [{ urlPattern: "*", requestStage: "Request" }],
          });
          attachedTabs.add(tabId);
          return { ok: true, tabId };
        } catch {
          return { ok: false, error: DEVTOOLS_MSG };
        }
      }
      return {
        ok: false,
        error: `Could not attach debugger. ${DEVTOOLS_MSG}`,
      };
    }
  }

  try {
    await chrome.debugger.sendCommand({ tabId }, "Fetch.enable", {
      patterns: [{ urlPattern: "*", requestStage: "Request" }],
    });
    return { ok: true, tabId };
  } catch (err) {
    attachedTabs.delete(tabId);
    try {
      await chrome.debugger.detach({ tabId });
    } catch {
      // ignore
    }
    return {
      ok: false,
      error: `Could not start intercept. ${DEVTOOLS_MSG}`,
    };
  }
}

async function detachDebugger(tabId) {
  if (!attachedTabs.has(tabId)) return;
  try {
    await chrome.debugger.sendCommand({ tabId }, "Fetch.disable");
  } catch {
    // ignore
  }
  try {
    await chrome.debugger.detach({ tabId });
  } catch {
    // ignore
  }
  attachedTabs.delete(tabId);
}

async function detachAllDebuggers() {
  const ids = [...attachedTabs];
  await Promise.all(ids.map((id) => detachDebugger(id)));
}

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId != null) attachedTabs.delete(source.tabId);
});

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (method !== "Fetch.requestPaused") return;
  handlePaused(source, params).catch((err) => {
    console.warn("Mock Request Error: handlePaused failed", err);
  });
});

async function handlePaused(source, params) {
  const tabId = source.tabId;
  const requestId = params.requestId;
  const url = params.request?.url || "";
  const method = (params.request?.method || "GET").toUpperCase();
  const resourceType = params.resourceType || "";

  const continueRequest = async () => {
    try {
      await chrome.debugger.sendCommand(source, "Fetch.continueRequest", {
        requestId,
      });
    } catch (err) {
      console.warn("Mock Request Error: continueRequest failed", err);
    }
  };

  const state = await getState();
  if (!state.armed || !attachedTabs.has(tabId)) {
    await continueRequest();
    return;
  }

  recordRecent(tabId, method, url);

  if (!shouldMock(state, url, method, resourceType)) {
    await continueRequest();
    return;
  }

  const mock = buildMockBody(state);
  const headers = [{ name: "X-Mock-Request-Error", value: "1" }];
  if (mock.contentType) {
    headers.push({ name: "Content-Type", value: mock.contentType });
  }
  headers.push({ name: "Cache-Control", value: "no-store" });

  try {
    const fulfill = {
      requestId,
      responseCode: mock.status,
      responseHeaders: headers,
    };
    if (mock.body != null) {
      fulfill.body = encodeBase64(mock.body);
    }
    await chrome.debugger.sendCommand(source, "Fetch.fulfillRequest", fulfill);
  } catch (err) {
    console.warn("Mock Request Error: fulfillRequest failed", err);
    await continueRequest();
    return;
  }

  const keepArmed = !!state.continuous;
  const next = {
    ...state,
    armed: keepArmed,
    lastIntercept: {
      url,
      method,
      statusCode: mock.status,
      message: state.message,
      contentType: mock.contentType,
      at: Date.now(),
    },
    lastError: "",
  };

  // Update storage/badge directly to avoid re-entrant attach/detach during the CDP event.
  await chrome.storage.session.set({ interceptState: next });
  updateBadge(next.armed, next.continuous);

  if (!keepArmed) {
    // Detach after a tick so fulfillRequest can finish cleanly.
    setTimeout(() => {
      detachDebugger(tabId).catch(() => {});
    }, 0);
  }
}
