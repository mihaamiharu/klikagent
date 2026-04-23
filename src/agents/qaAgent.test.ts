import { runQaAgent } from './qaAgent';
import { QATask } from '../types';

// ─── Mocks ────────────────────────────────────────────────────────────────────

jest.mock('../services/ai', () => ({
  runAgent: jest.fn(),
}));
jest.mock('../utils/logger', () => ({ log: jest.fn() }));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { runAgent } = require('../services/ai') as { runAgent: jest.Mock };

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTask(overrides: Partial<QATask> = {}): QATask {
  return {
    taskId: '21',
    title: 'Doctor reviews',
    description: '## Acceptance Criteria\nGiven a patient views a completed appointment...',
    qaEnvUrl: 'https://qa.example.com',
    outputRepo: 'klikagent-tests',
    ...overrides,
  };
}

function makeAgentResult(overrides: object = {}) {
  return {
    args: {
      enrichedSpec: 'test("reviews", async () => {});',
      poms: [{ pomContent: 'export class ReviewsPage {}', pomPath: 'pages/general/ReviewsPage.ts' }],
      affectedPaths: 'tests/web/general/',
      ...overrides,
    },
    tokenUsage: { promptTokens: 100, completionTokens: 50, totalTokens: 150, costUSD: 0.001 },
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('runQaAgent', () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('returns enrichedSpec, poms, affectedPaths, tokenUsage from agent', async () => {
    runAgent.mockResolvedValueOnce(makeAgentResult());

    const result = await runQaAgent(makeTask(), 'qa/21-doctor-reviews');

    expect(result.enrichedSpec).toBe('test("reviews", async () => {});');
    expect(result.poms[0].pomContent).toBe('export class ReviewsPage {}');
    expect(result.poms[0].pomPath).toBe('pages/general/ReviewsPage.ts');
    expect(result.affectedPaths).toBe('tests/web/general/');
    expect(result.tokenUsage).toEqual({ promptTokens: 100, completionTokens: 50, totalTokens: 150, costUSD: 0.001 });
  });

  it('calls runAgent with qaTools and qaHandlers', async () => {
    runAgent.mockResolvedValueOnce(makeAgentResult());

    await runQaAgent(makeTask(), 'qa/21');

    expect(runAgent).toHaveBeenCalledTimes(1);
    const [, , tools, handlers] = runAgent.mock.calls[0];
    const toolNames = tools.map((t: { function: { name: string } }) => t.function.name);
    expect(toolNames).toContain('browser_navigate');
    expect(toolNames).toContain('browser_snapshot');
    expect(toolNames).toContain('validate_typescript');
    expect(toolNames).toContain('done');
    expect(handlers).toHaveProperty('browser_navigate');
    expect(handlers).toHaveProperty('browser_snapshot');
    expect(handlers).toHaveProperty('validate_typescript');
  });

  it('includes taskId, title, description, and qaEnvUrl in the user message', async () => {
    runAgent.mockResolvedValueOnce(makeAgentResult());

    await runQaAgent(makeTask(), 'qa/21');

    const userMessage = runAgent.mock.calls[0][1] as string;
    expect(userMessage).toContain('21');
    expect(userMessage).toContain('Doctor reviews');
    expect(userMessage).toContain('Given a patient views a completed appointment');
    expect(userMessage).toContain('https://qa.example.com');
  });

  it('includes the branch in the user message', async () => {
    runAgent.mockResolvedValueOnce(makeAgentResult());

    await runQaAgent(makeTask(), 'qa/21-doctor-reviews');

    const userMessage = runAgent.mock.calls[0][1] as string;
    expect(userMessage).toContain('qa/21-doctor-reviews');
  });

  it('propagates agent errors', async () => {
    runAgent.mockRejectedValueOnce(new Error('AI timeout'));

    await expect(
      runQaAgent(makeTask(), 'qa/21'),
    ).rejects.toThrow('AI timeout');
  });
});
