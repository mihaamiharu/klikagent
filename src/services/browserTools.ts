/// <reference lib="dom" />
/**
 * browserTools.ts — Browser automation tools for the AI agent tool loop.
 *
 * Exposes browser automation as OpenAI function-calling compatible tools so the
 * agent can navigate, interact with, and snapshot a real browser during test
 * generation.
 *
 * Implementation: Direct Playwright API. This is simpler, faster, and more
 * reliable than shelling out to @playwright/cli — no child process overhead,
 * no fragile stdout parsing, and full access to the Playwright API for
 * network interception, dialog handling, etc.
 *
 * Browser session lifecycle: a module-level session is maintained so the agent
 * can call tools sequentially (navigate → click → fill → snapshot) without
 * relaunching the browser on each call. Call `browser_close` to tear down.
 */

import { chromium, Browser, BrowserContext, Page, Locator } from 'playwright';
import { AgentTool, ToolHandlers } from '../types';
import { log } from '../utils/logger';

// ─── Persona credentials ──────────────────────────────────────────────────────

export interface Persona {
  name: string;
  email: string;
  password: string;
}

/**
 * Returns available test personas from environment variables.
 * Persona env vars follow the pattern:
 *   PERSONA_<NAME>_EMAIL=<email>
 *   PERSONA_<NAME>_PASSWORD=<password>
 *
 * A default "default" persona is always included using QA_USER_EMAIL /
 * QA_USER_PASSWORD for backward compatibility with the old crawler.
 */
export function getPersonas(): Persona[] {
  const personas: Persona[] = [];

  // Default persona — backward compat with existing QA_USER_* env vars
  const defaultEmail = process.env.QA_USER_EMAIL;
  const defaultPassword = process.env.QA_USER_PASSWORD;
  if (defaultEmail && defaultPassword) {
    personas.push({ name: 'default', email: defaultEmail, password: defaultPassword });
  }

  // Discover additional PERSONA_<NAME>_EMAIL / PERSONA_<NAME>_PASSWORD pairs
  for (const [key, value] of Object.entries(process.env)) {
    const match = key.match(/^PERSONA_(.+)_EMAIL$/);
    if (!match || !value) continue;
    const name = match[1].toLowerCase();
    const password = process.env[`PERSONA_${match[1]}_PASSWORD`];
    if (!password) continue;
    // Skip if this is already the default persona
    if (name === 'default' && value === defaultEmail) continue;
    personas.push({ name, email: value, password });
  }

  return personas;
}

// ─── Module-level browser session ────────────────────────────────────────────

interface BrowserSession {
  browser: Browser;
  context: BrowserContext;
  page: Page;
}

let activeSession: BrowserSession | null = null;

async function getOrCreateSession(): Promise<BrowserSession> {
  if (activeSession) return activeSession;
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  activeSession = { browser, context, page };
  return activeSession;
}

async function teardownSession(): Promise<void> {
  if (!activeSession) return;
  await activeSession.browser.close().catch(() => {});
  activeSession = null;
}

// ─── Structured error shaping ─────────────────────────────────────────────────

interface ToolError {
  error: string;
  message: string;
  hint?: string;
}

function shapeError(err: unknown, operation: string): string {
  const message = err instanceof Error ? err.message : String(err);
  const msg = message.toLowerCase();

  if (msg.includes('timeout') || msg.includes('timed out')) {
    const shaped: ToolError = {
      error: 'TIMEOUT',
      message,
      hint: 'The element or page took too long. Call browser_snapshot() to check current state.',
    };
    return JSON.stringify(shaped);
  }

  if (msg.includes('not found') || msg.includes('no element') || msg.includes('strict mode violation')) {
    const shaped: ToolError = {
      error: 'LOCATOR_NOT_FOUND',
      message,
      hint: 'The locator did not match any element. Call browser_list_interactables() to see available elements.',
    };
    return JSON.stringify(shaped);
  }

  if (msg.includes('net::err_connection_refused') || msg.includes('connection refused')) {
    const shaped: ToolError = {
      error: 'CONNECTION_REFUSED',
      message,
      hint: `Cannot connect to the app. Is ${process.env.QA_BASE_URL ?? 'the QA app'} running?`,
    };
    return JSON.stringify(shaped);
  }

  const shaped: ToolError = {
    error: 'BROWSER_ERROR',
    message,
    hint: `${operation} failed. Call browser_snapshot() to check current state.`,
  };
  return JSON.stringify(shaped);
}

