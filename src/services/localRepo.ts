import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
import { log } from '../utils/logger';
import { token as getGitHubToken } from './github';

const execFileAsync = promisify(execFile);

const SYNC_INTERVAL_MS = parseInt(process.env.LOCAL_REPO_SYNC_INTERVAL_MS ?? '300000', 10); // default 5 min
const DEFAULT_CACHE_DIR = path.join(process.cwd(), '.klikagent-tests-cache');

function getRepoPath(repoName: string): string {
  const base = process.env.KLIKAGENT_TESTS_LOCAL_PATH ?? DEFAULT_CACHE_DIR;
  return path.join(base, repoName);
}

function getLastSyncPath(repoName: string): string {
  return path.join(getRepoPath(repoName), '.klikagent-last-sync');
}

async function isSyncNeeded(repoName: string): Promise<boolean> {
  try {
    const lastSync = await fs.readFile(getLastSyncPath(repoName), 'utf8');
    const lastSyncTime = parseInt(lastSync, 10);
    if (Number.isNaN(lastSyncTime)) return true;
    return Date.now() - lastSyncTime > SYNC_INTERVAL_MS;
  } catch {
    return true;
  }
}

async function markSynced(repoName: string): Promise<void> {
  await fs.writeFile(getLastSyncPath(repoName), String(Date.now()), 'utf8');
}

