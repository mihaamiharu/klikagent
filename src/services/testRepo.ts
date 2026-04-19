import { commitFile, getFileOnBranch } from './github';
import { log } from '../utils/logger';

const GITHUB_API = 'https://api.github.com';

function token(): string {
  const t = process.env.GITHUB_TOKEN;
  if (!t) throw new Error('GITHUB_TOKEN env var is not set');
  return t;
}

function owner(): string {
  const o = process.env.GITHUB_OWNER;
  if (!o) throw new Error('GITHUB_OWNER env var is not set');
  return o;
}

function repo(): string {
  const r = process.env.GITHUB_TEST_REPO;
  if (!r) throw new Error('GITHUB_TEST_REPO env var is not set');
  return r;
}

async function ghGet(path: string): Promise<Response> {
  return fetch(`${GITHUB_API}${path}`, {
    headers: {
      Authorization: `Bearer ${token()}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
}

async function readFile(path: string, ref = 'HEAD'): Promise<string | null> {
  const res = await ghGet(`/repos/${owner()}/${repo()}/contents/${path}?ref=${encodeURIComponent(ref)}`);
  if (res.status === 404) return null;
  if (!res.ok) {
    log('WARN', `testRepo.readFile ${path}@${ref}: ${res.status}`);
    return null;
  }
  const data = await res.json() as { content: string };
  return Buffer.from(data.content, 'base64').toString('utf8');
}

async function listDir(path: string, ref = 'HEAD'): Promise<string[]> {
  const res = await ghGet(`/repos/${owner()}/${repo()}/contents/${path}?ref=${encodeURIComponent(ref)}`);
  if (res.status === 404) return [];
  if (!res.ok) return [];
  const data = await res.json() as Array<{ name: string; type: string }>;
  return Array.isArray(data) ? data.map((f) => f.name) : [];
}

// ─── Config ───────────────────────────────────────────────────────────────────

export async function getRouteMap(): Promise<Record<string, string>> {
  const content = await readFile('config/routes.ts');
  if (!content) return {};
  // Parse the exported Record literal — extract key: 'value' pairs
  const pairs = [...content.matchAll(/(\w+)\s*:\s*'([^']+)'/g)];
  return Object.fromEntries(pairs.map(([, k, v]) => [k, v]));
}

export async function getTsConfig(): Promise<string> {
  return await readFile('tsconfig.json') ?? '';
}

export async function getPlaywrightConfig(): Promise<string> {
  return await readFile('playwright.config.ts') ?? '';
}

// ─── Context docs ─────────────────────────────────────────────────────────────

export async function getContextDocs(): Promise<Record<string, string>> {
  const files = await listDir('context');
  const mdFiles = files.filter((f) => f.endsWith('.md'));
  const entries = await Promise.all(
    mdFiles.map(async (f) => {
      const content = await readFile(`context/${f}`);
      return [f, content ?? ''] as [string, string];
    })
  );
  return Object.fromEntries(entries.filter(([, v]) => v !== ''));
}

// ─── Page objects ─────────────────────────────────────────────────────────────

export async function getExistingPOMNames(feature: string): Promise<string[]> {
  return listDir(`pages/${feature}`);
}

export async function getExistingPOM(feature: string): Promise<string | null> {
  const names = await getExistingPOMNames(feature);
  const pomFile = names.find((n) => n.endsWith('Page.ts'));
  if (!pomFile) return null;
  return readFile(`pages/${feature}/${pomFile}`);
}

export async function getCurrentPOM(branch: string, feature: string): Promise<string | null> {
  const names = await listDir(`pages/${feature}`, branch);
  const pomFile = names.find((n) => n.endsWith('Page.ts'));
  if (!pomFile) return null;
  return getFileOnBranch(repo(), branch, `pages/${feature}/${pomFile}`);
}

// ─── Fixtures + helpers ───────────────────────────────────────────────────────

export async function getFixtures(): Promise<string> {
  return await readFile('fixtures/index.ts') ?? '';
}

export async function getHelpers(): Promise<Record<string, string>> {
  const content = await readFile('utils/helpers.ts');
  return content ? { 'helpers.ts': content } : {};
}

// ─── Existing tests ───────────────────────────────────────────────────────────

export async function getExistingTests(feature: string): Promise<Record<string, string>> {
  const files = await listDir(`tests/web/${feature}`);
  const specFiles = files.filter((f) => f.endsWith('.spec.ts'));
  const entries = await Promise.all(
    specFiles.map(async (f) => {
      const content = await readFile(`tests/web/${feature}/${f}`);
      return [f, content ?? ''] as [string, string];
    })
  );
  return Object.fromEntries(entries.filter(([, v]) => v !== ''));
}

// ─── Branch-specific reads ────────────────────────────────────────────────────

export async function getSkeletonSpec(branch: string, ticketId: string, feature: string): Promise<string | null> {
  return getFileOnBranch(repo(), branch, `tests/web/${feature}/${ticketId}.spec.ts`);
}

export async function getCurrentSpec(branch: string, ticketId: string, feature: string): Promise<string | null> {
  return getFileOnBranch(repo(), branch, `tests/web/${feature}/${ticketId}.spec.ts`);
}

export async function getParentSpec(branch: string, parentTicketId: string, feature: string): Promise<string | null> {
  return getFileOnBranch(repo(), branch, `tests/web/${feature}/${parentTicketId}.spec.ts`);
}

// ─── Write ────────────────────────────────────────────────────────────────────

export async function writeFile(branch: string, path: string, content: string, message: string): Promise<void> {
  await commitFile(repo(), branch, path, content, message);
}
