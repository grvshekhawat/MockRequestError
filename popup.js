const statusCodeEl = document.getElementById("statusCode");
const messageEl = document.getElementById("message");
const contentTypeEl = document.getElementById("contentType");
const responseBodyEl = document.getElementById("responseBody");
const urlFilterEl = document.getElementById("urlFilter");
const form = document.getElementById("form");
const armBtn = document.getElementById("armBtn");
const disarmBtn = document.getElementById("disarmBtn");
const statusEl = document.getElementById("status");
const lastEl = document.getElementById("last");
const lastDetailsEl = document.getElementById("lastDetails");

function clampStatusCode(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 500;
  return Math.min(599, Math.max(200, Math.round(n)));
}

function render(state) {
  statusCodeEl.value = state.statusCode ?? 500;
  messageEl.value = state.message ?? "";
  contentTypeEl.value = state.contentType || "application/json";
  responseBodyEl.value = state.responseBody ?? "";
  urlFilterEl.value = state.urlFilter ?? "";

  if (state.armed) {
    armBtn.textContent = "Armed — waiting for next request";
    armBtn.classList.add("armed");
    disarmBtn.disabled = false;
    statusEl.className = "status armed";
    statusEl.textContent =
      "Armed. Trigger the action on the page. The next matching request gets your status + body.";
  } else {
    armBtn.textContent = "Intercept next request";
    armBtn.classList.remove("armed");
    disarmBtn.disabled = true;
    statusEl.className = "status idle";
    statusEl.textContent =
      "Idle — set status/body, then arm to intercept the next matching request.";
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
    contentType: contentTypeEl.value || "application/json",
    responseBody: responseBodyEl.value,
    urlFilter: urlFilterEl.value.trim(),
  };
}

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

chrome.runtime.sendMessage({ type: "GET_STATE" }, (state) => {
  if (state) render(state);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "session" && changes.interceptState) {
    render(changes.interceptState.newValue);
  }
});
