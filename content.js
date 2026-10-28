(function () {
  const ATTR = "data-mre-config";

  function writeDomConfig(state) {
    const payload = {
      armed: !!state.armed,
      statusCode: state.statusCode ?? 500,
      message: state.message || "",
      urlFilter: state.urlFilter || "",
    };
    try {
      const el = document.documentElement;
      if (el) {
        el.setAttribute(ATTR, JSON.stringify(payload));
      }
    } catch {
      // ignore
    }
    window.postMessage(
      {
        source: "mock-request-error",
        type: "CONFIG",
        payload,
      },
      "*"
    );
  }

  function loadAndPush() {
    chrome.runtime.sendMessage({ type: "GET_STATE" }, (state) => {
      if (chrome.runtime.lastError || !state) return;
      writeDomConfig(state);
    });
  }

  loadAndPush();

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === "STATE_UPDATED" && message.state) {
      writeDomConfig(message.state);
      sendResponse({ ok: true });
      return false;
    }
    if (message.type === "PING") {
      loadAndPush();
      sendResponse({ ok: true });
      return false;
    }
    return false;
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if ((area === "session" || area === "local") && changes.interceptState) {
      writeDomConfig(changes.interceptState.newValue || {});
    }
  });

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    if (!event.data || event.data.source !== "mock-request-error-page") return;

    if (event.data.type === "READY") {
      loadAndPush();
      return;
    }

    if (event.data.type === "INTERCEPTED") {
      chrome.runtime.sendMessage({
        type: "REQUEST_INTERCEPTED",
        url: event.data.payload.url,
        method: event.data.payload.method,
      });
    }
  });
})();
