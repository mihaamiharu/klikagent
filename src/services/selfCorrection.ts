import { QATask } from '../types';
import { runQaAgent } from '../agents/qaAgent';
import { runAgent, TokenUsage } from './ai';
import { validateTypescriptHandler } from '../agents/tools/outputTools';
import { qaTools, qaHandlers } from '../agents/tools';
import { maxSelfCorrectionAttempts } from './testRepoClone';
import { log } from '../utils/logger';
import { AgentTool, ToolHandlers } from '../types';

export interface SelfCorrectionResult {
  specContent: string;
  poms: Array<{ pomContent: string; pomPath: string }>;
  affectedPaths: string;
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
const fixHandlers: ToolHandlers = { ...qaHandlers };

export async function runWithSelfCorrection(
  task: QATask,
  branch: string,
  specPath: string,
): Promise<SelfCorrectionResult> {
  const maxAttempts = maxSelfCorrectionAttempts();

  // Step 1: Initial QA agent run
  log('INFO', '[selfCorrection] Running initial qaAgent pass');
  const qaResult = await runQaAgent(task, branch);
  let specContent = qaResult.enrichedSpec;
  const poms = qaResult.poms;
  const affectedPaths = qaResult.affectedPaths;
  let tokenUsage = qaResult.tokenUsage;

  // Step 2: TypeScript validation loop — up to maxAttempts corrections
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const tsResultRaw = await validateTypescriptHandler.validate_typescript({ code: specContent });
    const tsResult = JSON.parse(
      typeof tsResultRaw === 'string' ? tsResultRaw : JSON.stringify(tsResultRaw)
    ) as { valid: boolean; errors: Array<{ line: number; message: string }> };

    if (tsResult.valid) {
      log('INFO', `[selfCorrection] TypeScript valid${attempt > 1 ? ` after ${attempt - 1} correction(s)` : ''}`);
      return { specContent, poms, affectedPaths, tokenUsage, warned: false };
    }

    log('WARN', `[selfCorrection] TypeScript errors on attempt ${attempt}/${maxAttempts}: ${JSON.stringify(tsResult.errors)}`);

    if (attempt === maxAttempts) break;

    const tsErrors = tsResult.errors.map((e) => `Line ${e.line}: ${e.message}`).join('\n');
    const { args, tokenUsage: fixUsage } = await runAgent(
      'Fix the TypeScript errors in this Playwright spec. Output only the corrected spec content.',
      `TypeScript errors:\n${tsErrors}\n\nSpec:\n${specContent}`,
      fixTools,
      fixHandlers,
    );
    tokenUsage = addTokenUsage(tokenUsage, fixUsage);
    specContent = args.fixedSpec as string;
    log('INFO', `[selfCorrection] Applied TypeScript correction ${attempt}`);
  }

  // Final validation after last correction
  const finalRaw = await validateTypescriptHandler.validate_typescript({ code: specContent });
  const finalResult = JSON.parse(
    typeof finalRaw === 'string' ? finalRaw : JSON.stringify(finalRaw)
  ) as { valid: boolean; errors: Array<{ line: number; message: string }> };

  if (finalResult.valid) {
    log('INFO', `[selfCorrection] TypeScript valid after ${maxAttempts} correction(s)`);
    return { specContent, poms, affectedPaths, tokenUsage, warned: false };
  }

  const errorSummary = finalResult.errors.map((e) => `Line ${e.line}: ${e.message}`).join('\n');
  const warningMessage = `TypeScript still failing after ${maxAttempts} attempt(s):\n${errorSummary}`;
  log('WARN', `[selfCorrection] ${warningMessage}`);
  return { specContent, poms, affectedPaths, tokenUsage, warned: true, warningMessage };
}
