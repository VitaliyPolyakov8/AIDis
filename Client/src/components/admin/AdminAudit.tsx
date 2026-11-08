import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Shield } from 'lucide-react';
import type { AuditEntry } from '../../api/types';
import { rolesApi } from '../../api/roles';
import { friendlyError } from '../../api/errors';
import { usePresenceStore } from '../../stores/presenceStore';
import { formatMessageTimestamp } from '../../utils/time';
import { Avatar } from '../Avatar';

/** Superadmin: the instance-wide audit log (accounts, limits, servers, announcements). */
export function AdminAudit() {
  const { t } = useTranslation();
  const users = usePresenceStore((s) => s.users);
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [more, setMore] = useState(true);
  const load = useCallback(
    (before?: string) => {
      rolesApi.audit(before).then(
        ({ entries: next }) => {
          setEntries((list) => [...(before ? (list ?? []) : []), ...next]);
          setMore(next.length === 50);
        },
        (e: unknown) => setError(friendlyError(e, t('admin.audit.failed'))),
      );
    },
    [t],
  );
  useEffect(() => load(), [load]);
  const describe = (e: AuditEntry) => {
    const d = e.details ?? {};
    const s = (...keys: string[]) => {
      for (const k of keys) if (typeof d[k] === 'string' && d[k]) return d[k];
      return '';
    };
    const target = e.targetType === 'user' && e.targetId ? (users[e.targetId]?.displayName ?? s('user')) : s('name', 'channelName', 'module', 'user') || (e.targetId ?? '');
    return t(`admin.audit.actions.${e.action}`, { target, from: s('from', 'renamedFrom'), to: s('to'), channel: s('channel', 'channelName'), defaultValue: e.action });
  };
  return (
    <div className="admin-section">
      {error && <p className="field-error">{error}</p>}
      {entries === null && !error && <span className="spinner" role="status" aria-label={t('common.loading')} />}
      {entries?.length === 0 && <p className="field-hint">{t('admin.audit.empty')}</p>}
      <ul className="audit-list">
        {entries?.map((e) => {
          const actor = e.actorId ? users[e.actorId] : undefined;
          return (
            <li key={e.id} className="audit-row">
              {actor ? <Avatar userId={actor.id} name={actor.displayName} avatarAttachmentId={actor.avatarAttachmentId} size={24} /> : <Shield size={18} aria-hidden="true" />}
              <span className="audit-text">
                <strong>{actor?.displayName ?? t('admin.audit.system')}</strong> {describe(e)}
              </span>
              <time className="audit-time" dateTime={e.createdAt}>
                {formatMessageTimestamp(e.createdAt)}
              </time>
            </li>
          );
        })}
      </ul>
      {entries && more && entries.length > 0 && (
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => load(entries[entries.length - 1]?.id)}>
          {t('admin.audit.more')}
        </button>
      )}
    </div>
  );
}
