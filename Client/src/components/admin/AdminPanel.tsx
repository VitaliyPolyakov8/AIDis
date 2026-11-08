import { VoiceNodes } from './VoiceNodes';
import { MailSettings } from './MailSettings';
import { RegistrationSettings } from './RegistrationSettings';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Activity,
  Gauge,
  Mail,
  RadioTower,
  UserPlus,
  ScrollText,
  Server,
  Copy,
  Database,
  HardDrive,
  KeyRound,
  LogOut,
  Megaphone,
  MonitorSmartphone,
  Plus,
  RefreshCw,
  Shield,
  ShieldOff,
  Trash,
  UserCheck,
  UserX,
  Users,
  Volume2,
} from 'lucide-react';
import type { AdminConnection, AdminFile, AdminOverview, AdminStorage, AdminUser, SessionView } from '../../api/types';
import { adminApi } from '../../api/admin';
import { voiceApi } from '../../api/voice';
import { friendlyError } from '../../api/errors';
import { config, getApiOrigin } from '../../config';
import { useAuthStore } from '../../stores/authStore';
import { useChatStore } from '../../stores/chatStore';
import { useUiStore, toast } from '../../stores/uiStore';
import { useAnnouncementStore } from '../../stores/announcementStore';
import { usePresenceStore } from '../../stores/presenceStore';
import { useVoiceStore } from '../../voice/voiceStore';
import { formatBytes } from '../../utils/format';
import { formatLastSeen, formatMessageTimestamp } from '../../utils/time';
import { Avatar } from '../Avatar';
import { ConfirmDialog } from '../ConfirmDialog';
import { StyledName } from '../profile/StyledName';
import { compareVersions, generatePassword, platformLabelKey } from './adminUtils';
import { AllGuilds } from './AllGuilds';
import { LimitsEditor } from './LimitsEditor';
import { AdminAudit } from './AdminAudit';
import { useGuildStore } from '../../stores/guildStore';

/**
 * 0.5.8 "Administration" settings tab (ADMIN accounts only): system health, accounts and their
 * devices, who is online on which version, voice right now, files on disk, the announcement banner
 * and workspace settings. Everything the CLI on the mini-PC was needed for before.
 */
type Section = 'overview' | 'users' | 'guilds' | 'limits' | 'nodes' | 'mail' | 'registration' | 'online' | 'storage' | 'announce' | 'audit';

const SECTIONS: { id: Section; icon: typeof Activity }[] = [
  { id: 'overview', icon: Activity },
  { id: 'users', icon: Users },
  { id: 'guilds', icon: Server },
  { id: 'limits', icon: Gauge },
  { id: 'nodes', icon: RadioTower },
  { id: 'mail', icon: Mail },
  { id: 'registration', icon: UserPlus },
  { id: 'online', icon: MonitorSmartphone },
  { id: 'storage', icon: HardDrive },
  { id: 'announce', icon: Megaphone },
  { id: 'audit', icon: ScrollText },
];

let requestedSection: string | null = null;
/** 0.7.0: e.g. the rail's "All servers" button opens the panel on that section. */
export function openAdminSection(section: 'guilds' | 'limits' | 'nodes' | 'mail' | 'registration') {
  requestedSection = section;
  useUiStore.getState().openSettings('admin');
}
function consumeAdminSection(): string | null {
  const value = requestedSection;
  requestedSection = null;
  return value;
}

