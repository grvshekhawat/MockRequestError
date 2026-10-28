(function () {
  if (window.__mockRequestErrorInstalled) return;
  window.__mockRequestErrorInstalled = true;

  const ATTR = "data-mre-config";
  const originalFetch = window.fetch.bind(window);
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;

  let config = {
    armed: false,
    statusCode: 500,
    message: "Internal Server Error",
    urlFilter: "",
    armId: 0,
  };
  let consumedArmId = 0;
  let hooksActive = false;

  function applyConfig(next) {
    if (!next || typeof next !== "object") return;

    const incomingArmId = Number(next.armId) || 0;

    if (next.armed && incomingArmId > 0 && incomingArmId <= consumedArmId) {
      config = { ...config, ...next, armed: false, armId: incomingArmId };
      syncHooks();
      return;
    }

    config = { ...config, ...next, armId: incomingArmId };
    syncHooks();
  }

  function readConfigFromDom() {
    try {
      const raw = document.documentElement?.getAttribute(ATTR);
      if (!raw) return;
      applyConfig(JSON.parse(raw));
    } catch {
      // ignore
    }
  }

  function matchesFilter(url) {
    const filter = (config.urlFilter || "").trim();
    if (!filter) return true;
    try {
      return new RegExp(filter, "i").test(url);
    } catch {
      return String(url).toLowerCase().includes(filter.toLowerCase());
    }
  }

  function isNoise(url) {
    const u = String(url);
    return (
      u.startsWith("chrome-extension://") ||
      u.startsWith("data:") ||
      u.startsWith("blob:") ||
      u.startsWith("about:")
    );
  }

  function shouldIntercept(url) {
    if (!config.armed) return false;
    if (isNoise(url)) return false;
    return matchesFilter(String(url));
  }

  function buildBody(status, message) {
    try {
      return JSON.stringify({
        error: true,
        status,
        message: message || "",
      });
    } catch {
      return message || `Error ${status}`;
    }
  }

  function notifyIntercepted(url, method, armId) {
    window.postMessage(
      {
        source: "mock-request-error-page",
        type: "INTERCEPTED",
        payload: {
          url: String(url),
          method: method || "GET",
          armId: armId || 0,
        },
      },
      "*"
    );
  }

  function writeDomArmed(armed) {
    try {
      const payload = { ...config, armed: !!armed };
      config = payload;
      document.documentElement?.setAttribute(ATTR, JSON.stringify(payload));
    } catch {
      // ignore
    }
  }

  function disarmAndRestore(armId) {
    consumedArmId = Math.max(consumedArmId, Number(armId) || config.armId || 0);
    writeDomArmed(false);
    syncHooks();
  }

  function resolveUrl(input) {
    if (typeof input === "string") return input;
    if (typeof Request !== "undefined" && input instanceof Request) return input.url;
    try {
      return String(input);
    } catch {
      return "";
    }
  }

  function resolveMethod(input, init) {
    if (init && init.method) return init.method;
    if (typeof Request !== "undefined" && input instanceof Request) return input.method;
    return "GET";
  }

  function clearXhrOverrides(xhr) {
    if (!xhr || !xhr.__mrePatchedFields) return;
    for (const key of xhr.__mrePatchedFields) {
      try {
        delete xhr[key];
      } catch {
        try {
          Object.defineProperty(xhr, key, {
            configurable: true,
            writable: true,
            value: undefined,
          });
        } catch {
          // ignore
        }
      }
    }
    xhr.__mrePatchedFields = null;
    xhr.__mreIntercepted = false;
  }

  function mockedFetch(input, init) {
    // Re-read in case arm flipped between install and call.
    readConfigFromDom();

    const url = resolveUrl(input);
    const method = resolveMethod(input, init);

    if (!shouldIntercept(url)) {
      return originalFetch(input, init);
    }

    const armId = config.armId;
    const status = Number(config.statusCode) || 500;
    const statusText = config.message || "Error";
    const body = buildBody(status, statusText);

    disarmAndRestore(armId);
    notifyIntercepted(url, method, armId);

    return Promise.resolve(
      new Response(body, {
        status,
        statusText,
        headers: {
          "Content-Type": "application/json",
          "X-Mock-Request-Error": "1",
          "Cache-Control": "no-store",
        },
      })
    );
  }

  function mockedOpen(method, url, ...rest) {
    clearXhrOverrides(this);
    this.__mreMethod = method;
    this.__mreUrl = url;
    this.__mreIntercepted = false;
    return originalOpen.call(this, method, url, ...rest);
  }

  function mockedSend(...args) {
    readConfigFromDom();

    const url = this.__mreUrl;
    const method = this.__mreMethod || "GET";

    if (!shouldIntercept(url)) {
      return originalSend.apply(this, args);
    }

    const armId = config.armId;
    const status = Number(config.statusCode) || 500;
    const statusText = config.message || "Error";
    const body = buildBody(status, statusText);
    this.__mreIntercepted = true;
    this.__mrePatchedFields = [
      "readyState",
      "status",
      "statusText",
      "responseText",
      "response",
    ];

    disarmAndRestore(armId);
    notifyIntercepted(url, method, armId);

    const xhr = this;
    queueMicrotask(() => {
      if (!xhr.__mreIntercepted) return;
      try {
        for (const [key, value] of [
          ["readyState", 4],
          ["status", status],
          ["statusText", statusText],
          ["responseText", body],
          ["response", body],
        ]) {
          Object.defineProperty(xhr, key, {
            configurable: true,
            writable: true,
            value,
          });
        }
      } catch {
        // best effort
      }
      xhr.dispatchEvent(new Event("readystatechange"));
      xhr.dispatchEvent(new Event("load"));
      xhr.dispatchEvent(new Event("loadend"));
    });
  }

  function installHooks() {
    if (hooksActive) return;
    window.fetch = mockedFetch;
    XMLHttpRequest.prototype.open = mockedOpen;
    XMLHttpRequest.prototype.send = mockedSend;
    hooksActive = true;
  }

  function uninstallHooks() {
    if (!hooksActive) return;
    window.fetch = originalFetch;
    XMLHttpRequest.prototype.open = originalOpen;
    XMLHttpRequest.prototype.send = originalSend;
    hooksActive = false;
  }

  function syncHooks() {
    if (config.armed) installHooks();
    else uninstallHooks();
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    if (!event.data || event.data.source !== "mock-request-error") return;
    if (event.data.type === "CONFIG" && event.data.payload) {
      applyConfig(event.data.payload);
    }
  });

  // Start clean: never leave hooks installed unless currently armed.
  uninstallHooks();
  readConfigFromDom();
  syncHooks();

  window.postMessage({ source: "mock-request-error-page", type: "READY" }, "*");
})();
