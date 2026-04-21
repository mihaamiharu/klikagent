import { GitHubIssue } from '../types';
import { runQaAgent } from '../agents/qaAgent';
import { runAgent, TokenUsage } from './ai';
import { validateTypescriptHandler } from '../agents/tools/outputTools';
import { qaTools, qaHandlers } from '../agents/tools';
import {
  ensureFreshClone,
  writeSpecToClone,
  runPlaywrightTest,
  maxSelfCorrectionAttempts,
} from './testRepoClone';
import { log } from '../utils/logger';
import { AgentTool, ToolHandlers } from '../types';

export interface SelfCorrectionResult {
  specContent: string;
  poms: Array<{ pomContent: string; pomPath: string }>;
  affectedPaths: string;
  tokenUsage: TokenUsage;
  warned: boolean;        // true if all attempts exhausted without passing tests
  warningMessage?: string;
}

function addTokenUsage(acc: TokenUsage, next: TokenUsage): TokenUsage {
  return {
    promptTokens: acc.promptTokens + next.promptTokens,
    completionTokens: acc.completionTokens + next.completionTokens,
    totalTokens: acc.totalTokens + next.totalTokens,
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
const fixHandlers: ToolHandlers = { ...qaHandlers };

export async function runWithSelfCorrection(
  issue: GitHubIssue,
  feature: string,
  branch: string,
  personas: string[],
  startingUrls: string[],
  prDiff: string,
  specPath: string,
): Promise<SelfCorrectionResult> {
  const maxAttempts = maxSelfCorrectionAttempts();
  let attempts = 0;

  // Step 1: Initial QA agent run
  log('INFO', '[selfCorrection] Running initial qaAgent pass');
  const qaResult = await runQaAgent(issue, feature, branch, personas, startingUrls, prDiff);
  let specContent = qaResult.enrichedSpec;
  const poms = qaResult.poms;
  const affectedPaths = qaResult.affectedPaths;
  let tokenUsage = qaResult.tokenUsage;

  // Step 2: TypeScript validation
  log('INFO', '[selfCorrection] Running TypeScript validation');
  const tsResultRaw = await validateTypescriptHandler.validate_typescript({ code: specContent });
  const tsResult = JSON.parse(typeof tsResultRaw === 'string' ? tsResultRaw : JSON.stringify(tsResultRaw)) as {
    valid: boolean;
    errors: Array<{ line: number; message: string }>;
  };

  if (!tsResult.valid) {
    attempts += 1;
    log('WARN', `[selfCorrection] TypeScript validation failed (attempt ${attempts}/${maxAttempts}). Errors: ${JSON.stringify(tsResult.errors)}`);

    if (attempts <= maxAttempts) {
      const tsErrors = tsResult.errors.map((e) => `Line ${e.line}: ${e.message}`).join('\n');
      const { args, tokenUsage: fixUsage } = await runAgent(
        'Fix the failing Playwright test. Output only the corrected spec content.',
        `TypeScript validation errors:\n${tsErrors}\n\nSpec:\n${specContent}`,
        fixTools,
        fixHandlers,
      );
      tokenUsage = addTokenUsage(tokenUsage, fixUsage);
      specContent = args.fixedSpec as string;
      log('INFO', '[selfCorrection] TypeScript correction applied');
    }
  }

  // Step 3: Clone setup and initial playwright run
  log('INFO', '[selfCorrection] Ensuring fresh clone');
  await ensureFreshClone();
  await writeSpecToClone(specPath, specContent);
  for (const { pomContent, pomPath } of poms) {
    await writeSpecToClone(pomPath, pomContent);
  }

  log('INFO', `[selfCorrection] Running Playwright test (attempt ${attempts + 1})`);
  let testResult = await runPlaywrightTest(specPath);

  if (testResult.passed) {
    log('INFO', '[selfCorrection] Playwright test passed on first run');
    return { specContent, poms, affectedPaths, tokenUsage, warned: false };
  }

  // Step 4: Retry loop
  while (!testResult.passed && attempts < maxAttempts) {
    attempts += 1;
    log('WARN', `[selfCorrection] Playwright test failed. Running correction attempt ${attempts}/${maxAttempts}`);

    const { args, tokenUsage: fixUsage } = await runAgent(
      'Fix the failing Playwright test. Output only the corrected spec content.',
      `Playwright test failure output:\n${testResult.output}\n\nCurrent spec:\n${specContent}`,
      fixTools,
      fixHandlers,
    );
    tokenUsage = addTokenUsage(tokenUsage, fixUsage);
    specContent = args.fixedSpec as string;

    await writeSpecToClone(specPath, specContent);
    log('INFO', `[selfCorrection] Re-running Playwright test after correction ${attempts}`);
    testResult = await runPlaywrightTest(specPath);

    if (testResult.passed) {
      log('INFO', `[selfCorrection] Playwright test passed after ${attempts} correction(s)`);
      return { specContent, poms, affectedPaths, tokenUsage, warned: false };
    }
  }

  // All attempts exhausted
  const warningMessage = `Self-correction exhausted all ${maxAttempts} attempt(s). Last Playwright error:\n${testResult.output}`;
  log('WARN', `[selfCorrection] ${warningMessage}`);
  return { specContent, poms, affectedPaths, tokenUsage, warned: true, warningMessage };
}
