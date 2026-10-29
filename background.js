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
};

/** @type {Map<number, Array<{method: string, url: string, path: string, at: number}>>} */
const recentByTab = new Map();
const MAX_RECENT = 40;

async function getState() {
  const data = await chrome.storage.session.get("interceptState");
  return { ...DEFAULT_STATE, ...(data.interceptState || {}) };
}

async function setState(next) {
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
  };
  await chrome.storage.session.set({ interceptState: normalized });
  updateBadge(normalized.armed, normalized.continuous);
  await broadcastState(normalized);
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
  const next = [entry, ...list.filter((item) => `${item.method} ${item.url}` !== key)];
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
      if (!state.armed) updateBadge(false, false);
      else updateBadge(true, !!state.continuous);
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

        if (incoming.armed) {
          armId += 1;
        }

        const next = {
          ...DEFAULT_STATE,
          ...current,
          ...incoming,
          armId,
          armed: !!incoming.armed,
        };

        await setState(next);

        if (next.armed) {
          await ensureInjectedInActiveTab(next);
        }

        sendResponse({ ok: true, state: next });
      })
      .catch((err) => {
        console.warn("Mock Request Error: SET_STATE failed", err);
        sendResponse({ ok: false });
      });
    return true;
  }

  if (message.type === "REQUEST_INTERCEPTED") {
    getState()
      .then(async (state) => {
        const keepArmed = !!state.continuous;
        const next = {
          ...state,
          armed: keepArmed,
          lastIntercept: {
            url: message.url,
            method: message.method,
            statusCode: message.statusCode || state.statusCode,
            message: state.message,
            contentType: message.contentType || state.contentType,
            at: Date.now(),
          },
        };
        await setState(next);
        sendResponse(next);
      })
      .catch((err) => {
        console.warn("Mock Request Error: REQUEST_INTERCEPTED failed", err);
        sendResponse(null);
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

async function broadcastState(state) {
  try {
    const tabs = await chrome.tabs.query({});
    await Promise.all(
      tabs.map(async (tab) => {
        if (!tab.id || !isInjectableUrl(tab.url)) return;
        try {
          await chrome.tabs.sendMessage(tab.id, {
            type: "STATE_UPDATED",
            state,
          });
        } catch {
          // content script may not be present yet
        }
      })
    );
  } catch {
    // ignore
  }
}

function isInjectableUrl(url) {
  if (!url) return false;
  return /^(https?:|file:)/i.test(url);
}

function toPageConfig(state) {
  return {
    armed: !!state.armed,
    statusCode: state.statusCode ?? 500,
    message: state.message || "",
    contentType: state.contentType || "auto",
    responseBody:
      typeof state.responseBody === "string" ? state.responseBody : "",
    urlFilter: state.urlFilter || "",
    continuous: !!state.continuous,
    selectedUrl: state.selectedUrl || "",
    selectedMethod: state.selectedMethod || "",
    armId: Number(state.armId) || 0,
  };
}

async function ensureInjectedInActiveTab(state) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !isInjectableUrl(tab.url)) return;

    await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      files: ["inject.js"],
      world: "MAIN",
    });

    await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      files: ["content.js"],
    });

    const pageConfig = toPageConfig(state || (await getState()));

    await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      world: "MAIN",
      func: (cfg) => {
        window.__MRE_STATE = cfg;
        window.dispatchEvent(new CustomEvent("__mre_config", { detail: cfg }));
      },
      args: [pageConfig],
    });

    try {
      await chrome.tabs.sendMessage(tab.id, {
        type: "STATE_UPDATED",
        state: pageConfig,
      });
    } catch {
      // ignore
    }
  } catch (err) {
    console.warn("Mock Request Error: inject failed", err);
  }
}
