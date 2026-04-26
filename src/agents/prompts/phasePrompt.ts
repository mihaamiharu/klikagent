import {
  CORE_ROLE,
  FEATURE_DETERMINATION,
  CONTEXT_SEQUENCE,
  EXPLORATION_SEQUENCE,
  CODE_GEN_SEQUENCE,
  BROWSER_TOOLS,
  SPEC_RULES,
  POM_RULES,
  VALIDATION_RULES,
} from './sections';

export type AgentPhase = 'context' | 'exploration' | 'code_gen' | 'validation';

// Monotonically increasing priority: validation > code_gen > exploration > context.
// Once a trigger tool is seen, the phase never regresses even if the model deviates.
export function detectPhase(calledTools: string[]): AgentPhase {
  const tools = new Set(calledTools);
  if (tools.has('validate_typescript')) return 'validation';
  if (tools.has('browser_close')) return 'code_gen';
  if (tools.has('browser_navigate')) return 'exploration';
  return 'context';
}

export function buildSystemPrompt(phase: AgentPhase): string {
  switch (phase) {
    case 'context':
      return [CORE_ROLE, FEATURE_DETERMINATION, CONTEXT_SEQUENCE].join('\n\n');
    case 'exploration':
      return [CORE_ROLE, BROWSER_TOOLS, EXPLORATION_SEQUENCE].join('\n\n');
    case 'code_gen':
      return [CORE_ROLE, SPEC_RULES, POM_RULES, CODE_GEN_SEQUENCE].join('\n\n');
    case 'validation':
      return [CORE_ROLE, VALIDATION_RULES].join('\n\n');
  }
}
