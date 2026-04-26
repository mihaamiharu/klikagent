# KlikAgent — AI-Powered QA Automation

KlikAgent is an intelligent QA automation service that generates production-quality Playwright test specifications and Page Object Models (POMs) by exploring web applications using LLMs.

## Project Overview

- **Purpose**: Bridge the gap between feature requirements (acceptance criteria) and automated testing.
- **Main Technologies**: Node.js, TypeScript, Express, Playwright (ariaSnapshot), OpenAI SDK.
- **Architecture**:
    - **Webhook Server**: Receives tasks from GitHub/Jira (`src/webhook/server.ts`).
    - **Orchestrator**: Routes tasks to the generation flow (`src/orchestrator/generateQaSpecFlow.ts`).
    - **QA Agent**: Explores the UI and generates specs/POMs (`src/agents/qaAgent.ts`).
    - **Review Agent**: Addresses PR feedback by updating existing files (`src/agents/reviewAgent.ts`).
    - **Self-Correction**: Automatically validates and fixes TypeScript/Convention errors (`src/services/selfCorrection.ts`).
    - **Crawler**: Uses `playwright-cli` to capture AI-optimized YAML snapshots (`src/services/browserTools.ts`).

## Building and Running

### Development
```bash
npm run dev       # Start server with hot-reload (nodemon + ts-node)
```

### Production
```bash
npm run build     # Compile TypeScript to dist/
npm start         # Run compiled server
```

### Testing
```bash
npm test          # Run Jest test suite
npm run test:watch # Run tests in watch mode
```

## Development Conventions

### 1. Code Guidelines
- **Strict POM Encapsulation**: ALL element interactions MUST be inside a Page Object. Direct `page.locator()` or `page.getBy*` calls in spec files are forbidden (enforced by self-correction).
- **Persona Management**: Never hardcode credentials. Use the `personas` object (e.g., `personas.admin.email`). For negative tests with invalid data, use literal strings like `'invalid@example.com'`.
- **Fixture-First**: POMs must be registered as Playwright fixtures in `fixtures/index.ts`. Use them as test parameters: `test('...', async ({ loginPage }) => { ... })`.

### 2. Branch & File Naming
- **Branches**: `qa/{ticketId}-{slug}` (e.g., `qa/KA-42-login-validation`).
- **Specs**: `tests/web/{feature}/{ticketId}.spec.ts`.
- **POMs**: Located in `tests/poms/{feature}/`, paths derived from the class name.

### 3. Agent Tool Loop
- Agents interact with the system via a tool-calling loop (max 80 iterations).
- **Browser Tools**: `browser_navigate`, `browser_click`, `browser_fill`, `browser_snapshot`, `browser_generate_locator`.
- **Validation**: `validate_typescript` must be called before `done()`.

### 4. Label-Driven Behavior
KlikAgent behavior is controlled via GitHub labels:
- `klikagent`: Triggers the generation flow.
- `scope:web` / `scope:api`: Controls crawler utilization.
- `rework:*`: Enables rework mode for existing features.

## Key Files & Directories

- `src/webhook/server.ts`: Entry point for all incoming webhooks and dashboard API.
- `src/agents/qaAgent.ts`: Core logic for exploration and code generation.
- `src/agents/tools/`: Implementation of tools available to agents.
- `src/services/browserTools.ts`: Persistent browser session management via `playwright-cli`.
- `src/services/ai.ts`: Interface for OpenAI-compatible LLM communication.
- `src/dashboard/`: Event bus, run store, and UI for monitoring agent progress.

## API Reference

| Endpoint | Method | Payload | Description |
|---|---|---|---|
| `/tasks` | POST | `QATask` | Trigger QA spec generation for a new ticket. |
| `/reviews` | POST | `ReviewContext` | Address PR comments (Review Agent). |
| `/repos/provision` | POST | `ProvisionRequest`| Set up a new convention-compliant test repo. |
| `/api/runs/:id/fix`| POST | `{failures: []}` | Trigger CI failure fix agent. |
| `/health` | GET | - | Server health check. |
