// Compress a base64 image if its decoded size exceeds maxBytes.
// Re-encodes as JPEG with decreasing quality until under limit.
// Returns the original base64 if already under limit.
async function compressBase64Image(base64, maxBytes) {
    maxBytes = maxBytes || 4718592; // 4.5MB default (safe margin under 5MB API limit)
    var commaIdx = base64.indexOf(',');
    var b64Part = commaIdx >= 0 ? base64.substring(commaIdx + 1) : base64;
    var decodedSize = Math.floor(b64Part.length * 3 / 4);
    if (b64Part.endsWith('==')) decodedSize -= 2;
    else if (b64Part.endsWith('=')) decodedSize -= 1;
    if (decodedSize <= maxBytes) return base64;

    var img = new Image();
    await new Promise(function(resolve, reject) { img.onload = resolve; img.onerror = reject; img.src = base64; });
    var canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    canvas.getContext('2d').drawImage(img, 0, 0);
    img.src = '';

    var result = base64;
    var qualities = [0.85, 0.7, 0.5, 0.3];
    for (var i = 0; i < qualities.length; i++) {
        result = canvas.toDataURL('image/jpeg', qualities[i]);
        var rPart = result.substring(result.indexOf(',') + 1);
        if (Math.floor(rPart.length * 3 / 4) <= maxBytes) break;
    }
    canvas.width = 0;
    canvas.height = 0;
    return result;
}

// Resize a base64 image so neither dimension exceeds maxDim.
// Also compresses if the result exceeds 5MB API limit.
// Returns Promise<{ base64, width, height }>. No-op if already within limits.
function resizeImageIfNeeded(base64, maxDim) {
    maxDim = maxDim || 1600;
    return new Promise(function(resolve) {
        var img = new Image();
        img.onload = function() {
            var w = img.naturalWidth;
            var h = img.naturalHeight;
            if (w <= maxDim && h <= maxDim) {
                img.src = '';
                compressBase64Image(base64).then(function(compressed) {
                    resolve({ base64: compressed, width: w, height: h });
                });
                return;
            }
            var scale = Math.min(maxDim / w, maxDim / h);
            var newW = Math.round(w * scale);
            var newH = Math.round(h * scale);
            var canvas = document.createElement('canvas');
            canvas.width = newW;
            canvas.height = newH;
            var ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, newW, newH);
            var resized = canvas.toDataURL('image/png');
            canvas.width = 0;
            canvas.height = 0;
            img.src = '';
            compressBase64Image(resized).then(function(compressed) {
                resolve({ base64: compressed, width: newW, height: newH });
            });
        };
        img.onerror = function() {
            resolve({ base64: base64, width: 0, height: 0 });
        };
        img.src = base64;
    });
}

// Execute set_chat_title tool
function executeSetChatTitle(args) {
    if (!args.title || typeof args.title !== 'string') {
        return { success: false, error: 'Title is required' };
    }
    
    var title = args.title.trim().substring(0, 60);
    if (title.length === 0) {
        return { success: false, error: 'Title cannot be empty' };
    }
    
    var chat = chats[currentChatId];
    if (!chat) {
        return { success: false, error: 'No active chat' };
    }
    
    chat.title = title;
    saveChatsToStorage();
    renderChatList();
    updateChatTitleHeader();
    
    return { success: true, message: 'Chat title updated to: ' + title };
}

// Apply search-and-replace edits to content (no line numbers needed)
function applySearchReplaceEdits(content, edits) {
    var errors = [];
    var modifiedContent = content;
    var appliedEdits = [];

    for (var i = 0; i < edits.length; i++) {
        var edit = edits[i];

        // Validate edit is an object
        if (!edit || typeof edit !== 'object') {
            errors.push('Edit ' + i + ': Expected object with {find, replace}, got: ' + JSON.stringify(edit));
            continue;
        }

        // Support common alternative property names (LLMs sometimes use these)
        var findText = edit.find !== undefined ? edit.find :
                       edit.old_string !== undefined ? edit.old_string :
                       edit.search !== undefined ? edit.search :
                       edit.old !== undefined ? edit.old :
                       edit.text !== undefined ? edit.text : undefined;
        var replaceText = edit.replace !== undefined ? edit.replace :
                          edit.new_string !== undefined ? edit.new_string :
                          edit.replacement !== undefined ? edit.replacement :
                          edit.new !== undefined ? edit.new : undefined;

        // Validate required fields - show what keys were actually provided
        if (findText === undefined || findText === null) {
            var receivedKeys = Object.keys(edit).join(', ') || 'none';
            errors.push('Edit ' + i + ': Missing "find" property. Received keys: [' + receivedKeys + ']. Expected: {find: "...", replace: "..."}');
            continue;
        }
        if (replaceText === undefined || replaceText === null) {
            var receivedKeys = Object.keys(edit).join(', ') || 'none';
            errors.push('Edit ' + i + ': Missing "replace" property. Received keys: [' + receivedKeys + ']. Expected: {find: "...", replace: "..."}');
            continue;
        }

        // Count occurrences
        var occurrences = 0;
        var searchPos = 0;
        var foundIndex = -1;
        while ((searchPos = modifiedContent.indexOf(findText, searchPos)) !== -1) {
            if (occurrences === 0) foundIndex = searchPos;
            occurrences++;
            searchPos += 1;
        }

        if (occurrences === 0) {
            errors.push('Edit ' + i + ': Text not found: "' + findText.substring(0, 80) + (findText.length > 80 ? '...' : '') + '"');
            continue;
        }

        if (occurrences > 1) {
            // Find all occurrence positions and show context
            var positions = [];
            var lines = modifiedContent.split('\n');
            var charCount = 0;
            for (var lineNum = 0; lineNum < lines.length; lineNum++) {
                var lineStart = charCount;
                var lineEnd = charCount + lines[lineNum].length;
                var pos = modifiedContent.indexOf(findText, lineStart);
                while (pos !== -1 && pos < lineEnd + findText.length) {
                    if (pos >= lineStart) {
                        positions.push('line ' + (lineNum + 1) + ' (char ' + pos + ')');
                    }
                    pos = modifiedContent.indexOf(findText, pos + 1);
                }
                charCount = lineEnd + 1; // +1 for newline
            }
            errors.push('Edit ' + i + ': Text found ' + occurrences + ' times at: ' + positions.join(', ') + '. Add more surrounding context to make it unique. Text: "' + findText.substring(0, 50) + '..."');
            continue;
        }

        // Apply the edit
        modifiedContent = modifiedContent.substring(0, foundIndex) + replaceText + modifiedContent.substring(foundIndex + findText.length);
        appliedEdits.push({ index: i, action: 'replace', at: foundIndex, removed: findText.length, added: replaceText.length });
    }

    if (errors.length > 0) {
        // If some edits succeeded, return partial success with the modified content
        if (appliedEdits.length > 0) {
            return { error: false, partialSuccess: true, content: modifiedContent, appliedEdits: appliedEdits, failedEdits: errors };
        }
        // All edits failed - return error without any content changes
        return { error: true, messages: errors, partialEdits: [] };
    }

    return { error: false, content: modifiedContent, appliedEdits: appliedEdits };
}

// Execute diff edit tool (search-and-replace based)
async function executeDiffEdit(args, messageIndex) {
    if (!(/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(args.table))) {
        return { success: false, error: 'Invalid table name: must be alphanumeric/underscores only' };
    }
    if (args.sys_id && args.sys_id !== '-1' && !(/^[0-9a-fA-F]{32}$/.test(args.sys_id))) {
        return { success: false, error: 'Invalid sys_id: must be a 32-character hex string or -1' };
    }
    try {
        var currentContent;

        // Resolve target instance
        var _diffInstanceUrl = null;
        var _diffToken = null;
        if (args.instance) {
            _diffInstanceUrl = Platform.resolveInstanceUrl(args.instance);
            if (!_diffInstanceUrl) {
                return { success: false, error: 'Unknown instance "' + args.instance + '". Use list_instances to see available instances.' };
            }
            _diffToken = await Platform.getTokenForInstance(_diffInstanceUrl);
            if (!_diffToken) {
                return { success: false, error: 'No token available for instance "' + args.instance + '" (' + _diffInstanceUrl + '). Ensure a tab is open for that instance.' };
            }
        }
        var _diffApiToken = _diffToken || window.sessionToken || '';

        // Capture version before the change (skip for cross-instance)
        var versionBefore = null;
        var beforeVersion = null;
        if (!_diffInstanceUrl) {
            versionBefore = await getRecordVersion(args.table, args.sys_id);
            beforeVersion = versionBefore ? versionBefore.sys_id : null;
        }

        // Always fetch the full content from the server to ensure we have the complete field
        var getUrl = '/api/now/table/' + args.table + '/' + args.sys_id + '?sysparm_fields=' + args.field;
        if (_diffInstanceUrl) getUrl = _diffInstanceUrl + getUrl;
        var getOpts = {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'X-UserToken': _diffApiToken
            }
        };
        var getRes = await fetch(getUrl, getOpts);

        if (!getRes.ok) {
            var errText = await getRes.text();
            var errData = {};
            try { errData = JSON.parse(errText); } catch(e) { /* non-JSON error response */ }
            return { success: false, error: 'Failed to fetch record: ' + (errData.error?.message || 'HTTP ' + getRes.status) };
        }

        var getData = await getRes.json();
        if (!getData.result) {
            return { success: false, error: 'Record not found or empty response for ' + args.table + '/' + args.sys_id };
        }
        currentContent = getData.result[args.field] || '';

        var originalLength = currentContent.length;

        // Apply search-and-replace edits
        var editResult = applySearchReplaceEdits(currentContent, args.edits);
        
        // Check for validation errors - only fail if ALL edits failed
        if (editResult.error) {
            return { 
                success: false, 
                error: 'All edits failed validation', 
                validationErrors: editResult.messages,
                hint: 'Ensure find text is unique and exists in the document. Include more context lines if needed.'
            };
        }

        var newContent = editResult.content;
        var failedEdits = editResult.failedEdits || [];
        var isPartialSuccess = editResult.partialSuccess || false;

        // PUT the updated content using record's scope
        var putUrl = '/api/now/table/' + args.table + '/' + args.sys_id;
        var recordScope = _diffInstanceUrl ? null : await getRecordScope(args.table, args.sys_id);
        if (recordScope) {
            putUrl += '?sysparm_record_scope=' + encodeURIComponent(recordScope);
        }
        if (_diffInstanceUrl) putUrl = _diffInstanceUrl + putUrl;
        var putData = {};
        putData[args.field] = newContent;

        var putOpts = {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'X-UserToken': _diffApiToken
            },
            body: JSON.stringify(putData)
        };
        var putRes = await fetch(putUrl, putOpts);

        if (!putRes.ok) {
            var errText = await putRes.text();
            var errData = {};
            try { errData = JSON.parse(errText); } catch(e) { /* non-JSON error response */ }
            return { success: false, error: 'Failed to update record: ' + (errData.error?.message || 'HTTP ' + putRes.status) };
        }

        // Capture version after the change and track it (skip for cross-instance)
        if (!_diffInstanceUrl) {
            await new Promise(function(r) { setTimeout(r, 200); });
            var versionAfter = await getRecordVersion(args.table, args.sys_id);
            var afterVersion = versionAfter ? versionAfter.sys_id : null;
            var displayName = await getRecordDisplayValue(args.table, args.sys_id);
            addVersionHistoryEntry({
                id: 'vh_' + Date.now(),
                chatId: currentChatId,
                timestamp: Date.now(),
                table: args.table,
                sysId: args.sys_id,
                field: args.field,
                displayName: displayName,
                action: 'EDIT',
                statusMessage: args.status_message || null,
                messageIndex: messageIndex || -1,
                beforeVersion: beforeVersion,
                afterVersion: afterVersion
            });
        }

        var result = {
            success: true,
            originalLength: originalLength,
            newLength: newContent.length,
            editsApplied: editResult.appliedEdits
        };
        if (_diffInstanceUrl) result.instance = args.instance;
        
        if (isPartialSuccess) {
            result.message = 'Partially applied ' + editResult.appliedEdits.length + ' of ' + args.edits.length + ' edit(s) to ' + args.field;
            result.partialSuccess = true;
            result.failedEdits = failedEdits;
            result.warning = 'Some edits failed validation but successful edits were saved. Review failedEdits for details.';
        } else {
            result.message = 'Successfully applied ' + args.edits.length + ' edit(s) to ' + args.field;
        }
        
        return result;
    } catch (e) {
        return { success: false, error: e.message };
    }
}

