const DEFAULT_STATE = {
  armed: false,
  statusCode: 500,
  message: "Internal Server Error",
  urlFilter: "",
  lastIntercept: null,
  armId: 0,
};

async function getState() {
  const data = await chrome.storage.session.get("interceptState");
  return { ...DEFAULT_STATE, ...(data.interceptState || {}) };
}

async function setState(next) {
  const normalized = {
    ...DEFAULT_STATE,
    ...next,
    armed: !!next.armed,
  };
  await chrome.storage.session.set({ interceptState: normalized });
  updateBadge(normalized.armed);
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

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.session.set({ interceptState: { ...DEFAULT_STATE } });
  updateBadge(false);
});

// Browser restart must never leave a sticky armed flag.
chrome.runtime.onStartup.addListener(() => {
  forceDisarm();
});

// Sync badge when the service worker wakes; do not change armed mid-session.
getState()
  .then((state) => updateBadge(!!state.armed))
  .catch(() => updateBadge(false));

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "GET_STATE") {
    getState().then((state) => {
      // Never report sticky armed from a previous crashed session without badge sync.
      if (!state.armed) updateBadge(false);
      sendResponse(state);
    });
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
          await ensureInjectedInActiveTab();
          const latest = await getState();
          await broadcastState(latest);
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
        const next = {
          ...state,
          armed: false,
          lastIntercept: {
            url: message.url,
            method: message.method,
            statusCode: state.statusCode,
            message: state.message,
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

function updateBadge(armed) {
  chrome.action.setBadgeText({ text: armed ? "ON" : "" });
  chrome.action.setBadgeBackgroundColor({ color: armed ? "#c0392b" : "#666666" });
}

async function broadcastState(state) {
  try {
    const tabs = await chrome.tabs.query({});
    await Promise.all(
      tabs.map(async (tab) => {
        if (!tab.id || !isInjectableUrl(tab.url)) return;
        try {
          await chrome.tabs.sendMessage(tab.id, { type: "STATE_UPDATED", state });
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

async function ensureInjectedInActiveTab() {
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
  } catch (err) {
    console.warn("Mock Request Error: inject failed", err);
  }
}
