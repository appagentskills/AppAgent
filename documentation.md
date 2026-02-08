# AppAgent Documentation

## Getting Started

AppAgent is an AI Agent for your ServiceNow instance. It helps you query data, edit records, browse pages, and automate tasks using natural language.

> **Tip:** Quick Start: Type a message in the chat and press Enter. The Agent will understand your request and use the right tools automatically.

## Quick Guides

### Starting a Chat

1. Click + New Chat in the sidebar
2. Type your request (e.g., "Show me all incidents created today")
3. Press Enter to send
4. The Agent will respond and may use tools to complete your task

### Browse with Agent

1. Enter a URL path in the browser bar (e.g., /incident_list.do)
2. Click Browse with Agent
3. Ask the Agent about what you see: "What errors are on this page?"
4. The Agent can take screenshots, click elements, and fill forms

### Edit Records

1. Ask: "Update the script include MyUtils to add error logging"
2. Review the changes shown in the chat
3. Use the Undo button if needed
4. All changes are tracked in the version sidebar (right panel)

### Using Skills

1. Go to Skills page from sidebar
2. Click Activate on a skill to enable it
3. Active skills give the Agent new abilities and knowledge
4. Deactivate skills you don't need to keep responses focused

### Create Widgets

1. Go to Dashboard page
2. Click Add Widget
3. Describe what you want: "A chart showing incidents by priority"
4. The Agent generates an interactive widget

### Attach Images

1. Click the Image button in the input area
2. Select an image file or paste from clipboard
3. Type your question about the image
4. The Agent can analyze screenshots, diagrams, and UI elements

> **Tip:** Use image attachments to show the Agent error screenshots, UI mockups, or any visual content you need help with.

## Pages

### Chat

The main conversation interface where you interact with the Agent. Start New Chat →

- Message Area - Shows conversation history
- Input Box - Type your messages here
- Pause Button - Stop Agent execution if needed
- Context Indicator - Shows how full the context is (click to summarize)
- Version Sidebar - Track all changes made (right panel)

### Dashboard

A dynamic, smart dashboard with Agent-generated widgets. Open Dashboard →

Unlike traditional dashboards, widgets are generated through natural language prompts. Describe what you want and the Agent creates it instantly. Need changes? Just regenerate with a new prompt.

Widgets are also dynamic at runtime - they have access to your ServiceNow instance and can fetch live data, making your dashboard always up-to-date.

- Add Widget - Describe what you want in plain language
- Drag & Drop - Rearrange widgets
- Resize - Adjust widget sizes
- Regenerate - Instantly update any widget with a new prompt
- Import/Export - Save and share dashboards

### Skills

Manage Agent skills that extend its capabilities. Open Skills →

Skills can provide knowledge (instructions, best practices) and custom tools (executable JavaScript functions the Agent can call). Custom tools run in isolated sandboxes with executeTool() access.

- Activate/Deactivate - Toggle skills on or off
- New Skill - Create custom skills
- Import/Export - Share skills between instances
- Edit with Agent - Modify skills using Agent assistance

### Tools

View all available Agent tools and their parameters. Open Tools →

- Browser Code - Run JavaScript in an isolated sandbox
- ServiceNow API - Query and modify records
- Edit Code/Scripts - Make changes to scripts using search-and-replace
- Browser Control - Navigate, interact with pages, impersonate users
- Display Widget - Render interactive HTML widgets
- Take Screenshot - Capture screenshots of the browser, widgets, or elements
- Manage Skills - Create and manage Agent skills
- Read Attached File - Read text files attached by the user

### Settings

Configure AppAgent preferences. Open Settings →

- Agent Model - Choose which LLM to use
- App Scope - Set the scope for new records
- Display - Toggle API stats and compact mode
- Hooks - Enable auto-title generation and other automation
- Large Content Caching - Set when large results get cached (1K to 100K tokens)
- Tool Permissions - Control which tools run automatically
- System Prompt - Customize the AI's system instructions
- Data Management - Export, import, or delete data

### History

View and manage all your conversations. Open History →

