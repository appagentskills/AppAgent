// =============================================
// CACHED TOOL RESULTS - For large tool outputs (>4k tokens)
// Stores full content in IndexedDB, sends smart outline to API
// =============================================

// Cache limit function - use cacheTokenLimit setting (~4 chars per token)
function getCacheCharLimit() { return cacheTokenLimit * 4; }

// Code field names that should use code outline instead of JSON outline
var CODE_FIELD_NAMES = ['script', 'client_script', 'html', 'css', 'template', 'server_script', 'processing_script', 'code', 'source', 'body'];

// Field names that are definitely JavaScript
var JS_FIELD_NAMES = ['script', 'client_script', 'server_script', 'processing_script', 'code', 'source'];
// Field names that are definitely HTML
var HTML_FIELD_NAMES = ['html', 'template'];
// Field names that are definitely CSS
var CSS_FIELD_NAMES = ['css'];

// Detect content type based on field name and content
function detectCodeContentType(content, fieldName) {
    var lowerFieldName = fieldName ? fieldName.toLowerCase() : '';

    // Use field name as primary hint
    if (JS_FIELD_NAMES.indexOf(lowerFieldName) >= 0) return 'javascript';
    if (HTML_FIELD_NAMES.indexOf(lowerFieldName) >= 0) return 'html';
    if (CSS_FIELD_NAMES.indexOf(lowerFieldName) >= 0) return 'css';

    // Fall back to content analysis
    var trimmed = content.trim();

    // Strong HTML indicators (must be at the start of content)
    if (trimmed.startsWith('<!DOCTYPE') || trimmed.startsWith('<html') || trimmed.startsWith('<?xml')) {
        return 'html';
    }

    // Check first non-empty lines for type hints
    var firstLines = trimmed.split('\n').slice(0, 10).join('\n');

    // Strong CSS indicators: file starts with CSS-like patterns
    if (/^[\s]*(@import|@charset|@font-face|@keyframes|@media|[.#*][\w-]+\s*\{|[\w-]+\s*\{)/m.test(firstLines)) {
        // But make sure it's not just a JS object
        if (!firstLines.match(/^\s*(var|let|const|function|class|if|for|while|return|export|import)\s/m)) {
            return 'css';
        }
    }

    // Strong JavaScript indicators
    if (/^\s*(\/\/|\/\*|'use strict'|"use strict"|var\s|let\s|const\s|function\s|class\s|async\s|export\s|import\s|\(function)/m.test(firstLines)) {
        return 'javascript';
    }

    // If it looks like HTML structure at the top level (not just embedded in JS)
    if (/^[\s]*<(html|head|body|div|span|table|form|script|style|link|meta|!--)/mi.test(firstLines)) {
        return 'html';
    }

    // Default to JavaScript for code fields
    return 'javascript';
}

// Detect if a string looks like code (JS/HTML/CSS)
function looksLikeCode(str) {
    if (typeof str !== 'string' || str.length < 50) return false;
    // Check for common code patterns
    var codePatterns = [
        /^[\s]*function\s+\w+/m,           // function declaration
        /^[\s]*var\s+\w+\s*=/m,            // var declaration
        /^[\s]*const\s+\w+\s*=/m,          // const declaration
        /^[\s]*let\s+\w+\s*=/m,            // let declaration
        /^[\s]*if\s*\(/m,                   // if statement
        /^[\s]*for\s*\(/m,                  // for loop
        /^[\s]*while\s*\(/m,                // while loop
        /^[\s]*class\s+\w+/m,              // class declaration
        /^[\s]*<\w+[\s>]/m,                // HTML tag
        /^[\s]*<!DOCTYPE/mi,               // HTML doctype
        /^[\s]*[.#@][\w-]+\s*\{/m,         // CSS selector
        /\{\s*[\w-]+\s*:\s*[^}]+\}/,       // CSS rule
        /^\s*\/\/.*/m,                      // JS comment
        /^\s*\/\*[\s\S]*?\*\//m,           // Block comment
        /=>\s*\{/,                          // Arrow function
        /\.(then|catch|finally)\s*\(/,     // Promise chain
    ];
    var matches = 0;
    for (var i = 0; i < codePatterns.length; i++) {
        if (codePatterns[i].test(str)) matches++;
        if (matches >= 2) return true; // 2+ patterns = likely code
    }
    return false;
}

// Generate smart outline for any value, detecting code fields
// options: { maxDepth, arraySampleSize, arrayOffset, arrayLimit, targetPath }
function generateSmartOutline(data, maxDepth, options) {
    maxDepth = maxDepth || 3;
    options = options || {};
    var arraySampleSize = options.arraySampleSize || maxDepth; // More detail = more samples
    var arrayOffset = options.arrayOffset || 0;
    var arrayLimit = options.arrayLimit || null;
    var targetPath = options.targetPath || null; // Path to apply pagination to
    var stats = { totalKeys: 0, totalArrayItems: 0, codeFields: [] };

    function getType(val) {
        if (val === null) return 'null';
        if (Array.isArray(val)) return 'array';
        return typeof val;
    }

    function outlineValue(val, depth, path, parentKey) {
        var type = getType(val);

        if (type === 'object' && val !== null) {
            var keys = Object.keys(val);
            stats.totalKeys += keys.length;
            if (depth >= maxDepth) {
                return '{' + keys.length + ' keys: ' + keys.slice(0, 5).join(', ') + (keys.length > 5 ? ', ...' : '') + '}';
            }
            var result = {};
            keys.forEach(function(k) {
                result[k] = outlineValue(val[k], depth + 1, path + '.' + k, k);
            });
            return result;
        } else if (type === 'array') {
            stats.totalArrayItems += val.length;
            if (val.length === 0) return '[] (empty)';
            if (depth >= maxDepth) {
                var itemTypes = {};
                val.slice(0, 10).forEach(function(item) {
                    var t = getType(item);
                    itemTypes[t] = (itemTypes[t] || 0) + 1;
                });
                var typeStr = Object.keys(itemTypes).map(function(t) { return t + ':' + itemTypes[t]; }).join(', ');
                return '[' + val.length + ' items: ' + typeStr + ']';
            }

            // Check if this array should have pagination applied
            // targetPath: null = apply to all arrays, '' = root only, 'path' = specific path
            var cleanPath = path.replace(/^\$\.?/, '');
            var shouldPaginate = targetPath === null || cleanPath === targetPath;
            var offset = shouldPaginate ? arrayOffset : 0;
            var limit = shouldPaginate && arrayLimit ? arrayLimit : arraySampleSize;

            // Show items from offset to offset+limit
            var endIndex = Math.min(offset + limit, val.length);
            var sample = val.slice(offset, endIndex).map(function(item, i) {
                return outlineValue(item, depth + 1, path + '[' + (offset + i) + ']', null);
            });

            var result = { _array: sample };

            // Add pagination info
            if (offset > 0) {
                result._before = offset + ' items before (use array_offset: 0 to see from start)';
            }
            if (endIndex < val.length) {
                result._more = '... +' + (val.length - endIndex) + ' more items (use array_offset: ' + endIndex + ' to continue)';
            }
            result._total = val.length + ' total items';

            // If no pagination needed and small array, return simple array
            if (offset === 0 && val.length <= limit && !result._more) {
                return sample;
            }

            return result;
        } else if (type === 'string') {
            // Check if this string is code
            var isCodeField = parentKey && CODE_FIELD_NAMES.indexOf(parentKey.toLowerCase()) >= 0;
            var isCodeContent = val.length > 100 && looksLikeCode(val);

            if (isCodeField || isCodeContent) {
                var lineCount = val.split('\n').length;
                if (lineCount > 10) {
                    var contentType = detectCodeContentType(val, parentKey);
                    stats.codeFields.push({ path: path, lines: lineCount, chars: val.length, contentType: contentType });
                    return '=== CODE (' + lineCount + ' lines, ' + contentType + ') === Use cached_content_read with path: "' + path.replace(/^\$\.?/, '') + '" to read';
                }
            }

            if (val.length > 100) return '"...' + val.length + ' chars"';
            if (val.length > 50) return '"' + val.substring(0, 47) + '..."';
            return val;
        } else {
            return val;
        }
    }

    var outline = outlineValue(data, 1, '$', null);
    return { outline: outline, stats: stats };
}

// Process tool result and cache if too large
function processToolResultForCache(chatId, toolCallId, toolName, result) {
    var resultStr = JSON.stringify(result);

    // If small enough, return as-is
    if (resultStr.length <= getCacheCharLimit()) {
        return { content: resultStr, cached: false };
    }

    // Generate unique content ID
    var contentId = 'cache_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);

    // Store full content in chat's cache
    var chat = chats[chatId];
    if (!chat.cachedToolResults) {
        chat.cachedToolResults = {};
    }
    chat.cachedToolResults[contentId] = {
        id: contentId,
        toolName: toolName,
        toolCallId: toolCallId,
        fullContent: result, // Store the actual object, not stringified
        size: resultStr.length,
        timestamp: Date.now()
    };

    // Generate smart outline - maximize detail within size limit
    // detail_level: 1 = minimal, higher = more detail (maps to JSON depth)
    var maxOutlineSize = Math.floor(getCacheCharLimit() * 0.7); // Leave room for metadata
    var outlineResult = null;
    var bestDetailLevel = 1;

    // Try increasing detail levels to find the most detailed that fits
    for (var level = 1; level <= 10; level++) {
        var testResult = generateSmartOutline(result, level);
        var testStr = JSON.stringify(testResult.outline);
        if (testStr.length <= maxOutlineSize) {
            outlineResult = testResult;
            bestDetailLevel = level;
        } else {
            break; // Stop when we exceed the limit
        }
    }

    // Fallback to level 1 if nothing fit
    if (!outlineResult) {
        outlineResult = generateSmartOutline(result, 1);
        bestDetailLevel = 1;
    }

    // Build descriptive message about the cached content
    var sizeKB = Math.round(resultStr.length / 1024);
    var limitKB = Math.round(getCacheCharLimit() / 1024);
    var description = 'RESULT CACHED: This tool result is ' + sizeKB + 'KB (limit: ' + limitKB + 'KB). ';
    description += 'The full content is cached with ID "' + contentId + '". ';
    description += 'Use the tools below to explore and read specific parts:';

    // Create truncated version for API with clear explanation
    var truncated = {
        _cached: {
            message: description,
            content_id: contentId,
            size: sizeKB + 'KB',
            outlineDetailLevel: bestDetailLevel,
            tools: {
                'cached_content_outline': 'View structure at any path (detail_level auto-adjusts)',
                'cached_content_search': 'Search with regex patterns (optional path to limit scope)',
                'cached_content_read': 'Read specific paths (use start_line/end_line for code)'
            }
        },
        structure: outlineResult.outline
    };

    // Add stats summary
    var statsSummary = [];
    if (outlineResult.stats.totalKeys > 0) statsSummary.push(outlineResult.stats.totalKeys + ' keys');
    if (outlineResult.stats.totalArrayItems > 0) statsSummary.push(outlineResult.stats.totalArrayItems + ' array items');
    if (statsSummary.length > 0) truncated._cached.stats = statsSummary.join(', ');

    // Add code fields hint if any detected
    if (outlineResult.stats.codeFields.length > 0) {
        truncated._cached.codeFields = outlineResult.stats.codeFields.map(function(cf) {
            // Remove leading '$.' from path
            var cleanPath = cf.path.replace(/^\$\.?/, '');
            return cleanPath + ' (' + cf.lines + ' lines)';
        });
    }

    // If there's room in the budget, add brief code outlines for detected code fields
    var currentSize = JSON.stringify(truncated).length;
    var remainingBudget = getCacheCharLimit() - currentSize - 500; // Leave some margin

    if (remainingBudget > 1000 && outlineResult.stats.codeFields.length > 0) {
        truncated.codeOutlines = {};
        var budgetPerField = Math.floor(remainingBudget / outlineResult.stats.codeFields.length);

        for (var i = 0; i < outlineResult.stats.codeFields.length; i++) {
            var cf = outlineResult.stats.codeFields[i];
            var cleanPath = cf.path.replace(/^\$\.?/, '');

            // Navigate to the code field to get its content
            var codeContent = result;
            var pathParts = cleanPath.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
            for (var j = 0; j < pathParts.length; j++) {
                if (codeContent && typeof codeContent === 'object') {
                    var key = pathParts[j];
                    if (Array.isArray(codeContent) && /^\d+$/.test(key)) {
                        codeContent = codeContent[parseInt(key)];
                    } else {
                        codeContent = codeContent[key];
                    }
                } else {
                    codeContent = null;
                    break;
                }
            }

            if (typeof codeContent === 'string' && codeContent.length > 0) {
                // Use content type from stats (already detected with field name hint)
                var contentType = cf.contentType || 'javascript';

                // Generate code outline with increasing skip factor until it fits the budget
                // skipFactor 1 = all symbols (most detail), higher = less detail
                var codeOutline = null;
                for (var skipFactor = 1; skipFactor <= 20; skipFactor++) {
                    var outlineRes = generateCodemapWithOptions(codeContent, contentType, skipFactor, null, null);
                    if (outlineRes.outline.length <= budgetPerField) {
                        codeOutline = outlineRes.outline;
                        break;
                    }
                }

                if (codeOutline) {
                    truncated.codeOutlines[cleanPath] = codeOutline;
                    // Update remaining budget for next fields
                    remainingBudget -= codeOutline.length;
                    budgetPerField = outlineResult.stats.codeFields.length - i - 1 > 0
                        ? Math.floor(remainingBudget / (outlineResult.stats.codeFields.length - i - 1))
                        : 0;
                }
            }
        }

        // Remove codeOutlines if empty
        if (Object.keys(truncated.codeOutlines).length === 0) {
            delete truncated.codeOutlines;
        }
    }

    return { content: JSON.stringify(truncated), cached: true, contentId: contentId };
}

// Cache a long user-pasted text. Mirrors processToolResultForCache but for plain strings
// pushed by the user (e.g. a paste >16KB). Stores the full text in the chat's cache and
// returns a short reference the API can see in place of the original content.
// Returns { contentId, apiContent } if cached, or null if the text is small enough.
function processUserMessageForCache(chatId, content) {
    if (typeof content !== 'string') return null;
    if (content.length <= getCacheCharLimit()) return null;

    var chat = chats[chatId];
    if (!chat) return null;

    if (!chat.cachedToolResults) chat.cachedToolResults = {};

    // Generate unique content ID
    var contentId = 'cache_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);

    // Store the full text as a string. cached_content_read/search/outline all support strings.
    chat.cachedToolResults[contentId] = {
        id: contentId,
        toolName: 'user_message',
        toolCallId: null,
        fullContent: content,
        size: content.length,
        timestamp: Date.now(),
        source: 'user_paste'
    };

    var sizeKB = Math.round(content.length / 1024);
    var limitKB = Math.round(getCacheCharLimit() / 1024);
    var totalLines = content.split('\n').length;
    var preview = content.substring(0, 500);
    if (content.length > 500) preview += '\n... [truncated, ' + (content.length - 500) + ' more chars]';

    var description = 'USER MESSAGE CACHED: The user pasted a long message (' + sizeKB + 'KB, ' + totalLines + ' lines, limit: ' + limitKB + 'KB). ';
    description += 'The full text is cached with content_id "' + contentId + '". ';
    description += 'Use cached_content_read (with start_line/end_line), cached_content_search (regex), or cached_content_outline to inspect the full content.';

    var apiPayload = {
        _cached_user_message: {
            message: description,
            content_id: contentId,
            size: sizeKB + 'KB',
            totalLines: totalLines,
            tools: {
                'cached_content_read': 'Read line ranges (use start_line/end_line, no path needed)',
                'cached_content_search': 'Regex search the full text',
                'cached_content_outline': 'View structural outline'
            }
        },
        preview: preview
    };

    return {
        contentId: contentId,
        apiContent: '[User pasted a long message — cached]\n' + JSON.stringify(apiPayload, null, 2)
    };
}

// Execute cached_content_outline tool
// detail_level: 1 = minimal detail, higher = more detail
function executeCachedContentOutline(chatId, args) {
    var contentId = args.content_id;
    var detailLevel = args.detail_level || 3;
    var path = args.path || null;
    var arrayOffset = args.array_offset || 0;
    var arrayLimit = args.array_limit || null;

    var chat = chats[chatId];
    if (!chat || !chat.cachedToolResults || !chat.cachedToolResults[contentId]) {
        return { success: false, error: 'Cached content not found: ' + contentId };
    }

    var cached = chat.cachedToolResults[contentId];
    var targetData = cached.fullContent;

    // Navigate to path if specified
    if (path) {
        // Normalize path: strip leading $ and . (search results use $.path.to.value format)
        var normalizedPath = path.replace(/^\$\.?/, '').replace(/^\./, '');
        if (normalizedPath) {
            var pathParts = normalizedPath.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
            for (var i = 0; i < pathParts.length; i++) {
                if (targetData && typeof targetData === 'object') {
                    var key = pathParts[i];
                    if (Array.isArray(targetData) && /^\d+$/.test(key)) {
                        targetData = targetData[parseInt(key)];
                    } else {
                        targetData = targetData[key];
                    }
                } else {
                    return { success: false, error: 'Path "' + path + '" not found in cached content' };
                }
            }
        }
        // Check if path resolved to undefined
        if (targetData === undefined) {
            return { success: false, error: 'Path "' + path + '" not found in cached content' };
        }
    }

    // Check if target is a code string
    if (typeof targetData === 'string' && looksLikeCode(targetData)) {
        var lines = targetData.split('\n');

        // Extract field name from path for content type detection
        var fieldName = null;
        if (path) {
            var normalizedPath = path.replace(/^\$\.?/, '').replace(/^\./, '');
            var pathParts = normalizedPath.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
            // Get last non-numeric part as field name
            for (var pi = pathParts.length - 1; pi >= 0; pi--) {
                if (!/^\d+$/.test(pathParts[pi])) {
                    fieldName = pathParts[pi];
                    break;
                }
            }
        }
        var contentType = detectCodeContentType(targetData, fieldName);

        // Convert detailLevel to skipFactor: higher detail = lower skip (more symbols)
        // detailLevel 1 -> skipFactor 10, detailLevel 10 -> skipFactor 1
        var maxCodeOutlineSize = Math.floor(getCacheCharLimit() * 0.9);
        var requestedSkip = Math.max(1, 11 - detailLevel);
        var bestOutline = null;
        var actualSkip = requestedSkip;

        // Try increasing skip factors (less detail) until it fits
        for (var skip = requestedSkip; skip <= 50; skip++) {
            var outlineResult = generateCodemapWithOptions(targetData, contentType, skip, null, null);
            if (outlineResult.outline.length <= maxCodeOutlineSize) {
                bestOutline = outlineResult;
                actualSkip = skip;
                break;
            }
        }

        // If nothing fits even at max skip, reject
        if (!bestOutline) {
            var maxSkipOutline = generateCodemapWithOptions(targetData, contentType, 50, null, null);
            if (maxSkipOutline.outline.length > maxCodeOutlineSize) {
                return {
                    success: false,
                    error: 'Code outline too large even at minimum detail (' + Math.round(maxSkipOutline.outline.length / 1024) + 'KB, limit ~' + Math.round(maxCodeOutlineSize / 1024) + 'KB)',
                    totalLines: lines.length,
                    hint: 'Use cached_content_read with start_line/end_line to read specific portions, or cached_content_search to find specific code.'
                };
            }
            bestOutline = maxSkipOutline;
            actualSkip = 50;
        }

        // Convert skip back to detailLevel for response
        var actualDetailLevel = Math.max(1, 11 - actualSkip);
        var maxDetailLevel = Math.max(1, 11 - actualSkip);

        var codeResponse = {
            success: true,
            type: 'code',
            contentType: contentType,
            totalLines: lines.length,
            requestedDetailLevel: detailLevel,
            actualDetailLevel: actualDetailLevel,
            outline: bestOutline.outline,
            symbolCount: bestOutline.symbolCount,
            hint: 'Use cached_content_read with path and start_line/end_line to read specific lines'
        };

        // Inform agent if we couldn't provide the requested detail level
        if (actualDetailLevel < detailLevel) {
            codeResponse.note = 'Requested detail_level ' + detailLevel + ' would exceed size limit. Maximum available detail_level for this content is ' + maxDetailLevel + '.';
        }

        return codeResponse;
    }

    // JSON outline - detail_level maps to depth and array sample size
    var maxOutlineSize = Math.floor(getCacheCharLimit() * 0.9);
    var bestResult = null;
    var actualDetailLevel = detailLevel;

    // Build outline options for generateSmartOutline
    // targetPath: null = apply pagination to all arrays, '' = root only (when user specified a path)
    var outlineOptions = {
        arraySampleSize: detailLevel,
        arrayOffset: arrayOffset,
        arrayLimit: arrayLimit,
        targetPath: path ? '' : null
    };

    // Two modes:
    // 1. Explicit pagination (array_limit or array_offset): use exact values, REJECT if too large
    // 2. Only detail_level: dynamically reduce until it fits
    var usingExplicitPagination = arrayLimit || arrayOffset > 0;

    if (usingExplicitPagination) {
        // Explicit pagination: use exact values, reject if too large
        var result = generateSmartOutline(targetData, detailLevel, outlineOptions);
        var outlineStr = JSON.stringify(result.outline);
        if (outlineStr.length > maxOutlineSize) {
            return {
                success: false,
                error: 'Result too large (' + Math.round(outlineStr.length / 1024) + 'KB, limit ~' + Math.round(maxOutlineSize / 1024) + 'KB)',
                hint: 'Reduce array_limit (requested: ' + (arrayLimit || detailLevel) + ') or use a more specific path',
                pagination: { offset: arrayOffset, limit: arrayLimit || detailLevel }
            };
        }
        bestResult = result;
        actualDetailLevel = detailLevel;
    } else {
        // No explicit pagination: dynamically reduce detail_level until it fits
        for (var level = detailLevel; level >= 1; level--) {
            outlineOptions.arraySampleSize = level;
            var result = generateSmartOutline(targetData, level, outlineOptions);
            var outlineStr = JSON.stringify(result.outline);
            if (outlineStr.length <= maxOutlineSize) {
                bestResult = result;
                actualDetailLevel = level;
                break;
            }
        }

        // Fallback to minimal outline
        if (!bestResult) {
            outlineOptions.arraySampleSize = 1;
            bestResult = generateSmartOutline(targetData, 1, outlineOptions);
            actualDetailLevel = 1;
        }
    }

    var jsonResponse = {
        success: true,
        type: 'json',
        requestedDetailLevel: detailLevel,
        actualDetailLevel: actualDetailLevel,
        outline: bestResult.outline,
        stats: bestResult.stats,
        hint: 'Use path to focus on a section, or array_offset/array_limit to paginate arrays'
    };

    // Add pagination info if used
    if (usingExplicitPagination) {
        jsonResponse.pagination = {
            offset: arrayOffset,
            limit: arrayLimit || detailLevel
        };
    }

    // Note if detail_level was reduced (only in non-pagination mode)
    if (!usingExplicitPagination && actualDetailLevel < detailLevel) {
        jsonResponse.note = 'Reduced detail_level from ' + detailLevel + ' to ' + actualDetailLevel + ' to fit size limit.';
    }

    return jsonResponse;
}

// Execute cached_content_search tool
function executeCachedContentSearch(chatId, args) {
    var contentId = args.content_id;
    var query = args.query;
    var searchPath = args.path;
    var offset = args.offset || 0;
    var maxMatches = args.max_matches || 20;
    var MAX_RESULT_SIZE = 16000; // ~4k tokens

    var chat = chats[chatId];
    if (!chat || !chat.cachedToolResults || !chat.cachedToolResults[contentId]) {
        return { success: false, error: 'Cached content not found: ' + contentId };
    }

    var cached = chat.cachedToolResults[contentId];
    var searchTarget = cached.fullContent;

    // Navigate to path if specified
    if (searchPath) {
        var normalizedPath = searchPath.replace(/^\$\.?/, '').replace(/^\./, '');
        if (normalizedPath) {
            var pathParts = normalizedPath.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
            for (var p = 0; p < pathParts.length; p++) {
                if (searchTarget && typeof searchTarget === 'object') {
                    var key = pathParts[p];
                    if (Array.isArray(searchTarget) && /^\d+$/.test(key)) {
                        searchTarget = searchTarget[parseInt(key)];
                    } else {
                        searchTarget = searchTarget[key];
                    }
                } else {
                    return { success: false, error: 'Path "' + searchPath + '" not found in cached content' };
                }
            }
        }
    }

    if (searchTarget === undefined) {
        return { success: false, error: 'Path "' + searchPath + '" not found in cached content' };
    }

    // Create regex from query (always global, user can add (?i) for case-insensitive)
    var regex;
    try {
        regex = new RegExp(query, 'g');
    } catch (e) {
        return { success: false, error: 'Invalid regex pattern: ' + e.message };
    }

    var allMatches = [];
    var totalMatchesFound = 0;

    function searchInValue(val, currentPath) {
        if (typeof val === 'string') {
            var lines = val.split('\n');
            var matchedLines = new Set();

            // Search each line for matches
            for (var lineNum = 0; lineNum < lines.length; lineNum++) {
                var line = lines[lineNum];
                regex.lastIndex = 0;

                if (regex.test(line) && !matchedLines.has(lineNum)) {
                    matchedLines.add(lineNum);
                    totalMatchesFound++;

                    // Skip if before offset
                    if (totalMatchesFound <= offset) continue;

                    // Get context: 1 line before and 1 line after
                    var contextLines = [];
                    var startLineNum = Math.max(0, lineNum - 1);
                    var endLineNum = Math.min(lines.length - 1, lineNum + 1);

                    for (var cl = startLineNum; cl <= endLineNum; cl++) {
                        var prefix = (cl === lineNum) ? '> ' : '  ';
                        contextLines.push('[L' + (cl + 1) + '] ' + prefix + lines[cl]);
                    }

                    allMatches.push({
                        path: currentPath,
                        line: lineNum + 1,
                        context: contextLines.join('\n')
                    });
                }
            }
        } else if (Array.isArray(val)) {
            for (var i = 0; i < val.length; i++) {
                searchInValue(val[i], currentPath + '[' + i + ']');
            }
        } else if (val && typeof val === 'object') {
            var keys = Object.keys(val);
            for (var j = 0; j < keys.length; j++) {
                var childPath = currentPath ? currentPath + '.' + keys[j] : keys[j];
                searchInValue(val[keys[j]], childPath);
            }
        }
    }

    // Use clean path without $ prefix for results
    var basePath = searchPath ? searchPath.replace(/^\$\.?/, '') : '';
    searchInValue(searchTarget, basePath);

    // Apply max_matches and size limit to collected matches
    var matches = [];
    var totalResultSize = 0;
    var sizeLimitReached = false;

    for (var m = 0; m < allMatches.length && matches.length < maxMatches; m++) {
        var entrySize = JSON.stringify(allMatches[m]).length;
        if (totalResultSize + entrySize > MAX_RESULT_SIZE) {
            sizeLimitReached = true;
            break;
        }
        totalResultSize += entrySize;
        matches.push(allMatches[m]);
    }

    var hasMore = totalMatchesFound > offset + matches.length;
    var response = {
        success: true,
        query: query,
        path: searchPath || null,
        totalMatches: totalMatchesFound,
        offset: offset,
        returned: matches.length,
        matches: matches
    };

    if (hasMore) {
        response.hasMore = true;
        response.nextOffset = offset + matches.length;
        response.hint = 'Use offset: ' + (offset + matches.length) + ' to get next page';
    }

    if (sizeLimitReached) {
        response.sizeLimitReached = true;
    }

    return response;
}

// Execute cached_content_read tool
function executeCachedContentRead(chatId, args) {
    var contentId = args.content_id;
    var path = args.path;
    var startLine = args.start_line;
    var endLine = args.end_line;

    var chat = chats[chatId];
    if (!chat || !chat.cachedToolResults || !chat.cachedToolResults[contentId]) {
        return { success: false, error: 'Cached content not found: ' + contentId };
    }

    var cached = chat.cachedToolResults[contentId];
    var targetData = cached.fullContent;

    // Navigate to path if specified
    if (path) {
        // Normalize path: strip leading $ and . (search results use $.path.to.value format)
        var normalizedPath = path.replace(/^\$\.?/, '').replace(/^\./, '');
        if (!normalizedPath) {
            // Path was just "$" - return root
        } else {
            var pathParts = normalizedPath.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
            for (var i = 0; i < pathParts.length; i++) {
                if (targetData && typeof targetData === 'object') {
                    var key = pathParts[i];
                    if (Array.isArray(targetData) && /^\d+$/.test(key)) {
                        targetData = targetData[parseInt(key)];
                    } else {
                        targetData = targetData[key];
                    }
                } else {
                    return { success: false, error: 'Path "' + path + '" not found in cached content' };
                }
            }
        }
    }

    // Check if path resolved to undefined
    if (targetData === undefined) {
        return { success: false, error: 'Path "' + path + '" not found in cached content' };
    }

    // If it's a string, support line ranges
    if (typeof targetData === 'string') {
        var lines = targetData.split('\n');
        var totalLines = lines.length;

        // If no line range specified, reject if too large
        if (!startLine && !endLine) {
            var fullSize = targetData.length;
            if (fullSize > getCacheCharLimit()) {
                return {
                    success: false,
                    error: 'Content too large to read in full (' + Math.round(fullSize / 1024) + 'KB, limit is ' + Math.round(getCacheCharLimit() / 1024) + 'KB)',
                    totalLines: totalLines,
                    hint: 'Use start_line and end_line to read a portion (e.g., start_line: 1, end_line: 100), or use cached_content_search to find specific content.'
                };
            }
        }

        var sLine = startLine || 1;
        var eLine = endLine || totalLines;

        // Clamp to valid range
        sLine = Math.max(1, Math.min(sLine, totalLines));
        eLine = Math.max(sLine, Math.min(eLine, totalLines));

        var selectedLines = lines.slice(sLine - 1, eLine);
        var content = selectedLines.map(function(line, idx) {
            return (sLine + idx) + ': ' + line;
        }).join('\n');

        // Check if the selected content is too large
        if (content.length > getCacheCharLimit()) {
            return {
                success: false,
                error: 'Selected range too large (' + Math.round(content.length / 1024) + 'KB, limit is ' + Math.round(getCacheCharLimit() / 1024) + 'KB)',
                requestedLines: eLine - sLine + 1,
                totalLines: totalLines,
                hint: 'Request fewer lines (current range: ' + sLine + '-' + eLine + '). Try a smaller range like start_line: ' + sLine + ', end_line: ' + Math.min(sLine + 99, eLine) + '.'
            };
        }

        return {
            success: true,
            type: 'string',
            totalLines: totalLines,
            readRange: { start: sLine, end: eLine },
            content: content
        };
    }

    // Check if targetData is null
    if (targetData === null) {
        return { success: true, type: 'null', value: null };
    }

    // For non-strings, check size first
    var valStr = JSON.stringify(targetData, null, 2);
    if (valStr === undefined) {
        return { success: false, error: 'Cannot serialize value at path "' + (path || 'root') + '"' };
    }

    if (valStr.length > getCacheCharLimit()) {
        var outlineResult = generateSmartOutline(targetData, 3);
        return {
            success: false,
            error: 'Value too large to read in full (' + Math.round(valStr.length / 1024) + 'KB, limit is ' + Math.round(getCacheCharLimit() / 1024) + 'KB)',
            type: typeof targetData,
            hint: 'Use a more specific path to read a smaller portion, use cached_content_outline to explore the structure, or use cached_content_search to find specific content.',
            structure: outlineResult.outline
        };
    }

    return {
        success: true,
        type: typeof targetData,
        value: targetData
    };
}

function getSystemPromptWithContext() {
    // Use custom template if available, otherwise use default template
    var template = getSystemPromptTemplate();
    return expandSystemPromptPlaceholders(template);
}
