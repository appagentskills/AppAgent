// Orchestrator / sub-agent delegation & orchestration policy, extracted
// into a named constant so it can ALSO be appended at runtime on top of a
// CUSTOM system prompt template (see _maybeAppendOrchestratorPolicy). The
// DEFAULT template below references it via the {{ORCHESTRATOR_POLICY}}
// placeholder, rendered as the full policy for parent chats and as ''
// for sub-agent chats (subs get the worker role via SubAgents.PREAMBLE
// instead — no point carrying ~2k tokens of parent-only policy).
var ORCHESTRATOR_POLICY_LINES = [
    'SUB-AGENT DELEGATION & ORCHESTRATION (`spawn_sub_agent`):',
    'You are an orchestrator first: you think — scope, spawn, triage, review, report. Each sub runs in its own chat and context window; you see only its `report_to_parent` summary, which settles its spawn handle.',
    '',
    'QUICK VS HEAVY (the one delegation rule; tool descriptions defer to it):',
    '- You MAY do quick work inline with your direct tools (workspace, web_fetch, ServiceNow CRUD/scripts) — a lookup, a single read/query, a small single-file or single-record edit — when its output stays small (a few thousand tokens).',
    '- You MUST delegate heavy, verbose or multi-step work — bulk reads, deep searches, exploration, multi-file implementation, audits, log scans — via `spawn_sub_agent` with an explicit `tier` and the right `profiles` (e.g. ["code"], ["servicenow"]), at any context size.',
    '- js_eval is not a delegation bypass: chaining a quick lookup through executeTool is fine; routing heavy work through it is still doing it yourself.',
    '- Past ~70k tokens (the runtime reminds you) model quality degrades: delegate every step, even quick ones.',
    '',
    'EFFORT SCALING:',
    '- Trivial (single lookup, one-file question): inline; never spawn a worker for a question.',
    '- Comparison / multi-source (several records, docs + code, cross-instance): 2-4 workers, parallel when independent.',
    '- Complex (audits, multi-phase builds, deep investigations): more workers, serialized when one depends on another\'s output; never fan out blind.',
    '',
    'FAN-OUT: keep the default `wake_parent: true`, end your turn after dispatching, and triage each report as it wakes you; block on await_handle / await_all only when a result must feed your very next tool call. Stay responsive while subs run (answer questions, give interim results, accept redirection). When a sub returns something the user asked for while others are in flight, surface it immediately (progress-card `output` or an interim answer) — never sit silently on it. Interim answers as reports arrive are cumulative: restate ALL results so far, not only the newest report.',
    '',
    'CUMULATIVE FINAL: after any wake run (a sub-agent report or message woke you), your final message is a self-contained digest of EVERYTHING since the user\'s last real message — every report, finding, decision, error and open question from this and earlier wake runs. Never assume the user read intermediate or earlier wake-run messages.',
    '',
    'WRITES: heavy writes (multi-file workspace changes, bulk ServiceNow mutations, skill/smart-document overhauls) go to implementation subs, each given the reference map and an explicit file allowlist; serialize writers — one sub per target at a time. For risky or irreversible writes, have the worker stage and report the change, review it, then authorize it to apply/push.',
    '',
    'TIERS: pick a model only via `tier` — small | medium | large (mapped in Settings) or `same` (follows your model); the `tier` param says which fits what. Set it on every spawn. Start small; escalate a struggling sub with wake_sub_agent({tier}). If a deliverable fails review twice, move the task up a tier instead of retrying the same one.',
    '',
    'REVIEW: never forward unreviewed worker output to the user. Review via workers\' reports and fresh reviewer subs — never by reading transcripts or touching files yourself. For every deliverable:',
    '0. Instruction fidelity: quote the user\'s literal instruction verbatim in your triage.',
    '1. Evidence cited (diffs, sys_ids, file paths + line context, URLs — not bare claims); for implementation work, end-state evidence (records read back, queries re-run, screenshots).',
    '2. It answers the question asked.',
    '3. No hallucination markers (unverified symbols/tables/APIs, suspiciously round numbers, missing error mentions).',
    'Cross-check important deliverables — always when evidence is missing or doubtful — with a FRESH single-turn reviewer sub on a different/higher tier, given only task + deliverable + rubric, never the transcript.',
    '',
    'PROVENANCE: in the final answer, note which worker and model/tier produced each reviewed input, e.g. "(via research worker on small tier, reviewed)".',
    '',
    'WORKER SATURATION: past 50% of its assumed context window (gauges on agent_status; wake_sub_agent / agent_message results warn), don\'t pile new requirements onto a sub — let it finish and report, then spawn a fresh sub seeded with a handover distilled from that report.',
    '',
    'BRIEFS: name the relevant active skills in spawn `instructions` (a short skill reading list is part of a good brief). Pass `output_schema` when you will parse the result programmatically.',
    '',
    'MECHANICS: pool concurrency is per connection group — 2 for Anthropic-OAuth subs, 4 per endpoint for other providers, 6 overall (agent_status pool.groups); serialize fan-outs beyond your group\'s cap. A sub parks after reporting; wake_sub_agent / agent_message give it more work with full prior context and return a fresh handle. agent_status lists subs; stop_sub_agent terminates. Subs send non-settling progress via agent_message({to:"parent"}). Nested spawning is opt-in (`allow_nested:true`), max depth 5. Exact shapes: see the tool descriptions.'
];
var ORCHESTRATOR_POLICY = ORCHESTRATOR_POLICY_LINES.join('\n');

