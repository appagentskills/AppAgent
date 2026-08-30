async function callLLMStreaming(chatMessages, onThinking, onContent, onToolCall, onDone, onStreamStatus, chatId, metrics) {
    var apiMsgs = buildAPIMessages(chatMessages, chatId);
    // Register an AbortController so a user-typed message can interrupt the in-flight stream.
    var abortController = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    if (chatId && abortController) currentStreamAbortControllers[chatId] = abortController;
    try {
        // Thread chatId through so the system prompt builder can append the
        // sub-agent preamble when the chat is a sub-agent (see 100-cached-results.js).
        // Per-run provider resolution (Orchestrator §1): a chat stamped with
        // chat.provider (sub-agents pinned at spawn) uses it; everything else
        // gets the global currentProvider exactly as before.
        return await callOpenRouterStreaming(resolveChatProviderName(chatId), apiMsgs, onThinking, onContent, onToolCall, onDone, onStreamStatus, abortController, chatId, metrics);
    } finally {
        if (chatId && currentStreamAbortControllers[chatId] === abortController) {
            delete currentStreamAbortControllers[chatId];
        }
    }
}

async function callOpenRouterStreaming(currentProvider, messages, onThinking, onContent, onToolCall, onDone, onStreamStatus, abortController, chatId, metrics) {
    var provider = getProviderById(currentProvider);

    if (!provider) {
        throw new Error('Provider "' + currentProvider + '" not found. Please select a valid model in settings.');
    }

    // Per-call metrics object owned by the calling chat's loop turn. The SW runs
    // multiple chats concurrently — writing usage into the shared
    // `lastRequestMetrics` global let interleaved streams clobber each other
    // (wrong input_tokens/cost on assistant messages, corrupting the sub-agent
    // nudge). All writes below go to this object; the global fallback covers
    // any legacy caller that didn't pass one.
    var reqMetrics = metrics || lastRequestMetrics || (lastRequestMetrics = {});

    // For Anthropic: normalize ALL messages to array format, then add cache_control at branching points
    // Cache points: system prompt + last 2 user messages + last message
    // This allows branching without cache invalidation
    var messagesWithCache = messages.map(function(m) { return Object.assign({}, m); });
    var modelLower = provider.model.toLowerCase();
    var isAnthropic = (modelLower.includes('anthropic') || modelLower.includes('claude'));
    if (isAnthropic && messagesWithCache.length > 0) {
        // Step 1: Normalize ALL messages to array format for consistent structure
        for (var j = 0; j < messagesWithCache.length; j++) {
            var m = messagesWithCache[j];
            if (typeof m.content === 'string' && m.content.length > 0) {
                messagesWithCache[j] = Object.assign({}, m, {
                    content: [{ type: 'text', text: m.content }]
                });
            }
        }

        // Step 2: Cache last 2 user messages + last block
        var cacheIndices = [];

        // Find last 2 user messages
        var userMsgCount = 0;
        for (var i = messagesWithCache.length - 1; i >= 0 && userMsgCount < 2; i--) {
            if (messagesWithCache[i].role === 'user') {
                cacheIndices.push(i);
                userMsgCount++;
            }
        }

        // Always cache the last message
        if (messagesWithCache.length > 0) {
            var lastIdx = messagesWithCache.length - 1;
            if (cacheIndices.indexOf(lastIdx) === -1) {
                cacheIndices.push(lastIdx);
            }
        }

        // Apply cache_control to selected indices
        cacheIndices.forEach(function(idx) {
            var msg = messagesWithCache[idx];
            if (Array.isArray(msg.content) && msg.content.length > 0) {
                var contentCopy = msg.content.map(function(c) { return Object.assign({}, c); });
                contentCopy[contentCopy.length - 1].cache_control = { type: 'ephemeral' };
                messagesWithCache[idx] = Object.assign({}, msg, { content: contentCopy });
            }
        });
    }

    // Build system message fresh each time (not stored in chat.messages)
    // This ensures branched chats work even after browser reload when cache expires.
    // Pass chatId so sub-agent chats get the sub-agent preamble appended.
    var systemPromptText = getSystemPromptWithContext(chatId);
    var systemMessage;
    if (isAnthropic) {
        // For Anthropic: use array format with cache_control on the system prompt
        systemMessage = {
            role: 'system',
            content: [{ type: 'text', text: systemPromptText, cache_control: { type: 'ephemeral' } }]
        };
    } else {
        systemMessage = { role: 'system', content: systemPromptText };
    }
    
    var requestBody = {
        model: provider.model,
        messages: [systemMessage].concat(messagesWithCache),
        // Pass chatId so sub-agent chats see their per-sub tool_roster
        // (deterministic: parent's full list minus the nested-delegation
        // trio unless allow_nested:true) and parent chats don't see
        // sub-only tools (report_to_parent, sleep_self).
        tools: getEnabledTools(chatId),
        tool_choice: 'auto',
        parallel_tool_calls: true,
        stream: true,
        //top_p: 0.95,
        //top_k: 40,
        // GLOBAL user setting (Settings → Context Window & Token Budgets),
        // falling back to DEFAULT_MAX_TOKENS (core/030-config.js). Legacy
        // per-provider maxTokens still stored on old providers in IndexedDB
        // is deliberately IGNORED — pure-global design, global wins.
        max_tokens: getGlobalMaxTokens(),
        usage: { include: true }  // Required to get cache info in response
    };
    // Claude 4.7+ returns 400 on any non-default sampling param (temperature/
    // top_p/top_k), so omit temperature entirely for Anthropic models — the
    // default is 1 anyway. Keep the explicit default for other providers.
    if (!isAnthropic) {
        requestBody.temperature = 1;
    }
    // For Anthropic models, disable transforms to pass through cache_control
    if (isAnthropic) {
        requestBody.transforms = [];
    }
    // Adaptive-only Claude models (Opus 4.7+, Fable 5, Mythos 5) reject
    // budget-style thinking (`budget_tokens` → 400 error); the effort parameter
    // is the only thinking-depth control. Ignore any legacy thinkingBudget on
    // the provider for those models so a provider created from the generic
    // template doesn't 400. Detection lives in core/030-config.js
    // (isAdaptiveOnlyClaude) so the page and SW bundles share one pattern.
    var isAdaptiveOnly = isAdaptiveOnlyClaude(modelLower);
    // Enable reasoning - OpenRouter handles the format normalization.
    // GLOBAL user setting (Settings → Context Window & Token Budgets),
    // falling back to DEFAULT_THINKING_BUDGET (core/030-config.js) — but do
    // NOT inject the budget onto effort-style providers: OpenRouter treats
    // reasoning.effort and reasoning.max_tokens as alternative controls,
    // and stacking an uninvited budget onto e.g. gpt-5.5 (effort-only) is
    // an untested shape that may 400 on some routes. Legacy per-provider
    // thinkingBudget still stored on old providers is IGNORED here (global
    // wins) — only the adaptive-only legacy branch below reads the raw
    // stored value.
    var thinkingBudget = provider.effort ? 0 : getGlobalThinkingBudget();
    if (thinkingBudget && !isAdaptiveOnly) {
        requestBody.reasoning = { max_tokens: thinkingBudget };
    }
    if (provider.effort) {
        if (!requestBody.reasoning) requestBody.reasoning = {};
        requestBody.reasoning.effort = provider.effort;
    }
    if (isAdaptiveOnly && provider.thinkingBudget && !requestBody.reasoning) {
        // A legacy thinkingBudget was suppressed above and no effort is
        // configured: send the documented default effort explicitly so
        // OpenRouter doesn't fall back to budget-style thinking. When the
        // provider has NEITHER thinkingBudget nor effort, leave reasoning
        // absent — "(default)" effort must keep meaning the model default.
        requestBody.reasoning = { effort: 'high' };
    }
	if (provider.provider) {
		requestBody.provider = {
			only: [provider.provider],
			//allow_fallbacks: false
		};
	}

    // If messages contain PDF files, tell OpenRouter to use native file handling
    // (avoids format conversion conflicts between type:'file' and tool_result blocks)
    var hasPdfContent = messagesWithCache.some(function(m) {
        return Array.isArray(m.content) && m.content.some(function(c) { return c.type === 'file'; });
    });
    if (hasPdfContent) {
        requestBody.plugins = [{ id: 'file-parser', pdf: { engine: 'native' } }];
    }

    // Store request body in metrics for debugging
    reqMetrics.requestBody = requestBody;

    // Stable per-chat Codex session identity: the chatgpt.com/backend-api/codex
    // Responses endpoint keys its prompt cache off the session/thread headers
    // and prompt_cache_key (openai/codex#5556) — a fresh UUID per request
    // re-keys the cache every turn and guarantees a 0% hit rate. Stamp a
    // deterministic per-chat key on the body; it survives the port JSON
    // round-trip to runChatGPTOAuthStream (background.js), which uses it for
    // the session-id/thread-id/x-client-request-id headers, and
    // transformToResponses maps it to `prompt_cache_key`. Never sent raw:
    // transformToResponses builds the upstream body fresh, and this branch is
    // unreachable for the plain-fetch (OpenRouter/OpenAI-key) and Claude OAuth
    // paths, so no other provider ever sees the field.
    if (provider.isChatGPTOAuth) {
        requestBody._codexSessionKey = getCodexSessionKey(chatId);
    }

    // Prompt-cache heartbeat: stamp the finalized request body per chat so the
    // SW alarm (background.js) can re-send an identical-prefix 1-token request
    // when the chat sits waiting on sub-agents past the cache-TTL window.
    _stampCacheHeartbeat(chatId, requestBody, currentProvider);

    var reader;

    // Claude OAuth: route through the SW's runClaudeOAuthStream proxy.
    // Two code paths:
    //   • SW context (Platform.isWorker): we're already in the SW —
    //     call runClaudeOAuthStream directly. Connecting to a port
    //     named 'claude-oauth-stream' from inside the SW would fire
    //     onConnect in every OTHER extension context, never our own.
    //   • Page context: connect to the SW port (legacy path).
    if ((provider.isClaudeOAuth || provider.isChatGPTOAuth) && typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.connect) {
        reader = await (function() {
            return new Promise(function(resolve) {
                var chunks = [];
                var resolveRead = null;
                var streamDone = false;
                function onEnvelope(env) {
                    if (env.type === 'error') {
                        // Preserve transport classification through the synthetic SSE
                        // bridge. The parser below rehydrates these fields onto Error,
                        // allowing the outer loop to honor retryable:false.
                        var encoded = new TextEncoder().encode('data: ' + JSON.stringify({ error: { message: env.error, type: 'api_error', code: env.code, retryable: env.retryable } }) + '\n\n');
                        if (resolveRead) {
                            var r = resolveRead; resolveRead = null;
                            r({ value: encoded, done: false });
                        } else {
                            chunks.push(encoded);
                        }
                    } else if (env.type === 'sse') {
                        var encoded = new TextEncoder().encode(env.data);
                        if (resolveRead) {
                            var r = resolveRead; resolveRead = null;
                            r({ value: encoded, done: false });
                        } else {
                            chunks.push(encoded);
                        }
                    } else if (env.type === 'status') {
                        // Transport-level progress (429/529 backoff, concurrents
                        // slot park) from the SW streamer — NOT part of the SSE
                        // stream, so never queued into chunks. Relay via the agent
                        // event bus: in the SW the broadcast bridge (worker/100)
                        // forwards every emit to all connected panels; in page
                        // context the local 036 handler fires directly.
                        try {
                            if (typeof AgentEvents !== 'undefined' && AgentEvents.emit) {
                                // chatId lets the page-side handler mirror the
                                // status INLINE into the owning chat's status row
                                // (compact "Thinking…" bar / spinner text) instead
                                // of only the transient snackbar.
                                AgentEvents.emit('llmTransportStatus', { message: env.message, status: env.status, reason: env.reason, waitMs: env.waitMs, chatId: chatId });
                            }
                        } catch (e) {}
                    } else if (env.type === 'done') {
                        streamDone = true;
                        if (resolveRead) {
                            var r = resolveRead; resolveRead = null;
                            r({ value: undefined, done: true });
                        }
                    }
                }
                var fakeReader = {
                    read: function() {
                        if (chunks.length > 0) return Promise.resolve({ value: chunks.shift(), done: false });
                        if (streamDone) return Promise.resolve({ value: undefined, done: true });
                        return new Promise(function(res) { resolveRead = res; });
                    }
                };

                // Both OAuth providers speak the SAME envelope contract; only the
                // SW entry point and the port name differ.
                var _oauthStreamFn = provider.isChatGPTOAuth ? 'runChatGPTOAuthStream' : 'runClaudeOAuthStream';
                var _oauthPortName = provider.isChatGPTOAuth ? 'chatgpt-oauth-stream' : 'claude-oauth-stream';
                if (typeof Platform !== 'undefined' && Platform.isWorker && typeof self[_oauthStreamFn] === 'function') {
                    // SW-internal: call the streamer directly.
                    var signal = (abortController && abortController.signal) || null;
                    self[_oauthStreamFn](requestBody, onEnvelope, signal);
                    resolve(fakeReader);
                    return;
                }

                // Page-side fallback path: port-based.
                var port = chrome.runtime.connect({ name: _oauthPortName });
                if (abortController && abortController.signal) {
                    abortController.signal.addEventListener('abort', function() {
                        try { port.disconnect(); } catch (e) {}
                        streamDone = true;
                        if (resolveRead) {
                            var r = resolveRead; resolveRead = null;
                            var err = new Error('User aborted stream');
                            err.name = 'AbortError';
                            r({ value: undefined, done: true, _abortErr: err });
                        }
                    });
                }
                port.onMessage.addListener(onEnvelope);
                port.onDisconnect.addListener(function() {
                    streamDone = true;
                    if (resolveRead) {
                        var r = resolveRead; resolveRead = null;
                        r({ value: undefined, done: true });
                    }
                });
                port.postMessage({ type: 'start-stream', body: JSON.stringify(requestBody) });
                resolve(fakeReader);
            });
        })();
    } else {
        // Standard fetch path uses the provider's inline endpoint and API key.
        var fetchOpts = {
            method: 'POST',
            headers: {
                'Authorization': 'Bearer ' + provider.apiKey,
                'Content-Type': 'application/json',
                // Worker-safe: getReferer() returns a stable string in offscreen
                // (window.location.href there is offscreen.html, not useful).
                'HTTP-Referer': (typeof Platform !== 'undefined' && Platform.getReferer)
                    ? Platform.getReferer()
                    : (Platform.instanceUrl || (typeof window !== 'undefined' ? window.location.href : ''))
            },
            body: JSON.stringify(requestBody)
        };
        if (abortController && abortController.signal) fetchOpts.signal = abortController.signal;
        var res = await fetch(provider.endpoint, fetchOpts);

        if (!res.ok) {
            setLLMConnectionStatus('disconnected');
            var errorText = await res.text();
            var requestBodyStr = JSON.stringify(requestBody);
            console.error('API Error Response:', errorText);
            console.error('Request size:', Math.round(requestBodyStr.length / 1024) + 'KB, messages:', requestBody.messages.length);
            console.error('Provider config:', JSON.stringify({ model: provider.model, provider: provider.provider, endpoint: provider.endpoint }));
            console.error('Request provider setting:', JSON.stringify(requestBody.provider));
            var lastMsgs = requestBody.messages.slice(-5).map(function(m) {
                return { role: m.role, hasToolCalls: !!m.tool_calls, hasContent: !!(m.content && (typeof m.content === 'string' ? m.content.length : m.content.length) > 0), hasReasoning: !!m.reasoning_details };
            });
            console.error('Last 5 messages:', JSON.stringify(lastMsgs));
            try {
                var errorData = JSON.parse(errorText);
                var rawError = errorData.error?.metadata?.raw;
                if (rawError) {
                    try {
                        var rawParsed = JSON.parse(rawError);
                        throw new Error(rawParsed.message || rawError);
                    } catch (parseErr) {
                        throw new Error(rawError);
                    }
                }
                throw new Error(errorData.error?.message || 'API request failed');
            } catch (e) {
                // F5-1: attach the HTTP status to whatever error propagates so
                // the agent-loop throttle classifier can detect a 429/502/503/529
                // even when the proxy body is an HTML page whose markup the
                // message-regex can't match (see app/030-agent-loop.js).
                if (e.message && !e.message.includes('JSON')) { e._httpStatus = res.status; throw e; }
                // Cap the raw body — full text is already console.error'd above;
                // a multi-KB provider payload must not flood downstream UIs.
                var _apiErr = new Error('API request failed: ' + String(errorText).slice(0, 300));
                _apiErr._httpStatus = res.status;
                throw _apiErr;
            }
        }

        reader = res.body.getReader();
    }
    // Badge fix: a 200 response is NOT proof the OAuth session is valid for the
    // header pill (the SW may hold a token; this may be a non-OAuth provider).
    // For OAuth providers re-verify real login/expiry instead of blindly going
    // green, otherwise the chat page shows 'connected' even when logged out.
    if (provider && provider.isChatGPTOAuth && typeof updateChatGPTOAuthStatus === 'function') {
        updateChatGPTOAuthStatus();
    } else if (provider && provider.isClaudeOAuth && typeof updateClaudeOAuthStatus === 'function') {
        updateClaudeOAuthStatus();
    } else {
        setLLMConnectionStatus('connected');
    }
    var decoder = new TextDecoder();
    var buffer = '';
    var thinking = '';
    var content = '';
    var toolCalls = [];
    var refusalFinish = null; // finish_reason 'refusal'/'content_filter' seen in stream
    var toolCallBuffers = {};
    var reasoningDetails = []; // Preserve for API continuity
    var reasoningDetailsMap = {}; // Merge streaming fragments by index
    var isAnthropicModel = modelLower.includes('anthropic') || modelLower.includes('claude');

    var chunkCount = 0;
    var lastUpdateTime = Date.now();

    var streamDone = false;
    while (!streamDone) {
        var result = await reader.read();
        streamDone = result.done;

        // User-requested abort — throw so the agent loop can handle it as an interrupt.
        if (abortController && abortController.signal && abortController.signal.aborted) {
            var abortErr = new Error('Stream aborted by user');
            abortErr.name = 'AbortError';
            abortErr.isUserAbort = true;
            throw abortErr;
        }

        // Decode chunk
        var chunk = decoder.decode(result.value, { stream: !streamDone });
        buffer += chunk;

        var lines = buffer.split('\n');
        buffer = streamDone ? '' : (lines.pop() || '');

        for (var i = 0; i < lines.length; i++) {
            var line = lines[i].trim();
            if (!line || line === 'data: [DONE]') continue;
            if (!line.startsWith('data: ')) continue;

            // Skip OpenRouter processing placeholder messages
            if (line.includes('OPENROUTER PROCESSING') || line.includes(': OPENROUTER')) {
                chunkCount++;
                // Notify about stream activity even during processing
                if (onStreamStatus && Date.now() - lastUpdateTime > 500) {
                    onStreamStatus('processing', chunkCount);
                    lastUpdateTime = Date.now();
                }
                continue;
            }

            var jsonStr = line.substring(6);

            try {
                var data = JSON.parse(jsonStr);

                // Detect error responses in stream (backend errors sent mid-stream)
                if (data.error) {
                    var errMsg = data.error.message || (typeof data.error === 'string' ? data.error : JSON.stringify(data.error));
                    var apiErr = new Error(errMsg);
                    // Structured transport classification must survive envelope →
                    // synthetic SSE → Error. Assign by presence so false is retained.
                    if (data.error && typeof data.error === 'object') {
                        if (data.error.code !== undefined) apiErr.code = data.error.code;
                        if (data.error.retryable !== undefined) apiErr.retryable = data.error.retryable;
                    }
                    // Flag so the parse-error swallow below can't eat a genuine
                    // in-stream API error whose text happens to contain 'JSON'
                    // or 'Unexpected token'.
                    apiErr.isApiError = true;
                    throw apiErr;
                }

                // Capture usage data from OpenRouter
                if (data.usage) {
                    // Terminal usage is authoritative, including legitimate zeroes.
                    // Assignment-by-presence prevents stale values surviving when a
                    // provider reports 0 for a detail on the latest assistant turn.
                    if (Number.isFinite(data.usage.prompt_tokens)) reqMetrics.input_tokens = data.usage.prompt_tokens;
                    if (Number.isFinite(data.usage.completion_tokens)) reqMetrics.output_tokens = data.usage.completion_tokens;
                    if (Number.isFinite(data.usage.total_tokens)) reqMetrics.total_tokens = data.usage.total_tokens;
                    // Capture cache info from OpenRouter (Anthropic models via OpenRouter)
                    if (data.usage.cache_creation_input_tokens) reqMetrics.cache_creation_tokens = data.usage.cache_creation_input_tokens;
                    if (data.usage.cache_read_input_tokens) reqMetrics.cache_read_tokens = data.usage.cache_read_input_tokens;
                    // Also check prompt_tokens_details for cache info
                    if (data.usage.prompt_tokens_details) {
                        if (Number.isFinite(data.usage.prompt_tokens_details.cached_tokens)) reqMetrics.cache_read_tokens = data.usage.prompt_tokens_details.cached_tokens;
                        if (Number.isFinite(data.usage.prompt_tokens_details.cache_write_tokens)) reqMetrics.cache_write_tokens = data.usage.prompt_tokens_details.cache_write_tokens;
                    }
                    // Capture cost
                    if (data.usage.cost !== undefined) reqMetrics.cost = data.usage.cost;
                    // Capture reasoning tokens from completion_tokens_details
                    if (data.usage.completion_tokens_details) {
                        if (Number.isFinite(data.usage.completion_tokens_details.reasoning_tokens)) reqMetrics.reasoning_tokens = data.usage.completion_tokens_details.reasoning_tokens;
                    }
                }
                // Check for cache_discount at top level of response (OpenRouter cache savings)
                if (data.cache_discount !== undefined) {
                    reqMetrics.cache_discount = data.cache_discount;
                }
                // Capture the actual model/provider used (OpenRouter returns the routed model)
                if (data.model) {
                    reqMetrics.actualModel = data.model;
                    // Update header display with full model name
                    updateModelDisplayWithProvider(data.model);
                }
                // Capture the actual provider from the response (e.g., "Parasail")
                if (data.provider) {
                    reqMetrics.providerName = data.provider;
                }

                chunkCount++;

                var choice = data.choices && data.choices[0];
                if (!choice) continue;

                // Fable 5 / Opus 4.7+ refusals arrive as a SUCCESSFUL stream with
                // finish_reason 'refusal' (OpenRouter passes Anthropic's stop_reason
                // through; some routes normalize it to 'content_filter'). Track it so
                // the turn doesn't end as a silent empty message — mirrors the
                // OAuth-path handling in src/platform/extension/background.js.
                if (choice.finish_reason === 'refusal' || choice.finish_reason === 'content_filter') {
                    refusalFinish = choice.finish_reason;
                }

                var delta = choice.delta;
                var thinkingChunk = null;

                // Check for thinking/reasoning in delta
                if (delta) {
                    
                    // ALWAYS accumulate reasoning_details when present (for API continuity)
                    // Also extract text for display as fallback
                    var reasoningDetailsText = '';
                    if (delta.reasoning_details && Array.isArray(delta.reasoning_details)) {
                        delta.reasoning_details.forEach(function(rd) {
                            // Extract text for display
                            if (rd.text) {
                                reasoningDetailsText += rd.text;
                            } else if (rd.thinking) {
                                reasoningDetailsText += rd.thinking;
                            } else if (rd.content) {
                                reasoningDetailsText += rd.content;
                            }
                            
                            // Merge by index for API continuity
                            var idx = rd.index !== undefined ? rd.index : 0;
                            if (reasoningDetailsMap[idx]) {
                                var existing = reasoningDetailsMap[idx];
                                if (rd.text) existing.text = (existing.text || '') + rd.text;
                                if (rd.thinking) existing.thinking = (existing.thinking || '') + rd.thinking;
                                if (rd.content) existing.content = (existing.content || '') + rd.content;
                                if (rd.signature && rd.signature.length > 0) existing.signature = rd.signature;
                                if (rd.data) existing.data = rd.data;
                            } else {
                                reasoningDetailsMap[idx] = Object.assign({}, rd);
                            }
                        });
                    }
                    
                    // Priority order for DISPLAY: reasoning > reasoning_content > thinking > reasoning_details
                    var thinkingSource = null;
                    if (delta.reasoning) {
                        thinkingChunk = delta.reasoning;
                        thinkingSource = 'delta.reasoning';
                    } else if (delta.reasoning_content) {
                        thinkingChunk = delta.reasoning_content;
                        thinkingSource = 'delta.reasoning_content';
                    } else if (delta.thinking) {
                        thinkingChunk = delta.thinking;
                        thinkingSource = 'delta.thinking';
                    } else if (reasoningDetailsText) {
                        thinkingChunk = reasoningDetailsText;
                        thinkingSource = 'reasoning_details.text';
                    }
                    
                    if (thinkingChunk) {
                        thinking += thinkingChunk;
                        onThinking(thinking);
                    }

                    if (typeof delta.content === 'string' && delta.content) {
                        content += delta.content;
                        onContent(content);
                    }

                    if (delta.tool_calls) {
                        delta.tool_calls.forEach(function(tc) {
                            // Use index as key - this is the standard OpenAI streaming protocol
                            // ID is only sent on first chunk, subsequent chunks use index to correlate
                            var idx = tc.index;
                            if (!toolCallBuffers[idx]) {
                                toolCallBuffers[idx] = {
                                    id: tc.id || '',
                                    type: 'function',
                                    function: { name: '', arguments: '' }
                                };
                            }
                            // Capture ID from first chunk (subsequent chunks have id: null)
                            if (tc.id) toolCallBuffers[idx].id = tc.id;
                            if (tc.function) {
                                if (tc.function.name) toolCallBuffers[idx].function.name += tc.function.name;
                                if (tc.function.arguments) toolCallBuffers[idx].function.arguments += tc.function.arguments;
                            }
                        });
                        toolCalls = Object.keys(toolCallBuffers).map(function(k) {
                            return toolCallBuffers[k];
                        });
                        onToolCall(toolCalls);
                    }
                }

                // Handle choice-level and message-level thinking (non-delta format)
                // Only add if we didn't already get thinking from delta in this chunk
                if (!thinkingChunk) {
                    var choiceThinking = null;
                    
                    if (choice.reasoning) {
                        choiceThinking = choice.reasoning;
                    } else if (choice.message) {
                        // Priority: reasoning > thinking > reasoning_details
                        if (choice.message.reasoning) {
                            choiceThinking = choice.message.reasoning;
                        } else if (choice.message.thinking) {
                            choiceThinking = choice.message.thinking;
                        } else if (choice.message.reasoning_details && Array.isArray(choice.message.reasoning_details)) {
                            var detailText = '';
                            for (var rd = 0; rd < choice.message.reasoning_details.length; rd++) {
                                var detail = choice.message.reasoning_details[rd];
                                if (detail.thinking) detailText += detail.thinking;
                                else if (detail.content) detailText += detail.content;
                            }
                            if (detailText) choiceThinking = detailText;
                        }
                    }
                    
                    if (choiceThinking && !thinking.includes(choiceThinking)) {
                        thinking += choiceThinking;
                        onThinking(thinking);
                    }
                }
                
                // Capture content and tool_calls from choice.message (non-streaming format)
                if (choice.message) {
                    if (choice.message.content && !content.includes(choice.message.content)) {
                        content += choice.message.content;
                        onContent(content);
                    }
                    
                    if (choice.message.tool_calls && choice.message.tool_calls.length > 0) {
                        // Only use choice.message.tool_calls if we haven't accumulated any from delta streaming
                        // Some models send incomplete tool_calls in choice.message that would overwrite good streamed data
                        if (toolCalls.length === 0) {
                            toolCalls = choice.message.tool_calls;
                            onToolCall(toolCalls);
                        }
                    }
                    
                    // Preserve reasoning_details for API continuity - this is the complete version with signatures
                    if (choice.message.reasoning_details) {
                        reasoningDetails = choice.message.reasoning_details;
                    }
                }

            } catch (e) {
                // Re-throw real errors (e.g. API errors detected in stream)
                // Only silently continue for JSON parse errors
                if (e && e.isApiError) throw e;
                if (e.message && !e.message.includes('JSON') && !e.message.includes('Unexpected token')) throw e;
            }
        }
    }

    // Build reasoningDetails array from merged map (if not already set by choice.message)
    if (reasoningDetails.length === 0 && Object.keys(reasoningDetailsMap).length > 0) {
        // Sort by index and build array
        var indices = Object.keys(reasoningDetailsMap).map(Number).sort(function(a, b) { return a - b; });
        indices.forEach(function(idx) {
            reasoningDetails.push(reasoningDetailsMap[idx]);
        });
    }

    // Capture usage from OpenRouter if available in final data
    // OpenRouter typically includes usage in X-headers or final message
    
    // Surface refusals as visible assistant text (see refusalFinish capture in
    // the chunk loop). 'content_filter' only counts when the model produced no
    // content at all — some providers use it for partial output filtering.
    if (refusalFinish && (refusalFinish === 'refusal' || !content)) {
        content += (content ? '\n\n' : '') + '[Request declined by the model (' + provider.model + '). Refused requests can often be served by a different model — switch the provider and retry.]';
        onContent(content);
    }

    // IMPORTANT: Only pass back reasoning_details that came from the API
    // Do NOT construct it ourselves - that can cause issues with subsequent calls
    onDone({
        thinking: thinking,
        content: content,
        tool_calls: toolCalls.length > 0 ? toolCalls : null,
        reasoning_details: reasoningDetails.length > 0 ? reasoningDetails : null
    });
}

