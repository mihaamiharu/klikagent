/**
 * src/agents/tools/index.ts
 *
 * Central export point for all OpenAI function-calling tool definitions and
 * their corresponding handler maps. Import from here when wiring tools into
 * an agent via runAgent().
 *
 * Usage example:
 *
 *   import { browserTools, browserHandlers } from '../agents/tools';
 *
 *   await runAgent(systemPrompt, userMsg, browserTools, browserHandlers);
 */

export { browserTools, browserHandlers } from '../../services/browserTools';
import { browserTools, browserHandlers } from '../../services/browserTools';
import { AgentTool, ToolHandlers } from '../../types';
import { repoToolDefs, repoToolHandlers } from './repoTools';
import { githubToolDefs, githubToolHandlers } from './githubTools';
import {
  reviewDoneTool, qaDoneTool,
  validateTypescriptTool, validateTypescriptHandler,
} from './outputTools';

function merge(...handlers: ToolHandlers[]): ToolHandlers {
  return Object.assign({}, ...handlers);
}

export const reviewTools: AgentTool[] = [...repoToolDefs, ...githubToolDefs, validateTypescriptTool, reviewDoneTool];
export const reviewHandlers: ToolHandlers = merge(repoToolHandlers, githubToolHandlers, validateTypescriptHandler);

export const qaTools: AgentTool[] = [...browserTools, ...repoToolDefs, validateTypescriptTool, qaDoneTool];
export const qaHandlers: ToolHandlers = merge(browserHandlers, repoToolHandlers, validateTypescriptHandler);