async function repoExists(repoName: string): Promise<boolean> {
  try {
    const gitDir = path.join(getRepoPath(repoName), '.git');
    const stat = await fs.stat(gitDir);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

async function getCloneUrl(repoName: string): Promise<string> {
  const owner = process.env.GITHUB_OWNER;
  if (!owner) throw new Error('GITHUB_OWNER env var is not set');
  const pat = process.env.GITHUB_TOKEN ?? process.env.GH_APP_TOKEN;
  if (pat) {
    return `https://x-access-token:${pat}@github.com/${owner}/${repoName}.git`;
  }
  try {
    const appToken = await getGitHubToken();
    if (appToken) {
      return `https://x-access-token:${appToken}@github.com/${owner}/${repoName}.git`;
    }
  } catch {
    // GitHub App credentials not available — fall through to unauthenticated
  }
  return `https://github.com/${owner}/${repoName}.git`;
}

async function cloneRepo(repoName: string): Promise<void> {
  const repoDir = getRepoPath(repoName);
  const cloneUrl = await getCloneUrl(repoName);
  log('INFO', `[localRepo] Cloning ${repoName} into ${repoDir}`);
  await fs.mkdir(path.dirname(repoDir), { recursive: true });
  await execFileAsync('git', ['clone', '--depth', '1', cloneUrl, repoDir], {
    timeout: 120000,
  });
  log('INFO', `[localRepo] Clone complete for ${repoName}`);
}

async function syncRepo(repoName: string): Promise<void> {
  const repoDir = getRepoPath(repoName);
  log('INFO', `[localRepo] Syncing ${repoName}`);
  await execFileAsync('git', ['fetch', 'origin'], {
    cwd: repoDir,
    timeout: 60000,
  });
  await execFileAsync('git', ['reset', '--hard', 'origin/main'], {
    cwd: repoDir,
    timeout: 30000,
  });
  log('INFO', `[localRepo] Sync complete for ${repoName}`);
}

async function ensureNodeModules(repoName: string): Promise<void> {
  const repoDir = getRepoPath(repoName);
  const packageJsonPath = path.join(repoDir, 'package.json');
  const nodeModulesPath = path.join(repoDir, 'node_modules');

  try {
    await fs.access(packageJsonPath);
  } catch {
    return; // no package.json, nothing to install
  }

  try {
    await fs.access(nodeModulesPath);
    return; // already installed
  } catch {
    // proceed to install
  }

  log('INFO', `[localRepo] Running npm ci for ${repoName}`);
  await execFileAsync('npm', ['ci'], {
    cwd: repoDir,
    timeout: 180000,
  });
  log('INFO', `[localRepo] npm ci complete for ${repoName}`);
}

/**
 * Ensures the local clone exists and is up to date.
 * Call this at the start of every task flow.
 */
export async function ensureRepo(repoName: string): Promise<void> {
  if (!(await repoExists(repoName))) {
    await cloneRepo(repoName);
    await ensureNodeModules(repoName);
    await markSynced(repoName);
    return;
  }

  if (await isSyncNeeded(repoName)) {
    await syncRepo(repoName);
    await markSynced(repoName);
  }

  // Opportunistic: install deps if they went missing
  await ensureNodeModules(repoName);
}

/**
 * Read a file from the local working tree (main branch).
 */
export async function readFile(repoName: string, filePath: string): Promise<string | null> {
  const fullPath = path.join(getRepoPath(repoName), filePath);
  try {
    return await fs.readFile(fullPath, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Read a file from a specific branch using git show.
 */
export async function readFileOnBranch(repoName: string, filePath: string, branch: string): Promise<string | null> {
  const repoDir = getRepoPath(repoName);
  try {
    const { stdout } = await execFileAsync('git', ['show', `${branch}:${filePath}`], {
      cwd: repoDir,
      timeout: 10000,
    });
    return stdout;
  } catch {
    return null;
  }
}

/**
 * List directory contents from the local working tree.
 */
export async function listDirectory(repoName: string, dirPath: string): Promise<string[]> {
  const fullPath = path.join(getRepoPath(repoName), dirPath);
  try {
    const entries = await fs.readdir(fullPath, { withFileTypes: true });
    return entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
  } catch {
    return [];
  }
}

export interface SearchResult {
  path: string;
  line: number;
  context: string;
}

/**
 * Search the local working tree for code patterns.
 * Returns up to 10 matches with 2 lines of context.
 * Default filePattern is '*.ts'.
 */
export async function searchCodebase(
  repoName: string,
  query: string,
  options: {
    filePattern?: string;
    path?: string;
  } = {},
): Promise<{ matches: SearchResult[]; truncated: boolean }> {
  const repoDir = getRepoPath(repoName);
  const searchPath = options.path ? path.join(repoDir, options.path) : repoDir;
  const filePattern = options.filePattern ?? '*.ts';

  const args = [
    '-r',
    '-n',
    '-B2',
    '-A2',
    '--include',
    filePattern,
    '--exclude-dir=.git',
    '--exclude-dir=node_modules',
    '--exclude-dir=dist',
    '--exclude-dir=.playwright-cli',
    '-m',
    '10',
    query,
    searchPath,
  ];

  let stdout: string;
  try {
    const result = await execFileAsync('grep', args, { timeout: 30000 });
    stdout = result.stdout;
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string };
    // grep exits 1 when no matches — not an error for us
    if (e.stdout) {
      stdout = e.stdout;
    } else {
      return { matches: [], truncated: false };
    }
  }

  return parseGrepOutput(stdout, repoDir);
}

function parseGrepOutput(stdout: string, repoDir: string): { matches: SearchResult[]; truncated: boolean } {
  const lines = stdout.split('\n');
  const matches: SearchResult[] = [];
  let current: { path: string; line: number; contextLines: string[] } | null = null;

  for (const line of lines) {
    const headerMatch = line.match(/^(.+):(\d+):(.+)$/);
    if (headerMatch) {
      if (current) {
        matches.push({
          path: path.relative(repoDir, current.path),
          line: current.line,
          context: current.contextLines.join('\n'),
        });
      }
      current = {
        path: headerMatch[1],
        line: parseInt(headerMatch[2], 10),
        contextLines: [headerMatch[3]],
      };
    } else if (current && (line.startsWith('--') || line.match(/^\s/))) {
      current.contextLines.push(line);
    }
  }

  if (current) {
    matches.push({
      path: path.relative(repoDir, current.path),
      line: current.line,
      context: current.contextLines.join('\n'),
    });
  }

  // If we got exactly 10 matches, assume grep truncated (it stopped at -m 10)
  const truncated = matches.length >= 10;

  return { matches: matches.slice(0, 10), truncated };
}

// ─── Branch-specific reads (for CI fix, review agents) ───────────────────────

/**
 * List directory contents from a specific branch using git ls-tree.
 */
export async function listDirectoryOnBranch(repoName: string, dirPath: string, branch: string): Promise<string[]> {
  const repoDir = getRepoPath(repoName);
  try {
    const { stdout } = await execFileAsync('git', ['ls-tree', '--name-only', branch, dirPath], {
      cwd: repoDir,
      timeout: 10000,
    });
    return stdout.split('\n').filter((n) => n.trim() !== '');
  } catch {
    return [];
  }
}

async function findPOMFileOnBranch(repoName: string, feature: string, branch: string): Promise<string | null> {
  const names = await listDirectoryOnBranch(repoName, `pages/${feature}`, branch);
  return names.find((n) => n.endsWith('Page.ts')) ?? null;
}

async function findSpecFileOnBranch(repoName: string, feature: string, ticketId: string, branch: string): Promise<string | null> {
  const files = await listDirectoryOnBranch(repoName, `tests/web/${feature}`, branch);
  return files.find((f) => f.startsWith(ticketId) && f.endsWith('.spec.ts')) ?? null;
}

export async function getCurrentSpecOnBranch(repoName: string, branch: string, ticketId: string, feature: string): Promise<string | null> {
  const file = await findSpecFileOnBranch(repoName, feature, ticketId, branch);
  return file ? readFileOnBranch(repoName, `tests/web/${feature}/${file}`, branch) : null;
}

export async function getCurrentPOMOnBranch(repoName: string, branch: string, feature: string): Promise<string | null> {
  const pomFile = await findPOMFileOnBranch(repoName, feature, branch);
  return pomFile ? readFileOnBranch(repoName, `pages/${feature}/${pomFile}`, branch) : null;
}

export async function getSpecPathOnBranch(repoName: string, branch: string, ticketId: string, feature: string): Promise<string | null> {
  const file = await findSpecFileOnBranch(repoName, feature, ticketId, branch);
  return file ? `tests/web/${feature}/${file}` : null;
}

// ─── Config helpers ───────────────────────────────────────────────────────────

export async function getRouteMap(repoName: string): Promise<Record<string, string>> {
  const content = await readFile(repoName, 'config/routes.ts');
  if (!content) return {};
  const pairs = [...content.matchAll(/(\w+)\s*:\s*'([^']+)'/g)];
  return Object.fromEntries(pairs.map(([, k, v]) => [k, v]));
}

export async function getKeywordMap(repoName: string): Promise<Record<string, string[]>> {
  const content = await readFile(repoName, 'config/keywords.json');
  if (content) {
    try {
      return JSON.parse(content) as Record<string, string[]>;
    } catch {
      log('WARN', '[localRepo] config/keywords.json is invalid JSON — falling back to route map keys');
    }
  }
  const routeMap = await getRouteMap(repoName);
  return Object.fromEntries(Object.keys(routeMap).map((k) => [k, [k]]));
}

export async function getTsConfig(repoName: string): Promise<string> {
  return await readFile(repoName, 'tsconfig.json') ?? '';
}

export async function getPlaywrightConfig(repoName: string): Promise<string> {
  return await readFile(repoName, 'playwright.config.ts') ?? '';
}

export async function getPersonas(repoName: string): Promise<string> {
  const content = await readFile(repoName, 'config/personas.ts') ?? '';
  if (!content) return '';

  // Parse the personas to extract a structured schema summary
  const schema = parsePersonasSchema(content);
  if (!schema) return content;

  // Return both the raw file and a clear schema summary for the agent
  return `${content}

## Persona Schema Summary (for reference)
Valid persona keys: ${schema.keys.join(', ')}
Valid properties on each persona: ${schema.properties.join(', ')}

Usage examples:
  personas.${schema.keys[0]}.email        // login credential
  personas.${schema.keys[0]}.password     // login credential
  personas.${schema.keys[0]}.displayName  // for UI assertions
  personas.${schema.keys[0]}.role         // for role-based assertions

NEVER invent a persona key or property that is not listed above.`;
}

/**
 * Extract persona keys and properties from raw personas.ts content.
 * Returns null if parsing fails.
 */
function parsePersonasSchema(content: string): { keys: string[]; properties: string[] } | null {
  const keys: string[] = [];
  const allProperties = new Set<string>();
  const entryPattern = /(\w+):\s*\{([^}]+)\}/g;
  let match: RegExpExecArray | null;

  while ((match = entryPattern.exec(content)) !== null) {
    const [, key, block] = match;
    keys.push(key);
    const fieldPattern = /(\w+):\s*'([^']*)'/g;
    let fieldMatch: RegExpExecArray | null;
    while ((fieldMatch = fieldPattern.exec(block)) !== null) {
      allProperties.add(fieldMatch[1]);
    }
  }

  if (keys.length === 0) return null;
  return { keys, properties: Array.from(allProperties) };
}

export async function getFixtures(repoName: string): Promise<string> {
  return await readFile(repoName, 'fixtures/index.ts') ?? '';
}

export async function getHelpers(repoName: string): Promise<Record<string, string>> {
  const content = await readFile(repoName, 'utils/helpers.ts');
  return content ? { 'helpers.ts': content } : {};
}

export async function getContextDocs(repoName: string): Promise<Record<string, string>> {
  const files = await listDirectory(repoName, 'context');
  const mdFiles = files.filter((f) => f.endsWith('.md'));
  const entries = await Promise.all(
    mdFiles.map(async (f) => {
      const content = await readFile(repoName, `context/${f}`);
      return [f, content ?? ''] as [string, string];
    }),
  );
  return Object.fromEntries(entries.filter(([, v]) => v !== ''));
}

export async function getExistingPOMNames(repoName: string, feature: string): Promise<string[]> {
  return listDirectory(repoName, `pages/${feature}`);
}

export async function listAllPoms(repoName: string): Promise<string[]> {
  const features = await listDirectory(repoName, 'pages');
  const featureDirs = features.filter((f) => f.endsWith('/')).map((f) => f.slice(0, -1));
  const results = await Promise.all(
    featureDirs.map(async (feature) => {
      const files = await listDirectory(repoName, `pages/${feature}`);
      return files.filter((n) => n.endsWith('Page.ts')).map((n) => `pages/${feature}/${n}`);
    }),
  );
  return results.flat();
}

export async function getExistingPOM(repoName: string, feature: string): Promise<string | null> {
  const files = await listDirectory(repoName, `pages/${feature}`);
  const pomFile = files.find((n) => n.endsWith('Page.ts'));
  if (!pomFile) return null;
  return readFile(repoName, `pages/${feature}/${pomFile}`);
}

export async function getExistingTests(repoName: string, feature: string): Promise<Record<string, string>> {
  const files = await listDirectory(repoName, `tests/web/${feature}`);
  const specFiles = files.filter((f) => f.endsWith('.spec.ts'));
  const entries = await Promise.all(
    specFiles.map(async (f) => {
      const content = await readFile(repoName, `tests/web/${feature}/${f}`);
      return [f, content ?? ''] as [string, string];
    }),
  );
  return Object.fromEntries(entries.filter(([, v]) => v !== ''));
}

/**
 * Returns the absolute path to the local repo directory.
 * Useful for Phase 3 temp clone operations.
 */
export function getRepoDirectory(repoName: string): string {
  return getRepoPath(repoName);
}