// Single entry point for all tool execution - always checks permissions
// options: { batch, toolCallId, chatId } - passed through to requestProgrammaticToolApproval
async function executeTool(name, args, messageIndex, options) {
    var approval = await requestProgrammaticToolApproval(name, args, options);
    if (!approval.allowed) {
        return { success: false, error: approval.error, _denied: true };
    }

    // Execute the tool
    if (name === 'js_eval') {
        var sandbox = null;
        var sandboxMessageHandler = null;
        try {
            var chatId = (options && options.chatId) || activeStreamingChatId || currentChatId;

            sandbox = document.createElement('iframe');
            sandbox.style.display = 'none';

            // Sanitize code: convert Unicode lookalike characters to ASCII equivalents
            var sanitizedCode = args.code
                .replace(/[\u2018\u2019\u02BC\u02B9]/g, "'")
                .replace(/[\u201C\u201D]/g, '"')
                .replace(/[\u02CB\u0060\u2032\u02B4]/g, '`');

            var MSG_TOOL_CALL = 'sandboxToolCall';
            var MSG_TOOL_RESULT = 'sandboxToolResult';
            var MSG_DONE = 'sandboxDone';

            // Promise to wait for result
            var resultPromise = new Promise(function(resolveMain, rejectMain) {
                function handleSandboxMessage(e) {
                    if (e.source !== sandbox.contentWindow) return;

                    // Sandbox ready -> send code to execute
                    if (e.data && e.data.type === 'sandboxReady') {
                        sandbox.contentWindow.postMessage({ type: 'sandboxExec', code: sanitizedCode, globals: { lastLargeResponse: lastLargeResponse } }, '*');
                    } else if (e.data && e.data.type === MSG_TOOL_CALL) {
                        var toolPromise = executeTool(e.data.name, e.data.args, messageIndex, { chatId: chatId, fromSandbox: true });
                        var timeoutPromise = new Promise(function(_, rej) { setTimeout(function() { rej(new Error('Tool call timed out after 30s')); }, 30000); });
                        Promise.race([toolPromise, timeoutPromise])
                            .then(function(result) {
                                if (result && result._screenshotMessage) {
                                    var ssMsg = result._screenshotMessage;
                                    if (ssMsg.screenshot_id) {
                                        var jsChat = chats[chatId];
                                        if (jsChat) {
                                            if (!jsChat.screenshots) jsChat.screenshots = {};
                                            jsChat.screenshots[ssMsg.screenshot_id] = { base64: ssMsg.base64, name: ssMsg.name, width: ssMsg.width, height: ssMsg.height, timestamp: ssMsg.timestamp, description: ssMsg.description };
                                            saveChatsToStorage();
                                        }
                                    }
                                    result.base64 = ssMsg.base64;
                                    result.width = ssMsg.width;
                                    result.height = ssMsg.height;
                                    result.screenshot_id = ssMsg.screenshot_id || result.screenshot_id;
                                    delete result._screenshotMessage;
                                }
                                sandbox.contentWindow.postMessage({ type: MSG_TOOL_RESULT, id: e.data.id, result: result }, '*');
                            })
                            .catch(function(err) {
                                sandbox.contentWindow.postMessage({ type: MSG_TOOL_RESULT, id: e.data.id, error: err.message }, '*');
                            });
                    } else if (e.data && e.data.type === MSG_DONE) {
                        window.removeEventListener('message', handleSandboxMessage);
                        sandboxMessageHandler = null;
                        if (e.data.error) rejectMain(new Error(e.data.error));
                        else resolveMain(e.data.result);
                    }
                }
                sandboxMessageHandler = handleSandboxMessage;
                window.addEventListener('message', handleSandboxMessage);

                sandbox.src = 'sandbox.html';
                document.body.appendChild(sandbox);
            });

            var result = await resultPromise;
            document.body.removeChild(sandbox);
            var jsEvalResult = { success: true, result: result };
            // Extract _images from result: model-controlled image passing
            if (result && result._images && Array.isArray(result._images) && result._images.length > 0) {
                var imgs = result._images.filter(function(img) { return img && img.base64; });
                delete result._images;
                var screenshotMsgs = await Promise.all(imgs.map(async function(img) {
                    var ssId = newFileId();
                    var imgW = img.width || null;
                    var imgH = img.height || null;
                    // Look up dimensions from screenshots stored during this js_eval execution
                    if ((!imgW || !imgH) && chatId) {
                        var jsChat = chats[chatId];
                        if (jsChat && jsChat.screenshots) {
                            // Try matching by screenshot_id first, then by base64 prefix
                            if (img.screenshot_id && jsChat.screenshots[img.screenshot_id]) {
                                var stored = jsChat.screenshots[img.screenshot_id];
                                imgW = imgW || stored.width;
                                imgH = imgH || stored.height;
                            } else {
                                // Match by base64 prefix (first 200 chars avoids full string comparison)
                                var b64Prefix = img.base64 ? img.base64.substring(0, 200) : '';
                                for (var ssKey in jsChat.screenshots) {
                                    var ss = jsChat.screenshots[ssKey];
                                    if (ss.base64 && ss.base64.substring(0, 200) === b64Prefix) {
                                        imgW = imgW || ss.width;
                                        imgH = imgH || ss.height;
                                        break;
                                    }
                                }
                            }
                        }
                    }
                    // Resize if either dimension exceeds limit (Anthropic caps at 2000px for many-image requests)
                    var resized = await resizeImageIfNeeded(img.base64);
                    return {
                        role: 'screenshot',
                        base64: resized.base64,
                        name: img.name || null,
                        description: img.description || 'Image from js_eval',
                        timestamp: Date.now(),
                        width: resized.width,
                        height: resized.height,
                        screenshot_id: ssId,
                        file_id: ssId
                    };
                }));
                if (screenshotMsgs.length === 1) {
                    jsEvalResult._screenshotMessage = screenshotMsgs[0];
                } else {
                    jsEvalResult._screenshotMessages = screenshotMsgs;
                }
            }
            return jsEvalResult;
        } catch (e) {
            if (sandboxMessageHandler) {
                window.removeEventListener('message', sandboxMessageHandler);
            }
            if (sandbox && sandbox.parentNode) sandbox.parentNode.removeChild(sandbox);
            return { success: false, error: e.message };
        }
    } else if (name === 'list_instances') {
        // List all connected ServiceNow instances
        if (args.refresh && Platform.refreshInstances) {
            await Platform.refreshInstances();
        }
        return {
            success: true,
            instances: Platform.instances.map(function(inst) {
                return {
                    shortName: inst.shortName,
                    url: inst.url,
                    active: inst.isActive || inst.url === Platform.instanceUrl,
                    connected: !!inst.token,
                    userName: inst.userName || '',
                    roles: inst.roles || [],
                    tabCount: (inst.tabs || []).length
                };
            }),
            activeInstance: Platform.instanceUrl ? Platform.instanceUrl.replace(/^https?:\/\//, '').split('.')[0] : ''
        };
    } else if (name === 'servicenow_api' && !(/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(args.table))) {
        return { success: false, error: 'Invalid table name: must be alphanumeric/underscores only' };
    } else if (name === 'servicenow_api' && args.sys_id && args.sys_id !== '-1' && !(/^[0-9a-fA-F]{32}$/.test(args.sys_id))) {
        return { success: false, error: 'Invalid sys_id: must be a 32-character hex string or -1' };
    } else if (name === 'servicenow_api' && args.table === 'attachment' && args.method === 'POST' && args.attachment_data) {
        // Attachment upload via /api/now/attachment/file
        try {
            if (!args.attachment_file_name) return { success: false, error: 'attachment_file_name is required for attachment upload' };
            if (!args.attachment_table_name) return { success: false, error: 'attachment_table_name is required for attachment upload' };
            if (!args.attachment_table_sys_id) return { success: false, error: 'attachment_table_sys_id is required for attachment upload' };

            // Resolve target instance for attachments
            var _attachInstanceUrl = null;
            var _attachToken = null;
            if (args.instance) {
                _attachInstanceUrl = Platform.resolveInstanceUrl(args.instance);
                if (!_attachInstanceUrl) {
                    return { success: false, error: 'Unknown instance "' + args.instance + '". Use list_instances to see available instances.' };
                }
                _attachToken = await Platform.getTokenForInstance(_attachInstanceUrl);
                if (!_attachToken) {
                    return { success: false, error: 'No token available for instance "' + args.instance + '". Ensure a tab is open for that instance.' };
                }
            }

            // Detect content type from file extension if not provided
            var contentType = args.attachment_content_type;
            if (!contentType) {
                var ext = (args.attachment_file_name.split('.').pop() || '').toLowerCase();
                var mimeMap = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', svg: 'image/svg+xml', pdf: 'application/pdf', json: 'application/json', xml: 'application/xml', txt: 'text/plain', csv: 'text/csv', html: 'text/html', zip: 'application/zip', js: 'text/javascript', css: 'text/css' };
                contentType = mimeMap[ext] || 'application/octet-stream';
            }

            // Decode base64 data (handle data URL prefix)
            var base64Raw = args.attachment_data;
            if (base64Raw.indexOf(',') !== -1) {
                base64Raw = base64Raw.split(',')[1];
            }
            var binaryStr = atob(base64Raw);
            var bytes = new Uint8Array(binaryStr.length);
            for (var bi = 0; bi < binaryStr.length; bi++) {
                bytes[bi] = binaryStr.charCodeAt(bi);
            }

            var attachUrl = '/api/now/attachment/file?table_name=' + encodeURIComponent(args.attachment_table_name) +
                '&table_sys_id=' + encodeURIComponent(args.attachment_table_sys_id) +
                '&file_name=' + encodeURIComponent(args.attachment_file_name);
            if (_attachInstanceUrl) attachUrl = _attachInstanceUrl + attachUrl;
            var _attachApiToken = _attachToken || window.sessionToken || '';
            var attachOpts = {
                method: 'POST',
                headers: {
                    'Content-Type': contentType,
                    'Accept': 'application/json',
                    'X-UserToken': _attachApiToken
                },
                body: bytes.buffer
            };
            var res = await fetch(attachUrl, attachOpts);
            var _attachRespText = await res.text();
            var data;
            try { data = JSON.parse(_attachRespText); } catch(e) { data = { error: { message: 'Non-JSON response (HTTP ' + res.status + ')' } }; }
            return { success: res.ok, status: res.status, data: data };
        } catch (e) {
            return { success: false, error: e.message };
        }
    } else if (name === 'servicenow_api') {
        // Resolve target instance (if specified)
        var _targetInstanceUrl = null;
        var _targetToken = null;
        if (args.instance) {
            _targetInstanceUrl = Platform.resolveInstanceUrl(args.instance);
            if (!_targetInstanceUrl) {
                return { success: false, error: 'Unknown instance "' + args.instance + '". Use list_instances to see available instances.' };
            }
            _targetToken = await Platform.getTokenForInstance(_targetInstanceUrl);
            if (!_targetToken) {
                return { success: false, error: 'No token available for instance "' + args.instance + '" (' + _targetInstanceUrl + '). Ensure a tab is open for that instance.' };
            }
        }

        var url = '/api/now/table/' + args.table;
        if (args.sys_id) url += '/' + args.sys_id;
        var params = [];
        if (args.query) params.push('sysparm_query=' + encodeURIComponent(args.query));
        if (args.fields) params.push('sysparm_fields=' + encodeURIComponent(args.fields));
        if (args.limit) params.push('sysparm_limit=' + args.limit);
        // Exclude reference links by default (returns just the value instead of {link, value} object)
        params.push('sysparm_exclude_reference_link=true');
        if (args.url_params && typeof args.url_params === 'object') {
            Object.keys(args.url_params).forEach(function(key) {
                params.push(encodeURIComponent(key) + '=' + encodeURIComponent(args.url_params[key]));
            });
        }
        // Handle sysparm_record_scope for modifying methods (POST, PUT, PATCH, DELETE)
        if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(args.method)) {
            var recordScope = args.scope || (args.data && args.data.sys_scope);
            if (!recordScope) {
                return { success: false, error: args.method + ' requests require a scope. Provide "scope" parameter or include "sys_scope" in data.' };
            }
            params.push('sysparm_record_scope=' + encodeURIComponent(recordScope));
        }
        if (params.length) url += '?' + params.join('&');

        // If targeting a different instance, prepend full URL so fetch intercept passes through
        if (_targetInstanceUrl) {
            url = _targetInstanceUrl + url;
        }

        try {
            var beforeVersion = null;
            var isModifyingRequest = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(args.method);
            if (isModifyingRequest && args.sys_id && !_targetInstanceUrl) {
                var versionBefore = await getRecordVersion(args.table, args.sys_id);
                beforeVersion = versionBefore ? versionBefore.sys_id : null;
            }

            var _apiToken = _targetToken || window.sessionToken || '';
            var opts = {
                method: args.method,
                headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'X-UserToken': _apiToken }
            };
            if (args.data && ['POST', 'PUT', 'PATCH'].includes(args.method)) {
                opts.body = JSON.stringify(args.data);
            }
            var res = await fetch(url, opts);
            var data;
            if (res.status === 204) {
                data = {};
            } else {
                var _apiRespText = await res.text();
                try { data = JSON.parse(_apiRespText); } catch(e) { data = { error: { message: 'Non-JSON response (HTTP ' + res.status + ')' } }; }
            }

            // Version history tracking (skip for cross-instance requests)
            if (res.ok && isModifyingRequest && !_targetInstanceUrl) {
                var recordSysId = args.sys_id || (data.result && data.result.sys_id);
                if (recordSysId) {
                    await new Promise(function(r) { setTimeout(r, 200); });
                    var versionAfter = await getRecordVersion(args.table, recordSysId);
                    var afterVersion = versionAfter ? versionAfter.sys_id : null;
                    var displayName = await getRecordDisplayValue(args.table, recordSysId);
                    addVersionHistoryEntry({
                        id: 'vh_' + Date.now(),
                        chatId: currentChatId,
                        timestamp: Date.now(),
                        table: args.table,
                        sysId: recordSysId,
                        displayName: displayName,
                        action: args.method,
                        statusMessage: args.status_message || null,
                        messageIndex: messageIndex || -1,
                        beforeVersion: beforeVersion,
                        afterVersion: afterVersion
                    });
                }
            }

            var _apiResult = { success: res.ok, status: res.status, data: data };
            if (_targetInstanceUrl) _apiResult.instance = args.instance;
            return _apiResult;
        } catch (e) {
            return { success: false, error: e.message };
        }
    } else if (name === 'servicenow_run_script') {
        // Run a server-side JS snippet via /sys.scripts.do
        if (!args.script || typeof args.script !== 'string') {
            return { success: false, error: 'script is required (non-empty string)' };
        }
        // Resolve target instance (if specified)
        var _rsTargetUrl = null;
        var _rsTargetToken = null;
        if (args.instance) {
            _rsTargetUrl = Platform.resolveInstanceUrl(args.instance);
            if (!_rsTargetUrl) {
                return { success: false, error: 'Unknown instance "' + args.instance + '". Use list_instances to see available instances.' };
            }
            _rsTargetToken = await Platform.getTokenForInstance(_rsTargetUrl);
            if (!_rsTargetToken) {
                return { success: false, error: 'No token available for instance "' + args.instance + '".' };
            }
        }
        var _rsScope = args.scope || 'global';
        var _rsParams = [
            'script=' + encodeURIComponent(args.script),
            'sys_scope=' + encodeURIComponent(_rsScope),
            'runscript=' + encodeURIComponent('Run script')
        ];
        if (args.record_for_rollback !== false) _rsParams.push('record_for_rollback=on');
        if (args.sandbox === true) _rsParams.push('sandbox=on');
        var _rsUrl = '/sys.scripts.do?' + _rsParams.join('&');
        if (_rsTargetUrl) _rsUrl = _rsTargetUrl + _rsUrl;
        try {
            var _rsApiToken = _rsTargetToken || window.sessionToken || '';
            var _rsRes = await fetch(_rsUrl, {
                method: 'GET',
                headers: { 'Accept': 'text/html', 'X-UserToken': _rsApiToken }
            });
            var _rsText = await _rsRes.text();
            // Parse the response: extract output between <PRE>...</PRE> and execution history sys_id
            var _rsOutput = '';
            var _rsHistorySysId = null;
            var _rsCompleted = false;
            var preMatch = _rsText.match(/<PRE>([\s\S]*?)<\/PRE>/i);
            if (preMatch) {
                _rsOutput = preMatch[1].replace(/<BR\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').trim();
            }
            var histMatch = _rsText.match(/sys_script_execution_history\.do\?sys_id=([0-9a-f]{32})/i);
            if (histMatch) _rsHistorySysId = histMatch[1];
            if (/Script completed in scope/i.test(_rsText)) _rsCompleted = true;
            var _rsScopeMatch = _rsText.match(/Script completed in scope\s+([^:<\s]+)/i);
            var _rsActualScope = _rsScopeMatch ? _rsScopeMatch[1] : _rsScope;
            // Detect not authorized / errors
            if (!_rsRes.ok || /not authorized/i.test(_rsText)) {
                return {
                    success: false,
                    status: _rsRes.status,
                    error: /not authorized/i.test(_rsText) ? 'Not authorized to run scripts (check role/elevation)' : ('HTTP ' + _rsRes.status),
                    raw: _rsText.length > 2000 ? _rsText.substring(0, 2000) + '...' : _rsText
                };
            }
            var _rsResult = {
                success: _rsCompleted,
                status: _rsRes.status,
                output: _rsOutput,
                scope: _rsActualScope,
                executionHistorySysId: _rsHistorySysId,
                executionHistoryUrl: _rsHistorySysId ? '/sys_script_execution_history.do?sys_id=' + _rsHistorySysId : null
            };
            if (_rsTargetUrl) _rsResult.instance = args.instance;
            return _rsResult;
        } catch (e) {
            return { success: false, error: e.message };
        }
    } else if (name === 'servicenow_diff_edit') {
        return await executeDiffEdit(args, messageIndex);
    } else if (name === 'iframe_tool') {
        return await executeIframeTool(args);
    } else if (name === 'set_chat_title') {
        return executeSetChatTitle(args);
    } else if (name === 'cached_content_outline') {
        var ccoChatId = (options && options.chatId) || activeStreamingChatId || currentChatId;
        return executeCachedContentOutline(ccoChatId, args);
    } else if (name === 'cached_content_search') {
        var ccsChatId = (options && options.chatId) || activeStreamingChatId || currentChatId;
        return executeCachedContentSearch(ccsChatId, args);
    } else if (name === 'cached_content_read') {
        var ccrChatId = (options && options.chatId) || activeStreamingChatId || currentChatId;
        return executeCachedContentRead(ccrChatId, args);
    } else if (name === 'get_skill') {
        return await executeGetSkill(args);
    } else if (name === 'manage_skill') {
        return await executeManageSkill(args);
    } else if (name === 'display') {
        return executeDisplay(args, messageIndex, options);
    } else if (name === 'document') {
        return await executeSmartDocument(args, messageIndex, options);
    } else if (name === 'prompt_user') {
        return await executePromptUser(args, options);
    } else if (name === 'update_action_state') {
        return await executeUpdateActionState(args, options);
    } else if (name === 'show_action_button') {
        return executeShowActionButton(args, messageIndex, options);
    } else if (name === 'html_widget') {
        return executeHtmlWidget(args, messageIndex, options);
    } else if (name === 'take_screenshot') {
        return await executeTakeScreenshot(args);
    } else if (name === 'screenshot_by_id') {
        return executeScreenshotById(args);
    } else if (name === 'get_file') {
        return await executeGetFile(args);
    } else if (name === 'read_attached_file') {
        return executeReadAttachedFile(args);
    } else if (name === 'web_fetch') {
        try {
            var _wfSaveFile = args.save_file;
            // Route through background script — Origin header stripped by declarativeNetRequest rule
            var fetchResult = await new Promise(function(resolve) {
                var timeout = setTimeout(function() { resolve({ error: 'web_fetch timed out after 30s' }); }, 30000);
                chrome.runtime.sendMessage({
                    type: 'web-fetch',
                    url: args.url,
                    method: args.method || 'GET',
                    headers: args.headers || {},
                    body: args.body || null,
                    save_file: _wfSaveFile || false
                }, function(response) {
                    clearTimeout(timeout);
                    if (chrome.runtime.lastError) resolve({ error: chrome.runtime.lastError.message });
                    else resolve(response || { error: 'No response from background script' });
                });
            });
            if (fetchResult.error) return { success: false, error: fetchResult.error };
            var _wfResult = { success: true, status: fetchResult.status, content_type: fetchResult.content_type };
            if (_wfSaveFile) {
                var _wfFileId = newFileId();
                var _wfName = args.url.split('/').pop().split('?')[0] || 'download';
                registerFile(_wfFileId, { type: 'memory', data: fetchResult.body, name: _wfName, mime: fetchResult.content_type || 'application/octet-stream' });
                _wfResult.file_id = _wfFileId;
                _wfResult.file_name = _wfName;
                _wfResult.file_size = fetchResult.body ? fetchResult.body.length : 0;
            } else {
                _wfResult.body = fetchResult.body;
            }
            return _wfResult;
        } catch (e) {
            return { success: false, error: e.message };
        }
    } else if (name === 'workspace') {
        return await executeWorkspaceTool(args, options);
    } else if (isSkillTool(name)) {
        return await executeSkillTool(name, args, options);
    }
    return { success: false, error: 'Unknown tool' };
}

