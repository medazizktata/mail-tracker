<div align="center">

# Mail Tracker

[![License](https://img.shields.io/github/license/medazizktata/mail-tracker?style=for-the-badge)](LICENSE)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?style=for-the-badge&logo=cloudflare&logoColor=white)](https://workers.cloudflare.com)
[![Chrome Extension](https://img.shields.io/badge/Chrome-Manifest%20V3-4285F4?style=for-the-badge&logo=googlechrome&logoColor=white)](extension)

Self-hosted email open tracking. Install in five minutes, runs free on Cloudflare.

**English** | [繁體中文](README.zh-TW.md)

> Modified version of the original project.

## Quick start (no config files)

1. Click **Deploy to Cloudflare**, allow access when Cloudflare asks, and choose a password when it asks for `DASHBOARD_PASSWORD`. Cloudflare copies the project to your GitHub, creates the storage and deploys it to your own account.

   [![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/medazizktata/mail-tracker)

   Prefer a terminal? `pnpm install && pnpm run setup` does the same: it opens Cloudflare's "allow" screen, deploys, and picks the password for you.
2. Open `https://<your-worker>.workers.dev/connect`, copy the connection code.
3. In the extension popup, paste it into the first field and click **Save & Connect**.

That is all. The code carries the worker address and the password, so there is nothing else to type. Not verified here: the Deploy to Cloudflare flow itself was not clicked through (it needs your GitHub and Cloudflare logins); `pnpm run setup` was run against a real account.
 See [NOTICE.md](NOTICE.md) for provenance and what changed.

</div>

## Overview

Mail Tracker embeds an invisible 1x1 pixel in the mail you send. When the recipient
opens it, the pixel fires a request and the open is recorded — who, when, from where.

A Chrome extension injects the pixel into Gmail on Send, one per recipient, and shows
read indicators next to sent mail. A Cloudflare Worker serves the pixel, filters the
noise, and stores everything in your own KV namespace. No third party ever sees the data.

### Features

- **Auto-tracking** — the extension injects a pixel per recipient when you press Send
- **Read indicators** — single and double ticks beside recipients in the Gmail sent list
- **Self-open filtering** — opening your own thread does not count as the recipient reading it
- **Notifications** — Chrome, Slack and Discord, sent only once an open survives filtering
- **Self-hosted** — your Cloudflare account, your KV namespace, no vendor in the middle
- **No runtime dependencies** — vanilla JavaScript, no framework, no build step

### How it works

1. You press Send in Gmail. The extension creates one tracker per recipient and drops an
   invisible `<img>` into the body.
2. The recipient opens the mail. Their client fetches the pixel from your Worker.
3. The Worker records IP, country, user agent and time, then runs three filters: sender IP,
   known scanners, and a five-second window against repeat hits.
4. The open is queued for notification rather than announced immediately.
5. If you were the one who opened the thread, the extension tells the Worker to reclassify
   it as a self-view within that window.
6. A cron trigger drains the queue a few seconds later and notifies you about what is left.

The delay in steps 4 to 6 is the point: it is what stops your own reading of a thread from
being reported as the recipient opening your mail.

## Demo

https://github.com/user-attachments/assets/5470a2ce-9076-407d-8961-1ade0ea8329f

<br/>

## Quick Start

### Requirements

- Node 20 or newer
- pnpm
- A Cloudflare account with Workers and KV enabled

### Deploy

```bash
git clone https://github.com/medazizktata/mail-tracker.git
cd mail-tracker
pnpm install

pnpm exec wrangler kv namespace create "TRACKER"   # paste the id into wrangler.toml
pnpm exec wrangler secret put DASHBOARD_PASSWORD   # required
pnpm run deploy
```

> [!IMPORTANT]
> `DASHBOARD_PASSWORD` is not optional. Without it the Worker answers every route with
> `503` rather than leaving your recipients, subjects and opener IPs readable by anyone
> who finds the URL. The tracking endpoint `/t/:id` stays open so mail clients can load
> the pixel.

> [!IMPORTANT]
> `wrangler.toml` must declare the cron trigger. Queued notifications are drained by the
> scheduled handler, so without it no webhook is ever sent.
>
> ```toml
> [triggers]
> crons = ["* * * * *"]
> ```

### Extension

Download the zip from [Releases](https://github.com/medazizktata/mail-tracker/releases),
unzip it, then load it at `chrome://extensions` with Developer mode on and **Load
unpacked**. Open the extension and enter your Worker URL and dashboard password.

### Local development

```bash
pnpm dev     # http://localhost:8787
pnpm test    # node --test, no extra dependencies
```

Put `DASHBOARD_PASSWORD=...` in `.dev.vars` for local runs. The file is gitignored.

<br/>

## Tech Stack

| Area | Choice |
|---|---|
| Runtime | Cloudflare Workers (V8 isolate, no Node APIs) |
| Storage | Cloudflare KV, bound as `TRACKER` |
| Scheduling | Cron trigger, one minute |
| Extension | Chrome Manifest V3, vanilla JS |
| Tests | `node:test` against an in-memory KV stub |
| Deploy | Cloudflare Workers Builds on push to `main` |
| Dependencies | None at runtime; wrangler only for builds |

### Project Structure

```
src/index.js              Worker entry: router, API handlers, cron
src/shared.js             Constants, auth, escaping, pixel, KV metadata
src/notifications.js      Slack and Discord webhook dispatch
src/views/dashboard.js    Listing page (GET /)
src/views/detail.js       Tracker page (GET /s/:id)
extension/manifest.json   Manifest V3
extension/gmail.js        Content script: inject on Send, self-view detection
extension/popup.js        Popup: tracker list, detail, settings
extension/background.js   Service worker: polls for new opens
test/worker.test.js       node --test suite
wrangler.toml             KV binding and cron trigger
```

<br/>

## API

Every route except `/t/:id` uses HTTP Basic auth. The username is ignored; only the
password matters, and it may contain colons.

| Endpoint | Auth | Description |
|---|:---:|---|
| `GET /` | Yes | Dashboard |
| `POST /new` | Yes | Create a tracker from `{ to?, subject?, bodyPreview?, messageId? }` |
| `GET /t/:id` | No | Serve the pixel and record the open |
| `GET /s/:id` | Yes | Tracker page, or stats as JSON with `?format=json` |
| `GET /list` | Yes | All trackers as JSON |
| `GET /feed` | Yes | Recent opens from a single key, for the extension's background poll |
| `POST /self` | Yes | Reclassify recent opens as self-views, `{ ids: [...] }`, max 50 |
| `DELETE /d/:id` | Yes | Delete a tracker |

`/new` and `/d/:id` reject `GET` deliberately: a `GET` can be fired from any page with an
`<img>` tag, and the browser attaches the cached credentials to it.

```bash
curl -u :your-password -X POST -H 'Content-Type: application/json' \
     -d '{"to":"her@example.com","subject":"Hi"}' \
     https://your-worker.workers.dev/new

curl -u :your-password -X DELETE https://your-worker.workers.dev/d/THE_ID
```

<br/>

## Comparison

| | Mail Tracker | Mailtrack | Streak | Superhuman | HubSpot |
|---|---|---|---|---|---|
| Price | Free | $9.99/mo | $49/mo | $30/mo | $45/mo |
| Self-hosted | Yes | No | No | No | No |
| Open source | AGPL-3.0 | No | No | No | No |
| No data collection | Yes | No | No | No | No |
| Read indicators | Yes | Yes | Yes | Yes | No |
| Slack and Discord | Yes | No | No | No | Yes |
| Self-open filtering | Yes | Partial | Partial | Yes | Yes |

<br/>

## Limitations, and what this tracker does about each

Pixel tracking is inference, not certainty. Some limits can be worked around, some only
softened, and some cannot be fixed by any tracker. This table says which is which.

| Limit | What happens | What this tracker does | Status |
|---|---|---|---|
| **Images blocked** (common in corporate Outlook) | The pixel never loads, so no open is recorded. | **Click tracking.** A link still works when images do not. Turn on "Track link clicks" in the popup and links in the mails you send are tracked; or make a tracked link in the dashboard for any email. You only see a click if the recipient clicks. | Softened |
| **Apple Mail Privacy Protection** (iOS 15+, macOS) | Apple's proxy loads every image when the mail is *delivered*, whether or not it is read. | These hits are recognised by Apple's addresses and filed as "Apple Mail prefetch" instead of being counted, so they no longer inflate opens. The cost: a real open by an Apple Mail user is invisible. Set `COUNT_APPLE_PREFETCH=1` on the worker to count them anyway. | Handled (honestly, not defeated) |
| **Gmail image caching** | Gmail's proxy may serve a cached copy, so a repeat open may not reach the worker. | The pixel is sent with every no-cache header. That is all that can be done, so treat **the first open** as the reliable signal and use clicks for repeat engagement. In one real test a recipient's open arrived six minutes after the sender's own view, so caching did not hide it, but that is one observation, not a guarantee. | Cannot be fixed |
| **Opening a tracked mail outside the extension** | The extension hides your own views of a sent mail in desktop Gmail. A view on your phone, in another client, or in a browser without the extension looks like a recipient's open. | Your own direct loads from the address you send from are filtered. Install the extension in every browser where you read your sent mail. Views through Gmail's proxy on a device without the extension cannot be told apart. | Not solved |
| **Gmail plain-text mode** | The pixel is stripped when the message is sent, so there is no open signal. | **Not detected.** Tried in real Gmail: the extension still creates a tracker and shows no warning, because Gmail's plain-text compose looks the same in the page as the rich one. Leave plain-text mode off (it is a per-account setting Gmail remembers), or use a tracked link. | Not solved |
| **Plain-text clients** (other mail programs) | A pixel needs HTML; the extension only runs in Gmail on the web. | Make a tracked link in the dashboard and paste it into the email, or paste the pixel snippet into any client that sends HTML. | Softened |

### Click tracking, in practice

- Clicks are filed, not counted, when they come from your own address, from a link scanner,
  or within ten seconds of sending (scanners follow links the moment a mail arrives).
- A tracked link redirects only to a link you stored. The destination is never read from the
  request, so it cannot be used as an open redirect.
- It is **off by default** in the extension. Recipients see your worker's address when they
  hover a link, and rewritten links can affect deliverability. Turn it on per browser in the popup.

### A note on privacy

Pixels and tracked links record the reader's address, country and mail program. Some
regulators treat that like a cookie (France's CNIL, according to law-firm summaries that
were not checked against its text). If you send to people in such places, tell them.

<br/>

## Documentation

| File | Contents |
|---|---|
| [`docs/SETUP.md`](docs/SETUP.md) | Full deployment walkthrough, extension install, usage |
| [`docs/COST.md`](docs/COST.md) | Cloudflare free tier limits and real-world cost estimates |
| [`PASSWORD_SETUP.md`](PASSWORD_SETUP.md) | The three ways to set the dashboard password |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | How to propose changes |
| [`CLAUDE.md`](CLAUDE.md) | Architecture notes and conventions for contributors and agents |

### Deployment and CI

| Pipeline | Runs on | Trigger |
|---|---|---|
| Worker deploy | Cloudflare Workers Builds | push to `main` |
| Tests and build check | GitHub Actions, `ci.yml` | push, pull request, manual |
| Extension release | GitHub Actions, `release-extension.yml` | pushing a `v*` tag |

Releasing the extension means bumping `extension/manifest.json` and pushing a matching
tag. The job refuses to publish when the two disagree.

```bash
git tag v1.2.0 && git push origin main v1.2.0
```

<br/>

## Contributing

Issues and pull requests are welcome. Run `pnpm test` before opening one; CI runs the
same suite plus a dry-run build of the Worker.

## License

[AGPL-3.0](LICENSE). Section 13 applies to network use: deploy a modified copy where
other people can reach it and you have to offer them its source.
