---
name: web-search
description: Free, keyless web search via Google (default) and DuckDuckGo (fallback). One tool, two engines, sequential, with rate-limit handling. Google gives richer snippets with embedded freshness stamps like "2 hours ago"; DDG is the high-volume fallback. On rate-limit block returns a `blocked` flag plus the URL and remaining queries so the agent can decide how to recover (switch engines, wait, or open the iframe).
---

# web-search

Free, keyless web search via **Google** (default) and **DuckDuckGo** (fallback). No API key, no cost — but rate-limited per fingerprint. Good for agent lookups where freshness matters.

## Tool: `web_search`

One tool, two engines. Google is the default — richer snippets, embedded freshness stamps ("2 hours ago"), better ranking for current events. DDG is the fallback when Google is rate-limited or when you need to burn through many low-priority queries fast.

### Quick start

```js
// queries MUST be an array of strings — even for a single search.
web_search({ queries: ["servicenow flow designer best practices"] })
```

> ⚠️ **`queries` must be a list/array, not a plain string.** Passing a bare string (`queries: "..."`) fails silently / returns nothing. Always wrap it: `queries: ["..."]`.

### Input

- `queries`: string[] — run sequentially. **Required, must be an array** (wrap single queries too).
- `engine`: `"google"` (default) or `"ddg"`.
- `max_results_per_query`: optional, default 10.
- `sleep_ms`: optional. Defaults to **5000 for Google**, **2000 for DDG**. Lower at your own risk.

### Output (success)

```js
{
  engine: "google",
  completed: 3,
  total_requested: 3,
  results: [
    {
      query: "...",
      status: 200,
      results: [
        { title, url, snippet, freshness: "2 days ago" | "May 21, 2026" | null },
        ...
      ]
    },
    ...
  ]
}
```

### Output (when blocked — adds these fields)

```js
{
  ...,
  blocked: true,
  blocked_at: 2,                                          // index of failed query
  blocked_url: "https://www.google.com/search?q=…&udm=14&hl=en",
  remaining: [ "query that failed", "next…", ... ]        // pass back on retry
}
```

The `blocked` family of fields is **only present when a block was hit.** A successful run does not include them.

## Engine behavior

### Google (default)