- Search - Find chats by title, content, tools used, or widgets
- Pin - Pin important conversations for quick access
- Export - Download individual chats or all history
- Stats - View total conversations, pinned count, and accumulated cost
- Preview - See chat previews with user/agent messages

### Documentation

This page! Browse the full documentation for AppAgent. Open Docs →

- Table of Contents - Navigate sections via the right sidebar
- Download - Export the documentation as a Markdown file

## Features

### Agent Tools

The Agent has access to powerful tools:

| Tool | What it does | 
| --- | --- |
| Browser Code | Execute JavaScript in an isolated sandbox with executeTool() access | 
| ServiceNow API | Read, create, update, delete records | 
| Edit Code/Scripts | Modify scripts using search-and-replace | 
| Browser Control | Navigate pages, click, fill forms, select options, dispatch events, scroll, resize, inspect, impersonate, debug widgets | 
| Display Widget | Display interactive HTML widgets inline in chat | 
| Take Screenshot | Capture screenshots of the browser, widgets, or specific elements for visual analysis | 
| Manage Skills | Create, update, activate, and manage Agent skills | 
| Read Attached File | Read text files attached by the user in the conversation | 

### Tool Permissions

Control how tools execute. Configure in Settings:

Granular Controls:

- Auto - Tool runs without asking
- Ask First - Shows approval prompt before running
- Disabled - Tool cannot be used

- ServiceNow API - Separate permissions per HTTP method (GET, POST, PUT, PATCH, DELETE)
- Browser Control - Separate permissions per action (navigate, click, fill, select option, dispatch event, scroll, resize, impersonate, and more)
- Manage Skills - Separate permissions per action (create, update, add/update/delete files, activate, deactivate)

> **Tip:** Set destructive tools (DELETE, PUT) to "Ask First" for safety. Skill activation is disabled by default.

### Version History

All changes are tracked automatically:

Access version history from the panel on the right side of the chat.

- Undo - Revert individual changes
- Redo - Restore reverted changes
- Download XML - Export all changes to XML

### Browser Panel

The embedded browser lets the Agent see and interact with pages:

Widget Debugging: The browser panel can also open and debug HTML widgets. The Agent can take screenshots, inspect DOM, and edit widget HTML directly.

- Navigate - Enter URLs to browse (same-origin only)
- Screenshots - Agent can see the page content
- Click/Fill - Agent can interact with elements
- Interact - Click elements, fill forms, select options, dispatch events
- Scroll/Resize - Scroll pages and resize the viewport
- Inspect - Get element properties, computed styles, and dimensions
- Console/Network - View errors, logs, and network requests
- Impersonate - Switch to another user session
- Fullscreen - Expand browser with chat overlay

### Large Content Caching

When data is too large to fit in the conversation (over 4K tokens by default), it gets automatically cached. Instead of overwhelming the context, the Agent receives a smart outline and can explore the content piece by piece.

How it works:

What the Agent can do with cached content:

Settings: You can adjust the cache threshold in Settings (1K to 100K tokens). Lower values cache more aggressively, higher values let more data through directly.

1. A tool returns a large result (e.g., a big API response or long script)
2. The content is automatically cached
3. The Agent sees a summary showing the structure and contents
4. The Agent can browse, search, and read specific parts as needed

- Browse the outline - See the structure at different detail levels, from a quick overview to a deep dive
- Search - Find specific text or patterns within the cached content
- Read sections - Access specific parts of the data without loading everything

> **Tip:** Why this matters: Caching keeps conversations fast and focused. The Agent works smarter by only pulling in the specific data it needs, rather than flooding the context with huge responses.

## Tips & Shortcuts

| Action | How | 
| --- | --- |
| Send message | Enter | 
| New line | Shift + Enter | 
| New chat | Click + New Chat | 
| Search chats | Use search box in sidebar | 
| Pause Agent | Click Pause button | 
| Summarize context | Click the context percentage circle | 

> **Tip:** Pro tip: Be specific in your requests. Instead of "fix this", say "fix the null reference error on line 42".

## Advanced