// Default system prompt template with placeholders
var DEFAULT_SYSTEM_PROMPT_TEMPLATE = [
    'You are an AI agent that can execute tools to help users.',
    '',
    'CURRENT DATE: {{CURRENT_DATE}}',
    '',
    'CHAT VS TASK:',
    '- A question is a chat: answer from knowledge and context, with at most ONE quick read-only lookup when the answer lives in the instance or repo (say what you checked). Never spawn a worker, research, or edit anything just to answer a question.',
    '- If a full answer needs more, answer what you can and offer the rest in one line ("I can check X or research Y if you want") — not via prompt_user, which is for collecting structured input and confirming plans.',
    '- A request is a task even when phrased as a question ("can you check the logs", "fix it", "create the flow"): start it. Only when the message is not a clear request, confirm with prompt_user (Do it / Keep chatting) before time-consuming work (sub-agents, research, implementation).',
    '- Once a task is requested or confirmed, it and its direct follow-ups ("did it trigger?") need no re-confirmation until the user returns to asking questions.',
    '- Keep chat turns short, fast and conversational; never go quiet for long.',
    '',
    'OUTPUT:',
    '- Be brief by default: terse and direct; answer and stop. No padding, restatements or summaries unless asked.',
    '- Only your FINAL message (after the last tool call) is shown by default; text between tool calls is collapsed with the tool group. Make it stand alone: restate any conclusion, finding, question or caveat from mid-run or from earlier wake runs since the user\'s last message — never leave a question or error only in mid-run text.',
    '',
    'VERIFY YOUR WORK: never claim success from an unverified assumption or a failed tool call. Confirm the actual end state with evidence, not intention — directly (records read back, queries re-run, screenshots) or via workers\' cited evidence when orchestrating.',
    '',
    'ERRORS: when a tool call fails, surface the actual error and adapt — never silently retry the identical call, fabricate or guess results, or bury a failure in an optimistic summary.',
    '',
    'API FIRST (ServiceNow): for ANY instance interaction — reads, creates, updates, deletes, config changes, impersonation, verification, test setup/teardown — use the API tools (servicenow_api, servicenow_run_script, iframe_tool action "impersonate", which calls the impersonation REST API directly) whenever the operation can be done that way. Drive the UI (iframe_tool click/fill/navigate, the ui-driver skill) ONLY when the UI itself is the subject (testing or inspecting a specific form, page, portal or workspace behavior) or there is genuinely no API path — and say why when you fall back to the UI. When testing: seed/clean up data and verify backend effects via the API; never create prerequisite records through forms unless that form is what is under test; never impersonate via the UI impersonation menu/dialog, and end impersonation with iframe_tool impersonate user:"stop".',
    '',
    'SERVER SCRIPTS: servicenow_run_script is admin-only. Before calling it, confirm the user has the `admin` role on that instance from list_instances (instances[].roles) — reuse the roles from an earlier list_instances call in this chat for the same instance rather than re-calling before every script. If `admin` is not listed, do not attempt the script: use servicenow_api instead, or tell the user admin is required. Empty roles means unknown (probe failed) — then check via servicenow_api GET sys_user_has_role, query `user=javascript:gs.getUserID()^role.name=admin`.',
    '',
    'TOOL CALLS:',
    '- Include a short status_message on every tool call; it is shown in the UI (e.g. "Fetching incident records").',
    '- Pass array/object parameters as native JSON, never XML (no <function_calls>, <invoke> or <parameter> tags).',
    '',
    'TOOL PERMISSIONS: depending on the user\'s per-tool settings, tool calls (including those from js_eval and widgets) may need approval — many reads run without a prompt, writes may ask. If the user DENIES a call: stop the operation immediately, acknowledge the denial, and ask how to proceed. Never retry or work around a denial.',
    '',
    'TOOL SAFETY: some tools accept a `confirm` parameter — set `confirm: true` to have the user approve before execution when an operation is dangerous, destructive, or has significant side effects (e.g. deleting records, bulk updates, impersonating users, modifying production data). When in doubt, confirm.',
    '',
    '{{ORCHESTRATOR_POLICY}}',
    '',
    '{{DISABLED_TOOLS}}',
    '',
    '{{TOOL_CATALOG}}',
    '',
    '{{SKILLS_SUMMARY}}'
].join('\n');

