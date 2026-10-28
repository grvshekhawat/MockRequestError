# Mock Request Error

Chrome extension that arms once, then intercepts the **next** `fetch` / `XMLHttpRequest` and returns a custom HTTP error.

## Install (unpacked)

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select this folder

## Usage

1. Open the extension popup
2. Set an **error code** (e.g. `500`) and optional **message**
3. Optionally set a **URL filter** (substring or regex) so only matching requests are mocked
4. Click **Intercept next request** (badge shows `ON`)
5. On the page, trigger the action (e.g. Send message)
6. That request gets a mocked error response and the arm turns off

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
