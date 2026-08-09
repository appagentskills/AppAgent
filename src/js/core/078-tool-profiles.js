// =============================================================
// AppAgent — Tool Profiles (context-slimming tool rosters).
//
// Single source of truth mapping profile names → tool names. Every
// agent loads only the tools tagged with its profiles, cutting the
// tool-schema tokens sent to the LLM:
//   • Non-sub chats (main agent, background Action chats): core +
//     orchestrator REGISTRY tools. Skill-provided tools keep their
//     legacy always-on behavior for non-sub chats (gated only by
//     skill activation) so skill actions (run_audit, web_search,
//     extension_build, …) keep working.
//   • Sub-agents: core + sub-agent + the profiles the parent chose
//     via spawn_sub_agent's `profiles` param (see _computeToolRoster
//     in core/097-sub-agent-registry.js). `profiles` omitted ⇒ the
//     legacy full roster — backward compatible, no behavior change.
//
// A tool listed in NO profile: if it's a REGISTRY tool (core/080-
// tools.js TOOLS) it is treated as not loaded for profile-filtered
// agents (e.g. github_setup); if it's a SKILL-provided tool it keeps
// legacy behavior (loaded while its skill is active) so future
// skills don't break. NOTE: skill-provided tools that ARE listed in
// a profile (web_search, search_docs, run_audit, …) still require
// their skill to be ACTIVE in the spawning chat — the profile can
// only narrow, never conjure a tool the parent context doesn't have.
//
// Filtering shapes the tool list assembled for the LLM (getEnabledTools
// twins) AND the spawn-time tool_roster, which IS enforced at dispatch
// for sub-agents (tools/020-tool-execution.js roster gate) — a tool
// outside the roster is rejected even when invoked via the js_eval
// executeTool bridge. Permission checks are separate and untouched.
// The filter runs on the BASE list, before (and independent of)
// deferred-tools splitting.
//
// Loaded in BOTH bundles: page core tier (numeric prefix, before
// 080-tools.js) + WORKER_SHARED_FILES (build/build.js and
// skills/extension-dev/build.js — kept in sync).
// =============================================================

var TOOL_PROFILES = {
    core:        { description: 'Base tools every agent needs (eval/chaining, cached results, files, skills, progress card)', tools: ['js_eval', 'cached_content_outline', 'cached_content_search', 'cached_content_read', 'get_file', 'get_tool_schema', 'get_skill', 'update_action_state'] },
    'sub-agent': { description: 'Tools every spawned sub-agent needs to report back, communicate, and stage scratchpad docs', tools: ['report_to_parent', 'agent_message', 'sleep_self', 'document'] },
    orchestrator: { description: 'Main-agent orchestration and user-facing I/O: spawning/managing subs, async handles, prompts, rendering, answer cards', tools: ['spawn_sub_agent', 'agent_status', 'wake_sub_agent', 'stop_sub_agent', 'agent_message', 'await_handle', 'await_any', 'await_all', 'prompt_user', 'show_action_button', 'set_chat_title', 'set_tldr', 'set_links', 'set_caveat', 'display', 'html_widget', 'document', 'screenshot_by_id', 'read_attached_file', 'start_chat'] },
    'skill-manager': { description: 'Create/update/manage AI skills (live runtime copies)', tools: ['manage_skill'] },
    servicenow:  { description: 'ServiceNow record CRUD, server scripts, code edits', tools: ['servicenow_api', 'servicenow_run_script', 'servicenow_diff_edit', 'list_instances', 'start_chat'] },
    browser:     { description: 'Drive and inspect the ServiceNow UI in the iframe, screenshots', tools: ['iframe_tool', 'take_screenshot', 'screenshot_by_id', 'get_cookie', 'list_instances'] },
    research:    { description: 'Web research: web_fetch (all HTTP methods) + docs/web search (search_docs/web_search are skill-provided — present only while their skill is active)', tools: ['web_fetch', 'get_cookie', 'search_docs', 'web_search', 'list_instances'] },
    code:        { description: 'GitHub repo work: clone/browse/read/edit/diff via workspace', tools: ['workspace', 'web_fetch'] },
    'extension-dev': { description: 'AppAgent extension development: the code tools (workspace, web_fetch) + runtime_inspect and screenshots', tools: ['workspace', 'web_fetch', 'runtime_inspect', 'take_screenshot', 'screenshot_by_id'] },
    'eval-runner':   { description: 'Run the ServiceNow eval: grader + the ServiceNow tools the eval tasks need', tools: ['eval_runner', 'servicenow_api', 'servicenow_run_script', 'servicenow_diff_edit', 'list_instances'] },
    'audit-runner':  { description: 'Run instance audits: audit tool + ServiceNow read access', tools: ['run_audit', 'servicenow_api', 'list_instances'] }
};

// Union of tool names for a list of profile names. ALWAYS includes
// `core` (no need to pass it). Unknown profile names are ignored here
// — spawn_sub_agent validates them up front with a hard error.
function getToolNamesForProfiles(profileNames) {
    var seen = Object.create(null);
    var out = [];
    var list = ['core'].concat(Array.isArray(profileNames) ? profileNames : []);
    for (var i = 0; i < list.length; i++) {
        var prof = TOOL_PROFILES[list[i]];
        if (!prof || !Array.isArray(prof.tools)) continue;
        for (var j = 0; j < prof.tools.length; j++) {
            var n = prof.tools[j];
            if (!seen[n]) { seen[n] = true; out.push(n); }
        }
    }
    return out;
}

// Set (name → true) of every tool name appearing in ANY profile.
// Used to tell "listed somewhere" tools apart from unlisted
// skill-provided tools (which keep legacy always-on behavior).
var _profiledToolNameSet = null;
function getProfiledToolNameSet() {
    if (_profiledToolNameSet) return _profiledToolNameSet;
    var set = Object.create(null);
    for (var p in TOOL_PROFILES) {
        var tl = TOOL_PROFILES[p].tools || [];
        for (var i = 0; i < tl.length; i++) set[tl[i]] = true;
    }
    _profiledToolNameSet = set;
    return set;
}
