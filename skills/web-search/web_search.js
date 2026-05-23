// web-search :: web_search
// One tool, two engines. Google is the default — richer snippets, embedded
// freshness stamps ("2 hours ago"), better current-events ranking. DDG is the
// fallback when Google is rate-limited or for high-volume background lookups.
//
// The tool does NOT touch the iframe. On block it returns { blocked: true,
// blocked_url, remaining } and the agent decides what to do (open the iframe,
// prompt the user, switch engines, etc.). Recovery policy lives in the agent,
// not the skill.

var TOOL_DEFINITION = {
  type: "function",
  function: {
    name: "web_search",
    description: "Search the web. Default engine is Google (udm=14 \"Web only\" mode, classic 10-blue-link SERP, with freshness stamps like \"2 hours ago\" / \"May 21, 2026\" embedded in snippets). Pass engine='ddg' as a fallback when Google is rate-limited, or for high-volume queries (DDG is more permissive). Sequential, with engine-appropriate spacing (default 5s for Google, 2s for DDG). On rate-limit block returns { blocked: true, blocked_url, remaining } \u2014 the AGENT decides recovery (navigate iframe, prompt user, switch engines, wait, etc.); this tool never touches the iframe.",
    parameters: {
      type: "object",
      properties: {
        queries: {
          type: "array",
          items: { type: "string" },
          description: "Search queries, run sequentially in order. DDG hard limit: 499 chars per query."
        },
        engine: {
          type: "string",
          enum: ["google", "ddg"],
          description: "Default 'google'. Use 'ddg' as fallback or for bulk."
        },
        max_results_per_query: {
          type: "number",
          description: "Max results per query. Default 10."
        },
        sleep_ms: {
          type: "number",
          description: "Spacing between queries in ms. Defaults: 5000 (google), 2000 (ddg). Lower at your own risk."
        }
      },
      required: ["queries"]
    }
  }
};

var GOOGLE_URL = "https://www.google.com/search";
var DDG_URL = "https://html.duckduckgo.com/html/";
var DDG_VISIBLE = "https://duckduckgo.com/html/?q=";
var DDG_MAX_QUERY_LEN = 499;

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

function decodeEntities(s) {
  if (!s) return "";
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, function (_, n) { return String.fromCharCode(parseInt(n, 10)); })
    .replace(/&#x([0-9a-fA-F]+);/g, function (_, n) { return String.fromCharCode(parseInt(n, 16)); });
}

function stripTags(html) {
  return decodeEntities((html || "").replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();
}

// Strip trailing UI cruft that bleeds into stripTags output. Google's
// snippet div contains an expand button labelled "Read more" with no
// surrounding whitespace, which becomes part of the plain-text snippet.
// Replace it with an ellipsis so the snippet reads naturally.
function cleanSnippetTail(text) {
  if (!text) return text;
  return text.replace(/\s*Read more\s*$/i, "...");
}

// ---------- Freshness extraction ----------
// Google embeds date stamps directly in snippet text. Extract the first signal
// we recognise; return null if none.
var MONTHS = "Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|January|February|March|April|June|July|August|September|October|November|December";

function extractFreshness(text) {
  if (!text) return null;
  // "2 hours ago", "5 days ago", "1 week ago", "30 minutes ago"
  var m = text.match(/(\d+)\s+(minute|hour|day|week|month|year)s?\s+ago/i);
  if (m) return m[0].toLowerCase();
  // "today" / "yesterday"
  m = text.match(/\b(today|yesterday)\b/i);
  if (m) return m[0].toLowerCase();
  // "May 21, 2026" / "May 21 2026" / "Jan 5, 2025"
  m = text.match(new RegExp("(?:" + MONTHS + ")\\s+\\d{1,2},?\\s+\\d{4}", "i"));
  if (m) return m[0];
  return null;
}

// ---------- Google ----------
function unwrapGoogleUrl(href) {
  if (!href) return "";
  if (href.indexOf("/url?") === 0) {
    var qm = href.match(/[?&]q=([^&]+)/);
    if (qm) {
      try { return decodeURIComponent(qm[1]); } catch (e) { return qm[1]; }
    }
  }
  if (href.indexOf("//") === 0) return "https:" + href;
  return href;
}

function isGoogleInternalUrl(url) {
  if (!url) return true;
  return /^https?:\/\/(?:www\.|maps\.|policies\.|support\.|accounts\.|translate\.|webcache\.)?google\.[a-z.]+/i.test(url) ||
         /^https?:\/\/(?:webcache\.googleusercontent\.com|googleadservices\.com|googleusercontent\.com)/i.test(url);
}

// Parse Google's udm=14 static HTML.
// Strategy: pair each <a href="..."><h3>TITLE</h3> anchor with the nearest
// snippet div following it (within ~5000 chars). Snippet div class names
// rotate; we match a known set.
function parseGoogle(html, max) {
  if (!html) return [];
  var anchorRe = /<a\b[^>]*href="([^"]+)"[^>]*>(?:[^<]|<(?!\/a>))*?<h3[^>]*>([\s\S]*?)<\/h3>/g;
  var anchors = [];
  var m;
  while ((m = anchorRe.exec(html)) !== null) {
    var url = unwrapGoogleUrl(m[1]);
    if (isGoogleInternalUrl(url)) continue;
    if (!/^https?:\/\//.test(url)) continue;
    var title = stripTags(m[2]);
    if (!title) continue;
    anchors.push({ title: title, url: url, idx: m.index });
    if (anchors.length >= 30) break;
  }
  // Snippet div class names (observed on Google in 2025-2026, rotating set).
  // If results stop appearing despite no block, add the new class name here.
  var snipRe = /<div\b[^>]*class="[^"]*(?:VwiC3b|yXK7lf|GI74Re|MUxGbd|s8bAkb|Hdw6tb|lEBKkf|kvH3mc)[^"]*"[^>]*>([\s\S]*?)<\/div>/g;
  var snippets = [];
  while ((m = snipRe.exec(html)) !== null) {
    var text = stripTags(m[1]);
    if (text.length > 20) snippets.push({ text: text, idx: m.index });
    if (snippets.length >= 50) break;
  }
  var out = [];
  for (var i = 0; i < anchors.length && out.length < max; i++) {
    var a = anchors[i];
    var snippet = "";
    for (var j = 0; j < snippets.length; j++) {
      if (snippets[j].idx > a.idx && snippets[j].idx - a.idx < 5000) {
        snippet = cleanSnippetTail(snippets[j].text).slice(0, 400);
        break;
      }
    }
    out.push({
      title: a.title,
      url: a.url,
      snippet: snippet,
      freshness: extractFreshness(snippet)
    });
  }
  return out;
}