// ─── Snapshot helper ──────────────────────────────────────────────────────────

const INTERACTIVE_SELECTOR =
  'button, a[href], input, select, textarea, ' +
  '[role="button"], [role="link"], [role="checkbox"], [role="radio"], ' +
  '[role="tab"], [role="menuitem"], [role="option"], [role="combobox"], ' +
  '[role="textbox"], [role="switch"]';

export interface InteractableElement {
  role: string;
  label: string;
  selector: string;
}

// Converts a selector string produced by extractInteractables (e.g. "getByLabel('Email')")
// into an actual Playwright Locator. page.locator() only accepts CSS/XPath — not these strings.
function locatorFromSelector(page: Page, selector: string): Locator {
  const testId = selector.match(/^getByTestId\('(.+?)'\)$/);
  if (testId) return page.getByTestId(testId[1]);

  const label = selector.match(/^getByLabel\('(.+?)'\)$/);
  if (label) return page.getByLabel(label[1]);

  const placeholder = selector.match(/^getByPlaceholder\('(.+?)'\)$/);
  if (placeholder) return page.getByPlaceholder(placeholder[1]);

  const role = selector.match(/^getByRole\('(\w+)',\s*\{\s*name:\s*'(.+?)'\s*\}\)$/);
  if (role) return page.getByRole(role[1] as Parameters<Page['getByRole']>[0], { name: role[2] });

  return page.locator(selector);
}