This section covers advanced features, header buttons, import/export formats, and technical details about how AppAgent works.

### Dashboard Header Buttons

The dashboard header contains several action buttons:

| Button | Description | 
| --- | --- |
| Toggle Sidebar | Show or hide the left sidebar navigation | 
| Open Standalone | Open the dashboard in a new browser tab for standalone viewing | 
| Headers | Toggle visibility of widget headers on the dashboard. When hidden, widgets display in a cleaner view | 
| Regenerate All | Regenerate all widgets on the dashboard using the Agent. Useful for refreshing data | 
| Import | Import a dashboard or widget from a JSON file | 
| Export | Export the entire dashboard to a JSON file for backup or sharing | 
| Add Widget | Opens the widget editor to create a new widget with Agent assistance | 

### Widget Header Buttons

Dashboard Widget Headers (visible when Headers toggle is on):

Chat Widget Headers (inline widgets in chat):

| Button | Description | 
| --- | --- |
| Drag Handle | The widget icon acts as a drag handle to reorder widgets | 
| Regenerate | Ask the Agent to regenerate this widget's content | 
| History | View previous versions of this widget (if available) | 
| Fullscreen | Expand the widget to fullscreen view | 
| Edit | Open the widget editor to modify with Agent chat | 
| Delete | Remove the widget from the dashboard (with confirmation) | 

| Button | Description | 
| --- | --- |
| Add to Dashboard | Save this widget to your dashboard | 
| Edit Code | View and edit the widget's HTML/CSS/JS code directly | 
| Expand/Collapse | Toggle widget content visibility | 

### Resize & Move Widgets

Resizing widgets:

Moving widgets:

- Each widget has a resize handle in the bottom-right corner
- Click and drag the handle to resize the widget
- Width snaps to a 12-column grid (minimum 3 columns)
- Height is measured in 50px units (minimum 2 units = 100px)

- Enable Headers toggle to show widget headers
- Click and drag the widget icon (drag handle) to reorder
- Drop the widget on another widget to swap positions
- Widget order is saved automatically

### Import/Export Formats

Dashboard Export (dashboard-YYYY-MM-DD.json):

Single Widget Export:

Single Chat Export (chat-title-YYYY-MM-DD.json):

Chat exports preserve the full conversation history including all user messages and agent responses. Use the chat dropdown menu (···) and select Download to export individual chats.

Skills Export (folder structure):

All Data Export (appagent-backup-YYYY-MM-DD.json):

The full backup includes all chat history, settings, tool permissions, dashboard widgets, and API provider configurations.

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

```
{
  "type": "appagent-dashboard-widget",
  "version": 1,
  "widget": { ... }
}
```

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

```
skill-name/
├── SKILL.md      # Main skill definition
├── sample.xml    # Optional XML assets
├── helper.js     # Optional JS assets
└── notes.md      # Optional MD assets
```

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

> **Tip:** Note: Skills import/export uses the File System Access API and only works in Chrome or Edge browsers.

### API Statistics

When enabled in Settings, API statistics are displayed after each Agent response:

For multi-turn conversations, aggregate statistics show the total across all calls.

| Metric | Description | 
| --- | --- |
| In | Input tokens - the size of the prompt sent to the Agent | 
| Out | Output tokens - the size of the Agent's response | 
| Total | Combined input + output tokens | 
| Cache Read/Write | Tokens read from or written to prompt cache (reduces cost) | 
| Reasoning | Tokens used for internal reasoning (some models) | 
| Cost | Estimated cost of the API call in USD | 
| Duration | Time taken for the API call | 

> **Tip:** Toggle API stats display in Settings → Display → Show API Statistics.

### Manual Skill Editing

Skills can be created and edited manually or with Agent assistance:

Creating a skill manually:

SKILL.md format:

Editing with Agent:

Skill assets: Skills can include additional files (XML, JS, MD) that provide extra context or code for the Agent.

1. Go to Skills and click New Skill
2. Enter a skill name and description
3. Write the skill content in Markdown format
4. Click Save to create the skill

1. Click Edit with Agent on any skill
2. Describe what changes you want
3. The Agent will modify the skill content
4. Review and save the changes