// =============================================
// Workspace tool implementation
// =============================================

var _wsMutatingActions = { write: 1, edit: 1, copy: 1, delete: 1, discard: 1, push: 1 };

// Cross-chat conflict detection: surface a warning when one chat tries to
// mutate a file that another chat has uncommitted changes on. Each mutating
// action stamps last_modified_by_chat_id / _title / _at on the file record;
// subsequent mutations from a different chat are blocked unless force=true.
function _wsFormatAgo(ms) {
    if (!ms) return null;
    var diff = Math.max(0, Date.now() - ms);
    var s = Math.round(diff / 1000);
    if (s < 5) return 'just now';
    if (s < 60) return s + 's ago';
    var m = Math.round(s / 60);
    if (m < 60) return m + (m === 1 ? ' minute ago' : ' minutes ago');
    var h = Math.round(m / 60);
    if (h < 48) return h + (h === 1 ? ' hour ago' : ' hours ago');
    var d = Math.round(h / 24);
    return d + (d === 1 ? ' day ago' : ' days ago');
}

function _wsCheckCrossChatConflict(file, chatId) {
    if (!file || !file.dirty) return null;
    var lastChat = file.last_modified_by_chat_id;
    if (!lastChat) return null;
    if (chatId && lastChat === chatId) return null;
    var otherTitle = file.last_modified_by_chat_title || '(untitled chat)';
    var when = file.last_modified_at || null;
    var ago = _wsFormatAgo(when);
    var stillRunning = (typeof isChatRunning === 'function') && isChatRunning(lastChat);
    // hard=true: other chat is actively running — block to avoid clobbering an in-flight agent.
    // hard=false: other chat is dormant/closed — surface as warning only; current chat takes over.
    var hard = !!stillRunning;
    var headline = stillRunning
        ? '\u26A0 ANOTHER AGENT IS ACTIVELY RUNNING in chat "' + otherTitle + '" (' + lastChat + ')'
        : '\u26A0 This file has uncommitted changes from another (dormant) chat "' + otherTitle + '" (' + lastChat + ')';
    if (ago) headline += ' \u2014 last edited ' + ago;
    headline += hard
        ? '. Coordinate with the other chat, or pass {"force": true} to override and clobber their work.'
        : '. The other chat is no longer running, so this mutation will silently take over ownership.';
    return {
        cross_chat_conflict: true,
        hard: hard,
        last_modified_by_chat_id: lastChat,
        last_modified_by_chat_title: otherTitle,
        last_modified_at: when,
        last_modified_ago: ago,
        last_modified_iso: when ? new Date(when).toISOString() : null,
        other_chat_running: stillRunning,
        message: headline
    };
}

