---
name: runtime-debugging
description: Inspect and drive the AppAgent extension's OWN runtime with the runtime_inspect tool while developing the extension. Dev-mode only — the tool and this skill are hidden unless the extension-dev workflow is active (deploy folder connected).
devOnly: true
---

# Runtime Debugging (runtime_inspect)

`runtime_inspect` is a DEV-MODE-ONLY tool for introspecting the extension you are developing: page globals, IndexedDB, service-worker state, plus safe UI driving (chats/views/screenshot). All state access is CSP-safe — `get`/`call`/`set`/`dispatch` operate on existing page symbols and never evaluate dynamic code. It runs in the panel page (not the js_eval sandbox, not the SW). It is available only when Reload rebuilds from the workspace — extension-dev skill active AND deploy folder connected. Outside dev mode every call errors and the tool is hidden from the roster.

**Source of truth is the workspace repo — grep `src/` before evaluating or calling anything.** All function/global names below are real symbols in the workspace repo's `src/`.

## Key page globals (action: ui_state / get)

| Global | File | Meaning |
|---|---|---|
| `currentChatId`, `chats` | core/030-config.js | Active chat id, all chats map |
| `currentView` | core/130-indexeddb.js | 'chat', 'home', 'dashboard', … |
| `runningChatIds`, `pausedChats` | core/030-config.js | Per-chat run/pause flags |
| `activeStreamingChatId` | core/030-config.js | Chat with focused stream |
| `pendingToolApprovals` | core/030-config.js | Parked approval prompts |
| `chatWidgets` | core/030-config.js | Widgets per chat |
| `lastApiError`, `llmConnectionStatus` | core/030-config.js | LLM health |
| `activeSkills`, `skills` | core/030-config.js | Skill state |
| `hooksEnabled` | core/040-hooks-history.js | Auto-title/tldr/links/caveat |
| `_agentBusPort` | app/045-agent-port-bridge-page.js | Page↔SW port |

## Actions & examples

- `{action:'ui_state'}` — one-shot snapshot of all of the above (chats capped at 50, safe-serialized).
- `{action:'get', path:"chats['chat_123'].messages[5]"}` — CSP-safe read of any window path (dot + bracket syntax).
- `{action:'call', path:'renderChatList'}` / `{action:'call', path:'SubAgents.getById', args:['sub_x']}` — CSP-safe invocation; `this` = parent object.
- `{action:'set', path:'sidebarCollapsed', value:true, call_after:'renderChatList'}` — CSP-safe **write** of a page state variable: resolves the PARENT of the path and assigns the final segment (any JSON value); optional `call_after` invokes a function path with no args afterwards so the UI re-renders from the new state. Returns the safe-serialized `old_value` and `called_after`. Errors clearly if the parent path doesn't exist.
- `{action:'dispatch', event:'messagesAppended', payload:{chatId:'chat_123'}}` — **bus target (default)**: `AgentEvents.emit(event, payload)` in page context (app/035-agent-events.js) — invokes the REAL page-side handlers (re-renders, chat updates). Emit is synchronous, handler throws are swallowed + console.error'd. Returns `had_listeners` so you can tell whether anything was subscribed.
- `{action:'dispatch', target:'sw', event:'toggle-pause', payload:{chatId:'chat_123'}}` — **sw target**: posts `{type: event, ...payload}` to the service worker over the agent bus port (`_agentBusPort`), hitting the inbound switch in worker/130-port-bridge.js. Errors if no port is connected.
- `{action:'dispatch', target:'dom', selector:'#sendBtn', event:'click'}` — **dom target**: DOM event on the **panel page's own document** (NOT the ServiceNow iframe — use iframe_tool for that). Plain click → `el.click()`; other events construct the right class (MouseEvent for mouse events, KeyboardEvent for key* — pass `options:{key:'Enter'}` —, InputEvent/Event with bubbles for input/change). Returns `matched:false` (success, not an error) when the selector finds nothing.
- `{action:'db', op:'list'}` → store names; `{action:'db', op:'query', store:'chats', limit:5}`; `{action:'db', op:'get', store:'skills', key:'ui-driver'}`; `{action:'db', op:'count', store:'chats'}` → `{store, count}` (IDBObjectStore.count — cheap, no record reads). Actual stores: `action_state`, `agent_runs`, `apiProviders`, `chats`, `dashboardWidgets`, `documents`, `llmEndpoints`, `settings`, `skillAssets`, `skills`, `sub_agents`, `workspace_blobs`, `workspace_files`, `workspace_meta` — confirm with `op:'list'` first.
- `{action:'db', op:'get', store:'chats', key:'chat_123', path:'messages[3].content'}` — optional `path` drills into the fetched record (same dot/bracket syntax, walked over the PLAIN record — not window) → `{store, key, path, exists, value}`. A missing intermediate (or missing record) returns `exists:false`, **not** an error (plain `op:'get'` without `path` returns `found` + `exists`, both `false` when the key is missing) — the whole 64KB serialization budget goes to the one value you asked for.
- `{action:'db', op:'grep', store:'chats', pattern:'deploy folder', limit:10}` — regex-search the STRING leaves of every record in a store (IDB **cursor**, record-at-a-time — never getAll). Each match → `{key, path, excerpt}`: the record's primary key, the dotted JSON path inside the record (e.g. `messages[3].content`), and the match ±60 chars. Optional `flags` (default `'i'`), `key` (search one record only), `path` (search only under that sub-tree), `limit` = max matches (default 20, cap 100). ~1MB of string scanned per record — oversized string leaves are sliced to the remaining budget (not scanned fully), and each record that hits the cap is counted in `records_capped`; returns `{matches, truncated, records_scanned, records_capped}` where `truncated` means the match `limit` was hit (more matches may exist). With `key`, the result also carries `key_found` (`false` when that record doesn't exist). Invalid regex → clear error, no scan.
- `{action:'sw_state'}` — live service-worker state over the port: `runningChatIds`, pending UI tool calls, parked tool calls per chat, connected panel count, `resumeScanSettled`, `devMode`. 5s timeout if the SW is unreachable.
- `{action:'screenshot'}` — captures the panel via `chrome.tabs.captureVisibleTab`. Returns the **full** base64 data URL — the screenshot is exempt from the 64KB safe-serialization cap. ⚠️ **Limitation:** fails (with an explanatory error) when the panel runs in the **side panel** — it has no tab of its own; open the panel as a full tab (app.html) first.
- `{action:'new_chat', focus:false}` → background chat. ⚠️ This creates a **page-local temporary chat** the service worker doesn't know about — don't target it with `dispatch target:'sw'` (e.g. `pull-chat`/`run-agent`); `{action:'focus_chat', chatId}`; `{action:'set_view', view:'skills'}` (home|chat|dashboard|skills|documents|history|docs|settings).

