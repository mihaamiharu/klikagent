import { qaTools, qaHandlers } from './index';

describe('qaTools', () => {
  const toolNames = qaTools.map((t) => t.function.name);

  it('includes browser tools', () => {
    expect(toolNames).toContain('browser_navigate');
    expect(toolNames).toContain('browser_click');
    expect(toolNames).toContain('browser_fill');
    expect(toolNames).toContain('browser_snapshot');
    expect(toolNames).toContain('browser_close');
  });

  it('includes repo context tools', () => {
    expect(toolNames).toContain('get_context_docs');
    expect(toolNames).toContain('get_fixtures');
    expect(toolNames).toContain('get_existing_pom');
    expect(toolNames).toContain('list_available_poms');
  });

  it('includes validate_typescript and done', () => {
    expect(toolNames).toContain('validate_typescript');
    expect(toolNames).toContain('done');
  });

  it('done tool requires enrichedSpec, poms, affectedPaths', () => {
    const doneTool = qaTools.find((t) => t.function.name === 'done')!;
    const required = doneTool.function.parameters.required as string[];
    expect(required).toContain('enrichedSpec');
    expect(required).toContain('poms');
    expect(required).toContain('affectedPaths');
  });
});

describe('qaHandlers', () => {
  it('has handlers for all browser tools', () => {
    expect(qaHandlers).toHaveProperty('browser_navigate');
    expect(qaHandlers).toHaveProperty('browser_click');
    expect(qaHandlers).toHaveProperty('browser_fill');
    expect(qaHandlers).toHaveProperty('browser_snapshot');
    expect(qaHandlers).toHaveProperty('browser_close');
  });

  it('has validate_typescript handler', () => {
    expect(qaHandlers).toHaveProperty('validate_typescript');
  });

  it('validate_typescript handler rejects invalid Playwright expect().or() pattern', async () => {
    const result = JSON.parse(
      await qaHandlers['validate_typescript']({
        code: 'expect(locator).toContainText("foo").or(expect(other).toBeVisible());',
      }) as string,
    );
    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toMatch(/or\(\)/i);
  });

  it('validate_typescript handler accepts valid code', async () => {
    const result = JSON.parse(
      await qaHandlers['validate_typescript']({
        code: 'const x: string = "hello";',
      }) as string,
    );
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });
});
