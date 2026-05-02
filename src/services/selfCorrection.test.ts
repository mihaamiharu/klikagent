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
    function: { name: 'validate_typescript', description: 'Validate TS', parameters: { type: 'object', properties: { code: { type: 'string' }, fileType: { type: 'string' } }, required: ['code'] } },
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
  PAGE_GETBY_IN_SPEC_PATTERN: /\bpage\.(getByRole|getByTestId|getByLabel|getByText|getByPlaceholder|getByAltText|getByTitle|locator)\s*\(/,
}));

jest.mock('../agents/tools', () => ({
  qaTools: [],
  createQaHandlers: jest.fn().mockReturnValue({}),
  browserTools: [],
  browserHandlers: {
    browser_close: jest.fn().mockResolvedValue(undefined),
  },
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

const baseSpec = 'import { test } from "@playwright/test";\ntest("pass", async () => {});';
const basePom = 'export class TestPage {}';

const baseQaResult = {
  feature: 'test',
  files: [
    { path: 'tests/web/test/42-test-feature.spec.ts', content: baseSpec, role: 'spec' },
    { path: 'pages/test/TestPage.ts', content: basePom, role: 'pom' },
  ],
  affectedPaths: 'tests/web/test/',
  tokenUsage: { promptTokens: 100, completionTokens: 50, totalTokens: 150, costUSD: 0.001 },
};

const valid = JSON.stringify({ valid: true, errors: [] });
const invalid = (msgs: string[]) => JSON.stringify({
  valid: false,
  errors: msgs.map((m, i) => ({ line: i + 1, message: m })),
});

function makeFixResult(files: Array<{ path: string; content: string; role: string }>, tokens = { promptTokens: 20, completionTokens: 10, totalTokens: 30, costUSD: 0.0002 }) {
  return { args: { files }, tokenUsage: tokens };
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
    expect(result.files).toHaveLength(2);
    expect(result.files[0].content).toBe(baseSpec);
    expect(result.files[1].content).toBe(basePom);
    expect(result.tokenUsage.totalTokens).toBe(150);
    expect(mockRunAgent).not.toHaveBeenCalled();
  });

  it('fails tsc once then passes — warned: false, runAgent called once', async () => {
    const fixedSpec = 'import { test } from "@playwright/test";\ntest("fixed", async () => {});';
    mockValidateTs
      .mockResolvedValueOnce(invalid(['Unexpected token']))
      .mockResolvedValueOnce(valid);
    mockRunAgent.mockResolvedValue(makeFixResult([
      { path: 'tests/web/test/42-test-feature.spec.ts', content: fixedSpec, role: 'spec' },
    ]));

    const result = await runWithSelfCorrection(baseTask, 'qa/42-test');

    expect(result.warned).toBe(false);
    expect(result.files[0].content).toBe(fixedSpec);
    expect(mockRunAgent).toHaveBeenCalledTimes(1);
    expect(result.tokenUsage.totalTokens).toBe(150 + 30);
  });

  it('exhausts all tsc attempts — warned: true, warningMessage set', async () => {
    const fixedSpec = 'import { test } from "@playwright/test";\ntest("attempt", async () => {});';
    mockValidateTs.mockResolvedValue(invalid(['Persistent error']));
    mockRunAgent.mockResolvedValue(makeFixResult([
      { path: 'tests/web/test/42-test-feature.spec.ts', content: fixedSpec, role: 'spec' },
    ]));

    const result = await runWithSelfCorrection(baseTask, 'qa/42-test');

    expect(result.warned).toBe(true);
    expect(result.warningMessage).toContain('Persistent error');
    expect(result.warningMessage).toContain('3');
    // 2 files fail (spec + pom) → 2 parallel agents per attempt × 2 attempts before exhaustion = 4 calls
    // (attempt 3 short-circuits before invoking the agents)
    expect(mockRunAgent).toHaveBeenCalledTimes(4);
  });

  it('accumulates token usage across all correction rounds', async () => {
    const fixedSpec = 'import { test } from "@playwright/test";\ntest("fix2", async () => {});';
    // validate_typescript is called for EACH .ts file per attempt (spec + pom = 2 files)
    mockValidateTs
      .mockResolvedValueOnce(invalid(['error1'])) // attempt 1, spec
      .mockResolvedValueOnce(valid)               // attempt 1, pom
      .mockResolvedValueOnce(invalid(['error2'])) // attempt 2, spec
      .mockResolvedValueOnce(valid)               // attempt 2, pom
      .mockResolvedValueOnce(valid)               // attempt 3, spec
      .mockResolvedValueOnce(valid);              // attempt 3, pom
    mockRunAgent
      .mockResolvedValueOnce(makeFixResult([{ path: 'tests/web/test/42-test-feature.spec.ts', content: fixedSpec, role: 'spec' }], { promptTokens: 10, completionTokens: 5, totalTokens: 15, costUSD: 0.000125 }))
      .mockResolvedValueOnce(makeFixResult([{ path: 'tests/web/test/42-test-feature.spec.ts', content: fixedSpec, role: 'spec' }], { promptTokens: 20, completionTokens: 10, totalTokens: 30, costUSD: 0.00025 }));

    const result = await runWithSelfCorrection(baseTask, 'qa/42-test');

    expect(result.warned).toBe(false);
    expect(result.tokenUsage.totalTokens).toBe(150 + 15 + 30);
  });

  it('fixes violations one at a time — fix agent called once per violation round', async () => {
    const specWithTwoViolations =
      'import { test } from "../../../fixtures";\n' +
      'import { personas } from "../../../config/personas";\n' +
      'test("t", async ({ authPage }) => {\n' +
      '  await authPage.welcome(personas.patient.firstName);\n' +
      '  await authPage.expectUrl(personas.patient.route);\n' +
      '});';

    const specAfterFirstFix =
      'import { test } from "../../../fixtures";\n' +
      'import { personas } from "../../../config/personas";\n' +
      'test("t", async ({ authPage }) => {\n' +
      '  await authPage.welcome(personas.patient.displayName);\n' +
      '  await authPage.expectUrl(personas.patient.route);\n' +
      '});';

    const specFullyFixed =
      'import { test } from "../../../fixtures";\n' +
      'import { personas } from "../../../config/personas";\n' +
      'test("t", async ({ authPage }) => {\n' +
      '  await authPage.welcome(personas.patient.displayName);\n' +
      '  await authPage.expectUrl(/\\/dashboard/);\n' +
      '});';

    const personaMap = { user: { email: 'a@b.com', password: 'pw', displayName: 'Jane Doe', role: 'member' } };
    const { getPersonas } = await import('./personas');
    (getPersonas as jest.Mock).mockResolvedValue(personaMap);

    mockValidateTs.mockResolvedValue(valid);
    mockRunQaAgent.mockResolvedValueOnce({
      ...baseQaResult,
      files: [{ path: 'tests/web/test/42-test-feature.spec.ts', content: specWithTwoViolations.replace(/patient/g, 'user'), role: 'spec' }, baseQaResult.files[1]],
    });
    const specAfterFirstFixUser = specAfterFirstFix.replace(/patient/g, 'user');
    const specFullyFixedUser = specFullyFixed.replace(/patient/g, 'user');
    mockRunAgent
      .mockResolvedValueOnce(makeFixResult([{ path: 'tests/web/test/42-test-feature.spec.ts', content: specAfterFirstFixUser, role: 'spec' }]))
      .mockResolvedValueOnce(makeFixResult([{ path: 'tests/web/test/42-test-feature.spec.ts', content: specFullyFixedUser, role: 'spec' }]));

    await runWithSelfCorrection(baseTask, 'qa/42-test');

    // Fix agent called twice — first attempt sends both violations together (parallel by file),
    // second attempt handles the remaining violation after re-check.
    expect(mockRunAgent).toHaveBeenCalledTimes(2);
    expect(mockRunAgent).toHaveBeenNthCalledWith(1,
      expect.stringContaining('Fix ALL violations'),
      expect.stringContaining('personas.user.firstName'),
      expect.any(Array), expect.any(Object), expect.any(Object),
    );
    expect(mockRunAgent).toHaveBeenNthCalledWith(2,
      expect.stringContaining('Fix ALL violations'),
      expect.stringContaining('personas.user.route'),
      expect.any(Array), expect.any(Object), expect.any(Object),
    );
  });

  it('passes the correct error context to the fix agent', async () => {
    const fixedSpec = 'import { test } from "@playwright/test";\ntest("fixed", async () => {});';
    mockValidateTs
      .mockResolvedValueOnce(invalid(['Cannot find module']))
      .mockResolvedValueOnce(valid);
    mockRunAgent.mockResolvedValue(makeFixResult([
      { path: 'tests/web/test/42-test-feature.spec.ts', content: fixedSpec, role: 'spec' },
    ]));

    await runWithSelfCorrection(baseTask, 'qa/42-test');

    expect(mockRunAgent).toHaveBeenCalledWith(
      expect.stringContaining('AST'),
      expect.stringContaining('Cannot find module'),
      expect.any(Array),
      expect.any(Object),
      expect.objectContaining({ maxIterations: 10 }),
    );
  });
});
