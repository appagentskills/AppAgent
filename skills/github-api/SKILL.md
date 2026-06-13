---
name: github-api
description: Call the GitHub REST API from this extension. web_fetch now auto-attaches the stored GitHub token (the same credential the workspace tool uses for clone/push) on any request targeting the CONFIGURED GitHub instance's REST base (api.github.com for github.com, or <instance>/api/v3 for GitHub Enterprise), so authenticated REST calls work against PRIVATE repos with no manual token handling. Quick-reference for repos, branches, files/contents, commits, pull requests, PR files/commits, PR comments (conversation + inline review), reviews/approvers, and merging PRs (mergeability checks, merge methods, update-branch, branch deletion, direct branch merges), plus a reusable js_eval helper, pagination, rate-limit and error notes.
---

# GitHub REST API

Read and write GitHub data via the **official REST API** at `https://api.github.com`.

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

## Permissions: agent-governed (no prompt on reads)

`web_fetch` normally prompts the user on **every** call. The one exception is a
request to the **configured GitHub REST API base** (the same match that triggers
auto-auth above): those are treated like `servicenow_api` — **governed by the
`confirm` flag**, not a forced prompt.

- **Reads** (`GET`, and any call without `confirm:true`) run **silently** — no
  approval prompt. Loop over commits / PRs / files without interrupting the user.
- **Writes** — merging a PR, posting a comment/review, creating a branch, GraphQL
  mutations — set **`confirm: true`** so the user reviews before it runs.

This only applies to the connected GitHub host; every other `web_fetch` URL still
prompts. If the user has explicitly set `web_fetch` to *disabled* or *allow* in
settings, that override wins (only the default *ask* is downgraded).

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
| Check if merged | `GET /repos/{o}/{r}/pulls/{n}/merge` → **204**=merged · **404**=not merged |
| Merge a PR | `PUT /repos/{o}/{r}/pulls/{n}/merge` — see *Merge a pull request* below |
| Update PR branch (pull base in) | `PUT /repos/{o}/{r}/pulls/{n}/update-branch` → 202 |

### PR comments
| Kind | Endpoint |
|---|---|
| Conversation (issue) comments | `GET /repos/{o}/{r}/issues/{n}/comments` → `user.login`, `body`, `created_at` |
| Inline (review) comments | `GET /repos/{o}/{r}/pulls/{n}/comments` → adds `path`, `line`/`original_line`, `diff_hunk` |
| Post a conversation comment | `POST /repos/{o}/{r}/issues/{n}/comments` body `{"body":"..."}` |
| Post a review + inline comments | `POST /repos/{o}/{r}/pulls/{n}/reviews` — see *Post a review* below |

### Reviews & approvers
| Goal | Endpoint |
|---|---|
| Reviews (who approved) | `GET /repos/{o}/{r}/pulls/{n}/reviews` → each: `user.login` + `state` (`APPROVED` / `CHANGES_REQUESTED` / `COMMENTED` / `DISMISSED`) |
| Still-requested reviewers | `GET /repos/{o}/{r}/pulls/{n}/requested_reviewers` → `.users[].login`, `.teams[].slug` |

To get **current approvers**: pull `/reviews`, keep the latest review per `user.login`, and
filter `state === 'APPROVED'`.

### Post a review (summary + inline comments)

One call posts a review **summary plus many inline comments** atomically:
`POST /repos/{o}/{r}/pulls/{n}/reviews` with a JSON body:

```json
{
  "commit_id": "<head sha>",   // optional; defaults to the PR's latest commit
  "event": "COMMENT",           // COMMENT | APPROVE | REQUEST_CHANGES | (omit = PENDING draft)
  "body": "Overall summary…",
  "comments": [
    { "path": "src/foo.js", "line": 42, "side": "RIGHT", "body": "single-line note" },
    { "path": "src/foo.js", "start_line": 10, "line": 14, "side": "RIGHT", "body": "multi-line note" }
  ]
}
```

