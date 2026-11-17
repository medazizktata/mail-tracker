// Browser sessions for the dashboard. Stateless on purpose: a KV-backed session would be read from another
// data centre right after sign-in, and KV can lag by a minute there, bouncing the user back to the form.
// The cookie is an expiry plus an HMAC of it, keyed by the dashboard password, so changing the password
// signs every browser out. Trade-off: a stolen cookie can be tested against password guesses offline, which
// is why the setup script generates a long random password.
import { constantTimeEqual } from './shared.js';

export const SESSION_SECONDS = 14 * 24 * 3600;

const enc = new TextEncoder();
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');

async function mac(password, message) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, enc.encode(message)));
}

export async function signSession(password, expiresAtSeconds) {
  return `v1.${expiresAtSeconds}.${await mac(password, `session.v1.${expiresAtSeconds}`)}`;
}

export async function readSession(token, password, nowSeconds) {
  if (!password || typeof token !== 'string') return false;
  const m = /^v1\.(\d{1,12})\.([0-9a-f]{64})$/.exec(token);
  if (!m) return false;
  const expires = Number(m[1]);
  if (expires < nowSeconds) return false;
  return constantTimeEqual(m[2], await mac(password, `session.v1.${expires}`));
}

// "__Host-" makes the browser refuse the cookie unless it is Secure, on the exact host, with Path=/. It needs
// https, so local development over plain http gets a plain name instead.
export const cookieName = secure => (secure ? '__Host-mt_session' : 'mt_session');

const flags = secure => `Path=/; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`;
export const sessionCookie = (token, secure) => `${cookieName(secure)}=${token}; Max-Age=${SESSION_SECONDS}; ${flags(secure)}`;
export const clearedCookie = secure => `${cookieName(secure)}=; Max-Age=0; ${flags(secure)}`;

export function cookieValue(header, name) {
  for (const part of String(header || '').split(';')) {
    const piece = part.trim();
    if (piece.startsWith(name + '=')) return piece.slice(name.length + 1);
  }
  return '';
}

// Where sign-in may send you on. Not a general redirect: only pages this site has for a person, so a crafted
// link can neither leave the site nor reach an API route.
const NEXT_OK = /^\/(?:|connect|s\/[0-9a-f]{8,32})$/;
export const safeNext = raw => (typeof raw === 'string' && raw.length <= 100 && NEXT_OK.test(raw) ? raw : '/');
