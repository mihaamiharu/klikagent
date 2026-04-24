import { dashboardBus } from '../dashboard/eventBus';

export const log = (
  level: 'INFO' | 'SKIP' | 'ROUTE' | 'ERROR' | 'WARN' | 'REVIEW',
  message: string
) => {
  console.log(`[${new Date().toISOString()}] [${level}] ${message}`);
  dashboardBus.emitLog(level, message);
};
