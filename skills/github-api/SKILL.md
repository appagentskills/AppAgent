---
name: github-api
description: Call the GitHub REST API from this extension. web_fetch now auto-attaches the stored GitHub token (the same credential the workspace tool uses for clone/push) on any request targeting the CONFIGURED GitHub instance's REST base (api.github.com for github.com, or <instance>/api/v3 for GitHub Enterprise), so authenticated REST calls work against PRIVATE repos with no manual token handling. Quick-reference for repos, branches, files/contents, commits, pull requests, PR files/commits, PR comments (conversation + inline review), and reviews/approvers, plus a reusable js_eval helper, pagination, rate-limit and error notes.
---

# github-api

Read GitHub data via the **official REST API** at `https://api.github.com`.

## Auth is automatic

`web_fetch` auto-attaches the stored GitHub token when a request targets the **configured
GitHub instance's REST API base**:

- `https://github.com` (default) → **`https://api.github.com`** (any path on that host)
- GitHub **Enterprise** `<instanceUrl>` → **`<instanceUrl>/api/v3`** (only `/api/v3` paths)

Headers attached:

- `Authorization: Bearer <token>`
- `Accept: application/vnd.github+json`
- `X-GitHub-Api-Version: 2022-11-28`

So you **don't** pass a token yourself — just `web_fetch` the REST URL for your configured
instance, including for **private** repos.

Notes:
- Any header **you** set explicitly is respected (not overridden).
- The token only goes to the configured instance's REST base — never to other hosts, the
  GitHub web UI, or `raw.*` blobs.
- On **GitHub Enterprise**, use `<instanceUrl>/api/v3/...` (not `api.github.com`).

## Reusable helper (use inside one js_eval)

```javascript
// GET an api.github.com endpoint and parse JSON. Auth is auto-attached by web_fetch.
async function gh(path, opts) {
  opts = opts || {};
  var url = path.indexOf('http') === 0 ? path : 'https://api.github.com' + path;
  var res = await executeTool("web_fetch", {
    url: url,
    method: opts.method || 'GET',
    body: opts.body,
    headers: opts.headers,            // optional; yours win over the auto headers
    status_message: "GitHub REST: " + (opts.method || 'GET') + " " + url
  });
  var data;
  try { data = JSON.parse(res.body); } catch (e) { data = res.body; }
  return { status: res.status, data: data, raw: res };
}

// Paginate a list endpoint (follows ?page=). pages = max pages to pull.
async function ghAll(path, pages) {
  pages = pages || 5;
  var sep = path.indexOf('?') >= 0 ? '&' : '?';
  var out = [];
  for (var p = 1; p <= pages; p++) {
    var r = await gh(path + sep + 'per_page=100&page=' + p);
    if (r.status !== 200 || !Array.isArray(r.data) || r.data.length === 0) break;
    out = out.concat(r.data);
    if (r.data.length < 100) break;
  }
  return out;
}

// Example: 10 latest commits on main of a private repo
var c = await gh('/repos/OWNER/REPO/commits?sha=main&per_page=10');
return c.data.map(function (x) {
  return { sha: x.sha.slice(0,7), msg: x.commit.message.split('\n')[0],
           author: x.author && x.author.login, date: x.commit.committer.date };
});
```

> Return only the small fields you need — list responses can be large.

## Endpoint quick-reference

Replace `{o}`=owner, `{r}`=repo, `{n}`=PR/issue number, `{sha}`=commit/tree sha or branch.

### Repo / branches
| Goal | Endpoint |
|---|---|
| Repo metadata | `GET /repos/{o}/{r}` |
| List branches | `GET /repos/{o}/{r}/branches?per_page=100` |
| One branch (+ head sha) | `GET /repos/{o}/{r}/branches/{branch}` |
| Compare two refs | `GET /repos/{o}/{r}/compare/{base}...{head}` |

