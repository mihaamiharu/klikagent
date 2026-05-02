import { QATask, CiTestFailure, FileEntry } from '../types';
import { PersonaMap } from './personas';
import { runQaAgent } from '../agents/qaAgent';
import { runAgent, TokenUsage } from './ai';
import { validateTypescriptHandler, validateTypescriptTool, PAGE_GETBY_IN_SPEC_PATTERN } from '../agents/tools/outputTools';
import { qaTools, createQaHandlers, browserHandlers } from '../agents/tools';
import { maxSelfCorrectionAttempts } from './testRepoClone';
import { runTypecheck, runLint, runConventionCheck, ValidationError } from './codeValidation';
import { log } from '../utils/logger';
import { dashboardBus } from '../dashboard/eventBus';
import { AgentTool } from '../types';
import { getPersonas } from './personas';
import { getCurrentSpecOnBranch, getCurrentPOMOnBranch, getSpecPathOnBranch } from './localRepo';

function getForbiddenPersonaStrings(personaMap: PersonaMap): string[] {
  const forbidden = new Set<string>();
  for (const persona of Object.values(personaMap)) {
    for (const [key, value] of Object.entries(persona)) {
      // Skip credentials — those are checked separately
      if (key === 'password' || key === 'email') continue;
      // Skip role — it's a structural category, not persona-specific data.
      // Role values like "admin", "doctor", "patient" appear naturally in
      // comments, test descriptions, and URL paths and cause false positives.
      if (key === 'role') continue;
      if (typeof value === 'string' && value.length > 2) {
        forbidden.add(value);
      }
    }
  }
  // Don't add persona keys as forbidden strings — they appear in
  // `personas.admin.displayName` references which are the correct pattern.
  return Array.from(forbidden);
}

function getSpecFile(files: FileEntry[]): FileEntry | undefined {
  return files.find((f) => f.role === 'spec');
}

function getPomFiles(files: FileEntry[]): FileEntry[] {
  return files.filter((f) => f.role === 'pom');
}

/**
 * Strip test descriptions from spec content before running convention checks.
 * Removes the first string argument from test() and test.describe() calls
 * so that persona names in test titles don't trigger false positives.
 */
