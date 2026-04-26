/**
 * browserTools.ts — Browser automation tools backed by playwright-cli.
 *
 * playwright-cli maintains a persistent browser session (SESSION_ID) across
 * sequential tool calls. Every fill/click action emits the corresponding
 * Playwright TypeScript code ("generatedCode" in the response), which the
 * agent collects to build accurate POM methods — no locator guessing needed.
 *
 * Snapshots return a YAML accessibility tree with element refs (e1, e2, ...).
 * Use refs for interactions; use browser_generate_locator(ref) to obtain the
 * Playwright locator for any element you observe but don't interact with.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import { AgentTool, ToolHandlers } from '../types';
import { log } from '../utils/logger';

const execFileAsync = promisify(execFile);

// ─── Auth state ───────────────────────────────────────────────────────────────

const AUTH_DIR = process.env.PLAYWRIGHT_AUTH_DIR ?? path.join(process.cwd(), '.playwright-auth');

export function authStatePath(persona: string, baseUrl?: string): string {
  fs.mkdirSync(AUTH_DIR, { recursive: true });
  // Include a URL slug when different QA envs are in play
  const envSlug = baseUrl
    ? `-${new URL(baseUrl).hostname.replace(/\./g, '-')}`
    : '';
  return path.join(AUTH_DIR, `${persona}${envSlug}.json`);
}

export function authStateExists(persona: string, baseUrl?: string): boolean {
  return fs.existsSync(authStatePath(persona, baseUrl));
}

// ─── CLI runner ───────────────────────────────────────────────────────────────

const SESSION_ID = 'klikagent';
let sessionActive = false;

async function cli(...args: string[]): Promise<string> {
  const fullArgs = ['-s', SESSION_ID, ...args];
  log('INFO', `[BrowserTools] playwright-cli ${fullArgs.join(' ')}`);
  try {
    const { stdout, stderr } = await execFileAsync('playwright-cli', fullArgs, {
      timeout: 30_000,
      env: { ...process.env, PATH: `${process.cwd()}/node_modules/.bin:${process.env.PATH}` },
    });
    return (stdout || stderr).trim();
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    const out = (e.stdout || e.stderr || e.message || String(err)).trim();
    log('WARN', `[BrowserTools] CLI error: ${out}`);
    return out;
  }
}

// ─── Response helpers ─────────────────────────────────────────────────────────

async function snapshotYaml(): Promise<string> {
  return cli('--raw', 'snapshot');
}

async function pageUrl(): Promise<string> {
  try {
    return (await cli('--raw', 'eval', 'window.location.href')).trim();
  } catch {
    return '';
  }
}

// Extract "Ran Playwright code:" block from a playwright-cli action output.
function extractGeneratedCode(output: string): string | null {
  const match = output.match(/Ran Playwright code:\s*([\s\S]+?)(?:\n###|\n---|\n\n|$)/);
  return match?.[1]?.trim() ?? null;
}

async function buildResponse(actionOutput?: string): Promise<string> {
  const [url, snapshot] = await Promise.all([pageUrl(), snapshotYaml()]);
  const generatedCode = actionOutput ? extractGeneratedCode(actionOutput) : null;
  return JSON.stringify({ url, snapshot, generatedCode });
}

// ─── Tool handlers ────────────────────────────────────────────────────────────

async function handleNavigate(args: Record<string, unknown>): Promise<string> {
  let url = String(args['url'] ?? '');
  if (!url) throw new Error('browser_navigate: url is required');

  const persona = args['persona'] ? String(args['persona']) : null;
  const baseUrl = process.env.QA_BASE_URL ?? 'http://localhost:3000';

  if (/^https?:\/\/localhost(:\d+)?/.test(url)) {
    const parsed = new URL(url);
    url = baseUrl.replace(/\/$/, '') + parsed.pathname + parsed.search + parsed.hash;
    log('INFO', `[BrowserTools] Rewrote localhost URL to ${url}`);
  }

  try {
    if (!sessionActive) {
      // Ensure the playwright-cli workspace is initialized (creates chromium config if absent).
      // Without this, playwright-cli defaults to the 'chrome' channel which may not be installed.
      await cli('install');

      log('INFO', `[BrowserTools] Opening new browser session`);
      const openResult = await cli('open');
      if (openResult.includes('Error:') || openResult.includes('is not found')) {
        return JSON.stringify({ error: 'BROWSER_ERROR', message: `Failed to open browser session: ${openResult}` });
      }
      sessionActive = true;

      // Auto-load saved auth state for the persona, if available
      if (persona) {
        const stateFile = authStatePath(persona, baseUrl);
        if (fs.existsSync(stateFile)) {
          log('INFO', `[BrowserTools] Loading saved auth state for "${persona}" from ${stateFile}`);
          await cli('state-load', stateFile);
        } else {
          log('INFO', `[BrowserTools] No saved auth state for "${persona}" — agent will log in manually`);
        }
      }
    }

    log('INFO', `[BrowserTools] Navigating to ${url}`);
    const out = await cli('goto', url);
    return await buildResponse(out);
  } catch (err) {
    return JSON.stringify({ error: 'BROWSER_ERROR', message: String(err) });
  }
}

async function handleClick(args: Record<string, unknown>): Promise<string> {
  const selector = String(args['selector'] ?? '');
  if (!selector) throw new Error('browser_click: selector is required');

  log('INFO', `[BrowserTools] Clicking: ${selector}`);
  try {
    const out = await cli('click', selector);
    return await buildResponse(out);
  } catch (err) {
    return JSON.stringify({ error: 'BROWSER_ERROR', message: String(err) });
  }
}

async function handleFill(args: Record<string, unknown>): Promise<string> {
  const selector = String(args['selector'] ?? '');
  const value = String(args['value'] ?? '');
  if (!selector) throw new Error('browser_fill: selector is required');

  log('INFO', `[BrowserTools] Filling "${selector}" with "${value}"`);
  try {
    const out = await cli('fill', selector, value);
    return await buildResponse(out);
  } catch (err) {
    return JSON.stringify({ error: 'BROWSER_ERROR', message: String(err) });
  }
}

async function handleSnapshot(_args: Record<string, unknown>): Promise<string> {
  return buildResponse();
}

async function handleListInteractables(_args: Record<string, unknown>): Promise<string> {
  // Alias for snapshot — playwright-cli snapshots include all interactable refs
  return buildResponse();
}

async function handleGenerateLocator(args: Record<string, unknown>): Promise<string> {
  const ref = String(args['ref'] ?? '');
  if (!ref) throw new Error('browser_generate_locator: ref is required');
  if (!sessionActive) {
    return JSON.stringify({ error: 'BROWSER_ERROR', message: 'No active browser session — call browser_navigate first' });
  }
  log('INFO', `[BrowserTools] Generating locator for ref: ${ref}`);
  try {
    const result = await cli('--raw', 'generate-locator', ref);
    // Sanity-check: a valid locator starts with getBy*, locator(), nth(), etc.
    // If the output looks like an error or help text, surface it clearly so the agent can fall back.
    const looksLikeLocator = /^(getBy|page\.|locator|nth\(|\.filter)/.test(result.trim());
    if (!looksLikeLocator) {
      log('WARN', `[BrowserTools] generate-locator returned unexpected output: ${result.slice(0, 100)}`);
      return JSON.stringify({ error: 'GENERATE_LOCATOR_FAILED', ref, message: result.trim() });
    }
    return result.trim();
  } catch (err) {
    return JSON.stringify({ error: 'BROWSER_ERROR', message: String(err) });
  }
}

async function handleEval(args: Record<string, unknown>): Promise<string> {
  const expression = String(args['expression'] ?? '');
  if (!expression) throw new Error('browser_eval: expression is required');
  const ref = args['ref'] ? String(args['ref']) : null;
  log('INFO', `[BrowserTools] Eval "${expression}"${ref ? ` on ${ref}` : ''}`);
  const extra = ref ? ['eval', expression, ref] : ['eval', expression];
  return cli('--raw', ...extra);
}

async function handleCommand(args: Record<string, unknown>): Promise<string> {
  const cmdArgs = args['args'] as string[] | undefined;
  if (!Array.isArray(cmdArgs) || cmdArgs.length === 0) {
    throw new Error('browser_command: args array is required');
  }
  log('INFO', `[BrowserTools] browser_command: ${cmdArgs.join(' ')}`);
  try {
    return await cli(...cmdArgs);
  } catch (err) {
    return JSON.stringify({ error: 'BROWSER_ERROR', message: String(err) });
  }
}

async function handleClose(_args: Record<string, unknown>): Promise<string> {
  log('INFO', `[BrowserTools] Closing browser session`);
  try {
    await cli('close');
  } catch {
    // ignore — session may already be gone
  }
  sessionActive = false;
  return JSON.stringify({ ok: true });
}

// ─── Tool definitions ─────────────────────────────────────────────────────────

export function buildBrowserTools(): AgentTool[] {
  const baseUrl = process.env.QA_BASE_URL ?? 'http://localhost:3000';
  return [
    {
      type: 'function',
      function: {
        name: 'browser_navigate',
        description:
          'Open the browser and navigate to a URL. Returns a YAML accessibility snapshot with element refs (e1, e2, ...) and the current page URL. ' +
          'Must be called before any other browser tool. On first call, opens a new browser session. ' +
          'Pass "persona" (e.g. "patient", "doctor", "admin") to auto-load saved auth state — if a state file exists for that persona the browser will already be authenticated and the app will skip the login page.',
        parameters: {
          type: 'object',
          properties: {
            url: {
              type: 'string',
              description: `Fully-qualified URL to navigate to. App base URL is "${baseUrl}".`,
            },
            persona: {
              type: 'string',
              description:
                'Persona name to load saved auth state for (e.g. "patient", "doctor", "admin"). ' +
                'If a saved state exists the session will be pre-authenticated. ' +
                'If not, the app will redirect to login — log in manually then call ' +
                'browser_command(["state-save", ".playwright-auth/{persona}.json"]) to persist for next time.',
            },
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
          'Click an element using an element ref from the snapshot (e.g. "e15") or a Playwright locator string. ' +
          'Response includes "generatedCode" — the exact Playwright code for this click. Collect these for your POM.',
        parameters: {
          type: 'object',
          properties: {
            selector: {
              type: 'string',
              description: 'Element ref from the snapshot (e.g. "e15") or Playwright locator (e.g. "getByTestId(\'login-btn\')")',
            },
          },
          required: ['selector'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'browser_fill',
        description:
          'Fill a form input. Use an element ref from the snapshot or a Playwright locator string. ' +
          'Response includes "generatedCode" — the exact Playwright code for this fill. Collect these for your POM.',
        parameters: {
          type: 'object',
          properties: {
            selector: {
              type: 'string',
              description: 'Element ref (e.g. "e5") or Playwright locator (e.g. "getByLabel(\'Email\')")',
            },
            value: {
              type: 'string',
              description: 'The value to type into the field',
            },
          },
          required: ['selector', 'value'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'browser_snapshot',
        description:
          'Get a fresh YAML accessibility snapshot of the current page with element refs (e1, e2, ...). Use to observe page state after interactions.',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    },
    {
      type: 'function',
      function: {
        name: 'browser_list_interactables',
        description:
          'Alias for browser_snapshot — returns the current page snapshot including all interactable elements with refs.',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    },
    {
      type: 'function',
      function: {
        name: 'browser_generate_locator',
        description:
          'Generate the Playwright locator expression for an element ref from the current snapshot. ' +
          'Use this for POM properties you observe but do not directly interact with (so no "generatedCode" is produced for them). ' +
          'Returns a string like: getByRole(\'button\', { name: \'Submit\' }) or getByTestId(\'email-input\').',
        parameters: {
          type: 'object',
          properties: {
            ref: {
              type: 'string',
              description: 'Element ref from the current snapshot, e.g. "e5"',
            },
          },
          required: ['ref'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'browser_eval',
        description:
          'Evaluate a JavaScript expression on the page or on a specific element. ' +
          'Use to inspect attributes not visible in the snapshot (e.g. data-testid, value, aria-label).',
        parameters: {
          type: 'object',
          properties: {
            expression: {
              type: 'string',
              description: 'JS expression e.g. "window.location.href" or "el => el.getAttribute(\'data-testid\')"',
            },
            ref: {
              type: 'string',
              description: 'Optional element ref to scope the expression to, e.g. "e5"',
            },
          },
          required: ['expression'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'browser_command',
        description:
          'Run any playwright-cli command in the current browser session. ' +
          'Use for features not covered by the named tools: screenshots, tracing, video, network mocking, run-code, storage, tabs, etc. ' +
          'The session flag (-s klikagent) is automatically prepended — pass only the command and its arguments. ' +
          'Examples: ["screenshot", "--filename=step1.png"], ["tracing-start"], ["tracing-stop"], ' +
          '["route", "**/*.jpg", "--status=404"], ["run-code", "async page => { ... }"], ' +
          '["--raw", "eval", "document.title"], ["state-save", "auth.json"], ["state-load", "auth.json"]',
        parameters: {
          type: 'object',
          properties: {
            args: {
              type: 'array',
              items: { type: 'string' },
              description: 'playwright-cli command and arguments as an array, e.g. ["screenshot", "--filename=page.png"]',
            },
          },
          required: ['args'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'browser_close',
        description: 'Close the browser session. Call when exploration is complete, before calling done().',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    },
  ];
}

export const browserTools: AgentTool[] = buildBrowserTools();

export const browserHandlers: ToolHandlers = {
  browser_navigate: handleNavigate,
  browser_click: handleClick,
  browser_fill: handleFill,
  browser_snapshot: handleSnapshot,
  browser_list_interactables: handleListInteractables,
  browser_generate_locator: handleGenerateLocator,
  browser_eval: handleEval,
  browser_command: handleCommand,
  browser_close: handleClose,
};