### Files in a branch
| Goal | Endpoint |
|---|---|
| Full recursive tree | `GET /repos/{o}/{r}/git/trees/{branch}?recursive=1` → `.tree[]` has `path`, `type` (blob/tree), `sha` |
| Single file / dir listing | `GET /repos/{o}/{r}/contents/{path}?ref={branch}` → file content is base64 in `.content` (decode with `atob`); a dir returns an array |
| Raw blob by sha | `GET /repos/{o}/{r}/git/blobs/{sha}` (base64) |

> For reading/searching **many** file bodies, the `workspace` tool (clone → `read`/`grep`) is
> usually faster than pulling blobs one-by-one over REST. Use Contents API for one-off reads.

### Commits
| Goal | Endpoint |
|---|---|
| List commits on a branch | `GET /repos/{o}/{r}/commits?sha={branch}&per_page=10` |
| One commit (+ files) | `GET /repos/{o}/{r}/commits/{sha}` |
Fields: `sha`, `commit.message`, `commit.author/committer.{name,date}`, `author.login`.

### Pull requests
| Goal | Endpoint |
|---|---|
| List PRs | `GET /repos/{o}/{r}/pulls?state=all&per_page=100` (`state`=open/closed/all) |
| One PR | `GET /repos/{o}/{r}/pulls/{n}` → `title`, `state`, `merged`, `user.login`, `head.ref`, `base.ref`, `additions`, `deletions` |
| PR changed files | `GET /repos/{o}/{r}/pulls/{n}/files` → `filename`, `status`, `additions`, `deletions`, `patch` |
| PR commits | `GET /repos/{o}/{r}/pulls/{n}/commits` |

### PR comments
| Kind | Endpoint |
|---|---|
| Conversation (issue) comments | `GET /repos/{o}/{r}/issues/{n}/comments` → `user.login`, `body`, `created_at` |
| Inline (review) comments | `GET /repos/{o}/{r}/pulls/{n}/comments` → adds `path`, `line`/`original_line`, `diff_hunk` |
| Post a conversation comment | `POST /repos/{o}/{r}/issues/{n}/comments` body `{"body":"..."}` |

### Reviews & approvers
| Goal | Endpoint |
|---|---|
| Reviews (who approved) | `GET /repos/{o}/{r}/pulls/{n}/reviews` → each: `user.login` + `state` (`APPROVED` / `CHANGES_REQUESTED` / `COMMENTED` / `DISMISSED`) |
| Still-requested reviewers | `GET /repos/{o}/{r}/pulls/{n}/requested_reviewers` → `.users[].login`, `.teams[].slug` |

To get **current approvers**: pull `/reviews`, keep the latest review per `user.login`, and
filter `state === 'APPROVED'`.

### Search
| Goal | Endpoint |
|---|---|
| Search code | `GET /search/code?q={query}+repo:{o}/{r}` |
| Search PRs/issues | `GET /search/issues?q=repo:{o}/{r}+is:pr+is:open` |

## Pagination

List endpoints return max 100 per page. Use `?per_page=100&page=N`; stop when a page
returns fewer than `per_page` items (see `ghAll` above). The `Link` response header also
carries `rel="next"`/`rel="last"` if you prefer to follow cursors.

## Rate limits

REST = **5000 req/hr** per token. `GET /rate_limit` reports remaining. `search/*` has a
tighter limit (~30/min). Batch and cache; avoid tight loops.

## Errors / gotchas

- **404** = the resource is missing or the token lacks access to it — check the repo path
  and the token's scope.
- **401** = token invalid/expired → re-connect GitHub in the extension settings.
- **403** with `x-ratelimit-remaining: 0` = rate limited (back off / check `/rate_limit`).
- **422** = validation error on a write (bad/duplicate params) — read `.errors` in the body.
- Always `JSON.parse(res.body)`; for writes pass `method` + a JSON string `body`.
- Token scope: the same PAT/OAuth used for git now powers REST reads/writes, so its scope
  applies to both. Write calls (POST/PATCH/DELETE) act as the connected user — confirm intent.
