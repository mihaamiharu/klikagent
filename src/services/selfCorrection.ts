import { QATask, CiTestFailure } from '../types';
import { PersonaMap } from './personas';
import { runQaAgent } from '../agents/qaAgent';
import { runAgent, TokenUsage } from './ai';
import { validateTypescriptHandler } from '../agents/tools/outputTools';
import { qaTools, createQaHandlers } from '../agents/tools';
import { maxSelfCorrectionAttempts } from './testRepoClone';
import { log } from '../utils/logger';
import { dashboardBus } from '../dashboard/eventBus';
import { AgentTool } from '../types';
import { getPersonas } from './personas';
import { getCurrentSpec, getCurrentPOM, getSpecPath } from './testRepo';

type Pom = { pomContent: string; pomPath: string };

function getForbiddenPersonaStrings(personaMap: PersonaMap): string[] {
  const forbidden = new Set<string>();
  for (const persona of Object.values(personaMap)) {
    for (const [key, value] of Object.entries(persona)) {
      if (key === 'password' || key === 'email') continue;
      if (typeof value === 'string' && value.length > 2) {
        forbidden.add(value);
      }
    }
  }
  // Also add role keys
  for (const role of Object.keys(personaMap)) {
    if (role.length > 2) forbidden.add(role);
  }
  return Array.from(forbidden);
}