async function extractInteractables(page: Page): Promise<InteractableElement[]> {
  return page.evaluate((selector: string) => {
    const TAG_TO_ROLE: Record<string, string> = {
      button: 'button',
      a: 'link',
      select: 'combobox',
      textarea: 'textbox',
    };

    function inputRole(el: HTMLInputElement): string {
      const map: Record<string, string> = {
        checkbox: 'checkbox', radio: 'radio', range: 'slider',
        search: 'searchbox', spinbutton: 'spinbutton',
      };
      return map[el.type] ?? 'textbox';
    }

    function getRole(el: Element): string {
      const explicit = el.getAttribute('role');
      if (explicit) return explicit;
      const tag = el.tagName.toLowerCase();
      if (tag === 'input') return inputRole(el as HTMLInputElement);
      return TAG_TO_ROLE[tag] ?? tag;
    }

    function safeName(s: string): string {
      return s.trim().replace(/'/g, "\\'").slice(0, 60);
    }

    function bestLocator(el: Element): { role: string; label: string; selector: string } | null {
      const role = getRole(el);

      const testId = el.getAttribute('data-testid');
      if (testId) return { role, label: testId, selector: `getByTestId('${safeName(testId)}')` };

      const ariaLabel = el.getAttribute('aria-label');
      if (ariaLabel) return { role, label: ariaLabel, selector: `getByRole('${role}', { name: '${safeName(ariaLabel)}' })` };

      const id = el.getAttribute('id');
      if (id) {
        const labelEl = document.querySelector<HTMLElement>(`label[for="${id}"]`);
        const labelText = labelEl?.textContent?.trim();
        if (labelText) return { role, label: labelText, selector: `getByLabel('${safeName(labelText)}')` };
      }

      const placeholder = (el as HTMLInputElement).placeholder;
      if (placeholder) return { role, label: placeholder, selector: `getByPlaceholder('${safeName(placeholder)}')` };

      const text = el.textContent?.trim();
      if (text && text.length <= 60 && (role === 'button' || role === 'link')) {
        return { role, label: text, selector: `getByRole('${role}', { name: '${safeName(text)}' })` };
      }

      return null;
    }

    const seen = new Set<string>();
    const results: Array<{ role: string; label: string; selector: string }> = [];
    document.querySelectorAll(selector).forEach((el) => {
      const result = bestLocator(el);
      if (result && !seen.has(result.selector)) {
        seen.add(result.selector);
        results.push(result);
      }
    });
    return results;
  }, INTERACTIVE_SELECTOR);
}

async function takeSnapshot(page: Page): Promise<string> {
  // Expand collapsed elements to reveal lazy content
  await page.evaluate(() => {
    document.querySelectorAll<HTMLElement>('[aria-expanded="false"]').forEach((el) => el.click());
    document.querySelectorAll<HTMLElement>('details:not([open])').forEach((el) => el.setAttribute('open', ''));
  });
  await page.waitForTimeout(300);

  const [ariaTree, interactables] = await Promise.all([
    page.locator('body').ariaSnapshot({ mode: 'ai', timeout: 5_000 }).catch(() => ''),
    extractInteractables(page),
  ]);

  return JSON.stringify({
    url: page.url(),
    ariaTree,
    interactables,
  });
}

// ─── Tool handlers ────────────────────────────────────────────────────────────

async function handleNavigate(args: Record<string, unknown>): Promise<string> {
  let url = String(args['url'] ?? '');
  const personaName = args['persona'] ? String(args['persona']) : 'default';

  if (!url) throw new Error('browser_navigate: url is required');

  // Rewrite localhost URLs to QA_BASE_URL so the agent doesn't need to know the real host
  const baseUrl = process.env.QA_BASE_URL ?? 'http://localhost:3000';
  const localhostPattern = /^https?:\/\/localhost(:\d+)?/;
  if (localhostPattern.test(url)) {
    const parsed = new URL(url);
    url = baseUrl.replace(/\/$/, '') + parsed.pathname + parsed.search + parsed.hash;
    log('INFO', `[BrowserTools] Rewrote localhost URL to ${url}`);
  }

  const session = await getOrCreateSession();
  const { page } = session;

  // Authenticate as the requested persona if credentials are available
  const personas = getPersonas();
  const persona = personas.find((p) => p.name === personaName) ?? personas[0];

  if (persona) {
    const loginUrl = `${baseUrl}/login`;
    log('INFO', `[BrowserTools] Authenticating as persona "${persona.name}" at ${loginUrl}`);

    try {
      await page.goto(loginUrl, { waitUntil: 'networkidle', timeout: 30_000 });

      const interactables = await extractInteractables(page);
      const emailField = interactables.find(
        (el) => el.role === 'textbox' && /email|username/i.test(el.label),
      );
      const passwordField = interactables.find(
        (el) => el.role === 'textbox' && /password|pass/i.test(el.label),
      );

      if (emailField && passwordField) {
        log('INFO', `[BrowserTools] Using discovered auth fields: ${emailField.selector}, ${passwordField.selector}`);
        await locatorFromSelector(page, emailField.selector).first().fill(persona.email);
        await locatorFromSelector(page, passwordField.selector).first().fill(persona.password);
        await page.keyboard.press('Enter');
        await page.waitForNavigation({ timeout: 10_000 }).catch(() => {});
        log('INFO', `[BrowserTools] Login submitted`);
      } else {
        log('WARN', `[BrowserTools] Could not discover email/password fields in interactables — skipping auth`);
      }
    } catch (err) {
      log('WARN', `[BrowserTools] Authentication failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  log('INFO', `[BrowserTools] Navigating to ${url}`);
  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30_000 });
    return await takeSnapshot(page);
  } catch (err) {
    return shapeError(err, 'browser_navigate');
  }
}

async function handleClick(args: Record<string, unknown>): Promise<string> {
  const selector = String(args['selector'] ?? '');
  if (!selector) throw new Error('browser_click: selector is required');

  const session = await getOrCreateSession();
  const { page } = session;

  log('INFO', `[BrowserTools] Clicking: ${selector}`);
  try {
    await page.locator(selector).first().click({ timeout: 10_000 });

    // Wait for any navigation or network activity to settle
    await page.waitForTimeout(500);
    await page.waitForLoadState('networkidle').catch(() => {});

    return await takeSnapshot(page);
  } catch (err) {
    return shapeError(err, 'browser_click');
  }
}

async function handleFill(args: Record<string, unknown>): Promise<string> {
  const selector = String(args['selector'] ?? '');
  const value = String(args['value'] ?? '');
  if (!selector) throw new Error('browser_fill: selector is required');

  const session = await getOrCreateSession();
  const { page } = session;

  log('INFO', `[BrowserTools] Filling "${selector}" with "${value}"`);
  try {
    await page.locator(selector).first().fill(value, { timeout: 10_000 });
    // Return a snapshot so the agent can see the result of the fill
    return await takeSnapshot(page);
  } catch (err) {
    return shapeError(err, 'browser_fill');
  }
}

async function handleSnapshot(_args: Record<string, unknown>): Promise<string> {
  const session = await getOrCreateSession();
  return await takeSnapshot(session.page);
}

async function handleListInteractables(_args: Record<string, unknown>): Promise<string> {
  const session = await getOrCreateSession();
  const { page } = session;

  log('INFO', `[BrowserTools] Listing interactable elements`);
  const interactables = await extractInteractables(page);
  return JSON.stringify({
    url: page.url(),
    interactables,
  });
}

async function handleClose(_args: Record<string, unknown>): Promise<string> {
  log('INFO', `[BrowserTools] Closing browser session`);
  await teardownSession();
  return JSON.stringify({ ok: true });
}

// ─── OpenAI tool definitions ──────────────────────────────────────────────────

export function buildBrowserTools(): AgentTool[] {
  const baseUrl = process.env.QA_BASE_URL ?? 'http://localhost:3000';
  return [
  {
    type: 'function',
    function: {
      name: 'browser_navigate',
      description:
        'Launch a headless browser, authenticate as the given persona, navigate to the URL, and return a page snapshot. ' +
        'The snapshot includes an ARIA accessibility tree and a list of interactable elements with Playwright locators. ' +
        'Must be called first before any other browser tool.',
      parameters: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: `The fully-qualified URL to navigate to. The app base URL is "${baseUrl}" — use this as the host for all navigation (e.g. "${baseUrl}/dashboard").`,
          },
          persona: {
            type: 'string',
            description:
              'The persona name to authenticate as. Must match one of the configured personas (e.g. "default", "admin", "viewer"). Defaults to "default".',
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
        'Click an element on the current page using a Playwright locator from a previous snapshot\'s interactables list ' +
        '(e.g. getByRole("button", { name: "Submit" }) or getByTestId("submit-btn")). ' +
        'Returns an updated snapshot after the click.',
      parameters: {
        type: 'object',
        properties: {
          selector: {
            type: 'string',
            description:
              'A Playwright locator string from a previous snapshot\'s interactables array, e.g. "getByRole(\'button\', { name: \'Login\' })"',
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
        'Fill a form input on the current page. ' +
        'Use a locator from a previous snapshot\'s interactables list. Returns an updated snapshot.',
      parameters: {
        type: 'object',
        properties: {
          selector: {
            type: 'string',
            description:
              'A Playwright locator string for the input element, e.g. "getByLabel(\'Email\')"',
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
        'Capture the current page state without any interaction. ' +
        'Returns a snapshot with ARIA tree and interactable elements with Playwright locators. ' +
        'Use after any interaction to observe what changed on the page.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_list_interactables',
      description:
        'List all interactive elements on the current page with their roles, labels, and Playwright locators. ' +
        'Use this to discover what elements are available before interacting with them. ' +
        'Returns a list of { role, label, selector } objects.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_close',
      description:
        'Close the browser session. Call this when browser exploration is complete ' +
        'to free resources before calling done().',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
  ];
}

export const browserTools: AgentTool[] = buildBrowserTools();

// ─── OpenAI tool handlers ─────────────────────────────────────────────────────

export const browserHandlers: ToolHandlers = {
  browser_navigate: handleNavigate,
  browser_click: handleClick,
  browser_fill: handleFill,
  browser_snapshot: handleSnapshot,
  browser_list_interactables: handleListInteractables,
  browser_close: handleClose,
};