// ─── Prompt-cache heartbeat ─────────────────────────────────────────────
// The Anthropic prompt cache expires ~5 minutes after the last request. When
// a parent chat is waiting on sub-agents (blocked in await_handle, or turn
// ended waiting for wake_parent), the 30s `agent-heartbeat` alarm in
// background.js calls sendCacheHeartbeat(chatId) after 4 idle minutes to
// re-send the EXACT same prompt prefix with max_tokens:1, refreshing the
// cache TTL. The response is discarded entirely — it never touches
// chat.messages, metrics, or the UI.
//
// Registry is SW-scope global state keyed by chatId. The body is stored as a
// JSON string at stamp time so later in-place mutations of message objects
// elsewhere can never drift the heartbeat body away from what was sent.

// ─── Codex per-chat session key ─────────────────────────────────────────
// Deterministic chatId → UUID mapping for the ChatGPT OAuth (Codex) path.
// Codex CLI keeps ONE session_id/thread_id UUID for the lifetime of a
// conversation and sends session_id as prompt_cache_key
// (codex-rs/core/src/client.rs prompt_cache_key(),
// codex-api/src/requests/headers.rs build_session_headers) — the backend
// routes its prompt cache off these, so they must be STABLE per chat. Chat
// ids ("chat_1788..._x") are not UUIDs, so hash the id into UUID shape
// (FNV-1a ×4 with distinct seeds). Deterministic ⇒ the same chat always maps
// to the same UUID across service-worker restarts and page reloads, with no
// storage to persist or migrate. The memo map is just a hot-path shortcut.
function getCodexSessionKey(chatId) {
    var key = String(chatId || 'no-chat');
    var reg = (typeof self !== 'undefined') ? (self._codexSessionKeys = self._codexSessionKeys || {}) : {};
    if (reg[key]) return reg[key];
    function fnv32(str, seed) {
        var h = (0x811c9dc5 ^ seed) >>> 0;
        for (var i = 0; i < str.length; i++) {
            h ^= str.charCodeAt(i);
            h = Math.imul(h, 0x01000193) >>> 0;
        }
        return ('00000000' + h.toString(16)).slice(-8);
    }
    var hex = fnv32(key, 0) + fnv32(key, 0x9e3779b9) + fnv32(key, 0x85ebca6b) + fnv32(key, 0xc2b2ae35);
    // Shape into a syntactically valid v4/variant-1 UUID so upstream header
    // validators that expect UUID format accept it.
    var uuid = hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-4' + hex.slice(13, 16) + '-'
        + ((parseInt(hex.charAt(16), 16) & 0x3 | 0x8).toString(16)) + hex.slice(17, 20) + '-' + hex.slice(20, 32);
    reg[key] = uuid;
    return uuid;
}
if (typeof self !== 'undefined') { self.getCodexSessionKey = getCodexSessionKey; }

