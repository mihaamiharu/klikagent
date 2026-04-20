import OpenAI from 'openai';
import { AgentTool, ToolHandlers } from '../types';
import { log } from '../utils/logger';

const DEFAULT_MAX_ITERATIONS = 20;

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
  const maxTokens = options.maxTokens ?? 8192;
  const maxIterations = options.maxIterations ?? DEFAULT_MAX_ITERATIONS;

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userMessage },
  ];

  let promptTokens = 0;
  let completionTokens = 0;

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    log('INFO', `[AI] iteration ${iteration + 1}/${maxIterations}`);

    const response = await client.chat.completions.create({
      model,
      max_tokens: maxTokens,
      tools: tools as OpenAI.Chat.ChatCompletionTool[],
      tool_choice: 'auto',
      messages,
    });

    if (response.usage) {
      promptTokens += response.usage.prompt_tokens;
      completionTokens += response.usage.completion_tokens;
    }

    const choice = response.choices[0];
    const assistantMessage = choice.message;

    // Append assistant turn to history
    messages.push(assistantMessage);

    if (choice.finish_reason !== 'tool_calls' || !assistantMessage.tool_calls?.length) {
      // Model finished without calling a tool — treat as error
      throw new Error(`[AI] model stopped without calling done() — finish_reason: ${choice.finish_reason}`);
    }

    const toolResultMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [];

    for (const toolCall of assistantMessage.tool_calls) {
      if (toolCall.type !== 'function') continue;
      const name = toolCall.function.name;
      const args = JSON.parse(toolCall.function.arguments) as Record<string, unknown>;

      log('INFO', `[AI] tool call: ${name}`);

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

      const result = await handler(args);
      toolResultMessages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: typeof result === 'string' ? result : JSON.stringify(result),
      });
    }

    messages.push(...toolResultMessages);
  }

  throw new Error(`[AI] agent exceeded maxIterations (${maxIterations}) without calling done()`);
}
