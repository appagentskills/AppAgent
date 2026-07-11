# Getting Started {#getting-started}

AppAgent is an AI Agent for your ServiceNow instance. It helps you query data, edit records, browse pages, and automate tasks using natural language.

AppAgent **auto-detects every ServiceNow instance** you have open in the same Chrome profile — no setup or connection string needed. Open a tab on an instance and the Agent can target it; ask it to *list instances* to see them all (with your roles and connection status).

:::tip
**Quick Start:** Type a message in the chat and press Enter. The Agent will understand your request and use the right tools automatically.
:::

# Quick Guides {#guides}

## Starting a Chat {#guide-chat}

1. Click **+ New Chat** in the sidebar
2. Type your request (e.g., "Show me all incidents created today")
3. Press **Enter** to send
4. The Agent will respond and may use tools to complete your task

## Browse with Agent {#guide-browse}

1. Navigate to any page on your ServiceNow instance
2. Click the AppAgent icon and open the side panel
3. Ask the Agent about what you see: "What errors are on this page?"
4. The Agent can take screenshots, click elements, and fill forms

## Edit Records {#guide-edit}

1. Ask: "Update the script include MyUtils to add error logging"
2. Review the changes shown in the chat
3. Use the **Undo** button if needed
4. All changes are tracked in the version sidebar (right panel)

## Using Skills {#guide-skills}

1. Go to [Skills](app:openSkillsView) page from sidebar
2. Click **Activate** on a skill to enable it
3. Active skills give the Agent new abilities and knowledge
4. Deactivate skills you don't need to keep responses focused

## Create Widgets {#guide-dashboard}

1. Go to [Dashboard](app:openDashboardView) page
2. Click **Add Widget**
3. Describe what you want: "A chart showing incidents by priority"
4. The Agent generates an interactive widget

## Attach Images {#guide-images}

1. Click the **Image** button in the input area
2. Select an image file or paste from clipboard
3. Type your question about the image
4. The Agent can analyze screenshots, diagrams, and UI elements

:::tip
Use image attachments to show the Agent error screenshots, UI mockups, or any visual content you need help with.
:::

# Pages {#pages}

## Chat {#page-chat}

The main conversation interface where you interact with the Agent. [Start New Chat →](app:startNewChat)

- **Message Area** — Shows conversation history
- **Input Box** — Type your messages here
- **Pause Button** — Stop Agent execution if needed
- **Context Indicator** — Shows how full the context is (click to summarize)
- **Chat Sidebar** — Version history plus pushed PRs, workspace files, and sub-agent workers (right panel)

## Dashboard {#page-dashboard}

A **dynamic, smart dashboard** with Agent-generated widgets. [Open Dashboard →](app:openDashboardView)

Unlike traditional dashboards, widgets are generated through natural language prompts. Describe what you want and the Agent creates it instantly. Need changes? Just regenerate with a new prompt.

- **Add Widget** — Describe what you want in plain language
- **Drag & Drop** — Rearrange widgets
- **Resize** — Adjust widget sizes
- **Regenerate** — Instantly update any widget with a new prompt
- **Import/Export** — Save and share dashboards

Widgets are also **dynamic at runtime** — they have access to your ServiceNow instance and can fetch live data, making your dashboard always up-to-date.

## Documents {#page-documents}

**Smart Documents** — persistent, versioned Markdown documents the Agent builds and updates — are listed here. In the sidebar, **Documents** is grouped under **Dashboard**.

## Skills {#page-skills}

Manage Agent skills that extend its capabilities. [Open Skills →](app:openSkillsView)

- **Activate/Deactivate** — Toggle skills on or off
- **New Skill** — Create custom skills
- **Import/Export** — Share skills between instances
- **Edit with Agent** — Modify skills using Agent assistance

Skills can provide **knowledge** (instructions, best practices) and **custom tools** (executable JavaScript functions the Agent can call). Custom tools run in isolated sandboxes with `executeTool()` access.

## Tools {#page-tools}

Per-tool permissions and source/schema viewers are available in [Settings → Tool Permissions](app:toggleSettingsView).

