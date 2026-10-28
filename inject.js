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
    contentType: "application/json",
    responseBody: "",
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

  function normalizeStatus(code) {
    const n = Number(code);
    if (!Number.isFinite(n)) return 500;
    return Math.min(599, Math.max(200, Math.round(n)));
  }

  function buildMock() {
    const status = normalizeStatus(config.statusCode);
    const statusText = (config.message || "").trim() || defaultStatusText(status);
    const contentType = (config.contentType || "application/json").trim();
    const customBody = typeof config.responseBody === "string" ? config.responseBody : "";

    // Fetch forbids bodies for these statuses.
    const noBody = status === 204 || status === 205 || status === 304;
    let body = null;

    if (!noBody) {
      if (customBody.length > 0) {
        body = customBody;
      } else if (contentType.includes("json")) {
        body = JSON.stringify({
          error: status >= 400,
          status,
          message: statusText,
        });
      } else {
        body = statusText || `Status ${status}`;
      }
    }

    return { status, statusText, contentType, body };
  }

  function defaultStatusText(status) {
    const map = {
      200: "OK",
      201: "Created",
      204: "No Content",
      400: "Bad Request",
      401: "Unauthorized",
      403: "Forbidden",
      404: "Not Found",
      409: "Conflict",
      422: "Unprocessable Entity",
      429: "Too Many Requests",
      500: "Internal Server Error",
      502: "Bad Gateway",
      503: "Service Unavailable",
    };
    return map[status] || "Error";
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
    readConfigFromDom();

    const url = resolveUrl(input);
    const method = resolveMethod(input, init);

    if (!shouldIntercept(url)) {
      return originalFetch(input, init);
    }

    const armId = config.armId;
    const mock = buildMock();

    disarmAndRestore(armId);
    notifyIntercepted(url, method, armId);

    const headers = {
      "X-Mock-Request-Error": "1",
      "Cache-Control": "no-store",
    };
    if (mock.body !== null) {
      headers["Content-Type"] = mock.contentType;
    }

    return Promise.resolve(
      new Response(mock.body, {
        status: mock.status,
        statusText: mock.statusText,
        headers,
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
    const mock = buildMock();
    const bodyText = mock.body === null ? "" : String(mock.body);

    this.__mreIntercepted = true;
    this.__mrePatchedFields = [
      "readyState",
      "status",
      "statusText",
      "responseText",
      "response",
      "getAllResponseHeaders",
      "getResponseHeader",
    ];

    disarmAndRestore(armId);
    notifyIntercepted(url, method, armId);

    const xhr = this;
    const headerMap = {
      "content-type": mock.body === null ? null : mock.contentType,
      "x-mock-request-error": "1",
      "cache-control": "no-store",
    };

    queueMicrotask(() => {
      if (!xhr.__mreIntercepted) return;
      try {
        for (const [key, value] of [
          ["readyState", 4],
          ["status", mock.status],
          ["statusText", mock.statusText],
          ["responseText", bodyText],
          ["response", bodyText],
        ]) {
          Object.defineProperty(xhr, key, {
            configurable: true,
            writable: true,
            value,
          });
        }
        Object.defineProperty(xhr, "getAllResponseHeaders", {
          configurable: true,
          value: function () {
            return Object.entries(headerMap)
              .filter(([, v]) => v != null)
              .map(([k, v]) => `${k}: ${v}`)
              .join("\r\n");
          },
        });
        Object.defineProperty(xhr, "getResponseHeader", {
          configurable: true,
          value: function (name) {
            const key = String(name || "").toLowerCase();
            return headerMap[key] ?? null;
          },
        });
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

  uninstallHooks();
  readConfigFromDom();
  syncHooks();

  window.postMessage({ source: "mock-request-error-page", type: "READY" }, "*");
})();