function stripTestDescriptions(content: string): string {
  return content
    .replace(/test(?:\.describe)?\s*\(\s*`[^`]*`/g, 'test(`STRIPPED`')
    .replace(/test(?:\.describe)?\s*\(\s*"[^"]*"/g, 'test("STRIPPED"')
    .replace(/test(?:\.describe)?\s*\(\s*'[^']*'/g, "test('STRIPPED'");
}

/**
 * Strip route path strings (URLs) from spec content before convention checks.
 * Route paths like '/admin/dashboard' or '/appointments/book' contain persona
 * role names as URL segments and should not trigger forbidden-string matches.
 */
function stripRoutePaths(content: string): string {
  return content
    .replace(/['"]\/\w+\/\w+[^'"]*['"]/g, '"STRIPPED_ROUTE"')
    .replace(/['"]\/\w+['"]/g, '"STRIPPED_ROUTE"');
}

/**
 * Strip fixture parameter names from spec content before convention checks.
 * Fixture names like `asPatient`, `asAdmin`, `asDoctor` are convention-compliant
 * and should not trigger persona-data violations.
 */
function stripFixtureParameters(content: string): string {
  return content
    // Strip { asPatient }, { asAdmin }, { asDoctor } from test destructuring
    .replace(/\bas(?:Patient|Doctor|Admin)\w*\b/g, 'FIXTURE_PARAM')
    // Strip fixture names in goto calls: asPatient.goto(...)
    .replace(/\bFIXTURE_PARAM\.goto\b/g, 'fixture.goto');
}

/**
 * Strip URL regex patterns from spec content before convention checks.
 * Patterns like /\/admin/, /\/dashboard/ contain role names as URL segments
 * and should not trigger persona-data violations.
 */
function stripUrlRegexPatterns(content: string): string {
  return content
    // Strip regex URL patterns: /\/admin/, /\/appointments\/book/, etc.
    .replace(/\/\\\/\w+[^/]*\//g, '/STRIPPED_URL_REGEX/')
    // Strip string URL paths in toHaveURL assertions
    .replace(/toHaveURL\s*\(\s*['"`][^'"`]*['"`]\s*\)/g, 'toHaveURL("STRIPPED")');
}

/**
 * Strip single-line and multi-line comments from spec content before convention checks.
 * Comments like `// admin should be redirected` or `/* patient flow *\/` contain
 * role names as natural language and should not trigger persona-data violations.
 */
function stripComments(content: string): string {
  return content
    // Multi-line comments
    .replace(/\/\*[\s\S]*?\*\//g, '/* STRIPPED */')
    // Single-line comments
    .replace(/\/\/.*$/gm, '// STRIPPED');
}

function checkSpecConventions(specContent: string, personaMap: PersonaMap): string[] {
  const violations: string[] = [];
  const forbiddenStrings = getForbiddenPersonaStrings(personaMap);

  // Strip comments, test descriptions, route paths, fixture parameters, and URL regex patterns
  // before checking for forbidden strings. Comments like `// admin should be redirected`,
  // test titles like 'BA-2: admin role is redirected...', route patterns like '/admin/dashboard',
  // fixture names like { asAdmin }, and URL regexes like /\/admin/ should not trigger
  // persona-data violations.
  const checkableContent = stripUrlRegexPatterns(
    stripRoutePaths(
      stripTestDescriptions(
        stripFixtureParameters(
          stripComments(specContent)
        )
      )
    )
  );

  if (PAGE_GETBY_IN_SPEC_PATTERN.test(specContent)) {
    violations.push(
      'Spec contains direct `page.locator` or `page.getBy*` calls. ' +
      'All element interactions MUST be encapsulated within a Page Object Model (POM). ' +
      'Add properties or methods to your POM and use them in the spec instead (e.g. `await authPage.emailInput.fill(email)` NOT `await page.getByLabel("Email").fill(email)`).'
    );
  }

  for (const str of forbiddenStrings) {
    const escaped = str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`(?<!personas\\.)\\b${escaped}\\b`, 'i');
    if (regex.test(checkableContent)) {
      violations.push(
        `Spec contains hardcoded persona data ("${str}"). ` +
        'Assertions and locators must be persona-agnostic or use dynamic data from the imported `personas` object.'
      );
      break;
    }
  }

  if (/new \w+Page\(page\)/.test(specContent)) {
    violations.push(
      'Spec constructs a POM manually with `new PageClass(page)`. ' +
      'After registering the POM as a fixture, use it as a test parameter instead: ' +
      '`test("...", async ({ authPage }) => {})` — do NOT use a module-level ' +
      '`let authPage: AuthPage` variable populated in `beforeEach`.',
    );
  }

  if (/^\s*let \w+[Pp]age\s*:/m.test(specContent)) {
    violations.push(
      'Spec declares a module-level page object variable (`let xPage: XPage`). ' +
      'Receive it as a fixture parameter in each test function instead: ' +
      '`async ({ authPage }) => {}`.',
    );
  }

  if (/beforeEach[\s\S]{0,200}(gotoLogin|authPage\.login)/.test(specContent)) {
    violations.push(
      'Spec uses beforeEach to log in (authPage.gotoLogin / authPage.login). ' +
      'Feature tests must use persona fixtures instead: receive `asPatient`, `asDoctor`, or `asAdmin` ' +
      'as a test parameter — these provide a pre-authenticated Page via storageState. ' +
      'Remove the beforeEach block and construct the POM inline: ' +
      '`test("...", async ({ asPatient }) => { await asPatient.goto("/dashboard"); const pom = new MyPage(asPatient); ... })`.'
    );
  }

  if (/test\s*\.\s*each\s*\(/.test(specContent)) {
    violations.push(
      'Spec uses `test.each()` which is a Jest pattern and does not exist in Playwright. ' +
      'Write individual `test()` calls or use a `for...of` loop to iterate over test data.'
    );
  }

  if (/async\s*\(\s*\{\s*page\s*,/.test(specContent)) {
    violations.push(
      'Spec destructures bare `page` fixture. Feature tests must use persona fixtures: ' +
      '`asPatient`, `asDoctor`, or `asAdmin` — these provide a pre-authenticated Page via storageState.'
    );
  }

  const knownEmails = new Set(Object.values(personaMap).map((p) => p.email));
  const loginEmailPattern = /\.\s*login\s*\(\s*['"]([^'"]*@[^'"]*)['"]/g;
  let loginEmailMatch: RegExpExecArray | null;
  while ((loginEmailMatch = loginEmailPattern.exec(specContent)) !== null) {
    const email = loginEmailMatch[1];
    if (knownEmails.has(email)) {
      const validKeys = Object.keys(personaMap).join(', ');
      violations.push(
        `Spec passes a hardcoded persona email ("${email}") to a login call. ` +
        `Use the personas object instead: \`authPage.login(personas.patient.email, personas.patient.password)\`. ` +
        `Valid persona keys are: ${validKeys}. ` +
        'For negative tests with deliberately-invalid credentials, a literal like \'nonexistent@example.com\' is correct — do NOT invent a personas key.',
      );
      break;
    }
  }

  const reportedPersonaViolations = new Set<string>();
  const personaAccessPattern = /personas\.(\w+)\.(\w+)/g;
  let personaAccessMatch: RegExpExecArray | null;
  while ((personaAccessMatch = personaAccessPattern.exec(specContent)) !== null) {
    const key = personaAccessMatch[1];
    const prop = personaAccessMatch[2];
    if (!(key in personaMap)) {
      const violationKey = `key:${key}`;
      if (!reportedPersonaViolations.has(violationKey)) {
        reportedPersonaViolations.add(violationKey);
        const validKeys = Object.keys(personaMap).join(', ');
        // Find the line containing this reference for context
        const lines = specContent.split('\n');
        const lineIndex = lines.findIndex(l => l.includes(`personas.${key}.${prop}`));
        const lineContext = lineIndex >= 0 ? ` (line ${lineIndex + 1}: ${lines[lineIndex].trim().slice(0, 80)})` : '';
        violations.push(
          `Spec references \`personas.${key}\` which is not a valid persona key${lineContext}. ` +
          `Valid keys are: ${validKeys}. ` +
          `FIX: Replace \`personas.${key}\` with an existing key that matches the test scenario. ` +
          `For access-control tests, use the persona whose role matches the acceptance criteria. ` +
          `For deliberately-invalid credentials, use a string literal like 'nonexistent@example.com' instead of inventing a persona key.`,
        );
      }
      continue;
    }
    const validProps = Object.keys(personaMap[key]);
    if (!validProps.includes(prop)) {
      const violationKey = `prop:${key}.${prop}`;
      if (!reportedPersonaViolations.has(violationKey)) {
        reportedPersonaViolations.add(violationKey);
        const lines = specContent.split('\n');
        const lineIndex = lines.findIndex(l => l.includes(`personas.${key}.${prop}`));
        const lineContext = lineIndex >= 0 ? ` (line ${lineIndex + 1}: ${lines[lineIndex].trim().slice(0, 80)})` : '';
        violations.push(
          `Spec references \`personas.${key}.${prop}\` which is not a valid property${lineContext}. ` +
          `Valid properties for \`personas.${key}\` are: ${validProps.join(', ')}. ` +
          `FIX: Replace \`.${prop}\` with a valid property like .displayName, .email, .password, or .role.`,
        );
      }
    }
  }

  return violations;
}

function checkPomConventions(pomFiles: FileEntry[], personaMap: PersonaMap): string[] {
  const violations: string[] = [];
  const forbiddenStrings = getForbiddenPersonaStrings(personaMap);

  for (const { content, path: pomPath } of pomFiles) {
    for (const str of forbiddenStrings) {
      const escaped = str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(`\\b${escaped}\\b`, 'i');
      if (regex.test(content)) {
        violations.push(
          `${pomPath}: POM contains hardcoded persona data ("${str}"). ` +
          'POM locators and assertions must be dynamic and parameterized. ' +
          'Use methods that accept arguments like `async expectUserProfile(name: string)` instead of static properties.'
        );
        break;
      }
    }
  }

  return violations;
}

/** Structural checks that apply to the entire file set, not just individual files. */
function checkStructuralIssues(files: FileEntry[]): string[] {
  const violations: string[] = [];

  // Check for unauthorized fixture files — only fixtures/index.ts is allowed
  const fixtureFiles = files.filter((f) => f.path.startsWith('fixtures/') && f.path !== 'fixtures/index.ts');
  for (const f of fixtureFiles) {
    violations.push(
      `Unauthorized fixture file: "${f.path}". Feature POMs must NOT be registered as fixtures. ` +
      'Remove this file and construct the POM inline in the spec using persona fixtures (asPatient, asDoctor, asAdmin).'
    );
  }

  // Check for Jest patterns in any file
  for (const f of files.filter((f) => f.path.endsWith('.spec.ts'))) {
    if (/describe\s*\.\s*each\s*\(/.test(f.content)) {
      violations.push(
        `${f.path}: Uses \`describe.each()\` which is a Jest pattern and does not exist in Playwright. ` +
        'Write individual test.describe() blocks instead.'
      );
    }
  }

  // Check that spec import paths for POMs are correct (should be 3 levels up from tests/web/feature/)
  for (const f of files.filter((f) => f.role === 'spec')) {
    const pomImportMatch = f.content.match(/import\s*{[^}]*Page[^}]*}\s*from\s*['"]([^'"]+)['"]/g);
    if (pomImportMatch) {
      for (const imp of pomImportMatch) {
        const pathMatch = imp.match(/from\s*['"]([^'"]+)['"]/);
        if (pathMatch) {
          const importPath = pathMatch[1];
          // Specs in tests/web/feature/ need 3 levels up to reach pages/
          if (!importPath.startsWith('../../../') && importPath.includes('pages/')) {
            violations.push(
              `${f.path}: POM import path "${importPath}" is incorrect. ` +
              `Specs in tests/web/feature/ must use '../../../pages/...' (3 levels up). ` +
              `Fix to: import { ... } from '../../../pages/feature/ClassName';`
            );
          }
        }
      }
    }
  }

  return violations;
}

function formatFilesForPrompt(files: FileEntry[]): string {
  return files.map((f) => `### ${f.path} (role: ${f.role})\n\`\`\`typescript\n${f.content}\n\`\`\``).join('\n\n');
}

function mergeFiles(current: FileEntry[], changed: FileEntry[]): FileEntry[] {
  const merged = [...current];
  for (const file of changed) {
    const idx = merged.findIndex((f) => f.path === file.path);
    if (idx !== -1) merged[idx] = file;
    else merged.push(file);
  }
  return merged;
}

// ─── Parallel convention fix helpers ─────────────────────────────────────────

interface FileFixTask {
  filePath: string;
  violations: string[];
}

interface FixAgentResult {
  filePath: string;
  changedFiles: FileEntry[];
  tokenUsage: TokenUsage;
  remainingViolations: number;
  success: boolean;
}

/**
 * Extract the target file path from a violation message.
 * Convention violations either start with a file path (POM/structural)
 * or belong to the spec file (spec conventions).
 */
function extractTargetFile(violation: string, files: FileEntry[]): string {
  // POM violations start with the file path: "pages/auth/AuthPage.ts: POM contains..."
  const pathMatch = violation.match(/^([a-zA-Z0-9_\-/.]+\.(?:ts|js)):/);
  if (pathMatch) return pathMatch[1];

  // Structural violations reference a file: "tests/web/auth/auth.spec.ts: Uses..."
  const structMatch = violation.match(/^([a-zA-Z0-9_\-/.]+\.spec\.ts):/);
  if (structMatch) return structMatch[1];

  // Spec convention violations (no path prefix) → target the spec file
  const specFile = getSpecFile(files);
  return specFile?.path ?? 'spec.ts';
}

/**
 * Partition violations by target file path.
 */
function partitionViolationsByFile(violations: string[], files: FileEntry[]): FileFixTask[] {
  const byPath = new Map<string, string[]>();
  for (const v of violations) {
    const targetPath = extractTargetFile(v, files);
    const existing = byPath.get(targetPath) ?? [];
    existing.push(v);
    byPath.set(targetPath, existing);
  }
  return Array.from(byPath.entries()).map(([filePath, violations]) => ({ filePath, violations }));
}

/**
 * Build the context files for a fix agent: the target file + the spec file.
 */
function buildContextForTask(task: FileFixTask, files: FileEntry[]): FileEntry[] {
  const target = files.find((f) => f.path === task.filePath);
  const spec = getSpecFile(files);
  const context: FileEntry[] = [];
  if (target) context.push(target);
  if (spec && spec.path !== task.filePath) context.push(spec);
  return context;
}

/**
 * Run a batch of fix tasks with bounded concurrency.
 * Each task fixes all its violations in one agent call.
 * Failed tasks are caught and returned with success=false (partial success).
 */
async function runParallelFixRound(
  tasks: FileFixTask[],
  files: FileEntry[],
  personaMap: PersonaMap,
  concurrency: number,
): Promise<FixAgentResult[]> {
  const results: FixAgentResult[] = [];

  // Bounded concurrency pool
  const queue = [...tasks];
  const inFlight: Promise<void>[] = [];

  const runOne = async (task: FileFixTask) => {
    const contextFiles = buildContextForTask(task, files);
    const violationList = task.violations.join('\n\n');

    try {
      const { args, tokenUsage: fixUsage } = await runAgent(
        `Fix ALL convention violations listed below. Rules:
- Fix ONLY what is listed — do not change any other logic, test structure, or assertions
- Each fix should be the minimal change needed
- Do NOT "helpfully" fix violations in other files — those are handled by other agents
- Output ONLY the files you changed in your done() call`,
        `VIOLATIONS for ${task.filePath}:\n${violationList}\n\n${formatFilesForPrompt(contextFiles)}`,
        fixFilesTools,
        validateTypescriptHandler,
        { maxIterations: 10 },
      );

      const changedFiles = (args.files as FileEntry[] | undefined) ?? [];
      // Count remaining violations in the changed files
      let remainingCount = 0;
      for (const cf of changedFiles) {
        if (cf.role === 'spec') {
          remainingCount += checkSpecConventions(cf.content, personaMap).length;
        } else if (cf.role === 'pom') {
          remainingCount += checkPomConventions([cf], personaMap).length;
        }
      }

      results.push({
        filePath: task.filePath,
        changedFiles,
        tokenUsage: fixUsage,
        remainingViolations: remainingCount,
        success: true,
      });
    } catch (err) {
      log('WARN', `[selfCorrection] Parallel fix agent failed for ${task.filePath}: ${(err as Error).message}`);
      results.push({
        filePath: task.filePath,
        changedFiles: [],
        tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, costUSD: 0 },
        remainingViolations: task.violations.length,
        success: false,
      });
    }
  };

  while (queue.length > 0 || inFlight.length > 0) {
    while (queue.length > 0 && inFlight.length < concurrency) {
      const task = queue.shift()!;
      inFlight.push(runOne(task).then(() => {
        const idx = inFlight.findIndex(p => p);
        inFlight.splice(idx, 1);
      }));
    }
    if (inFlight.length > 0) {
      await Promise.race(inFlight);
    }
  }

  return results;
}

/**
 * Merge results from parallel fix agents.
 * If two agents modify the same file, keep the one with fewer remaining violations.
 */
function mergeFixResults(base: FileEntry[], results: FixAgentResult[]): FileEntry[] {
  const merged = [...base];
  const fileModifications = new Map<string, FixAgentResult[]>();

  // Group results by which files they modified
  for (const result of results) {
    if (!result.success || result.changedFiles.length === 0) continue;
    for (const cf of result.changedFiles) {
      const existing = fileModifications.get(cf.path) ?? [];
      existing.push(result);
      fileModifications.set(cf.path, existing);
    }
  }

  // Apply modifications — resolve conflicts by keeping the agent with fewer remaining violations
  for (const [filePath, modifications] of fileModifications) {
    if (modifications.length === 1) {
      // No conflict — apply directly
      const changedFile = modifications[0].changedFiles.find((f) => f.path === filePath);
      if (changedFile) {
        const idx = merged.findIndex((f) => f.path === filePath);
        if (idx !== -1) merged[idx] = changedFile;
      }
    } else {
      // Conflict — pick the agent with the fewest remaining violations
      const best = modifications.reduce((a, b) =>
        a.remainingViolations <= b.remainingViolations ? a : b
      );
      log('WARN', `[selfCorrection] Merge conflict on ${filePath} — keeping fix from agent with ${best.remainingViolations} remaining violations`);
      const changedFile = best.changedFiles.find((f) => f.path === filePath);
      if (changedFile) {
        const idx = merged.findIndex((f) => f.path === filePath);
        if (idx !== -1) merged[idx] = changedFile;
      }
    }
  }

  return merged;
}

const fixFilesDoneTool: AgentTool = {
  type: 'function',
  function: {
    name: 'done',
    description: 'Submit corrected files. Include ONLY the files you changed. Unchanged files will be preserved.',
    parameters: {
      type: 'object',
      properties: {
        files: {
          type: 'array',
          description: 'Only the files that changed. Omit files you did not modify.',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'Repo-relative file path' },
              content: { type: 'string', description: 'Full updated file content' },
              role: { type: 'string', enum: ['spec', 'pom', 'fixture', 'extra'] },
            },
            required: ['path', 'content', 'role'],
          },
        },
      },
      required: ['files'],
    },
  },
};

