import { CORS_HEADERS, DEDUP_WINDOW_MS, MAX_HITS_PER_TRACKER, json, isBot, checkAuth, requireAuth, servePixel, html, putTracker, trackerMeta, encodeConnectionCode, isApplePrefetch, validLinks, validAccount, constantTimeEqual } from './shared.js';
import { sendWebhookNotifications } from './notifications.js';
import { SESSION_SECONDS, signSession, readSession, cookieName, sessionCookie, clearedCookie, cookieValue, safeNext } from './session.js';
import { renderLogin } from './views/login.js';
import { renderDetail } from './views/detail.js';
import { renderDashboard } from './views/dashboard.js';
import { renderConnect } from './views/connect.js';

const SELF_VIEW_WINDOW_MS = 5_000;

// 8 hex chars was 32 bits: a ~50% chance of a silent overwriting collision by
// ~77k trackers, and cheap to enumerate. 16 hex chars is 64 bits.
const ID_LENGTH = 16;

// Keys the worker owns. They share the tracker namespace, so listings must skip
// them or they show up in the dashboard as phantom trackers.
const INTERNAL_PREFIX = '__';
const PENDING_PREFIX = '__pending__:';
const PENDING_TTL_S = 3600;
// Set whenever an open is queued, so scheduled() can rule out an empty queue
// with a get() instead of a list(). The free plan allows 100,000 reads a day
// but only 1,000 lists, and the cron fires on schedule whether or not anyone
// sent an email — listing unconditionally cost 1,440 lists a day at rest, over
// the daily limit before a single email was tracked, which took / and /list
// down with it because they list() too.
const QUEUE_HINT = '__queued__';
// Recent genuine opens, served by /feed. The extension used to poll /list every
// five minutes, and /list enumerates the namespace — 288 list operations a day
// out of 1,000. One key it can get() instead costs a read out of 100,000. The
// cron writes it once per drain, so an idle mailbox writes nothing at all.
const FEED_KEY = '__feed__';
const FEED_LIMIT = 50;
const WEBHOOK_GRACE_MS = 10_000;
// ponytail: 10 webhooks a minute is plenty for one mailbox and keeps the cron
// inside the free plan's 50-subrequest budget. Raise it with the plan if the
// queue ever backs up.
const MAX_PENDING_PER_RUN = 10;
const MAX_TRACKERS = 1000;
const MAX_LEGACY_READS = 20;
const MAX_SELF_VIEW_IDS = 50;

// Scanners follow every link the moment a mail arrives, and a sender's reopened draft loads the pixel at once;
// no reader does either within seconds of the send.
const TOO_FAST_MS = 10_000;

/**
 * Record a click, or file it as not-a-reader. Never throws: the caller redirects regardless, because
 * the person clicking must reach their destination whatever happens to our storage.
 */
async function recordClick(env, id, existing, link, request) {
  try {
    if ((existing.opens || 0) + (existing.skipped || 0) + (existing.clicks || 0) >= MAX_HITS_PER_TRACKER) return;
    const ip = request.headers.get('cf-connecting-ip') || 'unknown';
    const nowMs = Date.now();
    const event = {
      time: new Date(nowMs).toISOString(), ip, link,
      country: request.headers.get('cf-ipcountry') || 'unknown',
      userAgent: request.headers.get('user-agent') || 'unknown',
    };
    let reason = null;
    if (existing.senderIp && existing.senderIp === ip) reason = 'sender_ip';
    else if (isBot(event.userAgent)) reason = 'bot_proxy';
    else if (nowMs - new Date(existing.createdAt).getTime() < TOO_FAST_MS) reason = 'too_fast';

    if (reason) {
      if (isRepeatHit(existing.filteredEvents || [], ip, nowMs)) return;
      existing.skipped = (existing.skipped || 0) + 1;
      existing.filteredEvents = [...(existing.filteredEvents || []), { ...event, reason }].slice(-20);
    } else {
      if (isRepeatHit(existing.clickEvents || [], ip, nowMs)) return;
      existing.clicks = (existing.clicks || 0) + 1;
      existing.clickEvents = [...(existing.clickEvents || []), event].slice(-100);
    }
    await putTracker(env, id, existing);
  } catch (e) {
    console.log(`[click] id=${id} not recorded: ${e && e.message}`);
  }
}

