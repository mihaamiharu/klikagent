import { AgentTool, ToolHandlers } from '../../types';
import { repoToolDefs, repoToolHandlers } from './repoTools';
import { githubToolDefs, githubToolHandlers } from './githubTools';
import {
  enrichmentDoneTool, reviewDoneTool,
  validateTypescriptTool, validateTypescriptHandler,
} from './outputTools';

function merge(...handlers: ToolHandlers[]): ToolHandlers {
  return Object.assign({}, ...handlers);
}

export const enrichmentTools: AgentTool[] = [...repoToolDefs, validateTypescriptTool, enrichmentDoneTool];
export const enrichmentHandlers: ToolHandlers = merge(repoToolHandlers, validateTypescriptHandler);

export const reviewTools: AgentTool[] = [...repoToolDefs, ...githubToolDefs, validateTypescriptTool, reviewDoneTool];
export const reviewHandlers: ToolHandlers = merge(repoToolHandlers, githubToolHandlers, validateTypescriptHandler);
