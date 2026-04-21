import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { ownerName, testRepoName } from './github';
import { log } from '../utils/logger';

// ─── Env helpers ──────────────────────────────────────────────────────────────

function localClonePath(): string {
  const p = process.env.KLIKAGENT_TESTS_LOCAL_PATH;
  if (!p) throw new Error('KLIKAGENT_TESTS_LOCAL_PATH env var is not set');
  return p;
}

function githubToken(): string {
  const t = process.env.GITHUB_TOKEN;
  if (!t) throw new Error('GITHUB_TOKEN env var is not set');
  return t;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Ensures the local clone of klikagent-tests exists and is up to date.
 * Clones from GitHub if not present at KLIKAGENT_TESTS_LOCAL_PATH,
 * otherwise runs `git pull` to fetch the latest changes.
 * Returns the local clone path.
 */
function isGitRepo(dir: string): boolean {
  try {
    execFileSync('git', ['rev-parse', '--git-dir'], { cwd: dir, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

export async function ensureFreshClone(): Promise<string> {
  const clonePath = localClonePath();
  const token = githubToken();
  const repoUrl = `https://${token}@github.com/${ownerName()}/${testRepoName()}.git`;

  if (fs.existsSync(clonePath) && isGitRepo(clonePath)) {
    log('INFO', `[testRepoClone] Pulling latest changes in ${clonePath}`);
    execFileSync('git', ['pull'], {
      cwd: clonePath,
      stdio: 'pipe',
      timeout: 60_000,
    });
    log('INFO', '[testRepoClone] git pull complete');
  } else {
    log('INFO', `[testRepoClone] Cloning ${testRepoName()} into ${clonePath}`);
    execFileSync('git', ['clone', repoUrl, clonePath], {
      stdio: 'pipe',
      timeout: 120_000,
    });
    log('INFO', '[testRepoClone] Clone complete');
  }

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

  try {
    const stdout = execFileSync(
      'npx',
      ['playwright', 'test', fullSpecPath, '--reporter=list'],
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
    // execFileSync throws when exit code != 0; the error carries stdout/stderr
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