// Decide whether a mutator should block on a cross-chat conflict.
// - force=true: always allow.
// - gitignored path (e.g. dist/, .env): always allow — generated artefacts shouldn't gate cross-chat work.
// - other chat dormant (hard=false): allow, surface as warning only.
// - other chat running (hard=true): block.
// Returns { block, warn } — at most one is non-null.
async function _wsConflictDecision(wk, filePath, file, chatId, force) {
    if (force) return { block: null, warn: null };
    if (filePath) {
        try {
            var isIgnored = await wsGetIgnoreFilter(wk);
            if (isIgnored(filePath)) return { block: null, warn: null };
        } catch (e) { /* ignore filter failure — fall through to normal check */ }
    }
    var conflict = _wsCheckCrossChatConflict(file, chatId);
    if (!conflict) return { block: null, warn: null };
    if (conflict.hard) return { block: conflict, warn: null };
    return { block: null, warn: conflict };
}

function _wsResolveChat(options) {
    var chatId = (options && options.chatId)
        || (typeof activeStreamingChatId !== 'undefined' && activeStreamingChatId)
        || (typeof currentChatId !== 'undefined' && currentChatId)
        || null;
    var chatTitle = null;
    if (chatId && typeof chats !== 'undefined' && chats[chatId]) {
        chatTitle = chats[chatId].title || null;
    }
    return { chatId: chatId, chatTitle: chatTitle };
}

async function executeWorkspaceTool(args, options) {
    var action = args.action;
    var who = _wsResolveChat(options);
    var chatId = who.chatId;
    var chatTitle = who.chatTitle;
    var force = !!args.force;

    try {
        if (action === 'clone') {
            if (!args.repo) return { success: false, error: 'repo is required for clone' };
            return await wsClone(args.repo, args.branch);
        }
        if (action === 'list') {
            var allMetas = await getAllWorkspaceMetas();
            var workspaces = [];
            for (var _li = 0; _li < allMetas.length; _li++) {
                var _lm = allMetas[_li];
                var _lFiles = await getAllWorkspaceFiles(_lm.repo);
                var _lIgnored = await wsGetIgnoreFilter(_lm.repo);
                var _lDirty = _lFiles.filter(function(f) { return f.dirty && !_lIgnored(f.path); });
                workspaces.push({
                    workspace: _lm.repo,
                    repo: _lm.github_repo || parseWsKey(_lm.repo).repo,
                    branch: _lm.branch,
                    files: _lFiles.length,
                    dirty: _lDirty.length,
                    prs: _lm.prs || []
                });
            }
            return { success: true, workspaces: workspaces, total: workspaces.length };
        }
        // All other actions resolve workspace from optional workspace param or default
        var wk = await resolveWorkspace(args.workspace);
        if (wk && wk.error) return { success: false, error: wk.error };
        var result;
        var _incIgnored = !!args.include_git_ignored;
        if (action === 'ls') {
            result = await wsLs(wk, args.path || '', _incIgnored);
        } else if (action === 'read') {
            result = await wsRead(wk, args.path, args.offset, args.limit, chatId);
        } else if (action === 'write') {
            var _wsContent = args.content;
            if (args.file_id && !_wsContent) {
                var _wsFile = await getFileAsync(args.file_id);
                if (!_wsFile) _wsFile = getFile(args.file_id);
                if (!_wsFile) return { success: false, error: 'File not found: ' + args.file_id };
                _wsContent = _wsFile.data;
                // Convert data URLs to workspace binary format (::binary::<raw_base64>)
                if (typeof _wsContent === 'string' && _wsContent.indexOf('data:') === 0) {
                    var _wsComma = _wsContent.indexOf(',');
                    if (_wsComma > -1 && _wsContent.indexOf(';base64,') > -1) {
                        _wsContent = '::binary::' + _wsContent.substring(_wsComma + 1);
                    }
                }
            }
            result = await wsWrite(wk, args.path, _wsContent, chatId, chatTitle, force);
        } else if (action === 'edit') {
            result = await wsEdit(wk, args.path, args.edits, chatId, chatTitle, force);
        } else if (action === 'copy') {
            result = await wsCopy(wk, args.path, args.dest, chatId, chatTitle, force);
        } else if (action === 'delete') {
            result = await wsDelete(wk, args.path, chatId, chatTitle, force);
        } else if (action === 'grep') {
            result = await wsGrep(wk, args.pattern, args.path, _incIgnored);
        } else if (action === 'status') {
            result = await wsStatus(wk, _incIgnored, chatId);
        } else if (action === 'diff') {
            result = await wsDiff(wk, args.path, _incIgnored);
        } else if (action === 'push') {
            result = await wsPush(wk, args);
        } else if (action === 'deploy') {
            result = await wsDeploy(wk);
        } else if (action === 'discard') {
            result = await wsDiscard(wk, args.path, chatId, chatTitle, force);
        } else {
            return { success: false, error: 'Unknown workspace action: ' + action };
        }
        // Update header status after mutating actions
        if (_wsMutatingActions[action] && result && result.success) {
            updateWorkspaceHeaderStatus();
        }
        return result;
    } catch (e) {
        return { success: false, error: e.message };
    }
}

async function wsClone(repo, branch) {
    branch = branch || 'main';
    var gh = await loadGitHubSettings();
    if (!gh.token) return { success: false, error: 'GitHub not connected. Go to Settings > GitHub to add a token.' };

    var wk = wsKey(repo, branch);

    // Check for existing clone of this repo::branch
    var existing = await getWorkspaceMeta(wk);
    if (existing) {
        await deleteWorkspaceFiles(wk);
        await deleteWorkspaceMeta(wk);
    }

    // Get branch ref
    var refRes = await githubApi('GET', '/repos/' + repo + '/git/ref/heads/' + encodeURIComponent(branch));
    if (!refRes.ok) {
        // Try 'master' fallback if 'main' was default
        if (branch === 'main') {
            refRes = await githubApi('GET', '/repos/' + repo + '/git/ref/heads/master');
            if (refRes.ok) { branch = 'master'; wk = wsKey(repo, branch); }
        }
        if (!refRes.ok) return { success: false, error: 'Branch "' + branch + '" not found. Status: ' + refRes.status };
    }
    var headSha = refRes.body.object.sha;

    // Get full tree
    var treeRes = await githubApi('GET', '/repos/' + repo + '/git/trees/' + headSha + '?recursive=1');
    if (!treeRes.ok) return { success: false, error: 'Failed to fetch tree: ' + treeRes.status };

    var tree = treeRes.body.tree.filter(function(e) { return e.type === 'blob'; });
    var fileCount = tree.length;

    // Build SHA -> content cache from blobs we already have locally (any workspace).
    // Git blobs are content-addressed: same SHA == same bytes, so we can skip the fetch.
    // We use original_content (the pristine clone content), not content (which may be dirty).
    var shaCache = {};
    try {
        var existingFiles = await getAllWorkspaceFilesAllRepos();
        for (var ei = 0; ei < existingFiles.length; ei++) {
            var ef = existingFiles[ei];
            if (ef && ef.sha && ef.original_content != null && shaCache[ef.sha] === undefined) {
                shaCache[ef.sha] = ef.original_content;
            }
        }
    } catch (e) { /* non-fatal — fall through to full fetch */ }

    // Helper: persist a single tree entry with the given content
    async function _storeEntry(entry, content) {
        var _wsFileId = newFileId();
        await setWorkspaceFile({
            id: wk + '::' + entry.path,
            repo: wk,
            path: entry.path,
            sha: entry.sha,
            content: content,
            original_content: content,
            dirty: false,
            file_id: _wsFileId,
            pushed_pr: null,
            pushed_shas: null
        });
        registerFile(_wsFileId, { type: 'workspace', workspace: wk, path: entry.path });
    }

    // Split tree: entries we already have content for vs entries we need to fetch
    var toFetch = [];
    var reusedCount = 0;
    var storedCount = 0;
    for (var ti = 0; ti < tree.length; ti++) {
        var te = tree[ti];
        if (shaCache[te.sha] !== undefined) {
            await _storeEntry(te, shaCache[te.sha]);
            reusedCount++;
            storedCount++;
        } else {
            toFetch.push(te);
        }
    }

    // Fetch the remaining blobs in parallel batches of 15
    var BATCH_SIZE = 15;
    for (var i = 0; i < toFetch.length; i += BATCH_SIZE) {
        var batch = toFetch.slice(i, i + BATCH_SIZE);
        var results = await Promise.all(batch.map(function(entry) {
            return githubApi('GET', '/repos/' + repo + '/git/blobs/' + entry.sha);
        }));
        for (var j = 0; j < results.length; j++) {
            var blobRes = results[j];
            var entry = batch[j];
            if (!blobRes.ok) continue;
            var content = '';
            var raw = blobRes.body.content.replace(/\n/g, '');
            if (blobRes.body.encoding === 'base64') {
                // Decode base64 to bytes
                var binStr = atob(raw);
                var bytes = new Uint8Array(binStr.length);
                for (var bi = 0; bi < binStr.length; bi++) bytes[bi] = binStr.charCodeAt(bi);
                // Detect binary: try UTF-8 decode, if it produces replacement chars it's binary
                var decoded = new TextDecoder('utf-8', { fatal: true });
                try {
                    content = decoded.decode(bytes);
                } catch (e) {
                    // Not valid UTF-8 — binary file
                    content = '::binary::' + raw;
                }
            } else {
                content = blobRes.body.content;
            }
            await _storeEntry(entry, content);
            storedCount++;
        }
    }

    // Save metadata
    await setWorkspaceMeta({
        repo: wk,
        github_repo: repo,
        branch: branch,
        head_sha: headSha,
        tree_sha: treeRes.body.sha,
        cloned_at: Date.now()
    });

    refreshWorkspaceContext(); // update system prompt context
    updateWorkspaceHeaderStatus();
    var _msg = 'Cloned ' + repo + ' (' + branch + '): ' + storedCount + '/' + fileCount + ' files';
    if (reusedCount > 0) _msg += ' (' + reusedCount + ' reused from local cache)';
    return { success: true, workspace: wk, message: _msg, branch: branch, files: storedCount, reused: reusedCount };
}

