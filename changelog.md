# Changelog

## v1.1.24

### Features
- ChatGPT subscription accounts can now sign in with OAuth, use Codex models, see their usage limits, and choose subscription endpoints alongside API providers.
- Model setup has been polished with provider icons, automatic display names, effort controls, foldable model lists, and clearer delete and sign-out actions.

### Fixes
- Sub-agent transcripts no longer render empty or disappear during state syncing and cleanup; sleeping agents retire safely into history instead.
- Sub-agent usage totals and per-model cost breakdowns now roll up correctly.
- Reload no longer shows a false "Extension rebuild failed" message after a successful build.

---

## v1.1.23

### Features
- Active Chats list redesigned: the current chat stands out as a lifted white card with an accent bar, and unread, read, and running chats each have their own distinct visual cue.
- Live activity indicator: while an agent works you now see a pulsing "thinking" icon or the icon of the exact tool it is running, instead of a generic spinner.
- Sub-agents, documents, and other handles now get human-readable IDs derived from their names instead of random character strings.
- The main agent can now handle quick code and ServiceNow tasks itself instead of delegating everything to sub-agents.
- Pull requests opened via the raw GitHub API now appear in the sidebar alongside workspace-pushed ones, including your own merged PRs.

### Fixes
- Fixed silent data loss where a background or page save could delete chats it didn't know about — chats no longer vanish from storage.
- Fixed out-of-memory crashes on the extension page: long chats render only the visible messages, idle chats release their memory, and streaming no longer copies the entire chat on every event.
- The "Agent finished" notification no longer fires while sub-agents are still working.
- Progress cards now finalize on their own instead of hanging until an unrelated follow-up request.
- Workspace listings are much leaner, removing kilobytes of stale metadata from agent context.
- Major internal storage overhaul: chat state syncing between the page and background worker is now single-writer with build-time guards, making titles, pause state, and permissions far more reliable.

---

## v1.1.22

### Fixes
- Sub-agents can no longer spawn in a runaway loop, re-creating the same worker dozens of times.
- History now surfaces continued chats by their real latest activity instead of a stale timestamp.
- Parents no longer get a notification every time a sub-agent's tool call waits on the approval popup.
- Fixed a 400 crash when resuming or waking chats that contain images.

---

## v1.1.21

### Features
- New `get_cookie` tool lets `js_eval` make authenticated fetches against cookie-gated sites.
- Branching a workspace on a conflict now shows a recovery hint, and the new branch leaves files locked by other chats behind.

### Fixes
- Fixed tab out-of-memory crashes: large tool results now unload from memory and reload on demand.
- With multiple panels open, tool-approval popups and `prompt_user` forms now show up in all of them.
- Skill-provided tools no longer get blocked for sub-agents, and new skill tools work without an extension restart.

---

## v1.1.20

### Features
- Sub-agent tier pickers gained a "Same" option: sub-agents follow the parent's current model instead of a fixed one.
- Instance picker: stale instances can be removed with ✕, and live ones can be disabled for the agent with a toggle.

### Fixes
- Widgets now follow theme changes live, without a page reload.
- Sidebar PR cards no longer vanish after sub-agent cleanup, and reverting a dashboard widget no longer stacks duplicate history entries.
- Fixed "executeTool is not defined" when widgets are rendered from a deep link.

---

## v1.1.19

### Features
- Opus 5 is now the default model (Opus-4-8 stays selectable).
- Widgets can be pinned to Home as well as the Dashboard, follow the app's light/dark theme, and gather all their actions in one expanded view.
- Buttons inside a widget can hand work back to the agent with the new `start_chat` tool.
- Widget and document IDs in chat are clickable chips, and smart documents gained an "Edit with agent" button.
- Active Chats keeps completed and unread chats listed until you dismiss them.
- Emoji shortcodes render as real emoji, and prompt panels render markdown descriptions.

### Fixes
- Active Chats no longer lists every chat in history.
- Records edited by the agent, and pull requests opened by sub-agents, are back on the sidebar Artifacts list and the parent's links card.
- The last output is no longer missing when you open a chat while its after-response hooks are still running.
- Back/forward navigation, chat auto-scroll and New Chat drafts are reliable again, and the reasoning-effort bar is visible in dark mode.
- Fixed five chat-page memory leaks and a stale `list_instances` report.

---

## v1.1.18

### Fixes
- Fixed the storage stalls behind frozen tools and vanishing chats: the extension no longer shuts itself down mid-write, a wedged database is now detected and recovered automatically, and saves back off instead of piling up after a timeout.
- The usage pill no longer shows a red 100% when session usage is actually 1%.

---

## v1.1.17