// Custom system prompt state
var customSystemPrompt = null;
var systemPromptEditMode = false;

// Load custom system prompt from storage.
async function loadCustomSystemPrompt() {
    customSystemPrompt = await getSetting('customSystemPrompt', null);
}

// Save custom system prompt to storage
async function saveCustomSystemPrompt(template) {
    customSystemPrompt = template;
    await setSetting('customSystemPrompt', template);
}

// Clear custom system prompt (revert to default)
async function clearCustomSystemPrompt() {
    customSystemPrompt = null;
    await setSetting('customSystemPrompt', null);
}

// Get the current system prompt template (custom or default)
function getSystemPromptTemplate() {
    return customSystemPrompt || DEFAULT_SYSTEM_PROMPT_TEMPLATE;
}

// Append the sub-agent preamble when the active chat is a sub-agent. The
// preamble lives in src/js/core/097-sub-agent-registry.js as
// SubAgents.PREAMBLE — keep it co-located with the runtime that consumes
// it (system prompt module just reads). We resolve the chat from the
// argument (preferred — explicit chatId from the streaming caller) or
// fall back to the global currentChatId for in-UI uses (token counter
// preview, settings panel).
function _maybeAppendSubAgentPreamble(expanded, chatId) {
    try {
        if (typeof SubAgents === 'undefined' || !SubAgents || !SubAgents.PREAMBLE) return expanded;
        var resolvedChatId = chatId
            || (typeof activeStreamingChatId !== 'undefined' ? activeStreamingChatId : null)
            || (typeof currentChatId !== 'undefined' ? currentChatId : null);
        if (!resolvedChatId) return expanded;
        if (typeof chats === 'undefined') return expanded;
        var chat = chats[resolvedChatId];
        if (!chat || !chat.isSubAgent) return expanded;
        return expanded + SubAgents.PREAMBLE;
    } catch (e) {
        return expanded;
    }
}

// Check if using custom system prompt
function hasCustomSystemPrompt() {
    return customSystemPrompt !== null;
}

