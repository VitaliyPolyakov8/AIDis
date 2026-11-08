import type { AppConfig } from '../config/env.js';
import type { PrismaClient } from '../db/prisma.js';
import { Errors } from '../common/errors.js';
import { LIMITS, limitDef, type LimitKey, type LimitScopeName } from './catalog.js';

const SETTINGS_KEY = 'limits';

export interface LimitsView {
  catalog: { key: LimitKey; scopes: readonly LimitScopeName[]; default: number; min: number; max: number }[];
  global: Partial<Record<LimitKey, number>>;
  overrides: { key: LimitKey; scope: LimitScopeName; targetId: string; value: number }[];
}

/**
 * Resolves limits: USER exception -> GUILD exception -> global value -> default, then clamped.
 * Everything is cached in memory (one backend process; every write goes through here).
 */
export class LimitsService {
  private global: Partial<Record<LimitKey, number>> | null = null;
  private overrides: Map<string, number> | null = null;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly config: AppConfig,
  ) {}

  private overrideKey(key: string, scope: LimitScopeName, targetId: string): string {
    return `${key}|${scope}|${targetId}`;
  }

  private async load(): Promise<{ global: Partial<Record<LimitKey, number>>; overrides: Map<string, number> }> {
    if (!this.global) {
      const row = await this.prisma.appSetting.findUnique({ where: { key: SETTINGS_KEY } });
      const raw = row?.value;
      const out: Partial<Record<LimitKey, number>> = {};
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        for (const [k, v] of Object.entries(raw)) if (limitDef(k) && typeof v === 'number') out[k as LimitKey] = v;
      }
      this.global = out;
    }
    if (!this.overrides) {
      const rows = await this.prisma.limitOverride.findMany();
      this.overrides = new Map(rows.map((r) => [this.overrideKey(r.key, r.scope, r.targetId), r.value]));
    }
    return { global: this.global, overrides: this.overrides };
  }

  private clamp(key: LimitKey, value: number): number {
    const def = limitDef(key);
    if (!def) return value;
    return Math.min(def.max(this.config), Math.max(def.min, value));
  }

  async resolve(key: LimitKey, ctx: { guildId?: string | null; userId?: string | null } = {}): Promise<number> {
    const def = limitDef(key);
    if (!def) throw new Error(`Unknown limit ${key}`);
    const { global, overrides } = await this.load();
    const userValue = ctx.userId && def.scopes.includes('USER') ? overrides.get(this.overrideKey(key, 'USER', ctx.userId)) : undefined;
    const guildValue = ctx.guildId && def.scopes.includes('GUILD') ? overrides.get(this.overrideKey(key, 'GUILD', ctx.guildId)) : undefined;
    return this.clamp(key, userValue ?? guildValue ?? global[key] ?? def.default(this.config));
  }

  /** Throws LIMIT_REACHED when one more item would exceed the limit. */
  async assertBelow(key: LimitKey, ctx: { guildId?: string | null; userId?: string | null }, currentCount: number): Promise<void> {
    const limit = await this.resolve(key, ctx);
    if (currentCount >= limit) throw Errors.limitReached(key, limit);
  }

  async view(): Promise<LimitsView> {
    const { global, overrides } = await this.load();
    return {
      catalog: LIMITS.map((l) => ({ key: l.key, scopes: l.scopes, default: l.default(this.config), min: l.min, max: l.max(this.config) })),
      global: { ...global },
      overrides: [...overrides.entries()].map(([k, value]) => {
        const [key, scope, targetId] = k.split('|') as [LimitKey, LimitScopeName, string];
        return { key, scope, targetId, value };
      }),
    };
  }

  private validate(key: string, value: number): LimitKey {
    const def = limitDef(key);
    if (!def) throw Errors.badRequest('UNKNOWN_LIMIT', `Unknown limit: ${key}`);
    if (!Number.isInteger(value) || value < def.min || value > def.max(this.config)) {
      throw Errors.badRequest('LIMIT_OUT_OF_RANGE', `${key} must be between ${def.min} and ${def.max(this.config)}`);
    }
    return def.key;
  }

  /** null = back to the default. */
  async setGlobal(values: Record<string, number | null>): Promise<void> {
    const { global } = await this.load();
    const cleared = new Set<string>();
    const next: Partial<Record<LimitKey, number>> = {};
    for (const [key, value] of Object.entries(values)) {
      if (value === null) {
        if (!limitDef(key)) throw Errors.badRequest('UNKNOWN_LIMIT', `Unknown limit: ${key}`);
        cleared.add(key);
      } else next[this.validate(key, value)] = value;
    }
    for (const [key, value] of Object.entries(global) as [LimitKey, number][]) if (!cleared.has(key) && !(key in next)) next[key] = value;
    await this.prisma.appSetting.upsert({ where: { key: SETTINGS_KEY }, create: { key: SETTINGS_KEY, value: next }, update: { value: next } });
    this.global = next;
  }

  /** null = remove the exception. */
  async setOverride(key: string, scope: LimitScopeName, targetId: string, value: number | null): Promise<void> {
    const def = limitDef(key);
    if (!def) throw Errors.badRequest('UNKNOWN_LIMIT', `Unknown limit: ${key}`);
    if (!def.scopes.includes(scope)) throw Errors.badRequest('LIMIT_SCOPE', `${key} has no ${scope} exceptions`);
    if (value === null) {
      await this.prisma.limitOverride.deleteMany({ where: { key, scope, targetId } });
    } else {
      this.validate(key, value);
      await this.prisma.limitOverride.upsert({ where: { key_scope_targetId: { key, scope, targetId } }, create: { key, scope, targetId, value }, update: { value } });
    }
    this.overrides = null;
  }
}
