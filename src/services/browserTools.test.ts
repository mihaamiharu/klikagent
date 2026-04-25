import { buildBrowserTools, browserHandlers } from './browserTools';

describe('browserTools', () => {
  const tools = buildBrowserTools();
  const toolNames = tools.map((t) => t.function.name);

  it('exports all expected browser tools', () => {
    expect(toolNames).toEqual([
      'browser_navigate',
      'browser_click',
      'browser_fill',
      'browser_snapshot',
      'browser_list_interactables',
      'browser_generate_locator',
      'browser_eval',
      'browser_command',
      'browser_close',
    ]);
  });

  it('browser_navigate requires url parameter', () => {
    const nav = tools.find((t) => t.function.name === 'browser_navigate')!;
    expect(nav.function.parameters.required).toContain('url');
  });

  it('browser_click requires selector parameter', () => {
    const click = tools.find((t) => t.function.name === 'browser_click')!;
    expect(click.function.parameters.required).toContain('selector');
  });

  it('browser_fill requires selector and value', () => {
    const fill = tools.find((t) => t.function.name === 'browser_fill')!;
    expect(fill.function.parameters.required).toEqual(['selector', 'value']);
  });

  it('browser_list_interactables has no required params', () => {
    const interactables = tools.find((t) => t.function.name === 'browser_list_interactables')!;
    expect(interactables.function.parameters.required).toHaveLength(0);
  });

  it('browser_snapshot has no required params', () => {
    const snapshot = tools.find((t) => t.function.name === 'browser_snapshot')!;
    expect(snapshot.function.parameters.required).toHaveLength(0);
  });

  it('browser_generate_locator requires ref parameter', () => {
    const gen = tools.find((t) => t.function.name === 'browser_generate_locator')!;
    expect(gen.function.parameters.required).toContain('ref');
  });

  it('browser_eval requires expression parameter', () => {
    const ev = tools.find((t) => t.function.name === 'browser_eval')!;
    expect(ev.function.parameters.required).toContain('expression');
  });

  it('browser_command requires args parameter', () => {
    const cmd = tools.find((t) => t.function.name === 'browser_command')!;
    expect(cmd.function.parameters.required).toContain('args');
  });

  it('browser_close has no required params', () => {
    const close = tools.find((t) => t.function.name === 'browser_close')!;
    expect(close.function.parameters.required).toHaveLength(0);
  });
});

describe('browserHandlers', () => {
  const expectedHandlers = [
    'browser_navigate',
    'browser_click',
    'browser_fill',
    'browser_snapshot',
    'browser_list_interactables',
    'browser_generate_locator',
    'browser_eval',
    'browser_command',
    'browser_close',
  ];

  for (const name of expectedHandlers) {
    it(`has handler for ${name}`, () => {
      expect(browserHandlers).toHaveProperty(name);
      expect(typeof browserHandlers[name]).toBe('function');
    });
  }
});
