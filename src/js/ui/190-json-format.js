// Extract status_message from partial/streaming JSON arguments using regex
// This works even when the JSON is incomplete during streaming
function extractStatusMessage(argsString) {
    if (!argsString || typeof argsString !== 'string') return null;
    // Try full JSON parse first
    try {
        var parsed = JSON.parse(argsString);
        if (parsed.status_message) return parsed.status_message;
    } catch (e) {
        // JSON incomplete, try regex extraction
    }
    // Regex to extract status_message value from partial JSON
    // Matches: "status_message": "value" or "status_message":"value"
    var match = argsString.match(/"status_message"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/);
    if (match && match[1]) {
        // Unescape basic JSON escape sequences
        return match[1].replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    }
    return null;
}

// Format JSON string with pretty printing if valid JSON
// Renders arrays with expand/collapse buttons and removes quotes from strings
function formatJsonPretty(str) {
    if (!str || typeof str !== 'string') return str;
    try {
        var parsed = JSON.parse(str);
        // Remove status_message from display — it's already shown in the tool call header
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && parsed.status_message) {
            delete parsed.status_message;
        }
        return formatJsonValue(parsed, 0);
    } catch (e) {
        // HARDENING: every caller interpolates our return value into an
        // innerHTML context (<pre> panels in message render + notification
        // params). Partial/streaming JSON and plain-text tool results land
        // here — escape so raw <tags> in args/results can't inject markup
        // into the tool panel (they rendered as live HTML before this).
        return escapeHtml(str);
    }
}

// Recursively format JSON values with collapsible arrays and objects
function formatJsonValue(value, indent) {
    var indentStr = '  '.repeat(indent);
    var nextIndent = '  '.repeat(indent + 1);
    
    if (value === null) return '<span class="json-null">null</span>';
    if (typeof value === 'boolean') return '<span class="json-bool">' + value + '</span>';
    if (typeof value === 'number') return '<span class="json-num">' + value + '</span>';
    if (typeof value === 'string') {
        var escaped = escapeHtml(value);
        var valueLines = value.split('\n');
        var lineCount = valueLines.length;
        // Collapse if multiple lines or single line > 80 chars
        if (lineCount > 1 || value.length > 80) {
            var collapseId = 'json-str-' + Math.random().toString(36).substr(2, 9);
            var firstLine = valueLines[0];
            if (firstLine.length > 80) firstLine = firstLine.substring(0, 77) + '...';
            var preview = escapeHtml(firstLine);
            if (lineCount > 2) {
                preview += '<span class="json-preview"> +' + (lineCount - 1) + ' lines</span>';
            } else if (lineCount === 2) {
                preview += '<span class="json-preview"> +1 line</span>';
            }
            return '<span class="json-collapse" onclick="toggleJsonCollapse(\'' + collapseId + '\', event)">−</span>' +
                '<span id="' + collapseId + '" class="json-collapsible json-str">' + escaped + '</span>' +
                '<span id="' + collapseId + '-collapsed" class="json-collapsed json-str" style="display:none">' + preview + '</span>';
        }
        return '<span class="json-str">' + escaped + '</span>';
    }
    
    if (Array.isArray(value)) {
        if (value.length === 0) return '[]';
        var collapseId = 'json-arr-' + Math.random().toString(36).substr(2, 9);
        var items = value.map(function(item, idx) {
            return nextIndent + formatJsonValue(item, indent + 1) + (idx < value.length - 1 ? ',' : '');
        }).join('\n');
        return '<span class="json-collapse" onclick="toggleJsonCollapse(\'' + collapseId + '\', event)">−</span>' +
            '<span id="' + collapseId + '" class="json-collapsible">[\n' + items + '\n' + indentStr + ']</span>' +
            '<span id="' + collapseId + '-collapsed" class="json-collapsed" style="display:none">[<span class="json-preview">' + value.length + ' items</span>]</span>';
    }
    
    if (typeof value === 'object') {
        var keys = Object.keys(value);
        if (keys.length === 0) return '{}';
        var entries = keys.map(function(key, idx) {
            return nextIndent + '<span class="json-key">' + escapeHtml(key) + '</span>: ' + formatJsonValue(value[key], indent + 1) + (idx < keys.length - 1 ? ',' : '');
        }).join('\n');
        // Add collapse button for all objects
        var collapseId = 'json-obj-' + Math.random().toString(36).substr(2, 9);
        return '<span class="json-collapse" onclick="toggleJsonCollapse(\'' + collapseId + '\', event)">−</span>' +
            '<span id="' + collapseId + '" class="json-collapsible">{\n' + entries + '\n' + indentStr + '}</span>' +
            '<span id="' + collapseId + '-collapsed" class="json-collapsed" style="display:none">{<span class="json-preview">' + keys.length + ' keys</span>}</span>';
    }
    
    return String(value);
}

