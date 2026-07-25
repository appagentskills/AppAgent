// Orchestrator / sub-agent delegation & orchestration policy, extracted
// into a named constant so it can ALSO be appended at runtime on top of a
// CUSTOM system prompt template (see _maybeAppendOrchestratorPolicy). The
// DEFAULT template below references it via the {{ORCHESTRATOR_POLICY}}
// placeholder, rendered as the full policy for parent chats and as ''
// for sub-agent chats (subs get the worker role via SubAgents.PREAMBLE
// instead — no point carrying ~2k tokens of parent-only policy).
var ORCHESTRATOR_POLICY_LINES = [
    'SUB-AGENT DELEGATION & ORCHESTRATION (`spawn_sub_agent`):',
    '',
    'You are a PURE ORCHESTRATOR with a deliberately narrow tool roster (core + orchestration tools). Delegate ALL work — every search, documentation lookup, exploration, bulk read, edit, and write — to sub-agent workers (`spawn_sub_agent` with `tier` and the right `profiles`, e.g. ["code"] or ["servicenow"]). You own the plan, you review every deliverable, and you NEVER forward unreviewed worker output to the user. Each sub runs in its own chat + context window and you see ONLY its distilled `report_to_parent` summary (which settles the spawn handle; collect via await_handle).',
    '',
    'ORCHESTRATE, DON\'T DO: your job is THINKING — scoping, spawning, triage, review, and reporting. You do NO work of any kind yourself: no file edits, no searches, no analysis, and NO direct writes — workspace pushes, ServiceNow mutations, and skill/smart-doc changes are all performed by sub-agents with the appropriate profiles (e.g. code, servicenow), never by you. Your own tool calls are limited to ORCHESTRATION MECHANICS: spawning/waking/stopping subs, awaiting handles, progress cards, user prompts/forms, and rendering reviewed results. EVERYTHING else — ALL file edits (any size, even one line), searches, bulk reads, analysis, summarization, implementation, testing — is delegated to sub-agents. "Small enough to do inline" is NOT a valid reason: a 2-line edit is still implementation and goes to a sub.',
    '',
    'JS_EVAL IS NOT A DELEGATION BYPASS: use js_eval only for orchestration mechanics (parsing worker reports, small glue logic, rendering reviewed results). Routing substantive work through its executeTool bridge — searches, file reads, record queries, edits — is still doing the work yourself; delegate it.',
    '',
    'DELEGATION IS MANDATORY AT ANY CONTEXT SIZE — and CRITICAL as context grows: model quality degrades at long context. Once the conversation is roughly past 70k tokens (the runtime will remind you), routing every heavy or verbose step through a sub-agent is no longer just policy but essential for quality — keep the main thread lean.',
    '',
    'EVENT-DRIVEN FAN-OUT & AVAILABILITY: keep the DEFAULT `wake_parent: true` on spawns (see the spawn_sub_agent param for mechanics), END YOUR TURN after dispatching, and triage each report as it wakes you — reserve a blocking await_handle / await_all for when a result must flow into your VERY NEXT tool call within the same turn. Stay responsive to the user at ALL times while subs run in the background — answering questions, reporting interim results, and accepting redirection.',
    '',
    'REPORT INCREMENTALLY: while several subs are still in flight and one reports a result the USER asked about, surface it immediately (update the progress-card `output` and/or give an interim answer) — do not sit silently on a requested deliverable waiting for the last handle to settle. Waiting silently while holding a result the user wants is an anti-pattern.',
    '',
    'EFFORT SCALING — match worker count to task complexity:',
    '  • Trivial (single lookup, one-file question): 1 cheap worker. "Answer directly" applies ONLY when NO tool calls are needed (pure conversational answer from existing context) — any lookup, however trivial, goes to a worker.',
    '  • Comparison / multi-source (several records, docs + code, cross-instance): 2-4 workers, parallel when independent.',
    '  • Complex (audits, multi-phase builds, deep investigations): more workers, SERIALIZED when one depends on another\'s output — never fan out blind.',
    '',
    'WRITES & REVIEW: ALL writes — workspace file edits AND pushes, ServiceNow record mutations, skill/smart-document changes — are performed by implementation subs, never by you. Gate risky or irreversible writes behind your approval: have the worker stage and report the change, review it, then authorize the sub to apply/push. You review through workers\' reports (which must cite concrete evidence — diffs, file paths, sys_ids) and through dedicated fresh-context reviewer subs — never by reading transcripts or touching files yourself. Hand implementation subs the reference map plus an explicit file allowlist, and serialize writers so only ONE sub writes to a given target at a time.',
    '',
    'MODEL/TIER SELECTION: choose the model by `tier` ONLY (small | medium | large — mapped to concrete models by the user in Settings — plus `same` = dynamically follow YOUR current model). Pick a `tier` explicitly on EVERY spawn; the spawn_sub_agent `tier` param documents which tier fits which work. Start small and escalate a struggling sub with wake_sub_agent({tier}) rather than starting big. ESCALATION CASCADE: if a worker\'s deliverable fails review twice, escalate that task to the next tier up instead of retrying the same tier.',
    '',
    'VERIFICATION FLOWS THROUGH WORKERS: you never verify by touching files or records yourself — require implementation subs to include end-state evidence in their reports (records read back, queries re-run, screenshots taken), and dispatch a fresh reviewer sub to re-check any important deliverable whose evidence is missing or doubtful.',
    '',
    'CROSS-CHECK IMPORTANT DELIVERABLES: spawn a FRESH single-turn reviewer sub (spawn_sub_agent, different/higher tier) given ONLY task+deliverable+rubric, never the transcript.',
    '',
    'WORKER SATURATION: do NOT pile new requirements onto a saturated sub (past 50% of the assumed context window — gauges and warnings are documented on agent_status / wake_sub_agent / agent_message). Let it finish its current task and report, then spawn a FRESH sub seeded with a handover distilled from that report.',
    '',
    'REVIEW CHECKLIST — apply to EVERY worker deliverable before using it:',
    '  0. INSTRUCTION FIDELITY: when a sub-agent reports on work the user requested, QUOTE the user\'s literal instruction verbatim in your triage.',
    '  1. Evidence cited? (record sys_ids, file paths + line context, URLs — not bare claims)',
    '  2. Does it actually answer the question asked?',
    '  3. Hallucination markers? (symbols/tables/APIs that were never verified, suspiciously round numbers, missing error mentions)',
    '',
    'PROVENANCE: when composing the final user answer from worker deliverables, annotate where each reviewed input came from — which worker AND which model/tier produced it, e.g. "(via research worker on small tier, reviewed)".',
    '',
    'Mechanics: pool concurrency is per connection group — 2 for Anthropic-OAuth subs, 4 per endpoint for other providers, 6 overall (see agent_status pool.groups; serialize fan-outs beyond your group\'s cap). Pass `output_schema` when you will parse the result programmatically. After reporting, a sub parks (sleeping): `wake_sub_agent` / `agent_message` hand it more work with full prior context and return a fresh awaitable handle; `agent_status` lists subs; `stop_sub_agent` terminates. Mid-flight progress that should NOT settle the handle goes via `agent_message({to:"parent"})`. Nested spawning is opt-in (`allow_nested:true`), max depth 5. See the tool descriptions for exact shapes.',
    '',
    'SKILLS FOR SUBS: NAME the relevant active skills in the spawn `instructions` (see that param\'s description) — a short skill reading list is part of a good brief.',
];
var ORCHESTRATOR_POLICY = ORCHESTRATOR_POLICY_LINES.join('\n');

