(function () {
  if (window.__mockRequestErrorInstalled) return;
  window.__mockRequestErrorInstalled = true;

  let config = {
    armed: false,
    statusCode: 500,
    message: "Internal Server Error",
    urlFilter: "",
  };

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    if (!event.data || event.data.source !== "mock-request-error") return;

    if (event.data.type === "CONFIG") {
      config = { ...config, ...event.data.payload };
    }
  });

  function matchesFilter(url) {
    const filter = (config.urlFilter || "").trim();
    if (!filter) return true;
    try {
      return new RegExp(filter, "i").test(url);
    } catch {
      return url.toLowerCase().includes(filter.toLowerCase());
    }
  }

  function shouldIntercept(url) {
    return config.armed && matchesFilter(String(url));
  }

  function buildBody() {
    const message = config.message || "";
    try {
      return JSON.stringify({
        error: true,
        status: config.statusCode,
        message,
      });
    } catch {
      return message || `Error ${config.statusCode}`;
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
  }

  const originalFetch = window.fetch.bind(window);
  window.fetch = async function mockedFetch(input, init) {
    const url =
      typeof input === "string"
        ? input
        : input instanceof Request
          ? input.url
          : String(input);
    const method =
      (init && init.method) ||
      (input instanceof Request && input.method) ||
      "GET";

    if (!shouldIntercept(url)) {
      return originalFetch(input, init);
    }

    const status = Number(config.statusCode) || 500;
    const statusText = config.message || "Error";
    const body = buildBody();
    disarmLocally();
    notifyIntercepted(url, method);

    return new Response(body, {
      status,
      statusText,
      headers: {
        "Content-Type": "application/json",
        "X-Mock-Request-Error": "1",
      },
    });
  };

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__mockMethod = method;
    this.__mockUrl = url;
    return originalOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function (...args) {
    const url = this.__mockUrl;
    const method = this.__mockMethod || "GET";

    if (!shouldIntercept(url)) {
      return originalSend.apply(this, args);
    }

    const status = Number(config.statusCode) || 500;
    const statusText = config.message || "Error";
    const body = buildBody();
    disarmLocally();
    notifyIntercepted(url, method);

    const xhr = this;

    queueMicrotask(() => {
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

      xhr.dispatchEvent(new Event("readystatechange"));
      xhr.dispatchEvent(new Event("load"));
      xhr.dispatchEvent(new Event("loadend"));
    });
  };
})();