/**
 * A repeat hit from the same IP inside the dedup window. /t/:id is
 * unauthenticated, and the sender-IP and bot branches used to write to KV on
 * every single request, so anyone holding a pixel URL could drive unbounded
 * writes just by resending with a scanner's User-Agent.
 */
function isRepeatHit(events, ip, nowMs) {
  const last = events.length ? events[events.length - 1] : null;
  return !!last && last.ip === ip && nowMs - new Date(last.time).getTime() < DEDUP_WINDOW_MS;
}

// One subrequest per 1000 trackers instead of one per tracker. Records written
// before metadata existed still need a read, capped so an old namespace cannot
// blow the subrequest budget on its own.
async function listTrackers(env) {
  const out = [];
  let legacyReads = 0;
  let cursor;

  do {
    const page = await env.TRACKER.list({ cursor });
    for (const key of page.keys) {
      if (key.name.startsWith(INTERNAL_PREFIX)) continue;

      let meta = key.metadata;
      if (!meta && legacyReads < MAX_LEGACY_READS) {
        legacyReads++;
        const data = await env.TRACKER.get(key.name, 'json');
        if (data) meta = trackerMeta(data);
      }
      out.push({ id: key.name, ...(meta || {}) });
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor && out.length < MAX_TRACKERS);

  return out;
}

const secureCookie = url => url.protocol === 'https:';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const noStore = { 'Cache-Control': 'no-store' };

/** 'ok' (Basic password, or a valid session cookie), 'cross-site' (a cookie used to write from another site), or 'none'. */
async function authenticate(request, env, url) {
  if (checkAuth(request, env)) return 'ok';
  if (!env.DASHBOARD_PASSWORD) return 'none';
  const token = cookieValue(request.headers.get('Cookie'), cookieName(secureCookie(url)));
  if (!(await readSession(token, env.DASHBOARD_PASSWORD, Math.floor(Date.now() / 1000)))) return 'none';
  // SameSite=Strict already keeps the cookie off cross-site requests; this refuses a write that arrives
  // without our own Origin anyway. Basic-auth callers (the extension) never reach it.
  if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && request.headers.get('Origin') !== url.origin) return 'cross-site';
  return 'ok';
}

// A page load sends Sec-Fetch-Mode: navigate (or at least asks for HTML); API calls do not.
const wantsPage = request => request.method === 'GET'
  && (request.headers.get('Sec-Fetch-Mode') === 'navigate' || /\btext\/html\b/.test(request.headers.get('Accept') || ''));

/** null when the caller may go on, otherwise the response to return. */
async function gate(request, env, url, { page = false, cors = false } = {}) {
  const who = await authenticate(request, env, url);
  if (who === 'ok') return null;
  if (who === 'cross-site') return json({ error: 'Cross-site request refused' }, 403);
  if (page && env.DASHBOARD_PASSWORD && wantsPage(request)) {
    return new Response(null, { status: 303, headers: { Location: `/login?next=${encodeURIComponent(safeNext(url.pathname))}`, ...noStore } });
  }
  return requireAuth(env, cors ? CORS_HEADERS : {});
}

