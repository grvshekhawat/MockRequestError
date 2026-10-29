(function () {
  if (window.__mockRequestErrorInstalled) return;
  window.__mockRequestErrorInstalled = true;

  const originalFetch = window.fetch.bind(window);
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;

  let config = {
    armed: false,
    statusCode: 500,
    message: "",
    contentType: "auto",
    responseBody: "",
    urlFilter: "",
    continuous: false,
    selectedUrl: "",
    selectedMethod: "",
    armId: 0,
  };
  let consumedArmId = 0;
  let hooksActive = false;

  function applyConfig(next) {
    if (!next || typeof next !== "object") return;

    const incomingArmId = Number(next.armId) || 0;

    if (next.armed && incomingArmId > 0 && incomingArmId <= consumedArmId) {
      config = {
        ...config,
        ...next,
        armed: false,
        armId: incomingArmId,
        // Keep previously armed response body if stale update omitted it.
        responseBody:
          typeof next.responseBody === "string"
            ? next.responseBody
            : config.responseBody,
      };
      syncHooks();
      return;
    }

    config = {
      ...config,
      ...next,
      armId: incomingArmId,
      responseBody:
        typeof next.responseBody === "string"
          ? next.responseBody
          : config.responseBody || "",
    };
    window.__MRE_STATE = { ...config };
    syncHooks();
  }

  function readConfigFromWindow() {
    try {
      if (window.__MRE_STATE && typeof window.__MRE_STATE === "object") {
        applyConfig(window.__MRE_STATE);
      }
    } catch {
      // ignore
    }
  }

  function matchesSelected(url, method) {
    const selected = (config.selectedUrl || "").trim();
    if (!selected) return null;

    const selectedMethod = (config.selectedMethod || "").trim().toUpperCase();
    if (selectedMethod && method && selectedMethod !== String(method).toUpperCase()) {
      return false;
    }

    try {
      const actual = new URL(String(url), location.href);
      const target = new URL(selected, location.href);
      // Match origin + path; allow query-string differences.
      return (
        actual.origin === target.origin && actual.pathname === target.pathname
      );
    } catch {
      return String(url) === selected || String(url).includes(selected);
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

  function shouldIntercept(url, method) {
    readConfigFromWindow();
    if (!config.armed) return false;
    if (isNoise(url)) return false;

    const selectedMatch = matchesSelected(url, method);
    if (selectedMatch !== null) return selectedMatch;

    return matchesFilter(String(url));
  }

  function normalizeStatus(code) {
    const n = Number(code);
    if (!Number.isFinite(n)) return 500;
    return Math.min(599, Math.max(200, Math.round(n)));
  }

  function sanitizeStatusText(text) {
    // Response statusText must be a ByteString (latin1).
    return String(text || "")
      .replace(/[^\x20-\x7E]/g, "")
      .slice(0, 100);
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

  function buildMock() {
    const status = normalizeStatus(config.statusCode);
    const statusText = sanitizeStatusText(
      (config.message || "").trim() || defaultStatusText(status)
    );
    const customBody =
      typeof config.responseBody === "string" ? config.responseBody : "";
    const noBody = status === 204 || status === 205 || status === 304;

    let body = null;
    if (!noBody) {
      if (customBody.length > 0) {
        body = customBody;
      } else {
        body = JSON.stringify({
          error: status >= 400,
          status,
          message: statusText || defaultStatusText(status),
        });
      }
    }

    const contentType = detectContentType(
      body === null ? "" : body,
      config.contentType
    );

    return { status, statusText, contentType, body };
  }

  function notifyIntercepted(url, method, armId, mock, continuous) {
    window.postMessage(
      {
        source: "mock-request-error-page",
        type: "INTERCEPTED",
        payload: {
          url: String(url),
          method: method || "GET",
          armId: armId || 0,
          statusCode: mock?.status,
          contentType: mock?.contentType,
          continuous: !!continuous,
        },
      },
      "*"
    );
  }

  function disarmAndRestore(armId) {
    consumedArmId = Math.max(consumedArmId, Number(armId) || config.armId || 0);
    config = { ...config, armed: false };
    window.__MRE_STATE = { ...config, armed: false };
    syncHooks();
  }

  function afterIntercept(armId, url, method, mock) {
    const continuous = !!config.continuous;
    notifyIntercepted(url, method, armId, mock, continuous);
    if (!continuous) {
      disarmAndRestore(armId);
    }
    // Continuous: keep hooks + armed until user presses Stop.
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
        // ignore
      }
    }
    xhr.__mrePatchedFields = null;
    xhr.__mreIntercepted = false;
  }

  function mockedFetch(input, init) {
    const url = resolveUrl(input);
    const method = resolveMethod(input, init);

    if (!shouldIntercept(url, method)) {
      return originalFetch(input, init);
    }

    const armId = config.armId;
    let mock;
    try {
      mock = buildMock();
    } catch (err) {
      if (!config.continuous) disarmAndRestore(armId);
      return Promise.reject(err);
    }

    afterIntercept(armId, url, method, mock);

    try {
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
    } catch (err) {
      return Promise.reject(err);
    }
  }

  function mockedOpen(method, url, ...rest) {
    clearXhrOverrides(this);
    this.__mreMethod = method;
    this.__mreUrl = url;
    this.__mreIntercepted = false;
    return originalOpen.call(this, method, url, ...rest);
  }

  function mockedSend(...args) {
    const url = this.__mreUrl;
    const method = this.__mreMethod || "GET";

    if (!shouldIntercept(url, method)) {
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

    afterIntercept(armId, url, method, mock);

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

  window.addEventListener("__mre_config", (event) => {
    if (event?.detail) applyConfig(event.detail);
  });

  uninstallHooks();
  readConfigFromWindow();
  syncHooks();

  window.postMessage({ source: "mock-request-error-page", type: "READY" }, "*");
})();
