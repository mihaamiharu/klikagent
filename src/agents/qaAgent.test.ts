import { runQaAgent } from './qaAgent';
import { QATask, ExplorationReport, WriterContext } from '../types';

// ─── Mocks ────────────────────────────────────────────────────────────────────

jest.mock('./explorerAgent');
jest.mock('./writerAgent');
jest.mock('../services/writerContext');

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { runExplorerAgent } = require('./explorerAgent') as { runExplorerAgent: jest.Mock };
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { runWriterAgent } = require('./writerAgent') as { runWriterAgent: jest.Mock };
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { prefetchBaseContext, resolveWriterContext } = require('../services/writerContext') as {
  prefetchBaseContext: jest.Mock;
  resolveWriterContext: jest.Mock;
};

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

const baseTokenUsage = { promptTokens: 100, completionTokens: 50, totalTokens: 150, costUSD: 0.001 };

const mockReport: ExplorationReport = {
  feature: 'doctors',
  visitedRoutes: ['/doctor', '/doctor/reviews'],
  authPersona: 'patient',
  locators: { '/doctor': { reviewsTab: "page.getByRole('tab', { name: 'Reviews' })" } },
  flows: [{ name: 'view reviews', steps: 'navigate /doctor → click Reviews tab', observed: 'review list visible' }],
  missingLocators: [],
  notes: [],
};

const mockBaseCtx = {
  fixtures: 'export const test = base.extend({});',
  personas: 'export const personas = {};',
  contextDocs: '',
  availablePoms: [],
};

const mockCtx: WriterContext = {
  ...mockBaseCtx,
  existingTests: {},
  existingPom: null,
};

const mockWriterResult = {
  feature: 'doctors',
  enrichedSpec: 'test("reviews", async () => {});',
  poms: [{ pomContent: 'export class DoctorPage {}', pomPath: 'pages/doctors/DoctorPage.ts' }],
  affectedPaths: 'tests/web/doctors/',
  fixtureUpdate: undefined,
  tokenUsage: baseTokenUsage,
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('runQaAgent', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    runExplorerAgent.mockResolvedValue({ report: mockReport, tokenUsage: baseTokenUsage });
    prefetchBaseContext.mockResolvedValue(mockBaseCtx);
    resolveWriterContext.mockResolvedValue(mockCtx);
    runWriterAgent.mockResolvedValue(mockWriterResult);
  });

  it('runs explorerAgent and prefetchBaseContext in parallel, then writer', async () => {
    const started: string[] = [];
    const finished: string[] = [];

    runExplorerAgent.mockImplementation(async () => {
      started.push('explorer');
      await new Promise(r => setTimeout(r, 10));
      finished.push('explorer');
      return { report: mockReport, tokenUsage: baseTokenUsage };
    });
    prefetchBaseContext.mockImplementation(async () => {
      started.push('base');
      finished.push('base');
      return mockBaseCtx;
    });
    resolveWriterContext.mockResolvedValue(mockCtx);
    runWriterAgent.mockImplementation(async () => {
      started.push('writer');
      finished.push('writer');
      return mockWriterResult;
    });

    await runQaAgent(makeTask(), 'qa/21', 'klikagent-tests');

    // Both explorer and base start before either finishes (parallel)
    expect(started.slice(0, 2).sort()).toEqual(['base', 'explorer']);
    // Writer always starts after explorer and base finish
    expect(finished.indexOf('writer')).toBeGreaterThan(finished.indexOf('explorer'));
  });

  it('passes the exploration report to writerAgent', async () => {
    await runQaAgent(makeTask(), 'qa/21', 'klikagent-tests');

    const [, , passedReport] = runWriterAgent.mock.calls[0];
    expect(passedReport).toEqual(mockReport);
  });

  it('passes the resolved context to writerAgent', async () => {
    await runQaAgent(makeTask(), 'qa/21', 'klikagent-tests');

    const [, , , passedCtx] = runWriterAgent.mock.calls[0];
    expect(passedCtx).toEqual(mockCtx);
  });

  it('resolves feature-specific context using the feature from the report', async () => {
    await runQaAgent(makeTask(), 'qa/21', 'klikagent-tests');

    expect(resolveWriterContext).toHaveBeenCalledWith('klikagent-tests', 'doctors', mockBaseCtx);
  });

  it('returns enrichedSpec, poms, affectedPaths, and feature from writerAgent', async () => {
    const result = await runQaAgent(makeTask(), 'qa/21', 'klikagent-tests');

    expect(result.feature).toBe('doctors');
    expect(result.enrichedSpec).toBe('test("reviews", async () => {});');
    expect(result.poms[0].pomPath).toBe('pages/doctors/DoctorPage.ts');
    expect(result.affectedPaths).toBe('tests/web/doctors/');
  });

  it('sums token usage from both agents', async () => {
    const explorerUsage = { promptTokens: 300, completionTokens: 100, totalTokens: 400, costUSD: 0.005 };
    const writerUsage   = { promptTokens: 100, completionTokens:  50, totalTokens: 150, costUSD: 0.001 };
    runExplorerAgent.mockResolvedValue({ report: mockReport, tokenUsage: explorerUsage });
    runWriterAgent.mockResolvedValue({ ...mockWriterResult, tokenUsage: writerUsage });

    const result = await runQaAgent(makeTask(), 'qa/21', 'klikagent-tests');

    expect(result.tokenUsage).toEqual({
      promptTokens:     400,
      completionTokens: 150,
      totalTokens:      550,
      costUSD:          0.006,
    });
  });

  it('propagates explorer errors without calling writerAgent', async () => {
    runExplorerAgent.mockRejectedValue(new Error('QA environment unreachable'));

    await expect(runQaAgent(makeTask(), 'qa/21', 'klikagent-tests')).rejects.toThrow('QA environment unreachable');
    expect(runWriterAgent).not.toHaveBeenCalled();
  });

  it('propagates writer errors', async () => {
    runWriterAgent.mockRejectedValue(new Error('TypeScript validation loop'));

    await expect(runQaAgent(makeTask(), 'qa/21', 'klikagent-tests')).rejects.toThrow('TypeScript validation loop');
  });
});
