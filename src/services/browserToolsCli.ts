/**
 * browserTools.ts — Playwright CLI tool layer for the QA agent.
 *
 * Instead of calling Playwright API directly, we shell out to `playwright-cli`
 * (from @playwright/cli). This is token-efficient: CLI output is concise,
 * sessions are managed by the CLI, and we avoid maintaining our own browser
 * lifecycle code.
 *
 * Session: one named session per KlikAgent run (playwright-cli -s=klikagent).
 * Persona auth: each persona has a persistent state file. On first use,
 *   we run the login sequence via CLI and save state with state-save.
 *   On subsequent uses, we load the state file before navigating.
 *
 * Tool names are preserved (browser_navigate, browser_click, etc.) so
 * callers like qaAgent.ts don't need to change their imports.
 */

import { exec } from 'child_process';
import { AgentTool, ToolHandlers } from '../types';
import { log } from '../utils/logger';
import { getPersonas } from './personas';
import * as fs from 'fs';
import * as path from 'path';

const SESSION_NAME = 'klikagent';
const STATE_DIR = path.join(__dirname, '..', '.playwright-sessions');

// ─── Shell helper ──────────────────────────────────────────────────────────────

function getCliBase(): string {
  return path.resolve(__dirname, '..', '..', 'node_modules', '.bin', 'playwright-cli');
}

interface CliResult {
  stdout: string;
  stderr: string;
  code: number;
}

async function cli(...args: string[]): Promise<CliResult> {
  // Build: playwright-cli -s session arg1 arg2 ...
  const sessionArg = `-s=${SESSION_NAME}`;
  const cmd = [getCliBase(), sessionArg, ...args].join(' ') + ' 2>&1';
  log('INFO', `[BrowserTools] exec: ${cmd.slice(0, 120)}`);
  return new Promise((resolve) => {
    exec(cmd, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ stdout: stdout.trim(), stderr: stderr.trim(), code: err ? 1 : 0 });
    });
  });
}

// ─── Session management ────────────────────────────────────────────────────────

async function ensureSession(): Promise<void> {
  await cli('open', 'about:blank');
}

// ─── Persona state ────────────────────────────────────────────────────────────

const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 1 day

function cleanupExpiredSessions(): void {
  if (!fs.existsSync(STATE_DIR)) return;
  const now = Date.now();
  for (const file of fs.readdirSync(STATE_DIR)) {
    if (!file.endsWith('.json')) continue;
    const filePath = path.join(STATE_DIR, file);
    const stat = fs.statSync(filePath);
    if (now - stat.mtimeMs > SESSION_TTL_MS) {
      fs.unlinkSync(filePath);
    }
  }
}