// Google's soft block returns an HTTP 200 with a tiny "JavaScript required"
// interstitial (~90 KB) and ZERO <h3> tags. Real result pages are ~300 KB with
// 10 h3 tags. The interstitial contains the URL "/httpservice/retry/enablejs"
// AND so does every normal Google page (it's the noscript fallback) \u2014 do NOT
// use that string as a block signal. Use size + h3 count.
function googleBlocked(body) {
  if (!body) return true;
  var h3Count = (body.match(/<h3/g) || []).length;
  return body.length < 150000 && h3Count === 0;
}

async function googleSearch(queries, maxR, sleepMs) {
  var headers = {
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9"
  };
  var perQuery = [];
  var blockedAt = null;
  var blockedQuery = null;

  for (var i = 0; i < queries.length; i++) {
    var q = queries[i];

    if (typeof q !== "string" || !q.trim()) {
      perQuery.push({ query: String(q), status: null, results: [], error: "empty query" });
      continue;
    }

    var url = GOOGLE_URL + "?q=" + encodeURIComponent(q) + "&udm=14&hl=en";
    var res;
    try {
      res = await executeTool("web_fetch", { url: url, method: "GET", headers: headers });
    } catch (e) {
      perQuery.push({ query: q, status: null, results: [], error: "fetch failed: " + String(e) });
      blockedAt = i;
      blockedQuery = q;
      break;
    }

    if (!res || res.status !== 200) {
      perQuery.push({
        query: q,
        status: res ? res.status : null,
        results: [],
        error: "unexpected HTTP status"
      });
      blockedAt = i;
      blockedQuery = q;
      break;
    }

    var body = res.body || "";
    if (googleBlocked(body)) {
      perQuery.push({
        query: q,
        status: 200,
        results: [],
        error: "Google soft-block (h3=0, body<150KB) \u2014 likely fingerprint rate-limit"
      });
      blockedAt = i;
      blockedQuery = q;
      break;
    }

    var results = parseGoogle(body, maxR);
    perQuery.push({ query: q, status: 200, results: results });

    if (i < queries.length - 1) await sleep(sleepMs);
  }

  var out = {
    engine: "google",
    completed: perQuery.filter(function (p) { return p.status === 200 && !p.error; }).length,
    total_requested: queries.length,
    results: perQuery
  };

  if (blockedAt !== null) {
    out.blocked = true;
    out.blocked_at = blockedAt;
    out.blocked_url = GOOGLE_URL + "?q=" + encodeURIComponent(blockedQuery) + "&udm=14&hl=en";
    out.remaining = queries.slice(blockedAt);
  }

  return out;
}

