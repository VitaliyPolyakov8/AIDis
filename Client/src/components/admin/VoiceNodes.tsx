import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, RefreshCw, Trash } from 'lucide-react';
import type { GuildView, VoiceNodeView } from '../../api/types';
import { voiceNodesApi } from '../../api/voiceNodes';
import { adminApi } from '../../api/admin';
import { friendlyError } from '../../api/errors';
import { toast } from '../../stores/uiStore';
import { formatMessageTimestamp } from '../../utils/time';
import { ConfirmDialog } from '../ConfirmDialog';
import { Toggle } from '../settings/Toggle';
import { parseNodeBlock, validNodeUrl } from './voiceNodeForm';
import { useServerConfig } from '../../api/clientConfig';

const STATUS_COLOR: Record<string, string> = { ok: 'var(--live)', unreachable: 'var(--danger)', unauthorized: 'var(--warning, #f0b232)' };

function AddNodeForm({ onAdded }: { onAdded: () => void }) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [block, setBlock] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const parsed = parseNodeBlock(block);
  const domain = useServerConfig((st) => st.voiceNodeDomain);
  const urlOk = parsed ? validNodeUrl(parsed.url, domain) : false;
  const submit = async () => {
    if (!parsed) return;
    setBusy(true);
    setError(null);
    try {
      const { node } = await voiceNodesApi.create({ name: name.trim() || parsed.url.replace('wss://', ''), ...parsed });
      toast.success(t(node.lastCheckStatus === 'ok' ? 'vn.addedOk' : 'vn.addedNotOk'), 'vn-add');
      setName('');
      setBlock('');
      onAdded();
    } catch (e) {
      setError(friendlyError(e, t('vn.failed')));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="admin-card vn-add"
      onSubmit={(e) => {
        e.preventDefault();
        if (parsed && urlOk) void submit();
      }}
    >
      <h4>{t('vn.add')}</h4>
      <p className="field-hint">{t('vn.addHint', { domain })}</p>
      <label className="field">
        <span className="field-label">{t('vn.name')}</span>
        <input className="input" value={name} maxLength={64} onChange={(e) => setName(e.target.value)} placeholder={t('vn.namePlaceholder')} />
      </label>
      <label className="field">
        <span className="field-label">{t('vn.block')}</span>
        <textarea className="input admin-textarea vn-block" rows={3} value={block} onChange={(e) => setBlock(e.target.value)} placeholder={`URL: wss://voice2.${domain || 'chat.example.com'}\nAPI key: …\nAPI secret: …`} spellCheck={false} />
      </label>
      {block.trim() && !parsed && <p className="field-error">{t('vn.blockInvalid')}</p>}
      {parsed && !urlOk && <p className="field-error">{t('vn.urlInvalid', { domain })}</p>}
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      <button type="submit" className="btn btn-primary btn-sm" disabled={busy || !parsed || !urlOk}>
        <Plus size={14} aria-hidden="true" /> {t('vn.addButton')}
      </button>
    </form>
  );
}

