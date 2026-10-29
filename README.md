# Mock Request Error

Chrome extension that intercepts network requests and returns a custom HTTP status + body.

## Why v2 uses the debugger

Patching page `fetch` only works on simple pages. Many real apps (and internal tools) use bundled clients, service workers, or capture `fetch` early — so page hooks miss the request.

v2 intercepts at Chrome’s **network layer** via `chrome.debugger` / CDP `Fetch`. That works for normal XHR/fetch traffic on real sites.

While armed, Chrome may show: **“Mock Request Error started debugging this browser”**. Press **Stop interception** to clear it.

## Install

1. `chrome://extensions`
2. Enable **Developer mode**
3. **Load unpacked** → this folder
4. After updates, click **Reload** on the extension card
5. **Hard-reload every open tab** you test (`Cmd+Shift+R`) — otherwise you can see `Extension context invalidated` from old scripts

## Usage

1. Open the site tab you care about
2. Trigger the API once (so it appears under **Select API**), or type a URL filter
3. Set status code / optional response body
4. Click **Intercept next request** (badge `ON`)
5. Trigger the action again
6. Click **Stop interception** when done

### Modes

- **One-shot (default):** mocks the next matching XHR/Fetch, then stops
- **Continuous:** keeps mocking matches until Stop
- **No filter / no selection:** mocks the next XHR or Fetch only (not images/navigation)

## Tips

- Close DevTools on that tab if attach fails (“already attached”)
- Prefer selecting the API from the list for internal apps
- `fetch` does not throw on HTTP 4xx/5xx — apps check `response.status` / `response.ok`
