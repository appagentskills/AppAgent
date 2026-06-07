# attachment — sc_attachment file upload  ⚠️ CHARACTERIZED — drive via API, not the UI

**Status:** the on-form control is **not drivable** through `iframe_tool` (it opens the native OS file chooser) — use the **Attachment API**. Variable type: **Attachment (33)**.

**Characterized on** a live Employee Center catalog item form (`/esc?id=sc_cat_item&sys_id=<item_sys_id>`) with an Attachment (`sc_attachment`) variable.

## What the variable renders (scope to the variable container!)

Under the variable container `#<varname>`:

| Node | Selector | Markup |
|---|---|---|
| Hidden file input | `#<varname> input[type="file"]` | `<input type="file" ng-file-select="onAttachmentSelect($files)" class="ng-hide" ng-show="false" aria-hidden="true">` (1 match within the container) |
| Upload button | `#sp_formfield_<varname> button` | label **"Upload"** (glyphicon-upload), `ng-click="openAttachmentSelector($event)"`, `aria-label^="Upload Attachment"` — equiv `button[aria-label^="Upload Attachment"]` |

> ⚠️ **The button is "Upload", not "Add attachments".** The visible **"Add attachments / Choose a file or drag it here" dropzone** at the bottom of the item is a **separate page-level SP attachment widget**, *not* this variable. Page-wide `input[type="file"]` returns **2** matches (the variable's hidden input **+** the page widget's). **Always scope to `#<varname>` / `#sp_formfield_<varname>`** or you'll drive the wrong control.

## Why the UI control is not drivable

`openAttachmentSelector($event)` triggers the **native OS file chooser** (outside the page's reach) and `input[type=file].files` is **read-only**, so you cannot inject a `File` programmatically through this control. There is no reliable `iframe_tool` path to attach a file via the rendered widget.

## Recommended route — Attachment API

Attach server-side once the target (or temp) record exists, sidestepping the file chooser entirely:

```javascript
await executeTool("servicenow_api", {
  method:"POST", table:"attachment", scope:"global",
  attachment_data:        "<base64 or data: URL>",
  attachment_file_name:   "foo.png",
  attachment_table_name:  "<table>",      // e.g. the resulting sc_req_item after submit, or the temp record
  attachment_table_sys_id:"<sys_id>"
});
```

- **Pre-submit** on SP catalog, attachments bind to `formModel._attachmentGUID` (falls back to `formModel.sys_id`); for a **submitted** request, attach to the resulting `sc_req_item` / `sc_request` sys_id.
- Only bother with the UI control if an attachment is **required for form validity before submit** (rare) — and even then the native picker blocks automation.

## Gotchas (verified)

- **Two `input[type=file]` on the page** — scope to the variable container `#<varname>`; the unscoped second match is the page-level SP attachment dropzone, not the variable.
- **The button says "Upload"** (`aria-label^="Upload Attachment"`), not "Add attachments".
- **`input.files` is read-only + native picker** ⇒ no programmatic UI upload; use the Attachment API.

---
*Characterized on a live Employee Center Attachment variable:* the variable control is a hidden `ng-file-select` input + an "Upload" button (`openAttachmentSelector`) scoped under `#<varname>`; the native picker is not automatable, so attach via the Attachment API. A second, page-level SP attachment widget is the visible "Add attachments" dropzone — do not confuse the two.
