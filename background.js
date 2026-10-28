const DEFAULT_STATE = {
  armed: false,
  statusCode: 500,
  message: "Internal Server Error",
  urlFilter: "",
  lastIntercept: null,
};

async function getState() {
  const data = await chrome.storage.session.get("interceptState");
  return data.interceptState || DEFAULT_STATE;
}

async function setState(next) {
  await chrome.storage.session.set({ interceptState: next });
  updateBadge(next.armed);
  await broadcastState(next);
  return next;
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.session.set({ interceptState: DEFAULT_STATE });
  updateBadge(false);
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "GET_STATE") {
    getState().then(sendResponse);
    return true;
  }

  if (message.type === "SET_STATE") {
    const next = { ...DEFAULT_STATE, ...message.state };
    setState(next).then(async () => {
      if (next.armed) {
        await ensureInjectedInActiveTab();
      }
      sendResponse({ ok: true });
    });
    return true;
  }

  if (message.type === "REQUEST_INTERCEPTED") {
    getState().then(async (state) => {
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
      sendResponse({ ok: true });
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

    // Re-inject hooks into the page world (covers tabs opened before install).
    await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      files: ["inject.js"],
      world: "MAIN",
    });

    await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      files: ["content.js"],
    });

    const state = await getState();
    try {
      await chrome.tabs.sendMessage(tab.id, { type: "STATE_UPDATED", state });
    } catch {
      // ignore
    }
  } catch (err) {
    console.warn("Mock Request Error: inject failed", err);
  }
}
