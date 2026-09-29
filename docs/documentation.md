# Getting Started {#getting-started}

AppAgent is an AI Agent for ServiceNow that runs as a Chrome extension. Describe what you need in plain language and the Agent queries data, edits records, builds apps and widgets, tests pages in your browser, and reports back.

:::tip
**Quick start:** Set up a model, open a tab on your ServiceNow instance, then type a request in the chat and press <kbd>Enter</kbd>.
:::

## Set Up a Model {#guide-setup}

1. Open [Settings](app:openSettingsPageView) and go to **API Providers**
2. Add a provider (Anthropic, OpenRouter or a custom OpenAI-compatible API) with your API key — or enable **OAuth** on an Anthropic provider to sign in with your Claude account
3. Pick the model to use under **Agent Model**

Your API key is stored only in your browser. AI calls go directly from your browser to the provider.

## Connect Your Instances {#guide-instances}

AppAgent **auto-detects every ServiceNow instance** you have open in the same Chrome profile — there is no connection string to enter. Log in to an instance in a normal tab and the Agent can work on it with your user's roles and access rights. Ask *"list instances"* to see every detected instance, your roles and the connection status.

Each instance has a **permission level**, chosen from the instance dropdown:

- **Manual** — You approve each write operation (create, update, delete, form fills)
- **Auto** — The Agent decides on write operations without asking
- **Dev** — No approvals at all: every tool call on this instance runs without asking. Use it only on development instances

