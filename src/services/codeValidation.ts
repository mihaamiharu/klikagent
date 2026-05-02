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
  source: 'tsc' | 'eslint' | 'convention';
}

/**
 * Banned locator patterns that are syntactically valid TypeScript but
 * will fail at runtime. These catch common AI hallucinations before
 * expensive tsc/eslint runs.
 */
const BANNED_LOCATOR_PATTERNS: Array<{ pattern: RegExp; message: string }> = [
  {
    pattern: /\.locator\(\s*['"]link['"]\s*\)/,
    message: "page.locator('link') is not a valid CSS selector. Use page.getByRole('link') instead.",
  },
  {
    pattern: /\.locator\(\s*['"]button['"]\s*\)/,
    message: "page.locator('button') is too generic. Use getByRole('button', { name: '...' }) or getByTestId instead.",
  },
  {
    pattern: /\.locator\(\s*['"]div['"]\s*\)/,
    message: "page.locator('div') is too generic. Use getByRole, getByTestId, or getByText instead.",
  },
  {
    pattern: /\.locator\(\s*['"]span['"]\s*\)/,
    message: "page.locator('span') is too generic. Use getByRole, getByTestId, or getByText instead.",
  },
  {
    pattern: /\.locator\(\s*['"]input['"]\s*\)/,
    message: "page.locator('input') is too generic. Use getByRole, getByTestId, or getByLabel instead.",
  },
];

/**
 * Phase 0: Fast regex-based convention checks that catch AI hallucinations
 * before expensive tsc/eslint runs. Returns errors for any banned patterns
 * found in generated POM or spec files.
 */
export function runConventionCheck(files: FileEntry[]): ValidationError[] {
  const errors: ValidationError[] = [];

  for (const file of files) {
    const lines = file.content.split('\n');
    for (const [lineIdx, line] of lines.entries()) {
      for (const { pattern, message } of BANNED_LOCATOR_PATTERNS) {
        if (pattern.test(line)) {
          errors.push({
            filePath: file.path,
            line: lineIdx + 1,
            message,
            severity: 'error',
            source: 'convention',
          });
        }
      }
    }
  }

  return errors;
}

async function prepareTempClone(repoName: string, files: FileEntry[]): Promise<string> {
  const sourceDir = getRepoDirectory(repoName);
  const tempDir = path.join(os.tmpdir(), `klikagent-tsc-${Date.now()}-${Math.random().toString(36).slice(2)}`);

  log('INFO', `[codeValidation] Preparing temp clone: ${tempDir}`);

  // Copy repo contents (shallow copy of tracked files)
  await execFileAsync('cp', ['-r', sourceDir, tempDir], { timeout: 30000 });

  // Symlink node_modules to avoid copying
  const sourceNodeModules = path.join(sourceDir, 'node_modules');
  const tempNodeModules = path.join(tempDir, 'node_modules');
  try {
    await fs.access(sourceNodeModules);
    await fs.rm(tempNodeModules, { recursive: true, force: true });
    await fs.symlink(sourceNodeModules, tempNodeModules, 'dir');
  } catch {
    // node_modules may not exist, ignore
  }

  // Write generated files into temp clone
  for (const file of files) {
    const filePath = path.join(tempDir, file.path);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, file.content, 'utf8');
  }

  return tempDir;
}

async function cleanupTempClone(tempDir: string): Promise<void> {
  try {
    await fs.rm(tempDir, { recursive: true, force: true });
    log('INFO', `[codeValidation] Cleaned up temp clone: ${tempDir}`);
  } catch (err) {
    log('WARN', `[codeValidation] Failed to clean up temp clone ${tempDir}: ${(err as Error).message}`);
  }
}

/**
 * Run TypeScript compiler (`tsc --noEmit`) against the temp clone.
 * Returns parsed errors for the generated files.
 */
export async function runTypecheck(
  repoName: string,
  files: FileEntry[],
): Promise<ValidationError[]> {
  const tempDir = await prepareTempClone(repoName, files);
  const generatedPaths = new Set(files.map((f) => f.path));

  try {
    const { stderr } = await execFileAsync('npx', ['tsc', '--noEmit'], {
      cwd: tempDir,
      timeout: 120000,
    });
    // tsc exits 0 on success, but may still print to stderr
    return parseTscErrors(stderr || '', generatedPaths);
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    const output = e.stderr || e.stdout || '';
    return parseTscErrors(output, generatedPaths);
  } finally {
    await cleanupTempClone(tempDir);
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
 * Run ESLint against the generated files in the temp clone.
 * Returns parsed errors.
 */
export async function runLint(
  repoName: string,
  files: FileEntry[],
): Promise<ValidationError[]> {
  const tempDir = await prepareTempClone(repoName, files);
  const filePaths = files.map((f) => f.path);

  try {
    const { stdout } = await execFileAsync(
      'npx',
      ['eslint', '--format', 'json', '--no-eslintrc', ...filePaths],
      { cwd: tempDir, timeout: 60000 },
    );
    return parseEslintJson(stdout || '[]');
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string };
    // eslint exits 1 when there are errors
    return parseEslintJson(e.stdout || '[]');
  } finally {
    await cleanupTempClone(tempDir);
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