- **Browser Code** — Run JavaScript in an isolated sandbox
- **ServiceNow API** — Query and modify records
- **Run Background Script** — Execute server-side scripts on the connected instance
- **Edit Code/Scripts** — Make changes to scripts using search-and-replace
- **Browser Control** — Navigate, interact with pages, impersonate users
- **Display Widget** — Render interactive HTML widgets
- **Display Cards** — Render structured cards, tables, and timelines
- **Take Screenshot** — Capture screenshots of the browser, widgets, or elements
- **Manage Skills** — Create and manage Agent skills
- **Workspace** — Read, write, and edit files in the per-chat workspace
- **Smart Documents** — Build and query structured documents
- **Prompt User** — Ask the user for structured input via inline forms
- **Web Fetch** — Fetch and read pages from the public web
- **GitHub Setup** — Open a popup to connect a GitHub account or clone a repo into a workspace
- **Action Updates** — Show live progress pills and one-click action buttons
- **Read Attached File** — Read text files attached by the user

## Settings {#page-settings}

Configure AppAgent preferences. [Open Settings →](app:openSettingsPageView)

- **Agent Model** — Choose which LLM to use
- **API Providers** — Add or edit providers (Anthropic, OpenRouter, custom). Supports API-key and OAuth (Claude Code sign-in) providers
- **LLM Endpoints** — Named `URL + API key` pairs; point the extension at any OpenAI-compatible LLM API
- **Sub-Agent Model Tiers** — Map the small / medium / large tiers to concrete models
- **Reasoning Effort** — Per-provider effort selector: `(default)`, `low`, `medium`, `high`, `xhigh`, `max`. `xhigh` is accepted on Opus 4.7/4.8 and Fable/Mythos 5 on Anthropic directly (other models top out at `high`/`max`); OpenRouter maps unsupported values to the nearest supported level
- **Max Tokens & Thinking Budget** — Global caps on response length (64k default) and extended-thinking budget (32k default)
- **Context Window** — Set the assumed context-window size that drives the context indicator and saturation warnings
- **App Scope** — Set the scope for new records
- **Display** — Toggle API stats, compact mode, and keep-display-awake
- **Hooks** — Enable auto-title generation, "Agent finished" notifications, and other automation
- **Large Content Caching** — Set when large results get cached (1K to 100K tokens)
- **Tool Permissions** — Control which tools run automatically
- **System Prompt** — Customize the AI's system instructions
- **Data Management** — Export, import, or delete data

## History {#page-history}

View and manage all your conversations. [Open History →](app:openHistoryView)

- **Search** — Find chats by title, content, tools used, or widgets
- **Pin** — Pin important conversations for quick access
- **Export** — Download individual chats or all history
- **Stats** — View total conversations, pinned count, and accumulated cost
- **Preview** — See chat previews with user/agent messages

## Help {#page-docs}

This page! Browse the full documentation for AppAgent. The sidebar nav item is labeled **Help** (❓ icon). [Open Docs →](app:openDocsView)

- **Table of Contents** — Navigate sections via the right sidebar
- **Download** — Export the documentation as a Markdown file

# Features {#features}

## Agent Tools {#feature-tools}

The Agent has access to powerful tools:

| Tool | What it does |
|------|--------------|
| **Browser Code** | Execute JavaScript in an isolated sandbox with `executeTool()` access |
| **ServiceNow API** | Read, create, update, delete records |
| **Run Background Script** | Execute server-side scripts on the connected instance |
| **Edit Code/Scripts** | Modify scripts using search-and-replace |
| **Browser Control** | Navigate pages, click, fill forms, type per-character, wait for selectors/text/URL, select options, dispatch events, scroll, resize, inspect, impersonate, debug widgets |
| **Display Widget** | Display interactive HTML widgets inline in chat |
| **Display Cards** | Render structured cards, tables, lists, and timelines without writing HTML |
| **Take Screenshot** | Capture screenshots of the browser, widgets, or specific elements for visual analysis |
| **Screenshot by ID** | Retrieve a previously captured screenshot by ID without re-taking it |
| **Manage Skills** | Create, update, activate, and manage Agent skills (supports surgical search-and-replace edits) |
| **Workspace** | Per-chat scratchpad for files: read, write, edit, list. Cross-chat conflicts are surfaced before overwriting |
| **Smart Documents** | Build and query structured documents that the Agent can navigate without flooding the context |
| **Prompt User** | Show inline forms (text, select, multi-select, confirm) to collect structured input or confirm plans |
| **Web Fetch** | Fetch and read pages from the public web |
| **GitHub Setup** | Open a popup to connect a GitHub account or clone a repo into a workspace |
| **Action Updates** | Render live progress pills (running / stuck / done / error) and one-click action buttons in the chat |
| **Read Attached File** | Read text files attached by the user in the conversation |