function checkSpecConventions(specContent: string, personaMap: PersonaMap): string[] {
  const violations: string[] = [];
  const forbiddenStrings = getForbiddenPersonaStrings(personaMap);

  if (/(?<!expect\(\s*)page\.(?:locator|getBy(?:Role|Text|Label|Placeholder|AltText|Title|TestId))\b/.test(specContent)) {
    violations.push(
      'Spec contains direct `page.locator` or `page.getBy*` calls outside of assertions. ' +
      'All element interactions MUST be encapsulated within a Page Object Model (POM). ' +
      'Add properties or methods to your POM and use them in the spec instead (e.g. `await authPage.emailInput.fill(email)` NOT `await page.getByLabel("Email").fill(email)`).'
    );
  }

  // Dynamic persona check
  for (const str of forbiddenStrings) {
    const escaped = str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`(?<!personas\\.\\w+\\.)\\b${escaped}\\b`, 'i');
    if (regex.test(specContent)) {
      violations.push(
        `Spec contains hardcoded persona data ("${str}"). ` +
        'Assertions and locators must be persona-agnostic or use dynamic data from the imported `personas` object.'
      );
      break; // One violation is enough to trigger a fix
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

  if (/\.\s*login\s*\(\s*['"][^'"]*@[^'"]*['"]/.test(specContent)) {
    violations.push(
      'Spec passes a hardcoded email address to a login call. ' +
      'Import personas from config/personas.ts and use the typed values instead: ' +
      '`import { personas } from \'../../../config/personas\'; ' +
      'authPage.login(personas.patient.email, personas.patient.password)`.',
    );
  }

  return violations;
}

function checkPomConventions(poms: Pom[], personaMap: PersonaMap): string[] {
  const violations: string[] = [];
  const forbiddenStrings = getForbiddenPersonaStrings(personaMap);

  for (const { pomContent, pomPath } of poms) {
    if (/Welcome back,\s*\w+/.test(pomContent)) {
      violations.push(
        `${pomPath}: POM assertion method contains a hardcoded persona name (e.g. "Welcome back, Jane!"). ` +
        'POM helpers must be persona-agnostic. Accept the name as a parameter ' +
        '(`expectOnDashboard(expectedName?: string)`) or remove the heading check and let the test assert it.',
      );
    }

    for (const str of forbiddenStrings) {
      const escaped = str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(`(['"])${escaped}\\1`, 'i');
      if (regex.test(pomContent)) {
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

const fixConventionsDoneTool: AgentTool = {
  type: 'function',
  function: {
    name: 'done',
    description: 'Submit corrected files. Call when all convention fixes are complete.',
    parameters: {
      type: 'object',
      properties: {
        fixedSpec: {
          type: 'string',
          description: 'The corrected spec content.',
        },
        fixedPoms: {
          type: 'array',
          description: 'Corrected POM files — include only the ones that changed.',
          items: {
            type: 'object',
            properties: {
              pomContent: { type: 'string' },
              pomPath: { type: 'string' },
            },
            required: ['pomContent', 'pomPath'],
          },
        },
      },
      required: ['fixedSpec'],
    },
  },
};

export interface SelfCorrectionResult {
  feature: string;
  specContent: string;
  poms: Array<{ pomContent: string; pomPath: string }>;
  affectedPaths: string;
  fixtureUpdate?: string;
  tokenUsage: TokenUsage;
  warned: boolean;        // true if tsc still failing after all attempts
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

const fixDoneTool: AgentTool = {
  type: 'function',
  function: {
    name: 'done',
    description: 'Submit the corrected spec content. Call this when the fix is complete.',
    parameters: {
      type: 'object',
      properties: {
        fixedSpec: { type: 'string', description: 'The corrected Playwright TypeScript spec file content' },
      },
      required: ['fixedSpec'],
    },
  },
};

const fixTools: AgentTool[] = [...qaTools.filter((t) => t.function.name !== 'done'), fixDoneTool];

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
  let specContent = qaResult.enrichedSpec;
  const poms = qaResult.poms;
  const affectedPaths = qaResult.affectedPaths;
  const fixtureUpdate = qaResult.fixtureUpdate;
  let tokenUsage = qaResult.tokenUsage;

  // Step 2: Convention check — catches pattern violations that tsc cannot
  const personaMap = await getPersonas(repoName, []);
  const specViolations = checkSpecConventions(specContent, personaMap);
  const pomViolations = checkPomConventions(poms, personaMap);
  const allViolations = [...specViolations, ...pomViolations];

  if (allViolations.length > 0) {
    log('WARN', `[selfCorrection] ${allViolations.length} convention violation(s) found`);
    dashboardBus.emitEvent('correction', 'warn', 'Convention violations detected', { violations: allViolations });

    const conventionFixTools = [...qaTools.filter((t) => t.function.name !== 'done'), fixConventionsDoneTool];
    const violationList = allViolations.map((v, i) => `${i + 1}. ${v}`).join('\n');
    const pomSummary = poms.map((p) => `### ${p.pomPath}\n${p.pomContent}`).join('\n\n');

    const { args, tokenUsage: fixUsage } = await runAgent(
      'Fix the convention violations listed below in this Playwright spec and/or POM files. Fix ONLY what is listed — do not change any other logic.',
      `VIOLATIONS:\n${violationList}\n\n### Spec\n${specContent}\n\n${pomSummary}`,
      conventionFixTools,
      createQaHandlers(repoName),
    );

    tokenUsage = addTokenUsage(tokenUsage, fixUsage);
    specContent = args.fixedSpec as string;

    const fixedPoms = args.fixedPoms as Pom[] | undefined;
    if (fixedPoms?.length) {
      for (const fixed of fixedPoms) {
        const idx = poms.findIndex((p) => p.pomPath === fixed.pomPath);
        if (idx !== -1) poms[idx] = fixed;
      }
    }

    log('INFO', '[selfCorrection] Convention corrections applied');
    dashboardBus.emitEvent('correction', 'info', 'Convention corrections applied', { tokenUsage: fixUsage });
  }

  // Step 3: TypeScript validation loop — up to maxAttempts corrections
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    dashboardBus.emitEvent('validation', 'info', `TypeScript validation check (attempt ${attempt})`, { attempt });
    const tsResultRaw = await validateTypescriptHandler.validate_typescript({ code: specContent });
    const tsResult = JSON.parse(
      typeof tsResultRaw === 'string' ? tsResultRaw : JSON.stringify(tsResultRaw)
    ) as { valid: boolean; errors: Array<{ line: number; message: string }> };

    if (tsResult.valid) {
      log('INFO', `[selfCorrection] TypeScript valid${attempt > 1 ? ` after ${attempt - 1} correction(s)` : ''}`);
      dashboardBus.emitEvent('validation', 'info', 'TypeScript is valid', { valid: true });
      return { feature, specContent, poms, affectedPaths, fixtureUpdate, tokenUsage, warned: false };
    }

    log('WARN', `[selfCorrection] TypeScript errors on attempt ${attempt}/${maxAttempts}: ${JSON.stringify(tsResult.errors)}`);
    dashboardBus.emitEvent('validation', 'warn', 'TypeScript errors found', { errors: tsResult.errors });

    if (attempt === maxAttempts) break;

    const tsErrors = tsResult.errors.map((e) => `Line ${e.line}: ${e.message}`).join('\n');
    const { args, tokenUsage: fixUsage } = await runAgent(
      'Fix the TypeScript errors in this Playwright spec. Output only the corrected spec content.',
      `TypeScript errors:\n${tsErrors}\n\nSpec:\n${specContent}`,
      fixTools,
      createQaHandlers(repoName),
    );
    tokenUsage = addTokenUsage(tokenUsage, fixUsage);
    specContent = args.fixedSpec as string;
    log('INFO', `[selfCorrection] Applied TypeScript correction ${attempt}`);
    dashboardBus.emitEvent('correction', 'info', `Applied correction ${attempt}`, { tokenUsage: fixUsage });
  }

  // Final validation after last correction
  const finalRaw = await validateTypescriptHandler.validate_typescript({ code: specContent });
  const finalResult = JSON.parse(
    typeof finalRaw === 'string' ? finalRaw : JSON.stringify(finalRaw)
  ) as { valid: boolean; errors: Array<{ line: number; message: string }> };

  if (finalResult.valid) {
    log('INFO', `[selfCorrection] TypeScript valid after ${maxAttempts} correction(s)`);
    return { feature, specContent, poms, affectedPaths, fixtureUpdate, tokenUsage, warned: false };
  }

  const errorSummary = finalResult.errors.map((e) => `Line ${e.line}: ${e.message}`).join('\n');
  const warningMessage = `TypeScript still failing after ${maxAttempts} attempt(s):\n${errorSummary}`;
  log('WARN', `[selfCorrection] ${warningMessage}`);
  return { feature, specContent, poms, affectedPaths, fixtureUpdate, tokenUsage, warned: true, warningMessage };
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
3. In done(): fixedSpec = corrected spec, fixedPoms = array of {pomContent, pomPath} for each changed POM`;

export interface CiFixResult {
  specContent: string;
  poms: Pom[];
  specPath: string | null;
  tokenUsage: TokenUsage;
}

const MAX_CI_FAILURES = 5;
const MAX_ERROR_LINES = 25;

// Keep only the meaningful part of a Playwright error — strip full stack traces.
// The Expected/Received block and the immediate assertion location are enough.
function trimFailureMessage(msg: string): string {
  const lines = msg.split('\n');
  // Cut at "at " stack frame lines — everything from the first pure stack frame is noise
  const stackStart = lines.findIndex((l) => /^\s+at /.test(l));
  const trimmed = stackStart > 0 ? lines.slice(0, stackStart) : lines;
  return trimmed.slice(0, MAX_ERROR_LINES).join('\n').trim();
}

// Group failures by their root error pattern. When multiple tests share the
// same Expected/Received cause, only the first representative is needed.
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
    getCurrentSpec(repoName, branch, task.taskId, feature),
    getCurrentPOM(repoName, branch, feature),
    getSpecPath(repoName, branch, task.taskId, feature),
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

  const { args, tokenUsage } = await runAgent(
    CI_FIX_SYSTEM_PROMPT,
    userMessage,
    fixTools,
    createQaHandlers(repoName),
    { maxIterations: 25 },
  );

  const fixedSpec = args.fixedSpec as string;
  const fixedPoms = (args.fixedPoms as Pom[] | undefined) ?? [];

  log('INFO', `[ciFailureFix] Fix agent completed — $${tokenUsage.costUSD.toFixed(4)} USD`);
  dashboardBus.emitEvent('correction', 'info', 'CI failure fix applied', { tokenUsage });

  return { specContent: fixedSpec, poms: fixedPoms, specPath, tokenUsage };
}