Reads are always allowed. See [Tool Permissions](#feature-permissions) for finer control.

## Start a Chat {#guide-chat}

1. Click **New Chat** in the sidebar [Start New Chat →](app:startNewChat)
2. Type your request, for example *"Show me all incidents created today"*
3. Press <kbd>Enter</kbd> to send
4. Follow along as the Agent works: each tool call appears in the chat, and approval prompts appear when a step needs your OK

You can keep typing while the Agent works: sending a new message interrupts the current step, and **Pause** stops the run.

## Attach Images and Files {#guide-images}

1. Click the **Attach file** button in the input area to add an image, PDF, CSV or text file
2. Or paste an image from the clipboard, or drag and drop it onto the chat
3. Type your question about the attachment

:::tip
Attach error screenshots, UI mockups or exported data so the Agent can see exactly what you see.
:::

# Key Features {#features}

## Chat {#page-chat}

The main conversation view. [Start New Chat →](app:startNewChat)

- **Message area** — The conversation, including tool calls and their results
- **Input box** — Type messages; attach files; send while the Agent is working to interrupt it
- **Pause / Continue / Retry** — Stop the Agent, resume it, or retry the last step
- **Context indicator** — Shows how full the conversation is; click it to summarize into a new chat
- **Answer cards** — A **TL;DR** summary and a **Links** card (records, PRs, docs) can appear below an answer
- **Chat header** — Rename or pin the chat, or open AppAgent in a full browser tab with **Expand to full page**

## Browser Control {#feature-browser}

The Agent can open and control browser tabs on your instance to see and test pages:

- **Navigate, click, fill and select** — Realistic events, so forms and autocomplete fields behave as if you typed
- **Wait for** — Wait for an element, a text or a URL instead of guessing delays
- **Screenshots** — Capture the page, a widget or a single element for visual checks
- **Inspect** — Read element properties, styles, console errors and network requests
- **Impersonate** — Test as another user, then switch back

## Edit Records & Version History {#feature-history}

Every change the Agent makes to your instance is tracked in the chat sidebar:

- **Undo** — Revert an individual change
- **Redo** — Restore a reverted change
- **Download XML** — Export all changes, for example to move them to another instance

## Sub-Agents {#feature-subagents}

For heavy or parallel work, the Agent can start **sub-agents**: background workers that run in their own chat and context, then report a short result back to the main chat.

- **Model tiers** — Each sub-agent runs on a **small**, **medium** or **large** tier, or **same** to use the parent's model. Map tiers to models in [Settings](app:openSettingsPageView) → **Sub-Agent Model Tiers**
- **Workers strip** — Running sub-agents appear as live chips above the chat input; open one to watch its progress or read its transcript
- **Pool** — The number of concurrent sub-agents is capped; extra ones wait in a queue

## Dashboard & Widgets {#page-dashboard}

A dashboard of Agent-generated, interactive widgets. [Open Dashboard →](app:openDashboardView)

1. Click **Add Widget**
2. Describe what you want, for example *"A chart showing open incidents by priority"*
3. The Agent builds the widget; ask for changes or click **Regenerate** at any time

Widgets can fetch live data from your instance, so they stay up to date. Drag, resize, import and export them (see [Advanced](#advanced)). Widgets the Agent shows inline in a chat can be saved with **Add to Dashboard**.

## Smart Documents {#page-documents}

**Smart Documents** are persistent, versioned Markdown documents that the Agent writes and updates — plans, reports, specifications, findings. They render inline in chat, keep every version, and can be edited by you directly. Open them from **Documents** in the sidebar. [Open Documents →](app:openDocumentsView)

## Skills {#page-skills}

Skills give the Agent extra knowledge and tools. [Open Skills →](app:openSkillsView)

- **Activate / Deactivate** — Turn skills on or off; deactivate the ones you don't need to keep answers focused
- **New Skill** — Write your own skill in Markdown, or use **Edit with Agent**
- **Import / Export** — Share skills as folders
- **Skill actions** — Some skills add one-click buttons on the home page that start a preset workflow

A skill can provide **knowledge** (instructions, best practices) and **custom tools** (JavaScript functions that run in an isolated sandbox).

## Workspace & GitHub {#feature-workspace}

Each chat has a **workspace** — a file area where the Agent can read, write, edit and diff files.

- **GitHub** — Connect a GitHub account in [Settings](app:openSettingsPageView) to clone repositories into a workspace. The Agent can create branches, push commits and open pull requests from the chat
- **Pull requests** — PRs opened from a chat are listed in the chat sidebar, with a **Merge** button
- **Protection between chats** — Each file remembers which chat changed it, so two chats working in parallel do not silently overwrite each other's work
- **Auto-sync** — Cloned workspaces sync with GitHub when you navigate, switch chats or return to the tab

## Chat Sidebar {#feature-sidebar}

The right-hand sidebar collects everything the current chat produced:

- **Pull requests** — Title, target branch and a **Merge** button
- **Workspace files** — Open a file to view it, see its diff or browse earlier versions
- **Version history** — Instance changes with **Undo**, **Redo** and **Download XML**
- **Workers** — Running and finished sub-agents, with counters for tool calls, edited files and opened PRs

## Actions & Live Progress {#feature-actions}

Long tasks show live progress instead of going silent:

- **Progress card** — A single card with a colored state (running, stuck, done, error) and a list of steps
- **Action buttons** — One-click buttons that start follow-up workflows
- **Running indicator** — The chat list marks chats where the Agent is working
- **"Agent finished" notification** — If you switch tabs or windows during a run, a desktop notification tells you when the Agent is done

## Active Chats & Jobs {#feature-jobs}

The jobs pill in the header opens a live view of your chats and background work:

- **Active chats** — Running chats and chats with unread results (shown in **bold**), each with a context-usage ring
- **Sub-agents** — Listed under their parent chat; open one to read its transcript
- **Expand** — Open the list as a larger panel with a columns or sections layout

## Tool Permissions {#feature-permissions}

Besides the per-instance permission level (**Manual**, **Auto**, **Dev**), each tool has its own setting in [Settings](app:openSettingsPageView) → **Tool Permissions**:

- **Allow** — The tool always runs without asking
- **Auto** — The tool runs without asking, unless the Agent flags a call as needing your confirmation
- **Ask** — You get an approval prompt before every call
- **Off** — The Agent cannot use the tool

Some tools have finer controls: the ServiceNow API per HTTP method (GET, POST, PUT, PATCH, DELETE), browser control per action (navigate, click, fill, impersonate…), and skill management per action. Confirmation dialogs are color-coded by risk: **blue** (routine), **orange** (caution), **red** (destructive).

:::tip
Keep DELETE and other destructive operations on **Ask**, and use **Dev** only on development instances.
:::

## Agent Tools {#feature-tools}

The main tools the Agent uses:

| Tool | What it does |
|------|--------------|
| **ServiceNow API** (`servicenow_api`) | Read, create, update and delete records |
| **Background script** (`servicenow_run_script`) | Run a server-side script on the instance (requires the admin role) |
| **Script edits** (`servicenow_diff_edit`) | Change scripts with precise search-and-replace edits |
| **Browser control** (`iframe_tool`) | Navigate, click, fill, inspect and impersonate in browser tabs |
| **Browser code** (`js_eval`) | Run JavaScript in an isolated sandbox that can call other tools |
| **Screenshots** (`take_screenshot`) | Capture the page, a widget or an element |
| **Widgets and cards** (`html_widget`, `display`) | Show interactive widgets, tables, cards and timelines in the chat |
| **Smart Documents** (`document`) | Create and update persistent Markdown documents |
| **Prompt user** (`prompt_user`) | Ask you for input with an inline form |
| **Sub-agents** (`spawn_sub_agent`) | Delegate work to background workers |
| **Workspace** (`workspace`) | Work with files and GitHub repositories |
| **Web fetch** (`web_fetch`) | Read pages from the public web |
| **Skills** (`get_skill`, `manage_skill`) | Read and manage skills |

Open [Settings](app:openSettingsPageView) → **Tool Permissions** to see every tool, its source and its permission.

## Large Content Caching {#feature-caching}

When a tool result is too large for the conversation (more than 4K tokens by default), AppAgent caches it. The Agent receives an outline and then reads, searches or browses only the parts it needs. This keeps chats fast and focused. Change the threshold (1K to 100K tokens) in [Settings](app:openSettingsPageView) → **Large Content Caching**.

## Context Indicator {#feature-saturation}

The **context indicator** next to the chat input shows how full the conversation is. Past 50% the Agent is asked to wrap up and hand remaining heavy work to sub-agents; at 100% it stops and reports. Click the indicator at any time to summarize the conversation into a fresh chat.

## Usage & Rate Limits {#feature-usage}

- **Usage pill** — The header shows your API usage and remaining limits; click it for details
- **Automatic retries** — When the provider is rate-limited or overloaded (HTTP 429 / 529), AppAgent waits and retries automatically and shows a countdown in the chat
- **Out of credits** — When a 429 actually means your credits are exhausted, the chat says so clearly

## Languages {#feature-languages}

The interface is available in English plus 24 languages: Arabic, Chinese (Simplified, Traditional), Czech, Danish, Dutch, Finnish, French (France, Canada), German, Hebrew, Hungarian, Italian, Japanese, Korean, Norwegian, Polish, Portuguese (Brazil, Portugal), Russian, Spanish, Swedish, Thai and Turkish.

Choose one in [Settings](app:openSettingsPageView) → **Language**, or from the quick-settings menu in the header. **Auto** follows your browser's language and falls back to English. The change applies immediately, without a reload.

- **Right-to-left** — Arabic and Hebrew use a right-to-left layout
- **Local formats** — Dates, times and numbers follow your language
- **Agent replies** — The Agent replies in the chosen language unless you write in another one. Code, table and field names stay unchanged
- **This help page** — Shown in your language; the changelog stays in English

# Pages & Settings {#pages}

## Settings {#page-settings}

[Open Settings →](app:openSettingsPageView)

- **Agent Model** — The model the Agent uses
- **API Providers** — Anthropic, OpenRouter or custom providers, with an API key or OAuth
- **LLM Endpoints** — Named `URL + API key` pairs for any OpenAI-compatible API
- **Sub-Agent Model Tiers** — Map the small, medium and large tiers to models, or **Same**
- **Reasoning Effort, Max Tokens & Thinking Budget** — Tune answer depth and length
- **Context Window** — The context size used by the context indicator
- **Display** — API statistics, compact mode, keep the display awake
- **Language** — Interface language, or **Auto**
- **Hooks** — Automatic chat titles, "Agent finished" notifications and other automation
- **Large Content Caching** — When large results are cached
- **Tool Permissions** — What runs automatically, asks first or is disabled
- **GitHub** — Connect a GitHub account and manage cloned repositories
- **System Prompt** — Customize the Agent's instructions
- **Data Management** — Export, import or delete your data

## History {#page-history}

All your conversations. [Open History →](app:openHistoryView)

- **Search** — Find chats by title, content, tools used or widgets
- **Pin** — Keep important chats at the top
- **Export** — Download one chat or your whole history
- **Stats** — Number of chats, pinned chats and total cost

## Help {#page-docs}

This page. [Open Help →](app:openDocsView)

- **Search** — Filter the help topics from the search box in the toolbar
- **Contents** — Jump to a section from the outline
- **Download** — Save the documentation as a Markdown file

# Tips & Keyboard Shortcuts {#tips}

| Action | How |
|--------|-----|
| Send message | <kbd>Enter</kbd> |
| New line | <kbd>Shift</kbd> + <kbd>Enter</kbd> |
| Search chats | <kbd>Ctrl</kbd> + <kbd>K</kbd> (<kbd>⌘</kbd> + <kbd>K</kbd> on Mac) |
| Close a dialog or menu | <kbd>Esc</kbd> |
| Go back | <kbd>Alt</kbd> + <kbd>←</kbd> |
| Attach an image | Paste it, or drag and drop it onto the chat |
| Start fresh with a summary | Click the context indicator |
| Interrupt the Agent | Send a new message, or click **Pause** |

:::tip
**Be specific.** Instead of *"fix this"*, say *"fix the null reference error on line 42 of the MyUtils script include"*. Name the table, record or page when you can.
:::

- **One goal per chat** — Start a new chat for an unrelated task; the Agent stays faster and more accurate
- **Let it test** — Ask the Agent to open the page and verify its own change with a screenshot
- **Use skills** — Activate a skill that matches your task (for example testing or auditing) before you start

# Troubleshooting & FAQ {#faq}

### The Agent does not see my instance

Open the instance in a tab of the same Chrome profile and make sure you are logged in, then ask *"list instances"*. If it still does not appear, reload the instance tab.

### I get an API or authentication error

Check your provider in [Settings](app:openSettingsPageView) → **API Providers**: the API key, the selected endpoint and the model name. For OAuth, sign in to claude.ai again in the same Chrome profile.

### The Agent says it is rate-limited

AppAgent retries automatically and shows a countdown. If it keeps happening, check the usage pill for remaining credits, or use a smaller model tier for sub-agents.

### Too many approval prompts, or not enough

Change the instance's permission level (**Manual**, **Auto**, **Dev**) from the instance dropdown, and adjust individual tools in [Settings](app:openSettingsPageView) → **Tool Permissions**.

### Answers get slower or less accurate in a long chat

The conversation is filling up its context. Click the context indicator to continue in a fresh chat with a summary.

### How do I undo a change?

Open the chat sidebar and click **Undo** on the change in the version history. **Download XML** exports all changes.

### Where is my data stored?

Locally in your browser (IndexedDB). Chats never go to an AppAgent server — only to your AI provider and your ServiceNow instance. See [Data Storage](#adv-data-storage).

### The interface or this page is in the wrong language

Choose the language in [Settings](app:openSettingsPageView) → **Language**. **Auto** follows your browser's language.

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
| `{{ORCHESTRATOR_POLICY}}` | Sub-agent delegation policy — included in main chats, left empty in sub-agent chats |
| `{{DISABLED_TOOLS}}` | List of disabled tools |
| `{{TOOL_CATALOG}}` | Deferred-tool catalog (empty when deferred tool loading is off) |
| `{{SKILLS_SUMMARY}}` | Active skills content |

Placeholders are automatically replaced with actual values when sending to the AI. The token count display shows both the template size and expanded size.

:::tip
Click **Revert to Default** to restore the original system prompt if needed.
:::

## Agent API Calls {#adv-agent-api}

AppAgent runs as a **Chrome extension**:

- AI API calls go **directly from your browser to the AI provider** (e.g., Anthropic, OpenRouter)
- They do **not** pass through your instance or any AppAgent server
- Your API key (or OAuth token) is stored locally in your browser
- Conversation data is sent to the AI provider for processing

**How it works:**

1. You type a message in the chat
2. AppAgent builds a prompt with system instructions, tools, and conversation history
3. The prompt is sent to the AI provider's API
4. The Agent's response streams back to your browser
5. Tool calls are executed in your browser, using your instance session for API calls

:::tip
**Privacy:** Your API key and conversation data are handled client-side. Tool calls that interact with your instance use your existing session credentials.
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
2. The extension uses your claude.ai sign-in from the same Chrome profile to connect to Anthropic directly
3. No extra sign-in window, and no AppAgent server in between

**Requirements:**

- You must be signed in to `claude.ai` in the same Chrome profile
- Works with single sign-on (SSO) accounts

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

## Changelog {#changelog}

__CHANGELOG__