function personaStateFile(personaName: string): string {
  const dir = STATE_DIR;
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${personaName}.json`);
}

async function authenticatePersona(personaName: string): Promise<void> {
  const stateFile = personaStateFile(personaName);
  cleanupExpiredSessions();
  if (fs.existsSync(stateFile)) {
    await cli('state-load', stateFile);
    log('INFO', `[BrowserTools] Loaded persona state for "${personaName}" from ${stateFile}`);
    return;
  }

  const personaMap = await getPersonas([personaName]);
  const persona = personaMap[personaName] ?? Object.values(personaMap)[0];
  if (!persona) {
    log('WARN', `[BrowserTools] No credentials for persona "${personaName}" — skipping auth`);
    return;
  }

  const baseUrl = process.env.QA_BASE_URL ?? 'http://localhost:3000';
  const loginUrl = `${baseUrl}/login`;

  await cli('goto', loginUrl);
  await cli('fill', 'input[name="email"]', persona.email);
  await cli('fill', 'input[name="password"]', persona.password);
  await cli('click', 'button[type="submit"]');
  await cli('wait-for-load', 'networkidle');
  await cli('state-save', stateFile);
  log('INFO', `[BrowserTools] Authenticated as "${personaName}" and saved state to ${stateFile}`);
}

// ─── Error shaping ─────────────────────────────────────────────────────────────

interface ToolError {
  error: string;
  message: string;
  hint?: string;
}

function shapeError(stderr: string, cmd: string): string {
  const msg = stderr.toLowerCase();
  if (msg.includes('not found') || msg.includes('no such element') || msg.includes('no matching')) {
    const err: ToolError = {
      error: 'LOCATOR_NOT_FOUND',
      message: stderr,
      hint: 'Call browser_snapshot() to see the current page state and available refs.',
    };
    return JSON.stringify(err);
  }
  if (msg.includes('timeout') || msg.includes('timed out')) {
    const err: ToolError = {
      error: 'TIMEOUT',
      message: stderr,
      hint: 'The page took too long to load. Try browser_snapshot() to check current state.',
    };
    return JSON.stringify(err);
  }
  if (msg.includes('net::err_connection_refused') || msg.includes('connection refused')) {
    const err: ToolError = {
      error: 'CONNECTION_REFUSED',
      message: stderr,
      hint: `Cannot connect to the QA app. Is ${process.env.QA_BASE_URL} running?`,
    };
    return JSON.stringify(err);
  }
  if (cmd.includes('state-load') && msg.includes('no such file')) {
    return JSON.stringify({ error: 'STATE_FILE_NOT_FOUND', message: stderr });
  }
  if (cmd.includes('goto')) {
    return JSON.stringify({ error: 'NAVIGATION_ERROR', message: stderr });
  }
  return JSON.stringify({ error: 'UNKNOWN', message: stderr });
}

// ─── Snapshot parser ─────────────────────────────────────────────────────────────

interface ParsedSnapshot {
  url: string;
  pageTitle: string;
  refs: Record<string, string>;
  interactables: InteractableElement[];
  raw: string;
}

interface InteractableElement {
  ref: string;
  role: string;
  label: string;
  selector: string;
}

const INTERACTABLE_ROLES = new Set([
  'textbox', 'combobox', 'searchbox', 'spinbutton',
  'button', 'link', 'checkbox', 'radio', 'switch',
  'menuitem', 'tab', 'option', 'menuitemcheckbox', 'menuitemradio',
]);

function buildSelector(role: string, text: string, attrs: Record<string, string>): string {
  const safeText = text.replace(/"/g, '\\"');
  switch (role) {
    case 'textbox':
      if (attrs['type'] === 'email') return `input[type="email"]`;
      if (attrs['type'] === 'password') return `input[type="password"]`;
      if (attrs['type'] === 'search') return `input[type="search"]`;
      if (attrs['name']) return `input[name="${attrs['name']}"]`;
      if (attrs['id']) return `#${attrs['id']}`;
      if (safeText) return `input[placeholder*="${safeText}"]`;
      return `input[type="text"]`;
    case 'searchbox':
      return `input[type="search"]`;
    case 'checkbox':
      if (attrs['id']) return `#${attrs['id']}`;
      if (safeText) return `input[type="checkbox"]`;
      return `input[type="checkbox"]`;
    case 'radio':
      if (attrs['id']) return `#${attrs['id']}`;
      if (safeText) return `input[type="radio"]`;
      return `input[type="radio"]`;
    case 'button':
      if (attrs['type']) return `button[type="${attrs['type']}"]`;
      if (safeText) return `button:has-text("${safeText}")`;
      return `button`;
    case 'link':
      if (attrs['href']) return `a[href="${attrs['href']}"]`;
      if (safeText) return `a:has-text("${safeText}")`;
      return `a`;
    case 'combobox':
    case 'select':
      if (attrs['id']) return `#${attrs['id']}`;
      if (attrs['name']) return `select[name="${attrs['name']}"]`;
      return `select`;
    case 'switch':
      return `switch`;
    default:
      if (safeText) return `${role}:has-text("${safeText}")`;
      return role;
  }
}

