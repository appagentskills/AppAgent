// =============================================
// CODEMAP GENERATION - For large files (>500 lines)
// Uses pattern-based parsing for JS/HTML/CSS
// =============================================

var CODEMAP_LINE_THRESHOLD = 500;

// Generate codemap for JavaScript content
function generateJSCodemap(content) {
    var lines = content.split('\n');
    var symbols = [];
    var currentClass = null;
    var braceDepth = 0;
    var classStartLine = 0;
    
    for (var i = 0; i < lines.length; i++) {
        var line = lines[i];
        var lineNum = i + 1;
        var trimmed = line.trim();
        
        // Track brace depth for class scope
        var openBraces = (line.match(/\{/g) || []).length;
        var closeBraces = (line.match(/\}/g) || []).length;
        
        // Class declaration
        var classMatch = trimmed.match(/^(?:export\s+)?(?:default\s+)?class\s+(\w+)(?:\s+extends\s+(\w+))?/);
        if (classMatch) {
            currentClass = classMatch[1];
            classStartLine = lineNum;
            var ext = classMatch[2] ? ' extends ' + classMatch[2] : '';
            symbols.push({ type: 'class', name: classMatch[1] + ext, line: lineNum, endLine: null });
            braceDepth = 1;
            continue;
        }
        
        // Track when we exit the class
        if (currentClass) {
            braceDepth += openBraces - closeBraces;
            if (braceDepth <= 0) {
                // Find the class symbol and set its end line
                for (var j = symbols.length - 1; j >= 0; j--) {
                    if (symbols[j].type === 'class' && symbols[j].name.startsWith(currentClass)) {
                        symbols[j].endLine = lineNum;
                        break;
                    }
                }
                currentClass = null;
                braceDepth = 0;
            }
        }
        
        // Method inside class (including async, static, get, set)
        if (currentClass) {
            var methodMatch = trimmed.match(/^(?:async\s+)?(?:static\s+)?(?:get\s+|set\s+)?(\w+)\s*\([^)]*\)\s*\{?/);
            if (methodMatch && !trimmed.startsWith('if') && !trimmed.startsWith('for') && !trimmed.startsWith('while') && !trimmed.startsWith('switch')) {
                symbols.push({ type: 'method', name: currentClass + '.' + methodMatch[1] + '()', line: lineNum, parent: currentClass });
            }
            continue;
        }
        
        // Function declaration (named functions)
        var funcMatch = trimmed.match(/^(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)/);
        if (funcMatch) {
            var params = funcMatch[2].trim();
            symbols.push({ type: 'function', name: funcMatch[1] + '(' + (params.length > 30 ? params.substring(0, 30) + '...' : params) + ')', line: lineNum });
            continue;
        }
        
        // Arrow function or function expression assigned to const/let/var
        var arrowMatch = trimmed.match(/^(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?(?:\([^)]*\)|[\w]+)\s*=>/);
        if (arrowMatch) {
            symbols.push({ type: 'function', name: arrowMatch[1] + '()', line: lineNum });
            continue;
        }
        
        // Function expression assigned to variable
        var funcExprMatch = trimmed.match(/^(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?function/);
        if (funcExprMatch) {
            symbols.push({ type: 'function', name: funcExprMatch[1] + '()', line: lineNum });
            continue;
        }
        
        // Object with methods pattern: var/const NAME = { ... }
        var objMatch = trimmed.match(/^(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*\{/);
        if (objMatch) {
            symbols.push({ type: 'object', name: objMatch[1], line: lineNum });
            continue;
        }
        
        // IIFE pattern
        if (trimmed.match(/^\((?:async\s+)?function\s*\(/)) {
            symbols.push({ type: 'iife', name: '(IIFE)', line: lineNum });
            continue;
        }
        
        // Import statements (group them)
        if (trimmed.startsWith('import ') && symbols.length > 0 && symbols[symbols.length - 1].type !== 'imports') {
            symbols.push({ type: 'imports', name: 'imports', line: lineNum });
        }
    }
    
    return symbols;
}

// Generate codemap for HTML content
function generateHTMLCodemap(content) {
    var lines = content.split('\n');
    var symbols = [];
    var inScript = false;
    var inStyle = false;
    var scriptStart = 0;
    var styleStart = 0;
    var scriptContent = [];
    var styleContent = [];
    
    for (var i = 0; i < lines.length; i++) {
        var line = lines[i];
        var lineNum = i + 1;
        var trimmed = line.trim().toLowerCase();
        
        // Script tag detection
        if (trimmed.match(/<script[^>]*>/i) && !trimmed.match(/<script[^>]*src=/i)) {
            inScript = true;
            scriptStart = lineNum;
            scriptContent = [];
            var idMatch = line.match(/id=["']([^"']+)["']/i);
            var typeMatch = line.match(/type=["']([^"']+)["']/i);
            var label = idMatch ? 'script#' + idMatch[1] : (typeMatch ? 'script[' + typeMatch[1] + ']' : 'script');
            symbols.push({ type: 'script-start', name: label, line: lineNum, endLine: null });
            continue;
        }
        
        if (inScript) {
            if (trimmed.match(/<\/script>/i)) {
                inScript = false;
                // Update the script symbol with end line
                for (var j = symbols.length - 1; j >= 0; j--) {
                    if (symbols[j].type === 'script-start' && symbols[j].endLine === null) {
                        symbols[j].endLine = lineNum;
                        symbols[j].type = 'script';
                        break;
                    }
                }
                // Parse JS content inside script
                var jsSymbols = generateJSCodemap(scriptContent.join('\n'));
                jsSymbols.forEach(function(sym) {
                    sym.line = sym.line + scriptStart; // Adjust line numbers
                    if (sym.endLine) sym.endLine = sym.endLine + scriptStart;
                    sym.parent = 'script';
                    symbols.push(sym);
                });
            } else {
                scriptContent.push(line);
            }
            continue;
        }
        
        // Style tag detection
        if (trimmed.match(/<style[^>]*>/i)) {
            inStyle = true;
            styleStart = lineNum;
            styleContent = [];
            var styleIdMatch = line.match(/id=["']([^"']+)["']/i);
            var styleLabel = styleIdMatch ? 'style#' + styleIdMatch[1] : 'style';
            symbols.push({ type: 'style-start', name: styleLabel, line: lineNum, endLine: null });
            continue;
        }
        
        if (inStyle) {
            if (trimmed.match(/<\/style>/i)) {
                inStyle = false;
                for (var k = symbols.length - 1; k >= 0; k--) {
                    if (symbols[k].type === 'style-start' && symbols[k].endLine === null) {
                        symbols[k].endLine = lineNum;
                        symbols[k].type = 'style';
                        break;
                    }
                }
                // Parse CSS content
                var cssSymbols = generateCSSCodemap(styleContent.join('\n'));
                cssSymbols.forEach(function(sym) {
                    sym.line = sym.line + styleStart;
                    if (sym.endLine) sym.endLine = sym.endLine + styleStart;
                    sym.parent = 'style';
                    symbols.push(sym);
                });
            } else {
                styleContent.push(line);
            }
            continue;
        }
        
        // Major HTML sections
        var sectionMatch = line.match(/<(html|head|body|header|nav|main|article|section|aside|footer|form|table|div|template)(?:\s+[^>]*)?(?:id=["']([^"']+)["'])?[^>]*>/i);
        if (sectionMatch) {
            var tag = sectionMatch[1].toLowerCase();
            var id = sectionMatch[2];
            var className = (line.match(/class=["']([^"']+)["']/i) || [])[1];
            var name = tag;
            if (id) name += '#' + id;
            else if (className) name += '.' + className.split(/\s+/)[0];
            
            // Only include significant structural elements
            if (['html', 'head', 'body', 'header', 'nav', 'main', 'article', 'section', 'aside', 'footer', 'form', 'template'].includes(tag) || id) {
                symbols.push({ type: 'element', name: name, line: lineNum });
            }
        }
    }
    
    return symbols;
}

// Generate codemap for CSS content
function generateCSSCodemap(content) {
    var lines = content.split('\n');
    var symbols = [];
    var inBlock = false;
    var blockStart = 0;
    var currentSelector = '';
    
    for (var i = 0; i < lines.length; i++) {
        var line = lines[i];
        var lineNum = i + 1;
        var trimmed = line.trim();
        
        // Skip comments
        if (trimmed.startsWith('/*') || trimmed.startsWith('*') || trimmed.startsWith('//')) continue;
        
        // Media query
        var mediaMatch = trimmed.match(/^@media\s+(.+?)\s*\{/);
        if (mediaMatch) {
            symbols.push({ type: 'media', name: '@media ' + mediaMatch[1], line: lineNum });
            continue;
        }
        
        // Keyframes
        var keyframeMatch = trimmed.match(/^@keyframes\s+(\w+)/);
        if (keyframeMatch) {
            symbols.push({ type: 'keyframes', name: '@keyframes ' + keyframeMatch[1], line: lineNum });
            continue;
        }
        
        // CSS variables / root
        if (trimmed.match(/^:root\s*\{/)) {
            symbols.push({ type: 'variables', name: ':root (CSS variables)', line: lineNum });
            continue;
        }
        
        // Regular selector (only significant ones - IDs, classes, elements)
        var selectorMatch = trimmed.match(/^([^{]+)\{/);
        if (selectorMatch) {
            var selector = selectorMatch[1].trim();
            // Only include class selectors, ID selectors, or element selectors
            if (selector.match(/^[.#]?[\w-]+/) && selector.length < 60) {
                symbols.push({ type: 'rule', name: selector, line: lineNum });
            }
        }
    }
    
    return symbols;
}

// Main function to generate codemap based on content type
function generateCodemap(content, contentType) {
    var symbols = [];
    var totalLines = content.split('\n').length;

    if (contentType === 'javascript' || contentType === 'js') {
        symbols = generateJSCodemap(content);
    } else if (contentType === 'html') {
        symbols = generateHTMLCodemap(content);
    } else if (contentType === 'css') {
        symbols = generateCSSCodemap(content);
    } else {
        // Auto-detect based on content using smart detection
        var detectedType = detectCodeContentType(content, null);
        if (detectedType === 'html') {
            symbols = generateHTMLCodemap(content);
        } else if (detectedType === 'css') {
            symbols = generateCSSCodemap(content);
        } else {
            symbols = generateJSCodemap(content);
        }
    }
    
    // Format output as readable codemap
    var output = '=== CODEMAP (' + totalLines + ' lines total) ===\n';
    output += 'File too large to display in full. Use cached_content_read with start_line/end_line to read specific sections.\n\n';
    
    var currentParent = null;
    symbols.forEach(function(sym) {
        var indent = sym.parent ? '  ' : '';
        var lineInfo = sym.endLine ? 'L' + sym.line + '-' + sym.endLine : 'L' + sym.line;
        output += indent + '[' + lineInfo + '] ' + sym.type + ': ' + sym.name + '\n';
    });
    
    output += '\n=== END CODEMAP ===';
    output += '\nUse cached_content_read with start_line/end_line to read specific sections.';
    
    return { codemap: output, symbols: symbols, totalLines: totalLines };
}

// Detect content type from field name
function detectContentType(fieldName, tableName) {
    if (fieldName === 'script' || fieldName === 'client_script' || fieldName === 'server_script') {
        return 'javascript';
    }
    if (fieldName === 'html') {
        return 'html';
    }
    if (fieldName === 'css' || fieldName === 'style') {
        return 'css';
    }
    // Table-based detection
    if (tableName === 'sys_script_include' || tableName === 'sys_script' || tableName === 'sys_script_client') {
        return 'javascript';
    }
    if (tableName === 'sys_ui_page') {
        if (fieldName === 'html') return 'html';
        return 'javascript';
    }
    if (tableName === 'sp_widget') {
        if (fieldName === 'template') return 'html';
        if (fieldName === 'css') return 'css';
        return 'javascript';
    }
    return 'auto';
}

// Generate codemap with skip factor and line range options
// skipFactor: 1 = all symbols (most detail), higher = skip more symbols (less detail)
// Internally converts to detailLevel for display: detailLevel = max(1, 11 - skipFactor)
function generateCodemapWithOptions(content, contentType, skipFactor, startLine, endLine) {
    var symbols = [];
    var totalLines = content.split('\n').length;

    if (contentType === 'javascript' || contentType === 'js') {
        symbols = generateJSCodemap(content);
    } else if (contentType === 'html') {
        symbols = generateHTMLCodemap(content);
    } else if (contentType === 'css') {
        symbols = generateCSSCodemap(content);
    } else {
        // Auto-detect based on content using smart detection
        var detectedType = detectCodeContentType(content, null);
        if (detectedType === 'html') {
            symbols = generateHTMLCodemap(content);
        } else if (detectedType === 'css') {
            symbols = generateCSSCodemap(content);
        } else {
            symbols = generateJSCodemap(content);
        }
    }

    // Filter by line range if specified
    if (startLine !== null || endLine !== null) {
        var sLine = startLine || 1;
        var eLine = endLine || totalLines;
        symbols = symbols.filter(function(sym) {
            return sym.line >= sLine && sym.line <= eLine;
        });
    }

    var totalSymbols = symbols.length;

    // Apply skip factor (keep every Nth symbol)
    var filteredSymbols = [];
    if (skipFactor > 1) {
        for (var i = 0; i < symbols.length; i += skipFactor) {
            filteredSymbols.push(symbols[i]);
        }
        symbols = filteredSymbols;
    }

    // Convert skipFactor to detailLevel for display
    var detailLevel = Math.max(1, 11 - skipFactor);

    // Format output as readable codemap
    var rangeNote = '';
    if (startLine !== null || endLine !== null) {
        rangeNote = ' (lines ' + (startLine || 1) + '-' + (endLine || totalLines) + ')';
    }
    var detailNote = skipFactor > 1 ? ' [detail_level=' + detailLevel + ', showing ' + symbols.length + ' of ' + totalSymbols + ' symbols]' : '';

    var output = '=== CODE OUTLINE (' + totalLines + ' lines)' + rangeNote + detailNote + ' ===\n\n';

    var currentParent = null;
    symbols.forEach(function(sym) {
        var indent = sym.parent ? '  ' : '';
        var lineInfo = sym.endLine ? 'L' + sym.line + '-' + sym.endLine : 'L' + sym.line;
        output += indent + '[' + lineInfo + '] ' + sym.type + ': ' + sym.name + '\n';
    });

    output += '\n=== END CODE OUTLINE ===';
    output += '\nUse cached_content_read with start_line/end_line to read specific line ranges.';

    return { outline: output, symbolCount: symbols.length, totalLines: totalLines, detailLevel: detailLevel };
}

// Calculate codemap line counts at various detail levels (skip factors)
function getCodemapLineCounts(content, contentType) {
    var symbols = [];
    var totalLines = content.split('\n').length;
    
    if (contentType === 'javascript' || contentType === 'js') {
        symbols = generateJSCodemap(content);
    } else if (contentType === 'html') {
        symbols = generateHTMLCodemap(content);
    } else if (contentType === 'css') {
        symbols = generateCSSCodemap(content);
    } else {
        if (content.trim().startsWith('<!DOCTYPE') || content.trim().startsWith('<html') || content.match(/<(head|body|div|script|style)[>\s]/i)) {
            symbols = generateHTMLCodemap(content);
        } else if (content.match(/^[\s]*[.#@]?[\w-]+\s*\{/m) && content.match(/[\w-]+\s*:\s*[^;]+;/)) {
            symbols = generateCSSCodemap(content);
        } else {
            symbols = generateJSCodemap(content);
        }
    }
    
    var fullCount = symbols.length;
    return {
        totalLines: totalLines,
        zoom1: fullCount,
        zoom2: Math.ceil(fullCount / 2),
        zoom3: Math.ceil(fullCount / 3),
        zoom5: Math.ceil(fullCount / 5)
    };
}

// JSON Outline - generate structural outline of JSON data with detail level (depth) control
// detail_level 1 = 1 level deep, 2 = 2 levels, etc. Higher = more detail
function generateJsonOutline(data, maxDepth) {
    maxDepth = maxDepth || 3; // Default to 3 levels deep
    var stats = { totalKeys: 0, totalArrayItems: 0, maxDepthReached: 0 };

    function getType(val) {
        if (val === null) return 'null';
        if (Array.isArray(val)) return 'array';
        return typeof val;
    }

    function outlineValue(val, depth, path) {
        if (depth > stats.maxDepthReached) stats.maxDepthReached = depth;
        var type = getType(val);

        if (type === 'object' && val !== null) {
            var keys = Object.keys(val);
            stats.totalKeys += keys.length;
            if (depth >= maxDepth) {
                return '{' + keys.length + ' keys: ' + keys.slice(0, 5).join(', ') + (keys.length > 5 ? ', ...' : '') + '}';
            }
            var result = {};
            keys.forEach(function(k) {
                result[k] = outlineValue(val[k], depth + 1, path + '.' + k);
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
            // Show first few items as sample
            var sample = val.slice(0, 3).map(function(item, i) {
                return outlineValue(item, depth + 1, path + '[' + i + ']');
            });
            if (val.length > 3) {
                return { _array: sample, _more: '... +' + (val.length - 3) + ' more items' };
            }
            return sample;
        } else if (type === 'string') {
            if (val.length > 100) return '"...' + val.length + ' chars"';
            if (val.length > 50) return '"' + val.substring(0, 47) + '..."';
            return val;
        } else {
            return val;
        }
    }

    var outline = outlineValue(data, 1, '$');
    return {
        outline: outline,
        stats: stats
    };
}

// Get JSON structure info at different detail levels
function getJsonStructureInfo(data) {
    function countStructure(val, depth, maxDepth) {
        if (depth > maxDepth) return { keys: 0, items: 0 };
        var type = Array.isArray(val) ? 'array' : typeof val;
        var result = { keys: 0, items: 0 };

        if (type === 'object' && val !== null) {
            var keys = Object.keys(val);
            result.keys = keys.length;
            keys.forEach(function(k) {
                var sub = countStructure(val[k], depth + 1, maxDepth);
                result.keys += sub.keys;
                result.items += sub.items;
            });
        } else if (type === 'array') {
            result.items = val.length;
            val.slice(0, 10).forEach(function(item) { // Sample first 10
                var sub = countStructure(item, depth + 1, maxDepth);
                result.keys += sub.keys;
                result.items += sub.items;
            });
        }
        return result;
    }

    return {
        zoom1: countStructure(data, 1, 1),
        zoom2: countStructure(data, 1, 2),
        zoom3: countStructure(data, 1, 3),
        zoom5: countStructure(data, 1, 5)
    };
}