// ---------- DuckDuckGo ----------
function unwrapDdgUrl(href) {
  if (!href) return "";
  var m = href.match(/[?&]uddg=([^&"]+)/);
  if (m) {
    try { return decodeURIComponent(m[1]); } catch (e) { return m[1]; }
  }
  if (href.indexOf("//") === 0) return "https:" + href;
  return href;
}

// DDG mixes sponsored ads. Their hrefs go through the y.js ad redirector
// regardless of destination, so URL pattern is the most reliable filter.
function isDdgAdUrl(url) {
  if (!url) return false;
  return /^https?:\/\/(?:[a-z0-9.-]*\.)?duckduckgo\.com\/y\.js/i.test(url);
}

function parseDdg(html, max) {
  if (!html) return [];
  var titleRe = /<a\b[^>]*class="[^"]*\bresult__a\b[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  var snipRe = /<a\b[^>]*class="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/a>/g;
  var titles = [];
  var m;
  while ((m = titleRe.exec(html)) !== null) {
    titles.push({ url: unwrapDdgUrl(m[1]), title: stripTags(m[2]) });
    if (titles.length >= 50) break;
  }
  var snippets = [];
  while ((m = snipRe.exec(html)) !== null) {
    snippets.push(stripTags(m[1]));
    if (snippets.length >= 50) break;
  }
  var out = [];
  for (var i = 0; i < titles.length && out.length < max; i++) {
    if (!titles[i].title || !titles[i].url) continue;
    if (isDdgAdUrl(titles[i].url)) continue;
    var snippet = snippets[i] || "";
    out.push({
      title: titles[i].title,
      url: titles[i].url,
      snippet: snippet,
      freshness: extractFreshness(snippet)
    });
  }
  return out;
}

async function ddgSearch(queries, maxR, sleepMs) {
  // Only Content-Type. web_fetch runs in the user's real browser, so UA / Origin /
  // Sec-Fetch-* are set naturally (and several are forbidden header names that
  // fetch() would silently strip anyway).
  var headers = { "Content-Type": "application/x-www-form-urlencoded" };
  var perQuery = [];
  var blockedAt = null;
  var blockedQuery = null;

  for (var i = 0; i < queries.length; i++) {
    var q = queries[i];

    if (typeof q !== "string" || !q.trim()) {
      perQuery.push({ query: String(q), status: null, results: [], error: "empty query" });
      continue;
    }
    if (q.length > DDG_MAX_QUERY_LEN) {
      perQuery.push({ query: q, status: null, results: [], error: "query > 499 chars (DDG hard limit)" });
      continue;
    }

    var body = "q=" + encodeURIComponent(q) + "&b=&kl=wt-wt&df=";
    var res;
    try {
      res = await executeTool("web_fetch", {
        url: DDG_URL,
        method: "POST",
        headers: headers,
        body: body
      });
    } catch (e) {
      perQuery.push({ query: q, status: null, results: [], error: "fetch failed: " + String(e) });
      blockedAt = i;
      blockedQuery = q;
      break;
    }

    // 202 = DDG bot challenge.
    if (res && res.status === 202) {
      blockedAt = i;
      blockedQuery = q;
      perQuery.push({ query: q, status: 202, results: [], error: "DDG bot challenge (HTTP 202)" });
      break;
    }

    if (!res || res.status !== 200) {
      perQuery.push({
        query: q,
        status: res ? res.status : null,
        results: [],
        error: "unexpected HTTP status"
      });
      blockedAt = i;
      blockedQuery = q;
      break;
    }

    var results = parseDdg(res.body || "", maxR);
    perQuery.push({ query: q, status: 200, results: results });

    if (i < queries.length - 1) await sleep(sleepMs);
  }

  var out = {
    engine: "ddg",
    completed: perQuery.filter(function (p) { return p.status === 200 && !p.error; }).length,
    total_requested: queries.length,
    results: perQuery
  };

  if (blockedAt !== null) {
    out.blocked = true;
    out.blocked_at = blockedAt;
    out.blocked_url = DDG_VISIBLE + encodeURIComponent(blockedQuery);
    out.remaining = queries.slice(blockedAt);
  }

  return out;
}

// ---------- Entrypoint ----------
async function web_search(args) {
  args = args || {};
  var queries = Array.isArray(args.queries) ? args.queries.slice() : [];
  var engine = args.engine === "ddg" ? "ddg" : "google";
  var maxR = (typeof args.max_results_per_query === "number" && args.max_results_per_query > 0)
    ? Math.floor(args.max_results_per_query) : 10;
  var defaultSleep = engine === "google" ? 5000 : 2000;
  var sleepMs = (typeof args.sleep_ms === "number" && args.sleep_ms >= 0)
    ? Math.floor(args.sleep_ms) : defaultSleep;

  if (queries.length === 0) {
    return { engine: engine, completed: 0, total_requested: 0, results: [], error: "no queries provided" };
  }

  if (engine === "google") return googleSearch(queries, maxR, sleepMs);
  return ddgSearch(queries, maxR, sleepMs);
}
