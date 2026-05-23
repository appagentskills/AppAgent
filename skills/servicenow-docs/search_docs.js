var TOOL_DEFINITION = {
    type: "function",
    function: {
        name: "search_docs",
        description: "Search ServiceNow documentation and community. Searches official docs by default, or community posts, or both.",
        parameters: {
            type: "object",
            properties: {
                query: { type: "string", description: "Search query (e.g., 'catalog item ACL', 'GlideRecord API')" },
                source: { type: "string", enum: ["docs", "community", "both"], description: "Where to search. Default: docs" },
                action: { type: "string", enum: ["search", "read"], description: "Action: 'search' to find topics, 'read' to fetch a specific doc topic. Default: search" },
                map_id: { type: "string", description: "For action='read': the mapId from a previous search result" },
                content_id: { type: "string", description: "For action='read': the contentId from a previous search result" },
                read_first: { type: "boolean", description: "Fetch full content of the first search result. Default: true. Set to false only when browsing titles." },
                limit: { type: "number", description: "Number of search results to return. Default: 5" },
                page: { type: "number", description: "Page number for search results. Default: 1" }
            }
        }
    }
};

function stripHtml(html) {
    return (html || '')
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\s+/g, ' ')
        .trim();
}

async function searchCommunity(query, limit) {
    var escaped = query.replace(/'/g, "''");
    var liql = "SELECT subject,body,view_href FROM messages WHERE subject MATCHES '" + escaped + "' LIMIT " + (limit || 5);
    var res = await executeTool("web_fetch", {
        url: "https://www.servicenow.com/community/s/api/2.0/search?q=" + encodeURIComponent(liql)
    });
    if (!res.success) return [];
    try {
        var data = JSON.parse(res.body);
        if (data.status !== "success" || !data.data || !data.data.items) return [];
        return data.data.items.map(function(item) {
            return {
                source: "community",
                title: item.subject || '',
                url: item.view_href || '',
                excerpt: stripHtml(item.body).substring(0, 200)
            };
        });
    } catch (e) {
        return [];
    }
}

async function search_docs(args) {
    var action = args.action || "search";
    var source = args.source || "docs";
    var baseUrl = "https://www.servicenow.com/docs";

    // Read a specific doc topic
    if (action === "read") {
        if (!args.map_id || !args.content_id) {
            return { success: false, error: "map_id and content_id are required for reading a topic" };
        }
        var contentUrl = baseUrl + "/api/khub/maps/" + encodeURIComponent(args.map_id) + "/topics/" + encodeURIComponent(args.content_id) + "/content";
        var contentRes = await executeTool("web_fetch", { url: contentUrl });
        if (!contentRes.success) return contentRes;

        // Strip HTML to readable text
        var text = contentRes.body
            .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
            .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
            .replace(/<[^>]+>/g, ' ')
            .replace(/&nbsp;/g, ' ')
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'")
            .replace(/\s+/g, ' ')
            .trim();

        return { success: true, content: text, map_id: args.map_id, content_id: args.content_id };
    }

    // Search
    if (!args.query) {
        return { success: false, error: "query is required for search" };
    }

    var results = [];

    // Search official docs
    if (source === "docs" || source === "both") {
        var searchRes = await executeTool("web_fetch", {
            url: baseUrl + "/api/khub/clustered-search",
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                query: args.query,
                paging: { perPage: args.limit || 5, page: args.page || 1 },
                contentLocale: "en-US"
            })
        });
        if (searchRes.success) {
            try {
                var data = JSON.parse(searchRes.body);
                if (data.results) {
                    data.results.forEach(function(cluster) {
                        if (cluster.entries) {
                            cluster.entries.forEach(function(entry) {
                                if (entry.topic) {
                                    var t = entry.topic;
                                    var prettyUrl = '';
                                    if (t.metadata) {
                                        var urlMeta = t.metadata.find(function(m) { return m.key === 'ft:prettyUrl'; });
                                        if (urlMeta && urlMeta.values && urlMeta.values[0]) {
                                            prettyUrl = 'https://www.servicenow.com/docs/r/' + urlMeta.values[0];
                                        }
                                    }
                                    results.push({
                                        source: "docs",
                                        title: t.title,
                                        excerpt: stripHtml(t.htmlExcerpt),
                                        map_id: t.mapId,
                                        content_id: t.contentId,
                                        url: prettyUrl
                                    });
                                }
                            });
                        }
                    });
                }
            } catch (e) {}
        }
    }

    // Search community
    if (source === "community" || source === "both") {
        var communityResults = await searchCommunity(args.query, args.limit);
        results = results.concat(communityResults);
    }

    if (results.length === 0) {
        return { success: false, error: "No results found" };
    }

    var readFirst = args.read_first !== false;

    if (readFirst && results[0].source === "docs" && results[0].map_id) {
        var first = results[0];
        var readResult = await search_docs({ action: "read", map_id: first.map_id, content_id: first.content_id });
        return {
            success: true,
            query: args.query,
            title: first.title,
            url: first.url,
            other_results: results.slice(1).map(function(r) { return { title: r.title, url: r.url, source: r.source, map_id: r.map_id, content_id: r.content_id }; }),
            content: readResult.success ? readResult.content : readResult.error
        };
    }

    if (readFirst && results[0].source === "community") {
        var first = results[0];
        return {
            success: true,
            query: args.query,
            title: first.title,
            url: first.url,
            other_results: results.slice(1).map(function(r) { return { title: r.title, url: r.url, source: r.source, map_id: r.map_id, content_id: r.content_id }; }),
            content: first.excerpt
        };
    }

    return {
        success: true,
        query: args.query,
        results: results
    };
}
