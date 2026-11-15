# recorder — `startRecording()` helper for ui-video-recording

Shipped as `.md` (not `.js`) on purpose: `*.js` files in `skills/<name>/` are built as **agent tools** (TOOL_DEFINITION format), and this helper is not a tool — it must run *inside* the caller's js_eval, concurrently with the driving actions. Load it with the snippet in SKILL.md (extracts the single fenced javascript code block below and evaluates it with `new Function`).

```javascript
/* ui-video-recording / startRecording — WebM recorder for a browser tab, driven from js_eval.
 * API:   const rec = await startRecording({tab_id, width:1280, height:737, label:"Step 1"});
 *        rec.setLabel("Step 2"); ... const stats = await rec.stop({save_path:"recordings/demo.webm"});
 */
async function startRecording(opts) {
  opts = opts || {};
  var tab_id = opts.tab_id;
  if (tab_id == null || tab_id === "") throw new Error("startRecording: tab_id is required");
  var W = opts.width || 1280, H = opts.height || 737;
  var STREAM_FPS = opts.stream_fps || 30;
  // Size budget: bytes ~= bitrate/8 * seconds (nominal; VP9 can overshoot).
  // 0.8 Mbps ~= 6 MB/min, so the 150 s default cap is ~15 MB nominal — well
  // under the 25 MB read cap shared by get_file and local_folder read, with
  // margin for overshoot. (3 Mbps ~= 22.5 MB/min would blow past it in ~65 s.)
  var BITRATE = opts.bitrate || 800000;
  var MAX_MS = opts.max_duration_ms || 150000;        // safety auto-stop of the capture loop (stay under js_eval timeout + size budget)
  var TITLE = opts.title || "REC";
  var label = opts.label || "";
  var _sleep = (typeof sleep === "function") ? sleep : function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  var _exec = (typeof executeTool === "function") ? executeTool : opts.executeTool;
  if (typeof _exec !== "function") throw new Error("startRecording: executeTool not available");

  var canvas = document.createElement("canvas");
  canvas.width = W; canvas.height = H;
  var ctx = canvas.getContext("2d");
  var mime = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"].filter(function (m) {
    return MediaRecorder.isTypeSupported(m);
  })[0];
  if (!mime) throw new Error("startRecording: no supported WebM mime type");
  var stream = canvas.captureStream(STREAM_FPS);
  var rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: BITRATE });
  var chunks = [];
  rec.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };

  var t0 = performance.now();
  var lastImg = null, lastSeq = -1, seq = 0;
  var frames = 0, gaps = [], lastFrameAt = null, errors = [], errorCount = 0;
  var running = true, stopped = false;

  function fmt(ms) {
    var s = ms / 1000, m = Math.floor(s / 60);
    return (m < 10 ? "0" : "") + m + ":" + ((s % 60) < 10 ? "0" : "") + (s % 60).toFixed(1);
  }
  function paint() {
    ctx.fillStyle = "#000"; ctx.fillRect(0, 0, W, H);
    if (lastImg) {
      var iw = lastImg.naturalWidth || lastImg.width, ih = lastImg.naturalHeight || lastImg.height;
      var k = Math.min(W / iw, H / ih), dw = iw * k, dh = ih * k;
      ctx.drawImage(lastImg, (W - dw) / 2, (H - dh) / 2, dw, dh);
    }
    var el = performance.now() - t0;
    var text = TITLE + "  " + fmt(el) + (label ? "  \u00b7  " + label : "");
    ctx.font = "bold 18px system-ui, -apple-system, Segoe UI, sans-serif";
    var tw = ctx.measureText(text).width;
    ctx.fillStyle = "rgba(0,0,0,0.65)"; ctx.fillRect(12, 12, tw + 48, 34);
    if (Math.floor(el / 500) % 2 === 0) {
      ctx.fillStyle = "#e5322d"; ctx.beginPath(); ctx.arc(30, 29, 7, 0, Math.PI * 2); ctx.fill();
    }
    ctx.fillStyle = "#fff"; ctx.textBaseline = "middle"; ctx.fillText(text, 44, 30);
  }

  async function loop() {
    while (running) {
      if (performance.now() - t0 > MAX_MS) { running = false; break; }
      var mySeq = seq++;
      try {
        var r = await _exec("take_screenshot", { target: "browser", tab_id: tab_id, fast: true });
        if (!r || !r.base64) throw new Error((r && (r.error || r.message)) || "take_screenshot returned no base64");
        var img = new Image();
        img.src = r.base64;                       // decode now: screenshot ids can vanish from the store later
        await img.decode();
        if (mySeq > lastSeq) {                    // newest frame only; drop out-of-order frames
          lastSeq = mySeq; lastImg = img; paint(); frames++;
          var now = performance.now();
          if (lastFrameAt != null) gaps.push(now - lastFrameAt);
          lastFrameAt = now;
        }
      } catch (e) {
        errorCount++;
        if (errors.length < 5) errors.push(String((e && e.message) || e).slice(0, 200));
        await _sleep(600);                        // back off (e.g. captureVisibleTab quota)
      }
    }
  }

  paint();
  rec.start(1000);
  var ticker = setInterval(paint, 100);           // keeps the clock moving so the video plays at real speed
  var loopP = loop();

  async function stop(sopts) {
    sopts = sopts || {};
    if (stopped) throw new Error("recording already stopped");   // call stop() exactly once (in a finally)
    stopped = true;
    running = false;
    await loopP;
    if (sopts.restore_tab !== false) {
      try { await _exec("take_screenshot", { target: "browser", tab_id: tab_id, fast: true, restore_tab: true }); }
      catch (e) { errorCount++; if (errors.length < 5) errors.push("restore_tab: " + String((e && e.message) || e).slice(0, 200)); }
    }
    paint();
    await _sleep(250);
    clearInterval(ticker);
    var durationMs = performance.now() - t0;
    await new Promise(function (res) { rec.onstop = res; rec.stop(); });
    stream.getTracks().forEach(function (t) { t.stop(); });
    var blob = new Blob(chunks, { type: "video/webm" });
    handle.blob = blob;
    var sorted = gaps.slice().sort(function (a, b) { return a - b; });
    var stats = {
      duration_s: +(durationMs / 1000).toFixed(2),
      frames: frames,
      fps: +(frames / (durationMs / 1000)).toFixed(2),
      gap_median_ms: sorted.length ? Math.round(sorted[Math.floor(sorted.length / 2)]) : null,
      gap_max_ms: sorted.length ? Math.round(sorted[sorted.length - 1]) : null,
      errors: errorCount,
      error_samples: errors,
      size_bytes: blob.size,
      mime: mime,
      width: W, height: H
    };
    if (sopts.save_path) {
      var dataUrl = await new Promise(function (res, rej) {
        var fr = new FileReader(); fr.onload = function () { res(fr.result); }; fr.onerror = rej; fr.readAsDataURL(blob);
      });
      var w = await _exec("local_folder", { action: "write", folder: sopts.folder || "virtual", path: sopts.save_path, base64: dataUrl });
      stats.saved = { path: sopts.save_path, folder: sopts.folder || "virtual", ok: !!(w && w.success !== false), file_id: (w && w.file_id) || null, download_url: (w && w.download_url) || null };
      if (w && w.success === false) stats.saved.error = String(w.error || "write failed").slice(0, 200);
    }
    return stats;
  }

  var handle = {
    setLabel: function (t) { label = t || ""; paint(); },
    isRunning: function () { return running; },
    stop: stop,
    canvas: canvas,
    blob: null
  };
  return handle;
}
```
