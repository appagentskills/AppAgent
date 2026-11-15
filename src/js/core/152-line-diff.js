// Shared line diff (DOM-free; page bundle via the core tier AND the service-worker
// bundle via WORKER_SHARED_FILES in build/build.js + skills/extension-dev/build.js).
//
// lineDiffOps(a, b) -> [{type:'same'|'remove'|'add', oldIndex, newIndex}]
//   a, b: arrays of lines. oldIndex/newIndex are 0-based (null on the side a
//   row does not exist). Inside every change block all removes come before
//   the adds, so a replaced region reads as "- old ... + new" (no interleaving).
//
// Algorithm: common prefix/suffix trimmed, then linear-space Myers (middle
// snake / bisect, O((N+M)·D) time, O(N+M) space) recursing on both halves with
// the prefix/suffix trimmed again at each level -> a minimal edit script. All
// recursion levels share one step budget (LINE_DIFF_STEP_BUDGET). When it runs
// out (huge, very different inputs) the remaining ranges use patience anchors
// (lines unique on both sides, longest increasing subsequence) recursing on the
// gaps; a gap without anchors becomes delete + insert. Result is then still a
// valid (just not necessarily minimal) diff, in bounded time.
//
// Consumers: ui/090 computeDiff, tools/020 _wsPrFileLineCounts (+/- counts at
// push time, must equal computeDiff's), tools/110 _sdocLineDiffArr.
var LINE_DIFF_STEP_BUDGET = 25000000;

function lineDiffOps(a, b, opts) {
    a = a || []; b = b || [];
    var budget = { left: (opts && opts.budget > 0) ? opts.budget : LINE_DIFF_STEP_BUDGET };
    // Lines -> integer ids so the hot loops compare numbers.
    var ids = new Map(), A = new Int32Array(a.length), B = new Int32Array(b.length), next = 0, i, id;
    for (i = 0; i < a.length; i++) { id = ids.get(a[i]); if (id === undefined) { id = next++; ids.set(a[i], id); } A[i] = id; }
    for (i = 0; i < b.length; i++) { id = ids.get(b[i]); if (id === undefined) { id = next++; ids.set(b[i], id); } B[i] = id; }
    var mA = [], mB = []; // matched (same) index pairs, increasing
    _lineDiffRange(A, B, 0, A.length, 0, B.length, mA, mB, budget);
    var ops = [], x = 0, y = 0, k;
    for (k = 0; k <= mA.length; k++) {
        var ea = k < mA.length ? mA[k] : A.length, eb = k < mA.length ? mB[k] : B.length;
        while (x < ea) ops.push({ type: 'remove', oldIndex: x++, newIndex: null });
        while (y < eb) ops.push({ type: 'add', oldIndex: null, newIndex: y++ });
        if (k < mA.length) ops.push({ type: 'same', oldIndex: x++, newIndex: y++ });
    }
    return ops;
}

// Diff A[aLo,aHi) vs B[bLo,bHi): appends matches to mA/mB in order.
function _lineDiffRange(A, B, aLo, aHi, bLo, bHi, mA, mB, budget) {
    while (aLo < aHi && bLo < bHi && A[aLo] === B[bLo]) { mA.push(aLo++); mB.push(bLo++); }
    var suf = 0;
    while (aHi - suf > aLo && bHi - suf > bLo && A[aHi - 1 - suf] === B[bHi - 1 - suf]) suf++;
    aHi -= suf; bHi -= suf;
    if (aLo < aHi && bLo < bHi) {
        var split = budget.left > 0 ? _lineDiffBisect(A, B, aLo, aHi, bLo, bHi, budget) : null;
        if (split && split.none) {
            // no common line at all: delete + insert
        } else if (split && !((split.x === aLo && split.y === bLo) || (split.x === aHi && split.y === bHi))) {
            _lineDiffRange(A, B, aLo, split.x, bLo, split.y, mA, mB, budget);
            _lineDiffRange(A, B, split.x, aHi, split.y, bHi, mA, mB, budget);
        } else {
            _lineDiffPatience(A, B, aLo, aHi, bLo, bHi, mA, mB);
        }
    }
    for (var s = 0; s < suf; s++) { mA.push(aHi + s); mB.push(bHi + s); }
}

