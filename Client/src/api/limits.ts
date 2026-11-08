import { request } from './client';
import type { LimitScope, LimitsView } from './types';

/** 0.7.0 superadmin limits. */
export const limitsApi = {
  view(): Promise<LimitsView> {
    return request('/api/v1/admin/limits');
  },
  /** null = back to the default. */
  setGlobal(values: Record<string, number | null>): Promise<void> {
    return request('/api/v1/admin/limits', { method: 'PUT', body: { values } });
  },
  /** value null = remove the exception. */
  setOverride(input: { key: string; scope: LimitScope; targetId: string; value: number | null }): Promise<void> {
    return request('/api/v1/admin/limits/overrides', { method: 'PUT', body: input });
  },
};