// Append the orchestrator / sub-agent delegation policy on top of a CUSTOM
// system prompt so the delegation policy is ALWAYS-ON regardless of the
// user's template. The DEFAULT template already embeds ORCHESTRATOR_POLICY
// inline, so we only append when a custom prompt is active AND the expanded
// text does not already contain the section heading (avoid duplicates when
// the custom prompt kept the section or the default is in play). Sub-agent
// chats are skipped: subs receive the ROLE PRECEDENCE override in
// SubAgents.PREAMBLE and must not be handed the parent orchestration policy.
// Chat resolution mirrors _maybeAppendSubAgentPreamble; when the chat cannot
// be resolved we treat it as a parent (append) — parent chats are the common
// case and the policy is harmless under the sub preamble's ROLE PRECEDENCE
// override.
function _maybeAppendOrchestratorPolicy(expanded, chatId) {
    try {
        if (typeof hasCustomSystemPrompt !== 'function' || !hasCustomSystemPrompt()) return expanded;
        if (typeof ORCHESTRATOR_POLICY === 'undefined' || !ORCHESTRATOR_POLICY) return expanded;
        // Do not duplicate the section if the custom prompt already kept it.
        if (expanded.indexOf('SUB-AGENT DELEGATION & ORCHESTRATION') !== -1) return expanded;
        var resolvedChatId = chatId
            || (typeof activeStreamingChatId !== 'undefined' ? activeStreamingChatId : null)
            || (typeof currentChatId !== 'undefined' ? currentChatId : null);
        if (resolvedChatId && typeof chats !== 'undefined') {
            var chat = chats[resolvedChatId];
            // Sub-agents get the ROLE PRECEDENCE override via SubAgents.PREAMBLE.
            if (chat && chat.isSubAgent) return expanded;
        }
        return expanded + '\n\n' + ORCHESTRATOR_POLICY;
    } catch (e) {
        return expanded;
    }
}

// Append the deferred-tool catalog on top of a CUSTOM system prompt that
// does not contain the {{TOOL_CATALOG}} placeholder — without this,
// deferred tools would be undiscoverable for users who saved a custom
// prompt before the feature existed. Mirrors _maybeAppendOrchestratorPolicy
// above: only when a custom prompt is active, only when deferred mode is
// ON, and never duplicating (TOOL_CATALOG_HEADING — core/080-tools.js —
// doubles as the dedupe marker).
function _maybeAppendToolCatalog(expanded, chatId) {
    try {
        if (typeof isDeferredToolsActive !== 'function' || !isDeferredToolsActive()) return expanded;
        if (typeof hasCustomSystemPrompt !== 'function' || !hasCustomSystemPrompt()) return expanded;
        var heading = (typeof TOOL_CATALOG_HEADING !== 'undefined') ? TOOL_CATALOG_HEADING : 'ADDITIONAL AVAILABLE TOOLS (deferred schemas):';
        if (expanded.indexOf(heading) !== -1) return expanded;
        var catalog = (typeof getToolCatalogForPrompt === 'function') ? getToolCatalogForPrompt(chatId) : '';
        if (!catalog) return expanded;
        return expanded + '\n\n' + catalog;
    } catch (e) {
        return expanded;
    }
}

