# Changelog

## v1.1.3

Version bump to sync the extension manifest with the tagged release (manifest was still at 1.1.1 when v1.1.2 was tagged).

---

## v1.1.2

Stabilization release closing out issues from v1.1.0.

### Fixes
- Pause, Stop, Dismiss, Resume and Send work reliably again, including right after the extension restarts in the background.
- Retry always targets the right chat and works after a background restart. Error banners and Retry buttons clear when you retry, continue, switch chats, or start a new one.
- The chat you're viewing is never cleaned up out from under you, even after a reload or going Back.
- Background and sub-agent chats no longer inflate the active-chats count, and stopping or crashing a sub-agent cleanly stops everything it spawned.
- Tools that act on the page can't run twice when the panel reopens, and prompts asking for your input are always re-shown instead of hanging.
- Chats and their edits are reliably saved; sending a message right after a background restart no longer affects other chats.

---

## v1.1.1

### Features
- **GitHub REST API skill** — `web_fetch` now auto-attaches the stored GitHub token when called against the configured GitHub instance's REST base (`api.github.com`, or `<instance>/api/v3` for Enterprise), so authenticated calls against private repos work with no manual token handling. New `github-api` skill with endpoint quick-reference and a reusable helper.

### Fixes
- **Background chats now show in Active Chats** — were missing from the jobs dropdown when started from another chat. The current chat is also included now, rows linger 5 min after a chat finishes, and clicking one opens that chat's progress popover.
- **Screen no longer sleeps during agent runs** — keep-awake holds the display lock for the whole run. Notice also dismisses on click-outside.
- **Sub-agent messages render correctly** — newlines came through as literal text and URLs were not clickable.
- **Widget screenshots no longer return a stale capture** — was happening on every capture, including after edits to the widget.
- **Chat list no longer grows from completed sub-agents** — finished sub-agents are now cleaned up an hour after they go idle.
- **Sub-agent tool budgets now apply to browser-side work** — clicks, screenshots, widgets, prompts, and skill calls used to never count toward the cap.
- **Search Docs action only shows on home** — was also rendering above the chat input.

---

## v1.1.0

### Features
- **New default model: Opus-4-8** — replaces Opus-4-7 in the default provider list. Sonnet 4.6 added as another OAuth option.
- **Sub-agents** — the agent can spawn helper agents to work on parts of a task in parallel, each with their own chat. Up to two run at a time; extras queue. You see them as separate chats with a "Sub-agent" pill and a Workers strip on the chat list, and you can jump to the parent or stop a worker at any time.
- **Async tools** — long-running tools no longer block the agent. It can kick a tool off, do other work, and come back to check the result, cancel it, or wait on any of several at once.

