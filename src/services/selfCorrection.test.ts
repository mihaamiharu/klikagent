import { runWithSelfCorrection } from './selfCorrection';
import { GitHubIssue } from '../types';

// ─── Mock dependencies ──────────────────────────────────────────────────────

jest.mock('./testRepoClone', () => ({
  ensureFreshClone: jest.fn().mockResolvedValue('/tmp/klikagent-tests'),
  writeSpecToClone: jest.fn().mockResolvedValue(undefined),
  runPlaywrightTest: jest.fn(),
  maxSelfCorrectionAttempts: jest.fn().mockReturnValue(2),
}));

jest.mock('../agents/qaAgent', () => ({
  runQaAgent: jest.fn(),
}));

jest.mock('../agents/tools/outputTools', () => ({
  validateTypescriptHandler: {
    validate_typescript: jest.fn(),
  },
  validateTypescriptTool: {
    type: 'function',
    function: { name: 'validate_typescript', description: 'Validate TS', parameters: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] } },
  },
  qaDoneTool: {
    type: 'function',
    function: { name: 'done', description: 'Done', parameters: { type: 'object', properties: {}, required: [] } },
  },
  enrichmentDoneTool: {
    type: 'function',
    function: { name: 'done', description: 'Done', parameters: { type: 'object', properties: {}, required: [] } },
  },
  reviewDoneTool: {
    type: 'function',
    function: { name: 'done', description: 'Done', parameters: { type: 'object', properties: {}, required: [] } },
  },
  pomPathFromContent: jest.fn().mockReturnValue('pages/test/TestPage.ts'),
}));

jest.mock('../agents/tools', () => ({
  qaTools: [],
  qaHandlers: {},
  browserTools: [],
  browserHandlers: {},
  getPersonas: jest.fn(),
  enrichmentTools: [],
  enrichmentHandlers: {},
  reviewTools: [],
  reviewHandlers: {},
}));

jest.mock('./ai', () => ({
  runAgent: jest.fn(),
}));

// ─── Imports after mocks ────────────────────────────────────────────────────

import * as testRepoClone from './testRepoClone';
import * as qaAgentModule from '../agents/qaAgent';
import * as outputTools from '../agents/tools/outputTools';
import * as ai from './ai';

// ─── Helpers ────────────────────────────────────────────────────────────────

const mockRunQaAgent = qaAgentModule.runQaAgent as jest.MockedFunction<typeof qaAgentModule.runQaAgent>;
const mockRunPlaywrightTest = testRepoClone.runPlaywrightTest as jest.MockedFunction<typeof testRepoClone.runPlaywrightTest>;
const mockValidateTs = outputTools.validateTypescriptHandler.validate_typescript as jest.MockedFunction<typeof outputTools.validateTypescriptHandler.validate_typescript>;
const mockRunAgent = ai.runAgent as jest.MockedFunction<typeof ai.runAgent>;
const mockMaxAttempts = testRepoClone.maxSelfCorrectionAttempts as jest.MockedFunction<typeof testRepoClone.maxSelfCorrectionAttempts>;

const baseIssue: GitHubIssue = {
  number: 42,
  title: 'Test issue',
  body: 'Test body',
  url: 'https://github.com/owner/repo/issues/42',
  labels: [],
};

const baseQaResult = {
  enrichedSpec: 'import { test } from "@playwright/test";\ntest("pass", async () => {});',
  pomContent: 'export class TestPage {}',
  pomPath: 'pages/test/TestPage.ts',
  affectedPaths: 'tests/web/test/',
  tokenUsage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
};

const validTsResult = JSON.stringify({ valid: true, errors: [] });

function makeFixResult(fixedSpec: string, tokens = { promptTokens: 20, completionTokens: 10, totalTokens: 30 }) {
  return { args: { fixedSpec }, tokenUsage: tokens };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  mockMaxAttempts.mockReturnValue(2);
  mockRunQaAgent.mockResolvedValue(baseQaResult);
  mockValidateTs.mockResolvedValue(validTsResult);
});

