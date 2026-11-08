import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Crown, ExternalLink, Trash } from 'lucide-react';
import type { GuildView } from '../../api/types';
import { adminApi } from '../../api/admin';
import { guildsApi } from '../../api/guilds';
import { friendlyError } from '../../api/errors';
import { usePresenceStore } from '../../stores/presenceStore';
import { useGuildStore } from '../../stores/guildStore';
import { toast, useUiStore } from '../../stores/uiStore';
import { formatFullDate } from '../../utils/time';
import { ConfirmDialog } from '../ConfirmDialog';
import { GuildIcon } from '../guilds/GuildIcon';
import { enterGuild } from '../guilds/enterGuild';

type Pending = { kind: 'delete' | 'transfer'; guild: GuildView } | null;

/** Superadmin: every server of this AIDis (open, transfer, delete). */
export function AllGuilds() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const users = usePresenceStore((s) => s.users);
  const [guilds, setGuilds] = useState<GuildView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [pending, setPending] = useState<Pending>(null);
  const [typed, setTyped] = useState('');
  const [heir, setHeir] = useState('');

  const load = useCallback(() => {
    adminApi.guilds().then(
      ({ guilds: list }) => setGuilds(list),
      (e: unknown) => setError(friendlyError(e, t('sa.guilds.failed'))),
    );
  }, [t]);
  useEffect(load, [load]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (guilds ?? []).filter((g) => !q || g.name.toLowerCase().includes(q)).sort((a, b) => b.memberCount - a.memberCount || a.name.localeCompare(b.name));
  }, [guilds, query]);
  const people = useMemo(() => Object.values(users).sort((a, b) => a.displayName.localeCompare(b.displayName)), [users]);

  const open = async (guild: GuildView) => {
    try {
      const { guild: mine } = await guildsApi.get(guild.id);
      const path = await enterGuild(mine);
      useUiStore.getState().closeSettings();
      void navigate(path);
    } catch (e) {
      toast.error(friendlyError(e, t('sa.guilds.failed')), 'sa-open');
    }
  };

  return (
    <div className="admin-section">
      <p className="field-hint">{t('sa.guilds.hint')}</p>
      <input className="input sa-search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('sa.guilds.search')} aria-label={t('sa.guilds.search')} />
      {error && <p className="field-error">{error}</p>}
      {!guilds && !error && <span className="spinner" role="status" aria-label={t('common.loading')} />}
      <ul className="admin-list">
        {shown.map((g) => (
          <li key={g.id} className="admin-member">
            <div className="admin-member-head">
              <span className="sa-guild-icon">
                <GuildIcon name={g.name} iconAttachmentId={g.iconAttachmentId} size={32} />
              </span>
              <span className="admin-row-name">
                {g.name}
                <span className="field-hint">{t('sa.guilds.meta', { owner: users[g.ownerId]?.displayName ?? '…', count: g.memberCount, date: formatFullDate(g.createdAt) })}</span>
              </span>
              <span className="admin-row-actions">
                <button type="button" className="icon-btn" aria-label={`${t('sa.guilds.open')}: ${g.name}`} title={t('sa.guilds.open')} onClick={() => void open(g)}>
                  <ExternalLink size={15} />
                </button>
                <button type="button" className="icon-btn" aria-label={`${t('gs.overview.transfer')}: ${g.name}`} title={t('gs.overview.transfer')} onClick={() => setPending({ kind: 'transfer', guild: g })}>
                  <Crown size={15} />
                </button>
                <button type="button" className="icon-btn is-danger-hover" aria-label={`${t('gs.overview.delete')}: ${g.name}`} title={t('gs.overview.delete')} onClick={() => setPending({ kind: 'delete', guild: g })}>
                  <Trash size={15} />
                </button>
              </span>
            </div>
          </li>
        ))}
      </ul>
      {pending?.kind === 'delete' && (
        <ConfirmDialog
          title={t('gs.overview.deleteTitle', { name: pending.guild.name })}
          confirmLabel={t('gs.overview.delete')}
          confirmDisabled={typed !== pending.guild.name}
          onClose={() => {
            setPending(null);
            setTyped('');
          }}
          onConfirm={async () => {
            try {
              await guildsApi.remove(pending.guild.id, typed);
            } catch (e) {
              throw new Error(friendlyError(e, t('gs.overview.failed')), { cause: e });
            }
            useGuildStore.getState().removeGuild(pending.guild.id);
            setGuilds((list) => (list ?? []).filter((x) => x.id !== pending.guild.id));
            toast.info(t('gs.overview.deleted'), 'sa-delete');
          }}
        >
          <p>{t('gs.overview.deleteHint')}</p>
          <label className="field">
            <span className="field-label">{t('gs.overview.deleteType')}</span>
            <input className="input" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={pending.guild.name} data-autofocus />
          </label>
        </ConfirmDialog>
      )}
      {pending?.kind === 'transfer' && (
        <ConfirmDialog
          title={t('sa.guilds.transferTitle', { name: pending.guild.name })}
          confirmLabel={t('gs.overview.transfer')}
          tone="primary"
          confirmDisabled={!heir}
          onClose={() => {
            setPending(null);
            setHeir('');
          }}
          onConfirm={async () => {
            try {
              await guildsApi.transfer(pending.guild.id, heir);
            } catch (e) {
              throw new Error(friendlyError(e, t('gs.overview.failed')), { cause: e });
            }
            toast.success(t('gs.overview.transferred'), 'sa-transfer');
            load();
          }}
        >
          <p>{t('sa.guilds.transferHint')}</p>
          <select className="input" value={heir} onChange={(e) => setHeir(e.target.value)} aria-label={t('gs.overview.transferPick')}>
            <option value="">{t('gs.overview.transferPick')}</option>
            {people
              .filter((u) => u.id !== pending.guild.ownerId)
              .map((u) => (
                <option key={u.id} value={u.id}>
                  {u.displayName} (@{u.username})
                </option>
              ))}
          </select>
        </ConfirmDialog>
      )}
    </div>
  );
}