## Dispatch event vocabularies

⚠️ **bus/sw dispatch invokes REAL handlers** — these are live controls, not simulations: they mutate run state and UI (`interrupt` aborts a live run, `toggle-pause` pauses/resumes a chat, `update-chat` overwrites SW chat state). Useful for debugging the event plumbing, but never side-effect free.

**SW-inbound port message types** (`target:'sw'` — the switch in worker/130-port-bridge.js): `run-agent`, `send-message`, `interrupt`, `toggle-pause`, `pull-chat`, `dev-mode`, `pull-debug-state`, `update-chat`, `exec-tool-result`, `exec-approval-prompt-result`, `hooks-settings`, `permissions-update`, `focus-chat`, `panel-hello`, `relay-agent-event`. Most take `chatId` in the payload. ⚠️ `exec-tool-result` / `exec-approval-prompt-result` complete PARKED tool calls — sending fabricated ones can corrupt a live run.

**AgentEvents bus event names** (`target:'bus'` — discover the full set with `workspace grep 'AgentEvents\.emit\(' src/js`). Main ones:

| Event | Meaning |
|---|---|
| `runStarted` / `runFinished` / `runCrashed` | agent run lifecycle (app/030-agent-loop.js) |
| `turnStarted`, `assistantMessageStarted`, `assistantMessage` | per-turn / per-message lifecycle |
| `streamDelta` | streaming chunk (kind: text / thinking / tool_input) |
| `toolCallStarted` / `toolCallResult` / `toolCallCancelled` | tool-call lifecycle |
| `messagesAppended` | transcript grew → re-render (payload `{chatId}`) |
| `paused`, `userInjected`, `streamAborted`, `error` | run interruptions |
| `chatTitleChanged`, `tldrChanged`, `linksChanged`, `caveatChanged` | answer-card hooks (tools/020-tool-execution.js) |
| `actionStateChanged` | progress-card updates (tools/120-actions.js) |
| `documentChanged`, `workspaceMutated`, `recordMutated` | artifact mutations |
| `toolParked` / `toolUnparked` | SW parked/unparked a UI tool call (worker/120-tool-routing.js) |
| `llmTransportStatus`, `silentHookState`, `notifyFinish` | transport / hook / notification signals |

Emitting an event with a payload shape the handlers don't expect throws inside the handler (swallowed by the bus, logged to DevTools console).

## Finding data in IDB: grep → get workflow

The `chats` store is far too big to `query` and eyeball. Instead:

1. `{action:'db', op:'grep', store:'chats', pattern:'cache heartbeat', limit:5}` → matches like `{key:'chat_1783194987859_mgdqggqyp', path:'messages[12].content', excerpt:'…keep the prompt cache warm…'}`.
2. `{action:'db', op:'get', store:'chats', key:'chat_1783194987859_mgdqggqyp', path:'messages[12]'}` → read the exact message (or a parent path for surrounding context) without pulling the whole multi-MB record through the 64KB serialization cap.
3. Narrow long scans with `path` (e.g. `path:'title'` greps only titles) or `key` (one record).

## Safe UI-driving recipe

1. `new_chat {focus:false}` — never steal the user's current view unless asked.
2. `focus_chat {chatId}` when you do need to look at it.
3. `set_view` to reach panels (skills, settings, dashboard).
4. `screenshot` to SEE the result (full-tab panel only).
5. `get`/`call` to assert state — e.g. `get {path:'currentChatId'}` after `focus_chat`.

## How the tool is routed (one paragraph)

`runtime_inspect` is marked `headless:false` in HEADLESS_TOOLS (core/080-tools.js), so the SW's executeTool wrapper (worker/120-tool-routing.js) never runs it locally — it routes the call over the port to a connected panel (`exec-tool`), where the page-side wrapper at the bottom of tools/140-runtime-inspect.js intercepts the name before the shared dispatcher. No panel connected → the call parks until one connects (24h TTL). Results are safe-serialized: depth 6, 4KB per string, 64KB total — pull big things piecewise with `get`.

## devOnly skills

A skill with `devOnly: true` in its SKILL.md frontmatter (like this one) is embedded in the build but hidden — from the system prompt, the skills list UI, and skill-tool rosters — unless dev mode is active. Gates live in `isSkillDevHidden` (core/140-skills-engine.js), the two prompt-summary twins (ui/070-dashboard-ui.js + worker/020-page-stubs.js), and renderSkillsList (core/120-init.js).