function parseSnapshotOutput(stdout: string): ParsedSnapshot {
  const refs: Record<string, string> = {};
  const lines = stdout.split('\n');
  let pageTitle = '';
  let inPage = false;
  const interactables: InteractableElement[] = [];

  for (const line of lines) {
    if (line.startsWith('# Snapshot')) continue;
    if (line.startsWith('Page URL:')) continue;
    if (line.startsWith('- Page Title:')) {
      pageTitle = line.replace('- Page Title:', '').trim();
      continue;
    }
    const refMatch = line.match(/^\s*-\s+\[?([^\]]+)\]?\s*\[ref=(e\d+)\](?:\s*:\s*(.+))?/);
    if (refMatch) {
      const [, role, ref, text] = refMatch;
      const label = text ? text.trim() : '';
      refs[ref] = label ? `${role}: ${label}` : role;
      if (INTERACTABLE_ROLES.has(role)) {
        interactables.push({ ref, role, label, selector: buildSelector(role, label, {}) });
      }
    }
    if (line.trim() === '# Page' || line.startsWith('# Page')) inPage = true;
  }

  return { url: '', pageTitle, refs, interactables, raw: stdout };
}

// ─── Tool handlers ─────────────────────────────────────────────────────────────

async function handleNavigate(args: Record<string, unknown>): Promise<string> {
  let url = String(args['url'] ?? '');
  const personaName = String(args['persona'] ?? 'default');

  if (!url) throw new Error('browser_navigate: url is required');

  const baseUrl = process.env.QA_BASE_URL ?? 'http://localhost:3000';
  const localhostPattern = /^https?:\/\/localhost(:\d+)?/;
  if (localhostPattern.test(url)) {
    const parsed = new URL(url);
    url = baseUrl.replace(/\/$/, '') + parsed.pathname + parsed.search + parsed.hash;
    log('INFO', `[BrowserTools] Rewrote localhost URL to ${url}`);
  }

  await ensureSession();
  await authenticatePersona(personaName);

  log('INFO', `[BrowserTools] Navigating to ${url}`);
  const result = await cli('goto', url);

  if (result.code !== 0) {
    return shapeError(result.stderr, 'goto');
  }

  const snapshotResult = await cli('snapshot');
  if (snapshotResult.code !== 0) {
    return JSON.stringify({ error: 'SNAPSHOT_FAILED', message: snapshotResult.stderr });
  }

  return JSON.stringify(parseSnapshotOutput(snapshotResult.stdout));
}

async function handleClick(args: Record<string, unknown>): Promise<string> {
  const selector = String(args['selector'] ?? '');
  if (!selector) throw new Error('browser_click: selector is required');

  log('INFO', `[BrowserTools] Clicking: ${selector}`);
  const result = await cli('click', selector);

  if (result.code !== 0) {
    return shapeError(result.stderr, 'click');
  }

  const snapshotResult = await cli('snapshot');
  if (snapshotResult.code !== 0) {
    return JSON.stringify({ error: 'SNAPSHOT_FAILED', message: snapshotResult.stderr });
  }

  return JSON.stringify(parseSnapshotOutput(snapshotResult.stdout));
}

async function handleFill(args: Record<string, unknown>): Promise<string> {
  const selector = String(args['selector'] ?? '');
  const value = String(args['value'] ?? '');
  if (!selector) throw new Error('browser_fill: selector is required');

  log('INFO', `[BrowserTools] Filling "${selector}" with "${value}"`);
  const result = await cli('fill', selector, value);

  if (result.code !== 0) {
    return shapeError(result.stderr, 'fill');
  }

  return JSON.stringify({ ok: true, url: '' });
}

async function handleSnapshot(_args: Record<string, unknown>): Promise<string> {
  log('INFO', `[BrowserTools] Taking snapshot`);
  const result = await cli('snapshot');

  if (result.code !== 0) {
    return JSON.stringify({ error: 'SNAPSHOT_FAILED', message: result.stderr });
  }

  return JSON.stringify(parseSnapshotOutput(result.stdout));
}

async function handleClose(_args: Record<string, unknown>): Promise<string> {
  log('INFO', `[BrowserTools] Closing browser session`);
  await cli('close');
  return JSON.stringify({ ok: true });
}

