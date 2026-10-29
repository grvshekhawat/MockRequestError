const statusCodeEl = document.getElementById("statusCode");
const messageEl = document.getElementById("message");
const contentTypeEl = document.getElementById("contentType");
const responseBodyEl = document.getElementById("responseBody");
const urlFilterEl = document.getElementById("urlFilter");
const continuousEl = document.getElementById("continuous");
const form = document.getElementById("form");
const armBtn = document.getElementById("armBtn");
const disarmBtn = document.getElementById("disarmBtn");
const statusEl = document.getElementById("status");
const lastEl = document.getElementById("last");
const lastDetailsEl = document.getElementById("lastDetails");
const requestListEl = document.getElementById("requestList");
const selectedApiEl = document.getElementById("selectedApi");
const refreshRequestsBtn = document.getElementById("refreshRequests");
const clearRequestsBtn = document.getElementById("clearRequests");

let selectedUrl = "";
let selectedMethod = "";

function clampStatusCode(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 500;
  return Math.min(599, Math.max(200, Math.round(n)));
}

function shortUrl(url) {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    return url;
  }
}

function renderSelectedApi() {
  if (!selectedUrl) {
    selectedApiEl.hidden = true;
    selectedApiEl.textContent = "";
    return;
  }
  selectedApiEl.hidden = false;
  selectedApiEl.innerHTML = "";

  const label = document.createElement("div");
  label.className = "selected-label";
  label.textContent = "Selected";

  const value = document.createElement("code");
  value.textContent = `${selectedMethod || "*"} ${shortUrl(selectedUrl)}`;

  const clearBtn = document.createElement("button");
  clearBtn.type = "button";
  clearBtn.className = "linkish";
  clearBtn.textContent = "Clear";
  clearBtn.addEventListener("click", () => {
    selectedUrl = "";
    selectedMethod = "";
    urlFilterEl.value = "";
    renderSelectedApi();
    renderRequestList(lastRequests);
  });

  selectedApiEl.append(label, value, clearBtn);
}

let lastRequests = [];

function renderRequestList(requests) {
  lastRequests = requests || [];
  requestListEl.innerHTML = "";

  if (!lastRequests.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "No API requests captured yet for this tab.";
    requestListEl.appendChild(empty);
    return;
  }

  for (const req of lastRequests) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "request-item";
    if (selectedUrl === req.url && selectedMethod === req.method) {
      btn.classList.add("active");
    }

    const method = document.createElement("span");
    method.className = "method";
    method.textContent = req.method;

    const path = document.createElement("span");
    path.className = "path";
    path.textContent = req.path || shortUrl(req.url);
    path.title = req.url;

    btn.append(method, path);
    btn.addEventListener("click", () => {
      selectedUrl = req.url;
      selectedMethod = req.method;
      // Keep a readable fallback filter too.
      try {
        urlFilterEl.value = new URL(req.url).pathname;
      } catch {
        urlFilterEl.value = req.path || req.url;
      }
      renderSelectedApi();
      renderRequestList(lastRequests);
    });

    requestListEl.appendChild(btn);
  }
}

function loadRecentRequests() {
  chrome.runtime.sendMessage({ type: "GET_RECENT_REQUESTS" }, (result) => {
    if (chrome.runtime.lastError || !result) {
      renderRequestList([]);
      return;
    }
    renderRequestList(result.requests || []);
  });
}

function render(state) {
  statusCodeEl.value = state.statusCode ?? 500;
  messageEl.value = state.message ?? "";
  contentTypeEl.value = state.contentType || "auto";
  responseBodyEl.value = state.responseBody ?? "";
  urlFilterEl.value = state.urlFilter ?? "";
  continuousEl.checked = !!state.continuous;
  selectedUrl = state.selectedUrl || "";
  selectedMethod = state.selectedMethod || "";
  renderSelectedApi();

  if (state.armed) {
    armBtn.textContent = state.continuous
      ? "Armed — continuous"
      : "Armed — waiting for next request";
    armBtn.classList.add("armed");
    disarmBtn.disabled = false;
    statusEl.className = "status armed";
    if (state.continuous) {
      statusEl.textContent = selectedUrl
        ? `Continuous: mocking ${selectedMethod || ""} ${shortUrl(selectedUrl)} until Stop.`
        : "Continuous: mocking matching requests until you press Stop.";
    } else {
      statusEl.textContent = selectedUrl
        ? `Armed for ${selectedMethod || ""} ${shortUrl(selectedUrl)}. Trigger that action on the page.`
        : "Armed. Trigger the action on the page. The next matching request gets your status + body.";
    }
  } else {
    armBtn.textContent = continuousEl.checked
      ? "Start continuous intercept"
      : "Intercept next request";
    armBtn.classList.remove("armed");
    disarmBtn.disabled = true;
    statusEl.className = "status idle";
    statusEl.textContent =
      "Idle — select an API or set a filter (optional), then arm.";
  }

  if (state.lastIntercept) {
    lastEl.hidden = false;
    const hit = state.lastIntercept;
    lastDetailsEl.textContent = [
      `${hit.method} ${hit.url}`,
      `→ ${hit.statusCode}${hit.message ? ` ${hit.message}` : ""}`,
      hit.contentType ? `Content-Type: ${hit.contentType}` : null,
      new Date(hit.at).toLocaleString(),
    ]
      .filter(Boolean)
      .join("\n");
    if (!state.armed) {
      statusEl.className = "status hit";
      statusEl.textContent = "Last request was intercepted. Arm again to catch another.";
    }
  } else {
    lastEl.hidden = true;
  }
}

function readFormState(armed) {
  return {
    armed: !!armed,
    statusCode: clampStatusCode(statusCodeEl.value),
    message: messageEl.value.trim(),
    contentType: contentTypeEl.value || "auto",
    responseBody: responseBodyEl.value,
    urlFilter: urlFilterEl.value.trim(),
    continuous: !!continuousEl.checked,
    selectedUrl,
    selectedMethod,
  };
}

continuousEl.addEventListener("change", () => {
  if (!disarmBtn.disabled) return;
  armBtn.textContent = continuousEl.checked
    ? "Start continuous intercept"
    : "Intercept next request";
});

function setState(partial) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "GET_STATE" }, (current) => {
      const next = { ...current, ...partial };
      chrome.runtime.sendMessage({ type: "SET_STATE", state: next }, () => {
        render(next);
        resolve(next);
      });
    });
  });
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const current = await new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "GET_STATE" }, resolve);
  });

  await setState({
    ...readFormState(true),
    lastIntercept: current?.lastIntercept || null,
  });
});

disarmBtn.addEventListener("click", async () => {
  const current = await new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "GET_STATE" }, resolve);
  });
  await setState({
    ...readFormState(false),
    lastIntercept: current?.lastIntercept || null,
  });
});

document.querySelectorAll("#presets button").forEach((btn) => {
  btn.addEventListener("click", () => {
    statusCodeEl.value = btn.dataset.code;
    messageEl.value = btn.dataset.msg || "";
  });
});

refreshRequestsBtn.addEventListener("click", loadRecentRequests);

clearRequestsBtn.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "CLEAR_RECENT_REQUESTS" }, () => {
    renderRequestList([]);
  });
});

chrome.runtime.sendMessage({ type: "GET_STATE" }, (state) => {
  if (state) render(state);
  loadRecentRequests();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "session" && changes.interceptState) {
    render(changes.interceptState.newValue);
  }
});