export function AdminPanel() {
  const { t } = useTranslation();
  const [section, setSection] = useState<Section>(() => (consumeAdminSection() as Section | null) ?? 'overview');
  return (
    <div className="settings-section admin-panel">
      <div className="segmented admin-tabs" role="tablist">
        {SECTIONS.map(({ id, icon: Icon }) => (
          <button key={id} type="button" role="tab" aria-selected={section === id} className={section === id ? 'is-active' : ''} onClick={() => setSection(id)}>
            <Icon size={14} aria-hidden="true" />
            {t(`adminPanel.tabs.${id}`)}
          </button>
        ))}
      </div>
      {section === 'overview' && <OverviewSection />}
      {section === 'users' && <UsersSection />}
      {section === 'online' && <OnlineSection />}
      {section === 'storage' && <StorageSection />}
      {section === 'announce' && <AnnounceSection />}
      {section === 'guilds' && <AllGuilds />}
      {section === 'limits' && <LimitsEditor />}
      {section === 'audit' && <AdminAudit />}
      {section === 'nodes' && <VoiceNodes />}
      {section === 'mail' && <MailSettings />}
      {section === 'registration' && <RegistrationSettings />}
    </div>
  );
}

function useLoad<T>(load: () => Promise<T>, failKey: string): { data: T | null; error: string | null; reload: () => void; loading: boolean } {
  const { t } = useTranslation();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const fetchNow = useCallback(() => {
    load().then(
      (value) => {
        setData(value);
        setError(null);
        setLoading(false);
      },
      (e: unknown) => {
        setError(friendlyError(e, t(failKey)));
        setLoading(false);
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(fetchNow, [fetchNow]);
  const reload = useCallback(() => {
    setLoading(true);
    fetchNow();
  }, [fetchNow]);
  return { data, error, reload, loading };
}

function RefreshButton({ onClick, busy }: { onClick: () => void; busy: boolean }) {
  const { t } = useTranslation();
  return (
    <button type="button" className="btn btn-secondary btn-sm" onClick={onClick} disabled={busy}>
      <RefreshCw size={14} aria-hidden="true" className={busy ? 'is-spinning' : undefined} /> {t('adminPanel.refresh')}
    </button>
  );
}

// ---- overview --------------------------------------------------------------------------------

function formatUptime(seconds: number, t: (key: string, o?: Record<string, unknown>) => string): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return t('adminPanel.uptimeDays', { d, h });
  if (h > 0) return t('adminPanel.uptimeHours', { h, m });
  return t('adminPanel.uptimeMinutes', { m });
}

function Health({ ok, label }: { ok: boolean | null; label: string }) {
  return <span className={`health-chip is-${ok === null ? 'checking' : ok ? 'ok' : 'down'}`}>{label}</span>;
}

function OverviewSection() {
  const { t } = useTranslation();
  const { data, error, reload, loading } = useLoad<AdminOverview>(() => adminApi.overview(), 'adminPanel.failed');
  return (
    <div className="admin-section">
      <div className="admin-toolbar">
        <span className="field-hint">{t('adminPanel.overviewHint')}</span>
        <RefreshButton onClick={reload} busy={loading} />
      </div>
      {error && <p className="field-error">{error}</p>}
      {data && (
        <div className="admin-cards">
          <div className="admin-card">
            <h4>
              <Shield size={15} aria-hidden="true" /> {t('adminPanel.server')}
            </h4>
            <dl className="admin-dl">
              <dt>{t('adminPanel.version')}</dt>
              <dd>{data.server.version}</dd>
              <dt>{t('adminPanel.uptime')}</dt>
              <dd>{formatUptime(data.server.uptimeSeconds, t)}</dd>
              <dt>{t('adminPanel.memory')}</dt>
              <dd>{t('adminPanel.mb', { value: data.server.memoryMb })}</dd>
              <dt>Node.js</dt>
              <dd>{data.server.node}</dd>
            </dl>
          </div>
          <div className="admin-card">
            <h4>
              <Database size={15} aria-hidden="true" /> {t('adminPanel.services')}
            </h4>
            <dl className="admin-dl">
              <dt>{t('adminPanel.database')}</dt>
              <dd>
                <Health ok={data.database.ok} label={data.database.ok ? t('adminPanel.okMs', { ms: data.database.latencyMs ?? 0 }) : t('adminPanel.down')} />
              </dd>
              <dt>LiveKit</dt>
              <dd>
                {data.livekit.configured ? <Health ok={data.livekit.ok} label={data.livekit.ok ? t('adminPanel.okMs', { ms: data.livekit.latencyMs ?? 0 }) : t('adminPanel.down')} /> : t('adminPanel.notConfigured')}
              </dd>
            </dl>
          </div>
          <div className="admin-card">
            <h4>
              <Activity size={15} aria-hidden="true" /> {t('adminPanel.activity')}
            </h4>
            <div className="admin-stats">
              <Stat value={data.realtime.users} label={t('adminPanel.onlineNow')} />
              <Stat value={data.counts.users - data.counts.disabledUsers} label={t('adminPanel.accounts')} />
              <Stat value={data.counts.messages} label={t('adminPanel.messages')} />
              <Stat value={data.counts.files} label={t('adminPanel.files', { size: formatBytes(data.counts.fileBytes) })} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Stat({ value, label }: { value: number; label: string }) {
  return (
    <div className="admin-stat">
      <span className="admin-stat-value">{value.toLocaleString()}</span>
      <span className="admin-stat-label">{label}</span>
    </div>
  );
}

// ---- users -----------------------------------------------------------------------------------

interface Credentials {
  username: string;
  password: string;
  reset: boolean;
}

function CredentialsCard({ value, onClose }: { value: Credentials; onClose: () => void }) {
  const { t } = useTranslation();
  const origin = getApiOrigin() || window.location.origin;
  const text = t('adminPanel.credentialsText', { url: origin, username: value.username, password: value.password });
  return (
    <div className="admin-credentials" role="status">
      <strong>{value.reset ? t('adminPanel.passwordResetDone') : t('adminPanel.userCreated')}</strong>
      <pre>{text}</pre>
      <p className="field-hint">{t('adminPanel.credentialsHint')}</p>
      <div className="admin-row-actions">
        <button
          type="button"
          className="btn btn-primary btn-sm"
          onClick={() => {
            void navigator.clipboard.writeText(text).then(() => toast.success(t('adminPanel.copied')));
          }}
        >
          <Copy size={14} aria-hidden="true" /> {t('adminPanel.copy')}
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>
          {t('adminPanel.done')}
        </button>
      </div>
    </div>
  );
}

function NewUserForm({ onCreated }: { onCreated: (user: AdminUser, password: string) => void }) {
  const { t } = useTranslation();
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState(() => generatePassword());
  const [admin, setAdmin] = useState(false);
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 0.7.0: servers the new account joins at once (by default our server "AIDis").
  const myGuilds = useGuildStore((s) => s.guilds);
  const [guildIds, setGuildIds] = useState<string[] | null>(null);
  const picked =
    guildIds ??
    myGuilds
      .filter((g) => g.name === 'AIDis')
      .map((g) => g.id)
      .slice(0, 1);
  const submit = async () => {
    if (!/^[A-Za-z0-9_.-]{3,32}$/.test(username.trim())) {
      setError(t('adminPanel.usernameRule'));
      return;
    }
    setBusy(true);
    try {
      const { user } = await adminApi.createUser({
        username: username.trim(),
        displayName: displayName.trim() || username.trim(),
        password,
        role: admin ? 'ADMIN' : 'USER',
        guildIds: picked,
        ...(email.trim() ? { email: email.trim() } : {}),
      });
      onCreated(user, password);
    } catch (e) {
      setError(friendlyError(e, t('adminPanel.createFailed')));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="admin-form"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="admin-form-grid">
        <label className="field">
          <span className="field-label">{t('adminPanel.username')}</span>
          <input
            className="input"
            data-autofocus
            value={username}
            maxLength={32}
            autoComplete="off"
            onChange={(e) => {
              setUsername(e.target.value);
              setError(null);
            }}
            placeholder="pancake"
          />
        </label>
        <label className="field">
          <span className="field-label">{t('adminPanel.displayName')}</span>
          <input className="input" value={displayName} maxLength={64} onChange={(e) => setDisplayName(e.target.value)} placeholder="Pancake" />
        </label>
        <label className="field">
          <span className="field-label">{t('adminPanel.password')}</span>
          <span className="admin-password">
            <input className="input" value={password} minLength={8} maxLength={128} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
            <button type="button" className="icon-btn" aria-label={t('adminPanel.regenerate')} title={t('adminPanel.regenerate')} onClick={() => setPassword(generatePassword())}>
              <RefreshCw size={15} />
            </button>
          </span>
        </label>
        <label className="field">
          <span className="field-label">{t('newUser.email')}</span>
          <input className="input" type="email" value={email} maxLength={254} autoComplete="off" onChange={(e) => setEmail(e.target.value)} placeholder="pancake@example.com" />
          <span className="field-hint">{t('newUser.emailHint')}</span>
        </label>
      </div>
      <label className="admin-check">
        <input type="checkbox" checked={admin} onChange={(e) => setAdmin(e.target.checked)} /> {t('adminPanel.makeAdmin')}
      </label>
      {myGuilds.length > 0 && (
        <fieldset className="sa-new-user-guilds">
          <legend className="field-label">{t('sa.users.guilds')}</legend>
          <div className="chip-list">
            {myGuilds.map((g) => {
              const on = picked.includes(g.id);
              return (
                <button key={g.id} type="button" className={`chip${on ? ' is-on' : ''}`} aria-pressed={on} onClick={() => setGuildIds(on ? picked.filter((id) => id !== g.id) : [...picked, g.id])}>
                  {g.name}
                </button>
              );
            })}
          </div>
          <span className="field-hint">{t('sa.users.guildsHint')}</span>
        </fieldset>
      )}
      {error && <p className="field-error">{error}</p>}
      <button type="submit" className="btn btn-primary btn-sm" disabled={busy || password.length < 8}>
        <Plus size={14} aria-hidden="true" /> {t('adminPanel.createUser')}
      </button>
    </form>
  );
}

type PendingAction = { kind: 'disable' | 'enable' | 'admin' | 'unadmin' | 'password' | 'logout'; user: AdminUser };

function UsersSection() {
  const { t } = useTranslation();
  const selfId = useAuthStore((s) => s.user?.id);
  const { data, error, reload, loading } = useLoad(() => adminApi.users(), 'adminPanel.failed');
  const [creating, setCreating] = useState(false);
  const [credentials, setCredentials] = useState<Credentials | null>(null);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const users = useMemo(() => [...(data?.users ?? [])].sort((a, b) => Number(a.disabled) - Number(b.disabled) || a.displayName.localeCompare(b.displayName)), [data]);

  const run = async (action: PendingAction) => {
    const { user } = action;
    try {
      if (action.kind === 'disable' || action.kind === 'enable') await adminApi.setDisabled(user.id, action.kind === 'disable');
      if (action.kind === 'admin' || action.kind === 'unadmin') await adminApi.setRole(user.id, action.kind === 'admin' ? 'ADMIN' : 'USER');
      if (action.kind === 'logout') await adminApi.revokeSessions(user.id);
      if (action.kind === 'password') {
        const password = generatePassword();
        await adminApi.setPassword(user.id, password);
        setCredentials({ username: user.username, password, reset: true });
      }
      reload();
    } catch (e) {
      toast.error(friendlyError(e, t('adminPanel.actionFailed')), 'admin-user');
    }
  };

  return (
    <div className="admin-section">
      <div className="admin-toolbar">
        <button type="button" className="btn btn-primary btn-sm" onClick={() => setCreating((v) => !v)}>
          <Plus size={14} aria-hidden="true" /> {t('adminPanel.newUser')}
        </button>
        <RefreshButton onClick={reload} busy={loading} />
      </div>
      {credentials && <CredentialsCard value={credentials} onClose={() => setCredentials(null)} />}
      {creating && !credentials && (
        <NewUserForm
          onCreated={(user, password) => {
            setCreating(false);
            setCredentials({ username: user.username, password, reset: false });
            reload();
          }}
        />
      )}
      {error && <p className="field-error">{error}</p>}
      <ul className="admin-list">
        {users.map((u) => {
          const self = u.id === selfId;
          return (
            <li key={u.id} className={`admin-user${u.disabled ? ' is-disabled' : ''}`}>
              <div className="admin-user-row">
                <Avatar userId={u.id} name={u.displayName} avatarAttachmentId={u.avatarAttachmentId} size={36} />
                <div className="admin-user-text">
                  <span className="admin-user-name">
                    <StyledName userId={u.id} name={u.displayName} fallback={u} />
                    {u.role === 'ADMIN' && <span className="admin-tag">{t('members.admin')}</span>}
                    {u.disabled && <span className="admin-tag is-danger">{t('adminPanel.disabled')}</span>}
                    {u.pendingVerification && <span className="admin-tag">{t('adminUsers.pending')}</span>}
                  </span>
                  <span className="admin-user-sub">
                    @{u.username}
                    {u.email ? ` · ${u.email}` : ''} · {u.lastSeenAt ? formatLastSeen(u.lastSeenAt) : t('adminPanel.neverSeen')}
                  </span>
                </div>
                <span className="admin-row-actions">
                  <button
                    type="button"
                    className={`icon-btn${open === u.id ? ' is-active' : ''}`}
                    aria-label={t('adminPanel.sessions')}
                    title={t('adminPanel.sessions')}
                    onClick={() => setOpen(open === u.id ? null : u.id)}
                  >
                    <MonitorSmartphone size={15} />
                  </button>
                  <button type="button" className="icon-btn" aria-label={t('adminPanel.resetPassword')} title={t('adminPanel.resetPassword')} onClick={() => setPending({ kind: 'password', user: u })}>
                    <KeyRound size={15} />
                  </button>
                  {!self && (
                    <button
                      type="button"
                      className="icon-btn"
                      aria-label={u.role === 'ADMIN' ? t('adminPanel.removeAdmin') : t('adminPanel.makeAdminShort')}
                      title={u.role === 'ADMIN' ? t('adminPanel.removeAdmin') : t('adminPanel.makeAdminShort')}
                      onClick={() => setPending({ kind: u.role === 'ADMIN' ? 'unadmin' : 'admin', user: u })}
                    >
                      {u.role === 'ADMIN' ? <ShieldOff size={15} /> : <Shield size={15} />}
                    </button>
                  )}
                  {!self && (
                    <button
                      type="button"
                      className={`icon-btn${u.disabled ? '' : ' is-danger-hover'}`}
                      aria-label={u.disabled ? t('adminPanel.enable') : t('adminPanel.disable')}
                      title={u.disabled ? t('adminPanel.enable') : t('adminPanel.disable')}
                      onClick={() => setPending({ kind: u.disabled ? 'enable' : 'disable', user: u })}
                    >
                      {u.disabled ? <UserCheck size={15} /> : <UserX size={15} />}
                    </button>
                  )}
                </span>
              </div>
              {open === u.id && <SessionsList user={u} onLogoutAll={() => setPending({ kind: 'logout', user: u })} />}
            </li>
          );
        })}
      </ul>
      {pending && (
        <ConfirmDialog
          title={t(`adminPanel.confirm.${pending.kind}.title`, { name: pending.user.displayName })}
          confirmLabel={t(`adminPanel.confirm.${pending.kind}.action`)}
          tone={pending.kind === 'enable' || pending.kind === 'admin' ? 'primary' : 'danger'}
          onClose={() => setPending(null)}
          onConfirm={async () => {
            const action = pending;
            setPending(null);
            await run(action);
          }}
        >
          <p>{t(`adminPanel.confirm.${pending.kind}.text`, { name: pending.user.displayName })}</p>
        </ConfirmDialog>
      )}
    </div>
  );
}

function SessionsList({ user, onLogoutAll }: { user: AdminUser; onLogoutAll: () => void }) {
  const { t } = useTranslation();
  const [sessions, setSessions] = useState<SessionView[] | null>(null);
  const load = useCallback(() => {
    adminApi.sessions(user.id).then(
      ({ sessions: list }) => setSessions(list),
      () => setSessions([]),
    );
  }, [user.id]);
  useEffect(load, [load]);
  if (!sessions) return <div className="admin-sessions">{t('settings.about.checking')}</div>;
  return (
    <div className="admin-sessions">
      {sessions.length === 0 && <p className="field-hint">{t('adminPanel.noSessions')}</p>}
      {sessions.map((s) => (
        <div key={s.id} className="admin-session">
          <div>
            <strong>{s.deviceName || t(`adminPanel.clientType.${s.clientType}`, { defaultValue: s.clientType })}</strong>
            <span className="admin-user-sub">
              {s.ipAddress ?? '—'} · {t('adminPanel.lastUsed', { time: formatMessageTimestamp(s.lastUsedAt) })}
            </span>
          </div>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => {
              void adminApi.revokeSession(s.id).then(load, (e: unknown) => toast.error(friendlyError(e, t('adminPanel.actionFailed')), 'admin-session'));
            }}
          >
            {t('adminPanel.endSession')}
          </button>
        </div>
      ))}
      {sessions.length > 1 && (
        <button type="button" className="btn btn-secondary btn-sm" onClick={onLogoutAll}>
          <LogOut size={14} aria-hidden="true" /> {t('adminPanel.endAll')}
        </button>
      )}
    </div>
  );
}

// ---- online ----------------------------------------------------------------------------------

function OnlineSection() {
  const { t } = useTranslation();
  const users = usePresenceStore((s) => s.users);
  const { data, reload, loading } = useLoad(() => adminApi.connections(), 'adminPanel.failed');
  useEffect(() => {
    const timer = window.setInterval(reload, 15_000);
    return () => window.clearInterval(timer);
  }, [reload]);
  const byUser = useMemo(() => {
    const map = new Map<string, AdminConnection[]>();
    for (const c of data?.connections ?? []) map.set(c.userId, [...(map.get(c.userId) ?? []), c]);
    return [...map.entries()].sort((a, b) => (users[a[0]]?.displayName ?? '').localeCompare(users[b[0]]?.displayName ?? ''));
  }, [data, users]);
  const occupancy = useVoiceStore((s) => s.occupancy);
  const states = useVoiceStore((s) => s.memberStates);
  const channels = useChatStore((s) => s.channels);
  const voice = Object.entries(occupancy).filter(([, list]) => list.length > 0);

  return (
    <div className="admin-section">
      <div className="admin-toolbar">
        <span className="field-hint">{t('adminPanel.onlineHint', { version: config.clientVersion })}</span>
        <RefreshButton onClick={reload} busy={loading} />
      </div>
      <h4 className="settings-group-title">{t('adminPanel.connectedNow', { count: byUser.length })}</h4>
      <ul className="admin-list">
        {byUser.map(([userId, list]) => {
          const u = users[userId];
          return (
            <li key={userId} className="admin-user">
              <div className="admin-user-row">
                <Avatar userId={userId} name={u?.displayName ?? '?'} avatarAttachmentId={u?.avatarAttachmentId} size={30} />
                <div className="admin-user-text">
                  <span className="admin-user-name">{u ? <StyledName userId={userId} name={u.displayName} fallback={u} /> : userId}</span>
                  <span className="admin-chips">
                    {list.map((c) => {
                      const old = c.version !== null && compareVersions(c.version, config.clientVersion) < 0;
                      return (
                        <span
                          key={c.sessionId + c.connectedAt}
                          className={`admin-tag${old || c.version === null ? ' is-warning' : ''}`}
                          title={t('adminPanel.connectedSince', { time: formatMessageTimestamp(c.connectedAt) })}
                        >
                          {t(platformLabelKey(c.platform))} {c.version ?? t('adminPanel.oldVersion')}
                        </span>
                      );
                    })}
                  </span>
                </div>
              </div>
            </li>
          );
        })}
      </ul>
      <h4 className="settings-group-title">{t('adminPanel.voiceNow')}</h4>
      {voice.length === 0 && <p className="field-hint">{t('adminPanel.voiceEmpty')}</p>}
      {voice.map(([channelId, list]) => (
        <div key={channelId} className="admin-card">
          <h4>
            <Volume2 size={15} aria-hidden="true" /> {channels.find((c) => c.id === channelId)?.name ?? channelId}
          </h4>
          <ul className="admin-list">
            {list.map((p) => (
              <li key={p.identity} className="admin-voice-row">
                <span>
                  {users[p.identity]?.displayName ?? p.name}
                  {states[p.identity]?.screen && <span className="live-badge">{t('voice.live')}</span>}
                  {states[p.identity]?.muted && <span className="admin-user-sub"> · {t('voice.muted')}</span>}
                </span>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => {
                    void voiceApi.disconnectParticipant(channelId, p.identity).catch((e: unknown) => toast.error(friendlyError(e, t('adminPanel.actionFailed')), 'admin-voice'));
                  }}
                >
                  {t('adminPanel.disconnect')}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

// ---- storage ---------------------------------------------------------------------------------

function StorageSection() {
  const { t } = useTranslation();
  const stats = useLoad<AdminStorage>(() => adminApi.storage(), 'adminPanel.failed');
  const files = useLoad<{ files: AdminFile[] }>(() => adminApi.largestFiles(30), 'adminPanel.failed');
  const [deleting, setDeleting] = useState<AdminFile | null>(null);
  const reload = () => {
    stats.reload();
    files.reload();
  };
  const disk = stats.data?.disk;
  const used = disk ? disk.total - disk.free : 0;
  return (
    <div className="admin-section">
      <div className="admin-toolbar">
        <span className="field-hint">{t('adminPanel.storageHint')}</span>
        <RefreshButton onClick={reload} busy={stats.loading || files.loading} />
      </div>
      {stats.error && <p className="field-error">{stats.error}</p>}
      {stats.data && (
        <div className="admin-cards">
          <div className="admin-card">
            <h4>
              <HardDrive size={15} aria-hidden="true" /> {t('adminPanel.disk')}
            </h4>
            {disk ? (
              <>
                <div className="admin-meter" role="meter" aria-valuemin={0} aria-valuemax={disk.total} aria-valuenow={used}>
                  <span style={{ width: `${String(Math.min(100, Math.round((used / Math.max(1, disk.total)) * 100)))}%` }} />
                </div>
                <p className="field-hint">{t('adminPanel.diskText', { free: formatBytes(disk.free), total: formatBytes(disk.total) })}</p>
              </>
            ) : (
              <p className="field-hint">{t('adminPanel.unknown')}</p>
            )}
          </div>
          <div className="admin-card">
            <h4>{t('adminPanel.uploads')}</h4>
            <dl className="admin-dl">
              <dt>{t('adminPanel.filesCount')}</dt>
              <dd>{t('adminPanel.filesValue', { count: stats.data.files.count, size: formatBytes(stats.data.files.bytes) })}</dd>
              <dt>{t('adminPanel.partial')}</dt>
              <dd>{t('adminPanel.filesValue', { count: stats.data.partial.count, size: formatBytes(stats.data.partial.bytes) })}</dd>
              <dt>{t('adminPanel.limits')}</dt>
              <dd>{t('adminPanel.limitsValue', { small: formatBytes(stats.data.maxUploadSize), large: formatBytes(stats.data.maxLargeUploadSize) })}</dd>
            </dl>
            {stats.data.partial.idleOverHour > 0 && (
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => {
                  void adminApi.purgePartials().then(({ removed }) => {
                    toast.success(t('adminPanel.purged', { count: removed }));
                    stats.reload();
                  });
                }}
              >
                <Trash size={14} aria-hidden="true" /> {t('adminPanel.purge', { count: stats.data.partial.idleOverHour })}
              </button>
            )}
          </div>
        </div>
      )}
      <h4 className="settings-group-title">{t('adminPanel.biggest')}</h4>
      <ul className="admin-list">
        {(files.data?.files ?? []).map((f) => (
          <li key={f.id} className="admin-file">
            <div className="admin-user-text">
              <span className="admin-user-name">{f.originalName}</span>
              <span className="admin-user-sub">
                {formatBytes(f.size)} · {f.uploader.displayName} · {formatMessageTimestamp(f.createdAt)}
                {!f.messageId && ` · ${t('adminPanel.notInMessage')}`}
              </span>
            </div>
            <span className="admin-row-actions">
              {f.messageId && f.channelId && (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => {
                    useUiStore.getState().closeSettings();
                    void useChatStore.getState().jumpTo(f.channelId as string, f.messageId as string);
                  }}
                >
                  {t('adminPanel.show')}
                </button>
              )}
              <button type="button" className="icon-btn is-danger-hover" aria-label={t('common.delete')} onClick={() => setDeleting(f)}>
                <Trash size={15} />
              </button>
            </span>
          </li>
        ))}
      </ul>
      {deleting && (
        <ConfirmDialog
          title={t('adminPanel.deleteFileTitle')}
          confirmLabel={t('common.delete')}
          onClose={() => setDeleting(null)}
          onConfirm={async () => {
            const file = deleting;
            setDeleting(null);
            try {
              await adminApi.deleteFile(file.id);
              reload();
            } catch (e) {
              toast.error(friendlyError(e, t('adminPanel.actionFailed')), 'admin-file');
            }
          }}
        >
          <p>{t('adminPanel.deleteFileText', { name: deleting.originalName, size: formatBytes(deleting.size) })}</p>
        </ConfirmDialog>
      )}
    </div>
  );
}

// ---- announcement and settings ---------------------------------------------------------------

function AnnounceSection() {
  const { t } = useTranslation();
  const current = useAnnouncementStore((s) => s.announcement);
  const [text, setText] = useState(current?.text ?? '');
  const [level, setLevel] = useState<'info' | 'warning'>(current?.level ?? 'info');
  const [busy, setBusy] = useState(false);

  const publish = async () => {
    setBusy(true);
    try {
      const { announcement } = await adminApi.setAnnouncement(text.trim(), level);
      useAnnouncementStore.getState().set(announcement);
      toast.success(t('adminPanel.announcePublished'));
    } catch (e) {
      toast.error(friendlyError(e, t('adminPanel.actionFailed')), 'admin-announce');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="admin-section">
      <div className="admin-card">
        <h4>
          <Megaphone size={15} aria-hidden="true" /> {t('adminPanel.announce')}
        </h4>
        <p className="field-hint">{t('adminPanel.announceHint')}</p>
        <textarea className="input admin-textarea" value={text} maxLength={300} rows={3} onChange={(e) => setText(e.target.value)} placeholder={t('adminPanel.announcePlaceholder')} />
        <div className="admin-toolbar">
          <div className="segmented is-compact" role="radiogroup" aria-label={t('adminPanel.announceLevel')}>
            {(['info', 'warning'] as const).map((value) => (
              <button key={value} type="button" role="radio" aria-checked={level === value} className={`segment${level === value ? ' is-active' : ''}`} onClick={() => setLevel(value)}>
                {t(`adminPanel.level.${value}`)}
              </button>
            ))}
          </div>
          <span className="admin-row-actions">
            {current && (
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => {
                  void adminApi.clearAnnouncement().then(() => {
                    useAnnouncementStore.getState().set(null);
                    setText('');
                  });
                }}
              >
                {t('adminPanel.announceRemove')}
              </button>
            )}
            <button type="button" className="btn btn-primary btn-sm" disabled={busy || text.trim().length === 0} onClick={() => void publish()}>
              {t('adminPanel.announcePublish')}
            </button>
          </span>
        </div>
      </div>
      <p className="field-hint">{t('sa.newsMoved')}</p>
    </div>
  );
}
