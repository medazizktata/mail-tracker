#!/usr/bin/env node
// One command to get Mail Tracker running in YOUR Cloudflare account.
//
//   pnpm install && pnpm run setup
//
// It opens Cloudflare's own "allow access" screen (wrangler login) if you are not logged in, then
// creates the storage, deploys the worker, sets a random password, registers a workers.dev
// subdomain if the account has none, and gives you ONE connection code to paste into the extension.
// Re-running it is safe: it reuses what it made before (state is kept in .mailtracker.json).
//
// Options:  --name <worker name>   (default mail-tracker)      --account <id>   pick an account
//           --subdomain <name>     (only if you have none)     --rotate-password
//           --no-clipboard         print the code instead      --help
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

import { encodeConnectionCode } from '../src/shared.js';
import {
  generatePassword, isNotLoggedIn, parseAccounts, parseKvId, parseKvList, parseToken, parseWorkerUrl,
  renderWranglerConfig, suggestSubdomain, validSubdomain, validWorkerName,
} from './lib.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE_FILE = path.join(ROOT, '.mailtracker.json');
const CONFIG_FILE = path.join(ROOT, 'wrangler.local.toml');

// ---- arguments
const args = { name: 'mail-tracker' };
{
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--rotate-password') args.rotate = true;
    else if (a === '--no-clipboard') args.noClipboard = true;
    else if (['--name', '--account', '--subdomain'].includes(a)) args[a.slice(2)] = argv[++i];
    else die(`Unknown option: ${a}`);
  }
}

// ---- small helpers
function say(msg) { console.log(msg); }
function die(msg) { console.error(`\nSetup stopped: ${msg}`); process.exit(1); }
const interactive = process.stdin.isTTY && process.stdout.isTTY;

// wrangler: the repo's own copy, or whatever WRANGLER says (for example "pnpm dlx wrangler@4.135.0").
const WRANGLER = (process.env.WRANGLER || '').split(' ').filter(Boolean);
if (!WRANGLER.length) {
  const local = path.join(ROOT, 'node_modules', '.bin', 'wrangler');
  if (!existsSync(local)) die('wrangler is not installed here. Run `pnpm install` first.');
  WRANGLER.push(local);
}

function wrangler(wargs, { input, env, inherit } = {}) {
  const r = spawnSync(WRANGLER[0], [...WRANGLER.slice(1), ...wargs], {
    cwd: ROOT, encoding: 'utf8', input, stdio: inherit ? 'inherit' : 'pipe',
    env: { ...process.env, ...env },
  });
  return { status: r.status, out: `${r.stdout || ''}${r.stderr || ''}`, stdout: r.stdout || '' };
}

async function ask(question, fallback) {
  if (!interactive) return fallback;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try { return (await rl.question(question)).trim() || fallback; } finally { rl.close(); }
}

function loadState() {
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}
function saveState(state) {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
  chmodSync(STATE_FILE, 0o600); // it holds the dashboard password
}

function copyToClipboard(text) {
  const candidates = process.platform === 'darwin' ? [['pbcopy']]
    : process.platform === 'win32' ? [['clip']]
    : [['wl-copy'], ['xclip', '-selection', 'clipboard']];
  for (const [cmd, ...rest] of candidates) {
    const r = spawnSync(cmd, rest, { input: text });
    if (r.status === 0) return true;
  }
  return false;
}

// ---- steps
async function ensureLoggedIn() {
  let who = wrangler(['whoami']);
  if (isNotLoggedIn(who.out)) {
    say('Opening Cloudflare so you can allow access to your account...');
    const login = wrangler(['login'], { inherit: true });
    if (login.status !== 0) die('The Cloudflare login did not finish.');
    who = wrangler(['whoami']);
  }
  const accounts = parseAccounts(who.out);
  if (!accounts.length) die('Logged in, but no Cloudflare account was found.');
  return accounts;
}

async function pickAccount(accounts) {
  if (args.account) {
    const a = accounts.find(x => x.id === args.account);
    if (!a) die(`Account ${args.account} is not one of: ${accounts.map(x => x.id).join(', ')}`);
    return a;
  }
  if (accounts.length === 1) return accounts[0];
  if (!interactive) die(`Several accounts found; pick one with --account <id>:\n${accounts.map(a => `  ${a.id}  ${a.name}`).join('\n')}`);
  accounts.forEach((a, i) => say(`  ${i + 1}) ${a.name}  (${a.id})`));
  const n = Number(await ask('Which account? ', '')) - 1;
  if (!accounts[n]) die('No account chosen.');
  return accounts[n];
}