- Endpoint: `GET https://www.google.com/search?q=…&udm=14&hl=en`
- **`udm=14` is critical.** It's Google's "Web only" mode — strips the AI Overview and returns the classic, parseable 10-blue-link SERP. Without `udm=14`, the response is 470 KB of JS with only 2 `<h3>` tags. With it, it's 320 KB with the full 10 results.
- **5-second spacing is the sustainable rate** (tested: 37 consecutive clean queries at 5 s; ~20 clean queries at 2.5 s before block).
- **Block signal:** `HTTP 200` + `body.length < 150 KB` + `0 <h3> tags`. This is the JS-required interstitial Google serves when it suspects scraping.
  - **NOT** a 202, **NOT** a `/sorry/` redirect.
  - The string `/httpservice/retry/enablejs` appears in **every** Google page (it's the noscript fallback) — never use it as a block signal. (Wasted an hour learning this the hard way.)
- **Recovery: ~2 minutes, automatic, no CAPTCHA.** Block is per-fingerprint, not per-IP — a real Chrome session (the iframe panel) is unaffected and can be used for one-off queries while web_fetch cools down.
- **Parser:** pairs `<a href="..."><h3>...</h3>` anchors with the nearest snippet div within ~5000 chars. Snippet div classes rotate; current set: `VwiC3b`, `yXK7lf`, `GI74Re`, `MUxGbd`, `s8bAkb`, `Hdw6tb`, `lEBKkf`, `kvH3mc`. If results start coming back empty despite no block, add the new class name here.
- **Snippet cleanup:** trailing `"Read more"` (the rendered expand-button text that bleeds into `stripTags` output) is replaced with `"..."` so the snippet reads naturally.
- Unwraps `/url?q=…` redirector when present (Google now often links direct).
- Filters out `google.com`, `maps.google.com`, `policies.google.com`, `support.google.com`, `accounts.google.com`, and ad domains.

### DuckDuckGo (fallback)

- Endpoint: `POST https://html.duckduckgo.com/html/` with form body `q=…&b=&kl=wt-wt&df=`.
- **2-second spacing.** 30+ queries clean in testing. Lower spacing trips the bot challenge within ~5 queries.
- **Block signal:** `HTTP 202` (DDG uses 202, not 429).
- **Recovery:** user must solve the duck CAPTCHA in a real browser on the same IP. Or change IP. Cooldown was historically ~1 hour.
- **Parser:** pairs `result__a` (title + href) with `result__snippet` by index. Unwraps `uddg=` redirector. Filters out `y.js` ad URLs.
- **Headers:** only `Content-Type` is set. `web_fetch` runs in the user's real browser; the browser handles UA / Origin / Sec-Fetch-* naturally (and several are forbidden header names `fetch()` would silently strip).

## Freshness extraction

Both engines populate `freshness` on each result by regex-matching the snippet text. Patterns, in order:

1. `"N minutes/hours/days/weeks/months/years ago"` (common on Google, rare on DDG)
2. `"today"` / `"yesterday"`
3. `"May 21, 2026"` (month + day + year)

Google embeds freshness stamps in ~all news / recent results — that's the main reason it's the default. DDG snippets rarely carry any.

## When the response says `blocked: true`

The tool does **NOT** touch the iframe. **The agent decides what to do.** Typical options:

1. **Switch engines.** If Google is blocked, retry with `engine: "ddg"` (or vice versa). Different fingerprints, independent block state. Usually the fastest recovery.
2. **Wait.** Google clears in ~2 min automatically. Sleep then re-invoke with `queries: <response>.remaining`.
3. **Open the URL in the iframe panel** (heavyweight — only when the user needs a specific result *now*):
   ```
   iframe_tool { action: "navigate", url: <blocked_url>, wait: true }
   ```
   For Google: the iframe runs on a different fingerprint so it usually shows real results. The agent can `get_visible_text` and parse manually as a one-off, then ideally re-invoke `web_search` after the cooldown.
   For DDG: ask the user to solve the duck CAPTCHA (`prompt_user`), then re-invoke with `queries: remaining`.

The skill never decides for the agent — it just surfaces `blocked_url` + `remaining` so the agent has everything it needs.

## Why these choices

- **Google `udm=14`** — the "Web only" tab that the AI-Overview opt-out community publicized in mid-2024. Static, parseable, no AI summary, no JS rendering required. Closest thing Google has to a no-API SERP endpoint.
- **DDG `html.duckduckgo.com/html/` POST** — canonical no-JS form endpoint. ~15% smaller than the GET redirect, less likely to trip bot detection.
- **5 s / 2 s spacing** — empirically the lowest reliably safe rates. Tested with 60-query stress runs.
- **No `vqd` token / pagination** — only needed for page 2+. Single-page queries don't need it.
- **No cookies / session** — DDG doesn't use sessions; the bot blocker is per-IP. Google's blocker is per-fingerprint (UA + headers + IP combo), and since `web_fetch` already runs in the user's real browser, cookies happen automatically.

## Hard limits and gotchas

- **DDG per-query length:** 499 chars max (DDG returns nothing above; tool rejects with `error`).
- **Google per-query length:** ~2 KB (URL limit, generous).
- **Block release timing:** Google ~2 min, DDG ~5 min – 1 h (variable).
- **No pagination.** Page 1 only. Adding pagination would need `&start=10` for Google, `vqd` token for DDG.
- **HTML structure can change.** If a 200 returns empty results, the parser regexes may need updating — add the new snippet div class to the Google list, or check DDG hasn't renamed `result__snippet`.

## When not to use

- **Sustained high volume** (>12 queries / min on Google, >30 / min on DDG).
- **Enterprise / production** — no SLA, ToS-grey, breakable. Use SerpAPI / Brave / Tavily / Google Programmable Search Engine with an API key instead.
- **Pagination** — page 1 only.
