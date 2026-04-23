import { buildBrowserTools, browserHandlers } from './browserToolsCli';

describe('browserTools', () => {
  const toolNames = buildBrowserTools('http://localhost:3000').map((t: { function: { name: string } }) => t.function.name);

  it('includes browser_list_interactables', () => {
    expect(toolNames).toContain('browser_list_interactables');
  });

  it('browser_list_interactables has no required params', () => {
    const tools = buildBrowserTools('http://localhost:3000');
    const toolIndex = toolNames.indexOf('browser_list_interactables');
    const interactablesTool = tools[toolIndex];
    expect(interactablesTool.function.parameters.required).toHaveLength(0);
  });
});

describe('browserHandlers', () => {
  it('has handler for browser_list_interactables', () => {
    expect(browserHandlers).toHaveProperty('browser_list_interactables');
  });

  it('browser_list_interactables handler is a function', () => {
    expect(typeof browserHandlers['browser_list_interactables']).toBe('function');
  });
});
