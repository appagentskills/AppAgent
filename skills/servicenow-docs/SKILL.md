---
name: servicenow-docs
description: Search and read ServiceNow documentation and community posts
actions:
  - name: Search Docs
    icon: search
    show: [home]
---

## Action Lifecycle: Search Docs

1. `update_action_state({ state: 'running', icon: 'search', label: 'What to search?' })`
2. Call `prompt_user` with a single text field "query"
3. `update_action_state({ state: 'running', icon: 'search', label: 'Searching…' })`
4. Call `search_docs({ query: <user input> })` (or `web_fetch`/appropriate tool)
5. Render results using the `display` tool with `card_list` template
6. `update_action_state({ state: 'done', icon: 'check', label: 'N results' })`


## Overview

Search official ServiceNow documentation and community posts. No API key needed.

- **Docs** (default): Official documentation via Fluid Topics API — 216K+ topics across all products and versions (ITSM, SecOps, App Engine, API Reference, etc.). Returns latest version by default.
- **Community**: Forum posts, blogs, and events via Khoros LiQL API — real-world questions, solutions, and best practices from 1M+ members.

## How to Use

`read_first` defaults to true — searches and reads the top result in one call.

### Search docs (default)
```
search_docs({ query: "Workplace visitor properties" })
```

### Search community
```
search_docs({ query: "visitor management best practice", source: "community" })
```

### Search both
```
search_docs({ query: "GlideRecord API", source: "both" })
```

### Read a specific doc topic from a previous search
```
search_docs({ action: "read", map_id: "abc123", content_id: "xyz789" })
```

## What's in the Docs API

The Fluid Topics API covers all official ServiceNow documentation:

**Products**: API Reference, App Engine, Automation Engine, Customer Service Management, Data Foundations, Developer Guides, Employee Service Management, Field Service Management, Governance Risk & Compliance, IT Asset Management, IT Operations Management, IT Service Management, Now Intelligence, Security Operations, ServiceNow AI Platform, Strategic Portfolio Management, Web Services, and more.

**Versions**: Australia (latest), Zurich, Yokohama, Xanadu, Washington DC, and older.

**Locales**: English, German, French, Japanese, Korean, Portuguese.

**Additional endpoints**:
- `POST /api/khub/suggest` — autocomplete suggestions as you type
- `GET /api/khub/maps/{mapId}/toc` — full table of contents for a documentation book
- `GET /api/khub/maps/{mapId}/topics/{contentId}` — topic metadata
