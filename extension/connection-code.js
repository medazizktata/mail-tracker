// Reads the connection code that the worker's /connect page shows: "mt1." plus the worker's
// origin and password, base64url-encoded. One paste replaces typing a URL and a password.
//
// The code decides where the extension sends mail details (recipients, subjects), so decoding is
// strict: https only (plain http just for this machine), an origin and nothing else, no
// credentials, a password with no control characters. Anything else returns null.
//
// Loaded in the popup as a classic script, so it publishes onto globalThis.
(function (root) {
  const PREFIX = 'mt1.';
  const MAX_LENGTH = 2048;

  const looksLikeCode = s => typeof s === 'string' && s.trim().startsWith(PREFIX);

  function fromBase64Url(s) {
    const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
    return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bin, c => c.charCodeAt(0)));
  }

  function decode(code) {
    if (!looksLikeCode(code)) return null;
    const raw = code.trim();
    if (raw.length > MAX_LENGTH) return null;

    let data;
    try { data = JSON.parse(fromBase64Url(raw.slice(PREFIX.length))); } catch { return null; }
    if (!data || typeof data.u !== 'string' || typeof data.p !== 'string') return null;

    let u;
    try { u = new URL(data.u); } catch { return null; }
    const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
    if (!(u.protocol === 'https:' || (u.protocol === 'http:' && local))) return null;
    if (u.username || u.password || u.search || u.hash || u.pathname !== '/') return null;

    if (!data.p.length || data.p.length > 256 || /[\u0000-\u001f\u007f]/.test(data.p)) return null;
    return { url: u.origin, password: data.p };
  }

  root.MailTrackerConnect = { PREFIX, looksLikeCode, decode };
})(globalThis);