async function wsLs(wk, dirPath, includeIgnored) {
    var meta = await getWorkspaceMeta(wk);
    if (!meta) return { success: false, error: 'Repo not cloned. Use workspace clone first.' };

    var files = await getAllWorkspaceFiles(wk);
    // Filter out gitignored and deleted files
    var isIgnored = includeIgnored ? function() { return false; } : await wsGetIgnoreFilter(wk);
    files = files.filter(function(f) { return !f.deleted && !isIgnored(f.path); });
    // Normalize: strip leading/trailing slashes, empty or "/" means root
    var cleaned = (dirPath || '').replace(/^\/+|\/+$/g, '').replace(/^\.\/?$/, '');
    var prefix = cleaned ? cleaned + '/' : '';
    var entries = {};

    files.forEach(function(f) {
        var p = f.path;
        if (prefix && p.indexOf(prefix) !== 0) return;
        var rest = p.substring(prefix.length);
        var slashIdx = rest.indexOf('/');
        if (slashIdx === -1) {
            entries[rest] = { type: 'file', size: f.content.length, dirty: f.dirty };
        } else {
            var dirName = rest.substring(0, slashIdx);
            if (!entries[dirName]) entries[dirName] = { type: 'dir', count: 0 };
            entries[dirName].count++;
        }
    });

    var listing = Object.keys(entries).sort().map(function(name) {
        var e = entries[name];
        return e.type === 'dir' ? name + '/ (' + e.count + ' files)' : name + (e.dirty ? ' *' : '');
    });

    return { success: true, path: prefix || '/', entries: listing, total: listing.length };
}

async function wsRead(repo, filePath, offset, limit, chatId) {
    if (!filePath) return { success: false, error: 'path is required for read' };
    var file = await getWorkspaceFile(repo, filePath);
    if (!file) return { success: false, error: 'File not found: ' + filePath };

    // Ensure file has a file_id (old clones may not have one) and register in memory index
    if (!file.file_id) {
        file.file_id = newFileId();
        setWorkspaceFile(file); // persist to IndexedDB
    }
    if (!fileIndex.has(file.file_id)) {
        registerFile(file.file_id, { type: 'workspace', workspace: repo, path: filePath });
    }

    if (file.deleted) return { success: false, error: 'File was deleted: ' + filePath + '. Use workspace write to recreate it.' };
    if (file.content.indexOf('::binary::') === 0) return { success: false, error: 'Binary file — cannot read as text. Use get_file to download.', file_id: file.file_id || null };

    var lines = file.content.split('\n');
    var startLine = (offset || 1) - 1;
    var endLine = limit ? startLine + limit : lines.length;
    var slice = lines.slice(startLine, endLine);
    var numbered = slice.map(function(line, i) { return (startLine + i + 1) + '\t' + line; }).join('\n');

    var resp = { success: true, path: filePath, content: numbered, total_lines: lines.length, dirty: file.dirty, file_id: file.file_id || null };
    // Surface cross-chat ownership so the agent can decide whether to coordinate before editing.
    // Skip for gitignored paths (generated artefacts) — ownership is not meaningful there.
    var _readIgnored;
    try { _readIgnored = await wsGetIgnoreFilter(repo); } catch (e) { _readIgnored = function(){return false;}; }
    var conflict = _readIgnored(filePath) ? null : _wsCheckCrossChatConflict(file, chatId);
    if (conflict) resp.cross_chat_warning = conflict;
    else if (file.dirty && file.last_modified_by_chat_id) {
        resp.last_modified_by_chat_id = file.last_modified_by_chat_id;
        resp.last_modified_by_chat_title = file.last_modified_by_chat_title || null;
        resp.last_modified_at = file.last_modified_at || null;
        resp.last_modified_ago = _wsFormatAgo(file.last_modified_at);
    }
    return resp;
}

async function wsWrite(repo, filePath, content, chatId, chatTitle, force) {
    if (!filePath) return { success: false, error: 'path is required for write' };
    if (content === undefined || content === null) return { success: false, error: 'content is required for write' };
    var meta = await getWorkspaceMeta(repo);
    if (!meta) return { success: false, error: 'Repo not cloned. Use workspace clone first.' };

    var existing = await getWorkspaceFile(repo, filePath);
    var _wWriteDecision = await _wsConflictDecision(repo, filePath, existing, chatId, force);
    if (_wWriteDecision.block) {
        var blocked = _wWriteDecision.block;
        blocked.success = false;
        blocked.error = blocked.message;
        blocked.path = filePath;
        return blocked;
    }
    var wasDeleted = existing && existing.deleted;
    var _wrFileId = (existing && existing.file_id) || newFileId();
    // Net-zero edits (content matches original) should not be marked dirty.
    // A never-committed new file (original_content === null) is always dirty.
    var _origForWrite = existing ? existing.original_content : null;
    var _isDirty = (_origForWrite === null) ? true : (content !== _origForWrite);
    await setWorkspaceFile({
        id: repo + '::' + filePath,
        repo: repo,
        path: filePath,
        sha: existing ? existing.sha : null,
        content: content,
        original_content: _origForWrite,
        dirty: _isDirty,
        deleted: false,
        file_id: _wrFileId,
        pushed_pr: (existing && !wasDeleted) ? existing.pushed_pr : null,
        pushed_shas: (existing && !wasDeleted) ? existing.pushed_shas : null,
        last_modified_by_chat_id: _isDirty ? (chatId || null) : null,
        last_modified_by_chat_title: _isDirty ? (chatTitle || null) : null,
        last_modified_at: _isDirty ? Date.now() : null
    });
    registerFile(_wrFileId, { type: 'workspace', workspace: repo, path: filePath });
    var action = wasDeleted ? 'Restored' : (existing && !existing.deleted ? 'Updated' : 'Created');
    var resp = { success: true, message: action + ': ' + filePath, size: content.length, file_id: _wrFileId };
    if (_wWriteDecision.warn) resp.cross_chat_warning = _wWriteDecision.warn;
    return resp;
}

async function wsEdit(repo, filePath, edits, chatId, chatTitle, force) {
    if (!filePath) return { success: false, error: 'path is required for edit' };
    if (!edits || !edits.length) return { success: false, error: 'edits array is required' };
    var file = await getWorkspaceFile(repo, filePath);
    if (!file) return { success: false, error: 'File not found: ' + filePath };
    if (file.deleted) return { success: false, error: 'File was deleted: ' + filePath + '. Use workspace write to recreate it.' };

    var _wEditDecision = await _wsConflictDecision(repo, filePath, file, chatId, force);
    if (_wEditDecision.block) {
        var blocked = _wEditDecision.block;
        blocked.success = false;
        blocked.error = blocked.message;
        blocked.path = filePath;
        return blocked;
    }

    var result = applySearchReplaceEdits(file.content, edits);
    if (result.error) return { success: false, error: 'All edits failed', validationErrors: result.messages };

    file.content = result.content;
    // Net-zero edits (content matches original after rollback) should not be marked dirty.
    // A never-committed new file (original_content === null) stays dirty.
    file.dirty = (file.original_content === null) ? true : (file.content !== file.original_content);
    if (file.dirty) {
        file.last_modified_by_chat_id = chatId || null;
        file.last_modified_by_chat_title = chatTitle || null;
        file.last_modified_at = Date.now();
    } else {
        file.last_modified_by_chat_id = null;
        file.last_modified_by_chat_title = null;
        file.last_modified_at = null;
    }
    await setWorkspaceFile(file);

    var resp = { success: true, editsApplied: result.appliedEdits };
    if (result.partialSuccess) { resp.partialSuccess = true; resp.failedEdits = result.failedEdits; }
    if (_wEditDecision.warn) resp.cross_chat_warning = _wEditDecision.warn;
    return resp;
}

async function wsCopy(wk, srcPath, destPath, chatId, chatTitle, force) {
    if (!srcPath) return { success: false, error: 'path is required for copy' };
    if (!destPath) return { success: false, error: 'dest is required for copy' };
    var file = await getWorkspaceFile(wk, srcPath);
    if (!file) return { success: false, error: 'Source file not found: ' + srcPath };
    if (file.deleted) return { success: false, error: 'Source file was deleted: ' + srcPath };
    var existingDest = await getWorkspaceFile(wk, destPath);
    var _wCopyDecision = await _wsConflictDecision(wk, destPath, existingDest, chatId, force);
    if (_wCopyDecision.block) {
        var blocked = _wCopyDecision.block;
        blocked.success = false;
        blocked.error = blocked.message;
        blocked.path = destPath;
        return blocked;
    }
    var _cpFileId = (existingDest && existingDest.file_id) || newFileId();
    await setWorkspaceFile({
        id: wk + '::' + destPath,
        repo: wk,
        path: destPath,
        sha: null,
        content: file.content,
        original_content: null,
        dirty: true,
        deleted: false,
        file_id: _cpFileId,
        pushed_pr: null,
        pushed_shas: null,
        last_modified_by_chat_id: chatId || null,
        last_modified_by_chat_title: chatTitle || null,
        last_modified_at: Date.now()
    });
    registerFile(_cpFileId, { type: 'workspace', workspace: wk, path: destPath });
    var resp = { success: true, message: 'Copied ' + srcPath + ' → ' + destPath };
    if (_wCopyDecision.warn) resp.cross_chat_warning = _wCopyDecision.warn;
    return resp;
}

