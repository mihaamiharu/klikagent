export { browserTools, browserHandlers } from '../../services/browserTools';
import { browserTools, browserHandlers } from '../../services/browserTools';
import { AgentTool, ToolHandlers } from '../../types';
import { repoToolDefs, createRepoToolHandlers } from './repoTools';
import { githubToolDefs, createGithubToolHandlers } from './githubTools';
import {
  reviewDoneTool, qaDoneTool,
  validateTypescriptTool, validateTypescriptHandler,
} from './outputTools';

function merge(...handlers: ToolHandlers[]): ToolHandlers {
  return Object.assign({}, ...handlers);
}

export const reviewTools: AgentTool[] = [...repoToolDefs, ...githubToolDefs, validateTypescriptTool, reviewDoneTool];
export const qaTools: AgentTool[] = [...browserTools, ...repoToolDefs, validateTypescriptTool, qaDoneTool];

export function createQaHandlers(repoName: string): ToolHandlers {
  return merge(browserHandlers, createRepoToolHandlers(repoName), validateTypescriptHandler);
}

export function createReviewHandlers(repoName: string): ToolHandlers {
  return merge(createRepoToolHandlers(repoName), createGithubToolHandlers(repoName), validateTypescriptHandler);
}
