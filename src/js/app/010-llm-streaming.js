async function callLLMStreaming(chatMessages, onThinking, onContent, onToolCall, onDone, onStreamStatus, chatId) {
    var apiMsgs = buildAPIMessages(chatMessages, chatId);
    // Register an AbortController so a user-typed message can interrupt the in-flight stream.
    var abortController = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    if (chatId && abortController) currentStreamAbortControllers[chatId] = abortController;
    try {
        // Thread chatId through so the system prompt builder can append the
        // sub-agent preamble when the chat is a sub-agent (see 100-cached-results.js).
        return await callOpenRouterStreaming(currentProvider, apiMsgs, onThinking, onContent, onToolCall, onDone, onStreamStatus, abortController, chatId);
    } finally {
        if (chatId && currentStreamAbortControllers[chatId] === abortController) {
            delete currentStreamAbortControllers[chatId];
        }
    }
}

async function callOpenRouterStreaming(currentProvider, messages, onThinking, onContent, onToolCall, onDone, onStreamStatus, abortController, chatId) {
    var provider = getProviderById(currentProvider);

    if (!provider) {
        throw new Error('Provider "' + currentProvider + '" not found. Please select a valid model in settings.');
    }

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
        temperature: 1,
        //top_p: 0.95,
        //top_k: 40,
        max_tokens: provider.maxTokens,
        usage: { include: true }  // Required to get cache info in response
    };
    // For Anthropic models, disable transforms to pass through cache_control
    if (isAnthropic) {
        requestBody.transforms = [];
    }
    // Enable reasoning - OpenRouter handles the format normalization
    if (provider.thinkingBudget) {
        requestBody.reasoning = { max_tokens: provider.thinkingBudget };
    }
    if (provider.effort) {
        if (!requestBody.reasoning) requestBody.reasoning = {};
        requestBody.reasoning.effort = provider.effort;
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
    lastRequestMetrics.requestBody = requestBody;

    var reader;

    // Claude OAuth: route through the SW's runClaudeOAuthStream proxy.
    // Two code paths:
    //   • SW context (Platform.isWorker): we're already in the SW —
    //     call runClaudeOAuthStream directly. Connecting to a port
    //     named 'claude-oauth-stream' from inside the SW would fire
    //     onConnect in every OTHER extension context, never our own.
    //   • Page context: connect to the SW port (legacy path).
    if (provider.isClaudeOAuth && typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.connect) {
        reader = await (function() {
            return new Promise(function(resolve) {
                var chunks = [];
                var resolveRead = null;
                var streamDone = false;
                function onEnvelope(env) {
                    if (env.type === 'error') {
                        var encoded = new TextEncoder().encode('data: ' + JSON.stringify({ error: { message: env.error, type: 'api_error' } }) + '\n\n');
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

                if (typeof Platform !== 'undefined' && Platform.isWorker && typeof self.runClaudeOAuthStream === 'function') {
                    // SW-internal: call the streamer directly.
                    var signal = (abortController && abortController.signal) || null;
                    self.runClaudeOAuthStream(requestBody, onEnvelope, signal);
                    resolve(fakeReader);
                    return;
                }

                // Page-side fallback path: port-based.
                var port = chrome.runtime.connect({ name: 'claude-oauth-stream' });
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
        // Standard fetch path
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
                if (e.message && !e.message.includes('JSON')) throw e;
                throw new Error('API request failed: ' + errorText);
            }
        }

        reader = res.body.getReader();
    }
    // Badge fix: a 200 response is NOT proof the OAuth session is valid for the
    // header pill (the SW may hold a token; this may be a non-OAuth provider).
    // For OAuth providers re-verify real login/expiry instead of blindly going
    // green, otherwise the chat page shows 'connected' even when logged out.
    if (provider && provider.isClaudeOAuth && typeof updateClaudeOAuthStatus === 'function') {
        updateClaudeOAuthStatus();
    } else {
        setLLMConnectionStatus('connected');
    }
    var decoder = new TextDecoder();
    var buffer = '';
    var thinking = '';
    var content = '';
    var toolCalls = [];
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
                    throw new Error(errMsg);
                }

                // Capture usage data from OpenRouter
                if (data.usage) {
                    lastRequestMetrics = lastRequestMetrics || {};
                    if (data.usage.prompt_tokens) lastRequestMetrics.input_tokens = data.usage.prompt_tokens;
                    if (data.usage.completion_tokens) lastRequestMetrics.output_tokens = data.usage.completion_tokens;
                    if (data.usage.total_tokens) lastRequestMetrics.total_tokens = data.usage.total_tokens;
                    // Capture cache info from OpenRouter (Anthropic models via OpenRouter)
                    if (data.usage.cache_creation_input_tokens) lastRequestMetrics.cache_creation_tokens = data.usage.cache_creation_input_tokens;
                    if (data.usage.cache_read_input_tokens) lastRequestMetrics.cache_read_tokens = data.usage.cache_read_input_tokens;
                    // Also check prompt_tokens_details for cache info
                    if (data.usage.prompt_tokens_details) {
                        if (data.usage.prompt_tokens_details.cached_tokens) lastRequestMetrics.cache_read_tokens = data.usage.prompt_tokens_details.cached_tokens;
                        if (data.usage.prompt_tokens_details.cache_write_tokens) lastRequestMetrics.cache_write_tokens = data.usage.prompt_tokens_details.cache_write_tokens;
                    }
                    // Capture cost
                    if (data.usage.cost !== undefined) lastRequestMetrics.cost = data.usage.cost;
                    // Capture reasoning tokens from completion_tokens_details
                    if (data.usage.completion_tokens_details) {
                        if (data.usage.completion_tokens_details.reasoning_tokens) lastRequestMetrics.reasoning_tokens = data.usage.completion_tokens_details.reasoning_tokens;
                    }
                }
                // Check for cache_discount at top level of response (OpenRouter cache savings)
                if (data.cache_discount !== undefined) {
                    lastRequestMetrics = lastRequestMetrics || {};
                    lastRequestMetrics.cache_discount = data.cache_discount;
                }
                // Capture the actual model/provider used (OpenRouter returns the routed model)
                if (data.model) {
                    lastRequestMetrics = lastRequestMetrics || {};
                    lastRequestMetrics.actualModel = data.model;
                    // Update header display with full model name
                    updateModelDisplayWithProvider(data.model);
                }
                // Capture the actual provider from the response (e.g., "Parasail")
                if (data.provider) {
                    lastRequestMetrics = lastRequestMetrics || {};
                    lastRequestMetrics.providerName = data.provider;
                }

                chunkCount++;

                var choice = data.choices && data.choices[0];
                if (!choice) continue;

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
    
    // IMPORTANT: Only pass back reasoning_details that came from the API
    // Do NOT construct it ourselves - that can cause issues with subsequent calls
    onDone({
        thinking: thinking,
        content: content,
        tool_calls: toolCalls.length > 0 ? toolCalls : null,
        reasoning_details: reasoningDetails.length > 0 ? reasoningDetails : null
    });
}