async function wsDelete(wk, filePath, chatId, chatTitle, force) {
    if (!filePath) return { success: false, error: 'path is required for delete' };
    var file = await getWorkspaceFile(wk, filePath);
    if (!file) return { success: false, error: 'File not found: ' + filePath };
    if (file.deleted) return { success: false, error: 'File already deleted: ' + filePath };

    var _wDelDecision = await _wsConflictDecision(wk, filePath, file, chatId, force);
    if (_wDelDecision.block) {
        var blocked = _wDelDecision.block;
        blocked.success = false;
        blocked.error = blocked.message;
        blocked.path = filePath;
        return blocked;
    }

    if (!file.sha) {
        // New file (never committed) — safe to remove from IndexedDB entirely
        try {
            var database = await openDatabase();
            var tx = database.transaction([workspaceFilesStoreName], 'readwrite');
            tx.objectStore(workspaceFilesStoreName).delete(file.id);
            await new Promise(function(resolve, reject) {
                tx.oncomplete = resolve;
                tx.onerror = function() { reject(tx.error); };
            });
            unregisterFile(file.file_id);
        } catch (e) {
            return { success: false, error: 'Failed to delete: ' + e.message };
        }
    } else {
        // Tracked file — mark as tombstone so push can delete from repo
        file.content = '';
        file.dirty = true;
        file.deleted = true;
        file.last_modified_by_chat_id = chatId || null;
        file.last_modified_by_chat_title = chatTitle || null;
        file.last_modified_at = Date.now();
        await setWorkspaceFile(file);
    }
    var resp = { success: true, message: 'Deleted: ' + filePath };
    if (_wDelDecision.warn) resp.cross_chat_warning = _wDelDecision.warn;
    return resp;
}

async function wsDiscard(wk, filePath, chatId, chatTitle, force) {
    var meta = await getWorkspaceMeta(wk);
    if (!meta) return { success: false, error: 'Repo not cloned. Use workspace clone first.' };

    var files = await getAllWorkspaceFiles(wk);
    var targets = filePath
        ? files.filter(function(f) { return f.path === filePath; })
        : files.filter(function(f) { return f.dirty; });

    if (filePath && targets.length === 0) return { success: false, error: 'File not found: ' + filePath };
    if (targets.length === 0) return { success: true, message: 'No dirty files to discard', discarded: 0 };

    // Cross-chat guard — partition targets into proceedable vs blocked.
    // - force=true: all proceedable.
    // - gitignored path: proceedable (generated artefacts don't gate cross-chat work).
    // - other chat dormant (soft warn): proceedable, attach warning.
    // - other chat actively running (hard block): blocked unless force.
    // Single-file requests preserve old semantics: if the one file is blocked, return error.
    var proceedable = [];
    var blocking = [];
    var warnings = [];
    if (force) {
        proceedable = targets.slice();
    } else {
        var _disIgnored = await wsGetIgnoreFilter(wk);
        for (var ci = 0; ci < targets.length; ci++) {
            var tgt = targets[ci];
            if (_disIgnored(tgt.path)) { proceedable.push(tgt); continue; }
            var conflict = _wsCheckCrossChatConflict(tgt, chatId);
            if (conflict && conflict.hard) {
                blocking.push({ path: tgt.path, conflict: conflict });
            } else {
                if (conflict) warnings.push({ path: tgt.path, warning: conflict });
                proceedable.push(tgt);
            }
        }
    }

    if (filePath && blocking.length > 0 && proceedable.length === 0) {
        return {
            success: false,
            cross_chat_conflict: true,
            error: 'Discard blocked — file is locked by another running chat. Pass {"force": true} to override.',
            blocking_files: blocking
        };
    }

    var discarded = [];
    for (var i = 0; i < proceedable.length; i++) {
        var f = proceedable[i];
        if (!f.dirty) {
            if (filePath) return { success: false, error: 'File is not modified: ' + filePath };
            continue;
        }
        if (f.original_content === null) {
            // New file — remove entirely
            try {
                var database = await openDatabase();
                var tx = database.transaction([workspaceFilesStoreName], 'readwrite');
                tx.objectStore(workspaceFilesStoreName).delete(f.id);
                await new Promise(function(resolve, reject) {
                    tx.oncomplete = resolve;
                    tx.onerror = function() { reject(tx.error); };
                });
                unregisterFile(f.file_id);
            } catch (e) {}
            discarded.push({ path: f.path, action: 'removed' });
        } else {
            // Modified or deleted file — restore original content
            f.content = f.original_content;
            f.dirty = false;
            f.deleted = false;
            f.pushed_pr = null;
            f.pushed_shas = null;
            f.last_modified_by_chat_id = null;
            f.last_modified_by_chat_title = null;
            f.last_modified_at = null;
            await setWorkspaceFile(f);
            discarded.push({ path: f.path, action: 'restored' });
        }
    }
    var resp = { success: true, message: 'Discarded changes to ' + discarded.length + ' file(s)', discarded: discarded.length, files: discarded };
    if (blocking.length > 0) {
        resp.skipped_files = blocking;
        resp.message += ' (' + blocking.length + ' file(s) skipped — locked by another running chat; pass {"force": true} to discard them too)';
    }
    if (warnings.length > 0) resp.cross_chat_warnings = warnings;
    return resp;
}

async function wsGrep(repo, pattern, pathPrefix, includeIgnored) {
    if (!pattern) return { success: false, error: 'pattern is required for grep' };
    var meta = await getWorkspaceMeta(repo);
    if (!meta) return { success: false, error: 'Repo not cloned. Use workspace clone first.' };

    var files = await getAllWorkspaceFiles(repo);
    var isIgnored = includeIgnored ? function() { return false; } : await wsGetIgnoreFilter(repo);
    var regex;
    try { regex = new RegExp(pattern, 'gim'); } catch (e) { return { success: false, error: 'Invalid regex: ' + e.message }; }

    var matches = [];
    var MAX_MATCHES = 100;
    for (var i = 0; i < files.length && matches.length < MAX_MATCHES; i++) {
        var f = files[i];
        if (f.deleted || isIgnored(f.path)) continue;
        if (f.content.indexOf('::binary::') === 0) continue;
        if (pathPrefix && f.path.indexOf(pathPrefix) !== 0) continue;
        var lines = f.content.split('\n');
        for (var ln = 0; ln < lines.length && matches.length < MAX_MATCHES; ln++) {
            regex.lastIndex = 0;
            if (regex.test(lines[ln])) {
                matches.push({ file: f.path, line: ln + 1, text: lines[ln].substring(0, 200) });
            }
        }
    }
    return { success: true, pattern: pattern, matches: matches, total: matches.length, truncated: matches.length >= MAX_MATCHES };
}

