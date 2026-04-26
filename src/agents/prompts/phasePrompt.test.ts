import { detectPhase, buildSystemPrompt, AgentPhase } from './phasePrompt';

describe('detectPhase', () => {
  it('returns context when no tools have been called', () => {
    expect(detectPhase([])).toBe('context');
  });

  it('returns context when only non-phase tools have been called', () => {
    expect(detectPhase(['get_fixtures', 'get_personas', 'list_available_poms'])).toBe('context');
  });

  it('returns exploration when browser_navigate is in history', () => {
    expect(detectPhase(['get_fixtures', 'browser_navigate', 'browser_snapshot'])).toBe('exploration');
  });

  it('returns code_gen when browser_close is in history (monotonic over exploration)', () => {
    expect(detectPhase(['browser_navigate', 'browser_close'])).toBe('code_gen');
  });

  it('returns validation when validate_typescript is in history (highest priority)', () => {
    expect(detectPhase(['browser_navigate', 'browser_close', 'validate_typescript'])).toBe('validation');
  });

  it('returns validation even when called before browser_close', () => {
    expect(detectPhase(['browser_navigate', 'validate_typescript'])).toBe('validation');
  });
});

describe('buildSystemPrompt', () => {
  const phases: AgentPhase[] = ['context', 'exploration', 'code_gen', 'validation'];

  it.each(phases)('returns a non-empty string for phase %s', (phase) => {
    expect(buildSystemPrompt(phase).length).toBeGreaterThan(0);
  });

  it('context prompt contains feature determination content', () => {
    expect(buildSystemPrompt('context')).toContain('Feature determination');
  });

  it('exploration prompt contains browser tools content', () => {
    expect(buildSystemPrompt('exploration')).toContain('browser_navigate');
  });

  it('code_gen prompt contains POM rules content', () => {
    expect(buildSystemPrompt('code_gen')).toContain('POM rules');
  });

  it('validation prompt contains validate_typescript protocol', () => {
    expect(buildSystemPrompt('validation')).toContain('validate_typescript');
  });

  it('context prompt does not contain full browser tool instructions', () => {
    expect(buildSystemPrompt('context')).not.toContain('Browser tools (powered by playwright-cli)');
  });

  it('validation prompt does not contain POM rules', () => {
    expect(buildSystemPrompt('validation')).not.toContain('Fixture registration');
  });
});
