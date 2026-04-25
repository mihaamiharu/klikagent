import { runWithSelfCorrection } from './selfCorrection';
import { QATask } from '../types';

// ─── Mock dependencies ──────────────────────────────────────────────────────

jest.mock('./testRepoClone', () => ({
  maxSelfCorrectionAttempts: jest.fn().mockReturnValue(3),
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
  createQaHandlers: jest.fn().mockReturnValue({}),
  browserTools: [],
  browserHandlers: {},
  reviewTools: [],
  createReviewHandlers: jest.fn().mockReturnValue({}),
}));

jest.mock('./ai', () => ({
  runAgent: jest.fn(),
}));

jest.mock('./personas', () => ({
  getPersonas: jest.fn().mockResolvedValue({}),
}));

// ─── Imports after mocks ────────────────────────────────────────────────────

import * as testRepoClone from './testRepoClone';
import * as qaAgentModule from '../agents/qaAgent';
import * as outputTools from '../agents/tools/outputTools';
import * as ai from './ai';

// ─── Helpers ────────────────────────────────────────────────────────────────

const mockRunQaAgent = qaAgentModule.runQaAgent as jest.MockedFunction<typeof qaAgentModule.runQaAgent>;
const mockValidateTs = outputTools.validateTypescriptHandler.validate_typescript as jest.MockedFunction<typeof outputTools.validateTypescriptHandler.validate_typescript>;
const mockRunAgent = ai.runAgent as jest.MockedFunction<typeof ai.runAgent>;
const mockMaxAttempts = testRepoClone.maxSelfCorrectionAttempts as jest.MockedFunction<typeof testRepoClone.maxSelfCorrectionAttempts>;

const baseTask: QATask = {
  taskId: '42',
  title: 'Test feature',
  description: 'As a user I want to test',
  qaEnvUrl: 'https://qa.example.com',
  outputRepo: 'klikagent-tests',
};

const baseQaResult = {
  feature: 'test',
  enrichedSpec: 'import { test } from "@playwright/test";\ntest("pass", async () => {});',
  poms: [{ pomContent: 'export class TestPage {}', pomPath: 'pages/test/TestPage.ts' }],
  affectedPaths: 'tests/web/test/',
  tokenUsage: { promptTokens: 100, completionTokens: 50, totalTokens: 150, costUSD: 0.001 },
};

const valid = JSON.stringify({ valid: true, errors: [] });
const invalid = (msgs: string[]) => JSON.stringify({
  valid: false,
  errors: msgs.map((m, i) => ({ line: i + 1, message: m })),
});

function makeFixResult(fixedSpec: string, tokens = { promptTokens: 20, completionTokens: 10, totalTokens: 30, costUSD: 0.0002 }) {
  return { args: { fixedSpec }, tokenUsage: tokens };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  mockMaxAttempts.mockReturnValue(3);
  mockRunQaAgent.mockResolvedValue(baseQaResult);
  mockValidateTs.mockResolvedValue(valid);
});

describe('runWithSelfCorrection', () => {
  it('passes on first tsc check — warned: false, no correction calls', async () => {
    const result = await runWithSelfCorrection(baseTask, 'qa/42-test');

    expect(result.warned).toBe(false);
    expect(result.warningMessage).toBeUndefined();
    expect(result.specContent).toBe(baseQaResult.enrichedSpec);
    expect(result.poms[0].pomContent).toBe(baseQaResult.poms[0].pomContent);
    expect(result.tokenUsage.totalTokens).toBe(150);
    expect(mockRunAgent).not.toHaveBeenCalled();
  });

  it('fails tsc once then passes — warned: false, runAgent called once', async () => {
    const fixedSpec = 'import { test } from "@playwright/test";\ntest("fixed", async () => {});';
    mockValidateTs
      .mockResolvedValueOnce(invalid(['Unexpected token']))
      .mockResolvedValueOnce(valid);
    mockRunAgent.mockResolvedValue(makeFixResult(fixedSpec));

    const result = await runWithSelfCorrection(baseTask, 'qa/42-test');

    expect(result.warned).toBe(false);
    expect(result.specContent).toBe(fixedSpec);
    expect(mockRunAgent).toHaveBeenCalledTimes(1);
    expect(result.tokenUsage.totalTokens).toBe(150 + 30);
  });

  it('exhausts all tsc attempts — warned: true, warningMessage set', async () => {
    const fixedSpec = 'import { test } from "@playwright/test";\ntest("attempt", async () => {});';
    mockValidateTs.mockResolvedValue(invalid(['Persistent error']));
    mockRunAgent.mockResolvedValue(makeFixResult(fixedSpec));

    const result = await runWithSelfCorrection(baseTask, 'qa/42-test');

    expect(result.warned).toBe(true);
    expect(result.warningMessage).toContain('Persistent error');
    expect(result.warningMessage).toContain('3');
    // attempts: 1 fail → fix, 2 fail → fix, 3 fail → final check → warned
    expect(mockRunAgent).toHaveBeenCalledTimes(2);
  });

  it('accumulates token usage across all correction rounds', async () => {
    const fixedSpec = 'import { test } from "@playwright/test";\ntest("fix2", async () => {});';
    mockValidateTs
      .mockResolvedValueOnce(invalid(['error1']))
      .mockResolvedValueOnce(invalid(['error2']))
      .mockResolvedValueOnce(valid);
    mockRunAgent
      .mockResolvedValueOnce(makeFixResult(fixedSpec, { promptTokens: 10, completionTokens: 5, totalTokens: 15, costUSD: 0.000125 }))
      .mockResolvedValueOnce(makeFixResult(fixedSpec, { promptTokens: 20, completionTokens: 10, totalTokens: 30, costUSD: 0.00025 }));

    const result = await runWithSelfCorrection(baseTask, 'qa/42-test');

    expect(result.warned).toBe(false);
    expect(result.tokenUsage.totalTokens).toBe(150 + 15 + 30);
  });

  it('passes the correct error context to the fix agent', async () => {
    const fixedSpec = 'import { test } from "@playwright/test";\ntest("fixed", async () => {});';
    mockValidateTs
      .mockResolvedValueOnce(invalid(['Cannot find module']))
      .mockResolvedValueOnce(valid);
    mockRunAgent.mockResolvedValue(makeFixResult(fixedSpec));

    await runWithSelfCorrection(baseTask, 'qa/42-test');

    expect(mockRunAgent).toHaveBeenCalledWith(
      expect.stringContaining('TypeScript errors'),
      expect.stringContaining('Cannot find module'),
      expect.any(Array),
      expect.any(Object),
    );
  });
});