### Fixes
- **Stays signed in** — when the Claude session expires, the extension silently re-authenticates instead of failing the next request. Re-auth now fires both proactively (clock-based, before token expiry) **and** reactively on a server-side `401` (token revoked / session expired early), retrying the request once with a fresh token.
- **Retry after rate-limit works** — the Retry button after a 429 actually retries now (previously it silently did nothing and you had to click Continue).
- **Pause works again after the SW move** — pausing a chat aborts the in-flight LLM call / running tool **immediately** again, as documented. When the agent loop moved into the service worker, the in-flight stream's `AbortController` and the tool interrupt resolver moved with it — but the SW's `toggle-pause` handler only set the pause flag and never fired the abort. The panel-side `togglePause` still called `abort()`/the resolver, but on its own now-empty copies of those maps, so Pause silently became a no-op: it only took effect at the next loop-iteration boundary (after the whole streaming turn **and** its tool batch finished). The SW handler now mirrors the `interrupt` path and aborts the stream / resolves the interrupt on pause (without setting `userInterruptedChats`, so abandoned tools still read "paused by user" rather than "user sent a new message").
- **Reload button reliably restarts the service worker** — clicking Reload now always calls `chrome.runtime.reload()` (a full extension restart that re-imports `sw-bundle.js` from disk), so a freshly deployed service-worker bundle — e.g. an SW-side fix like the pause-abort one above — actually takes effect. Previously the whole reload was gated on the `chrome.storage.local.set({reopenAppTab})` completion callback in `src/js/ui/270-iframe-panel.js` (`reloadExtension()`); if that callback was delayed or never fired (SW asleep/busy, storage blocked, unchecked `lastError`), `chrome.runtime.reload()` was never reached and the **old** SW kept running — with no feedback to tell the user nothing happened, so a new `sw-bundle.js` never took effect. The reload now fires exactly once through a guarded helper with a short timer fallback (a stranded storage callback can no longer strand it), shows a "Reloading extension…" snackbar, and confirms first when an agent run is still in flight (a full reload kills it). The `reopenAppTab` → reopen-as-a-full-tab behavior is unchanged.
- **More reliable form fill** — ServiceNow fields with autocomplete or React-based inputs now fire their handlers correctly.
- **Readable `workspace` diffs** — the `diff` action now renders a proper LCS-based unified diff (common prefix/suffix trim + hunked context with `@@` headers). Previously it compared lines by absolute index, so any insert/delete shifted every following line and flagged the whole tail as changed — a localized ~30-line edit produced a ~360-line "whole-file re-alignment" anchored on repeated `}`/`return;`/blank lines. Display-only; file contents were never affected.
- **Active Chats now actually appear in the jobs badge/dropdown** — a background chat (one you started, then navigated away from while it kept running) is supposed to show under an "Active Chats" group in the jobs badge and its dropdown. It never did: a running chat only qualifies once it is **not** the focused chat (`getActiveChatsList()` excludes `currentChatId`), but `renderJobsBadge()` was only called on run start/finish/crash and action-state changes — never on chat switch. So the badge was computed while the chat was still focused (excluded → count 0 → badge `display:none`, which also hides its dropdown), and never recomputed after you navigated away. `selectChat()` now recomputes the badge **and** re-renders any open dropdown after `currentChatId` updates, and the panel-reconnect `hello` handler (which restores `runningChatIds`) now refreshes the badge too.
- **Sub-agent reliability hardening** (found in v1.1.0 testing):
  - `wake_sub_agent` / `stop_sub_agent` ACL now fails **closed** — previously an unresolved caller chat-id bypassed the subtree-ownership check entirely (fail-open), unlike `agent_message` which already failed closed.
  - Waking a still-running sub *with an instruction* no longer pushes a `user` message mid-turn (which broke Anthropic's assistant→tool_result alternation and 400'd the request) — it routes through `pendingInjectionsByChatId` like `agent_message`.
  - A sub that finishes without calling `report_to_parent` under `auto_report:false` is now marked `errored` (with `settled_at`) instead of being silently downgraded to `sleeping` — the tombstone sweep can finally GC the record + its background chat row (was a permanent leak). The `auto_report:true` crash path now stamps `settled_at` too.
  - `_drainPool` no longer leaks a pool slot (and orphans the spawn handle) if `runAgent` is unavailable in the current context.
  - Resumed (re-woken) sub-agents report their fresh spawn handle in `agent_status.pending_handles` again.
  - `spawn_sub_agent` now verifies the `chats` map is available **before** allocating the spawn handle + record (the guard previously ran *after* allocation). A missing `chats` map used to leak an orphan `running` record and leave the parent's `await_handle` hanging on a deferred that never resolved.
  - Budget-exhaustion and crash (`_markErrored`) terminations now **cascade-stop descendants**, like `stop_sub_agent` already did. Previously only an explicit `stop_sub_agent` cascaded, so a nested parent that ran out of tool budget or crashed orphaned its grandchildren — they kept holding pool slots and reporting into a dead chat. The cascade is now a shared `_cascadeStopDescendants` helper used by all three paths.
  - `wake_sub_agent` (already-running no-op) and `agent_message` (running recipient) now return an awaitable `handle` for the in-flight run, matching the documented "always returns `{handle}`" contract — previously these two branches returned no handle and the caller had to poll `agent_status`.
