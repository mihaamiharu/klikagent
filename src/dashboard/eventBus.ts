import { EventEmitter } from 'node:events';
import { AsyncLocalStorage } from 'node:async_hooks';

export type EventCategory =
  | 'task'
  | 'review'
  | 'flow'
  | 'agent'
  | 'validation'
  | 'correction'
  | 'browser'
  | 'github'
  | 'system';

export interface DashboardEvent {
  id: string;
  runId: string;
  timestamp: string;
  category: EventCategory;
  level: 'info' | 'warn' | 'error';
  message: string;
  data?: Record<string, unknown>;
}

class EventBus extends EventEmitter {
  private runContext = new AsyncLocalStorage<string>();

  constructor() {
    super();
    this.setMaxListeners(100);
  }

  // Wraps an execution context with a specific runId
  public withRunId<T>(runId: string, fn: () => T): T {
    return this.runContext.run(runId, fn);
  }

  public getRunId(): string {
    return this.runContext.getStore() || 'system';
  }

  public emitEvent(category: EventCategory, level: 'info' | 'warn' | 'error', message: string, data?: Record<string, unknown>) {
    const runId = this.getRunId();
    const event: DashboardEvent = {
      id: Math.random().toString(36).substring(2, 11),
      runId,
      timestamp: new Date().toISOString(),
      category,
      level,
      message,
      data,
    };
    this.emit('event', event);
  }

  // Used by the existing logger
  public emitLog(level: string, message: string) {
    const l = level.toLowerCase() as 'info' | 'warn' | 'error';
    const cleanLevel = ['info', 'warn', 'error'].includes(l) ? l : 'info';
    
    // Categorize based on context/message
    let category: EventCategory = 'system';
    const runId = this.getRunId();
    
    if (message.includes('[AI]')) category = 'agent';
    else if (message.includes('[BrowserTools]')) category = 'browser';
    else if (message.includes('[selfCorrection]')) category = 'correction';
    else if (message.includes('[generateQaSpecFlow]')) category = 'flow';
    else if (runId !== 'system') category = 'flow';

    this.emitEvent(category, cleanLevel, message);
  }
}

export const dashboardBus = new EventBus();
