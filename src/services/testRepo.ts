import { commitFile, getFileOnBranch, ghRequest, ownerName } from './github';
import { log } from '../utils/logger';

async function readFile(repoName: string, path: string, ref = 'HEAD'): Promise<string | null> {
  return getFileOnBranch(repoName, ref, path);
}

async function listDir(repoName: string, path: string, ref = 'HEAD'): Promise<string[]> {
  const res = await ghRequest(`/repos/${ownerName()}/${repoName}/contents/${path}?ref=${encodeURIComponent(ref)}`);
  if (res.status === 404) return [];
  if (!res.ok) {
    log('WARN', `testRepo.listDir ${path}@${ref}: ${res.status}`);
    return [];
  }
  const data = await res.json() as Array<{ name: string; type: string }>;
  return Array.isArray(data) ? data.map((f) => f.name) : [];
}

// ─── Config ───────────────────────────────────────────────────────────────────

export async function getPersonas(repoName: string): Promise<string> {
  return await readFile(repoName, 'config/personas.ts') ?? '';
}

export async function getRouteMap(repoName: string): Promise<Record<string, string>> {
  const content = await readFile(repoName, 'config/routes.ts');
  if (!content) return {};
  const pairs = [...content.matchAll(/(\w+)\s*:\s*'([^']+)'/g)];
  return Object.fromEntries(pairs.map(([, k, v]) => [k, v]));
}

// Reads klikagent-tests/config/keywords.json — a user-maintained map of feature → keywords.
// Falls back to using route map keys as single-word keywords if the file doesn't exist.
// Example keywords.json: { "auth": ["login", "sign in"], "doctors": ["doctor", "physician"] }
export async function getKeywordMap(repoName: string): Promise<Record<string, string[]>> {
  const content = await readFile(repoName, 'config/keywords.json');
  if (content) {
    try {
      return JSON.parse(content) as Record<string, string[]>;
    } catch {
      log('WARN', '[testRepo] config/keywords.json is invalid JSON — falling back to route map keys');
    }
  }
  // Fallback: derive from route map keys (each feature name becomes its own keyword)
  const routeMap = await getRouteMap(repoName);
  return Object.fromEntries(Object.keys(routeMap).map((k) => [k, [k]]));
}

export async function getTsConfig(repoName: string): Promise<string> {
  return await readFile(repoName, 'tsconfig.json') ?? '';
}

export async function getPlaywrightConfig(repoName: string): Promise<string> {
  return await readFile(repoName, 'playwright.config.ts') ?? '';
}

// ─── Context docs ─────────────────────────────────────────────────────────────

export async function getContextDocs(repoName: string): Promise<Record<string, string>> {
  const files = await listDir(repoName, 'context');
  const entries = await Promise.all(
    files
      .filter((f) => f.endsWith('.md'))
      .map(async (f) => [f, await readFile(repoName, `context/${f}`) ?? ''] as [string, string])
  );
  return Object.fromEntries(entries.filter(([, v]) => v !== ''));
}

// ─── Page objects ─────────────────────────────────────────────────────────────

async function findPOMFile(repoName: string, feature: string, ref = 'HEAD'): Promise<string | null> {
  const names = await listDir(repoName, `pages/${feature}`, ref);
  return names.find((n) => n.endsWith('Page.ts')) ?? null;
}

export async function getExistingPOMNames(repoName: string, feature: string): Promise<string[]> {
  return listDir(repoName, `pages/${feature}`);
}

export async function listAllPOMs(repoName: string): Promise<string[]> {
  const features = await listDir(repoName, 'pages');
  const results = await Promise.all(
    features.map(async (f) => {
      const files = await listDir(repoName, `pages/${f}`);
      return files.filter((n) => n.endsWith('Page.ts')).map((n) => `pages/${f}/${n}`);
    })
  );
  return results.flat();
}

export async function getExistingPOM(repoName: string, feature: string): Promise<string | null> {
  const pomFile = await findPOMFile(repoName, feature);
  return pomFile ? readFile(repoName, `pages/${feature}/${pomFile}`) : null;
}

export async function getCurrentPOM(repoName: string, branch: string, feature: string): Promise<string | null> {
  const pomFile = await findPOMFile(repoName, feature, branch);
  return pomFile ? getFileOnBranch(repoName, branch, `pages/${feature}/${pomFile}`) : null;
}

// ─── Fixtures + helpers ───────────────────────────────────────────────────────

export async function getFixtures(repoName: string): Promise<string> {
  return await readFile(repoName, 'fixtures/index.ts') ?? '';
}

export async function getHelpers(repoName: string): Promise<Record<string, string>> {
  const content = await readFile(repoName, 'utils/helpers.ts');
  return content ? { 'helpers.ts': content } : {};
}

// ─── Existing tests ───────────────────────────────────────────────────────────

export async function getExistingTests(repoName: string, feature: string): Promise<Record<string, string>> {
  const files = await listDir(repoName, `tests/web/${feature}`);
  const entries = await Promise.all(
    files
      .filter((f) => f.endsWith('.spec.ts'))
      .map(async (f) => [f, await readFile(repoName, `tests/web/${feature}/${f}`) ?? ''] as [string, string])
  );
  return Object.fromEntries(entries.filter(([, v]) => v !== ''));
}

// ─── Branch-specific reads ────────────────────────────────────────────────────

// Finds a spec file for a ticketId by scanning the directory — resilient to any naming convention.
// Matches the first file starting with "${ticketId}" (e.g. "21.spec.ts" or "21-doctor-reviews.spec.ts").
async function findSpecFile(repoName: string, feature: string, ticketId: string, ref: string): Promise<string | null> {
  const files = await listDir(repoName, `tests/web/${feature}`, ref);
  return files.find((f) => f.startsWith(ticketId) && f.endsWith('.spec.ts')) ?? null;
}

// Reads the current spec for a ticket on a branch (works for both skeleton and enriched)
export async function getCurrentSpec(repoName: string, branch: string, ticketId: string, feature: string): Promise<string | null> {
  const file = await findSpecFile(repoName, feature, ticketId, branch);
  return file ? getFileOnBranch(repoName, branch, `tests/web/${feature}/${file}`) : null;
}

export async function getParentSpec(repoName: string, branch: string, parentTicketId: string, feature: string): Promise<string | null> {
  const file = await findSpecFile(repoName, feature, parentTicketId, branch);
  return file ? getFileOnBranch(repoName, branch, `tests/web/${feature}/${file}`) : null;
}

// ─── Write ────────────────────────────────────────────────────────────────────

export async function writeFile(repoName: string, branch: string, path: string, content: string, message: string): Promise<void> {
  await commitFile(repoName, branch, path, content, message);
}

// ─── Keyword map ──────────────────────────────────────────────────────────────