async function handleLogin(request, env, url) {
  if (!env.DASHBOARD_PASSWORD) return requireAuth(env); // 503: never a way in without a password
  if (request.method === 'GET') {
    const next = safeNext(url.searchParams.get('next'));
    if ((await authenticate(request, env, url)) === 'ok') return new Response(null, { status: 303, headers: { Location: next, ...noStore } });
    const nonce = crypto.randomUUID();
    return html(renderLogin({ next, nonce }), nonce, noStore, { formAction: true });
  }
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, POST' } });
  if (request.headers.get('Origin') && request.headers.get('Origin') !== url.origin) return new Response('Forbidden', { status: 403 });

  const text = await request.text();
  const form = new URLSearchParams(text.length <= 2000 ? text : '');
  const password = form.get('password') || '';
  const next = safeNext(form.get('next'));
  if (password && constantTimeEqual(password, env.DASHBOARD_PASSWORD)) {
    const token = await signSession(env.DASHBOARD_PASSWORD, Math.floor(Date.now() / 1000) + SESSION_SECONDS);
    return new Response(null, { status: 303, headers: { Location: next, 'Set-Cookie': sessionCookie(token, secureCookie(url)), ...noStore } });
  }
  await sleep(Number(env.LOGIN_FAIL_DELAY_MS ?? 600)); // makes guessing slow without any state to keep
  const nonce = crypto.randomUUID();
  return html(renderLogin({ error: 'That password is incorrect.', next, nonce }), nonce, noStore, { status: 401, formAction: true });
}