function ensureKv(accountId, state) {
  if (state.kvId) return state.kvId;
  const title = `${args.name}-tracker`;
  const env = { CLOUDFLARE_ACCOUNT_ID: accountId };
  const created = wrangler(['kv', 'namespace', 'create', title], { env });
  let id = parseKvId(created.out);
  if (!id) { // it may already exist from an earlier attempt
    const list = wrangler(['kv', 'namespace', 'list'], { env });
    id = parseKvList(list.out).find(n => n.title === title)?.id || null;
  }
  if (!id) die(`Could not create the storage namespace "${title}".\n${created.out.trim().split('\n').slice(-4).join('\n')}`);
  return id;
}

// Never printed or stored: the OAuth token (or CLOUDFLARE_API_TOKEN) is used for these two calls only.
async function ensureSubdomain(accountId) {
  const token = process.env.CLOUDFLARE_API_TOKEN || parseToken(wrangler(['auth', 'token']).stdout);
  if (!token) die('Could not get a Cloudflare token from your login. Try `wrangler login` again, or set CLOUDFLARE_API_TOKEN.');
  const api = `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/subdomain`;
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const current = await (await fetch(api, { headers })).json();
  if (current.success) return;
  if (!/workers\.dev subdomain/i.test(JSON.stringify(current.errors))) die(`Could not read your workers.dev subdomain: ${JSON.stringify(current.errors)}`);

  // The subdomain is permanent and shows up in every pixel URL, so offer a neutral one.
  let sub = args.subdomain;
  if (!sub) sub = await ask(`Your account has no workers.dev subdomain yet. Choose one (it appears in every tracking-pixel URL) [${suggestSubdomain()}]: `, '') || suggestSubdomain();
  if (!validSubdomain(sub)) die(`"${sub}" is not a valid subdomain (lowercase letters, digits and hyphens).`);
  const put = await (await fetch(api, { method: 'PUT', headers, body: JSON.stringify({ subdomain: sub }) })).json();
  if (!put.success) die(`Could not register the subdomain "${sub}": ${JSON.stringify(put.errors)}`);
  say(`Registered ${sub}.workers.dev`);
}

async function waitUntilReachable(url) {
  say('Waiting for the new address to answer (the first time this can take a couple of minutes)...');
  const deadline = Date.now() + 240_000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url + '/', { signal: AbortSignal.timeout(8000) });
      if (r.status === 401) return true; // up, and asking for the password
    } catch { /* certificate or DNS not ready yet */ }
    await new Promise(r => setTimeout(r, 5000));
  }
  return false;
}

// ---- main
if (args.help) {
  say(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 14).map(l => l.replace(/^\/\/ ?/, '')).join('\n'));
  process.exit(0);
}
if (!validWorkerName(args.name)) die(`"${args.name}" is not a valid worker name (lowercase letters, digits and hyphens).`);

const accounts = await ensureLoggedIn();
const account = await pickAccount(accounts);
say(`Using account: ${account.name}`);

let state = loadState();
if (state.accountId !== account.id || state.name !== args.name) state = { accountId: account.id, name: args.name };

state.kvId = ensureKv(account.id, state);
writeFileSync(CONFIG_FILE, renderWranglerConfig({ name: args.name, accountId: account.id, kvId: state.kvId }));
await ensureSubdomain(account.id);

say('Deploying the worker...');
const deploy = wrangler(['deploy', '-c', CONFIG_FILE]);
const url = parseWorkerUrl(deploy.out);
if (deploy.status !== 0 || !url) die(`The deploy failed.\n${deploy.out.trim().split('\n').slice(-8).join('\n')}`);
state.url = url;

if (!state.password || args.rotate) {
  const password = generatePassword();
  const put = wrangler(['secret', 'put', 'DASHBOARD_PASSWORD', '-c', CONFIG_FILE], { input: password });
  if (put.status !== 0) die(`Could not set the dashboard password.\n${put.out.trim().split('\n').slice(-4).join('\n')}`);
  state.password = password;
}
saveState(state);

const ready = await waitUntilReachable(url);
const code = encodeConnectionCode(url, state.password);

say(`\nDone. Your tracker is at ${url}${ready ? '' : '  (not answering yet; give it a minute)'}`);
if (!args.noClipboard && copyToClipboard(code)) {
  say('The connection code is on your clipboard.');
} else {
  say(`Your connection code (it contains your password, so keep it private):\n\n${code}\n`);
}
say('Last step: open the Mail Tracker extension popup, paste the code into the first field, and click Save & Connect.');
say(`You can get the code again any time at ${url}/connect`);
