export { browserTools, browserHandlers } from '../../services/browserTools';
import { browserTools, browserHandlers } from '../../services/browserTools';
import { AgentTool, ToolHandlers } from '../../types';
import { repoToolDefs, createRepoToolHandlers } from './repoTools';
import { githubToolDefs, createGithubToolHandlers } from './githubTools';
import {
  reviewDoneTool, qaDoneTool, explorationDoneTool,
  validateTypescriptTool, validateTypescriptHandler,
} from './outputTools';

function merge(...handlers: ToolHandlers[]): ToolHandlers {
  return Object.assign({}, ...handlers);
}

// Explorer: browser tools + repo read tools + exploration done
// No validate_typescript — explorer does not write code
export const explorerTools: AgentTool[] = [...browserTools, ...repoToolDefs, explorationDoneTool];

// Writer: only validate + done — all context is pre-fetched and injected into the user message
export const writerTools: AgentTool[] = [validateTypescriptTool, qaDoneTool];

// Review agent tools (unchanged)
export const reviewTools: AgentTool[] = [...repoToolDefs, ...githubToolDefs, validateTypescriptTool, reviewDoneTool];

// Legacy combined tool set — kept for backwards compatibility with any tests that reference it
export const qaTools: AgentTool[] = [...browserTools, ...repoToolDefs, validateTypescriptTool, qaDoneTool];

export function createExplorerHandlers(repoName: string): ToolHandlers {
  return merge(browserHandlers, createRepoToolHandlers(repoName));
}

export function createWriterHandlers(): ToolHandlers {
  // Writer has no repo tools — context is fully pre-fetched by the orchestrator
  return validateTypescriptHandler;
}

export function createQaHandlers(repoName: string): ToolHandlers {
  return merge(browserHandlers, createRepoToolHandlers(repoName), validateTypescriptHandler);
}

export function createReviewHandlers(repoName: string): ToolHandlers {
  return merge(createRepoToolHandlers(repoName), createGithubToolHandlers(repoName), validateTypescriptHandler);
}
