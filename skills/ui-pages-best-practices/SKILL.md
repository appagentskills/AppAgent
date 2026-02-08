---
name: ui-pages-best-practices
description: A comprehensive guide for working with ServiceNow UI Pages, including best practices, patterns, and common pitfalls to avoid. Use when creating or editing UI Pages.
---

## Overview
UI Pages in ServiceNow are custom web pages that can be created using HTML, CSS, and JavaScript. They provide a flexible way to create custom user interfaces.

## Key Rules

1. **Avoid using Jelly at all cost** - Jelly is hard to debug as it does not have separation of concern between client and server.

2. **Avoid using GlideAjax** - GlideAjax needs a backend Script Include that is client callable, which has security considerations.

3. **Never use `<script>` tags in HTML** - All JavaScript code must go in the client_script field, not inline in the HTML section.

4. **Prefer the Table API** - The Table API respects user data access.

5. **Always use X-UserToken header for API calls** - All Table API requests must include `'X-UserToken': window.sessionToken` for authentication.

6. **Always test the UI page at the end** - After making changes, test the UI page to verify it works correctly. See [testing_ui_pages.md](testing_ui_pages.md) for the testing guide.

7. **Do not use the `processing_script` field** - The `processing_script` field on UI Pages runs server-side Jelly/Java code. Avoid it entirely; use the Table API for any server interaction instead.

8. **Always close all HTML elements** - Every HTML element must be properly closed, including void/self-closing elements. Use the self-closing slash syntax for elements like `<input>`, `<br>`, `<hr>`, `<img>`, etc.
   ```html
   <!-- Bad -->
   <input type="text" class="filter-input" id="filter-search" placeholder="Search...">
   <br>
   <img src="icon.png">

   <!-- Good -->
   <input type="text" class="filter-input" id="filter-search" placeholder="Search..."/>
   <br/>
   <img src="icon.png"/>
   ```

9. **Turn on ECMAScript 2021 (ES12) mode** - Enable modern JavaScript syntax (`async/await`, `const/let`, arrow functions, optional chaining, nullish coalescing) in the client script. ES12 is controlled via the `sys_es_latest_script` table, not the `sys_ui_page` table directly. First, use `servicenow_api` to query `sys_es_latest_script` with `table=sys_ui_page` and `id=<UI Page sys_id>` to check if a record already exists. If it exists, update `use_es_latest` to `true`. If it does not exist, create a new record with the following structure:
   ```xml
   <sys_es_latest_script action="INSERT_OR_UPDATE">
       <id>{UI Page sys_id}</id>
       <table>sys_ui_page</table>
       <use_es_latest>true</use_es_latest>
   </sys_es_latest_script>
   ```

10. **Enable the Direct flag for better debugging** - The `direct` field on the `sys_ui_page` record renders the UI Page without the ServiceNow navigation frame, making it easier to debug with browser developer tools. Use `servicenow_api` to set `direct` to `true` on the UI Page record. Once debugging is complete, revert `direct` back to what it was before the change.

11. **Always give explicit values to HTML attributes** - Even for boolean attributes, always provide an explicit value rather than using the shorthand form.
   ```html
   <!-- Bad -->
   <input type="checkbox" checked disabled>
   <select>
       <option selected>Choose one</option>
   </select>
   <button hidden>Click</button>

   <!-- Good -->
   <input type="checkbox" checked="true" disabled="true"/>
   <select>
       <option selected="selected">Choose one</option>
   </select>
   <button hidden="true">Click</button>
   ```

12. **UI Page not loading with empty html body** - If a UI Page does not load or displays with an empty body, there may be an issue with ServiceNow parsing the HTML content. Common causes include invalid Jelly syntax, unescaped XML entities (like `&times;` instead of `&#215;`), improperly closed tags, or escaped HTML tags appearing in the content (like `&lt;script&gt;&lt;/script&gt;`). The Table API returns HTTP 200 even when validation fails silently. Use `servicenow_api` to GET the record back and compare the `html` field in the response with what you sent - if they differ, the content was not saved due to a parsing error.

13. **Avoid `${...}` template literals in client_script** - Jelly interprets `${...}` syntax before the JavaScript reaches the browser, causing errors or unexpected behavior.
   ```javascript
   // Bad - Jelly will try to evaluate this
   const url = `/api/now/table/incident/${sysId}`;
   const msg = `Hello ${name}`;

   // Good - use string concatenation
   const url = '/api/now/table/incident/' + sysId;
   const msg = 'Hello ' + name;
   ```

14. **Avoid HTML comments `<!-- -->` in the HTML field** - Jelly processes comments and certain content inside them can cause parsing failures or unexpected behavior.

15. **Escape angle brackets `<` and `>` in JavaScript comparisons** - The XML parser may misinterpret these as tag delimiters, causing parsing errors.
   ```javascript
   // May break - parser sees < and > as tag markers
   if (a < b && c > d)

   // Safer - rearrange comparisons to avoid <
   if (b > a && d < c)
   ```


## Table API Examples

```javascript
// GET - Fetch records
async function getRecords() {
    window.sessionToken = "$[gs.getSessionToken()]";
    const response = await fetch('/api/now/table/incident?sysparm_limit=10', {
        headers: {
            'Accept': 'application/json',
            'X-UserToken': window.sessionToken
        }
    });
    const data = await response.json();
    return data.result;
}

// POST - Create a record
async function createRecord(fields) {
    window.sessionToken = "$[gs.getSessionToken()]";
    const response = await fetch('/api/now/table/incident', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'X-UserToken': window.sessionToken
        },
        body: JSON.stringify(fields)
    });
    return await response.json();
}

// PUT - Update a record
async function updateRecord(sysId, fields) {
    window.sessionToken = "$[gs.getSessionToken()]";
    const response = await fetch('/api/now/table/incident/' + sysId, {
        method: 'PUT',
        headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'X-UserToken': window.sessionToken
        },
        body: JSON.stringify(fields)
    });
    return await response.json();
}
```