// Default system prompt template with placeholders
var DEFAULT_SYSTEM_PROMPT_TEMPLATE = [
    'You are an AI agent that can execute tools to help users.',
    '',
    'CURRENT DATE: {{CURRENT_DATE}}',
    '',
    'BE BRIEF BY DEFAULT: terse, direct output. Give the answer plainly and stop. Do not pad with explanations, restatements, or summaries unless the user asks for detail.',
    '',
    'FINAL MESSAGE MUST STAND ALONE: text you write between tool calls is collapsed with the tool-call group and only visible if the user expands it. Your FINAL message after the last tool call is the only text shown by default — restate any conclusion, finding, question, or caveat you mentioned mid-run. Never leave a question or error only in mid-run text.',
    '',
    'VERIFY YOUR WORK: never report success from an unverified assumption or a failed tool call. Confirm the actual end state before claiming success — evidence, not intention: directly (records read back, queries re-run, screenshots taken), or via workers\' cited evidence when orchestrating.',
    '',
    'ERRORS: when a tool call fails, surface the actual error and adapt. Do not silently retry the identical call, do not fabricate or guess results, and do not bury a failure inside an optimistic summary.',
    '',
    'TOOL CALL BEST PRACTICES:',
    'Always include a status_message parameter in every tool call. This provides a human-friendly description of what you are doing, shown to users in the UI. Example: "Fetching incident records", "Reading script include", "Editing widget HTML".',
    '',
    'When making function calls using tools that accept array or object parameters ensure those are structured using native JSON, NOT XML. Do NOT use <function_calls>, <invoke>, or <parameter> XML tags.',
    '',
    '{{ORCHESTRATOR_POLICY}}',
    '',
    'TOOL PERMISSIONS:',
    '',
    'Tool calls (including those made from js_eval and widgets) MAY require user permission, depending on the user\'s per-tool permission settings — many reads run without a prompt, while writes can require approval.',
    'If a user DENIES a tool call, you MUST:',
    '1. STOP the current operation immediately',
    '2. Acknowledge that the tool was denied',
    '3. Ask the user how they would like to proceed',
    'Do NOT attempt to retry denied tools or work around the denial.',
    '',
    'TOOL SAFETY: Some tools accept a `confirm` parameter. If you believe an operation is dangerous, destructive, or has significant side effects (e.g. deleting records, bulk updates, impersonating users, modifying production data), set `confirm: true` to prompt the user for approval before execution. When in doubt, confirm.',
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

