import { AgentTool, ToolHandlers } from '../../types';
import { repoToolDefs, repoToolHandlers } from './repoTools';
import { githubToolDefs, githubToolHandlers } from './githubTools';
import {
  skeletonDoneTool, enrichmentDoneTool, reworkDoneTool, reviewDoneTool,
  validateTypescriptTool, validateTypescriptHandler,
} from './outputTools';

function merge(...handlers: ToolHandlers[]): ToolHandlers {
  return Object.assign({}, ...handlers);
}

export const skeletonTools: AgentTool[] = [...repoToolDefs, skeletonDoneTool];
export const skeletonHandlers: ToolHandlers = merge(repoToolHandlers, validateTypescriptHandler);

export const enrichmentTools: AgentTool[] = [...repoToolDefs, validateTypescriptTool, enrichmentDoneTool];
export const enrichmentHandlers: ToolHandlers = merge(repoToolHandlers, validateTypescriptHandler);

export const reworkTools: AgentTool[] = [...repoToolDefs, validateTypescriptTool, reworkDoneTool];
export const reworkHandlers: ToolHandlers = merge(repoToolHandlers, validateTypescriptHandler);

export const reviewTools: AgentTool[] = [...repoToolDefs, ...githubToolDefs, validateTypescriptTool, reviewDoneTool];
export const reviewHandlers: ToolHandlers = merge(repoToolHandlers, githubToolHandlers, validateTypescriptHandler);