export interface SelfCorrectionResult {
  feature: string;
  files: FileEntry[];
  affectedPaths: string;
  tokenUsage: TokenUsage;
  warned: boolean;
  warningMessage?: string;
}

function addTokenUsage(acc: TokenUsage, next: TokenUsage): TokenUsage {
  return {
    promptTokens: acc.promptTokens + next.promptTokens,
    completionTokens: acc.completionTokens + next.completionTokens,
    totalTokens: acc.totalTokens + next.totalTokens,
    costUSD: acc.costUSD + next.costUSD,
  };
}

// Convention and TS fix agents only need validate_typescript + their done() — no browser tools.
const fixFilesTools: AgentTool[] = [validateTypescriptTool, fixFilesDoneTool];

// CI fix agent DOES need browser tools — it navigates to verify actual vs expected values.
const ciFixTools: AgentTool[] = [...qaTools.filter((t) => t.function.name !== 'done'), fixFilesDoneTool];

export async function runWithSelfCorrection(
  task: QATask,
  branch: string,
): Promise<SelfCorrectionResult> {
  const maxAttempts = maxSelfCorrectionAttempts();
  const repoName = task.outputRepo;

  // Step 1: Initial QA agent run
  log('INFO', '[selfCorrection] Running initial qaAgent pass');
  const qaResult = await runQaAgent(task, branch, repoName);
  const feature = qaResult.feature;
  let files = qaResult.files.map((f) => ({ ...f, role: f.role as FileEntry['role'] }));
  const affectedPaths = qaResult.affectedPaths;
  let tokenUsage = qaResult.tokenUsage;

  // Close any browser session left open by the QA agent
  try {
    await browserHandlers.browser_close({});
  } catch {
    // ignore
  }

  // Step 2: Convention check — fix violations in parallel by file, re-check after each round.
  const personaMap = await getPersonas(repoName, []);
  const MAX_CONVENTION_ROUNDS = maxAttempts;
  const CONCURRENCY_LIMIT = 2;

  for (let round = 1; round <= MAX_CONVENTION_ROUNDS; round++) {
    const specFile = getSpecFile(files);
    const pomFiles = getPomFiles(files);
    const specViolations = specFile ? checkSpecConventions(specFile.content, personaMap) : [];
    const pomViolations = checkPomConventions(pomFiles, personaMap);
    const allViolations = [...specViolations, ...pomViolations];

    if (allViolations.length === 0) break;

    log('WARN', `[selfCorrection] Convention round ${round}/${MAX_CONVENTION_ROUNDS}: ${allViolations.length} violation(s) across files`);
    dashboardBus.emitEvent('correction', 'warn', `Convention round ${round}`, { violations: allViolations.length });

    // Partition violations by target file
    const tasks = partitionViolationsByFile(allViolations, files);
    log('INFO', `[selfCorrection] Partitioned into ${tasks.length} parallel fix task(s)`);

    // Run fix agents in parallel with bounded concurrency
    const results = await runParallelFixRound(tasks, files, personaMap, CONCURRENCY_LIMIT);

    // Merge results (partial success — failed agents are skipped)
    const successfulResults = results.filter((r) => r.success && r.changedFiles.length > 0);
    const failedCount = results.length - successfulResults.length;
    const roundTokenUsage = results.reduce((acc, r) => addTokenUsage(acc, r.tokenUsage), { promptTokens: 0, completionTokens: 0, totalTokens: 0, costUSD: 0 });
    tokenUsage = addTokenUsage(tokenUsage, roundTokenUsage);

    files = mergeFixResults(files, results);

    if (failedCount > 0) {
      log('WARN', `[selfCorrection] ${failedCount} fix agent(s) failed in round ${round} — violations will be retried next round`);
    }
    log('INFO', `[selfCorrection] Convention round ${round} complete — ${successfulResults.length} agent(s) succeeded, $${roundTokenUsage.costUSD.toFixed(4)} USD`);
    dashboardBus.emitEvent('correction', 'info', `Convention round ${round} complete`, { tokenUsage: roundTokenUsage, agentsSucceeded: successfulResults.length, agentsFailed: failedCount });

    if (round === MAX_CONVENTION_ROUNDS) {
      const remainingSpec = getSpecFile(files);
      const remainingPoms = getPomFiles(files);
      const remaining = [
        ...(remainingSpec ? checkSpecConventions(remainingSpec.content, personaMap) : []),
        ...checkPomConventions(remainingPoms, personaMap),
      ];
      if (remaining.length > 0) {
        log('WARN', `[selfCorrection] ${remaining.length} convention violation(s) remain after ${MAX_CONVENTION_ROUNDS} rounds: ${remaining.join('; ')}`);
        dashboardBus.emitEvent('correction', 'warn', 'Convention violations remain after max rounds', { violations: remaining });
      }
    }
  }

  // ─── Phase 1: Fast validation (convention + AST) ────────────────────────────
  // Phase 0: Banned locator pattern check (catches AI hallucinations before AST)
  let conventionCheckErrors: Array<{ path: string; line: number; message: string }> = [];
  for (const file of files) {
    const violations = runConventionCheck([file]);
    for (const v of violations) {
      conventionCheckErrors.push({ path: v.filePath, line: v.line, message: v.message });
    }
  }

  // Already done above. Now run AST validation on all .ts files.
  // If AST errors exist, combine with any remaining convention errors and fix together.
  const tsFiles = files.filter((f) => f.path.endsWith('.ts'));
  let astErrors: Array<{ path: string; line: number; message: string }> = [];
  for (const file of tsFiles) {
    const fileType: 'spec' | 'pom' | 'generic' =
      file.role === 'spec' ? 'spec' : file.role === 'pom' ? 'pom' : 'generic';
    const tsResultRaw = await validateTypescriptHandler.validate_typescript({ code: file.content, fileType });
    const tsResult = JSON.parse(
      typeof tsResultRaw === 'string' ? tsResultRaw : JSON.stringify(tsResultRaw)
    ) as { valid: boolean; errors: Array<{ line: number; message: string }> };
    if (!tsResult.valid) {
      for (const err of tsResult.errors) {
        astErrors.push({ path: file.path, line: err.line, message: err.message });
      }
    }
  }

  // Fix AST errors (if any) together with any lingering convention issues
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const specFile = getSpecFile(files);
    const pomFiles = getPomFiles(files);
    const specViolations = specFile ? checkSpecConventions(specFile.content, personaMap) : [];
    const pomViolations = checkPomConventions(pomFiles, personaMap);
    const structuralIssues = checkStructuralIssues(files);
    const conventionErrors = [...specViolations, ...pomViolations, ...structuralIssues];

    if (astErrors.length === 0 && conventionCheckErrors.length === 0 && conventionErrors.length === 0) {
      log('INFO', `[selfCorrection] Phase 1 valid${attempt > 1 ? ` after ${attempt - 1} correction(s)` : ''}`);
      dashboardBus.emitEvent('validation', 'info', 'Phase 1 (fast) validation passed', { valid: true });
      break;
    }

    const combinedErrors = [
      ...conventionErrors.map((m) => `CONVENTION: ${m}`),
      ...conventionCheckErrors.map((e) => `BANNED_LOCATOR: ${e.path}(${e.line}): ${e.message}`),
      ...astErrors.map((e) => `AST: ${e.path}(${e.line}): ${e.message}`),
    ].join('\n');

    log('WARN', `[selfCorrection] Phase 1 errors on attempt ${attempt}/${maxAttempts}`);
    dashboardBus.emitEvent('validation', 'warn', 'Phase 1 errors found', { errors: combinedErrors });

    if (attempt === maxAttempts) {
      log('WARN', `[selfCorrection] Phase 1 exhausted after ${maxAttempts} attempts`);
      break;
    }

    const { args, tokenUsage: fixUsage } = await runAgent(
      `Fix the errors listed below. Rules:
- Fix ONLY what is listed — do not change any other logic
- For convention errors: apply the suggested fix pattern
- For AST errors: fix the TypeScript syntax/type issue
- Output ONLY the changed files in your done() call`,
      `ERRORS:\n${combinedErrors}\n\n${formatFilesForPrompt(files)}`,
      fixFilesTools,
      validateTypescriptHandler,
      { maxIterations: 10 },
    );
    tokenUsage = addTokenUsage(tokenUsage, fixUsage);
    const changedFiles = (args.files as FileEntry[] | undefined) ?? [];
    files = mergeFiles(files, changedFiles);
    log('INFO', `[selfCorrection] Applied Phase 1 correction ${attempt}`);
    dashboardBus.emitEvent('correction', 'info', `Applied Phase 1 correction ${attempt}`, { tokenUsage: fixUsage });

    // Re-run AST validation after fix
    astErrors = [];
    for (const file of files.filter((f) => f.path.endsWith('.ts'))) {
      const fileType: 'spec' | 'pom' | 'generic' =
        file.role === 'spec' ? 'spec' : file.role === 'pom' ? 'pom' : 'generic';
      const tsResultRaw = await validateTypescriptHandler.validate_typescript({ code: file.content, fileType });
      const tsResult = JSON.parse(
        typeof tsResultRaw === 'string' ? tsResultRaw : JSON.stringify(tsResultRaw)
      ) as { valid: boolean; errors: Array<{ line: number; message: string }> };
      if (!tsResult.valid) {
        for (const err of tsResult.errors) {
          astErrors.push({ path: file.path, line: err.line, message: err.message });
        }
      }
    }

    // Re-run banned locator check after fix
    conventionCheckErrors = [];
    for (const file of files) {
      const violations = runConventionCheck([file]);
      for (const v of violations) {
        conventionCheckErrors.push({ path: v.filePath, line: v.line, message: v.message });
      }
    }
  }

  // ─── Phase 2: Slow validation (tsc + eslint) ────────────────────────────────
  // Only run if Phase 1 passed (no remaining convention or AST errors).
  const specFile = getSpecFile(files);
  const pomFiles = getPomFiles(files);
  const remainingConventions = [
    ...(specFile ? checkSpecConventions(specFile.content, personaMap) : []),
    ...checkPomConventions(pomFiles, personaMap),
    ...checkStructuralIssues(files),
  ];

  if (remainingConventions.length === 0 && astErrors.length === 0) {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      dashboardBus.emitEvent('validation', 'info', `Phase 2 validation (attempt ${attempt})`, { attempt });

      let typeErrors: ValidationError[] = [];
      let lintErrors: ValidationError[] = [];

      try {
        typeErrors = await runTypecheck(repoName, files);
      } catch (err) {
        log('WARN', `[selfCorrection] runTypecheck failed: ${(err as Error).message}`);
      }

      try {
        lintErrors = await runLint(repoName, files);
      } catch (err) {
        log('WARN', `[selfCorrection] runLint failed: ${(err as Error).message}`);
      }

      const allPhase2Errors = [...typeErrors, ...lintErrors];

      if (allPhase2Errors.length === 0) {
        log('INFO', `[selfCorrection] Phase 2 valid${attempt > 1 ? ` after ${attempt - 1} correction(s)` : ''}`);
        dashboardBus.emitEvent('validation', 'info', 'Phase 2 (tsc/eslint) validation passed', { valid: true });
        return { feature, files, affectedPaths, tokenUsage, warned: false };
      }

      const errorSummary = allPhase2Errors
        .map((e) => `[${e.source}] ${e.filePath}(${e.line}${e.column ? `,${e.column}` : ''}): ${e.message}`)
        .join('\n');

      log('WARN', `[selfCorrection] Phase 2 errors on attempt ${attempt}/${maxAttempts}:\n${errorSummary}`);
      dashboardBus.emitEvent('validation', 'warn', 'Phase 2 errors found', { errors: allPhase2Errors });

      if (attempt === maxAttempts) break;

      const { args, tokenUsage: fixUsage } = await runAgent(
        `Fix the TypeScript and/or ESLint errors in the files below. The project typechecker and linter found these errors:
${errorSummary}

You may need to:
- Correct import paths
- Fix type signatures
- Update method calls to match existing interfaces
- Resolve ESLint rule violations

Output only the changed files.`,
        `ERRORS:\n${errorSummary}\n\n${formatFilesForPrompt(files)}`,
        fixFilesTools,
        validateTypescriptHandler,
        { maxIterations: 10 },
      );
      tokenUsage = addTokenUsage(tokenUsage, fixUsage);
      const changedFiles = (args.files as FileEntry[] | undefined) ?? [];
      files = mergeFiles(files, changedFiles);
      log('INFO', `[selfCorrection] Applied Phase 2 correction ${attempt}`);
      dashboardBus.emitEvent('correction', 'info', `Applied Phase 2 correction ${attempt}`, { tokenUsage: fixUsage });
    }
  }

  // If we reach here, Phase 2 failed or Phase 1 still has errors
  const finalSpec = getSpecFile(files);
  const finalPoms = getPomFiles(files);
  const finalConventions = [
    ...(finalSpec ? checkSpecConventions(finalSpec.content, personaMap) : []),
    ...checkPomConventions(finalPoms, personaMap),
    ...checkStructuralIssues(files),
  ];
  const errorSummary = [
    ...finalConventions.map((m) => `CONVENTION: ${m}`),
    ...conventionCheckErrors.map((e) => `BANNED_LOCATOR: ${e.path}(${e.line}): ${e.message}`),
    ...astErrors.map((e) => `AST: ${e.path}(${e.line}): ${e.message}`),
  ].join('\n');

  const warningMessage = `Validation failed after ${maxAttempts} attempt(s):\n${errorSummary}`;
  log('WARN', `[selfCorrection] ${warningMessage}`);
  return { feature, files, affectedPaths, tokenUsage, warned: true, warningMessage };
}

