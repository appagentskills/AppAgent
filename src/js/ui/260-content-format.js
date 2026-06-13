// Apply search term highlighting to HTML content
function applySearchHighlight(html, query) {
    if (!query) return html;
    // Escape special regex characters in query
    var escapedQuery = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Case-insensitive replace, but preserve original case
    var regex = new RegExp('(' + escapedQuery + ')(?![^<]*>)', 'gi');
    return html.replace(regex, '<mark class="search-highlight">$1</mark>');
}

function formatMetrics(metrics) {
    if (!metrics) return '';
    
    var parts = [];
    var isAggregate = metrics.isAggregate === true;
    
    // Show model name first, then provider
    if (!isAggregate) {
        var modelInfo = [];
        if (metrics.actualModel) modelInfo.push('<strong>' + metrics.actualModel + '</strong>');
        if (metrics.providerName) modelInfo.push(metrics.providerName);
        if (modelInfo.length > 0) {
            parts.push('<span class="stats-icon">' + UI_ICONS.model + '</span> ' + modelInfo.join(' · '));
        }
    } else {
        parts.push('<span class="stats-icon">' + UI_ICONS.stats + '</span> <strong>Total (' + metrics.callCount + ' calls)</strong>');
    }
    
    // Token usage
    if (metrics.input_tokens || metrics.output_tokens) {
        var tokenParts = [];
        if (metrics.input_tokens) tokenParts.push('In: ' + metrics.input_tokens.toLocaleString());
        if (metrics.output_tokens) tokenParts.push('Out: ' + metrics.output_tokens.toLocaleString());
        if (metrics.input_tokens && metrics.output_tokens) {
            var total = metrics.input_tokens + metrics.output_tokens;
            tokenParts.push('Total: ' + total.toLocaleString());
        }
        parts.push('<span class="stats-icon">' + UI_ICONS.stats + '</span> ' + tokenParts.join(' | '));
    }
    
    // Cache info for Anthropic
    if (metrics.cache_read_tokens || metrics.cache_creation_tokens || metrics.cache_write_tokens) {
        var cacheParts = [];
        if (metrics.cache_read_tokens) cacheParts.push('Read: ' + metrics.cache_read_tokens.toLocaleString());
        if (metrics.cache_write_tokens) cacheParts.push('Write: ' + metrics.cache_write_tokens.toLocaleString());
        if (metrics.cache_creation_tokens) cacheParts.push('Created: ' + metrics.cache_creation_tokens.toLocaleString());
        parts.push('<span class="stats-icon">' + UI_ICONS.cache + '</span> Cache: ' + cacheParts.join(' | '));
    }
    
    // Reasoning tokens
    if (metrics.reasoning_tokens) {
        parts.push('<span class="stats-icon">' + UI_ICONS.stats + '</span> Reasoning: ' + metrics.reasoning_tokens.toLocaleString());
    }
    
    // Cost
    if (metrics.cost !== undefined) {
        parts.push('<span class="stats-icon">' + UI_ICONS.money + '</span> $' + metrics.cost.toFixed(4));
    }
    
    // Performance timing
    if (metrics.duration) {
        var seconds = (metrics.duration / 1000).toFixed(1);
        parts.push('<span class="stats-icon">' + UI_ICONS.timer + '</span> ' + seconds + 's');
        
        // Tokens per second if we have output tokens
        if (metrics.output_tokens && metrics.duration > 0) {
            var tps = (metrics.output_tokens / (metrics.duration / 1000)).toFixed(1);
            parts.push('<span class="stats-icon">' + UI_ICONS.stats + '</span>' + tps + ' tok/s');
        }
    }
    
    if (parts.length === 0) return '';
    
    // Note: View Request button removed - embedding requestBody in DOM caused severe performance issues
    // (166MB+ of data-json attributes with large conversations). requestBody is no longer stored in metrics.
    var viewRequestBtn = '';
    
    var cssClass = isAggregate ? 'metrics-display metrics-aggregate' : 'metrics-display';
    return '<div class="' + cssClass + '">' + parts.join(' \u00A0•\u00A0 ') + viewRequestBtn + '</div>';
}

function updateChatTitle(chat) {
    // Immediately give a brand-new chat a provisional title derived from the
    // first user message (no LLM involved) so the sidebar never shows
    // "New Chat". When the auto-title hook is enabled it later replaces this
    // with a model-generated title — `titleProvisional` tells the hook the
    // title still needs upgrading (see executeAfterResponseHooks).
    if (chat.title && chat.title !== 'New Chat' && !chat.titleProvisional) return;

    var userMsgs = chat.messages.filter(function(m) { return m.role === 'user' && !m.isHookMessage; });
    if (userMsgs.length === 1) {
        var first = (typeof userMsgs[0].content === 'string') ? userMsgs[0].content : '';
        first = first.replace(/\s+/g, ' ').trim();
        if (!first) return;
        chat.title = first.substring(0, 80) + (first.length > 80 ? '...' : '');
        chat.titleProvisional = true;
        saveChatsToStorage();
        renderChatList();
        updateChatTitleHeader();
    }
}