- **Async-tool (handle) reliability hardening** (found in v1.1.0 testing):
  - `cancel_handle` now stamps `settledAt` at cancel time so a cancelled handle whose background work *never* settles (a hung fetch / iframe interaction) can still be garbage-collected — previously it leaked in the registry forever in the long-lived service worker.
  - `await_any` no longer lets an `unknown` handle (bogus id, or one wiped by a service-worker restart) instantly "win" the race and mask handles that are genuinely still pending. Only a terminal status (`done`/`error`/`cancelled`) wins; if **every** handle is unknown it resolves immediately instead of hanging.
  - `awaitingApproval` is now forced `false` on any settled snapshot (`done`/`error`/`cancelled`) — it was set while pending but never reset, so a terminal snapshot could still claim the tool was blocked on the approval modal.
  - The handle GC sweep now also runs from `poll`/`await` (not just `start`/`list`), matching the documented "sweeps on every `Handles.*` call" — a poll/await-only workload previously never swept.
  - `await_all` now returns a top-level `timedOut` flag (mirrors `await_any`'s `timeout`); the empty-array guard on both helpers returns the uniform `{handle/snapshots, …}` shape instead of a bare `{error}`.
  - `await_all`'s `timedOut` flag is now actually surfaced to the agent. The registry computed it, but the tool-dispatch arm hand-picked only `{snapshots}` (unlike `await_any`, which spreads its whole result), so the flag was silently dropped at the boundary and never reached the caller — the documented partial-result detection was a no-op. The arm now forwards the full uniform shape via `Object.assign`, and the `await_all` tool description + system-prompt entry document `timedOut`.
- **Sub-agent boot GC no longer orphans chat rows** — the boot-time tombstone sweep deleted the settled sub-agent record but left its background chat row in `chats` + IndexedDB forever (the runtime idle sweep already deletes both). The boot sweep now reclaims the chat row too.
- **Sonnet 4.6 OAuth provider** added to the default provider list (the v1.1.0 feature note above shipped without the corresponding provider entry).

### Other
- **New permission: `offscreen`** — required so sub-agents and async tools can keep running when the side panel is closed.

---

## v1.0.6

### Other
- README: features and comparison tables now cover Skill Actions, Live Progress, Workspaces, Integrated Git & GitHub Push, Smart Documents, Multi-Instance, Pause & Interrupt, Claude OAuth sign-in, and Web Search. Background tasks marked as shipped (via Skill Actions); roadmap entry replaced with "Parallel agents". Web Search removed from the roadmap (already ships as a skill).

---

## v1.0.5

### Features
- **Documentation site** — the in-extension docs page is now sourced from a single Markdown file (`docs/documentation.md`) and rendered through a shared parser. A static github.io site renders the same Markdown with a sticky outline on desktop and a slide-in drawer on mobile
- In-extension docs page updated to cover features added since v0.9.0: Actions & Live Progress, Workspace cross-chat ownership, Pause & Send-During-Stream, OAuth sign-in, `prompt_user` / `web_fetch` / `servicenow_run_script` / `smart_documents` tools, browser `type` + `wait_for` actions

### Other
- New GitHub Actions release pipeline: pushing a `v*` tag deploys docs to GitHub Pages and attaches a built extension zip to the (auto-created) release. The tag is the single source of truth — the workflow overrides `manifest.version` in the ephemeral checkout from the tag name
- `npm run docs` serves the documentation site locally with on-the-fly `__VERSION__` substitution from the manifest
- Build: `file-download.html` and `file-download.js` are now included in the Node build's copy list (were silently missing, would have produced a broken zip from a clean CI checkout)

---

## v1.0.4

### Features
- **Reasoning Effort selector** in the API Provider modal — `(default)/low/medium/high/xhigh/max`. Editing a provider no longer silently drops the `effort` setting on save
- Opus-4.7 OAuth default reasoning effort raised from `high` to `xhigh` (only Opus 4.7 accepts `xhigh` on the Anthropic API; OpenRouter maps unsupported values to the nearest supported level)

### Other
- Version is now single-sourced from `manifest.json` via a `__VERSION__` placeholder substituted at build time by both `build/build.js` and the in-browser `extension_build` skill tool
- Inlined the OAuth path into `background.js` (no more standalone proxy). Removed legacy build-time API key substitution and unused dev tooling

---

## v1.0.3

### Features
- **Silent OAuth flow with PKCE** — no consent tab, no fetch interceptor. Requires being signed into claude.ai in the same Chrome profile

### Fixes
- `servicenow-eval`: execution lock + atomic verification/cleanup for more reliable scoring

### Other
- Extension manifest: add `cookies` permission

---

## v1.0.1

### Fixes
- GPT-5 / OpenAI strict function-calling rejected array params lacking an `items` schema (`invalid_function_parameters`). Added `items` to `display.rows/cards/items/events/data/changes` and to `prompt_user.fields[].options`

### Other
- New `servicenow-eval` skill: 20-task model evaluation harness for benchmarking agents on ServiceNow workflows

---

## v1.0.0

### Features
- **Workspace cross-chat ownership** — every workspace mutation stamps the file with `last_modified_by_chat_id/_title/_at`; subsequent mutations from a different chat are blocked (active chat) or surface a `cross_chat_warning` (dormant chat). `force: true` overrides. `read`/`status` surface the metadata with human-readable "X minutes ago" timestamps
- **Honest UI input in `iframe_tool`** — `fill` now fires the full keydown→input→keyup→change event chain with a React-safe value setter; new `type` action for per-character realistic key events (debounced/autocomplete handlers fire reliably); new `wait_for` action (`selector_visible` / `selector_gone` / `text` / `url_matches` with timeout) replaces blind setTimeout polling
- **Instant send-during-stream** — sending mid-stream aborts the in-flight LLM call (per-chat `AbortController`) and races running tools via an event-driven interrupt resolver instead of waiting for the batch to finish. Translucent "Queued" bubble renders the moment you press send; spinner switches to "Interrupting…" immediately
- **`update_action_state` in any chat** — drops the background-only guard, renders a single mutating progress card + color-coded state pill next to the chat title (running/stuck/done/error), with previous distinct steps tucked into a "Previous steps" trail
- **`manage_skill` `edit` action** — search-and-replace editing for skill body and skill files (matches `servicenow_diff_edit` / workspace edit shape) so the agent can make surgical changes instead of resending full content
- **Embedded `feature-deroulement` skill** — ships with the extension on fresh installs
- **Header live action pills** — auto-rendered from `activeActions`, with icon-only responsive collapse
- **Streaming dot in chat list** — per-chat agent-running indicator (suppressed when paused)
- **Instance picker live-refresh poll**
- **Display awake when idle** — opt-out feature prevents OS display sleep after 5 minutes of inactivity in the chat page; toggles in both settings UIs
- **"Agent finished" notification when away** — finish-time check now uses `_hiddenDuringRun` (visibilitychange + window.blur listeners) so it fires when you switched Chrome windows or tabbed away mid-run, not only when the document is hidden at the exact end
- System prompt: don't volunteer `html_widget` / `display` unless the user asked for a visualization or the data is too large for plain text. `iframe_tool` now nudges to read `sys_ui_action.script` and replicate via Table API / `servicenow_run_script` instead of clicking through UI Actions
- `atf-testing` skill: HTTP 414 gotcha, state-passing across `run_script` calls via `gs.setProperty`, compact RSS param-name pattern, cleanup-by-prefix idiom, multi-test suite section

### Fixes
- `iframe_tool` `navigate`: eliminate race where `complete` fired before listener attached; detect same-URL no-op navigations (was hitting 15s timeout); sidepanel `handleNavigate` now honors the `wait` param; numeric `wait` is a custom timeout in ms
- Chat markdown renderer now supports blockquotes — single- and multi-line `> …` no longer renders as literal text
- Progress pill jumped straight to the final state when an assistant message batched multiple `update_action_state` calls; `collectAllActionUpdates` now requires a matching `role:'tool'` result row and treats the in-flight call as synthetically completed
- `executeUpdateActionState` edge cases: reject off-list state values instead of silently coercing to `running`; treat `output:null` as explicit clear (was leaving stale output); reset the dismiss timer on terminal→terminal transitions (e.g. `done`→`error`); floor `auto_dismiss_ms` at 500ms
- `manage_skill` create/update silently dropped the `actions` field, and SKILL.md writes never re-parsed frontmatter — actions/name/description now persist on every write path
- Build: Node build now emits embedded-skill frontmatter as base64, included in the change-detection hash so action-only edits force a refresh on upgrade. Legacy installs with empty `actions` backfill from `embedded.frontmatter` (guarded by `!userModified`)
- Streaming/pause overhaul:
  - Pause is per-chat — was a global flag that halted every running chat including background Action chats
  - Pause now aborts the in-flight LLM call immediately via `AbortController`; previously waited for the agent-loop iteration boundary
  - Resume gates on `runningChatIds[chatId]` instead of the global `isRunning` (was blocked whenever any background chat was active)
  - Queued messages concatenate instead of overwrite — sending two messages during the abort/restart window no longer drops the first
  - IME composition guard on Enter (`!e.isComposing && e.keyCode !== 229`) — CJK candidate-commits no longer accidentally send
  - Removed `scroll-behavior: smooth` on `.streaming-answer`; per-chunk scroll animations were stacking and fighting auto-follow
  - `streamUpdateInterval` declared before the `try` so the `catch`'s `clearInterval` is safe even if `setInterval` itself throws

---

## v0.9.0

### Features
- **Actions System** — one-click agent workflows triggered by buttons; active-actions badge on home, jobs dropdown with state colors, and an Action Updates timeline in the right sidebar
- **Streaming timeline** — ephemeral agent messages render as a timeline during streaming
- **Tool Inspector** — replaces the standalone Tools page with a modal launched from Settings
- **ServiceNow session keep-alive** — touch-session heartbeat keeps connected instances from timing out
- **`servicenow_run_script` tool** — execute background scripts on the connected instance
- **Workspace deploy tool** — deploy `dist/extension` from the agent
- **Continue after reload** — page-reload now shows a Continue button instead of leaving the agent stuck on Pause
- **Instance picker upgrades** — role-privilege badge and click-to-expand roles panel
- **Cached user messages** — collapsible, scrollable UI for long cached prompts
- **`extension_build` `status_message`** — surface build status text from the tool
- Workspace clone perf: blob fetches deduplicated across branches

### Fixes
- Opus 4.7: explicitly set `thinking.display='summarized'` (was relying on default)
- Sent messages now queue per-chat instead of via the global `isRunning` flag
- `renderMessages` reads per-chat `isRunning` so background streams no longer bleed into the foreground chat's UI
- Removed undefined `snTabs` reference in `iframe_tool` nav listener
- Workspace dirty flag reconciles when edits cancel out
- All tool handlers now route via `options.chatId` first
- Instance picker: replace dead `/api/now/ui/user` fallback with a `sys_user` query and display username
- Instance picker dropdown width clamped to viewport; z-index raised above sibling popovers
- Skills: pointer cursor applied to the whole dropdown container, not just items

---

## v0.8.0

### Features
- **Opus 4.7 support** — added Opus 4.7 with adaptive thinking API (`thinking.type: 'adaptive'` + `output_config.effort`); Opus 4.7 OAuth is now the default provider

### Fixes
- OAuth status and credits pill visibility in sidepanel mode

---

## v0.7.0

### Features
- **Smart Documents create** — create documents directly from the Smart Documents page with editable titles and larger modal
- **Approval popup improvements** — instance name badge and context badges moved to top-right corner
- **Workspace auto-rebase** — dirty files auto-rebase when remote base changes; diff runs sync before computing

### Fixes
- Cache-busted external fetch calls (GitHub API, web_fetch, credits check, token validation)
- Security: whitelist validation for table and sys_id in URL paths
- Tab injection race condition for already-complete tabs
- card_list & timeline expand broken by CSP
- dispatch_event key info passthrough in extension mapper

---

## v0.6.0

### Features
- **Multi-instance support** — agent can see and interact with all connected ServiceNow instances
- **Remote file attachments** — attach remote files on the chat
- **Workspace remote sync** — auto-syncs with remote before reporting dirty files; `include_git_ignored` param for ls/grep/status/diff

### Fixes
- Multi-instance connection issues resolved
- File store stability: screenshots_map pointer, stale index validation

---

## v0.5.0

### Features
- **Multi-repo workspaces** — workspace list action, dot-path support, multi-repo header/dropdown
- **Streaming safety** — fix image/file injection during streaming and pause safety
- **Context indicator** — updates after each API call instead of only at end
- **Workspace write** — binary format conversion and file_id tracking fixes

### Fixes
- Icon flattened to remove transparency for Chrome Web Store compatibility
- Cache-busted favicon (v3)

---

## v0.4.0

### Features
- **Permission tiers** — per-instance Manual/Auto modes with CRUD presentation for ServiceNow tools
- **Smart Documents** — persistent versioned markdown documents with edit, diff, and preview
- **Workspace sync** — push/pull with remote, discard action, branch-aware operations, behind/conflict detection
- **Unified file store** — `file_id` on all content, `get_file` tool, `web_fetch` save_file, workspace write file_id
- **GitHub integration** — workspace tool with GitHub support
- **Claude 4.6 adaptive thinking** support
- **Browser notifications** when agent finishes or needs tool approval in background
- **Header redesign** — model-name status pill (green/red), workspace/branch status, icon-only Browse with AI button
- **OAuth auto-refresh** — seamless token renewal instead of showing "Expired"
- **Prompt user tool** — agent can ask user for input mid-task
- **Display & inline templates** — rich rendering for tool outputs
- **Screenshot tools** — capture and download screenshots from widgets and browser iframe
- **Extension dev-server** for local development

### Fixes
- Security hardening for sandbox and iframe isolation
- Normalize string-ified tool args at parse boundary (edit tools no longer fail on string params)
- Workspace: gitignore false positives, file deletion handling, transaction awaits
- OAuth token auto-refresh on expiry instead of stale "Expired" status
- Green dot no longer shows without active ServiceNow tabs
- Modal edit/diff fill, prompts scroll, full-page CSS, container targeting
- Diff view header responsiveness and close button
- Settings page uses smart sync and filters gitignored files
- Various icon and favicon updates

## v0.3.0

- Claude 4.6 support with proxy config
- Sandbox security fixes
- Persistent chrome-extension:// URLs for file downloads
- Workspace file_ids at clone, async workspace resolution
- Reload button on home view, favicon update, reopen app after reload

## v0.2.0

- Cross-origin widget debug tools via postMessage bridge
- Skill tool system with sandboxed iframes
- iframe_tool controlled actions (scroll, resize, get_properties, set_style, dispatch_event, select_option)
- Proxy for OpenAI/OpenRouter to Anthropic API adaptation
- Chrome extension with side panel support

## v0.1.0

- Initial release
- Multi-tab iframe browser with fullscreen chat overlay
- Shadow DOM support and accessibility filtering for element scanning
- Tool permission system with settings panel and scope management
- IndexedDB storage with scope management
- Version history tracking with revert functionality
- Inline change tracking with undo/redo per AI response
- XML export for chat changes
- Automatic chat title setting and record delete functionality
- ServiceNow-style artifact cards UI
- Snackbar notifications replacing alerts
- State persistence and chat management
- Codemap generation, `read_lines`, `search_code`, and `code_outline` tools
- Chat search with snippet navigation and match highlighting
- SVG icon system with granular iframe_tool permissions
- Collapsible JSON/code formatting with syntax highlighting
- Deep screenshot mode and XHR interception
- Network request status and duration tracking
- Scroll following behavior during streaming
- `servicenow_diff_edit` with partial success handling
- AI Skills system with CRUD operations and `get_skill` tool
- OpenRouter credits display and metrics tracking