function _stampCacheHeartbeat(chatId, requestBody, providerName) {
    if (!chatId) return;
    try {
        var reg = self._cacheHeartbeat = self._cacheHeartbeat || {};
        // Two timestamps: lastRealRequestAt anchors the 2h lifetime cutoff in
        // _cacheHeartbeatTick (background.js) and is IMMUTABLE between real
        // requests — heartbeats must never extend the lifetime, or the hard
        // stop can never fire. lastHeartbeatAt drives the 4-minute cadence.
        // `at` is kept as a legacy alias (old tick code read it) and is no
        // longer mutated by sendCacheHeartbeat.
        reg[chatId] = {
            at: Date.now(),
            lastRealRequestAt: Date.now(),
            bodyJson: JSON.stringify(requestBody),
            provider: providerName,
            chatId: chatId
        };
    } catch (e) { /* best-effort — never break the real request path */ }
}

function sendCacheHeartbeat(chatId) {
    var reg = (typeof self !== 'undefined') ? self._cacheHeartbeat : null;
    var entry = reg && reg[chatId];
    if (!entry || !entry.bodyJson) return false;
    // Stamp the heartbeat time NOW, before dispatch: prevents double-fire
    // from overlapping alarm ticks, and doubles as retry-storm suppression on
    // hard failure (next attempt is another 4 minutes out either way).
    // Deliberately NOT entry.at / entry.lastRealRequestAt — those anchor the
    // 2h lifetime cutoff in _cacheHeartbeatTick and only real requests
    // (_stampCacheHeartbeat) may reset them.
    entry.lastHeartbeatAt = Date.now();
    try {
        var body = JSON.parse(entry.bodyJson);
        body.max_tokens = 1;
        body.stream = false;
        // Thinking budgets require max_tokens > budget — a heartbeat with
        // max_tokens:1 + reasoning would 400. Stripping `reasoning` does not
        // change the cached prefix (system/messages/tools stay untouched);
        // for the OAuth path it also stops transformToAnthropic from adding
        // a `thinking` block.
        delete body.reasoning;
        // usage accounting is pointless for a discarded 1-token response.
        delete body.usage;

        var provider = getProviderById(entry.provider);
        if (!provider) return false;

        if (provider.isChatGPTOAuth) {
            // The Codex backend DOES keep an implicit prompt cache (~5-10 min
            // TTL) routed by the stable session headers + prompt_cache_key
            // (openai/codex#5556). Re-send the identical prefix through
            // runChatGPTOAuthStream — the stamped body still carries
            // _codexSessionKey, so the heartbeat reuses the SAME
            // session-id/thread-id headers and prompt_cache_key as the real
            // request — with a minimal continuation. _maxOutputTokens maps to
            // Responses `max_output_tokens` in transformToResponses (16 is the
            // API minimum; the chat-completions `max_tokens` set above is
            // ignored by that transform). Same discard contract as the Claude
            // branch below: a short stream ends by itself, no abort needed.
            // Only reachable in the SW (the alarm lives there).
            if (typeof self !== 'undefined' && typeof self.runChatGPTOAuthStream === 'function') {
                body.stream = true;
                body._maxOutputTokens = 16;
                self.runChatGPTOAuthStream(body, function discard() {}, null);
                return true;
            }
            return false;
        }
        if (provider.isClaudeOAuth) {
            // transformToAnthropic hardcodes stream:true, so send streaming
            // and discard every envelope — a 1-token stream ends immediately,
            // no abort needed. Only reachable in the SW (the alarm lives
            // there); in page context we simply skip.
            if (typeof self !== 'undefined' && typeof self.runClaudeOAuthStream === 'function') {
                body.stream = true;
                self.runClaudeOAuthStream(body, function discard() {}, null);
                return true;
            }
            return false;
        }

        // Non-OAuth providers: plain fetch with the same headers as the real
        // path (callOpenRouterStreaming's fetch branch). Fire-and-forget.
        fetch(provider.endpoint, {
            method: 'POST',
            headers: {
                'Authorization': 'Bearer ' + provider.apiKey,
                'Content-Type': 'application/json',
                'HTTP-Referer': (typeof Platform !== 'undefined' && Platform.getReferer)
                    ? Platform.getReferer()
                    : (Platform.instanceUrl || (typeof window !== 'undefined' ? window.location.href : ''))
            },
            body: JSON.stringify(body)
        }).then(function(res) {
            if (!res.ok) console.warn('[cache-heartbeat] non-OK response for chat', chatId, res.status);
            // Drain/cancel so the connection is released.
            try { if (res.body && res.body.cancel) res.body.cancel(); } catch (e2) {}
        }).catch(function(e2) {
            console.warn('[cache-heartbeat] fetch failed for chat', chatId, e2 && e2.message);
        });
        return true;
    } catch (e) {
        console.warn('[cache-heartbeat] failed for chat', chatId, e && e.message);
        return false;
    }
}

// Expose for the SW alarm handler in background.js (importScripts shares the
// worker global scope, but be explicit like Handles/SubAgents are).
if (typeof self !== 'undefined') { self.sendCacheHeartbeat = sendCacheHeartbeat; }