// ─── CI failure fix ────────────────────────────────────────────────────────────

const CI_FIX_SYSTEM_PROMPT = `You are a senior QA engineer fixing Playwright test failures.

You receive the exact CI failure output (with Expected/Received values), the current spec, and the current POM.
Your job is to fix only the failing assertions — do not rewrite passing tests.

## What to do for each failure

### Wrong assertion text (Expected X, Received Y)
Navigate to the page, observe the actual heading/text in the snapshot, update the POM method to match.

### Strict mode violation (locator resolved to N elements)
Navigate to the page, call browser_generate_locator(ref) on the specific element,
use the returned scoped locator in the POM. Never invent a regex or text-based locator.

### Element not found / Timeout
Navigate to the page, verify whether the element exists at all.
If yes, get its correct locator via browser_generate_locator(ref).
If the element genuinely doesn't exist (e.g. admin page has no welcome heading), remove that assertion.

## Browser tools
- browser_navigate(url, persona) to open a URL with saved auth state
- browser_snapshot() to see the current DOM
- browser_click(ref) / browser_fill(ref, value) to interact — use element refs (e1, e2, ...) from the snapshot
- browser_generate_locator(ref) to get the exact Playwright locator for an element
- browser_eval(expression, ref) to read attributes not visible in the snapshot
- browser_close() when done exploring

## Locator rules
- Every locator must come from browser_generate_locator or generatedCode — never invent selectors
- CRITICAL: use scoped locators verbatim — e.g. getByRole('complementary').getByText('Jane Doe') — never simplify
- Never hardcode persona strings in the POM. Accept names/roles as method parameters.

## Done protocol
1. Call validate_typescript on the fixed spec
2. If valid, call done() immediately — do NOT make any other tool calls after validation passes
3. In done(): files = array of {path, content, role} for each changed file. Include ONLY changed files.`;