```
# Skill Name

Description of what this skill does.

## Instructions

Detailed instructions for the Agent...

## Examples

- Example usage 1
- Example usage 2
```

### System Prompt

The system prompt defines the Agent's behavior and capabilities. You can customize it in Settings.

Editing the System Prompt:

Available Placeholders:

Placeholders are automatically replaced with actual values when sending to the AI. The token count display shows both the template size and expanded size.

1. Go to Settings → System Prompt section
2. Click Edit to switch to editing mode
3. Modify the template as needed
4. Click Save to apply changes

| Placeholder | Description | 
| --- | --- |
| {{SCOPE_CONTEXT}} | Current app scope information | 
| {{DISABLED_TOOLS}} | List of disabled tools | 
| {{SKILLS_SUMMARY}} | Active skills content | 

> **Tip:** Click Revert to Default to restore the original system prompt if needed.

### Agent API Calls

AppAgent runs as a UI Page on your ServiceNow instance, but AI API calls go directly from your browser to the AI provider:

How it works:

- AI API calls go directly from your browser to the AI provider (e.g., OpenRouter, Anthropic)
- AI calls do not route through your instance
- Your API key is stored locally in your browser
- Conversation data is sent to the AI provider for processing

1. You type a message in the chat
2. AppAgent builds a prompt with system instructions, tools, and conversation history
3. The prompt is sent directly from your browser to the AI provider's API endpoint
4. The Agent's response streams back to your browser
5. Tool calls are executed in your browser, using your instance session for API calls

> **Tip:** Privacy: Your API key and conversation data are handled client-side. AI API calls go directly to the provider from your browser. Tool calls that interact with your instance use your existing session credentials.

### Security Considerations

API Key Storage:

Session & Permissions:

Tool Execution Environment:

Record Modification Capabilities:

Self-Improvement:

- Your API key is stored locally in your browser's IndexedDB
- The key is never sent to your instance or any server other than the AI provider
- Clearing browser data will remove your stored API key

- The Agent runs with your current user session, inheriting your access rights and roles
- All API calls to your instance use your session credentials
- The Agent can only access what your user account can access

- Browser Code (js_eval) runs JavaScript in an isolated sandbox with only executeTool() access
- Widget scripts run in isolated iframes with only executeTool() access for API calls
- Skill tools run in isolated sandboxes with only executeTool() access
- All API access goes through the permission system via executeTool("servicenow_api", {...})
- The integrated browser only loads pages from the same instance domain (same-origin)

- ServiceNow API tool supports POST, PATCH, PUT, and DELETE methods that can alter records
- The Agent can create and edit records through the integrated browser if given permissions for fill and click tools
- Configure Tool Permissions to control which operations require approval

- The Agent can manage its own skills - creating, editing, and activating skills
- This allows the Agent to learn and self-improve over time
- Review skill changes periodically to ensure they align with your expectations

### Data Storage

AppAgent stores data locally in your browser using IndexedDB:

Downloading your data:

Deleting your data:

1. Go to Settings → Data Management
2. Click Export Data
3. A JSON backup file will be downloaded

1. Go to Settings → Data Management
2. Click Delete All Data
3. Confirm twice to permanently delete everything

| Data Type | Storage | Description | 
| --- | --- | --- |
| Chats | IndexedDB | All conversation history, messages, and tool results | 
| Settings | IndexedDB | Tool permissions, API keys, model preferences | 
| Dashboard Widgets | IndexedDB | Widget HTML, titles, sizes, and conversation history | 
| Skills | IndexedDB | Skill definitions, content, and assets | 
| API Providers | IndexedDB | Custom API provider configurations and endpoints | 
| UI State | localStorage | Sidebar state, current view, scroll positions | 

> **Tip:** Important: Data is stored per-browser and per-origin. Clearing browser data or using a different browser will result in separate data stores.

## About

Version: v0.1

License: Private and Commercial use. Internal modification permitted. Distribution and resale prohibited. All rights reserved. See [LICENSE](LICENSE) for details.