## Tool Permissions {#feature-permissions}

Control how tools execute. Configure in [Settings](app:openSettingsPageView):

- **Auto** — Tool runs without asking
- **Ask First** — Shows approval prompt before running
- **Disabled** — Tool cannot be used

**Per-instance mode:** Each connected instance has a permission tier that sets its write defaults:

- **Manual** — You approve each write operation (create / update / delete, form fills). Writes default to *Ask First*
- **Auto** — The Agent runs write operations without asking

Switch modes from the instance dropdown or [Settings](app:openSettingsPageView). Reads are always allowed; the per-tool controls below override the tier.

**Granular Controls:**

- **ServiceNow API** — Separate permissions per HTTP method (GET, POST, PUT, PATCH, DELETE)
- **Browser Control** — Separate permissions per action (navigate, click, fill, select option, dispatch event, scroll, resize, impersonate, and more)
- **Manage Skills** — Separate permissions per action (create, update, add/update/delete files, activate, deactivate)

Confirmation dialogs are color-coded by severity — **blue** (routine), **orange** (caution), **red** (destructive).

:::tip
Set destructive tools (DELETE, PUT) to "Ask First" for safety. Skill activation is disabled by default.
:::

## Version History {#feature-history}

All changes are tracked automatically:

- **Undo** — Revert individual changes
- **Redo** — Restore reverted changes
- **Download XML** — Export all changes to XML

Access version history from the panel on the right side of the chat.

## Browser Panel {#feature-browser}

The Agent can control browser tabs to see and interact with pages:

- **Navigate** — Open pages in a browser tab for the Agent to interact with
- **Screenshots** — Agent can see the page content
- **Click/Fill** — Agent can interact with elements (fires the full keydown→input→keyup→change chain with a React-safe value setter)
- **Type** — Send per-character realistic key events so debounced / autocomplete handlers fire reliably
- **Wait For** — Wait for a selector to appear or disappear, for text to be present, or for the URL to match a pattern — instead of blind `setTimeout`
- **Interact** — Click elements, fill forms, select options, dispatch events
- **Scroll/Resize** — Scroll pages and resize the viewport
- **Inspect** — Get element properties, computed styles, and dimensions
- **Console/Network** — View errors, logs, and network requests
- **Impersonate** — Switch to another user session
- **Full Page Mode** — Open AppAgent in a full browser tab

**Widget Debugging:** The browser panel can also open and debug HTML widgets. The Agent can take screenshots, inspect DOM, and edit widget HTML directly.

## Actions & Live Progress {#feature-actions}

Long-running agent workflows surface live state in the chat instead of going silent between tool calls:

- **Progress pills** — A single mutating card with a color-coded state pill (running / stuck / done / error) next to the chat title. Previous distinct steps are tucked into a "Previous steps" trail
- **Action buttons** — The Agent can render one-click buttons in the chat to trigger follow-up workflows
- **Header action pills** — The header auto-renders any active actions, with icon-only responsive collapse
- **Streaming dot** — The chat list shows a per-chat agent-running indicator (suppressed when paused)
- **"Agent finished" notification** — If you tab away or switch Chrome windows mid-run, a desktop notification fires when the Agent finishes
- **Answer cards** — After a response the Agent can attach a **TL;DR** summary card and a **Links** card of relevant links (records, PRs, docs) below the answer

## Active Chats & Jobs {#feature-jobs}

A header pill opens the **jobs dropdown** — a live view of your chats and background work:

- **Active chats** — Running or unread-finished chats, each with a **context-usage ring**; unread chats are emphasized in **bold** (email-style) after any activity while you're away
- **Sub-agent cards** — Worker sub-agents nest under their parent chat, with a chat-view modal to read their transcript
- **Expand modal** — Pop the list out to a full modal with a **columns / sections** layout toggle
- **New Chat page** — The expanded Active Chats panel is also embedded on the New Chat page for an at-a-glance overview

## Usage & Limits {#feature-usage}

A **usage pill** in the header tracks your API usage and remaining limits. Hover for a native tooltip, or click to open a dropdown with a rich breakdown of usage limits and remaining credits. Credit balances refresh automatically when you return to the tab.