function handleLogout(request, url) {
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: { Allow: 'POST' } });
  if (request.headers.get('Origin') && request.headers.get('Origin') !== url.origin) return new Response('Forbidden', { status: 403 });
  return new Response(null, { status: 303, headers: { Location: '/login', 'Set-Cookie': clearedCookie(secureCookie(url)), ...noStore } });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    // /login and /logout: the browser's way in. The extension and curl keep using Basic auth.
    if (url.pathname === '/login') return handleLogin(request, env, url);
    if (url.pathname === '/logout') return handleLogout(request, url);

    // POST /self — extension signals sender viewed a thread (batch: multiple pixel IDs)
    // Called AFTER opens have been recorded, so we retroactively reclassify.
    if (url.pathname === '/self' && request.method === 'POST') {
      { const denied = await gate(request, env, url, { cors: true }); if (denied) return denied; }

      let ids;
      try {
        const body = await request.json();
        ids = body.ids;
        if (!Array.isArray(ids) || ids.length === 0) return json({ error: 'ids must be a non-empty array' }, 400);
        // Each id costs a KV read plus a write; an unbounded batch would run
        // straight into the subrequest limit.
        if (ids.length > MAX_SELF_VIEW_IDS) return json({ error: `At most ${MAX_SELF_VIEW_IDS} ids per call` }, 400);
      } catch (e) {
        return json({ error: 'Invalid JSON body' }, 400);
      }

      const now = Date.now();
      const nowIso = new Date(now).toISOString();
      const cutoff = now - SELF_VIEW_WINDOW_MS;
      const results = [];
      let totalReclassified = 0;

      for (const id of ids) {
        const existing = await env.TRACKER.get(id, 'json');
        if (!existing) {
          results.push({ id, status: 'not_found' });
          continue;
        }

        let reclassified = 0;
        let relabelled = 0;
        const keptEvents = [];
        existing.filteredEvents = existing.filteredEvents || [];

        // Reclassify recent genuine opens as self-view
        for (const event of existing.events) {
          const eventTime = new Date(event.time).getTime();
          if (eventTime >= cutoff) {
            existing.filteredEvents.push({ ...event, reason: 'self_view', reclassifiedAt: nowIso });
            reclassified++;
          } else {
            keptEvents.push(event);
          }
        }

        // Also relabel recent bot_proxy filtered events as self_view
        // (Gmail's GoogleImageProxy fires when sender opens their own thread)
        for (const event of existing.filteredEvents) {
          const eventTime = new Date(event.time).getTime();
          if (eventTime >= cutoff && event.reason === 'bot_proxy') {
            event.reason = 'self_view';
            event.reclassifiedAt = nowIso;
            relabelled++;
          }
        }

        if (reclassified > 0) {
          existing.events = keptEvents;
          existing.opens = Math.max(0, existing.opens - reclassified);
          existing.skipped = (existing.skipped || 0) + reclassified;
        }

        // Nothing changed: do not write the record back. KV is eventually consistent, so a record
        // read here can be older than one just written from another location, and writing it back
        // would overwrite the newer one.
        if (reclassified === 0 && relabelled === 0) {
          results.push({ id, reclassified: 0, opensNow: existing.opens });
          continue;
        }

        if (existing.filteredEvents.length > 20) existing.filteredEvents = existing.filteredEvents.slice(-20);
        await putTracker(env, id, existing);
        console.log(`[self-view] id=${id} reclassified=${reclassified} opens_now=${existing.opens}`);

        totalReclassified += reclassified;
        results.push({ id, reclassified, opensNow: existing.opens });
      }

      console.log(`[self-view] batch: ${ids.length} trackers, ${totalReclassified} total reclassified`);
      return json({ ok: true, totalReclassified, results });
    }

    // GET /t/:id — track pixel open
    if (url.pathname.startsWith('/t/')) {
      const id = url.pathname.slice('/t/'.length);
      if (!id || id.startsWith(INTERNAL_PREFIX)) return new Response('Missing id', { status: 400 });

      const existing = await env.TRACKER.get(id, 'json');
      if (!existing) return servePixel();

      // Bound the writes an unauthenticated URL can cause. /self moves opens into
      // skipped, so their sum only ever grows.
      if ((existing.opens || 0) + (existing.skipped || 0) >= MAX_HITS_PER_TRACKER) return servePixel();

      const ip = request.headers.get('cf-connecting-ip') || 'unknown';
      const country = request.headers.get('cf-ipcountry') || 'unknown';
      const userAgent = request.headers.get('user-agent') || 'unknown';
      const now = new Date().toISOString();
      const nowMs = new Date(now).getTime();

      // Filter 1: Sender IP exclusion
      if (existing.senderIp && existing.senderIp === ip) {
        if (isRepeatHit(existing.filteredEvents || [], ip, nowMs)) return servePixel();
        existing.skipped = (existing.skipped || 0) + 1;
        existing.filteredEvents = existing.filteredEvents || [];
        existing.filteredEvents.push({ time: now, ip, reason: 'sender_ip' });
        if (existing.filteredEvents.length > 20) existing.filteredEvents = existing.filteredEvents.slice(-20);
        await putTracker(env, id, existing);
        console.log(`[open] id=${id} SKIPPED reason=sender_ip ip=${ip}`);
        return servePixel();
      }

      // Filter 1b: Apple Mail Privacy Protection. Its proxy loads the image at delivery, not at reading,
      // so the hit is filed, not counted. COUNT_APPLE_PREFETCH=1 counts it anyway.
      if (!env.COUNT_APPLE_PREFETCH && isApplePrefetch(ip)) {
        if (isRepeatHit(existing.filteredEvents || [], ip, nowMs)) return servePixel();
        existing.skipped = (existing.skipped || 0) + 1;
        existing.filteredEvents = [...(existing.filteredEvents || []), { time: now, ip, userAgent, reason: 'apple_mpp' }].slice(-20);
        await putTracker(env, id, existing);
        console.log(`[open] id=${id} SKIPPED reason=apple_mpp ip=${ip}`);
        return servePixel();
      }

      // Filter 2: Bot/proxy detection
      if (isBot(userAgent)) {
        if (isRepeatHit(existing.filteredEvents || [], ip, nowMs)) return servePixel();
        existing.skipped = (existing.skipped || 0) + 1;
        existing.filteredEvents = existing.filteredEvents || [];
        existing.filteredEvents.push({ time: now, ip, userAgent, reason: 'bot_proxy' });
        if (existing.filteredEvents.length > 20) existing.filteredEvents = existing.filteredEvents.slice(-20);
        await putTracker(env, id, existing);
        console.log(`[open] id=${id} SKIPPED reason=bot_proxy ua=${userAgent}`);
        return servePixel();
      }

      // Filter 2b: too soon after sending. A reader cannot open a mail seconds after it left; what loads
      // the pixel then is the sender's own draft (Undo reopens it and Gmail's image proxy fetches the
      // pixel) or a delivery scanner. Gmail's proxy cannot be filtered by name, so use the time.
      if (nowMs - new Date(existing.createdAt).getTime() < TOO_FAST_MS) {
        if (isRepeatHit(existing.filteredEvents || [], ip, nowMs)) return servePixel();
        existing.skipped = (existing.skipped || 0) + 1;
        existing.filteredEvents = [...(existing.filteredEvents || []), { time: now, ip, userAgent, reason: 'too_fast' }].slice(-20);
        await putTracker(env, id, existing);
        console.log(`[open] id=${id} SKIPPED reason=too_fast ip=${ip}`);
        return servePixel();
      }

      // Filter 3: Dedup window (same IP within 5s)
      if (isRepeatHit(existing.events, ip, nowMs)) {
        console.log(`[open] id=${id} SKIPPED reason=dedup ip=${ip}`);
        return servePixel();
      }

      // Record the open — extension will retroactively reclassify if it was a self-view
      existing.opens += 1;
      existing.events.push({ time: now, ip, country, userAgent });
      if (existing.events.length > 100) existing.events = existing.events.slice(-100);
      await putTracker(env, id, existing);

      console.log(`[open] id=${id} RECORDED opens=${existing.opens} ip=${ip} country=${country} ua=${userAgent}`);

      // Queue the webhook under its own key. Appending to one shared key meant a
      // read-modify-write per open: KV caps writes at one per second per key, and
      // concurrent opens silently overwrote each other's entries. The TTL keeps an
      // abandoned queue from growing without bound if the cron trigger is missing.
      await Promise.all([
        env.TRACKER.put(
          `${PENDING_PREFIX}${nowMs}:${id}`,
          JSON.stringify({ id, time: now, ip, country, recipient: existing.recipient, subject: existing.subject }),
          { expirationTtl: PENDING_TTL_S },
        ),
        // KV reads are eventually consistent, so the cron may not see this for a
        // firing or two. The entry stays queued until it does, so the webhook is
        // delayed, never dropped. The TTL matches the entries it stands for.
        env.TRACKER.put(QUEUE_HINT, '1', { expirationTtl: PENDING_TTL_S }),
      ]);

      return servePixel();
    }

    // GET /c/:id/:n — a tracked link. The destination is the n-th link stored on the tracker, never
    // anything from the request, so this cannot be used as an open redirect.
    const click = url.pathname.match(/^\/c\/([0-9a-f]{8,32})\/(0|[1-9]\d?)$/);
    if (click && (request.method === 'GET' || request.method === 'HEAD')) {
      const id = click[1];
      const n = Number(click[2]);
      const existing = await env.TRACKER.get(id, 'json');
      const target = existing && Array.isArray(existing.links) ? existing.links[n] : undefined;
      if (!target) return new Response('Not found', { status: 404 });
      if (request.method === 'GET') await recordClick(env, id, existing, n, request); // HEAD is a scanner's
      return new Response(null, {
        status: 302,
        headers: {
          Location: target,
          'Cache-Control': 'no-store',
          'Referrer-Policy': 'no-referrer',
          'X-Robots-Tag': 'noindex',
        },
      });
    }

    // GET /s/:id — stats for a tracking pixel
    if (url.pathname.startsWith('/s/')) {
      { const denied = await gate(request, env, url, { page: url.searchParams.get('format') !== 'json' }); if (denied) return denied; }

      const id = url.pathname.slice('/s/'.length);
      if (!id || id.startsWith(INTERNAL_PREFIX)) return new Response('Missing id', { status: 400 });

      const data = await env.TRACKER.get(id, 'json');
      if (!data) return new Response('Tracker not found', { status: 404 });

      const acceptsJson = request.headers.get('accept')?.includes('application/json');
      const formatJson = url.searchParams.get('format') === 'json';

      if (acceptsJson || formatJson) {
        const { senderIp, ...safeData } = data;
        return json({ ...safeData, recipient: data.recipient || null, hasSenderProtection: !!senderIp });
      }

      const nonce = crypto.randomUUID();
      return html(renderDetail(id, data, nonce, url.origin), nonce);
    }

    // POST /new — create a new tracking pixel
    if (url.pathname === '/new') {
      { const denied = await gate(request, env, url, { cors: true }); if (denied) return denied; }
      // State changes are POST/DELETE only. A GET can be fired from any page
      // with an <img> tag, and browsers attach cached Basic credentials to it.
      if (request.method !== 'POST') return json({ error: 'Use POST' }, 405);

      const id = crypto.randomUUID().replace(/-/g, '').slice(0, ID_LENGTH);
      const senderIp = request.headers.get('cf-connecting-ip') || 'unknown';

      let recipient = null, subject = '', bodyPreview = '', messageId = '', links = [], account = '';
      try {
        const body = await request.json();
        recipient = body.to || null;
        subject = body.subject || '';
        bodyPreview = body.bodyPreview || '';
        messageId = body.messageId || '';
        account = validAccount(body.account);
        if (body.links !== undefined) {
          if (!Array.isArray(body.links)) return json({ error: 'links must be an array' }, 400);
          links = validLinks(body.links);
        }
      } catch (e) {
        return json({ error: 'Invalid JSON body' }, 400);
      }

      // One pixel per message, so a message to several people is one tracker
      // labelled with all of them (separate pixels in one body all fire for every
      // recipient and make each tracker count everyone's opens).
      const EMAIL = /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/;
      if (recipient && (recipient.length > 500 || !recipient.split(',').every(a => EMAIL.test(a.trim())))) {
        return json({ error: 'Invalid email format' }, 400);
      }
      if (subject.length > 500 || bodyPreview.length > 1000) return json({ error: 'Input too long' }, 400);

      await putTracker(env, id, {
        opens: 0, events: [], filteredEvents: [], skipped: 0,
        senderIp, recipient, subject, bodyPreview, messageId, links, account,
        createdAt: new Date().toISOString(),
      });

      const base = url.origin;
      return json({
        id, pixel: `${base}/t/${id}`,
        html: `<img src="${base}/t/${id}" width="1" height="1" style="display:none" />`,
        stats: `${base}/s/${id}`, recipient, subject, bodyPreview,
        links: links.map((u, index) => ({ index, url: u, tracked: `${base}/c/${id}/${index}` })),
      });
    }

    // GET /feed — recent opens for the extension's background poll. Deliberately
    // one get() of one key: see FEED_KEY. The opener's IP is left out, since a
    // desktop notification has no use for it.
    if (url.pathname === '/feed') {
      { const denied = await gate(request, env, url, { cors: true }); if (denied) return denied; }
      return json({ opens: (await env.TRACKER.get(FEED_KEY, 'json')) || [] });
    }

    // GET /list — JSON API for extension
    if (url.pathname === '/list') {
      { const denied = await gate(request, env, url, { cors: true }); if (denied) return denied; }

      const trackers = await listTrackers(env);
      return json(trackers.map(t => ({
        id: t.id, opens: t.opens || 0, skipped: t.skipped || 0, clicks: t.clicks || 0,
        recipient: t.recipient || null, subject: t.subject || '',
        bodyPreview: t.bodyPreview || '', messageId: t.messageId || '', account: t.account || '',
        createdAt: t.createdAt || null, lastOpen: t.lastOpen || null,
      })));
    }

    // DELETE /d/:id — delete a tracking pixel
    if (url.pathname.startsWith('/d/')) {
      { const denied = await gate(request, env, url, { cors: true }); if (denied) return denied; }
      // Was a GET: <img src="https://tracker/d/:id"> on any page deleted a
      // tracker, since the browser attached the owner's cached credentials.
      if (request.method !== 'DELETE') return json({ error: 'Use DELETE' }, 405);
      const id = url.pathname.slice('/d/'.length);
      if (!id || id.startsWith(INTERNAL_PREFIX)) return json({ error: 'Missing id' }, 400);
      await env.TRACKER.delete(id);
      return json({ deleted: id });
    }

    // GET /connect — the code that connects the extension. It contains the password, so it needs
    // the password to see, and it must never be cached.
    if (url.pathname === '/connect' && request.method === 'GET') {
      { const denied = await gate(request, env, url, { page: true }); if (denied) return denied; }
      const nonce = crypto.randomUUID();
      return html(renderConnect(encodeConnectionCode(url.origin, env.DASHBOARD_PASSWORD), nonce), nonce, { 'Cache-Control': 'no-store' });
    }

    // GET / — dashboard
    if (url.pathname === '/') {
      { const denied = await gate(request, env, url, { page: true }); if (denied) return denied; }

      const results = (await listTrackers(env)).map(t => ({
        id: t.id, email: t.recipient || t.id,
        subject: t.subject || '', bodyPreview: t.bodyPreview || '',
        opens: t.opens || 0, clicks: t.clicks || 0,
        lastOpen: t.lastOpen || 'never',
        createdAt: t.createdAt || null,
      }));

      results.sort((a, b) => {
        if (!a.createdAt) return 1;
        if (!b.createdAt) return -1;
        return new Date(b.createdAt) - new Date(a.createdAt);
      });

      const totalOpens = results.reduce((s, r) => s + r.opens, 0);
      const activeCount = results.filter(r => r.opens > 0).length;

      const nonce = crypto.randomUUID();
      return html(renderDashboard(results, totalOpens, activeCount, nonce), nonce);
    }

    return new Response('Not found', { status: 404 });
  },

  async scheduled(event, env) {
    // Nearly every firing finds an empty queue. Spend a read to establish that,
    // not a list — see QUEUE_HINT.
    if (!(await env.TRACKER.get(QUEUE_HINT))) return;

    const { keys } = await env.TRACKER.list({ prefix: PENDING_PREFIX, limit: MAX_PENDING_PER_RUN });
    if (!keys.length) {
      await env.TRACKER.delete(QUEUE_HINT);
      return;
    }

    const now = Date.now();
    const drained = [];

    for (const key of keys) {
      const item = await env.TRACKER.get(key.name, 'json');
      if (!item) continue;

      // Too young — leave it queued so /self still has time to reclassify it.
      if (now - new Date(item.time).getTime() < WEBHOOK_GRACE_MS) continue;

      await env.TRACKER.delete(key.name);

      const tracker = await env.TRACKER.get(item.id, 'json');
      if (!tracker) continue;

      const stillGenuine = (tracker.events || []).some(e => e.time === item.time && e.ip === item.ip);
      if (!stillGenuine) {
        console.log(`[cron] id=${item.id} open was reclassified, skipping webhook`);
        continue;
      }

      const open = {
        id: item.id,
        recipient: item.recipient,
        subject: item.subject,
        opens: tracker.opens,
        country: item.country,
        time: item.time,
      };
      await sendWebhookNotifications(env, { ...open, ip: item.ip });
      drained.push(open);
      console.log(`[cron] id=${item.id} webhook sent for genuine open`);
    }

    // One write per drain, not per open, so a burst cannot trip the 1 write/sec
    // limit KV enforces on a single key.
    if (drained.length) {
      const feed = (await env.TRACKER.get(FEED_KEY, 'json')) || [];
      await env.TRACKER.put(FEED_KEY, JSON.stringify([...feed, ...drained].slice(-FEED_LIMIT)));
    }
  },
};
