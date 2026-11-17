import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { renderDashboard } from '../src/views/dashboard.js';
import { renderDetail } from '../src/views/detail.js';

const ORIGIN = 'https://mt.example.workers.dev';

describe('the dashboard\'s create form can make a tracked link', () => {
  const html = renderDashboard([], 0, 0, 'n');

  test('has an optional link field and asks the worker to track it', () => {
    assert.match(html, /id="inputLink"/);
    assert.match(html, /body\.links\s*=\s*\[/);
  });
  test('shows the tracked URL it gets back, with a copy button', () => {
    assert.match(html, /id="resultLink"/);
    assert.match(html, /id="copyLinkBtn"/);
    assert.match(html, /data\.links\[0\]\.tracked/);
  });
  test('shows the server\'s error instead of a broken result', () => {
    assert.match(html, /id="formError"/);
    assert.match(html, /data\.error/);
  });
});

describe('the detail page shows clicks and tracked links', () => {
  const data = {
    opens: 0, skipped: 0, events: [], filteredEvents: [], recipient: 'bob@example.com', subject: 'S',
    createdAt: '2026-11-01T10:00:00Z', clicks: 3,
    links: ['https://example.com/a', 'https://example.org/b?x=1'],
    clickEvents: [{ time: 't1', ip: '1.1.1.1', link: 0 }, { time: 't2', ip: '2.2.2.2', link: 0 }, { time: 't3', ip: '3.3.3.3', link: 1 }],
  };

  test('a Clicks stat with the total', () => {
    const html = renderDetail('abcdef0123456789', data, 'n', ORIGIN);
    assert.match(html, /stat-label">Clicks<\/div><div class="stat-value[^"]*" id="statClicks">3</);
  });

  test('every link with its own click count and its tracked address', () => {
    const html = renderDetail('abcdef0123456789', data, 'n', ORIGIN);
    assert.match(html, /Tracked links/);
    assert.ok(html.includes('https://example.com/a'));
    assert.ok(html.includes(`${ORIGIN}/c/abcdef0123456789/0`));
    assert.ok(html.includes(`${ORIGIN}/c/abcdef0123456789/1`));
    assert.match(html, /data-link="0"[^>]*>2 clicks</);
    assert.match(html, /data-link="1"[^>]*>1 click</);
  });

  test('a hostile link cannot break out of the page', () => {
    const evil = { ...data, links: ['https://x.example/"><script>alert(1)</script>'], clickEvents: [] };
    const html = renderDetail('abcdef0123456789', evil, 'n', ORIGIN);
    assert.ok(!html.includes('<script>alert(1)</script>'));
    assert.ok(!html.includes('"><script>'));
  });

  test('no links, no panel, and a zero Clicks stat', () => {
    const html = renderDetail('abcdef0123456789', { ...data, links: [], clicks: 0, clickEvents: [] }, 'n', ORIGIN);
    assert.ok(!html.includes('Tracked links'));
    assert.match(html, /id="statClicks">0</);
  });

  test('an older tracker with no click fields still renders', () => {
    const old = { opens: 1, skipped: 0, events: [], filteredEvents: [], recipient: null, subject: '', createdAt: null };
    assert.doesNotThrow(() => renderDetail('abcdef0123456789', old, 'n', ORIGIN));
  });

  test('without an origin the tracked path is still shown', () => {
    const html = renderDetail('abcdef0123456789', data, 'n');
    assert.ok(html.includes('/c/abcdef0123456789/0'));
  });

  test('filtered reasons are labelled, including the new ones', () => {
    const html = renderDetail('abcdef0123456789', data, 'n', ORIGIN);
    assert.match(html, /apple_mpp/);
    assert.match(html, /Too soon after sending/);
  });
});

describe('the dashboard lists mails with clicks and filters', () => {
  const rows = [
    { id: 'a', email: 'a@x.co', subject: 'A', bodyPreview: '', opens: 2, clicks: 1, lastOpen: 'never', createdAt: '2026-11-01T10:00:00Z' },
    { id: 'b', email: 'b@x.co', subject: 'B', bodyPreview: '', opens: 0, clicks: 0, lastOpen: 'never', createdAt: '2026-11-02T10:00:00Z' },
  ];
  const html = renderDashboard(rows, 2, 1, 'n');

  test('filter chips: all, opened, not opened, clicked', () => {
    for (const f of ['all', 'opened', 'pending', 'clicked']) assert.match(html, new RegExp(`data-filter="${f}"`), f);
  });
  test('a card shows its click count', () => {
    assert.match(html, /if \(r\.clicks > 0\) \{[^}]*r\.clicks \+ \(r\.clicks === 1 \? ' click' : ' clicks'\)/);
  });
  test('the clicks total is in the summary', () => {
    assert.match(html, /id="totalClicks"/);
  });
});
