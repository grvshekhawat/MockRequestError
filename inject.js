(function () {
  if (window.__mockRequestErrorInstalled) return;
  window.__mockRequestErrorInstalled = true;

  const ATTR = "data-mre-config";

  let config = {
    armed: false,
    statusCode: 500,
    message: "Internal Server Error",
    urlFilter: "",
  };

  function readConfigFromDom() {
    try {
      const raw = document.documentElement?.getAttribute(ATTR);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        config = { ...config, ...parsed };
      }
    } catch {
      // ignore bad JSON
    }
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    if (!event.data || event.data.source !== "mock-request-error") return;
    if (event.data.type === "CONFIG" && event.data.payload) {
      config = { ...config, ...event.data.payload };
    }
  });

  // Ask the isolated content script for the latest config.
  window.postMessage({ source: "mock-request-error-page", type: "READY" }, "*");

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
    readConfigFromDom();
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

  function notifyIntercepted(url, method) {
    window.postMessage(
      {
        source: "mock-request-error-page",
        type: "INTERCEPTED",
        payload: { url: String(url), method: method || "GET" },
      },
      "*"
    );
  }

  function disarmLocally() {
    config = { ...config, armed: false };
    try {
      document.documentElement?.setAttribute(
        ATTR,
        JSON.stringify({ ...config, armed: false })
      );
    } catch {
      // ignore
    }
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

  const originalFetch = window.fetch.bind(window);
  window.fetch = function mockedFetch(input, init) {
    const url = resolveUrl(input);
    const method = resolveMethod(input, init);

    if (!shouldIntercept(url)) {
      return originalFetch(input, init);
    }

    const status = Number(config.statusCode) || 500;
    const statusText = config.message || "Error";
    const body = buildBody(status, statusText);
    disarmLocally();
    notifyIntercepted(url, method);

    return Promise.resolve(
      new Response(body, {
        status,
        statusText,
        headers: {
          "Content-Type": "application/json",
          "X-Mock-Request-Error": "1",
        },
      })
    );
  };

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__mreMethod = method;
    this.__mreUrl = url;
    return originalOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function (...args) {
    const url = this.__mreUrl;
    const method = this.__mreMethod || "GET";

    if (!shouldIntercept(url)) {
      return originalSend.apply(this, args);
    }

    const status = Number(config.statusCode) || 500;
    const statusText = config.message || "Error";
    const body = buildBody(status, statusText);
    disarmLocally();
    notifyIntercepted(url, method);

    const xhr = this;
    queueMicrotask(() => {
      try {
        Object.defineProperty(xhr, "readyState", { configurable: true, get: () => 4 });
        Object.defineProperty(xhr, "status", { configurable: true, get: () => status });
        Object.defineProperty(xhr, "statusText", {
          configurable: true,
          get: () => statusText,
        });
        Object.defineProperty(xhr, "responseText", {
          configurable: true,
          get: () => body,
        });
        Object.defineProperty(xhr, "response", {
          configurable: true,
          get: () => body,
        });
      } catch {
        // Some browsers lock these; still fire events best-effort.
      }

      xhr.dispatchEvent(new Event("readystatechange"));
      xhr.dispatchEvent(new Event("load"));
      xhr.dispatchEvent(new Event("loadend"));
    });
  };
})();
