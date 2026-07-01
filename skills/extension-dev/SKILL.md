---
name: extension-dev
description: "Develop the AppAgent Chrome extension using the workspace tool. Clone, browse, and edit source files; the user clicks Reload to rebuild, redeploy, and restart."
---

# Extension Development Skill

Develop the AppAgent Chrome extension using the `workspace` tool. You edit source files in the workspace; the **Reload** button in the extension applies them (it rebuilds + redeploys from the workspace and restarts). You do **not** deploy yourself.

> ## ⛔ #1 RULE — skills are SOURCE FILES here, not live-instance objects
> **If a task is "improve / test / edit / fix the `<name>` skill" (e.g. ui-driver, instance-audit), that IS extension development — edit `skills/<name>/SKILL.md` and its `*.md` / tool `*.js` files with the `workspace` tool, then ask the user to Reload.** Do **NOT** reach for the `manage_skill` tool: it mutates only the *ephemeral live/runtime copy*, which the next build **overwrites** — so that work is silently lost and diverges from the repo (this exact mistake has recurred across multiple agents — see PR history). All *writes* go through the `workspace` tool. For *reading*, `get_skill` is fine for a quick look — but the **canonical source is the repo**, so prefer `workspace read` as the source of truth (the runtime copy `get_skill` returns can lag what's in `skills/<name>/`). Rule of thumb: **write with `workspace`, never `manage_skill`.**

## Prerequisites

- GitHub connected in Settings (PAT with `repo` scope)
- The AppAgent repo cloned via `workspace clone`
- For changes to apply on reload: extension folder connected in Settings > GitHub > Connect Folder

## Development Workflow

1. **Clone**: `workspace clone` with `repo: "owner/appagent"` (only needed once)
2. **Explore**: Use `workspace ls`, `workspace read`, `workspace grep` to understand the codebase
3. **Edit**: Use `workspace edit` for surgical changes (preferred) or `workspace write` for new files
4. **Reload to apply**: Do **not** run `extension_build` to deploy. After editing, ask the user to click the **Reload** button in the extension header. With a deploy folder connected and this skill active, the reload rebuilds + redeploys from the workspace and restarts in one click — that is what makes your changes take effect. (Reload calls `extension_build` internally; you don't.)
5. **Push**: When happy, `workspace push` creates a branch + commit + PR on GitHub. **By default, pass `files: [...]` listing ONLY the files YOU worked on in this chat** — other dirty files in the workspace may be work-in-progress from other agents/chats, and pushing them would leak unrelated, possibly half-finished changes into your PR. Run `workspace status` first: it shows which chat owns each dirty file. Only omit `files` when you have verified every dirty file belongs to your task.

## Workspace Pinning, Branch Forks & Edit Moves

- **Pinning**: `workspace pin` (args: `workspace`, or `{unpin: true}`) marks ONE workspace per owner/repo as pinned. Reload / `extension_build` build the **pinned** `/AppAgent` workspace; without a pin they fall back to the trunk (`::main` / `::master`), then the first match. Default workspace resolution also prefers the pin over most-recently-used. The pin is also toggleable from the workspace header dropdown (📌) and the Settings repos list.
- **`branch` action (local fork)**: `workspace branch` with `branch: "feat/x"` forks the current workspace into `owner/repo::feat/x` locally — a cheap row copy; the **remote branch is only created on the first push** from the fork (cut from the fork's base branch; `branch_name` defaults to the fork's own branch). Dirty edits travel to the fork by default (`move_dirty: true` reverts the source clean); pass `move_dirty: false` to keep them in both. The fork is pinned automatically, so Reload builds it.
- **`move` action**: `workspace move` with `to: "owner/repo::other"` (optional `files: [...]`) moves dirty edits onto another workspace — written against the target's own base, source restored clean. A target file that is itself dirty with different content blocks the whole move (use `force` to overwrite); differing base shas are allowed but reported in `base_diverged`.
- **Merge lifecycle**: when a workspace's branch is the head of a MERGED PR and its base branch is cloned locally, sync auto-deletes the fork workspace: dirty files are moved to the base first (a blocked move keeps the workspace and returns a warning), the base workspace is synced/pulled so it contains the merged code, and the pin follows the merge onto the base (only if the deleted workspace held the pin, or no pin existed — a pin pointing elsewhere is never stolen).

## Project Structure

```
src/
  js/          - JavaScript source files (numbered for build order)
  css/         - CSS source files (numbered for build order)
  html/        - HTML templates (head.html, body.html)
  platform/
    extension/ - Chrome extension files (manifest.json, background.js, content-script.js, platform-bridge.js)
skills/        - Agent skills (SKILL.md + optional tool JS files)
build/         - Build scripts (reference only — the in-browser build replicates this)
dist/extension/- Built extension output (DO NOT edit directly, use src/)
```

## JS File Map (src/js/)

Files are organized into **tiers** (folders); within each tier the numeric prefix sets load order.
Tier concatenation order (in `build/build.js` `JS_TIERS`): `core` → `ui` → `tools` → `app` for the page bundle, plus a separate `worker` tier bundled into the service worker. Since the service-worker move, the authoritative agent loop and all run state live in the `worker` tier (the SW); tools that need the DOM are bridged from the SW to an offscreen document.

- `src/js/core/` — platform detection, bootstrap, config, hooks/history, streaming, permissions, tool registry, codemap, handle & sub-agent registries, cached results, system prompt, init, IndexedDB, skills engine, record helpers
- `src/js/ui/` — views, panels, sidebar, settings, modals, dropdowns, message rendering, layout, iframe panel UI
- `src/js/tools/` — agent tool implementations (iframe_tool, file_tools, screenshot_tools, widget_tools, prompt_user, actions, smart_documents, display_templates)
- `src/js/app/` — page-side bridge / event-handler layer between the page and the service worker (llm_streaming, api_messages, send_message, image_attachments, keep_awake), plus the page-side agent bus / port bridge (045-agent-port-bridge-page.js) and agent-event handlers (035-agent-events.js, 036-agent-event-handlers-page.js). NOTE: the authoritative agent loop no longer runs here — it runs in the `worker` tier (service worker); `030-agent-loop.js` here is the page-side wrapper.
- `src/js/worker/` — service worker: agent-loop host, run sequencing, tool routing / port bridge, SW storage, checkpoints, broadcasts (000-runtime-globals, 010-platform-stub, 020-page-stubs, 025-permissions-helpers, 100-agent-event-broadcast, 105-subagent-broadcast, 110-agent-checkpoint, 115-storage, 120-tool-routing, 130-port-bridge, 190-entry)

Insertion: drop a new file into the right tier folder with an unused numeric prefix (gaps of 10). No global renumber.

## CSS File Map (src/css/)

- `00-03` — Tokens (variables), dark theme, layout, chat
- `04-08` — Header, tools, input, markdown, browser panel
- `09-15` — Settings, approval, version, artifacts, notifications, modals, widgets
- `16-24` — Diff, skills, panels, dashboard, responsive, display templates (`21*`: display-templates, prompt-user, smart-documents), sidepanel, actions, sub-agents

## Key Files

- `src/js/core/080-tools.js` — Tool definitions (TOOLS array)
- `src/js/core/070-permissions.js` — Permission keys and defaults
- `src/js/tools/020-tool-execution.js` — Tool execution logic (executeTool)
- `src/js/tools/010-iframe-tool.js` — Browser interaction tool
- `src/js/core/120-init.js` — Initialization and startup
- `src/js/worker/190-entry.js` — Service worker entry; hosts the authoritative agent message loop + run state
- `src/js/worker/120-tool-routing.js` — SW tool routing (parks/replays UI tool calls, bridges DOM-needing tools to the offscreen document)
- `src/js/worker/130-port-bridge.js` — SW port bridge (run-agent handler, page↔SW messaging)
- `src/js/app/045-agent-port-bridge-page.js` — Page-side agent port bridge (runningChatIds, _pendingRunAgents)
- `src/js/app/035-agent-events.js` / `036-agent-event-handlers-page.js` — Page-side agent event bus / handlers
- `src/js/app/030-agent-loop.js` — Page-side agent loop wrapper (authoritative loop is in the worker tier)
- `src/js/ui/250-message-render.js` — Chat message rendering
- `src/platform/extension/background.js` — Extension service worker
- `src/platform/extension/content-script.js` — Tab content script
- `src/platform/extension/platform-bridge.js` — Extension platform bridge

## Important Rules

- **NEVER write literal `<![CDATA[` or `]]>` in code** — breaks the XML wrapper. Build dynamically: `'<![' + 'CDATA['`
- **Edit `src/` files, not `dist/`** — dist is generated by the build
- **In extension dev mode, update skills in the extension source, not on the live workspace** — edit the `skills/<name>/SKILL.md` (and any tool JS) files in the repo and ship them by asking the user to reload (the reload rebuilds + redeploys). Do NOT create or modify skills with the `manage_skill` tool on the running workspace; skill changes are delivered through the extension build, not the live instance.
- **`workspace push` reuses a PR when you push to an existing branch** — a new `branch_name` creates a new branch + new PR against the base/source branch we cloned from; passing the SAME `branch_name` as a prior push appends another commit to that branch and updates the existing open PR (each commit carries the full current changes against the base). To add commits to the same PR, push again with the same `branch_name` (the response sets `pr_reused: true` when an existing PR was updated).
- **JS files are tiered** (`core` → `ui` → `tools` → `app`) with numeric prefix for load order within tier — use the file map above to pick the right folder
- **Edits are surgical** — use `workspace edit` with search-and-replace, not full file rewrites
- **Inline handlers are OK** — the build auto-converts `onclick="..."` etc. to CSP-compliant `addEventListener` calls
- **Don't deploy yourself — the user's Reload does it.** Editing `src/` only changes the workspace. Clicking the in-extension **Reload** button rebuilds + redeploys from the workspace and restarts (it calls `extension_build` internally). Just make your edits and ask the user to reload; do not call `extension_build` to deploy.
- **workspace push `pr_body` and `commit_message`**: Do NOT use `\n` escape sequences — they render as literal text on GitHub. Use actual newlines in the string value for multi-line content. Markdown formatting like `###` headers DOES work when you use real newlines.