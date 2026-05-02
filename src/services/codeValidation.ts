import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { FileEntry } from '../types';
import { getRepoDirectory } from './localRepo';
import { log } from '../utils/logger';

const execFileAsync = promisify(execFile);

export interface ValidationError {
  filePath: string;
  line: number;
  column?: number;
  message: string;
  severity: 'error' | 'warning';
  source: 'tsc' | 'eslint';
}

/**
 * Create a scratch directory that mirrors the source repo and symlinks
 * `node_modules` so tsc/eslint can run against it. The directory is meant
 * to outlive a single validation call so `tsc --incremental` can reuse its
 * build cache across attempts within the same task.
 *
 * The caller owns the lifecycle — call cleanupValidationDir once Phase 2 is
 * done (success or failure).
 */
export async function prepareValidationDir(repoName: string, taskId: string): Promise<string> {
  const sourceDir = getRepoDirectory(repoName);
  const safeId = taskId.replace(/[^a-zA-Z0-9_-]/g, '_');
  const dir = path.join(os.tmpdir(), `klikagent-validate-${repoName}-${safeId}-${Date.now()}`);

  log('INFO', `[codeValidation] Preparing validation dir: ${dir}`);
  await execFileAsync('cp', ['-r', sourceDir, dir], { timeout: 30000 });

  const sourceNodeModules = path.join(sourceDir, 'node_modules');
  const tempNodeModules = path.join(dir, 'node_modules');
  try {
    await fs.access(sourceNodeModules);
    await fs.rm(tempNodeModules, { recursive: true, force: true });
    await fs.symlink(sourceNodeModules, tempNodeModules, 'dir');
  } catch {
    // node_modules may not exist; ignore
  }

  return dir;
}

export async function cleanupValidationDir(dir: string): Promise<void> {
  try {
    await fs.rm(dir, { recursive: true, force: true });
    log('INFO', `[codeValidation] Cleaned up validation dir: ${dir}`);
  } catch (err) {
    log('WARN', `[codeValidation] Failed to clean up ${dir}: ${(err as Error).message}`);
  }
}

/**
 * Overwrite the generated files inside the validation directory with the
 * latest content. Creates parent directories as needed.
 */
async function writeGeneratedFiles(dir: string, files: FileEntry[]): Promise<void> {
  for (const file of files) {
    const filePath = path.join(dir, file.path);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, file.content, 'utf8');
  }
}

/**
 * Run `tsc --noEmit --incremental` against the validation directory.
 * The .tsbuildinfo cache lets repeat attempts within the same task skip
 * unchanged files.
 */
export async function runTypecheck(
  dir: string,
  files: FileEntry[],
): Promise<ValidationError[]> {
  await writeGeneratedFiles(dir, files);
  const generatedPaths = new Set(files.map((f) => f.path));

  try {
    const { stderr } = await execFileAsync(
      'npx',
      ['tsc', '--noEmit', '--incremental', '--tsBuildInfoFile', '.klikagent.tsbuildinfo'],
      { cwd: dir, timeout: 120000 },
    );
    return parseTscErrors(stderr || '', generatedPaths);
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    const output = e.stderr || e.stdout || '';
    return parseTscErrors(output, generatedPaths);
  }
}

function parseTscErrors(output: string, generatedPaths: Set<string>): ValidationError[] {
  const errors: ValidationError[] = [];
  // Match: path(line,col): error TSxxxx: message
  const pattern = /^(.+)\((\d+),(\d+)\):\s+error\s+(TS\d+):\s+(.+)$/gm;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(output)) !== null) {
    const filePath = match[1].trim();
    // Only include errors in generated files (ignore noise from existing code)
    const relativePath = path.relative(process.cwd(), filePath);
    const cleanPath = relativePath.startsWith('..') ? filePath : relativePath;
    if (!generatedPaths.has(cleanPath) && !generatedPaths.has(filePath)) {
      continue;
    }
    errors.push({
      filePath: cleanPath,
      line: parseInt(match[2], 10),
      column: parseInt(match[3], 10),
      message: `${match[4]}: ${match[5]}`,
      severity: 'error',
      source: 'tsc',
    });
  }

  return errors;
}

/**
 * Run ESLint against the generated files inside the validation directory.
 */
export async function runLint(
  dir: string,
  files: FileEntry[],
): Promise<ValidationError[]> {
  await writeGeneratedFiles(dir, files);
  const filePaths = files.map((f) => f.path);

  try {
    const { stdout } = await execFileAsync(
      'npx',
      ['eslint', '--format', 'json', '--no-eslintrc', ...filePaths],
      { cwd: dir, timeout: 60000 },
    );
    return parseEslintJson(stdout || '[]');
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string };
    // eslint exits 1 when there are errors
    return parseEslintJson(e.stdout || '[]');
  }
}

function parseEslintJson(jsonOutput: string): ValidationError[] {
  try {
    const reports = JSON.parse(jsonOutput) as Array<{
      filePath: string;
      messages: Array<{
        line: number;
        column: number;
        message: string;
        severity: number; // 1 = warning, 2 = error
      }>;
    }>;

    const errors: ValidationError[] = [];
    for (const report of reports) {
      for (const msg of report.messages) {
        errors.push({
          filePath: report.filePath,
          line: msg.line,
          column: msg.column,
          message: msg.message,
          severity: msg.severity === 2 ? 'error' : 'warning',
          source: 'eslint',
        });
      }
    }
    return errors;
  } catch {
    return [];
  }
}
