/// <reference lib="dom" />
import { chromium, Page } from 'playwright';
import { PageSnapshot } from '../types';
import { log } from '../utils/logger';

const QA_BASE_URL = () => process.env.QA_BASE_URL ?? 'http://localhost:3000';
const QA_USER_EMAIL = () => process.env.QA_USER_EMAIL ?? '';
const QA_USER_PASSWORD = () => process.env.QA_USER_PASSWORD ?? '';

// Run standard reveal pass to expand collapsed elements, load lazy content
async function revealPass(page: Page): Promise<void> {
  await page.evaluate(() => {
    document.querySelectorAll<HTMLElement>('[aria-expanded="false"]').forEach((el) => el.click());
    document.querySelectorAll<HTMLElement>('details:not([open])').forEach((el) => el.setAttribute('open', ''));
  });
  await page.waitForTimeout(300);
}

// Compute the best Playwright locator string for every interactable element on the page.
// Priority: getByTestId > getByLabel > getByPlaceholder > getByRole(+name) > getByText
// Mirrors what the Playwright inspector shows when you hover over elements in codegen.
async function extractLocators(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const INTERACTIVE = 'button, a[href], input, select, textarea, [role="button"], [role="link"], [role="checkbox"], [role="radio"], [role="tab"], [role="menuitem"], [role="option"], [role="combobox"], [role="textbox"], [role="switch"]';

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
      // 1. data-testid
      const testId = el.getAttribute('data-testid');
      if (testId) return `getByTestId('${safeName(testId)}')`;

      const role = getRole(el);

      // 2. aria-label
      const ariaLabel = el.getAttribute('aria-label');
      if (ariaLabel) return `getByRole('${role}', { name: '${safeName(ariaLabel)}' })`;

      // 3. label association (inputs)
      const id = el.getAttribute('id');
      if (id) {
        const label = document.querySelector<HTMLElement>(`label[for="${id}"]`);
        const labelText = label?.textContent?.trim();
        if (labelText) return `getByLabel('${safeName(labelText)}')`;
      }

      // 4. placeholder
      const placeholder = (el as HTMLInputElement).placeholder;
      if (placeholder) return `getByPlaceholder('${safeName(placeholder)}')`;

      // 5. visible text (buttons and links only)
      const text = el.textContent?.trim();
      if (text && text.length <= 60 && (role === 'button' || role === 'link')) {
        return `getByRole('${role}', { name: '${safeName(text)}' })`;
      }

      return null;
    }

    const seen = new Set<string>();
    const locators: string[] = [];

    document.querySelectorAll(INTERACTIVE).forEach((el) => {
      const locator = bestLocator(el);
      if (locator && !seen.has(locator)) {
        seen.add(locator);
        locators.push(locator);
      }
    });

    return locators;
  });
}

function htmlSample(html: string): string {
  return html.slice(0, 500);
}

async function capturePageSnapshot(page: Page, url: string): Promise<PageSnapshot> {
  await page.goto(url, { waitUntil: 'networkidle', timeout: 30_000 });
  await revealPass(page);

  const [ariaTree, testIds, locators, bodyHtml] = await Promise.all([
    page.locator('body').ariaSnapshot({ mode: 'ai', timeout: 5_000 }).catch(() => ''),
    page.$$eval('[data-testid]', (els) => els.map((el) => el.getAttribute('data-testid') ?? '').filter(Boolean)),
    extractLocators(page),
    page.$eval('body', (el) => el.outerHTML).catch(() => ''),
  ]);

  return { url, ariaTree, testIds, locators, htmlSample: htmlSample(bodyHtml) };
}

async function authenticate(page: Page): Promise<void> {
  const loginUrl = `${QA_BASE_URL()}/login`;
  log('INFO', `Crawler: authenticating at ${loginUrl}`);
  await page.goto(loginUrl, { waitUntil: 'networkidle', timeout: 30_000 });

  // Best-effort auth — fill first email + password inputs found
  const emailInput = page.locator('input[type="email"], input[name="email"]').first();
  const passwordInput = page.locator('input[type="password"]').first();

  if (await emailInput.isVisible({ timeout: 5_000 }).catch(() => false)) {
    await emailInput.fill(QA_USER_EMAIL());
    await passwordInput.fill(QA_USER_PASSWORD());
    await page.keyboard.press('Enter');
    await page.waitForNavigation({ timeout: 10_000 }).catch(() => {});
  }
}

async function withAuthenticatedPage<T>(fn: (page: Page) => Promise<T>): Promise<T> {
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await authenticate(page);
    return await fn(page);
  } finally {
    await browser.close();
  }
}

export async function captureSnapshot(url: string): Promise<PageSnapshot> {
  return withAuthenticatedPage((page) => capturePageSnapshot(page, url));
}

export async function captureSnapshots(urls: string[]): Promise<PageSnapshot[]> {
  return withAuthenticatedPage(async (page) => {
    const snapshots: PageSnapshot[] = [];
    for (const url of urls) {
      log('INFO', `Crawler: capturing ${url}`);
      snapshots.push(await capturePageSnapshot(page, url));
    }
    return snapshots;
  });
}
