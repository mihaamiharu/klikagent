/// <reference lib="dom" />
import { chromium, Page } from 'playwright';
import { AriaNode, PageSnapshot } from '../types';
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

function htmlSample(html: string): string {
  return html.slice(0, 500);
}

async function capturePageSnapshot(page: Page, url: string): Promise<PageSnapshot> {
  await page.goto(url, { waitUntil: 'networkidle', timeout: 30_000 });
  await revealPass(page);

  // accessibility.snapshot() deprecated in Playwright 1.48+ — use ariaSnapshot on root
  const ariaTree = await page.locator('body').ariaSnapshot({ timeout: 5_000 })
    .then((yaml) => ({ role: 'WebArea', name: url, children: [{ role: 'generic', name: yaml }] } as AriaNode))
    .catch(() => ({ role: 'WebArea', name: url, children: [] } as AriaNode));

  const testIds = await page.$$eval('[data-testid]', (els) =>
    els.map((el) => el.getAttribute('data-testid') ?? '').filter(Boolean)
  );
  const bodyHtml = await page.$eval('body', (el) => el.outerHTML).catch(() => '');

  return {
    url,
    ariaTree: ariaTree ?? { role: 'WebArea', name: '', children: [] },
    testIds,
    htmlSample: htmlSample(bodyHtml),
  };
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

export async function captureSnapshot(url: string): Promise<PageSnapshot> {
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await authenticate(page);
    const snapshot = await capturePageSnapshot(page, url);
    return snapshot;
  } finally {
    await browser.close();
  }
}

export async function captureSnapshots(urls: string[]): Promise<PageSnapshot[]> {
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await authenticate(page);

    const snapshots: PageSnapshot[] = [];
    for (const url of urls) {
      log('INFO', `Crawler: capturing ${url}`);
      snapshots.push(await capturePageSnapshot(page, url));
    }
    return snapshots;
  } finally {
    await browser.close();
  }
}
