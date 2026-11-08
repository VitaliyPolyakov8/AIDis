import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, Trash } from 'lucide-react';
import type { GuildView, LimitScope, LimitsView } from '../../api/types';
import { limitsApi } from '../../api/limits';
import { adminApi } from '../../api/admin';
import { friendlyError } from '../../api/errors';
import { usePresenceStore } from '../../stores/presenceStore';
import { toast } from '../../stores/uiStore';
import { fromInput, isBytesLimit, toInput, validate, type LimitDef } from './limitsForm';

const keyOf = (key: string) => key.replace(/\./g, '_');

function unit(def: Pick<LimitDef, 'key'>, t: (k: string) => string) {
  return isBytesLimit(def.key) ? t('sa.limits.mb') : '';
}

function GlobalRow({ def, value, onSaved }: { def: LimitDef; value: number | undefined; onSaved: () => void }) {
  const { t } = useTranslation();
  const [text, setText] = useState(toInput(def, value));
  const [busy, setBusy] = useState(false);
  const range = validate(def, text);
  const dirty = text.trim() !== toInput(def, value);
  const save = async () => {
    setBusy(true);
    try {
      await limitsApi.setGlobal({ [def.key]: fromInput(def, text) });
      toast.success(t('sa.limits.saved'), 'limits');
      onSaved();
    } catch (e) {
      toast.error(friendlyError(e, t('sa.limits.failed')), 'limits');
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="sa-limit-row"
      onSubmit={(e) => {
        e.preventDefault();
        if (!range && dirty) void save();
      }}
    >
      <span className="sa-limit-name">
        <strong>{t(`sa.limits.keys.${keyOf(def.key)}`)}</strong>
        <span className="field-hint">
          {t('sa.limits.default', { value: `${toInput(def, def.default)} ${unit(def, t)}`.trim() })} · {t(`sa.limits.scopes.${def.scopes.join('_')}`)}
        </span>
      </span>
      <span className="input-row sa-limit-input">
        <input
          className="input"
          inputMode="decimal"
          value={text}
          placeholder={toInput(def, def.default)}
          onChange={(e) => setText(e.target.value)}
          aria-label={t(`sa.limits.keys.${keyOf(def.key)}`)}
          aria-invalid={range !== null}
        />
        {unit(def, t) && <span className="sa-unit">{unit(def, t)}</span>}
        <button type="submit" className="btn btn-secondary btn-sm" disabled={busy || !dirty || range !== null}>
          {t('common.save')}
        </button>
      </span>
      {range && (
        <span className="field-error sa-limit-error" role="alert">
          {t('sa.limits.range', { min: range.min, max: range.max })}
        </span>
      )}
    </form>
  );
}

function NewOverride({ catalog, guilds, onSaved }: { catalog: LimitDef[]; guilds: GuildView[]; onSaved: () => void }) {
  const { t } = useTranslation();
  const users = usePresenceStore((s) => s.users);
  const [key, setKey] = useState(catalog[0]?.key ?? '');
  const def = catalog.find((d) => d.key === key);
  const [scope, setScope] = useState<LimitScope>(def?.scopes[0] ?? 'GUILD');
  const [targetId, setTargetId] = useState('');
  const [text, setText] = useState('');
  const scopes = def?.scopes ?? [];
  const realScope = scopes.includes(scope) ? scope : (scopes[0] ?? 'GUILD');
  const range = def ? validate(def, text) : null;
  const people = useMemo(() => Object.values(users).sort((a, b) => a.displayName.localeCompare(b.displayName)), [users]);
  if (!def) return null;
  const submit = async () => {
    const value = fromInput(def, text);
    if (value === null || !targetId) return;
    try {
      await limitsApi.setOverride({ key: def.key, scope: realScope, targetId, value });
      toast.success(t('sa.limits.saved'), 'limits');
      setText('');
      onSaved();
    } catch (e) {
      toast.error(friendlyError(e, t('sa.limits.failed')), 'limits');
    }
  };
  return (
    <form
      className="sa-override-new"
      onSubmit={(e) => {
        e.preventDefault();
        if (!range) void submit();
      }}
    >
      <select className="input" value={key} onChange={(e) => setKey(e.target.value)} aria-label={t('sa.limits.limit')}>
        {catalog.map((d) => (
          <option key={d.key} value={d.key}>
            {t(`sa.limits.keys.${keyOf(d.key)}`)}
          </option>
        ))}
      </select>
      {scopes.length > 1 && (
        <select className="input" value={realScope} onChange={(e) => setScope(e.target.value as LimitScope)} aria-label={t('sa.limits.for')}>
          {scopes.map((s) => (
            <option key={s} value={s}>
              {t(`sa.limits.scope.${s}`)}
            </option>
          ))}
        </select>
      )}
      <select className="input" value={targetId} onChange={(e) => setTargetId(e.target.value)} aria-label={t(`sa.limits.scope.${realScope}`)}>
        <option value="">{t(`sa.limits.pick.${realScope}`)}</option>
        {realScope === 'GUILD'
          ? guilds.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))
          : people.map((u) => (
              <option key={u.id} value={u.id}>
                {u.displayName} (@{u.username})
              </option>
            ))}
      </select>
      <input
        className="input sa-override-value"
        inputMode="decimal"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={toInput(def, def.default)}
        aria-label={t('sa.limits.value')}
        aria-invalid={range !== null}
      />
      {unit(def, t) && <span className="sa-unit">{unit(def, t)}</span>}
      <button type="submit" className="btn btn-primary btn-sm" disabled={!targetId || !text.trim() || range !== null}>
        <Plus size={14} aria-hidden="true" /> {t('sa.limits.addException')}
      </button>
      {range && (
        <span className="field-error" role="alert">
          {t('sa.limits.range', { min: range.min, max: range.max })}
        </span>
      )}
    </form>
  );
}