// Toggle JSON array collapse
function toggleJsonCollapse(id, event) {
    event.stopPropagation();
    var expanded = document.getElementById(id);
    var collapsed = document.getElementById(id + '-collapsed');
    var btn = event.target;
    if (!expanded || !collapsed) return;
    
    if (expanded.style.display === 'none') {
        expanded.style.display = 'inline';
        collapsed.style.display = 'none';
        btn.textContent = '−';
    } else {
        expanded.style.display = 'none';
        collapsed.style.display = 'inline';
        btn.textContent = '+';
    }
}

// Toggle tool args expand to full height
function toggleToolExpand(btn, event) {
    event.stopPropagation();
    var wrapper = btn.closest('.tool-args-wrapper') || btn.closest('.tool-result-wrapper');
    // Sub-report cards (175-sub-agent-ui.js) reuse the tool-call wrapper
    // markup but live inside .sub-report-body instead of a .tool-call /
    // .tool-result <details> — accept it as the class-flip target so
    // expanded panels get the same wrapper treatment (CSS in 05-tools.css
    // mirrors the .tool-call rules for .sub-report-body). setupStickyObserver
    // no-ops on it (no <summary> child), which is fine — the sub-report CSS
    // makes the buttons position:sticky directly instead of via .stuck.
    var details = btn.closest('.tool-call') || btn.closest('.tool-result') || btn.closest('.sub-report-body');
    var pre = wrapper.querySelector('.tool-args') || wrapper.querySelector('pre');
    if (!pre) return;
    
    // Track expanded state in message data
    var msgEl = details ? details.closest('.message') : null;
    var msgIndex = msgEl ? parseInt(msgEl.id.replace('msg-', '')) : -1;
    var isToolCall = details && details.classList.contains('tool-call');
    var tcIdx = -1;
    if (isToolCall && details.id) {
        var parts = details.id.split('-');
        tcIdx = parseInt(parts[parts.length - 1]);
    }
    
    var isExpanding = !pre.classList.contains('expanded');
    
    if (!isExpanding) {
        pre.classList.remove('expanded');
        if (details) {
            details.classList.remove('expanded');
            details.classList.remove('stuck');
            // Clean up observer
            if (details._stickyObserver) {
                details._stickyObserver.disconnect();
                details._stickyObserver = null;
            }
        }
        btn.textContent = '⤢';
        btn.title = 'Expand';
    } else {
        pre.classList.add('expanded');
        if (details) {
            details.classList.add('expanded');
            // Set up IntersectionObserver to detect when header should stick
            setupStickyObserver(details);
        }
        btn.textContent = '⤡';
        btn.title = 'Collapse';
    }
    
    // Save expanded state to message data
    var chat = chats[currentChatId];
    if (chat && msgIndex >= 0 && chat.messages[msgIndex]) {
        var msg = chat.messages[msgIndex];
        if (isToolCall && tcIdx >= 0) {
            if (!msg.toolCallsFullHeight) msg.toolCallsFullHeight = {};
            msg.toolCallsFullHeight[tcIdx] = isExpanding;
        } else if (details && details.classList.contains('tool-result')) {
            msg.fullHeight = isExpanding;
        }
    }
}