### Fixes
- Fixed the recurring 30-second storage timeouts: screenshots and other large payloads now live in their own store, saves are much slimmer, and older chats migrate to the new format quietly in the background.
- Mid-stream "Overloaded" errors no longer kill a run — the agent now retries with a live countdown, like it already did for rate limits before the stream starts.
- Long background scripts no longer fail from URL length limits, and scripts on the same instance run one at a time instead of racing.
- Skill tools that wait or sleep are no longer throttled to once a minute when the panel is closed.
- `servicenow-eval` runner hardening: guarded init, idempotent teardown, and loud failure when script execution is denied.

---

## v1.1.16

### Features
- Home Active Chats: state-filter pills, per-card pin/dismiss, auto-sizing panel.
- Sub-agent chats get a sidebar card with a "Back to parent" button, and nicer report cards.
- Word-level highlighting in file diffs.

### Fixes
- Fixed storage going silently unreachable after sleep, Reload, or a busy boot — no more empty chat list.
- Sub-agent fixes: reports wake an idle parent, waking works after a cold restart, out-of-budget subs report instead of looping errors.
- Chat no longer jumps to the top when an answer lands.

---

## v1.1.15

### Features
- Active Chats can now be viewed as a wider grid, showing three cards per row.

### Fixes
- Chat auto-scroll is reliable again: the view sticks to the bottom while streaming and re-pins when late content arrives.
- Tool-approval popups are no longer lost when you act in another chat, and background tabs now flag pending approvals.
- Sub-agent completions now reliably wake their parent chat, even across extension restarts.
- Fixed memory leaks from screenshots and other large payloads staying in memory; they now load on demand when a chat is opened.
- Record changes made by widgets no longer vanish from the sidebar Artifacts list.
- Web page extraction no longer includes script and style text, and browser actions are guarded against targeting the wrong tab.
- Jobs rows now show unread bold for activity that lands while the panel is hidden, and multi-line Recent prompt chips paste correctly.
- A prompt and tool-roster audit fixed two dozen small consistency issues across agent roles.

---

## v1.1.14

### Features
- Tool profiles: the main agent and each sub-agent now get a tool roster tailored to their role, with a profile chip shown on sub-agent worker cards.
- Leaner system prompt: tool guidance now lives in the tool descriptions themselves, and the main agent follows a pure-orchestrator policy in orchestrator mode.
- Sub-agent handling was simplified: runs are always awaited, so results come back without extra polling.

### Fixes
- Fixed an intermittent bug where the extension lost IndexedDB access until Chrome was restarted.
- Multi-line sub-agent report summaries are no longer cut to their first line in parent-chat notices.

---

## v1.1.13

### Features
- Orchestrator mode: the main agent plans and delegates work to smaller, faster sub-agent workers instead of doing everything itself, with sensible per-task model tiers.
- Experimental: tools now load on demand instead of all upfront, shrinking the core tool set and freeing up context for the agent.
- Active chats now show live state badges — waiting for input, awaiting approval, waiting for sub-agents, or PR merged — so you can tell at a glance what each chat is doing.
- New global settings for context window, max tokens, and thinking budget, plus context-usage warnings and sub-agent saturation gauges so long runs don't quietly overflow.
- The sidebar tracks merged PRs with a MERGED badge and preserves the original diff for files edited in a merged PR.
- Updated Help page documenting sub-agents, tiers, saturation, permissions modes, and LLM endpoints.

### Fixes
- Fixed several cross-chat leaks where one chat's PRs, edited files, or streaming text could show up in another chat's sidebar.
- Hardened the cross-chat workspace file lock against silent overwrites, with per-file ownership attribution and clearer warnings.
- PRs no longer go missing from the sidebar, and sub-agent PRs and edited files now roll up into the parent chat.
- Jobs dropdown fixes: unread bold no longer reverts, "Completed Today" no longer counts chats that merely started today, and the phantom notification bell is gone.
- Many design and consistency fixes across chat cards, the active-chats dropdown, and the New Chat page.

---

## v1.1.12

### Fixes
- Fixed the extension build breaking on the new GitHub setup popup (the service-worker bundle was missing a stub for the page-only tool).

---

## v1.1.11

### Features
- Workspace files now live in the chat sidebar: open one to view it, diff it, or browse past versions, with a chip showing which chat owns each change.
- You can now merge a PR straight from the sidebar — squash-merged with the PR title, and your workspace syncs afterwards.
- LLM endpoints are now named objects with their own Settings section, and the default providers were refreshed to the July 2026 model lineup.
- Rate limits are handled far more gracefully: requests retry automatically, chat shows a live retry countdown instead of a stuck "Thinking…", and messages tell apart a busy endpoint from running out of credits.
- A new GitHub setup popup walks you through connecting your account and cloning your repo.
- Your workspace keeps itself in sync automatically as you navigate, switch chats, or return to the extension tab.

