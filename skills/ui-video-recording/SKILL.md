---
name: ui-video-recording
description: Record a WebM video of the agent driving a browser tab (demos, bug repros, UI test evidence, walkthroughs). Screenshot loop → canvas → MediaRecorder inside one js_eval, saved to Agent Files under recordings/, shown in a player widget with a download button. Ships a reusable startRecording() helper (recorder.md). Use when the user asks to record / film / screencast / make a video of a UI flow.
---

# ui-video-recording — record a WebM of the agent driving a browser tab

Use when the user wants a **video** of a UI flow (demo, bug repro, test evidence, walkthrough). Output: a `.webm` in **Agent Files → `recordings/<name>.webm`** plus a player widget with a download button.

> **Recordings are always saved to Agent Files (folder `virtual`) under `recordings/`** — e.g. `recordings/github-releases.webm`. Always tell the user that path.

> There is **no native screen recording**: `getDisplayMedia` is blocked in the js_eval sandbox ("display-capture disallowed by permissions policy"). The recipe below builds a video from a fast screenshot loop instead. Verified live: **~1.79 fps, 0 errors**.

## How it works
1. Capture loop: `take_screenshot({target:"browser", tab_id, fast:true})`, **awaited sequentially**. Each frame is decoded right away (`new Image()` from `r.base64`) and drawn on a canvas (letterboxed).
2. `canvas.captureStream(30)` → `MediaRecorder` (`video/webm;codecs=vp9`, 0.8 Mbps default ≈ 6 MB/min, 150 s auto-stop).
3. A 100 ms ticker repaints a **REC overlay** (blinking red dot, elapsed time, step label), so the video plays at real speed even though frames arrive at ~1.8 fps.
4. The driving actions (`iframe_tool` navigate / scroll / click / fill) run **in the same js_eval**, concurrently with the loop.
5. Stop: loop flag false → await loop → one final `take_screenshot({..., fast:true, restore_tab:true})` (switches back to the user's original tab) → `rec.stop()` → Blob → data URL → `local_folder write {path:"recordings/<name>.webm", base64}`.

`fast:true` (PRs #1336/#1338/#1340) stays on the target tab instead of switching back after every shot, captures JPEG, and does lightweight post-processing; the result carries `fast_mode {fast, switched, format, restored_tab_ids, timing_ms{…}}`. Without `fast` each shot takes ~1.25 s (≈0.7 fps).

## The helper: `recorder.md`
`startRecording({tab_id, width=1280, height=737, label, title="REC", bitrate=8e5, stream_fps=30, max_duration_ms=150000})` → handle:
- `setLabel(text)` — change the step label in the overlay.
- `stop({save_path, folder="virtual", restore_tab=true})` → stats `{duration_s, frames, fps, gap_median_ms, gap_max_ms, errors, error_samples, size_bytes, mime, width, height, saved:{path, folder, ok, file_id, download_url}}`. Also sets `handle.blob`. Call it **exactly once, in a `finally`**, so the capture loop stops and the user's tab is restored even when a driving step throws.
- `isRunning()` — false after the `max_duration_ms` safety auto-stop (keeps you under the js_eval timeout; still call `stop()` to save).

The helper ships as `recorder.md` (a single fenced javascript code block) rather than `.js`, because `*.js` files in a skill are built as agent tools — and this helper must run *inside your* js_eval, concurrently with the driving. **Load it inside js_eval:**
```javascript
const f = await executeTool("get_skill", {action: "read_file", skill_id: "ui-video-recording", filename: "recorder.md"});
const code = f.content.split("```javascript")[1].split("```")[0];
const startRecording = new Function("executeTool", "sleep", code + "\nreturn startRecording;")(executeTool, sleep);
```
Alternatively paste the `startRecording` function from `recorder.md` into the js_eval body. It needs `executeTool`, `document` (canvas), `MediaRecorder`, `Image`, `FileReader` — all present in js_eval.

## Worked example — browsing GitHub Releases
Run with `timeout_ms: 300000`. Return stats only (never base64).
```javascript
const f = await executeTool("get_skill", {action: "read_file", skill_id: "ui-video-recording", filename: "recorder.md"});
const code = f.content.split("```javascript")[1].split("```")[0];
const startRecording = new Function("executeTool", "sleep", code + "\nreturn startRecording;")(executeTool, sleep);

const nav = await executeTool("iframe_tool", {action: "navigate", url: "https://github.com/microsoft/vscode/releases", wait: true, tab_id: "new"});
const TAB = nav.tab_id;
const ift = a => executeTool("iframe_tool", Object.assign({tab_id: TAB}, a));

const rec = await startRecording({tab_id: TAB, label: "Releases list"});
let stats, driveError = null;
try {
  await sleep(1500);
  for (let s = 1; s <= 5; s++) {               // y is ABSOLUTE → increase it
    rec.setLabel("Scrolling " + s + "/5");
    await ift({action: "scroll", y: s * 300});
    await sleep(1200);
  }
  rec.setLabel("Open latest release");
  await ift({action: "navigate", url: "https://github.com/microsoft/vscode/releases/latest", wait: true});
  await sleep(2500);
  rec.setLabel("Tags page");
  await ift({action: "navigate", url: "https://github.com/microsoft/vscode/tags", wait: true});
  await sleep(2500);
} catch (e) {
  driveError = String((e && e.message) || e);
} finally {
  // Always stop: ends the capture loop, restores the user's tab, saves what was recorded.
  stats = await rec.stop({save_path: "recordings/github-releases.webm"});
}
return Object.assign(stats, {drive_error: driveError});   // {duration_s, frames, fps, ..., size_bytes, saved:{path, file_id, download_url}}
```
Report: duration, frames, fps, median/max gap, errors, file size, and the Agent Files path `recordings/<name>.webm`.

## Player widget (with download button)
Show the result in an `html_widget`. The player loads the bytes by **`file_id`** (`stats.saved.file_id`) via `get_file`, falling back to `local_folder read`. **Both are capped at 25 MB**: the recording's `file_id` is an Agent Files folder pointer, which `get_file` resolves by reading the file's bytes (same 25 MB read limit as `local_folder read`). For clips over 25 MB skip the player and hand the user the download link instead — `stats.saved.download_url` or `local_folder share {path}` (Download button, served via `file-download.html`, no size cap). The data URL is converted to a Blob, and `URL.createObjectURL(blob)` is used both as the `<video>` src and as the `<a download>` href; the Agent Files path is displayed. Replace `NAME` and `FILE_ID` (or `""`):
```html
<div style="font-family:var(--font-family,system-ui);color:var(--text-primary);padding:var(--space-8,8px)">
  <video id="v" controls style="width:100%;border-radius:var(--radius-md,6px);background:#000"></video>
  <div style="display:flex;gap:8px;align-items:center;margin-top:8px;flex-wrap:wrap">
    <a id="dl" download="NAME.webm" style="pointer-events:none;opacity:.5;padding:6px 12px;border-radius:var(--radius-md,6px);background:var(--primary);color:#fff;text-decoration:none">⬇ Download NAME.webm</a>
    <span style="color:var(--text-secondary);font-size:12px">Agent Files: <code>recordings/NAME.webm</code></span>
    <span id="st" style="font-size:12px"></span>
  </div>
</div>
<script>
(async function () {
  var st = document.getElementById("st");
  try {
    st.textContent = "Loading…";
    var FILE_ID = "FILE_ID", dataUrl = null, r = null;
    if (FILE_ID) { try { dataUrl = (await executeTool("get_file", {id: FILE_ID})).data; } catch (e) {} }   // <= 25 MB too (folder pointer -> byte read)
    if (!dataUrl) {
      r = await executeTool("local_folder", {action: "read", path: "recordings/NAME.webm", encoding: "base64"});   // <= 25 MB
      dataUrl = r.data_url;
      if (!dataUrl && r.file_id) dataUrl = (await executeTool("get_file", {id: r.file_id})).data;   // over the inline limit
    }
    if (!dataUrl) throw new Error((r && r.error) || "recording not found (over 25 MB? use local_folder share for a download button)");
    var blob = await (await fetch(dataUrl)).blob();
    var url = URL.createObjectURL(new Blob([blob], {type: "video/webm"}));
    document.getElementById("v").src = url;
    var a = document.getElementById("dl"); a.href = url; a.style.pointerEvents = ""; a.style.opacity = "";
    st.textContent = (blob.size / 1048576).toFixed(2) + " MB";
  } catch (e) { st.textContent = "Error: " + e.message; st.style.color = "var(--error,#d33)"; }
})();
</script>
```
(If you already have a `file_id`, `get_file({id}).data` gives the same data URL.)

## Limits
- Chrome `captureVisibleTab` allows **max 2 calls/s**; the fast path enforces 510 ms spacing → **~1.8 fps** is the practical max. Don't add sleeps in the capture loop.
- Screenshots must be **sequential** (await each). Parallel bursts → `MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND` quota errors (the helper backs off 600 ms after an error).
- Fast mode **brings the target tab to the front and keeps it there** until `restore_tab` — the user's tab is hidden while recording. `stop()` restores it (pass `restore_tab:false` to skip).
- Size: bytes ≈ bitrate/8 × seconds (nominal; static pages encode smaller, but VP9 can overshoot the target on busy frames). 0.8 Mbps (default) ≈ **6 MB/min**; 3 Mbps ≈ **22 MB/min**. Both `get_file` (folder-pointer file_ids read the bytes) and `local_folder read` refuse files over **25 MB**, so keep `bitrate × duration` well under 25 MB (default 0.8 Mbps × 150 s ≈ 15 MB, leaving overshoot margin). Raise the bitrate only for short clips; for anything over 25 MB use `stats.saved.download_url` / `local_folder share {path}` (no size cap) instead of the player.

## Gotchas
- `iframe_tool scroll` `y` is an **absolute** position — use increasing `y` (`s*300`), not a constant.
- Screenshot ids can disappear from the store ("File not found") — decode frames **immediately** and keep them in memory; never stitch later from ids (the helper does this).
- Use `timeout_ms: 300000` on the js_eval.
- Keep the js_eval return value small (stats only, never base64).
- Draw only the newest frame; drop out-of-order frames (the helper tracks a sequence number).
- `tab_id` is required (no fallback). Never record/navigate the agent's own tab.
- Recorder + driving must run in **one js_eval** — the recorder lives in that sandbox's memory and dies with it.
