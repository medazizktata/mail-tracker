# Notice

Mail Tracker is licensed under the GNU Affero General Public License v3 (see [LICENSE](LICENSE)).
This copy is a **modified version**.

## Provenance

| | |
|---|---|
| Original | [samrathreddy/mail-tracker](https://github.com/samrathreddy/mail-tracker) |
| Hardened fork this work builds on | [xinshoutw/mail-tracker](https://github.com/xinshoutw/mail-tracker) |
| This copy | [medazizktata/mail-tracker](https://github.com/medazizktata/mail-tracker), branch `main` |

The history of all three is kept in this repository's git log; every commit carries its author and date.

## Changes in this copy (from 2026-11-17)

- Worker: per-tracker hit cap and 90-day expiry; one tracker may label several recipients; `/self` writes only
  when it changes something; the detail page's Delete works.
- Extension: one pixel per message and no addresses in the sent HTML; a visible banner when a message goes
  out untracked; Ctrl/Cmd+Enter is tracked; the password stays in `chrome.storage.local`; https-only server URL.
- Send button found automatically from the shape of Gmail's shortcut label (works in any Gmail language), with a
  learn-once fallback; all extension text in `_locales` (English, French); sent-list ticks matched on subject
  and retried until the Sent rows appear.
- One-step Cloudflare setup: a Deploy to Cloudflare button (the KV binding has no id, so Cloudflare creates the
  storage), `pnpm run setup` (wrangler's own login, deploy, random password), and a `/connect` page whose one code
  the extension takes in a single paste.
- Tests: unit tests for the worker and the extension's pure logic, plus guards on the extension's packaging,
  permissions and network use.
- `wrangler.toml` is a placeholder; it no longer names another person's Cloudflare account.

## What has not been verified

The extension's page-touching code has no automated tests. The French text is an unreviewed draft.