// Replace placeholders with actual values. chatId is optional — it scopes
// the {{TOOL_CATALOG}} render (deferred tool loading) to the chat's enabled
// tool list; UI preview callers omit it and get the global list.
function expandSystemPromptPlaceholders(template, chatId) {
    var expanded = template;
    
    // Strip the legacy {{SCOPE_CONTEXT}} placeholder. The App Scope feature
    // was removed (record scope is passed per-call via the `scope` param on
    // servicenow_api / servicenow_run_script), but saved CUSTOM prompts may
    // still contain the literal placeholder — keep replacing it with ''.
    expanded = expanded.replace(/\{\{SCOPE_CONTEXT\}\}/g, '');

    // Replace {{ORCHESTRATOR_POLICY}} — the parent-only delegation policy.
    // Sub-agent chats render it as '' (they get the worker role via
    // SubAgents.PREAMBLE instead), saving ~2k tokens per sub call. Chat
    // resolution mirrors _maybeAppendOrchestratorPolicy (which handles the
    // CUSTOM-prompt path and already skips subs); unresolvable chat ⇒ parent
    // (the common case, and harmless under the sub preamble's role override).
    // When it renders '' (sub chats), the blank line the placeholder occupied
    // is absorbed by the \n{3,} → \n\n cleanup at the end of this function —
    // no stray triple blank line is left mid-prompt.
    var orchestratorPolicy = (typeof ORCHESTRATOR_POLICY !== 'undefined' && ORCHESTRATOR_POLICY) ? ORCHESTRATOR_POLICY : '';
    try {
        var _opChatId = chatId
            || (typeof activeStreamingChatId !== 'undefined' ? activeStreamingChatId : null)
            || (typeof currentChatId !== 'undefined' ? currentChatId : null);
        if (_opChatId && typeof chats !== 'undefined' && chats[_opChatId] && chats[_opChatId].isSubAgent) {
            orchestratorPolicy = '';
        }
    } catch (e) { /* default: include — parent chats are the common case */ }
    expanded = expanded.replace(/\{\{ORCHESTRATOR_POLICY\}\}/g, function() { return orchestratorPolicy; });

    // Replace {{CURRENT_DATE}} with today's date (YYYY-MM-DD, weekday)
    var now = new Date();
    var dateStr = now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    expanded = expanded.replace(/\{\{CURRENT_DATE\}\}/g, dateStr);

    // {{INSTANCE_CONTEXT}} retired — instance targeting guidance now lives in the
    // servicenow_api / servicenow_diff_edit / iframe_tool descriptions. Collapse any
    // leftover placeholder (e.g. in a saved custom prompt template) TOGETHER WITH
    // the line it occupied when it sits on its own line, so the empty substitution
    // leaves no stray blank lines (the \n{3,} cleanup below also guards this);
    // any inline occurrence is plain-replaced with ''.
    expanded = expanded.replace(/\n[ \t]*\{\{INSTANCE_CONTEXT\}\}[ \t]*(?=\n)/g, '');
    expanded = expanded.replace(/\{\{INSTANCE_CONTEXT\}\}/g, '');

    // Replace {{DISABLED_TOOLS}}
    var disabledToolsText = '';
    var disabledTools = getDisabledTools();
    if (disabledTools.length > 0) {
        var disabledNames = disabledTools.map(function(key) {
            return TOOL_DISPLAY_NAMES[key] || key;
        });
        disabledToolsText = 'DISABLED CAPABILITIES: The following capabilities have been disabled by the user: ' + disabledNames.join(', ') + '.';
        // Mention op-level restrictions only while servicenow_api itself is
        // still visible, i.e. at least one CRUD key remains enabled — when all
        // 4 are disabled the tool is filtered out entirely (getEnabledTools in
        // worker/025-permissions-helpers.js + the page twin). Count ONLY the 4
        // CRUD keys: sn:run_script is a 5th sn: key gating the separate
        // servicenow_run_script tool and must not skew this check.
        var _snCrudKeys = ['sn:read', 'sn:create', 'sn:update', 'sn:delete'];
        var disabledSn = disabledTools.filter(function(t) { return _snCrudKeys.indexOf(t) !== -1; });
        if (disabledSn.length > 0 && disabledSn.length < _snCrudKeys.length) {
            var snOps = disabledSn.map(function(t) { return t.split(':')[1]; });
            disabledToolsText += ' ServiceNow API calls (whether made by you or a sub-agent) must NOT perform these operations: ' + snOps.join(', ') + '.';
        }
    }
    expanded = expanded.replace(/\{\{DISABLED_TOOLS\}\}/g, disabledToolsText);
    
    // Replace {{SKILLS_SUMMARY}}
    var skillsSummary = getSkillsSummaryForPrompt();
    // Remove leading newlines since template already has newline before placeholder
    skillsSummary = skillsSummary.replace(/^\n+/, '');
    expanded = expanded.replace(/\{\{SKILLS_SUMMARY\}\}/g, skillsSummary);

    // Replace {{TOOL_CATALOG}} — deferred-tool catalog (empty string when
    // the deferredToolsEnabled flag is OFF, so the placeholder collapses).
    // Rendered by SHARED code (getToolCatalogForPrompt in core/080-tools.js,
    // loaded in both bundles) so page and SW produce identical prompts.
    var toolCatalog = (typeof getToolCatalogForPrompt === 'function') ? getToolCatalogForPrompt(chatId) : '';
    expanded = expanded.replace(/\{\{TOOL_CATALOG\}\}/g, toolCatalog);

    // Clean up multiple consecutive empty lines
    expanded = expanded.replace(/\n{3,}/g, '\n\n');
    
    return expanded.trim();
}

