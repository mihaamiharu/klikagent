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

export { browserTools, browserHandlers, getPersonas } from '../../services/browserTools';
