import { runAgent } from './ai';

// ─── Mocks ────────────────────────────────────────────────────────────────────

// jest.mock is hoisted above variable declarations, so we cannot reference
// outer variables inside the factory. Use __esModule: true and configure
// the instance in beforeEach instead.
jest.mock('openai', () => ({
  __esModule: true,
  default: jest.fn(),
}));
jest.mock('../utils/logger', () => ({ log: jest.fn() }));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const MockOpenAI = (require('openai') as { default: jest.Mock }).default;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeToolCallResponse(
  toolName: string,
  args: object,
  usage = { prompt_tokens: 100, completion_tokens: 50 },
) {
  return {
    choices: [{
      finish_reason: 'tool_calls',
      message: {
        role: 'assistant',
        tool_calls: [{
          id: 'call_1',
          type: 'function',
          function: { name: toolName, arguments: JSON.stringify(args) },
        }],
      },
    }],
    usage,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('runAgent', () => {
  let mockCreate: jest.Mock;

  beforeEach(() => {
    jest.useFakeTimers();
    process.env.AI_API_KEY = 'test-key';
    process.env.AI_BASE_URL = 'https://test.api';
    process.env.AI_MODEL = 'test-model';

    mockCreate = jest.fn();
    MockOpenAI.mockImplementation(() => ({
      chat: { completions: { create: mockCreate } },
    }));
  });

  afterEach(() => {
    jest.useRealTimers();
    delete process.env.AI_API_KEY;
    delete process.env.AI_BASE_URL;
    delete process.env.AI_MODEL;
    jest.resetAllMocks();
  });

  // ─── Token tracking ──────────────────────────────────────────────────────

  it('returns tokenUsage with prompt + completion + total on single iteration', async () => {
    mockCreate.mockResolvedValueOnce(
      makeToolCallResponse('done', { result: 'ok' }, { prompt_tokens: 100, completion_tokens: 50 }),
    );

    const { tokenUsage } = await runAgent('sys', 'msg', [], {});

    expect(tokenUsage).toEqual({ promptTokens: 100, completionTokens: 50, totalTokens: 150 });
  });

  it('accumulates tokens across multiple iterations', async () => {
    mockCreate
      .mockResolvedValueOnce(makeToolCallResponse('my_tool', {}, { prompt_tokens: 100, completion_tokens: 30 }))
      .mockResolvedValueOnce(makeToolCallResponse('done', { result: 'ok' }, { prompt_tokens: 200, completion_tokens: 40 }));

    const { tokenUsage } = await runAgent('sys', 'msg', [], {
      my_tool: async () => 'tool result',
    });

    expect(tokenUsage).toEqual({ promptTokens: 300, completionTokens: 70, totalTokens: 370 });
  });

  it('handles missing usage field without crashing (treats as zero)', async () => {
    const response = makeToolCallResponse('done', { result: 'ok' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (response as any).usage;
    mockCreate.mockResolvedValueOnce(response);

    const { tokenUsage } = await runAgent('sys', 'msg', [], {});

    expect(tokenUsage).toEqual({ promptTokens: 0, completionTokens: 0, totalTokens: 0 });
  });

  // ─── Return value ────────────────────────────────────────────────────────

  it('returns done() arguments in args field', async () => {
    mockCreate.mockResolvedValueOnce(
      makeToolCallResponse('done', { specContent: 'test content', pomContent: 'pom' }),
    );

    const { args } = await runAgent('sys', 'msg', [], {});

    expect(args).toEqual({ specContent: 'test content', pomContent: 'pom' });
  });

  it('calls the tool handler and continues to the next iteration', async () => {
    const handler = jest.fn().mockResolvedValue('tool output');

    mockCreate
      .mockResolvedValueOnce(makeToolCallResponse('my_tool', { input: 'x' }))
      .mockResolvedValueOnce(makeToolCallResponse('done', { result: 'ok' }));

    await runAgent('sys', 'msg', [], { my_tool: handler });

    expect(handler).toHaveBeenCalledWith({ input: 'x' });
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });

  // ─── Retry behaviour ─────────────────────────────────────────────────────

  it('retries on 529 and succeeds on the next attempt', async () => {
    const busyError = Object.assign(new Error('service busy'), { status: 529 });
    mockCreate
      .mockRejectedValueOnce(busyError)
      .mockResolvedValueOnce(makeToolCallResponse('done', { result: 'ok' }));

    const promise = runAgent('sys', 'msg', [], {});
    await jest.runAllTimersAsync();
    const { args } = await promise;

    expect(args).toEqual({ result: 'ok' });
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });

  it('retries on 429 and 503 as well', async () => {
    const err429 = Object.assign(new Error('rate limited'), { status: 429 });
    const err503 = Object.assign(new Error('unavailable'), { status: 503 });
    mockCreate
      .mockRejectedValueOnce(err429)
      .mockRejectedValueOnce(err503)
      .mockResolvedValueOnce(makeToolCallResponse('done', { result: 'ok' }));

    const promise = runAgent('sys', 'msg', [], {});
    await jest.runAllTimersAsync();
    const { args } = await promise;

    expect(args).toEqual({ result: 'ok' });
    expect(mockCreate).toHaveBeenCalledTimes(3);
  });

  it('throws immediately on a non-retryable error', async () => {
    const err400 = Object.assign(new Error('bad request'), { status: 400 });
    mockCreate.mockRejectedValueOnce(err400);

    await expect(runAgent('sys', 'msg', [], {})).rejects.toThrow('bad request');
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it('throws after exhausting all retries on a persistent transient error', async () => {
    const busyError = Object.assign(new Error('still busy'), { status: 529 });
    mockCreate.mockRejectedValue(busyError);

    const promise = runAgent('sys', 'msg', [], {}, { maxIterations: 1 });
    const assertion = expect(promise).rejects.toThrow('still busy');
    await jest.runAllTimersAsync();
    await assertion;
    // DEFAULT_MAX_RETRIES = 4 → 5 total attempts (0..4)
    expect(mockCreate).toHaveBeenCalledTimes(5);
  });

  // ─── Error cases ─────────────────────────────────────────────────────────

  it('recovers from finish_reason: length by injecting a continuation prompt', async () => {
    mockCreate
      .mockResolvedValueOnce({
        choices: [{ finish_reason: 'length', message: { role: 'assistant', content: 'partial...', tool_calls: undefined } }],
        usage: { prompt_tokens: 100, completion_tokens: 200 },
      })
      .mockResolvedValueOnce(makeToolCallResponse('done', { result: 'recovered' }, { prompt_tokens: 150, completion_tokens: 50 }));

    const { args, tokenUsage } = await runAgent('sys', 'msg', [], {});

    expect(args).toEqual({ result: 'recovered' });
    expect(mockCreate).toHaveBeenCalledTimes(2);
    // Recovery prompt is injected as the 4th message (index 3): sys, user, assistant(truncated), user(recovery)
    // Note: the messages array is mutated in-place after each iteration, so we check index 3 directly
    const secondCallMessages = mockCreate.mock.calls[1][0].messages as Array<{ role: string; content: string }>;
    expect(secondCallMessages[3]).toMatchObject({ role: 'user', content: expect.stringContaining('cut off') });
    expect(tokenUsage.totalTokens).toBe(500);
  });

  it('throws when model stops without calling a tool', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'done', tool_calls: undefined } }],
      usage: { prompt_tokens: 50, completion_tokens: 10 },
    });

    await expect(runAgent('sys', 'msg', [], {}))
      .rejects.toThrow('model stopped without calling done()');
  });

  it('throws when max iterations exceeded without done()', async () => {
    mockCreate.mockResolvedValue(makeToolCallResponse('my_tool', {}));

    await expect(runAgent('sys', 'msg', [], { my_tool: async () => 'ok' }, { maxIterations: 3 }))
      .rejects.toThrow('exceeded maxIterations (3)');
  });

  it('throws when an unknown tool is called', async () => {
    mockCreate.mockResolvedValueOnce(makeToolCallResponse('unknown_tool', {}));

    await expect(runAgent('sys', 'msg', [], {}))
      .rejects.toThrow('[AI] unknown tool: unknown_tool');
  });

  it('throws when AI_API_KEY is not set', async () => {
    delete process.env.AI_API_KEY;

    await expect(runAgent('sys', 'msg', [], {}))
      .rejects.toThrow('AI_API_KEY');
  });

  it('throws when AI_BASE_URL is not set', async () => {
    delete process.env.AI_BASE_URL;

    await expect(runAgent('sys', 'msg', [], {}))
      .rejects.toThrow('AI_BASE_URL');
  });
});