- **`line` is the line number in the file, not a diff offset.** Use the post-change number for `side:"RIGHT"` (added/context), the pre-change number for `side:"LEFT"` (deleted lines). Compute it from the hunk header `@@ -a,b +c,d @@`: the new side starts at line `c`, then increment once per non-removed line.
- A comment **must land on a line that is part of the diff** (an added/removed/context line shown in the file's `patch`), otherwise GitHub returns **422 "line must be part of the diff"**. Fetch `GET /pulls/{n}/files` first and read each `patch` to pick valid anchors.
- `start_line` + `line` = a multi-line comment; omit `start_line` for a single line. `side` defaults to `RIGHT`.
- You **cannot `APPROVE` your own PR** (422) — use `event:"COMMENT"` to leave notes without a verdict.

Standalone single inline comment (no review wrapper):
`POST /repos/{o}/{r}/pulls/{n}/comments` body `{commit_id, path, line, side, body}`.
Reply to an existing inline comment: same endpoint with `{body, in_reply_to: <comment_id>}`.

### Merge a pull request

`PUT /repos/{o}/{r}/pulls/{n}/merge` merges the PR. JSON body (all optional):

```json
{
  "merge_method": "merge",          // merge (default) | squash | rebase
  "commit_title": "...",            // overrides the auto commit title (merge/squash)
  "commit_message": "...",          // overrides the auto commit body (merge/squash)
  "sha": "<expected head sha>"      // guard: 409 if the head moved since you read it
}
```

Success = **200** with `{ "merged": true, "sha": "<merge commit sha>", "message": "Pull Request successfully merged" }`.

**Always check mergeability first.** `GET /repos/{o}/{r}/pulls/{n}` returns:
- `mergeable` — `true` / `false` / **`null`** (GitHub is still computing it in the background — re-GET after ~1s until it settles; do **not** merge while `null`).
- `mergeable_state` — `clean` (good to go) · `dirty` (merge conflicts) · `blocked` (branch protection: required reviews/checks not satisfied) · `behind` (head is behind base — update the branch first) · `unstable` (non-required checks failing, still mergeable) · `draft` (PR is a draft) · `has_hooks`.
- `merged` — already merged? (skip if `true`).

Recommended flow inside one js_eval (uses the `gh` helper above; replace `{o}/{r}/{n}`):
```javascript
var pr = (await gh('/repos/{o}/{r}/pulls/{n}')).data;
if (pr.merged) return { already: true };
// poll until GitHub finishes computing mergeable
for (var i = 0; i < 5 && pr.mergeable === null; i++) {
  await new Promise(function (r) { setTimeout(r, 1200); });
  pr = (await gh('/repos/{o}/{r}/pulls/{n}')).data;
}
if (!pr.mergeable) return { blocked: pr.mergeable_state };   // dirty / blocked / behind ...
var m = await gh('/repos/{o}/{r}/pulls/{n}/merge', {
  method: 'PUT',
  body: JSON.stringify({ merge_method: 'squash', sha: pr.head.sha })
});
return { status: m.status, merged: m.data.merged, sha: m.data.sha, msg: m.data.message };
```

**Response codes:**
- **200** — merged.
- **405** `"Pull Request is not mergeable"` — conflicts, a draft, or branch protection (`blocked`) is stopping it. The merge API has **no admin-override** for protected branches; satisfy the requirement (approve / pass checks) or merge from the GitHub UI as an admin.
- **409** `"Head branch was modified..."` — the `sha` you passed no longer matches the PR head (someone pushed). Re-read the PR and retry with the fresh head sha.
- **404** — no write access or wrong path.
- **422** — bad `merge_method` (e.g. `squash`/`rebase` disabled in the repo's merge settings) or other validation; read `.errors`.

> **Confirm before merging.** A merge is a hard-to-undo write that runs as the connected user — treat it like a production change and confirm intent first.

**If `mergeable_state` is `behind`:** sync the head with base first via
`PUT /repos/{o}/{r}/pulls/{n}/update-branch` (→ **202**, `{message, url}`), let checks re-run, then merge.

**Clean up after merge:** delete the merged head branch with
`DELETE /repos/{o}/{r}/git/refs/heads/{head.ref}` (→ **204**). Never delete a branch that other open PRs still target.

**Enable auto-merge** (merge automatically once required checks/reviews pass) — **GraphQL only**, there is no REST endpoint:
```graphql
mutation {
  enablePullRequestAutoMerge(input:{ pullRequestId:"PR_…", mergeMethod:SQUASH }) {
    pullRequest { autoMergeRequest { enabledAt } }
  }
}
```
Get the GraphQL `pullRequestId` (`PR_…`) from `repository(owner:"{o}",name:"{r}"){ pullRequest(number:{n}){ id } }`. Turn it off with `disablePullRequestAutoMerge`.

### Merge one branch into another (no PR)

To merge branches directly without opening a PR, `POST /repos/{o}/{r}/merges` with
`{ "base": "main", "head": "feature", "commit_message": "..." }`:
- **201** — created a merge commit (returns the commit object).
- **204** — nothing to merge (base already contains head).
- **409** — merge conflict (resolve through a PR/branch instead).
- **404** — missing base/head or no access.

### Resolve / unresolve a review thread (GraphQL only)

**REST cannot resolve review threads** — there is no endpoint for it. Use the GraphQL API at
`POST https://api.github.com/graphql` (same host, so the token auto-attaches; send `{"query": "…"}`).

1. Get the thread IDs (and which inline comment opened each):
```graphql
query {
  repository(owner:"{o}", name:"{r}") {
    pullRequest(number:{n}) {
      reviewThreads(first:50) {
        nodes { id isResolved comments(first:1){ nodes { databaseId path line } } }
      }
    }
  }
}
```
Match a thread to a known inline comment via `comments.nodes[0].databaseId` (that's the REST comment `id`).
2. Resolve (or `unresolveReviewThread` to reopen):
```graphql
mutation { resolveReviewThread(input:{threadId:"PRRT_…"}) { thread { id isResolved } } }
```
- `threadId` is the GraphQL node id (`PRRT_…`), **not** the REST comment id.
- GraphQL errors come back as `{ "errors": […] }` with HTTP 200 — always check `body.errors`, not just the status.

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
