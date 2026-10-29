(function () {
  if (window.__mreContentInstalled) return;
  window.__mreContentInstalled = true;

  function toPayload(state) {
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

  function pushConfig(state) {
    const payload = toPayload(state || { armed: false });
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
      if (chrome.runtime.lastError || !state) {
        pushConfig({ armed: false, armId: 0 });
        return;
      }
      pushConfig(state);
    });
  }

  loadAndPush();

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === "STATE_UPDATED" && message.state) {
      pushConfig(message.state);
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
      pushConfig(changes.interceptState.newValue || { armed: false });
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
      const continuous = !!event.data.payload.continuous;

      // One-shot: disarm immediately. Continuous: stay armed locally.
      if (!continuous) {
        pushConfig({
          armed: false,
          continuous: false,
          statusCode: event.data.payload.statusCode,
          contentType: event.data.payload.contentType,
          armId: event.data.payload.armId || 0,
        });
      }

      chrome.runtime.sendMessage(
        {
          type: "REQUEST_INTERCEPTED",
          url: event.data.payload.url,
          method: event.data.payload.method,
          armId: event.data.payload.armId || 0,
          statusCode: event.data.payload.statusCode,
          contentType: event.data.payload.contentType,
        },
        (state) => {
          if (chrome.runtime.lastError || !state) {
            if (!continuous) pushConfig({ armed: false });
            return;
          }
          pushConfig(state);
        }
      );
    }
  });
})();