## Rate-Limit Handling {#feature-ratelimit}

When a provider returns a **429 / 529** (rate limit or overload), AppAgent retries automatically instead of failing:

- **Automatic backoff** — Transport-level jittered backoff with escalating retries; sub-agents throttle back under a shared stream semaphore
- **Live status** — The chat shows an inline rate-limit status with a **retry countdown** instead of a stuck *Thinking…*, and distinguishes provider saturation from waiting on sibling agents
- **Credit exhaustion** — Ambiguous 429s that actually mean "out of credits" are detected via the usage API and surfaced clearly

## Sub-Agents {#feature-subagents}

The Agent can spawn **background worker agents** to handle heavy or parallel work without cluttering the main chat. Each sub runs in its own chat and context, then reports a distilled result back to the parent.

- **Spawn** — Delegate searches, audits, bulk edits, or deep investigations to a sub-agent
- **Model tiers** — Each sub runs on a **small / medium / large** tier, or `same` to match the parent's model. Map tiers to models in [Settings → Sub-Agent Model Tiers](app:openSettingsPageView)
- **Workers strip** — Running subs appear as live chips above the chat input; open one to watch its progress or transcript
- **Manage** — The Agent can check a sub's status, wake it with follow-up work, or stop it
- **Pool** — Concurrent subs are capped by a shared worker pool; extras queue automatically

## Workspace {#feature-workspace}

Each chat has its own **workspace** — a per-chat file scratchpad the Agent can read, write, and edit. Useful for staging plans, notes, generated artifacts, or multi-step task state.

**Cross-chat ownership:** every workspace mutation stamps the file with the chat ID, title, and timestamp. If a different chat tries to mutate the same file:

- If the owning chat is **active**, the write is blocked
- If the owning chat is **dormant**, the Agent gets a `cross_chat_warning` and can pass `force: true` to override
- `read` and `status` surface the owner and a human-readable "X minutes ago" timestamp

This prevents two parallel chats from silently clobbering each other's work.

**GitHub sync:** Cloned workspaces auto-sync with GitHub on page navigation, chat switch, and tab focus, so merged or updated branches stay current.

## Chat Sidebar {#feature-sidebar}

The right-hand chat sidebar gathers the artifacts of the current chat in a single scroll — **pushed PRs**, **workspace files**, **version history**, and **sub-agent workers**:

- **Pushed PRs** — Each PR the Agent opens from this chat shows as a row with its title and **target branch**. Click **Merge** to squash-merge it (the PR title becomes the commit title) and auto-sync the affected workspace
- **Workspace files** — Files the Agent created or changed appear as rows; open one to **view** it, see a **diff** (diff-first, with file-nav arrows), or browse prior **versions**. A color-coded chip marks the owning chat, and pushed rows link to their PR
- **Workers** — Running and finished sub-agents appear as cards; open one to watch its live progress or read its chat in a modal. Collapsed cards show tool-call, files-edited, and PRs-opened counters

## Pause & Send-During-Stream {#feature-streaming}

You don't have to wait for the Agent to finish before reacting:

- **Pause** aborts the in-flight LLM call immediately via `AbortController` (not at the next agent-loop iteration)
- **Send mid-stream** aborts the current call and races any running tools via an event-driven interrupt resolver. A translucent *Queued* bubble renders the moment you press send, and the spinner switches to *Interrupting…*
- **Per-chat scope** — Pause only affects the current chat. Background chats and parallel runs keep going
- **Concatenating queue** — Sending two messages during the abort/restart window concatenates them instead of dropping the first

## Large Content Caching {#feature-caching}

When data is too large to fit in the conversation (over 4K tokens by default), it gets automatically cached. Instead of overwhelming the context, the Agent receives a smart outline and can explore the content piece by piece.

**How it works:**

1. A tool returns a large result (e.g., a big API response or long script)
2. The content is automatically cached
3. The Agent sees a summary showing the structure and contents
4. The Agent can browse, search, and read specific parts as needed

**What the Agent can do with cached content:**

- **Browse the outline** — See the structure at different detail levels, from a quick overview to a deep dive
- **Search** — Find specific text or patterns within the cached content
- **Read sections** — Access specific parts of the data without loading everything

**Settings:** You can adjust the cache threshold in [Settings](app:openSettingsPageView) (1K to 100K tokens). Lower values cache more aggressively, higher values let more data through directly.

