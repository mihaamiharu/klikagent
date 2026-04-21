import OpenAI from 'openai';
import { AgentTool, ToolHandlers } from '../types';
import { log } from '../utils/logger';

const DEFAULT_MAX_ITERATIONS = parseInt(process.env.AI_MAX_ITERATIONS ?? '30', 10);
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
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface AgentRunResult {
  args: Record<string, unknown>;
  tokenUsage: TokenUsage;
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

  // Cache tool results so duplicate calls don't re-inflate the context.
  // done() and validate_typescript are excluded — they're side-effectful or need fresh data.
  const UNCACHEABLE_TOOLS = new Set(['done', 'validate_typescript']);
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

    // Log reasoning text if the model included any before tool calls
    if (assistantMessage.content) {
      const preview = assistantMessage.content.slice(0, 300).replace(/\n/g, ' ');
      log('INFO', `[AI] reasoning: ${preview}${assistantMessage.content.length > 300 ? '…' : ''}`);
    }

    // Append assistant turn to history
    messages.push(assistantMessage);

    if (choice.finish_reason === 'length') {
      // Model hit the token limit mid-response — inject a recovery prompt and continue
      log('WARN', `[AI] response truncated (finish_reason: length) at iteration ${iteration + 1} — injecting recovery prompt`);
      messages.push({ role: 'user', content: 'Your response was cut off due to length limits. Please continue where you left off and call the appropriate tool.' });
      continue;
    }

    if (choice.finish_reason !== 'tool_calls' || !assistantMessage.tool_calls?.length) {
      // Model finished without calling a tool — treat as error
      throw new Error(`[AI] model stopped without calling done() — finish_reason: ${choice.finish_reason}`);
    }

    const toolResultMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [];

    for (const toolCall of assistantMessage.tool_calls) {
      if (toolCall.type !== 'function') continue;
      const name = toolCall.function.name;
      const args = JSON.parse(toolCall.function.arguments) as Record<string, unknown>;

      const argsSummary = Object.entries(args)
        .filter(([k]) => k !== 'code') // skip large code blobs in logs
        .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
        .join(', ');
      log('INFO', `[AI] tool call: ${name}${argsSummary ? ` (${argsSummary})` : ''}`);

      // done() exits the loop
      if (name === 'done') {
        const tokenUsage: TokenUsage = {
          promptTokens,
          completionTokens,
          totalTokens: promptTokens + completionTokens,
        };
        log('INFO', `[AI] tokens used — prompt: ${promptTokens}, completion: ${completionTokens}, total: ${tokenUsage.totalTokens}`);
        return { args, tokenUsage };
      }

      const handler = toolHandlers[name];
      if (!handler) {
        throw new Error(`[AI] unknown tool: ${name}`);
      }

      const cacheKey = `${name}:${JSON.stringify(args)}`;
      let result: string;
      if (!UNCACHEABLE_TOOLS.has(name) && toolCache.has(cacheKey)) {
        log('INFO', `[AI] cache hit for ${name} — skipping duplicate fetch`);
        result = `[ALREADY FETCHED — this result is already in your context from an earlier call. Do not call this tool again with the same arguments.]`;
      } else {
        const raw = await handler(args);
        result = typeof raw === 'string' ? raw : JSON.stringify(raw);
        if (!UNCACHEABLE_TOOLS.has(name)) toolCache.set(cacheKey, result);
        const resultPreview = result.slice(0, 200).replace(/\n/g, ' ');
        log('INFO', `[AI] tool result: ${resultPreview}${result.length > 200 ? `… (${result.length} chars total)` : ''}`);
      }
      toolResultMessages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: result,
      });
    }

    messages.push(...toolResultMessages);
  }

  throw new Error(`[AI] agent exceeded maxIterations (${maxIterations}) without calling done()`);
}