/** Superadmin: every limit (global value, plus exceptions for one server or one person). */
export function LimitsEditor() {
  const { t } = useTranslation();
  const users = usePresenceStore((s) => s.users);
  const [view, setView] = useState<LimitsView | null>(null);
  const [guilds, setGuilds] = useState<GuildView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    limitsApi.view().then(setView, (e: unknown) => setError(friendlyError(e, t('sa.limits.failed'))));
  }, [t]);
  useEffect(() => {
    load();
    adminApi.guilds().then(
      ({ guilds: list }) => setGuilds(list),
      () => undefined,
    );
  }, [load]);

  if (error) return <p className="field-error">{error}</p>;
  if (!view) return <span className="spinner" role="status" aria-label={t('common.loading')} />;
  const nameOf = (scope: LimitScope, id: string) => (scope === 'GUILD' ? (guilds.find((g) => g.id === id)?.name ?? id) : (users[id]?.displayName ?? id));
  const defOf = (key: string) => view.catalog.find((d) => d.key === key);

  return (
    <div className="admin-section">
      <p className="field-hint">{t('sa.limits.hint')}</p>
      <div className="admin-card">
        <h4>{t('sa.limits.global')}</h4>
        {view.catalog.map((def) => (
          <GlobalRow key={`${def.key}:${view.global[def.key] ?? ''}`} def={def} value={view.global[def.key]} onSaved={load} />
        ))}
      </div>
      <div className="admin-card">
        <h4>{t('sa.limits.exceptions')}</h4>
        <p className="field-hint">{t('sa.limits.exceptionsHint')}</p>
        <NewOverride catalog={view.catalog} guilds={guilds} onSaved={load} />
        {view.overrides.length === 0 && <p className="field-hint">{t('sa.limits.noExceptions')}</p>}
        <ul className="admin-list">
          {view.overrides.map((o) => {
            const def = defOf(o.key);
            return (
              <li key={`${o.key}:${o.scope}:${o.targetId}`} className="admin-row">
                <span className="admin-row-name">
                  {t(`sa.limits.keys.${keyOf(o.key)}`)}
                  <span className="field-hint">
                    {t(`sa.limits.scope.${o.scope}`)}: {nameOf(o.scope, o.targetId)}
                  </span>
                </span>
                <span className="admin-tag">
                  {def ? toInput(def, o.value) : o.value} {def ? unit(def, t) : ''}
                </span>
                <span className="admin-row-actions">
                  <button
                    type="button"
                    className="icon-btn is-danger-hover"
                    aria-label={t('sa.limits.removeException')}
                    title={t('sa.limits.removeException')}
                    onClick={() => {
                      limitsApi.setOverride({ key: o.key, scope: o.scope, targetId: o.targetId, value: null }).then(load, (e: unknown) => toast.error(friendlyError(e, t('sa.limits.failed')), 'limits'));
                    }}
                  >
                    <Trash size={15} />
                  </button>
                </span>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