:::tip
**Why this matters:** Caching keeps conversations fast and focused. The Agent works smarter by only pulling in the specific data it needs, rather than flooding the context with huge responses.
:::

## Context Saturation {#feature-saturation}

The **context indicator** by the chat input tracks how full the conversation is. As it fills, the Agent receives escalating nudges:

- **Past 50%** — A warning to wrap up the current step and delegate remaining heavy work to fresh sub-agents (model quality degrades as context grows)
- **Full (100%)** — A stop-now prompt to report conclusions immediately and hand off unfinished work to a new chat or sub-agent

Click the context indicator to summarize the conversation into a fresh chat.

# Tips & Shortcuts {#tips}

| Action | How |
|--------|-----|
| Send message | <kbd>Enter</kbd> |
| New line | <kbd>Shift + Enter</kbd> |
| New chat | Click **+ New Chat** |
| Search chats | Use search box in sidebar |
| Pause Agent | Click **Pause** button |
| Summarize context | Click the context percentage circle |

:::tip
**Pro tip:** Be specific in your requests. Instead of "fix this", say "fix the null reference error on line 42".
:::

# Advanced {#advanced}

This section covers advanced features, header buttons, import/export formats, and technical details about how AppAgent works.

## Dashboard Header Buttons {#adv-dashboard-header}

The dashboard header contains several action buttons:

| Button | Description |
|--------|-------------|
| **Toggle Sidebar** | Show or hide the left sidebar navigation |
| **Open Standalone** | Open the dashboard in a new browser tab for standalone viewing |
| **Headers** | Toggle visibility of widget headers on the dashboard. When hidden, widgets display in a cleaner view |
| **Regenerate All** | Regenerate all widgets on the dashboard using the Agent. Useful for refreshing data |
| **Import** | Import a dashboard or widget from a JSON file |
| **Export** | Export the entire dashboard to a JSON file for backup or sharing |
| **Add Widget** | Opens the widget editor to create a new widget with Agent assistance |

## Widget Header Buttons {#adv-widget-headers}

**Dashboard Widget Headers** (visible when Headers toggle is on):

| Button | Description |
|--------|-------------|
| **Drag Handle** | The widget icon acts as a drag handle to reorder widgets |
| **Regenerate** | Ask the Agent to regenerate this widget's content |
| **History** | View previous versions of this widget (if available) |
| **Fullscreen** | Expand the widget to fullscreen view |
| **Edit** | Open the widget editor to modify with Agent chat |
| **Delete** | Remove the widget from the dashboard (with confirmation) |

**Chat Widget Headers** (inline widgets in chat):

| Button | Description |
|--------|-------------|
| **Add to Dashboard** | Save this widget to your dashboard |
| **Edit Code** | View and edit the widget's HTML/CSS/JS code directly |
| **Expand/Collapse** | Toggle widget content visibility |

## Resize & Move Widgets {#adv-resize-move}

**Resizing widgets:**

- Each widget has a **resize handle** in the bottom-right corner
- Click and drag the handle to resize the widget
- Width snaps to a 12-column grid (minimum 3 columns)
- Height is measured in 50px units (minimum 2 units = 100px)

**Moving widgets:**

- Enable **Headers** toggle to show widget headers
- Click and drag the **widget icon** (drag handle) to reorder
- Drop the widget on another widget to swap positions
- Widget order is saved automatically

## Import/Export Formats {#adv-import-export}

**Dashboard Export** (`dashboard-YYYY-MM-DD.json`):

```
{
  "type": "appagent-dashboard",
  "version": 1,
  "widgets": [
    {
      "id": "widget_123",
      "title": "Widget Title",
      "html": "<html>...</html>",
      "width": 6,
      "height": 8,
      "order": 0,
      "conversation": [...]
    }
  ]
}
```

**Single Widget Export:**

```
{
  "type": "appagent-dashboard-widget",
  "version": 1,
  "widget": { ... }
}
```

**Single Chat Export** (`chat-title-YYYY-MM-DD.json`):

```
{
  "exportType": "single_chat",
  "exportDate": "2024-01-15T10:30:00.000Z",
  "chat": {
    "id": "chat_123",
    "title": "Chat Title",
    "messages": [
      {
        "role": "user",
        "content": "User message text"
      },
      {
        "role": "assistant",
        "content": "Agent response text"
      }
    ],
    "createdAt": 1705312200000
  }
}
```