// Parse .gitignore and return a function that tests if a path is ignored
// Supports: negation (!pattern), anchored (/pattern), directories (pattern/),
// wildcards (* = single segment, ** = cross-directory)
function parseGitignore(content) {
    if (!content) return function() { return false; };
    var rules = [];
    content.split('\n').forEach(function(line) {
        line = line.replace(/#.*$/, '').trim();
        if (!line) return;
        var negate = false;
        if (line.charAt(0) === '!') { negate = true; line = line.substring(1); }
        var anchored = line.charAt(0) === '/';
        if (anchored) line = line.substring(1);
        // Trailing slash = directory pattern — strip it (matching logic treats it the same for files inside)
        if (line.length > 0 && line.charAt(line.length - 1) === '/') line = line.slice(0, -1);
        if (!line) return;
        var hasSlash = line.indexOf('/') !== -1;
        // Build regex: process ** before * to avoid double-conversion
        var escaped = '';
        for (var ci = 0; ci < line.length; ci++) {
            if (line[ci] === '*' && line[ci + 1] === '*') {
                if (line[ci + 2] === '/') {
                    // **/ = match any prefix (including none)
                    escaped += '(.+/)?';
                    ci += 2; // skip ** and /
                } else {
                    // /** or standalone ** = match everything
                    escaped += '.*';
                    ci += 1; // skip second *
                }
            } else if (line[ci] === '*') {
                escaped += '[^/]*'; // * matches within single path segment
            } else if ('.+^${}()|[]\\'.indexOf(line[ci]) !== -1) {
                escaped += '\\' + line[ci];
            } else {
                escaped += line[ci];
            }
        }
        rules.push({ regex: escaped, negate: negate, anchored: anchored || hasSlash });
    });
    return function(filePath) {
        var ignored = false;
        for (var i = 0; i < rules.length; i++) {
            var r = rules[i];
            var matched = false;
            if (r.anchored) {
                // Match from root of path only
                matched = new RegExp('^' + r.regex + '($|/)').test(filePath);
            } else {
                // Match basename or any path segment
                var basename = filePath.split('/').pop();
                matched = new RegExp('^' + r.regex + '$').test(basename) ||
                          new RegExp('(^|/)' + r.regex + '($|/)').test(filePath);
            }
            if (matched) ignored = !r.negate;
        }
        return ignored;
    };
}

async function wsGetIgnoreFilter(wk) {
    try {
        var gitignoreFile = await getWorkspaceFile(wk, '.gitignore');
        if (gitignoreFile && gitignoreFile.content) return parseGitignore(gitignoreFile.content);
    } catch (e) {}
    return function() { return false; };
}

async function wsStatus(wk, includeIgnored, chatId) {
    var meta = await getWorkspaceMeta(wk);
    if (!meta) return { success: false, error: 'Repo not cloned. Use workspace clone first.' };

    // Sync with remote first — cleans up merged PRs and detects behind/conflict files
    var syncResult = null;
    try { syncResult = await wsSyncWithRemote(wk); } catch(e) {}
    // Re-read meta + files after sync (may have been updated)
    meta = await getWorkspaceMeta(wk);

    var files = await getAllWorkspaceFiles(wk);
    var isIgnored = includeIgnored ? function() { return false; } : await wsGetIgnoreFilter(wk);
    var foreignCount = 0;
    var foreignRunningCount = 0;
    var dirty = files.filter(function(f) { return f.dirty && !isIgnored(f.path); }).map(function(f) {
        var entry = { path: f.path, isNew: !f.sha && !f.deleted, isDeleted: !!f.deleted, size: f.deleted ? 0 : f.content.length, pushed_pr: f.pushed_pr || null };
        if (f.last_modified_by_chat_id) {
            entry.last_modified_by_chat_id = f.last_modified_by_chat_id;
            entry.last_modified_by_chat_title = f.last_modified_by_chat_title || null;
            entry.last_modified_at = f.last_modified_at || null;
            entry.last_modified_ago = _wsFormatAgo(f.last_modified_at);
            if (chatId && f.last_modified_by_chat_id !== chatId) {
                entry.foreign_chat = true;
                if ((typeof isChatRunning === 'function') && isChatRunning(f.last_modified_by_chat_id)) {
                    entry.other_chat_running = true;
                    foreignRunningCount++;
                }
                foreignCount++;
            }
        }
        return entry;
    });
    var activeFiles = files.filter(function(f) { return !f.deleted; });
    var result = { success: true, workspace: wk, repo: meta.github_repo || parseWsKey(wk).repo, branch: meta.branch, dirty_files: dirty, total_files: activeFiles.length, prs: meta.prs || [] };
    if (foreignCount > 0) {
        result.foreign_dirty_count = foreignCount;
        result.foreign_running_count = foreignRunningCount;
        if (foreignRunningCount > 0) {
            result.foreign_warning = foreignRunningCount + ' of ' + foreignCount + ' foreign dirty file(s) belong to a chat that is still running. Mutating those is blocked unless you pass {"force": true}. The remaining ' + (foreignCount - foreignRunningCount) + ' belong to dormant chats and will be silently taken over on next mutation.';
        } else {
            result.foreign_warning = foreignCount + ' dirty file(s) were last modified by other (now dormant) chats. Mutating any will silently take over ownership.';
        }
    }
    // Include sync info if available
    if (syncResult) {
        if (syncResult.synced > 0) result.synced = syncResult.synced;
        if (syncResult.behindFiles && syncResult.behindFiles.length > 0) result.behind_files = syncResult.behindFiles;
        if (syncResult.conflictFiles && syncResult.conflictFiles.length > 0) result.conflict_files = syncResult.conflictFiles;
    }
    return result;
}

async function wsDiff(repo, filePath, includeIgnored) {
    var meta = await getWorkspaceMeta(repo);
    if (!meta) return { success: false, error: 'Repo not cloned. Use workspace clone first.' };

    // Sync with remote first — updates original_content for dirty files whose base changed
    var _syncErr = null;
    try { await wsSyncWithRemote(repo); } catch(e) { _syncErr = e; }

    var files = await getAllWorkspaceFiles(repo);
    var isIgnored = includeIgnored ? function() { return false; } : await wsGetIgnoreFilter(repo);
    var diffs = [];

    files.forEach(function(f) {
        if (!f.dirty) return;
        if (filePath && f.path !== filePath) return;
        if (isIgnored(f.path)) return;
        if (f.deleted) {
            diffs.push({ path: f.path, status: 'deleted' });
            return;
        }
        if (f.original_content === null) {
            // New file
            diffs.push({ path: f.path, status: 'new', lines: f.content.split('\n').length });
        } else {
            // Modified file — simple line diff
            var oldLines = f.original_content.split('\n');
            var newLines = f.content.split('\n');
            var diffLines = [];
            var maxLen = Math.max(oldLines.length, newLines.length);
            for (var i = 0; i < maxLen; i++) {
                var ol = i < oldLines.length ? oldLines[i] : undefined;
                var nl = i < newLines.length ? newLines[i] : undefined;
                if (ol === nl) {
                    // context — only include around changes
                } else {
                    if (ol !== undefined) diffLines.push('-' + ol);
                    if (nl !== undefined) diffLines.push('+' + nl);
                }
            }
            diffs.push({ path: f.path, status: 'modified', diff: diffLines.join('\n') });
        }
    });

    var result = { success: true, diffs: diffs, total: diffs.length };
    if (_syncErr) result.sync_warning = 'Remote sync failed — diffs may be against stale base';
    return result;
}

// Compute git blob SHA locally: SHA-1("blob <byte_len>\0<content_bytes>")
async function computeGitBlobSha(content) {
    var encoder = new TextEncoder();
    var isBinary = content.indexOf('::binary::') === 0;
    var contentBytes;
    if (isBinary) {
        var b64 = content.substring('::binary::'.length);
        var binStr = atob(b64);
        contentBytes = new Uint8Array(binStr.length);
        for (var i = 0; i < binStr.length; i++) contentBytes[i] = binStr.charCodeAt(i);
    } else {
        contentBytes = encoder.encode(content);
    }
    var header = encoder.encode('blob ' + contentBytes.length + '\0');
    var combined = new Uint8Array(header.length + contentBytes.length);
    combined.set(header);
    combined.set(contentBytes, header.length);
    var hashBuffer = await crypto.subtle.digest('SHA-1', combined);
    var hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(function(b) { return b.toString(16).padStart(2, '0'); }).join('');
}

// Sync local workspace with remote — compare dirty files against remote tree.
// Returns { synced: number, behind: boolean, remoteHead: string, dirty_remaining: number }
async function wsSyncWithRemote(wk) {
    var meta = await getWorkspaceMeta(wk);
    if (!meta) return null;
    var githubRepo = meta.github_repo || parseWsKey(wk).repo;

    // 1. Get remote HEAD
    var refRes = await githubApi('GET', '/repos/' + githubRepo + '/git/ref/heads/' + encodeURIComponent(meta.branch));
    if (!refRes.ok) return null;
    var remoteHead = refRes.body.object.sha;

    // If local HEAD matches remote, no sync needed
    if (remoteHead === meta.head_sha) {
        return { synced: 0, behind: false, remoteHead: remoteHead, dirty_remaining: -1 };
    }

    // 2. Get remote tree (SHA-only metadata, not file contents)
    var treeRes = await githubApi('GET', '/repos/' + githubRepo + '/git/trees/' + remoteHead + '?recursive=1');
    if (!treeRes.ok) return { synced: 0, behind: true, remoteHead: remoteHead, dirty_remaining: -1 };

    // Build remote tree lookup: path → sha
    var remoteTree = {};
    treeRes.body.tree.forEach(function(e) { if (e.type === 'blob') remoteTree[e.path] = e.sha; });

    // 3. For each dirty file, compute local blob SHA and compare with remote
    var files = await getAllWorkspaceFiles(wk);
    var isIgnored = await wsGetIgnoreFilter(wk);
    var synced = 0;

    for (var i = 0; i < files.length; i++) {
        var f = files[i];
        if (!f.dirty || isIgnored(f.path)) continue;

        if (f.deleted) {
            // Deleted locally — if also gone from remote, sync it
            if (!remoteTree[f.path]) {
                try {
                    var _db = await openDatabase();
                    var _tx = _db.transaction([workspaceFilesStoreName], 'readwrite');
                    _tx.objectStore(workspaceFilesStoreName).delete(f.id);
                    await new Promise(function(resolve, reject) {
                        _tx.oncomplete = resolve;
                        _tx.onerror = function() { reject(_tx.error); };
                    });
                    unregisterFile(f.file_id);
                } catch (e) {}
                synced++;
            }
            continue;
        }

        // For new or modified files, compute local SHA and compare with remote
        var localSha = await computeGitBlobSha(f.content);
        if (remoteTree[f.path] && remoteTree[f.path] === localSha) {
            // File content matches remote — mark as clean, update original_content and sha,
            // and clear cross-chat ownership (no longer dirty, so no claim).
            f.original_content = f.content;
            f.sha = localSha;
            f.dirty = false;
            f.pushed_pr = null;
            f.pushed_shas = null;
            f.last_modified_by_chat_id = null;
            f.last_modified_by_chat_title = null;
            f.last_modified_at = null;
            await setWorkspaceFile(f);
            synced++;
        }
    }

    // 4. Detect behind files (remote changed, local clean) and conflicts (both changed)
    var behindFiles = [];
    var conflictFiles = [];
    for (var j = 0; j < files.length; j++) {
        var cf = files[j];
        if (isIgnored(cf.path)) continue;
        if (cf.dirty && cf.deleted) {
            // Deleted locally — if remote also changed, that's a conflict (unless we pushed the delete)
            if (remoteTree[cf.path] && cf.sha && remoteTree[cf.path] !== cf.sha) {
                var _pushedDelete = cf.pushed_shas && cf.pushed_shas.indexOf('::deleted::') !== -1;
                conflictFiles.push({ path: cf.path, remoteSha: remoteTree[cf.path], localDeleted: true, deletePushed: !!_pushedDelete });
            }
        } else if (cf.dirty && !cf.deleted) {
            // Dirty file — check if remote base also changed
            var _remoteSha = remoteTree[cf.path];
            if (_remoteSha && (!cf.sha || _remoteSha !== cf.sha)) {
                // Check if this remote sha matches one of our pushed shas (our PR was merged)
                var _isOurWork = cf.pushed_shas && cf.pushed_shas.indexOf(_remoteSha) !== -1;
                if (_isOurWork) {
                    // Our PR was merged — safe to update base pointer.
                    // Fetch remote content so original_content reflects the new base.
                    try {
                        var _blobRes = await githubApi('GET', '/repos/' + githubRepo + '/git/blobs/' + _remoteSha);
                        if (_blobRes.ok && _blobRes.body.content) {
                            var _remoteContent = _blobRes.body.encoding === 'base64'
                                ? decodeURIComponent(escape(atob(_blobRes.body.content.replace(/\n/g, ''))))
                                : _blobRes.body.content;
                            cf.original_content = _remoteContent;
                            cf.sha = _remoteSha;
                            // Remove matched sha and all older ones (they're subsets of the matched content).
                            // Only keep shas pushed AFTER the match — those have newer content.
                            var _idx = cf.pushed_shas.indexOf(_remoteSha);
                            if (_idx !== -1) cf.pushed_shas = cf.pushed_shas.slice(_idx + 1);
                            if (!cf.pushed_shas.length) { cf.pushed_shas = null; cf.pushed_pr = null; }
                            await setWorkspaceFile(cf);
                            synced++;
                        } else {
                            conflictFiles.push({ path: cf.path, remoteSha: _remoteSha });
                        }
                    } catch(_e) {
                        conflictFiles.push({ path: cf.path, remoteSha: _remoteSha });
                    }
                } else {
                    // Someone else changed the file — real conflict
                    conflictFiles.push({ path: cf.path, remoteSha: _remoteSha });
                }
            }
        } else if (!cf.dirty && !cf.deleted) {
            // Clean file — check if remote changed (behind)
            if (remoteTree[cf.path] && remoteTree[cf.path] !== cf.sha) {
                behindFiles.push({ path: cf.path, remoteSha: remoteTree[cf.path] });
            }
            if (!remoteTree[cf.path]) {
                behindFiles.push({ path: cf.path, remoteSha: null, remoteDeleted: true });
            }
        }
    }
    // New files on remote we don't have locally
    var localPaths = {};
    files.forEach(function(f) { localPaths[f.path] = true; });
    for (var rp in remoteTree) {
        if (!localPaths[rp]) {
            behindFiles.push({ path: rp, remoteSha: remoteTree[rp], isNew: true });
        }
    }

    var behind = behindFiles.length > 0 || conflictFiles.length > 0;

    // Only advance HEAD if fully in sync
    if (!behind) {
        meta.head_sha = remoteHead;
        meta.tree_sha = treeRes.body.sha;
        await setWorkspaceMeta(meta);
    }

    // Count remaining dirty files
    var remaining = (await getAllWorkspaceFiles(wk)).filter(function(f) { return f.dirty && !isIgnored(f.path); }).length;

    return { synced: synced, behind: behind, remoteHead: remoteHead, dirty_remaining: remaining, behindFiles: behindFiles, conflictFiles: conflictFiles, _remoteTree: remoteTree, _treeSha: treeRes.body.sha };
}

// Pull remote changes for behind files (download new content from remote)
async function wsPull(wk) {
    var meta = await getWorkspaceMeta(wk);
    if (!meta) return { success: false, error: 'Repo not cloned' };
    var githubRepo = meta.github_repo || parseWsKey(wk).repo;

    // Re-sync to get fresh behind files list
    var syncResult = await wsSyncWithRemote(wk);
    if (!syncResult || !syncResult.behindFiles || syncResult.behindFiles.length === 0) {
        return { success: true, message: 'Already up to date', pulled: 0 };
    }

    var pulled = 0;
    var failedPulls = [];
    var BATCH_SIZE = 15;
    var behindFiles = syncResult.behindFiles;

    for (var i = 0; i < behindFiles.length; i += BATCH_SIZE) {
        var batch = behindFiles.slice(i, i + BATCH_SIZE);
        var results = await Promise.all(batch.map(function(bf) {
            if (bf.remoteDeleted) return Promise.resolve({ bf: bf, ok: true, deleted: true });
            return githubApi('GET', '/repos/' + githubRepo + '/git/blobs/' + bf.remoteSha)
                .then(function(res) { return { bf: bf, ok: res.ok, body: res.body }; });
        }));

        for (var j = 0; j < results.length; j++) {
            var r = results[j];
            if (r.deleted) {
                // Remote deleted this file — delete locally
                var delFile = await getWorkspaceFile(wk, r.bf.path);
                if (delFile) {
                    try {
                        var _db = await openDatabase();
                        var _tx = _db.transaction([workspaceFilesStoreName], 'readwrite');
                        _tx.objectStore(workspaceFilesStoreName).delete(delFile.id);
                        await new Promise(function(resolve, reject) {
                            _tx.oncomplete = resolve;
                            _tx.onerror = function() { reject(_tx.error); };
                        });
                        unregisterFile(delFile.file_id);
                    } catch (e) {}
                }
                pulled++;
                continue;
            }
            if (!r.ok) { failedPulls.push(r.bf.path); continue; }
            var content = '';
            var raw = r.body.content.replace(/\n/g, '');
            if (r.body.encoding === 'base64') {
                var binStr = atob(raw);
                var bytes = new Uint8Array(binStr.length);
                for (var bi = 0; bi < binStr.length; bi++) bytes[bi] = binStr.charCodeAt(bi);
                var decoded = new TextDecoder('utf-8', { fatal: true });
                try { content = decoded.decode(bytes); } catch (e) { content = '::binary::' + raw; }
            } else {
                content = r.body.content;
            }

            if (r.bf.isNew) {
                // New file from remote — no local owner
                var _existingPull = await getWorkspaceFile(wk, r.bf.path);
                var _pullFileId = (_existingPull && _existingPull.file_id) || newFileId();
                await setWorkspaceFile({
                    id: wk + '::' + r.bf.path,
                    repo: wk,
                    path: r.bf.path,
                    sha: r.bf.remoteSha,
                    content: content,
                    original_content: content,
                    dirty: false,
                    file_id: _pullFileId,
                    pushed_pr: null,
                    pushed_shas: null,
                    last_modified_by_chat_id: null,
                    last_modified_by_chat_title: null,
                    last_modified_at: null
                });
                registerFile(_pullFileId, { type: 'workspace', workspace: wk, path: r.bf.path });
            } else {
                // Updated file — replace local copy with remote, drop any chat-id stamp
                var existing = await getWorkspaceFile(wk, r.bf.path);
                if (existing) {
                    existing.content = content;
                    existing.original_content = content;
                    existing.sha = r.bf.remoteSha;
                    existing.dirty = false;
                    existing.pushed_pr = null;
                    existing.pushed_shas = null;
                    existing.last_modified_by_chat_id = null;
                    existing.last_modified_by_chat_title = null;
                    existing.last_modified_at = null;
                    await setWorkspaceFile(existing);
                }
            }
            pulled++;
        }
    }

    // Only advance HEAD if no conflicts and no failed downloads remain
    var conflicts = syncResult.conflictFiles || [];
    if (conflicts.length === 0 && failedPulls.length === 0) {
        meta = await getWorkspaceMeta(wk);
        meta.head_sha = syncResult.remoteHead;
        meta.tree_sha = syncResult._treeSha;
        await setWorkspaceMeta(meta);
    }

    refreshWorkspaceContext();
    var result = { success: true, message: 'Pulled ' + pulled + ' file(s) from remote', pulled: pulled };
    if (conflicts.length > 0) result.conflicts = conflicts;
    if (failedPulls.length > 0) result.failed = failedPulls;
    return result;
}

async function wsPush(wk, args) {
    if (!args.branch_name) return { success: false, error: 'branch_name is required' };
    if (!args.commit_message) return { success: false, error: 'commit_message is required' };
    if (!args.pr_title) return { success: false, error: 'pr_title is required' };

    var meta = await getWorkspaceMeta(wk);
    if (!meta) return { success: false, error: 'Repo not cloned. Use workspace clone first.' };
    var githubRepo = meta.github_repo || parseWsKey(wk).repo;
    var gh = await loadGitHubSettings();
    if (!gh.token) return { success: false, error: 'GitHub not connected' };

    // Sync with remote first — advance HEAD if PRs were merged
    var syncResult = await wsSyncWithRemote(wk);
    if (syncResult && syncResult.conflictFiles && syncResult.conflictFiles.length > 0) {
        return { success: false, error: 'Cannot push — ' + syncResult.conflictFiles.length + ' file(s) have conflicting remote changes. Pull or discard first.', conflict_files: syncResult.conflictFiles };
    }
    // Re-read meta after sync (head_sha may have advanced)
    meta = await getWorkspaceMeta(wk);

    var files = await getAllWorkspaceFiles(wk);
    var isIgnored = await wsGetIgnoreFilter(wk);
    var dirtyFiles = files.filter(function(f) { return f.dirty && !isIgnored(f.path); });
    if (dirtyFiles.length === 0) return { success: false, error: 'No modified files to push (all files match remote after sync)' };

    // Separate modified/new files from deleted files
    var modifiedFiles = dirtyFiles.filter(function(f) { return !f.deleted; });
    var deletedFiles = dirtyFiles.filter(function(f) { return !!f.deleted; });

    // 1. Create blobs for modified files (skip deleted)
    var blobShas = {};
    for (var i = 0; i < modifiedFiles.length; i++) {
        var f = modifiedFiles[i];
        var isBinary = f.content.indexOf('::binary::') === 0;
        var blobContent = isBinary ? f.content.substring('::binary::'.length) : btoa(unescape(encodeURIComponent(f.content)));
        var blobRes = await githubApi('POST', '/repos/' + githubRepo + '/git/blobs', { content: blobContent, encoding: 'base64' });
        if (!blobRes.ok) return { success: false, error: 'Failed to create blob for ' + f.path + ': ' + JSON.stringify(blobRes.body) };
        blobShas[f.path] = blobRes.body.sha;
    }

    // 2. Create tree (modified files get new blobs, deleted files get sha:null to remove)
    var treeEntries = modifiedFiles.map(function(f) {
        return { path: f.path, mode: '100644', type: 'blob', sha: blobShas[f.path] };
    });
    deletedFiles.forEach(function(f) {
        treeEntries.push({ path: f.path, mode: '100644', type: 'blob', sha: null });
    });
    var treeRes = await githubApi('POST', '/repos/' + githubRepo + '/git/trees', { base_tree: meta.tree_sha, tree: treeEntries });
    if (!treeRes.ok) return { success: false, error: 'Failed to create tree: ' + JSON.stringify(treeRes.body) };

    // 3. Create commit (single commit on top of current HEAD)
    var commitRes = await githubApi('POST', '/repos/' + githubRepo + '/git/commits', {
        message: args.commit_message,
        tree: treeRes.body.sha,
        parents: [meta.head_sha]
    });
    if (!commitRes.ok) return { success: false, error: 'Failed to create commit: ' + JSON.stringify(commitRes.body) };

    // 4. Create branch ref
    var refRes = await githubApi('POST', '/repos/' + githubRepo + '/git/refs', {
        ref: 'refs/heads/' + args.branch_name,
        sha: commitRes.body.sha
    });
    if (!refRes.ok) return { success: false, error: 'Failed to create branch "' + args.branch_name + '": ' + JSON.stringify(refRes.body) };

    // 5. Open PR (base is always the source/cloned branch)
    var baseBranch = args.base_branch || meta.source_branch || meta.branch;
    var prRes = await githubApi('POST', '/repos/' + githubRepo + '/pulls', {
        title: args.pr_title,
        body: args.pr_body || '',
        head: args.branch_name,
        base: baseBranch
    });
    if (!prRes.ok) return { success: false, error: 'Failed to create PR: ' + JSON.stringify(prRes.body) };

    var prUrl = prRes.body.html_url;
    var prNumber = prRes.body.number;

    // 6. Track PR on dirty files and in workspace meta — files stay dirty locally,
    //    but cross-chat ownership is released since the work has been published to a PR.
    //    Without this, the pusher's chat would keep blocking other chats from editing
    //    the same files until sync replaces them with merged remote content.
    var prInfo = { url: prUrl, number: prNumber, branch: args.branch_name };
    for (var k = 0; k < dirtyFiles.length; k++) {
        dirtyFiles[k].pushed_pr = prInfo;
        // Track pushed blob shas so sync can distinguish "my PR merged" from "someone else changed it"
        // For deleted files, track '::deleted::' sentinel since no blob is created
        if (!dirtyFiles[k].pushed_shas) dirtyFiles[k].pushed_shas = [];
        var _pushSha = blobShas[dirtyFiles[k].path] || (dirtyFiles[k].deleted ? '::deleted::' : null);
        if (_pushSha && dirtyFiles[k].pushed_shas.indexOf(_pushSha) === -1) {
            dirtyFiles[k].pushed_shas.push(_pushSha);
            // Keep only the last 20 pushed shas — older ones are unlikely to match
            if (dirtyFiles[k].pushed_shas.length > 20) dirtyFiles[k].pushed_shas = dirtyFiles[k].pushed_shas.slice(-20);
        }
        // Release cross-chat ownership now that the work is in a PR
        dirtyFiles[k].last_modified_by_chat_id = null;
        dirtyFiles[k].last_modified_by_chat_title = null;
        dirtyFiles[k].last_modified_at = null;
        await setWorkspaceFile(dirtyFiles[k]);
    }

    // Add PR to workspace meta prs list
    if (!meta.prs) meta.prs = [];
    meta.prs.push(prInfo);
    await setWorkspaceMeta(meta);

    refreshWorkspaceContext();
    updateWorkspaceHeaderStatus();
    return { success: true, workspace: wk, pr_url: prUrl, pr_number: prNumber, files_pushed: dirtyFiles.length, branch: meta.branch };
}

// Path the built extension lives at inside the workspace. Always the same
// for this repo — hardcoded to remove the silent footgun where deploying
// without a prefix wrote every workspace file at the deploy folder root.
var DEPLOY_PATH = 'dist/extension';

async function wsDeploy(wk) {
    var handle = await getDeployDirHandle();
    if (!handle) return { success: false, error: 'No deploy folder connected. Go to Settings > GitHub > Connect Folder.' };

    var files = await getAllWorkspaceFiles(wk);
    if (files.length === 0) return { success: false, error: 'No files in workspace. Clone first.' };
    var prefix = DEPLOY_PATH + '/';
    var written = 0;

    for (var i = 0; i < files.length; i++) {
        var f = files[i];
        if (f.deleted) continue; // Skip deleted files
        if (prefix && f.path.indexOf(prefix) !== 0) continue;
        var outPath = prefix ? f.path.substring(prefix.length) : f.path;
        if (!outPath) continue;

        // Create directories and write file
        var parts = outPath.split('/');
        var dirHandle = handle;
        for (var d = 0; d < parts.length - 1; d++) {
            dirHandle = await dirHandle.getDirectoryHandle(parts[d], { create: true });
        }
        var fileName = parts[parts.length - 1];
        var fileHandle = await dirHandle.getFileHandle(fileName, { create: true });
        var writable = await fileHandle.createWritable();
        if (f.content.indexOf('::binary::') === 0) {
            var b64 = f.content.substring('::binary::'.length);
            var binStr = atob(b64);
            var bytes = new Uint8Array(binStr.length);
            for (var b = 0; b < binStr.length; b++) bytes[b] = binStr.charCodeAt(b);
            await writable.write(bytes);
        } else {
            await writable.write(f.content);
        }
        await writable.close();
        written++;
    }

    var meta = await getWorkspaceMeta(wk);
    var branchName = meta ? meta.branch : parseWsKey(wk).branch;
    return { success: true, message: 'Deployed ' + written + ' files from ' + branchName + ' to ' + handle.name, files_written: written, branch: branchName };
}

// =============================================