function extractInteractables(raw: string): InteractableElement[] {
  const lines = raw.split('\n');
  const interactables: InteractableElement[] = [];

  for (const line of lines) {
    const refIdx = line.indexOf('[ref=');
    if (refIdx === -1) continue;

    const beforeRef = line.slice(0, refIdx).trim();
    const refPart = line.slice(refIdx);

    const refMatch = refPart.match(/\[ref=(e\d+)\]/);
    if (!refMatch) continue;
    const ref = refMatch[1];

    const content = beforeRef.replace(/^-\s*/, '').trim();
    if (!content) continue;

    const textMatch = content.match(/"([^"]+)"/);
    let role: string, label: string;
    if (textMatch) {
      role = content.replace(/"[^"]+"/, '').trim();
      label = textMatch[1];
    } else {
      const colonIdx = content.indexOf(':');
      if (colonIdx !== -1) {
        role = content.slice(0, colonIdx).trim();
        label = content.slice(colonIdx + 1).trim();
      } else {
        role = content;
        label = '';
      }
    }

    if (!INTERACTABLE_ROLES.has(role)) continue;
    interactables.push({ ref, role, label, selector: buildSelector(role, label, {}) });
  }

  return interactables;
}

async function handleListInteractables(_args: Record<string, unknown>): Promise<string> {
  const result = await cli('snapshot');
  if (result.code !== 0) {
    return JSON.stringify({ error: 'SNAPSHOT_FAILED', message: result.stderr });
  }
  const parsed = parseSnapshotOutput(result.stdout);
  const interactables = extractInteractables(parsed.raw);
  return JSON.stringify({ interactables, pageTitle: parsed.pageTitle });
}

// ─── OpenAI tool definitions ──────────────────────────────────────────────────

export function buildBrowserTools(baseUrl: string): AgentTool[] {
  return [
    {
      type: 'function',
      function: {
        name: 'browser_navigate',
        description:
          'Open browser, authenticate as persona, navigate to URL, and return a page snapshot with element refs. ' +
          'Pass the full URL including the QA base host (e.g. "https://app.testingwithekki.com/dashboard"). ' +
          'Returns a snapshot JSON with "refs" mapping (e.g. { e5: "button: Submit" }).',
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string', description: `Full URL to navigate to.` },
            persona: { type: 'string', description: 'Persona name to authenticate as (e.g. "default", "patient"). Defaults to "default".' },
          },
          required: ['url'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'browser_click',
        description:
          'Click an element on the current page. Accepts an element ref from a snapshot (e.g. "e5") or a Playwright selector string. ' +
          'Returns an updated snapshot after the click.',
        parameters: {
          type: 'object',
          properties: {
            selector: { type: 'string', description: 'Element ref (e.g. "e5") or selector string (e.g. "getByRole(\'button\', { name: \'Submit\' })")' },
          },
          required: ['selector'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'browser_fill',
        description: 'Fill a text input on the current page. Accepts element ref or selector string.',
        parameters: {
          type: 'object',
          properties: {
            selector: { type: 'string', description: 'Element ref or selector string for the input' },
            value: { type: 'string', description: 'Text value to type' },
          },
          required: ['selector', 'value'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'browser_snapshot',
        description: 'Capture the current page snapshot with element refs. Use after any interaction to observe what changed.',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    },
    {
      type: 'function',
      function: {
        name: 'browser_close',
        description: 'Close the browser session and free resources.',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    },
    {
      type: 'function',
      function: {
        name: 'browser_list_interactables',
        description:
          'List all interactive elements on the current page with their refs, roles, labels, and CSS selectors. ' +
          'Use this to discover what elements are available before interacting with them. ' +
          'Returns a list of { ref, role, label, selector } objects.',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    },
  ];
}

export { getPersonas } from '../utils/personaUtils';
export const browserTools: AgentTool[] = buildBrowserTools(
  process.env.QA_BASE_URL ?? 'http://localhost:3000'
);

export const browserHandlers: ToolHandlers = {
  browser_navigate: handleNavigate,
  browser_click: handleClick,
  browser_fill: handleFill,
  browser_snapshot: handleSnapshot,
  browser_close: handleClose,
  browser_list_interactables: handleListInteractables,
};