// Myers middle snake on the (already trimmed) range. Returns {x, y} (split
// point), {none:true} when the ranges share no path to overlap (no common
// subsequence worth keeping), or null when the shared budget ran out.
function _lineDiffBisect(A, B, aLo, aHi, bLo, bHi, budget) {
    var N = aHi - aLo, M = bHi - bLo;
    var maxD = Math.ceil((N + M) / 2), off = maxD, vLen = 2 * maxD + 2;
    var v1 = new Int32Array(vLen).fill(-1), v2 = new Int32Array(vLen).fill(-1);
    v1[off + 1] = 0; v2[off + 1] = 0;
    var delta = N - M, front = (delta & 1) !== 0;
    var k1start = 0, k1end = 0, k2start = 0, k2end = 0, d, k1, k2, x1, y1, x2, y2, ko, steps = 0;
    for (d = 0; d < maxD; d++) {
        for (k1 = -d + k1start; k1 <= d - k1end; k1 += 2) {
            ko = off + k1;
            x1 = (k1 === -d || (k1 !== d && v1[ko - 1] < v1[ko + 1])) ? v1[ko + 1] : v1[ko - 1] + 1;
            y1 = x1 - k1;
            while (x1 < N && y1 < M && A[aLo + x1] === B[bLo + y1]) { x1++; y1++; steps++; }
            steps++;
            v1[ko] = x1;
            if (x1 > N) k1end += 2;
            else if (y1 > M) k1start += 2;
            else if (front) {
                var k2o = off + delta - k1;
                if (k2o >= 0 && k2o < vLen && v2[k2o] !== -1 && x1 >= N - v2[k2o]) { budget.left -= steps; return { x: aLo + x1, y: bLo + y1 }; }
            }
        }
        for (k2 = -d + k2start; k2 <= d - k2end; k2 += 2) {
            ko = off + k2;
            x2 = (k2 === -d || (k2 !== d && v2[ko - 1] < v2[ko + 1])) ? v2[ko + 1] : v2[ko - 1] + 1;
            y2 = x2 - k2;
            while (x2 < N && y2 < M && A[aHi - 1 - x2] === B[bHi - 1 - y2]) { x2++; y2++; steps++; }
            steps++;
            v2[ko] = x2;
            if (x2 > N) k2end += 2;
            else if (y2 > M) k2start += 2;
            else if (!front) {
                var k1o = off + delta - k2;
                if (k1o >= 0 && k1o < vLen && v1[k1o] !== -1) {
                    x1 = v1[k1o]; y1 = x1 - (k1o - off);
                    if (x1 >= N - x2) { budget.left -= steps; return { x: aLo + x1, y: bLo + y1 }; }
                }
            }
        }
        if (steps >= budget.left) { budget.left = 0; return null; }
    }
    budget.left -= steps;
    return { none: true };
}

// Budget fallback: patience anchors (lines unique in both ranges, kept in
// order via LIS) and recursion on the gaps; no anchors -> delete + insert.
function _lineDiffPatience(A, B, aLo, aHi, bLo, bHi, mA, mB) {
    while (aLo < aHi && bLo < bHi && A[aLo] === B[bLo]) { mA.push(aLo++); mB.push(bLo++); }
    var suf = 0;
    while (aHi - suf > aLo && bHi - suf > bLo && A[aHi - 1 - suf] === B[bHi - 1 - suf]) suf++;
    aHi -= suf; bHi -= suf;
    if (aLo < aHi && bLo < bHi) {
        var cnt = new Map(), i, j, c;
        for (i = aLo; i < aHi; i++) { c = cnt.get(A[i]); if (!c) { c = { a: 0, b: 0, ai: -1, bi: -1 }; cnt.set(A[i], c); } c.a++; c.ai = i; }
        for (j = bLo; j < bHi; j++) { c = cnt.get(B[j]); if (c) { c.b++; c.bi = j; } }
        var pairs = [];
        for (i = aLo; i < aHi; i++) { c = cnt.get(A[i]); if (c.a === 1 && c.b === 1) pairs.push(c.bi, i); }
        // pairs: [bIndex, aIndex, ...] in increasing aIndex. LIS on bIndex.
        var P = pairs.length / 2;
        if (P) {
            var tails = [], prev = new Int32Array(P), t, lo, hi, mid;
            for (t = 0; t < P; t++) {
                lo = 0; hi = tails.length;
                while (lo < hi) { mid = (lo + hi) >> 1; if (pairs[2 * tails[mid]] < pairs[2 * t]) lo = mid + 1; else hi = mid; }
                prev[t] = lo > 0 ? tails[lo - 1] : -1;
                tails[lo] = t;
            }
            var chain = [];
            for (t = tails[tails.length - 1]; t !== -1; t = prev[t]) chain.push(t);
            chain.reverse();
            var pa = aLo, pb = bLo;
            for (var q = 0; q < chain.length; q++) {
                var ai = pairs[2 * chain[q] + 1], bi = pairs[2 * chain[q]];
                _lineDiffPatience(A, B, pa, ai, pb, bi, mA, mB);
                mA.push(ai); mB.push(bi);
                pa = ai + 1; pb = bi + 1;
            }
            _lineDiffPatience(A, B, pa, aHi, pb, bHi, mA, mB);
        }
    }
    for (var s = 0; s < suf; s++) { mA.push(aHi + s); mB.push(bHi + s); }
}