### Fixes
- Two regression sweeps over recent releases fixed 18 small issues.
- Sub-agents that hit a rate limit but recovered can now report their results back to the parent chat.
- Garbled characters in embedded skill content are fixed.
- Workspace changes made in one panel now show up in the others, and the file modal no longer flashes when switching views or files.

---

## v1.1.10

### Features
- New Links card: the agent can attach relevant links right below the TL;DR, and pushed PR links now show up in the chat sidebar.
- Jobs dropdown got smarter: chat rows show sub-agents and a context-usage ring, unread chats stand out email-style, and the sub-agent drawer is docked inside the expanded card.
- Workspace dropdown opens instantly, and the workspace pill has a "This chat" section listing the workspaces this chat has touched.
- Workspace ls, grep, and diff now warn when another chat owns the workspace, and grep keeps output short by default.
- Clicking the usage pill now refreshes your usage and opens a dropdown breaking down your limits in detail, updating live as fresh numbers land.
- Sub-agent chats have a clearer header with a link back to the parent chat, and internal tools show friendly names instead of raw identifiers.

### Fixes
- Switching chats mid-run no longer leaves a blank pane, leaks another chat's streaming text, or hides text the agent streamed between tool calls.
- Sent messages appear as normal messages immediately — no more "Queued" badge.
- The Continue button no longer shows up after a run that ends with just an answer card, and answer cards land in the right chat.
- Chat text rendering is hardened against HTML injection.
- Pushing a new PR without a description now falls back to your commit message.

---

## v1.1.9

### Features
- Jobs dropdown is cleaner: timestamps are right-aligned, the Recent tab is gone, and row icons are clearer at a glance.
- An unread finished chat now stays in Active Chats until you actually open it, no matter how old it is, instead of dropping out after a few minutes.

### Fixes
- The legacy frame-busting guard no longer redirects the extension panel to your instance.

---

## v1.1.8

### Features
- New Jobs dropdown shows your running and recent agents in tabs, with live progress, an always-visible badge, a pinned section, and per-chat dismiss.
- Workspace dropdown now sorts by most recently used, lets you clone or pin a workspace, and collapses long sections by default.
- Usage pill now shows your extra usage as a percentage with a used/limit tooltip.

### Fixes
- Stale approval requests are now swept out automatically.
- Model pill tooltip was broken in the workspace dropdown.

---

## v1.1.7

### Features
- Helper agents now live in the sidebar with live progress, tool count, and a link to open their chat.
- Documents can be kept private to a chat or shared, and no longer leak into chats they don't belong to.

### Fixes
- More reliable instance picker: no false "disconnected", click-to-select, no session loss on switch, correct role badge.
- You won't be asked to approve the same fetch twice.

---

## v1.1.6

### Features
- You can now branch a workspace to work on changes separately, or move unfinished edits from one workspace to another — and merging brings those edits back automatically.
- Workspaces now take up much less space — identical files are saved once instead of being copied again and again.
- If the model declines a request you'll see a clear message instead of a blank reply, and responses stay fast.
- Helper agents are no longer cut off in the middle of a task — they get a heads-up as they near their limit but are allowed to finish and report back, and the limit itself is higher than before.

### Fixes
- Several fixes to merging and syncing workspaces — merging is no longer blocked by ignored files, re-downloading a workspace remembers where it branched from, and the "behind" indicator updates correctly.
- Widgets no longer slowly grow taller on their own.
- The agent's final reply now repeats any important conclusion or question, instead of leaving it buried in the hidden step-by-step details.
- Helper agents now pick up where they left off if the extension restarts in the background, instead of stopping.
- Pushing your changes to GitHub now works in several cases that used to fail.

---

## v1.1.5

### Features
- New `ui-driver` skill for driving tricky Service Portal / ESC form widgets (select2, native inputs, date/datetime, duration, list collector) on both catalog and custom widgets.
- GitHub REST calls no longer prompt on every request — reads run silently, writes still confirm.
- Reload now rebuilds and redeploys the extension first when a deploy folder is connected.
- Merged workspaces are cleaned up automatically on the next remote sync.

### Fixes
- More reliable synthetic clicks (real `MouseEvent`s); `get_properties` no longer throws on a no-match selector.
- `dispatch_event` rejects unknown events consistently across both backends.

---

## v1.1.4

Stability release.

### Fixes
- Active skills were not loading on the system prompt.
- Actions no longer run twice when the panel reconnects mid-task.
- Chat titles update promptly, and the chat view no longer flickers while the agent works.
- Fixed crashes when viewing certain embedded content and stale widget screenshots.

---

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
