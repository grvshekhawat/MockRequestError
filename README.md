# Mock Request Error

Chrome extension that arms once, then intercepts the **next** `fetch` / `XMLHttpRequest` and returns a custom HTTP error.

## Install (unpacked)

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select this folder

## Usage

1. At `chrome://extensions`, click **Reload** on this extension after updates
2. **Reload the tab** you are testing
3. On the page, trigger the API once normally (so it appears in the list)
4. Open the popup → **Select API** → click the request you want
5. Set status code / optional response body
6. Click **Intercept next request** (badge shows `ON`)
7. Trigger that same action again — only that API is mocked

You can still type a manual URL filter as a fallback if the request isn’t listed yet.

**Note:** `fetch` does not throw on HTTP 4xx/5xx — it resolves with `response.ok === false`. Apps must check the status; the real network call is skipped when intercept works.

## How it works

A content script injects page-level hooks for `window.fetch` and `XMLHttpRequest`. When armed, the next matching request never hits the network; the page receives a JSON body like:

```json
{
  "error": true,
  "status": 500,
  "message": "Internal Server Error"
}
```

## Notes

- Works for same-page `fetch` / XHR (typical SPA APIs). It does not rewrite requests from service workers or `<img>` / navigation loads.
- After one intercept, re-arm to catch another request.
- Reload the tab after installing so the inject script is present.
