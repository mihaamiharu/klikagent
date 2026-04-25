# KlikAgent — AI-Powered QA Automation

KlikAgent is an intelligent QA automation service that bridges the gap between feature requirements and automated testing. It uses large language models (LLMs) to analyze acceptance criteria, crawl web applications, and generate production-quality Playwright test specifications and Page Object Models (POMs).

## Core Architecture

- **Webhook Server**: An Express-based listener (`src/webhook/server.ts`) that receives triggers from external services (GitHub, Jira, CI).
- **Orchestrator**: Routes incoming tasks to specialized AI flows (`src/orchestrator/`).
- **Agents**:
  - **QA Agent**: Generates initial test specs and POMs by exploring the target environment.
  - **Review Agent**: Addresses feedback from GitHub PR reviews by updating existing specs and POMs.
- **Crawler**: Uses Playwright's `ariaSnapshot` (AI-optimized YAML format) to provide the AI with a structured view of the application's UI.
- **Self-Correction**: An automated loop that validates generated TypeScript code and attempts to fix errors before committing.

## Dev Commands

```bash
npm run dev       # Start development server with hot-reload (nodemon + ts-node)
npm run build     # Compile TypeScript to JavaScript (tsc)
npm start         # Run the compiled server from dist/
npm test          # Execute the Jest test suite
npm run test:watch # Run tests in watch mode
```

## API Reference

| Endpoint | Method | Payload | Description |
|---|---|---|---|
| `/tasks` | POST | `QATask` | Trigger QA spec generation for a new feature/ticket. |
| `/reviews` | POST | `ReviewContext` | Trigger the Review Agent to fix a spec based on PR comments. |
| `/repos/provision` | POST | `ProvisionRequest`| Set up a new convention-compliant test repository. |
| `/tasks/:id/results`| POST | `TaskResult` | Callback for CI to report test execution results. |
| `/health` | GET | - | Server health check. |

## Development Conventions

### Branch & File Naming
- **Branches**: `qa/{ticketId}-{slug}` (e.g., `qa/KA-42-login-validation`).
- **Specs**: `tests/web/{feature}/{ticketId}.spec.ts`.
- **POMs**: Located in `tests/poms/`, path derived from the `Page` class name.

### Label-Driven Behavior
KlikAgent uses GitHub labels (passed in `QATask.metadata`) to control its behavior:
- `klikagent`: Triggers the generation flow.
- `scope:web` / `scope:api`: Controls whether the Playwright crawler is utilized.
- `rework:*`: Enables rework mode (aware of parent ticket context).

### AI Service
Configured via environment variables:
- `AI_BASE_URL`: API endpoint (OpenAI compatible).
- `AI_MODEL`: The model name (e.g., `MiniMax-M2.7`).
- `MAX_SELF_CORRECTION_ATTEMPTS`: Number of retries for fixing TypeScript/Lint errors (default: 2).

## Key Files & Directories

- `src/webhook/server.ts`: Entry point for the Express server.
- `src/agents/qaAgent.ts`: Core logic for the QA generation AI loop.
- `src/agents/reviewAgent.ts`: Logic for addressing PR review comments.
- `src/services/crawler.ts`: Playwright-based browser exploration tools.
- `src/services/ai.ts`: Interface for LLM communication.
- `src/types/index.ts`: Central TypeScript interface definitions.
- `AGENTS.md`: Detailed developer reference and testing guide.
