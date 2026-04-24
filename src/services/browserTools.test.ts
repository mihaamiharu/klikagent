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
    'browser_close',
  ];

  for (const name of expectedHandlers) {
    it(`has handler for ${name}`, () => {
      expect(browserHandlers).toHaveProperty(name);
      expect(typeof browserHandlers[name]).toBe('function');
    });
  }
});
