import { runQaAgent } from './qaAgent';
import { GitHubIssue } from '../types';

// ─── Mocks ────────────────────────────────────────────────────────────────────

jest.mock('../services/ai', () => ({
  runAgent: jest.fn(),
}));
jest.mock('../utils/logger', () => ({ log: jest.fn() }));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { runAgent } = require('../services/ai') as { runAgent: jest.Mock };

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeIssue(overrides: Partial<GitHubIssue> = {}): GitHubIssue {
  return {
    number: 21,
    title: 'Doctor reviews',
    body: '## Personas\n- patient\n- doctor\n\n## Acceptance Criteria\nGiven a patient views a completed appointment...',
    labels: ['feature:reviews'],
    url: 'https://github.com/mihaamiharu/caresync/issues/21',
    ...overrides,
  };
}

function makeAgentResult(overrides: object = {}) {
  return {
    args: {
      enrichedSpec: 'test("reviews", async () => {});',
      pomContent: 'export class ReviewsPage {}',
      pomPath: 'pages/reviews/ReviewsPage.ts',
      affectedPaths: 'tests/web/reviews/',
      ...overrides,
    },
    tokenUsage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('runQaAgent', () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('returns enrichedSpec, pomContent, pomPath, affectedPaths, tokenUsage from agent', async () => {
    runAgent.mockResolvedValueOnce(makeAgentResult());

    const result = await runQaAgent(
      makeIssue(),
      'reviews',
      'qa/21-doctor-reviews',
      ['patient', 'doctor'],
      ['/appointments/1', '/doctors/1'],
      'diff content',
    );

    expect(result.enrichedSpec).toBe('test("reviews", async () => {});');
    expect(result.pomContent).toBe('export class ReviewsPage {}');
    expect(result.pomPath).toBe('pages/reviews/ReviewsPage.ts');
    expect(result.affectedPaths).toBe('tests/web/reviews/');
    expect(result.tokenUsage).toEqual({ promptTokens: 100, completionTokens: 50, totalTokens: 150 });
  });

  it('calls runAgent with qaTools and qaHandlers', async () => {
    runAgent.mockResolvedValueOnce(makeAgentResult());

    await runQaAgent(makeIssue(), 'reviews', 'qa/21', ['patient'], ['/reviews'], '');

    expect(runAgent).toHaveBeenCalledTimes(1);
    const [, , tools, handlers] = runAgent.mock.calls[0];
    // qaTools includes browser tools, repo tools, validate_typescript, and done
    const toolNames = tools.map((t: { function: { name: string } }) => t.function.name);
    expect(toolNames).toContain('browser_navigate');
    expect(toolNames).toContain('browser_snapshot');
    expect(toolNames).toContain('validate_typescript');
    expect(toolNames).toContain('done');
    // handlers cover all tools
    expect(handlers).toHaveProperty('browser_navigate');
    expect(handlers).toHaveProperty('browser_snapshot');
    expect(handlers).toHaveProperty('validate_typescript');
  });

  it('includes personas and starting URLs in the user message', async () => {
    runAgent.mockResolvedValueOnce(makeAgentResult());

    await runQaAgent(
      makeIssue(),
      'reviews',
      'qa/21',
      ['patient', 'doctor'],
      ['/appointments/1', '/doctors/42'],
      '',
    );

    const userMessage = runAgent.mock.calls[0][1] as string;
    expect(userMessage).toContain('- patient');
    expect(userMessage).toContain('- doctor');
    expect(userMessage).toContain('/appointments/1');
    expect(userMessage).toContain('/doctors/42');
  });

  it('includes issue AC and feature in the user message', async () => {
    runAgent.mockResolvedValueOnce(makeAgentResult());

    await runQaAgent(makeIssue(), 'reviews', 'qa/21', [], [], 'some diff');

    const userMessage = runAgent.mock.calls[0][1] as string;
    expect(userMessage).toContain('Issue #21');
    expect(userMessage).toContain('Doctor reviews');
    expect(userMessage).toContain('Feature: reviews');
    expect(userMessage).toContain('some diff');
  });

  it('falls back to "default" persona label when no personas provided', async () => {
    runAgent.mockResolvedValueOnce(makeAgentResult());

    await runQaAgent(makeIssue(), 'reviews', 'qa/21', [], [], '');

    const userMessage = runAgent.mock.calls[0][1] as string;
    expect(userMessage).toContain('- default');
  });

  it('propagates agent errors', async () => {
    runAgent.mockRejectedValueOnce(new Error('AI timeout'));

    await expect(
      runQaAgent(makeIssue(), 'reviews', 'qa/21', ['patient'], [], ''),
    ).rejects.toThrow('AI timeout');
  });
});
