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

function htmlSample(html: string): string {
  return html.slice(0, 500);
}

async function capturePageSnapshot(page: Page, url: string): Promise<PageSnapshot> {
  await page.goto(url, { waitUntil: 'networkidle', timeout: 30_000 });
  await revealPass(page);

  const ariaTree = await page.locator('body').ariaSnapshot({ mode: 'ai', timeout: 5_000 })
    .catch(() => '');

  const testIds = await page.$$eval('[data-testid]', (els) =>
    els.map((el) => el.getAttribute('data-testid') ?? '').filter(Boolean)
  );
  const bodyHtml = await page.$eval('body', (el) => el.outerHTML).catch(() => '');

  return { url, ariaTree, testIds, htmlSample: htmlSample(bodyHtml) };
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
