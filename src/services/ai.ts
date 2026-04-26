import OpenAI from 'openai';
import { AgentTool, ToolHandlers } from '../types';
import { log } from '../utils/logger';
import { dashboardBus } from '../dashboard/eventBus';

const DEFAULT_MAX_ITERATIONS = parseInt(process.env.AI_MAX_ITERATIONS ?? '50', 10);
const RETRYABLE_STATUS_CODES = new Set([429, 503, 529]);
const DEFAULT_MAX_RETRIES = 4;
const BASE_DELAY_MS = 2000;

// Retries the API call on transient errors (429/503/529) with exponential backoff.
// Non-retryable errors are re-thrown immediately.
async function callWithRetry(
  fn: () => Promise<OpenAI.Chat.ChatCompletion>,
  maxRetries = DEFAULT_MAX_RETRIES,
): Promise<OpenAI.Chat.ChatCompletion> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (!RETRYABLE_STATUS_CODES.has(status ?? 0) || attempt === maxRetries) throw err;
      const delayMs = BASE_DELAY_MS * 2 ** attempt;
      log('WARN', `[AI] transient error (status ${status}), retrying in ${delayMs}ms (attempt ${attempt + 1}/${maxRetries})`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  /* istanbul ignore next */
  throw new Error('[AI] unreachable');
}

function makeClient(): OpenAI {
  const apiKey = process.env.AI_API_KEY;
  const baseURL = process.env.AI_BASE_URL;
  if (!apiKey) throw new Error('AI_API_KEY env var is not set');
  if (!baseURL) throw new Error('AI_BASE_URL env var is not set');
  return new OpenAI({ apiKey, baseURL });
}

export interface RunAgentOptions {
  model?: string;
  maxTokens?: number;
  maxIterations?: number;
  // Called after each tool executes — sequentially after each sequential tool, or in batch
  // (all at once) after parallel tools complete. Return a new system prompt to trigger a phase
  // change (replaces messages[0]), or null to leave the prompt unchanged.
  onToolCall?: (toolName: string) => string | null;
}

// MiniMax M2.7 pricing (per 1M tokens) — update if model changes
const PROMPT_COST_PER_M = 5;    // USD per 1M prompt tokens
const COMPLETION_COST_PER_M = 10; // USD per 1M completion tokens

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUSD: number;
}

function computeCost(promptTokens: number, completionTokens: number): number {
  return (promptTokens / 1_000_000) * PROMPT_COST_PER_M
    + (completionTokens / 1_000_000) * COMPLETION_COST_PER_M;
}

export interface AgentRunResult {
  args: Record<string, unknown>;
  tokenUsage: TokenUsage;
}

// Tools that maintain shared browser/terminal state and must run in order.
// Any batch containing one of these falls back to fully sequential execution.
const SEQUENTIAL_TOOLS = new Set([
  'browser_navigate', 'browser_click', 'browser_fill',
  'browser_snapshot', 'browser_list_interactables',
  'browser_generate_locator', 'browser_eval',
  'browser_command', 'browser_close',
  'validate_typescript',
  'done',
]);

// Cache tool results so duplicate calls don't re-inflate the context.
// done() and stateful browser tools are excluded.
const UNCACHEABLE_TOOLS = new Set([
  'done',
  'validate_typescript',
  'browser_navigate',
  'browser_snapshot',
  'browser_click',
  'browser_fill',
  'browser_list_interactables',
  'browser_close',
]);

interface FunctionToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

async function executeToolCall(
  toolCall: FunctionToolCall,
  handlers: ToolHandlers,
  toolCache: Map<string, string>,
  toolPending: Map<string, Promise<string>>,
): Promise<{ id: string; result: string }> {
  const name = toolCall.function.name;
  const args = JSON.parse(toolCall.function.arguments) as Record<string, unknown>;

  const argsSummary = Object.entries(args)
    .filter(([k]) => k !== 'code')
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join(', ');
  log('INFO', `[AI] tool call: ${name}${argsSummary ? ` (${argsSummary})` : ''}`);
  dashboardBus.emitEvent('agent', 'info', `Tool Call: ${name}`, { toolCall: name, args });

  const cacheKey = `${name}:${JSON.stringify(args)}`;
  let result: string;

  if (!UNCACHEABLE_TOOLS.has(name) && toolCache.has(cacheKey)) {
    log('INFO', `[AI] cache hit for ${name} — skipping duplicate fetch`);
    result = `[ALREADY FETCHED — this result is already in your context from an earlier call. Do not call this tool again with the same arguments.]`;
  } else if (!UNCACHEABLE_TOOLS.has(name) && toolPending.has(cacheKey)) {
    log('INFO', `[AI] dedup hit for ${name} — awaiting in-flight request`);
    result = await toolPending.get(cacheKey)!;
  } else {
    const handler = handlers[name];
    if (!handler) throw new Error(`[AI] unknown tool: ${name}`);

    const promise = (async () => {
      const raw = await handler(args);
      return typeof raw === 'string' ? raw : JSON.stringify(raw);
    })();

    if (!UNCACHEABLE_TOOLS.has(name)) toolPending.set(cacheKey, promise);
    result = await promise;
    if (!UNCACHEABLE_TOOLS.has(name)) toolCache.set(cacheKey, result);
  }

  const resultPreview = result.slice(0, 200).replace(/\n/g, ' ');
  log('INFO', `[AI] tool result: ${resultPreview}${result.length > 200 ? `… (${result.length} chars total)` : ''}`);

  return { id: toolCall.id, result };
}