Chat exports preserve the full conversation history including all user messages and agent responses. Use the chat dropdown menu (···) and select **Download** to export individual chats.

**Skills Export** (folder structure):

```
skill-name/
├── SKILL.md      # Main skill definition
├── sample.xml    # Optional XML assets
├── helper.js     # Optional JS assets
└── notes.md      # Optional MD assets
```

:::tip
**Note:** Skills import/export uses the File System Access API and **only works in Chrome or Edge** browsers.
:::

**All Data Export** (`appagent-backup-YYYY-MM-DD.json`):

```
{
  "version": 3,
  "exportDate": "2024-01-15T10:30:00.000Z",
  "chats": [...],
  "settings": [...],
  "dashboardWidgets": [...],
  "apiProviders": [...]
}
```

The full backup includes all chat history, settings, tool permissions, dashboard widgets, and API provider configurations.

## API Statistics {#adv-api-stats}

When enabled in Settings, API statistics are displayed after each Agent response:

| Metric | Description |
|--------|-------------|
| **In** | Input tokens — the size of the prompt sent to the Agent |
| **Out** | Output tokens — the size of the Agent's response |
| **Total** | Combined input + output tokens |
| **Cache Read/Write** | Tokens read from or written to prompt cache (reduces cost) |
| **Reasoning** | Tokens used for internal reasoning (some models) |
| **Cost** | Estimated cost of the API call in USD |
| **Duration** | Time taken for the API call |

For multi-turn conversations, aggregate statistics show the total across all calls.

:::tip
Toggle API stats display in [Settings](app:openSettingsPageView) → Display → Show API Statistics.
:::

## Manual Skill Editing {#adv-skills-manual}

Skills can be created and edited manually or with Agent assistance:

**Creating a skill manually:**

1. Go to [Skills](app:openSkillsView) and click **New Skill**
2. Enter a skill name and description
3. Write the skill content in Markdown format
4. Click **Save** to create the skill

**SKILL.md format:**

```
# Skill Name

Description of what this skill does.

## Instructions

Detailed instructions for the Agent...

## Examples

- Example usage 1
- Example usage 2
```

**Editing with Agent:**

1. Click **Edit with Agent** on any skill
2. Describe what changes you want
3. The Agent will modify the skill content
4. Review and save the changes

**Skill assets:** Skills can include additional files (XML, JS, MD) that provide extra context or code for the Agent.

## System Prompt {#adv-system-prompt}

The system prompt defines the Agent's behavior and capabilities. You can customize it in [Settings](app:openSettingsPageView).

**Editing the System Prompt:**

1. Go to Settings → System Prompt section
2. Click **Edit** to switch to editing mode
3. Modify the template as needed
4. Click **Save** to apply changes

**Available Placeholders:**

| Placeholder | Description |
|-------------|-------------|
| `{{CURRENT_DATE}}` | Today's date (weekday, month, day, year) |
| `{{ORCHESTRATOR_POLICY}}` | Sub-agent delegation & orchestration policy — rendered for main (parent) chats, empty (`''`) for sub-agent chats, which get their worker role via the sub-agent preamble instead |
| `{{SCOPE_CONTEXT}}` | Current app scope information |
| `{{DISABLED_TOOLS}}` | List of disabled tools |
| `{{TOOL_CATALOG}}` | Deferred-tool catalog (empty when deferred tool loading is off) |
| `{{SKILLS_SUMMARY}}` | Active skills content |

Placeholders are automatically replaced with actual values when sending to the AI. The token count display shows both the template size and expanded size.

:::tip
Click **Revert to Default** to restore the original system prompt if needed.
:::

## Agent API Calls {#adv-agent-api}

AppAgent runs as a **Chrome extension**. AI API calls go directly from your browser to the AI provider:

- AI API calls go **directly from your browser to the AI provider** (e.g., Anthropic, OpenRouter)
- AI calls do **not** route through your instance, and do **not** route through any AppAgent server — there is no proxy in the middle
- Your API key (or OAuth token) is stored locally in your browser
- Conversation data is sent to the AI provider for processing

**How it works:**

1. You type a message in the chat
2. AppAgent builds a prompt with system instructions, tools, and conversation history
3. The prompt is sent directly from your browser to the AI provider's API endpoint
4. The Agent's response streams back to your browser
5. Tool calls are executed in your browser, using your instance session for API calls