describe('runWithSelfCorrection', () => {
  it('passes on first attempt — warned: false, no correction calls', async () => {
    mockRunPlaywrightTest.mockResolvedValue({ passed: true, output: '' });

    const result = await runWithSelfCorrection(
      baseIssue, 'test', 'qa/42-test', [], [], '', 'tests/web/test/42.spec.ts'
    );

    expect(result.warned).toBe(false);
    expect(result.warningMessage).toBeUndefined();
    expect(result.specContent).toBe(baseQaResult.enrichedSpec);
    expect(result.pomContent).toBe(baseQaResult.pomContent);
    expect(result.tokenUsage.totalTokens).toBe(150);
    expect(mockRunAgent).not.toHaveBeenCalled();
  });

  it('fails once then passes — warned: false, runAgent called once', async () => {
    const fixedSpec = 'import { test } from "@playwright/test";\ntest("fixed", async () => {});';
    mockRunPlaywrightTest
      .mockResolvedValueOnce({ passed: false, output: 'Error: locator not found' })
      .mockResolvedValueOnce({ passed: true, output: '' });
    mockRunAgent.mockResolvedValue(makeFixResult(fixedSpec));

    const result = await runWithSelfCorrection(
      baseIssue, 'test', 'qa/42-test', [], [], '', 'tests/web/test/42.spec.ts'
    );

    expect(result.warned).toBe(false);
    expect(result.specContent).toBe(fixedSpec);
    expect(mockRunAgent).toHaveBeenCalledTimes(1);
    // Token usage should accumulate
    expect(result.tokenUsage.totalTokens).toBe(150 + 30);
  });

  it('exhausts all attempts — warned: true, warningMessage set', async () => {
    mockRunPlaywrightTest.mockResolvedValue({ passed: false, output: 'Persistent failure' });
    mockRunAgent.mockResolvedValue(makeFixResult('import { test } from "@playwright/test";\ntest("attempt", async () => {});'));

    const result = await runWithSelfCorrection(
      baseIssue, 'test', 'qa/42-test', [], [], '', 'tests/web/test/42.spec.ts'
    );

    expect(result.warned).toBe(true);
    expect(result.warningMessage).toContain('Persistent failure');
    expect(result.warningMessage).toContain('2');
    expect(mockRunAgent).toHaveBeenCalledTimes(2);
  });

  it('TS validation failure counts as attempt 1 — reduces remaining playwright retries', async () => {
    const tsErrors = [{ line: 1, message: 'Unexpected token' }];
    mockValidateTs.mockResolvedValue(JSON.stringify({ valid: false, errors: tsErrors }));

    const fixedSpec = 'import { test } from "@playwright/test";\ntest("fixed-ts", async () => {});';
    // runAgent for TS fix, then runAgent for playwright fix
    mockRunAgent
      .mockResolvedValueOnce(makeFixResult(fixedSpec))
      .mockResolvedValueOnce(makeFixResult(fixedSpec));

    // Playwright always fails so we see how many attempts remain
    mockRunPlaywrightTest.mockResolvedValue({ passed: false, output: 'playwright error' });

    const result = await runWithSelfCorrection(
      baseIssue, 'test', 'qa/42-test', [], [], '', 'tests/web/test/42.spec.ts'
    );

    // TS fix = attempt 1, playwright fails, 1 remaining playwright correction attempt
    // After 1 playwright correction attempt (attempt 2) → exhausted
    expect(result.warned).toBe(true);
    // runAgent: once for TS fix, once for playwright correction
    expect(mockRunAgent).toHaveBeenCalledTimes(2);
    expect(mockRunAgent).toHaveBeenNthCalledWith(
      1,
      'Fix the failing Playwright test. Output only the corrected spec content.',
      expect.stringContaining('TypeScript validation errors'),
      expect.any(Array),
      expect.any(Object),
    );
    expect(mockRunAgent).toHaveBeenNthCalledWith(
      2,
      'Fix the failing Playwright test. Output only the corrected spec content.',
      expect.stringContaining('playwright error'),
      expect.any(Array),
      expect.any(Object),
    );
  });
});
