# Privacy Policy — AppAgent for ServiceNow

**Last updated:** March 27, 2026

## Data Collection

AppAgent for ServiceNow does **not** collect, transmit, or store any personal data on external servers. All user data remains on the user's device.

## What Is Stored Locally

The extension stores the following data locally in your browser using Chrome's storage API:

- **ServiceNow session token and instance URL** — used to authenticate with your ServiceNow instance.
- **Claude OAuth credentials** — used to authenticate with the Anthropic API on your behalf.
- **Chat history and settings** — stored in your browser's IndexedDB.

This data never leaves your browser except when sent directly to the services you have configured (your ServiceNow instance or the AI API provider you choose).

## Third-Party Services

The extension communicates with:

- **Your ServiceNow instance** — the URL you connect to, using your existing session.
- **AI API providers** — only the provider you configure (e.g., Anthropic, OpenRouter). API keys are entered by you and stored locally.

No data is sent to the extension developer or any analytics service.

## Permissions

The extension requests broad permissions (`<all_urls>`, `tabs`, `scripting`) because ServiceNow instances run on customer-specific domains that cannot be known in advance. These permissions are used solely to interact with ServiceNow pages you visit.

## Contact

If you have questions about this privacy policy, open an issue at: https://github.com/appagentskills/AppAgent/issues
