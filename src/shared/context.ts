import { AsyncLocalStorage } from 'node:async_hooks';

import type { Principal } from './types/principal';

/**
 * Per-request context propagated via AsyncLocalStorage: requestId + correlationId flow into
 * logs, emitted events, jobs, and socket emits, so one user action is traceable end-to-end.
 * See BACKEND_ARCHITECTURE.md §4 and LOGGING_AND_MONITORING.md §1.
 */
export interface RequestContext {
  requestId: string;
  correlationId: string;
  principal?: Principal;
}

const als = new AsyncLocalStorage<RequestContext>();

export function runWithContext<T>(ctx: RequestContext, fn: () => T): T {
  return als.run(ctx, fn);
}

export function getContext(): RequestContext | undefined {
  return als.getStore();
}

export function getCorrelationId(): string | undefined {
  return als.getStore()?.correlationId;
}
