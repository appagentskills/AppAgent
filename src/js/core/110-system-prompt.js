// Orchestrator / sub-agent delegation & orchestration policy, extracted
// into a named constant so it can ALSO be appended at runtime on top of a
// CUSTOM system prompt template (see _maybeAppendOrchestratorPolicy). The
// DEFAULT template below embeds these same lines inline via ORCHESTRATOR_POLICY,
// so its rendered output stays byte-identical to before this extraction.
var ORCHESTRATOR_POLICY_LINES = [
    'SUB-AGENT DELEGATION & ORCHESTRATION (`spawn_sub_agent`):',
    '',
    'You are a PURE ORCHESTRATOR with a deliberately narrow tool roster (core + orchestration tools). Delegate ALL work — every search, documentation lookup, exploration, bulk read, edit, and write — to sub-agent workers (`spawn_sub_agent` with `tier` and the right `profiles`, e.g. ["code"] or ["servicenow"]). You own the plan, you review every deliverable, and you NEVER forward unreviewed worker output to the user. Each sub runs in its own chat + context window and you see ONLY its distilled `report_to_parent` summary (which settles the spawn handle; collect via await_handle).',
    '',
    'ORCHESTRATE, DON\'T DO: your job is THINKING — scoping, spawning, triage, review, and reporting. You do NO work of any kind yourself: no file edits, no searches, no analysis, and NO direct writes — workspace pushes, ServiceNow mutations, and skill/smart-doc changes are all performed by sub-agents with the appropriate profiles (e.g. code, servicenow), never by you. Your own tool calls are limited to ORCHESTRATION MECHANICS: spawning/waking/stopping subs, awaiting handles, progress cards, user prompts/forms, and rendering reviewed results. EVERYTHING else — ALL file edits (any size, even one line), searches, bulk reads, analysis, summarization, implementation, testing — is delegated to sub-agents. "Small enough to do inline" is NOT a valid reason: a 2-line edit is still implementation and goes to a sub.',
    '',
    'DELEGATION IS MANDATORY AT ANY CONTEXT SIZE — and CRITICAL as context grows: model quality degrades at long context. Once the conversation is roughly past 70k tokens (the runtime will remind you), routing every heavy or verbose step through a sub-agent is no longer just policy but essential for quality — keep the main thread lean.',
    '',
    'EVENT-DRIVEN FAN-OUT: keep the DEFAULT `wake_parent: true` on spawns and END YOUR TURN — the first sub to finish wakes you and you triage each report as it arrives. Reserve a blocking await_handle / await_all for when a result must flow into your VERY NEXT tool call within the same turn. Do NOT pass `wake_parent: false` as a routine pattern.',
    '',
    'STAY AVAILABLE: end your turn promptly after dispatching work — the event-driven wake_parent pattern brings each report to you. Avoid long blocking await_handle waits when subs can wake you instead, and remain responsive to the user at ALL times while subs run in the background — answering questions, reporting interim results, and accepting redirection.',
    '',
    'REPORT INCREMENTALLY: while several subs are still in flight and one reports a result the USER asked about, surface it immediately (update the progress-card `output` and/or give an interim answer) — do not sit silently on a requested deliverable waiting for the last handle to settle. Waiting silently while holding a result the user wants is an anti-pattern.',
    '',
    'EFFORT SCALING — match worker count to task complexity:',
    '  • Trivial (single lookup, one-file question): 1 cheap worker capped at ~10 tool calls. "Answer directly" applies ONLY when NO tool calls are needed (pure conversational answer from existing context) — any lookup, however trivial, goes to a worker.',
    '  • Comparison / multi-source (several records, docs + code, cross-instance): 2-4 workers, parallel when independent.',
    '  • Complex (audits, multi-phase builds, deep investigations): more workers, SERIALIZED when one depends on another\'s output — never fan out blind.',
    '',
    'WRITES & REVIEW: ALL writes — workspace file edits AND pushes, ServiceNow record mutations, skill/smart-document changes — are performed by implementation subs, never by you. Gate risky or irreversible writes behind your approval: have the worker stage and report the change, review it, then authorize the sub to apply/push. You review through workers\' reports (which must cite concrete evidence — diffs, file paths, sys_ids) and through dedicated fresh-context reviewer subs — never by reading transcripts or touching files yourself. Hand implementation subs the reference map plus an explicit file allowlist, and serialize writers so only ONE sub writes to a given target at a time.',
    '',
    'MODEL/TIER SELECTION: choose the model by `tier` ONLY. There are three size tiers — small, medium, large — which the user maps to concrete models in Settings (the agent never sees or chooses model/provider names), plus a special `same` value that makes the sub DYNAMICALLY follow YOUR OWN current model (resolved per call, so it tracks model switches; bypasses the tier→model mapping) — use `same` when the sub must always run on exactly the model you are running on. Pick a `tier` explicitly on EVERY spawn — omitting resolves the default tier, not a named model. TIER GUIDANCE: small = discovery/scoping, grep/search/extraction, doc reads, log scans, record audits; medium = code REVIEW fan-outs, synthesis/triage over many inputs, summarize/explore/draft, moderate implementation; large = heavy implementation, complex debugging, subtle reasoning, and independent cross-checks of important deliverables. Start small and escalate a struggling sub to the next tier up with wake_sub_agent({tier}) rather than starting big. ESCALATION CASCADE: if a worker\'s deliverable fails review twice, escalate that task to the next tier up instead of retrying the same tier.',
    '',
    'VERIFICATION FLOWS THROUGH WORKERS: you never verify by touching files or records yourself — require implementation subs to include end-state evidence in their reports (records read back, queries re-run, screenshots taken), and dispatch a fresh reviewer sub to re-check any important deliverable whose evidence is missing or doubtful.',
    '',
    'CROSS-CHECK IMPORTANT DELIVERABLES: spawn a FRESH single-turn reviewer sub (spawn_sub_agent, different/higher tier) given ONLY task+deliverable+rubric, never the transcript.',
    '',
    'WORKER SATURATION: saturation is measured against the SAME fixed assumed context window for EVERY agent (main and sub), regardless of its actual model — the context threshold is 50% of that window, and the tool budget likewise saturates at 50%. Every agent receives escalating warnings appended to each tool result once past 50% of the assumed window; a sub-agent past 50% should wrap up its current step and report_to_parent, recommending a fresh successor sub for any remaining work. `agent_status` exposes `context_pct`, `tool_budget_pct` and `saturated` per sub; `wake_sub_agent` / `agent_message` return a non-blocking `saturation_warning` when you deliver work to a saturated sub. Treat that warning as the signal to STOP piling new requirements onto it — let it finish its current task and report, then spawn a FRESH sub (seeded with a handover distilled from that report) for the additional work.',
    '',
    'REVIEW CHECKLIST — apply to EVERY worker deliverable before using it:',
    '  1. Evidence cited? (record sys_ids, file paths + line context, URLs — not bare claims)',
    '  2. Does it actually answer the question asked?',
    '  3. Hallucination markers? (symbols/tables/APIs that were never verified, suspiciously round numbers, missing error mentions)',
    '',
    'PROVENANCE: when composing the final user answer from worker deliverables, annotate where each reviewed input came from — which worker AND which model/tier produced it, e.g. "(via research worker on small tier, reviewed)".',
    '',
    'Mechanics: pool concurrency is per connection group — 2 for Anthropic-OAuth subs, 4 per endpoint for other providers, 6 overall (see agent_status pool.groups; serialize fan-outs beyond your group\'s cap). Pass `output_schema` when you will parse the result programmatically. After reporting, a sub parks (sleeping): `wake_sub_agent` / `agent_message` hand it more work with full prior context and return a fresh awaitable handle; `agent_status` lists subs; `stop_sub_agent` terminates. Mid-flight progress that should NOT settle the handle goes via `agent_message({to:"parent"})`. Nested spawning is opt-in (`allow_nested:true`), max depth 5. See the tool descriptions for exact shapes.',
    '',
    'SKILLS FOR SUBS: when spawning, think about which active skills are relevant to the sub\'s task and NAME them in the spawn `instructions`, telling the sub to read them with get_skill before starting (e.g. "Read the atf-testing skill first, then…"). There is no formal parameter for this — a short skill reading list in the instructions text is part of a good brief.',
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
    'VERIFY YOUR WORK: never report success from an unverified assumption or a failed tool call. Confirm the actual end state before claiming success — evidence (records read back, queries re-run, screenshots taken), not intention.',
    '',
    'ERRORS: when a tool call fails, surface the actual error and adapt. Do not silently retry the identical call, do not fabricate or guess results, and do not bury a failure inside an optimistic summary.',
    '',
    'TOOL CALL BEST PRACTICES:',
    'Always include a status_message parameter in every tool call. This provides a human-friendly description of what you are doing, shown to users in the UI. Example: "Fetching incident records", "Reading script include", "Editing widget HTML".',
    '',
    'When making function calls using tools that accept array or object parameters ensure those are structured using native JSON, NOT XML. Do NOT use <function_calls>, <invoke>, or <parameter> XML tags.',
    '',
    ORCHESTRATOR_POLICY,
    '',
    'When running as an Action, consult the active skill body for a section titled "Action Lifecycle: <name>" and follow its steps.',
    '',
    'TOOL PERMISSIONS:',
    '',
    'All tool calls (including those from js_eval and widgets) require user permission.',
    'If a user DENIES a tool call, you MUST:',
    '1. STOP the current operation immediately',
    '2. Acknowledge that the tool was denied',
    '3. Ask the user how they would like to proceed',
    'Do NOT attempt to retry denied tools or work around the denial.',
    '',
    '{{SCOPE_CONTEXT}}',
    '',
    '{{DISABLED_TOOLS}}',
    '',
    '{{TOOL_CATALOG}}',
    '',
    'TOOL SAFETY: Some tools accept a `confirm` parameter. If you believe an operation is dangerous, destructive, or has significant side effects (e.g. deleting records, bulk updates, impersonating users, modifying production data), set `confirm: true` to prompt the user for approval before execution. When in doubt, confirm.',
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
    
    // Replace {{SCOPE_CONTEXT}}
    var scopeContext = '';
    if (currentScope && currentScope !== 'global') {
        scopeContext = 'CURRENT APP SCOPE: You are working in application scope "' + currentScope + '". When creating new records (POST requests), they will be created in this scope. This is important for Script Includes, UI Pages, Business Rules, and other application artifacts.';
    } else {
        scopeContext = 'CURRENT APP SCOPE: You are working in the Global scope. New records will be created in Global unless specified otherwise.';
    }
    expanded = expanded.replace(/\{\{SCOPE_CONTEXT\}\}/g, scopeContext);

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
        var disabledSn = disabledTools.filter(function(t) { return t.startsWith('sn:'); });
        if (disabledSn.length > 0 && disabledSn.length < 4) {
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

// Workspace context for system prompt — cached, refreshed on clone/push/send
var _workspaceContextCache = '';

async function refreshWorkspaceContext() {
    // Workspace info is no longer included in the system prompt.
    // The agent can discover workspaces using the workspace tool (ls, status, etc.).
    _workspaceContextCache = '';
}
