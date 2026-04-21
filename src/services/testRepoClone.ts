import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { ownerName, testRepoName } from './github';
import { log } from '../utils/logger';

// ─── Env helpers ──────────────────────────────────────────────────────────────

function localClonePath(): string {
  const p = process.env.KLIKAGENT_TESTS_LOCAL_PATH;
  if (!p) throw new Error('KLIKAGENT_TESTS_LOCAL_PATH env var is not set');
  return p.trim();
}

function githubToken(): string {
  const t = process.env.GITHUB_TOKEN;
  if (!t) throw new Error('GITHUB_TOKEN env var is not set');
  return t.trim();
}

const GH_API = 'https://api.github.com';

async function ghFetch(path: string): Promise<unknown> {
  const res = await fetch(`${GH_API}${path}`, {
    headers: {
      Authorization: `Bearer ${githubToken()}`,
      Accept: 'application/vnd.github.v3+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!res.ok) {
    throw new Error(`GitHub API ${path} returned ${res.status} ${res.statusText}`);
  }
  return res.json();
}

async function getDefaultBranchSha(): Promise<string> {
  const repo = await ghFetch(`/repos/${ownerName()}/${testRepoName()}`) as { default_branch: string };
  const branch = await ghFetch(
    `/repos/${ownerName()}/${testRepoName()}/git/refs/heads/${repo.default_branch}`
  ) as { object: { sha: string } };
  return branch.object.sha;
}

async function getRepoTree(sha: string): Promise<Array<{ path: string; sha: string; type: string }>> {
  const tree = await ghFetch(
    `/repos/${ownerName()}/${testRepoName()}/git/trees/${sha}?recursive=1`
  ) as { tree: Array<{ path: string; sha: string; type: string }> };
  return tree.tree;
}

async function downloadBlob(sha: string): Promise<string> {
  const blob = await ghFetch(
    `/repos/${ownerName()}/${testRepoName()}/git/blobs/${sha}`
  ) as { content: string; encoding: string };
  if (blob.encoding === 'base64') {
    return Buffer.from(blob.content, 'base64').toString('utf8');
  }
  return Buffer.from(blob.content, 'utf8').toString('utf8');
}

async function downloadTree(
  tree: Array<{ path: string; sha: string; type: string }>,
  destDir: string
): Promise<void> {
  const batchSize = 100;
  const files = tree.filter((f) => f.type === 'blob');

  for (let i = 0; i < files.length; i += batchSize) {
    const batch = files.slice(i, i + batchSize);
    await Promise.all(
      batch.map(async (file) => {
        const content = await downloadBlob(file.sha);
        const filePath = path.join(destDir, file.path);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, content, 'utf8');
      })
    );
    log('INFO', `[testRepoClone] Downloaded batch ${i / batchSize + 1}/${Math.ceil(files.length / batchSize)}`);
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Ensures the local clone of klikagent-tests exists and is up to date.
 * Fetches the full repo tree via GitHub API and downloads all files.
 * Returns the local clone path.
 */
export async function ensureFreshClone(): Promise<string> {
  const clonePath = localClonePath();

  log('INFO', `[testRepoClone] Fetching repo tree for ${testRepoName()}`);
  const sha = await getDefaultBranchSha();
  const tree = await getRepoTree(sha);

  const existingShaPath = path.join(clonePath, '.klikagent-sha');
  const existingSha = fs.existsSync(existingShaPath)
    ? fs.readFileSync(existingShaPath, 'utf8').trim()
    : null;

  if (existingSha === sha) {
    log('INFO', `[testRepoClone] Repo already at SHA ${sha}, skipping download`);
    return clonePath;
  }

  log('INFO', `[testRepoClone] Downloading ${tree.filter((f) => f.type === 'blob').length} files to ${clonePath}`);
  fs.mkdirSync(clonePath, { recursive: true });
  await downloadTree(tree, clonePath);

  fs.writeFileSync(existingShaPath, sha, 'utf8');
  log('INFO', '[testRepoClone] Repo download complete');

  return clonePath;
}

/**
 * Writes content to a file path within the local clone.
 * Creates any missing parent directories automatically.
 */
export async function writeSpecToClone(specPath: string, content: string): Promise<void> {
  const clonePath = localClonePath();
  const fullPath = path.join(clonePath, specPath);
  const dir = path.dirname(fullPath);

  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(fullPath, content, 'utf8');
  log('INFO', `[testRepoClone] Wrote spec to ${fullPath}`);
}

/**
 * Runs playwright test for a specific spec file against the QA environment.
 * Returns { passed: boolean, output: string } — passed is true only if exit code is 0.
 */
export async function runPlaywrightTest(specPath: string): Promise<{ passed: boolean; output: string }> {
  const clonePath = localClonePath();
  const fullSpecPath = path.join(clonePath, specPath);

  log('INFO', `[testRepoClone] Running playwright test: ${fullSpecPath}`);

  execFileSync('npm', ['install', '--silent'], {
    cwd: clonePath,
    stdio: 'pipe',
    timeout: 120_000,
    env: { ...process.env },
  });

  try {
    const stdout = execFileSync(
      'npx',
      ['playwright@1.44.0', 'test', fullSpecPath, '--reporter=list'],
      {
        cwd: clonePath,
        stdio: 'pipe',
        timeout: 120_000,
        env: { ...process.env },
      }
    );
    const output = stdout.toString('utf8');
    log('INFO', '[testRepoClone] Playwright test passed');
    return { passed: true, output };
  } catch (err: unknown) {
    const execErr = err as { stdout?: Buffer | string; stderr?: Buffer | string; message?: string };
    const stdout = execErr.stdout ? execErr.stdout.toString() : '';
    const stderr = execErr.stderr ? execErr.stderr.toString() : '';
    const output = [stdout, stderr].filter(Boolean).join('\n').trim() ||
      (execErr.message ?? 'Unknown error');
    log('WARN', `[testRepoClone] Playwright test failed:\n${output}`);
    return { passed: false, output };
  }
}

/**
 * Returns MAX_SELF_CORRECTION_ATTEMPTS from env (default: 2).
 */
export function maxSelfCorrectionAttempts(): number {
  const raw = process.env.MAX_SELF_CORRECTION_ATTEMPTS;
  if (!raw) return 2;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 2;
}