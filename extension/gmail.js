// Gmail content script — auto-injects tracking pixel on Send
// Strategy: Only inject pixels when Send button is clicked

(function () {
  const LOG = '[MailTracker]';
  const { t, uiLocale } = MailTrackerI18n;
  let serverUrl = '';
  let dashboardPassword = '';
  let trackingEnabled = true;
  let learnedSends = []; // Send buttons learned from this user's Gmail, see send-signatures.js

  // Add CSS for read indicators
  const style = document.createElement('style');
  style.textContent = `
    .mail-tracker-status {
      display: inline-block;
      margin-left: 4px;
      font-size: 11px;
      font-weight: bold;
      cursor: help;
      opacity: 0.8;
      transition: opacity 0.2s;
    }
    .mail-tracker-status:hover {
      opacity: 1;
    }
  `;
  document.head.appendChild(style);

  // Cache for tracking data to avoid excessive API calls
  let trackingDataCache = null;
  let lastCacheUpdate = 0;
  const CACHE_DURATION = 5000; // 5 second cache
  let currentView = '';

  // Get tracking data with caching
  async function getTrackingData() {
    const now = Date.now();
    
    console.log(LOG, 'getTrackingData called - cache age:', now - lastCacheUpdate, 'ms');
    
    // Return cached data if still valid
    if (trackingDataCache && (now - lastCacheUpdate) < CACHE_DURATION) {
      console.log(LOG, 'Using cached data, no API call');
      return trackingDataCache;
    }
    
    console.log(LOG, 'Cache expired or empty, making API call...');
    
    try {
      const headers = {};
      if (dashboardPassword) {
        headers['Authorization'] = 'Basic ' + btoa(':' + dashboardPassword);
      }
      
      console.log(LOG, 'Making /list API call');
      const res = await fetch(`${serverUrl}/list`, { headers, signal: AbortSignal.timeout(NEW_PIXEL_TIMEOUT_MS) });
      if (res.ok) {
        trackingDataCache = await res.json();
        lastCacheUpdate = now;
        console.log(LOG, 'API call successful, cached', trackingDataCache.length, 'trackers');
        return trackingDataCache;
      } else {
        console.warn(LOG, 'Failed to fetch tracking data:', res.status);
        return [];
      }
    } catch (e) {
      console.warn(LOG, 'Error fetching tracking data:', e);
      return [];
    }
  }

  // Load settings
  chrome.storage.sync.get(['serverUrl', 'autoTrack'], (result) => {
    serverUrl = result.serverUrl || '';
    trackingEnabled = result.autoTrack !== false;
    console.log(LOG, 'Loaded settings:', { serverUrl: serverUrl ? 'set' : 'empty', trackingEnabled });
  });

  // The password stays in this browser: storage.sync would copy it to every Chrome signed in to the account.
  chrome.storage.local.get(['dashboardPassword', 'sendSignatures'], (r) => {
    dashboardPassword = r.dashboardPassword || '';
    learnedSends = r.sendSignatures || [];
  });

  chrome.storage.onChanged.addListener((changes) => {
    if (changes.serverUrl) serverUrl = changes.serverUrl.newValue || '';
    if (changes.dashboardPassword) dashboardPassword = changes.dashboardPassword.newValue || '';
    if (changes.sendSignatures) learnedSends = changes.sendSignatures.newValue || [];
    if (changes.autoTrack) trackingEnabled = changes.autoTrack.newValue !== false;
  });

  // Extract email addresses from a compose form
  function getRecipients(composeForm) {
    const recipients = new Set();

    // [email] covers span[email]; [data-hovercard-id] catches the chip variant.
    composeForm.querySelectorAll('[email]').forEach(el => {
      const email = el.getAttribute('email');
      if (email && email.includes('@')) recipients.add(email.toLowerCase());
    });

    composeForm.querySelectorAll('[data-hovercard-id]').forEach(el => {
      const email = el.getAttribute('data-hovercard-id');
      if (email && email.includes('@')) recipients.add(email.toLowerCase());
    });

    return Array.from(recipients);
  }

  // Extract email subject and body preview
  function getEmailContent(composeForm) {
    // Try multiple selectors for subject
    const subjectEl = composeForm.querySelector('input[name="subjectbox"]') ||
                     composeForm.querySelector('input[aria-label*="Subject"]') ||
                     composeForm.querySelector('input[placeholder*="Subject"]') ||
                     composeForm.querySelector('[data-tooltip*="Subject"] input');
    
    const subject = subjectEl?.value || '';
    
    // Try multiple selectors for body
    const bodyEl = composeForm.querySelector('[contenteditable="true"][aria-label*="Message"]') ||
                   composeForm.querySelector('[contenteditable="true"][role="textbox"]') ||
                   composeForm.querySelector('.Am.Al.editable') ||
                   composeForm.querySelector('[contenteditable="true"]');
    
    let bodyPreview = '';
    if (bodyEl) {
      const text = bodyEl.innerText || bodyEl.textContent || '';
      // Get first 2 lines, max 200 chars
      const lines = text.split('\n').filter(line => line.trim());
      bodyPreview = lines.slice(0, 2).join(' ').substring(0, 200);
    }
    
    console.log(LOG, 'Extracted content:', { subject, bodyPreview: bodyPreview.substring(0, 50) + '...' });
    return { subject: subject.trim(), bodyPreview: bodyPreview.trim() };
  }

  // Find compose form containing a body element
  function findComposeForm(bodyEl) {
    return bodyEl.closest('[role="dialog"]') || bodyEl.closest('.nH') || bodyEl.closest('form');
  }

  // Find all compose body elements
  function findComposeBodies() {
    return Array.from(document.querySelectorAll('div[contenteditable="true"]'))
      .filter(el => el.closest('[role="dialog"]') || el.closest('.nH'));
  }

  // A hung worker used to swallow the click outright: Send was cancelled and the
  // replacement click only fired once the fetch settled, which never happened.
  const NEW_PIXEL_TIMEOUT_MS = 3000;

  // A mail that leaves untracked looks exactly like a mail nobody has opened, so say so.
  function showTrackingFailure(reason) {
    showBanner(t('bannerNotTracked', [reason]), { kind: 'error' });
  }

  // One banner at a time. `actions` are buttons; ttl 0 keeps it until an action is used.
  function showBanner(text, { kind = 'info', actions = [], ttl = 10000 } = {}) {
    console.warn(LOG, text);
    const old = document.getElementById('mail-tracker-banner');
    if (old) old.remove();
    const el = document.createElement('div');
    el.id = 'mail-tracker-banner';
    el.style.cssText = 'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:2147483647;'
      + `background:${kind === 'error' ? '#b91c1c' : '#1e40af'};color:#fff;padding:10px 16px;border-radius:8px;`
      + 'font:13px sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.4);display:flex;gap:12px;align-items:center;max-width:80vw';
    const msg = document.createElement('span');
    msg.textContent = text;
    el.appendChild(msg);
    for (const a of actions) {
      const b = document.createElement('button');
      b.textContent = a.label;
      b.style.cssText = 'background:#fff;color:#111;border:0;border-radius:6px;padding:4px 10px;font:inherit;cursor:pointer;white-space:nowrap';
      b.addEventListener('click', () => { el.remove(); a.onClick(); });
      el.appendChild(b);
    }
    document.body.appendChild(el);
    if (ttl) setTimeout(() => el.remove(), ttl);
  }

  // One pixel per message. Gmail sends one body to every recipient, so a pixel per
  // recipient would fire for all of them and each tracker would count everyone's opens.
  async function injectTracker(bodyEl, recipients) {
    if (!serverUrl || recipients.length === 0) return;

    const form = findComposeForm(bodyEl);
    const emailContent = getEmailContent(form);
    const contentArea = bodyEl.querySelector('[contenteditable="true"]')
      || bodyEl.querySelector('.Am.Al.editable')
      || bodyEl;

    const headers = { 'Content-Type': 'application/json' };
    if (dashboardPassword) headers['Authorization'] = 'Basic ' + btoa(':' + dashboardPassword);

    let res;
    try {
      res = await fetch(`${serverUrl}/new`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          to: recipients.join(', '),
          subject: emailContent.subject,
          bodyPreview: emailContent.bodyPreview,
          messageId: Date.now() + '-' + Math.random().toString(36).slice(2, 11),
        }),
        signal: AbortSignal.timeout(NEW_PIXEL_TIMEOUT_MS),
      });
    } catch (e) {
      return showTrackingFailure(e.name === 'TimeoutError' ? t('reasonServerSlow') : t('reasonServerUnreachable'));
    }
    if (!res.ok) return showTrackingFailure(t('reasonServerAnswered', [String(res.status)]));
    const data = await res.json();

    const img = document.createElement('img');
    img.src = data.pixel;
    img.width = 1;
    img.height = 1;
    img.style.cssText = 'display:none!important;width:1px!important;height:1px!important;opacity:0!important;position:absolute!important;';
    // The id only: an address in the sent HTML would be readable by every recipient.
    img.setAttribute('data-mail-tracker', data.id);
    contentArea.appendChild(img);
    console.log(LOG, 'Injected tracker', data.id, 'for', recipients.length, 'recipient(s)');
  }

  // Read receipts are drawn rather than typed: the check glyphs rendered
  // inconsistently across platforms, and inline SVG matches how the rest of
  // this project ships icons.
  function makeTicks(double) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', double ? '0 0 20 14' : '0 0 14 14');
    svg.setAttribute('width', double ? '16' : '12');
    svg.setAttribute('height', '11');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    const path = d => {
      const el = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      el.setAttribute('d', d);
      return el;
    };
    svg.appendChild(path('M1 7.5 L5 11.5 L12 2.5'));
    if (double) svg.appendChild(path('M8.5 11 L9 11.5 L18 2.5'));
    return svg;
  }

  // Extract unique identifiers from Gmail thread
  function getEmailIdentifiers(row) {
    // Try to get Gmail's thread ID or message ID
    const threadId = row.querySelector('[data-thread-id]')?.getAttribute('data-thread-id') ||
                    row.querySelector('[data-legacy-thread-id]')?.getAttribute('data-legacy-thread-id');
    
    // Get subject from the email row
    const subjectEl = row.querySelector('.bog span') || row.querySelector('.y6 span');
    const subject = subjectEl?.textContent?.trim() || '';
    
    // Get timestamp
    const timestamp = row.querySelector('span[title]')?.getAttribute('title') || '';
    
    return { threadId, subject, timestamp };
  }

  // Find best matching tracker for an email
  function findMatchingTracker(trackers, email, identifiers) {
    // First try exact subject + recipient match
    let matches = trackers.filter(t => 
      (t.recipient || '').split(', ').includes(email) && 
      t.subject && 
      identifiers.subject.includes(t.subject)
    );
    
    if (matches.length === 1) return matches[0];
    
    // If multiple matches, try to find most recent
    if (matches.length > 1) {
      return matches.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];
    }
    
    // Fallback to any tracker for this recipient (most recent)
    matches = trackers.filter(t => (t.recipient || '').split(', ').includes(email));
    if (matches.length > 0) {
      return matches.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];
    }
    
    return null;
  }
  // Process a compose window — inject pixels for untracked recipients
  async function processCompose(bodyEl) {
    const form = findComposeForm(bodyEl);
    if (!form) {
      console.log(LOG, 'Could not find compose form for body element');
      return;
    }

    const recipients = getRecipients(form);
    if (recipients.length === 0) return;

    if (bodyEl.querySelector('img[data-mail-tracker]')) return; // already tracked

    await injectTracker(bodyEl, recipients);
  }

  // English "Send" is built in; every other language is learned from the user's own
  // Gmail (see send-signatures.js and startLearning below).
  const labelSelector = () => MailTrackerSend.sendSelector(learnedSends);
  const sendButtonIn = container => container.querySelector(labelSelector());
  const sendButtonFrom = el => el.closest(labelSelector());

  // Learn once: swallow the next click on a button inside a compose window and store
  // what Gmail calls it. Mouse down and up are swallowed too, since Gmail's buttons
  // act on them, so nothing is sent.
  let learning = false;
  function startLearning() {
    if (learning) return;
    learning = true;
    showBanner(t('bannerLearnPrompt'), { ttl: 0 });
    const events = ['mousedown', 'mouseup', 'click'];
    const onEvent = (e) => {
      const btn = e.target.closest && e.target.closest('div[role="button"]');
      const compose = btn && findComposeForm(btn);
      if (!compose || !compose.querySelector('div[contenteditable="true"]')) return; // not in a compose window
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.type !== 'click') return;
      const sig = MailTrackerSend.signatureFrom({
        label: btn.getAttribute('aria-label'),
        tooltip: btn.getAttribute('data-tooltip'),
      });
      if (!sig) return;
      events.forEach(ev => window.removeEventListener(ev, onEvent, true));
      learning = false;
      learnedSends = MailTrackerSend.addSignature(learnedSends, sig);
      chrome.storage.local.set({ sendSignatures: learnedSends });
      showBanner(t('bannerLearned', [sig.label || sig.tooltip]), {
        actions: [{
          label: t('actionUndo'),
          onClick: () => {
            learnedSends = MailTrackerSend.removeSignature(learnedSends, sig);
            chrome.storage.local.set({ sendSignatures: learnedSends });
          },
        }],
      });
    };
    events.forEach(ev => window.addEventListener(ev, onEvent, true));
  }

  let isSending = false; // Flag to prevent infinite loop

  // Track the compose being sent (not every open compose or draft), then send it.
  async function trackThenSend(sendButton) {
    isSending = true;
    const form = findComposeForm(sendButton);
    const bodies = findComposeBodies().filter(b => !form || findComposeForm(b) === form);

    // Whatever happens to the pixel, the mail still has to go out.
    try {
      for (const body of bodies) await processCompose(body);
    } catch (err) {
      showTrackingFailure(err.message);
    }

    setTimeout(() => {
      sendButton.click();
      setTimeout(() => { isSending = false; }, 1000);
    }, 100);
  }

  // A compose window whose Send button we cannot match (another interface language, or
  // Gmail changed its markup) would otherwise send every mail untracked and say nothing.
  let warnedSend = false;
  function checkSendRecognised() {
    if (warnedSend || !trackingEnabled || !serverUrl) return;
    const body = document.querySelector('[role="dialog"] div[contenteditable="true"]');
    const dialog = body && body.closest('[role="dialog"]');
    if (dialog && !sendButtonIn(dialog)) {
      warnedSend = true;
      console.warn(LOG, 'Send button not recognised. lang =', document.documentElement.lang, 'buttons:',
        Array.from(dialog.querySelectorAll('div[role="button"]')).slice(0, 15)
          .map(b => ({ label: b.getAttribute('aria-label'), tip: b.getAttribute('data-tooltip'), cls: b.className })));
      showBanner(t('bannerSendNotRecognised'), {
        kind: 'error',
        ttl: 0,
        actions: [{ label: t('actionLearnSend'), onClick: startLearning }],
      });
    }
  }

  function setupSendInterception() {
    document.addEventListener('click', (e) => {
      if (!trackingEnabled || !serverUrl || isSending) return;
      const target = sendButtonFrom(e.target);
      if (!target) return;

      console.log(LOG, 'Send button clicked - checking for untracked recipients');
      e.stopPropagation();
      e.preventDefault();
      trackThenSend(target);
    }, true); // Use capture phase to intercept before Gmail

    // Ctrl/Cmd+Enter sends without a click, which used to skip tracking silently.
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || !(e.ctrlKey || e.metaKey)) return;
      if (!trackingEnabled || !serverUrl || isSending) return;
      // Compose windows are dialogs. The looser findComposeForm() fallback can match
      // the whole page, and Ctrl+Enter in the search box must never send a draft.
      const dialog = e.target.closest('[role="dialog"]');
      const button = dialog && sendButtonIn(dialog);
      if (!button) {
        // Typing in an inline reply: Gmail will send it, and we cannot track it from here.
        if (e.target.closest('[contenteditable="true"]')) showTrackingFailure(t('reasonInlineCtrlEnter'));
        return;
      }

      e.stopPropagation();
      e.preventDefault();
      trackThenSend(button);
    }, true);
  }

  // Add read indicators to sent emails in inbox view
  async function addInboxReadIndicators() {
    if (!serverUrl || !dashboardPassword) return;
    
    console.log(LOG, 'addInboxReadIndicators called');
    
    // First, remove all existing indicators to prevent duplicates
    document.querySelectorAll('.mail-tracker-status').forEach(el => el.remove());
    console.log(LOG, 'Cleared existing indicators');
    
    // Fetch tracking data ONCE before processing emails
    const trackers = await getTrackingData();
    console.log(LOG, 'Got', trackers.length, 'trackers for processing');
    
    // Sent rows put a localised prefix ("To:", "À :", ...) in front of the recipients, while an
    // inbox row starts straight with the sender's name. Gmail's rows can still be the inbox's for a
    // moment after the hash changes to #sent, so test for "some prefix" instead of the English word.
    const sentRows = document.querySelectorAll('tr[role="row"]');
    console.log(LOG, 'Found', sentRows.length, 'email rows');
    
    sentRows.forEach((row, index) => {
      const toField = row.querySelector('.yW');
      const firstRecipient = toField && toField.querySelector('span[email]');
      if (!firstRecipient || toField.textContent.indexOf(firstRecipient.textContent) < 1) return;
      
      const emailSpan = toField.querySelector('span[email]');
      if (!emailSpan) return; // Remove the duplicate check since we cleared all indicators above
      
      const email = emailSpan.getAttribute('email');
      console.log(LOG, 'Processing row', index, 'for email:', email);
      
      // Get email identifiers for better matching
      const identifiers = getEmailIdentifiers(row);
      console.log(LOG, 'Email identifiers:', identifiers);
      
      // Find the best matching tracker for this specific email
      const tracker = findMatchingTracker(trackers, email, identifiers);
      
      // Only add indicator if email was tracked
      if (!tracker) {
        console.log(LOG, 'Email', email, 'not tracked, skipping');
        return;
      }
      
      console.log(LOG, 'Found tracked email to:', email);
      
      // Create status indicator
      const statusEl = document.createElement('span');
      statusEl.className = 'mail-tracker-status';
      statusEl.style.cssText = 'margin-left: 6px; font-size: 11px; color: #5f6368; cursor: help; font-weight: bold;';
      
      if (tracker.opens > 0) {
        statusEl.replaceChildren(makeTicks(true));
        statusEl.style.color = '#1a73e8'; // Blue for read
        
        const lastOpen = tracker.lastOpen ? new Date(tracker.lastOpen).toLocaleString(uiLocale(), {
          hour: 'numeric',
          minute: '2-digit',
          month: 'short',
          day: 'numeric'
        }) : t('indicatorNever');
        
        const opened = tracker.opens === 1 ? t('indicatorOpenedOne') : t('indicatorOpenedMany', [String(tracker.opens)]);
        statusEl.title = `${opened}\n${t('indicatorLastOpened', [lastOpen])}`;
      } else {
        statusEl.replaceChildren(makeTicks(false));
        statusEl.title = t('indicatorUnopened');
      }
      
      // Insert after email span
      emailSpan.parentNode.insertBefore(statusEl, emailSpan.nextSibling);
      console.log(LOG, 'Added indicator for tracked email:', email);
    });
  }

  // ---- Self-view detection ----
  // When the sender opens a thread containing tracked pixels, notify the worker
  // so it can filter out the self-open (Gmail proxy fires /t/:id around the same time)

  const SELF_VIEW_DELAY_MS = 1000;


  function isThreadView() {
    // Gmail thread URLs look like #inbox/FMfcg... or #sent/FMfcg... or #label/FMfcg...
    const hash = location.hash;
    // Thread views have a second path segment (the thread ID)
    const parts = hash.replace('#', '').split('/');
    return parts.length >= 2 && parts[1].length > 5;
  }

  // Find tracker pixel IDs directly from <img> tags in the thread DOM
  // Gmail proxies images like: https://ci3.googleusercontent.com/meips/...#https://mail-tracker.xxx.workers.dev/t/8bdcb976
  // The actual pixel URL is after the # fragment
  function findPixelIdsInThread() {
    const ids = new Set();
    if (!serverUrl) return [];

    // Extract the host from our server URL to avoid matching other sites' /t/ paths
    const serverHost = new URL(serverUrl).host;

    document.querySelectorAll('img').forEach(img => {
      const src = img.src || img.getAttribute('src') || '';
      // Only match if src contains our server host
      if (!src.includes(serverHost)) return;
      // 8 chars covers trackers created before IDs were widened to 16.
      const match = src.match(/\/t\/([a-f0-9]{8,32})\b/);
      if (match) ids.add(match[1]);
    });

    // Also check data attributes set during injection (before Gmail proxied them)
    document.querySelectorAll('img[data-mail-tracker]').forEach(img => {
      ids.add(img.getAttribute('data-mail-tracker'));
    });

    return Array.from(ids);
  }

  async function notifySelfView(ids) {
    if (!serverUrl || ids.length === 0) return;
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (dashboardPassword) {
        headers['Authorization'] = 'Basic ' + btoa(':' + dashboardPassword);
      }
      console.log(LOG, `[self-view] POST /self — ids:`, ids);
      const res = await fetch(`${serverUrl}/self`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ ids }),
      });
      if (res.ok) {
        const data = await res.json();
        console.log(LOG, '[self-view] response:', JSON.stringify(data));
      } else {
        console.warn(LOG, `[self-view] server returned ${res.status}`);
      }
    } catch (e) {
      console.warn(LOG, `[self-view] error:`, e.message);
    }
  }

  let selfViewTimer = null;

  async function checkSelfView() {
    if (!serverUrl || !isThreadView()) return;

    const ids = findPixelIdsInThread();
    console.log(LOG, `[self-view] found ${ids.length} pixel(s) in thread:`, ids);

    if (ids.length === 0) return;

    // Cancel any existing pending call
    if (selfViewTimer) {
      clearTimeout(selfViewTimer);
      selfViewTimer = null;
    }

    selfViewTimer = setTimeout(async () => {
      await notifySelfView(ids);
      selfViewTimer = null;
    }, SELF_VIEW_DELAY_MS);
  }

  function cancelPendingSelfViews() {
    if (selfViewTimer) {
      console.log(LOG, '[self-view] cancelling pending self-view call (user left thread)');
      clearTimeout(selfViewTimer);
      selfViewTimer = null;
    }
  }

  // Initialize tracking
  if (window.location.hostname === 'mail.google.com') {
    console.log(LOG, 'Initializing...');
    setupSendInterception();
    setInterval(checkSendRecognised, 3000);

    // Detect view changes and fetch data only when needed
    let lastUrl = location.href;

    function handleViewChange() {
      const newView = location.hash;
      console.log(LOG, 'URL changed to:', newView);

      // Only process if we're actually changing to sent folder view
      if (newView !== currentView && newView === '#sent') {
        currentView = newView;
        console.log(LOG, 'Entered sent folder, loading indicators');
        // Clear cache on view change to force fresh data
        trackingDataCache = null;
        setTimeout(() => addInboxReadIndicators(), 1000);
      } else if (newView !== currentView) {
        currentView = newView;
        console.log(LOG, 'Changed to:', currentView, '- not sent folder, skipping');
      }

      // Self-view detection: check if user opened a thread with tracked pixels
      if (isThreadView()) {
        console.log(LOG, '[self-view] thread view detected, will check for tracked pixels');
        // Small delay to let Gmail render the thread content
        setTimeout(() => checkSelfView(), 800);
      } else {
        // User left a thread view — cancel any pending self-view calls
        cancelPendingSelfViews();
      }
    }

    // Initial load
    if (location.hash === '#sent') {
      handleViewChange();
    }
    // Also check if we loaded directly into a thread
    if (isThreadView()) {
      setTimeout(() => checkSelfView(), 1500);
    }

    // Watch for URL changes with polling instead of MutationObserver
    setInterval(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        handleViewChange();
      }
    }, 1000);
  }

})();
