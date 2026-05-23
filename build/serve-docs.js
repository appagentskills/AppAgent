#!/usr/bin/env node
// Serves the docs/ folder over HTTP for local preview of the github.io page.
// Zero dependencies — uses only Node built-ins. Stop with Ctrl+C.

const http = require('http');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..');
const ROOT = path.join(REPO_ROOT, 'docs');
const PORT = parseInt(process.env.PORT, 10) || 8080;
const MANIFEST_SRC = path.join(REPO_ROOT, 'src', 'platform', 'extension', 'manifest.json');

function readVersion() {
    try { return JSON.parse(fs.readFileSync(MANIFEST_SRC, 'utf-8')).version || ''; }
    catch (e) { return ''; }
}

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.css':  'text/css; charset=utf-8',
    '.js':   'application/javascript; charset=utf-8',
    '.md':   'text/markdown; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg':  'image/svg+xml',
    '.png':  'image/png',
    '.jpg':  'image/jpeg',
    '.ico':  'image/x-icon',
};

const server = http.createServer((req, res) => {
    // Strip query string + decode + collapse traversal
    let urlPath = decodeURIComponent(req.url.split('?')[0]);
    if (urlPath === '/' || urlPath === '') urlPath = '/index.html';

    // Resolve against ROOT and ensure we don't escape it.
    const resolved = path.normalize(path.join(ROOT, urlPath));
    if (!resolved.startsWith(ROOT)) {
        res.writeHead(403); res.end('Forbidden'); return;
    }

    fs.stat(resolved, (err, stat) => {
        if (err || !stat.isFile()) {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('Not found: ' + urlPath);
            return;
        }
        const ext = path.extname(resolved).toLowerCase();
        const headers = {
            'Content-Type': MIME[ext] || 'application/octet-stream',
            'Cache-Control': 'no-cache',
        };

        // Substitute __VERSION__ on the fly when serving documentation.md.
        // github pages won't do this — it serves static files raw — so the
        // committed source can stay placeholder'd and dev preview shows the
        // current manifest version without keeping a duplicate file around.
        if (urlPath === '/documentation.md') {
            const md = fs.readFileSync(resolved, 'utf-8').split('__VERSION__').join(readVersion());
            res.writeHead(200, headers);
            res.end(md);
            return;
        }

        res.writeHead(200, headers);
        fs.createReadStream(resolved).pipe(res);
    });
});

// Files served by Pages live in docs/, but README.md + its hero image stay at
// the repo root. The Pages workflow copies them in; for local preview we
// route the two paths to the repo root instead of forcing a build step.
const ROOT_FALLBACKS = new Set(['/README.md', '/AppAgentExample.png']);
const _origListener = server.listeners('request')[0];
server.removeAllListeners('request');
server.on('request', (req, res) => {
    const urlPath = decodeURIComponent(req.url.split('?')[0]);
    if (ROOT_FALLBACKS.has(urlPath)) {
        const src = path.join(REPO_ROOT, urlPath.slice(1));
        fs.stat(src, (err, stat) => {
            if (err || !stat.isFile()) {
                res.writeHead(404, { 'Content-Type': 'text/plain' });
                res.end('Not found: ' + urlPath);
                return;
            }
            const ext = path.extname(src).toLowerCase();
            res.writeHead(200, {
                'Content-Type': MIME[ext] || 'application/octet-stream',
                'Cache-Control': 'no-cache',
            });
            fs.createReadStream(src).pipe(res);
        });
        return;
    }
    _origListener(req, res);
});

server.listen(PORT, () => {
    console.log(`Serving docs/ at http://localhost:${PORT}/  (Ctrl+C to stop)`);
});