// Provider-agnostic agent tool loop using OpenAI-compatible API (works with Minimax).
// Runs until the agent calls done(), then returns done()'s parsed arguments plus token usage.
export async function runAgent(
  systemPrompt: string,
  userMessage: string,
  tools: AgentTool[],
  toolHandlers: ToolHandlers,
  options: RunAgentOptions = {}
): Promise<AgentRunResult> {
  const client = makeClient();
  const model = options.model ?? process.env.AI_MODEL ?? 'MiniMax-M2.7';
  const maxTokens = options.maxTokens ?? Number(process.env.AI_MAX_TOKENS ?? 32768);
  const maxIterations = options.maxIterations ?? DEFAULT_MAX_ITERATIONS;

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userMessage },
  ];

  let promptTokens = 0;
  let completionTokens = 0;

  const toolCache = new Map<string, string>();

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    log('INFO', `[AI] iteration ${iteration + 1}/${maxIterations}`);

    const response = await callWithRetry(() =>
      client.chat.completions.create({
        model,
        max_tokens: maxTokens,
        tools: tools as OpenAI.Chat.ChatCompletionTool[],
        tool_choice: 'auto',
        messages,
      }),
    );

    if (response.usage) {
      promptTokens += response.usage.prompt_tokens;
      completionTokens += response.usage.completion_tokens;
      log('INFO', `[AI] tokens this iteration — prompt: ${response.usage.prompt_tokens}, completion: ${response.usage.completion_tokens}`);
    }

    const choice = response.choices[0];
    const assistantMessage = choice.message;

    if (assistantMessage.content) {
      const preview = assistantMessage.content.slice(0, 300).replace(/\n/g, ' ');
      log('INFO', `[AI] reasoning: ${preview}${assistantMessage.content.length > 300 ? '…' : ''}`);
      dashboardBus.emitEvent('agent', 'info', 'AI Reasoning', { reasoning: assistantMessage.content });
    }

    messages.push(assistantMessage);

    if (choice.finish_reason === 'length') {
      log('WARN', `[AI] response truncated (finish_reason: length) at iteration ${iteration + 1} — injecting recovery prompt`);
      messages.push({ role: 'user', content: 'Your response was cut off due to length limits. Please continue where you left off and call the appropriate tool.' });
      continue;
    }

    if (choice.finish_reason !== 'tool_calls' || !assistantMessage.tool_calls?.length) {
      throw new Error(`[AI] model stopped without calling done() — finish_reason: ${choice.finish_reason}`);
    }

    const toolCalls = assistantMessage.tool_calls.filter(tc => tc.type === 'function') as FunctionToolCall[];
    const hasSequential = toolCalls.some(tc => SEQUENTIAL_TOOLS.has(tc.function.name));
    const toolResultMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [];

    if (hasSequential) {
      for (const toolCall of toolCalls) {
        const name = toolCall.function.name;

        if (name === 'done') {
          const args = JSON.parse(toolCall.function.arguments) as Record<string, unknown>;
          log('INFO', '[AI] tool call: done');
          dashboardBus.emitEvent('agent', 'info', `Tool Call: done`, { toolCall: 'done', args });
          const tokenUsage: TokenUsage = {
            promptTokens,
            completionTokens,
            totalTokens: promptTokens + completionTokens,
            costUSD: computeCost(promptTokens, completionTokens),
          };
          log('INFO', `[AI] tokens used — prompt: ${promptTokens}, completion: ${completionTokens}, total: ${tokenUsage.totalTokens}, cost: $${tokenUsage.costUSD.toFixed(4)}`);
          dashboardBus.emitEvent('agent', 'info', 'AI Token Usage', { tokenUsage });
          return { args, tokenUsage };
        }

        const { id, result } = await executeToolCall(toolCall, toolHandlers, toolCache, new Map());

        const newPrompt = options.onToolCall?.(name);
        if (newPrompt != null) {
          messages[0] = { role: 'system', content: newPrompt };
        }

        toolResultMessages.push({ role: 'tool', tool_call_id: id, content: result });
      }
    } else {
      // All tools are parallel-safe — fire with Promise.all
      const toolPending = new Map<string, Promise<string>>();
      const results = await Promise.all(
        toolCalls.map(tc => executeToolCall(tc, toolHandlers, toolCache, toolPending))
      );
      // Fire onToolCall for each (parallel tools never trigger phase changes, but keep history accurate)
      for (const tc of toolCalls) {
        options.onToolCall?.(tc.function.name);
      }
      for (const { id, result } of results) {
        toolResultMessages.push({ role: 'tool', tool_call_id: id, content: result });
      }
    }

    messages.push(...toolResultMessages);
  }

  throw new Error(`[AI] agent exceeded maxIterations (${maxIterations}) without calling done()`);
}