:::tip
**Privacy:** Your API key and conversation data are handled client-side. AI API calls go directly to the provider from your browser. Tool calls that interact with your instance use your existing session credentials.
:::

## LLM Endpoints {#adv-endpoints}

Models connect through **named LLM endpoints** — reusable `URL + API key` pairs. This lets you point AppAgent at **any OpenAI-compatible chat-completions API**: OpenRouter, a local gateway, a proxy, or your own hosted model.

1. In [Settings → LLM Endpoints](app:openSettingsPageView), click **Add Endpoint**
2. Give it a name, the API URL, and an API key
3. Each model (API Provider) picks an endpoint — update a key once and every model using it is updated

:::tip
Claude **OAuth** providers don't use endpoints — they talk to `api.anthropic.com` directly.
:::

## Sign in with Claude (OAuth) {#adv-oauth}

Instead of pasting an API key, you can sign in to Anthropic providers using your existing claude.ai session:

1. In [Settings → API Providers](app:openSettingsPageView), add or edit an Anthropic provider and enable **OAuth**
2. The extension reads the claude.ai session cookie from your Chrome profile and performs a PKCE exchange against `api.anthropic.com` directly
3. No consent tab, no fetch interceptor, no AppAgent server in the loop

**Requirements:**

- You must be signed in to `claude.ai` in the same Chrome profile
- The extension manifest requires the `cookies` permission
- OAuth works under SSO setups where the old `/oauth/authorize` page would return 403

:::tip
OAuth tokens are refreshed automatically. If sign-in fails, open `claude.ai` in the same profile and sign in again.
:::

## Security Considerations {#adv-security}

**API Key Storage:**

- Your **API key is stored locally** in your browser's IndexedDB
- The key is never sent to your instance or any server other than the AI provider
- Clearing browser data will remove your stored API key

**Session & Permissions:**

- The Agent runs with your **current user session**, inheriting your access rights and roles
- All API calls to your instance use your session credentials
- The Agent can only access what your user account can access

**Tool Execution Environment:**

- **Browser Code (js_eval)** runs JavaScript in an **isolated sandbox** with only `executeTool()` access
- **Widget scripts** run in **isolated iframes** with only `executeTool()` access for API calls
- **Skill tools** run in **isolated sandboxes** with only `executeTool()` access
- All API access goes through the **permission system** via `executeTool("servicenow_api", {...})`
- The Agent interacts with pages in **browser tabs** on your ServiceNow instance

**Record Modification Capabilities:**

- **ServiceNow API** tool supports POST, PATCH, PUT, and DELETE methods that can alter records
- The Agent can create and edit records through the **integrated browser** if given permissions for fill and click tools
- Configure [Tool Permissions](app:openSettingsPageView) to control which operations require approval

**Self-Improvement:**

- The Agent can **manage its own skills** — creating, editing, and activating skills
- This allows the Agent to learn and self-improve over time
- Review skill changes periodically to ensure they align with your expectations

## Data Storage {#adv-data-storage}

AppAgent stores data locally in your browser using **IndexedDB**:

| Data Type | Storage | Description |
|-----------|---------|-------------|
| **Chats** | IndexedDB | All conversation history, messages, and tool results |
| **Settings** | IndexedDB | Tool permissions, API keys, model preferences |
| **Dashboard Widgets** | IndexedDB | Widget HTML, titles, sizes, and conversation history |
| **Skills** | IndexedDB | Skill definitions, content, and assets |
| **API Providers** | IndexedDB | Custom API provider configurations and endpoints |
| **UI State** | localStorage | Sidebar state, current view, scroll positions |

**Downloading your data:**

1. Go to [Settings](app:openSettingsPageView) → Data Management
2. Click **Export Data**
3. A JSON backup file will be downloaded

**Deleting your data:**

1. Go to [Settings](app:openSettingsPageView) → Data Management
2. Click **Delete All Data**
3. Confirm twice to permanently delete everything

:::tip
**Important:** Data is stored locally in the extension. Clearing browser data, uninstalling the extension, or using a different browser profile will result in separate data stores.
:::

# About {#about}

**Version:** v__VERSION__

**License:** Private and Commercial use. Internal modification permitted. Distribution and resale prohibited. All rights reserved.
