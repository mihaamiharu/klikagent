import { commitFile, getFileOnBranch, ghRequest, ownerName, testRepoName } from './github';
import { log } from '../utils/logger';

async function readFile(path: string, ref = 'HEAD'): Promise<string | null> {
  return getFileOnBranch(testRepoName(), ref, path);
}

async function listDir(path: string, ref = 'HEAD'): Promise<string[]> {
  const res = await ghRequest(`/repos/${ownerName()}/${testRepoName()}/contents/${path}?ref=${encodeURIComponent(ref)}`);
  if (res.status === 404) return [];
  if (!res.ok) {
    log('WARN', `testRepo.listDir ${path}@${ref}: ${res.status}`);
    return [];
  }
  const data = await res.json() as Array<{ name: string; type: string }>;
  return Array.isArray(data) ? data.map((f) => f.name) : [];
}

// ─── Config ───────────────────────────────────────────────────────────────────

export async function getRouteMap(): Promise<Record<string, string>> {
  const content = await readFile('config/routes.ts');
  if (!content) return {};
  const pairs = [...content.matchAll(/(\w+)\s*:\s*'([^']+)'/g)];
  return Object.fromEntries(pairs.map(([, k, v]) => [k, v]));
}

// Reads klikagent-tests/config/keywords.json — a user-maintained map of feature → keywords.
// Falls back to using route map keys as single-word keywords if the file doesn't exist.
// Example keywords.json: { "auth": ["login", "sign in"], "doctors": ["doctor", "physician"] }
export async function getKeywordMap(): Promise<Record<string, string[]>> {
  const content = await readFile('config/keywords.json');
  if (content) {
    try {
      return JSON.parse(content) as Record<string, string[]>;
    } catch {
      log('WARN', '[testRepo] config/keywords.json is invalid JSON — falling back to route map keys');
    }
  }
  // Fallback: derive from route map keys (each feature name becomes its own keyword)
  const routeMap = await getRouteMap();
  return Object.fromEntries(Object.keys(routeMap).map((k) => [k, [k]]));
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
  const entries = await Promise.all(
    files
      .filter((f) => f.endsWith('.md'))
      .map(async (f) => [f, await readFile(`context/${f}`) ?? ''] as [string, string])
  );
  return Object.fromEntries(entries.filter(([, v]) => v !== ''));
}

// ─── Page objects ─────────────────────────────────────────────────────────────

async function findPOMFile(feature: string, ref = 'HEAD'): Promise<string | null> {
  const names = await listDir(`pages/${feature}`, ref);
  return names.find((n) => n.endsWith('Page.ts')) ?? null;
}

export async function getExistingPOMNames(feature: string): Promise<string[]> {
  return listDir(`pages/${feature}`);
}

export async function listAllPOMs(): Promise<string[]> {
  const features = await listDir('pages');
  const results = await Promise.all(
    features.map(async (f) => {
      const files = await listDir(`pages/${f}`);
      return files.filter((n) => n.endsWith('Page.ts')).map((n) => `pages/${f}/${n}`);
    })
  );
  return results.flat();
}

export async function getExistingPOM(feature: string): Promise<string | null> {
  const pomFile = await findPOMFile(feature);
  return pomFile ? readFile(`pages/${feature}/${pomFile}`) : null;
}

export async function getCurrentPOM(branch: string, feature: string): Promise<string | null> {
  const pomFile = await findPOMFile(feature, branch);
  return pomFile ? getFileOnBranch(testRepoName(), branch, `pages/${feature}/${pomFile}`) : null;
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
  const entries = await Promise.all(
    files
      .filter((f) => f.endsWith('.spec.ts'))
      .map(async (f) => [f, await readFile(`tests/web/${feature}/${f}`) ?? ''] as [string, string])
  );
  return Object.fromEntries(entries.filter(([, v]) => v !== ''));
}

// ─── Branch-specific reads ────────────────────────────────────────────────────

// Finds a spec file for a ticketId by scanning the directory — resilient to any naming convention.
// Matches the first file starting with "${ticketId}" (e.g. "21.spec.ts" or "21-doctor-reviews.spec.ts").
async function findSpecFile(feature: string, ticketId: string, ref: string): Promise<string | null> {
  const files = await listDir(`tests/web/${feature}`, ref);
  return files.find((f) => f.startsWith(ticketId) && f.endsWith('.spec.ts')) ?? null;
}

// Reads the current spec for a ticket on a branch (works for both skeleton and enriched)
export async function getCurrentSpec(branch: string, ticketId: string, feature: string): Promise<string | null> {
  const file = await findSpecFile(feature, ticketId, branch);
  return file ? getFileOnBranch(testRepoName(), branch, `tests/web/${feature}/${file}`) : null;
}

export async function getParentSpec(branch: string, parentTicketId: string, feature: string): Promise<string | null> {
  const file = await findSpecFile(feature, parentTicketId, branch);
  return file ? getFileOnBranch(testRepoName(), branch, `tests/web/${feature}/${file}`) : null;
}

// ─── Write ────────────────────────────────────────────────────────────────────

export async function writeFile(branch: string, path: string, content: string, message: string): Promise<void> {
  await commitFile(testRepoName(), branch, path, content, message);
}

// ─── Keyword map ──────────────────────────────────────────────────────────────

