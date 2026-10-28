(function () {
  function injectScript() {
    const script = document.createElement("script");
    script.src = chrome.runtime.getURL("inject.js");
    script.onload = () => script.remove();
    (document.documentElement || document.head || document).appendChild(script);
  }

  injectScript();

  function pushConfig(state) {
    window.postMessage(
      {
        source: "mock-request-error",
        type: "CONFIG",
        payload: {
          armed: !!state.armed,
          statusCode: state.statusCode,
          message: state.message || "",
          urlFilter: state.urlFilter || "",
        },
      },
      "*"
    );
  }

  function loadAndPush() {
    chrome.runtime.sendMessage({ type: "GET_STATE" }, (state) => {
      if (chrome.runtime.lastError || !state) return;
      pushConfig(state);
    });
  }

  loadAndPush();

  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === "STATE_UPDATED" && message.state) {
      pushConfig(message.state);
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "session" && changes.interceptState) {
      pushConfig(changes.interceptState.newValue || {});
    }
  });

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    if (!event.data || event.data.source !== "mock-request-error-page") return;

    if (event.data.type === "INTERCEPTED") {
      chrome.runtime.sendMessage({
        type: "REQUEST_INTERCEPTED",
        url: event.data.payload.url,
        method: event.data.payload.method,
      });
    }
  });
})();