export interface CiFixResult {
  files: FileEntry[];
  tokenUsage: TokenUsage;
}

const MAX_CI_FAILURES = 5;
const MAX_ERROR_LINES = 25;

function trimFailureMessage(msg: string): string {
  const lines = msg.split('\n');
  const stackStart = lines.findIndex((l) => /^\s+at /.test(l));
  const trimmed = stackStart > 0 ? lines.slice(0, stackStart) : lines;
  return trimmed.slice(0, MAX_ERROR_LINES).join('\n').trim();
}

function deduplicateFailures(failures: CiTestFailure[]): CiTestFailure[] {
  const seen = new Set<string>();
  return failures.filter((f) => {
    const key = f.errorMessage.split('\n').find((l) => l.includes('Error:') || l.includes('Expected'))?.trim() ?? f.errorMessage.slice(0, 80);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function runWithCiFailureFix(
  task: QATask,
  branch: string,
  feature: string,
  failures: CiTestFailure[],
): Promise<CiFixResult> {
  const repoName = task.outputRepo;

  const deduplicated = deduplicateFailures(failures).slice(0, MAX_CI_FAILURES);
  log('INFO', `[ciFailureFix] Fixing ${deduplicated.length} unique failure(s) (${failures.length} total) on branch ${branch}`);
  dashboardBus.emitEvent('correction', 'info', `Fixing ${deduplicated.length} CI failure(s)`, { branch, feature, total: failures.length });

  const [currentSpec, currentPom, specPath] = await Promise.all([
    getCurrentSpecOnBranch(repoName, branch, task.taskId, feature),
    getCurrentPOMOnBranch(repoName, branch, feature),
    getSpecPathOnBranch(repoName, branch, task.taskId, feature),
  ]);

  const failureSummary = deduplicated
    .map((f, i) => `### Failure ${i + 1}: ${f.testName}\n${trimFailureMessage(f.errorMessage)}`)
    .join('\n\n');

  const pomSection = currentPom ? `## Current POM\n${currentPom}` : '## Current POM\n(none found)';

  const userMessage = `## CI Failures to Fix

${failureSummary}

## Current Spec
${currentSpec ?? '(spec not found on branch)'}

${pomSection}

## Task Context
QA Environment: ${task.qaEnvUrl}
Branch: ${branch}
Feature: ${feature}

Navigate to the relevant pages to verify actual values, then fix only the failing assertions.`;

  const { args, tokenUsage: agentUsage } = await runAgent(
    CI_FIX_SYSTEM_PROMPT,
    userMessage,
    ciFixTools,
    createQaHandlers(repoName),
    { maxIterations: 25 },
  );

  let tokenUsage = agentUsage;
  let files = (args.files as FileEntry[] | undefined) ?? [];

  // If the agent returned no files, use the current spec as fallback
  if (files.length === 0 && currentSpec) {
    files = [{ path: specPath ?? `tests/web/${feature}/${feature}.spec.ts`, content: currentSpec, role: 'spec' }];
  }

  log('INFO', `[ciFailureFix] Fix agent completed — $${tokenUsage.costUSD.toFixed(4)} USD`);
  dashboardBus.emitEvent('correction', 'info', 'CI failure fix applied', { tokenUsage });

  // Structural guard: validate the spec
  const specFile = files.find((f) => f.role === 'spec');
  const tsResultRaw = await validateTypescriptHandler.validate_typescript({
    code: specFile?.content || currentSpec || '',
    fileType: 'spec',
  });
  const tsResult = JSON.parse(
    typeof tsResultRaw === 'string' ? tsResultRaw : JSON.stringify(tsResultRaw)
  ) as { valid: boolean; errors: Array<{ line: number; message: string }> };

  if (!tsResult.valid) {
    log('WARN', `[ciFailureFix] TypeScript errors in agent output — running one TS fix pass`);
    dashboardBus.emitEvent('validation', 'warn', 'CI fix output has TS errors — correcting', { errors: tsResult.errors });

    const tsErrors = tsResult.errors.map((e) => `Line ${e.line}: ${e.message}`).join('\n');
    const { args: fixArgs, tokenUsage: fixUsage } = await runAgent(
      'Fix the TypeScript errors in the files below. Output only the changed files.',
      `TypeScript errors:\n${tsErrors}\n\n${formatFilesForPrompt(files)}`,
      fixFilesTools,
      validateTypescriptHandler,
      { maxIterations: 10 },
    );
    const fixChangedFiles = (fixArgs.files as FileEntry[] | undefined) ?? [];
    files = mergeFiles(files, fixChangedFiles);
    tokenUsage = addTokenUsage(tokenUsage, fixUsage);

    log('INFO', `[ciFailureFix] TS fix pass complete — $${tokenUsage.costUSD.toFixed(4)} USD total`);
    dashboardBus.emitEvent('correction', 'info', 'CI fix TS correction applied', { tokenUsage: fixUsage });
  }

  return { files, tokenUsage };
}