function NodeRow({ node, guilds, onChanged }: { node: VoiceNodeView; guilds: GuildView[]; onChanged: () => void }) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await action();
      onChanged();
    } catch (e) {
      toast.error(friendlyError(e, t('vn.failed')), 'vn-action');
    } finally {
      setBusy(false);
    }
  };
  const toggleGuild = (guildId: string) => {
    const next = node.guildIds.includes(guildId) ? node.guildIds.filter((g) => g !== guildId) : [...node.guildIds, guildId];
    void run(() => voiceNodesApi.update(node.id, { guildIds: next }));
  };
  const status = node.lastCheckStatus;
  return (
    <li className="admin-member vn-node">
      <div className="admin-member-head">
        <span className="vn-dot" style={{ '--vn-color': status ? STATUS_COLOR[status] : 'var(--text-faint)' } as CSSProperties} aria-hidden="true" />
        <span className="admin-row-name">
          {node.name}
          <span className="field-hint">
            {node.url} · {status ? t(`vn.status.${status}`) : t('vn.status.never')}
            {node.lastCheckAt ? ` · ${formatMessageTimestamp(node.lastCheckAt)}` : ''}
          </span>
        </span>
        <span className="admin-row-actions">
          <button type="button" className="icon-btn" disabled={busy} aria-label={`${t('vn.check')}: ${node.name}`} title={t('vn.check')} onClick={() => void run(() => voiceNodesApi.check(node.id))}>
            <RefreshCw size={15} />
          </button>
          <button type="button" className="icon-btn is-danger-hover" disabled={busy} aria-label={`${t('vn.delete')}: ${node.name}`} title={t('vn.delete')} onClick={() => setDeleting(true)}>
            <Trash size={15} />
          </button>
        </span>
      </div>
      <Toggle label={t('vn.enabled')} hint={t('vn.enabledHint')} checked={node.enabled} disabled={busy} onChange={(on) => void run(() => voiceNodesApi.update(node.id, { enabled: on }))} />
      <div className="vn-guilds">
        <span className="field-label">{t('vn.guilds')}</span>
        <div className="chip-list">
          {guilds.map((g) => {
            const on = node.guildIds.includes(g.id);
            return (
              <button key={g.id} type="button" className={`chip${on ? ' is-on' : ''}`} aria-pressed={on} disabled={busy} onClick={() => toggleGuild(g.id)}>
                {g.name}
              </button>
            );
          })}
        </div>
        {node.guildIds.length === 0 && <span className="field-hint">{t('vn.noGuilds')}</span>}
      </div>
      {deleting && (
        <ConfirmDialog
          title={t('vn.deleteTitle', { name: node.name })}
          confirmLabel={t('vn.delete')}
          onClose={() => setDeleting(false)}
          onConfirm={async () => {
            try {
              await voiceNodesApi.remove(node.id);
            } catch (e) {
              throw new Error(friendlyError(e, t('vn.failed')), { cause: e });
            }
            onChanged();
          }}
        >
          <p>{t('vn.deleteBody')}</p>
        </ConfirmDialog>
      )}
    </li>
  );
}

/** 0.7.1 superadmin: extra voice servers (LiveKits on VPSes) and which servers may use them. */
export function VoiceNodes() {
  const { t } = useTranslation();
  const [data, setData] = useState<{ main: { url: string }; nodes: VoiceNodeView[] } | null>(null);
  const [guilds, setGuilds] = useState<GuildView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    voiceNodesApi.list().then(setData, (e: unknown) => setError(friendlyError(e, t('vn.failed'))));
  }, [t]);
  useEffect(() => {
    load();
    adminApi.guilds().then(
      ({ guilds: list }) => setGuilds(list),
      () => undefined,
    );
    // Other superadmins' changes and the periodic checks (realtime 'voice-nodes.changed').
    const onChanged = () => load();
    window.addEventListener('aidis:voice-nodes-changed', onChanged);
    return () => window.removeEventListener('aidis:voice-nodes-changed', onChanged);
  }, [load]);

  if (error) return <p className="field-error">{error}</p>;
  if (!data) return <span className="spinner" role="status" aria-label={t('common.loading')} />;
  return (
    <div className="admin-section">
      <p className="field-hint">{t('vn.hint')}</p>
      <div className="admin-card">
        <h4>{t('vn.main')}</h4>
        <p className="field-hint">
          {data.main.url} · {t('vn.mainHint')}
        </p>
      </div>
      {data.nodes.length > 0 && (
        <ul className="admin-list">
          {data.nodes.map((node) => (
            <NodeRow key={node.id} node={node} guilds={guilds} onChanged={load} />
          ))}
        </ul>
      )}
      <AddNodeForm onAdded={load} />
    </div>
  );
}
