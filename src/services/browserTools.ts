/// <reference lib="dom" />
/**
 * browserTools.ts — Browser automation tools for the AI agent tool loop.
 *
 * Exposes browser automation as OpenAI function-calling compatible tools so the
 * agent can navigate, interact with, and snapshot a real browser during test
 * generation.
 *
 * Implementation: Approach B — raw playwright (already installed), because
 * @playwright/mcp only exposes a CLI binary and a `createConnection()` that
 * starts an MCP protocol server; bridging that into OpenAI function calling
 * would require a full MCP client transport layer. Using playwright directly
 * is simpler and avoids the round-trip overhead.
 *
 * Browser session lifecycle: a module-level session is maintained so the agent
 * can call tools sequentially (navigate → click → fill → snapshot) without
 * relaunching the browser on each call. Call `browser_close` to tear down.
 */

import { chromium, Browser, BrowserContext, Page } from 'playwright';
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

// ─── Snapshot helper (mirrors capturePageSnapshot in crawler.ts) ──────────────

const INTERACTIVE_SELECTOR =
  'button, a[href], input, select, textarea, ' +
  '[role="button"], [role="link"], [role="checkbox"], [role="radio"], ' +
  '[role="tab"], [role="menuitem"], [role="option"], [role="combobox"], ' +
  '[role="textbox"], [role="switch"]';

async function extractLocators(page: Page): Promise<string[]> {
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

    function bestLocator(el: Element): string | null {
      const testId = el.getAttribute('data-testid');
      if (testId) return `getByTestId('${safeName(testId)}')`;

      const role = getRole(el);
      const ariaLabel = el.getAttribute('aria-label');
      if (ariaLabel) return `getByRole('${role}', { name: '${safeName(ariaLabel)}' })`;

      const id = el.getAttribute('id');
      if (id) {
        const label = document.querySelector<HTMLElement>(`label[for="${id}"]`);
        const labelText = label?.textContent?.trim();
        if (labelText) return `getByLabel('${safeName(labelText)}')`;
      }

      const placeholder = (el as HTMLInputElement).placeholder;
      if (placeholder) return `getByPlaceholder('${safeName(placeholder)}')`;

      const text = el.textContent?.trim();
      if (text && text.length <= 60 && (role === 'button' || role === 'link')) {
        return `getByRole('${role}', { name: '${safeName(text)}' })`;
      }

      return null;
    }

    const seen = new Set<string>();
    const locators: string[] = [];
    document.querySelectorAll(selector).forEach((el) => {
      const locator = bestLocator(el);
      if (locator && !seen.has(locator)) {
        seen.add(locator);
        locators.push(locator);
      }
    });
    return locators;
  }, INTERACTIVE_SELECTOR);
}

async function takeSnapshot(page: Page): Promise<string> {
  // Expand collapsed elements to reveal lazy content
  await page.evaluate(() => {
    document.querySelectorAll<HTMLElement>('[aria-expanded="false"]').forEach((el) => el.click());
    document.querySelectorAll<HTMLElement>('details:not([open])').forEach((el) => el.setAttribute('open', ''));
  });
  await page.waitForTimeout(300);

  const [ariaTree, testIds, locators, bodyHtml] = await Promise.all([
    page.locator('body').ariaSnapshot({ mode: 'ai', timeout: 5_000 }).catch(() => ''),
    page.$$eval('[data-testid]', (els) =>
      els.map((el) => el.getAttribute('data-testid') ?? '').filter(Boolean)
    ),
    extractLocators(page),
    page.$eval('body', (el) => el.outerHTML.slice(0, 500)).catch(() => ''),
  ]);

  return JSON.stringify({
    url: page.url(),
    ariaTree,
    testIds,
    locators,
    htmlSample: bodyHtml,
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

    await page.goto(loginUrl, { waitUntil: 'networkidle', timeout: 30_000 });

    const emailInput = page.locator('input[type="email"], input[name="email"]').first();
    const passwordInput = page.locator('input[type="password"]').first();

    if (await emailInput.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await emailInput.fill(persona.email);
      await passwordInput.fill(persona.password);
      await page.keyboard.press('Enter');
      await page.waitForNavigation({ timeout: 10_000 }).catch(() => {});
      log('INFO', `[BrowserTools] Login submitted`);
    }
  }

  log('INFO', `[BrowserTools] Navigating to ${url}`);
  await page.goto(url, { waitUntil: 'networkidle', timeout: 30_000 });

  return await takeSnapshot(page);
}

async function handleClick(args: Record<string, unknown>): Promise<string> {
  const selector = String(args['selector'] ?? '');
  if (!selector) throw new Error('browser_click: selector is required');

  const session = await getOrCreateSession();
  const { page } = session;

  log('INFO', `[BrowserTools] Clicking: ${selector}`);
  await page.locator(selector).first().click({ timeout: 10_000 });

  // Wait for any navigation or network activity to settle
  await page.waitForTimeout(500);
  await page.waitForLoadState('networkidle').catch(() => {});

  return await takeSnapshot(page);
}

async function handleFill(args: Record<string, unknown>): Promise<string> {
  const selector = String(args['selector'] ?? '');
  const value = String(args['value'] ?? '');
  if (!selector) throw new Error('browser_fill: selector is required');

  const session = await getOrCreateSession();
  const { page } = session;

  log('INFO', `[BrowserTools] Filling "${selector}" with "${value}"`);
  await page.locator(selector).first().fill(value, { timeout: 10_000 });

  return JSON.stringify({ ok: true, url: page.url() });
}

async function handleSnapshot(_args: Record<string, unknown>): Promise<string> {
  const session = await getOrCreateSession();
  return await takeSnapshot(session.page);
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
        'Launch a headless browser, authenticate as the given persona, navigate to the URL, and return an ARIA snapshot of the page (ariaTree, testIds, locators, htmlSample). ' +
        'Must be called first before any other browser tool. Returns PageSnapshot JSON.',
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
        'Click an element on the current page using a Playwright locator expression ' +
        '(e.g. getByRole("button", { name: "Submit" }) or getByTestId("submit-btn")). ' +
        'Returns an updated ARIA snapshot after the click.',
      parameters: {
        type: 'object',
        properties: {
          selector: {
            type: 'string',
            description:
              'A Playwright locator string from a previous snapshot\'s locators array, e.g. "getByRole(\'button\', { name: \'Login\' })"',
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
        'Use a locator from the previous snapshot\'s locators array.',
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
        'Returns PageSnapshot JSON with ariaTree, testIds, locators, and htmlSample. ' +
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
  browser_close: handleClose,
};
