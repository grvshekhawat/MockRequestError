const DEFAULT_STATE = {
  armed: false,
  statusCode: 500,
  message: "Internal Server Error",
  urlFilter: "",
  lastIntercept: null,
};

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.session.set({ interceptState: DEFAULT_STATE });
  updateBadge(false);
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "GET_STATE") {
    chrome.storage.session.get("interceptState").then((data) => {
      sendResponse(data.interceptState || DEFAULT_STATE);
    });
    return true;
  }

  if (message.type === "SET_STATE") {
    const next = { ...DEFAULT_STATE, ...message.state };
    chrome.storage.session.set({ interceptState: next }).then(() => {
      updateBadge(next.armed);
      broadcastState(next);
      sendResponse({ ok: true });
    });
    return true;
  }

  if (message.type === "REQUEST_INTERCEPTED") {
    chrome.storage.session.get("interceptState").then((data) => {
      const state = data.interceptState || DEFAULT_STATE;
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
      chrome.storage.session.set({ interceptState: next }).then(() => {
        updateBadge(false);
        broadcastState(next);
        sendResponse({ ok: true });
      });
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
    for (const tab of tabs) {
      if (!tab.id) continue;
      chrome.tabs.sendMessage(tab.id, { type: "STATE_UPDATED", state }).catch(() => {});
    }
  } catch {
    // ignore
  }
}
