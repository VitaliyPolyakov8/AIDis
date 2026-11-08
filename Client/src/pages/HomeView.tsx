import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, MessageCircle, UserMinus, UserPlus, Users, X } from 'lucide-react';
import type { PublicUser } from '../api/types';
import { CenterHeader } from '../components/CenterHeader';
import { useOpenDm } from '../components/dm/DmDialogs';
import { Avatar } from '../components/Avatar';
import { StyledName } from '../components/profile/StyledName';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { usePresenceStore } from '../stores/presenceStore';
import { friendsErrorText, useFriendsStore } from '../stores/friendsStore';
import { presenceState } from '../utils/presence';
import { toast } from '../stores/uiStore';
import { friendlyError } from '../api/errors';
import { openProfile } from '../components/profile/profileState';

type Tab = 'online' | 'all' | 'pending' | 'add';

function AddFriend() {
  const { t } = useTranslation();
  const request = useFriendsStore((s) => s.request);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  return (
    <form
      className="friends-add"
      onSubmit={(e) => {
        e.preventDefault();
        if (!name.trim()) return;
        setBusy(true);
        setResult(null);
        request(name).then(
          (status) => {
            setResult({ ok: true, text: t(status === 'accepted' ? 'friends.accepted' : 'friends.sent') });
            setName('');
            setBusy(false);
          },
          (err: unknown) => {
            setResult({ ok: false, text: friendsErrorText(err) });
            setBusy(false);
          },
        );
      }}
    >
      <h2 className="friends-add-title">{t('friends.add')}</h2>
      <p className="field-hint">{t('friends.addHint')}</p>
      <span className="input-row">
        <input className="input" data-autofocus value={name} onChange={(e) => setName(e.target.value)} placeholder={t('friends.addPlaceholder')} aria-label={t('friends.addPlaceholder')} autoComplete="off" />
        <button type="submit" className="btn btn-primary" disabled={busy || !name.trim()}>
          {t('friends.send')}
        </button>
      </span>
      {result && (
        <p className={result.ok ? 'field-success' : 'field-error'} role={result.ok ? 'status' : 'alert'}>
          {result.text}
        </p>
      )}
    </form>
  );
}

function PersonRow({ user, children }: { user: PublicUser; children: React.ReactNode }) {
  const presence = usePresenceStore((s) => s.presence[user.id]);
  const state = presenceState(presence);
  return (
    <li className="friend-row">
      <button type="button" className="friend-who" onClick={(e) => openProfile(e, user.id)}>
        <Avatar userId={user.id} name={user.displayName} avatarAttachmentId={user.avatarAttachmentId} size={36} status={state} />
        <span className="friend-names">
          <StyledName userId={user.id} name={user.displayName} fallback={user} />
          <span className="friend-user">@{user.username}</span>
        </span>
      </button>
      <span className="friend-actions">{children}</span>
    </li>
  );
}

/** 0.7.0 Home (/channels/@me): friends, requests and adding friends; DMs are in the sidebar. */
export function HomeView() {
  const { t } = useTranslation();
  const users = usePresenceStore((s) => s.users);
  const presence = usePresenceStore((s) => s.presence);
  const { friendIds, incoming, outgoing, accept, decline, remove } = useFriendsStore();
  const [tab, setTab] = useState<Tab>(friendIds.length === 0 && incoming.length === 0 ? 'add' : incoming.length > 0 ? 'pending' : 'online');
  const [removing, setRemoving] = useState<PublicUser | null>(null);
  const openDm = useOpenDm();
  useEffect(() => {
    document.title = `${t('friends.title')} · AIDis`;
  }, [t]);

  const people = (ids: string[]) =>
    ids
      .map((id) => users[id])
      .filter((u): u is PublicUser => u !== undefined)
      .sort((a, b) => a.displayName.localeCompare(b.displayName));
  const friends = useMemo(() => people(friendIds), [friendIds, users]); // eslint-disable-line react-hooks/exhaustive-deps
  const online = friends.filter((u) => presenceState(presence[u.id]) !== 'offline');
  const shown = tab === 'online' ? online : friends;
  const run = (action: Promise<void>) => action.catch((e: unknown) => toast.error(friendsErrorText(e), 'friends'));
  const message = (userId: string) => openDm(userId).catch((e: unknown) => toast.error(friendlyError(e, t('dm.failed')), 'dm-open'));

  const tabs: { id: Tab; label: string; count?: number }[] = [
    { id: 'online', label: t('friends.online') },
    { id: 'all', label: t('friends.all') },
    { id: 'pending', label: t('friends.pending'), count: incoming.length },
    { id: 'add', label: t('friends.add') },
  ];

  return (
    <div className="chat-view home-view">
      <CenterHeader icon={<Users size={19} />} title={t('friends.title')}>
        <div className="segmented friends-tabs" role="tablist">
          {tabs.map(({ id, label, count }) => (
            <button key={id} type="button" role="tab" aria-selected={tab === id} className={`${tab === id ? 'is-active' : ''}${id === 'add' ? ' is-add' : ''}`} onClick={() => setTab(id)}>
              {id === 'add' && <UserPlus size={14} aria-hidden="true" />} {label}
              {count ? <span className="badge badge-mention">{count}</span> : null}
            </button>
          ))}
        </div>
      </CenterHeader>
      <div className="home-body">
        {tab === 'add' && <AddFriend />}
        {(tab === 'online' || tab === 'all') && (
          <>
            <h3 className="friends-count">
              {tab === 'online' ? t('friends.online') : t('friends.all')} — {shown.length}
            </h3>
            {shown.length === 0 && <p className="field-hint">{tab === 'online' && friends.length > 0 ? t('friends.noneOnline') : t('friends.empty')}</p>}
            <ul className="friend-list">
              {shown.map((u) => (
                <PersonRow key={u.id} user={u}>
                  <button type="button" className="icon-btn" aria-label={`${t('friends.message')}: ${u.displayName}`} title={t('friends.message')} onClick={() => void message(u.id)}>
                    <MessageCircle size={17} />
                  </button>
                  <button type="button" className="icon-btn is-danger-hover" aria-label={`${t('friends.remove')}: ${u.displayName}`} title={t('friends.remove')} onClick={() => setRemoving(u)}>
                    <UserMinus size={17} />
                  </button>
                </PersonRow>
              ))}
            </ul>
          </>
        )}
        {tab === 'pending' && (
          <>
            {incoming.length === 0 && outgoing.length === 0 && <p className="field-hint">{t('friends.noPending')}</p>}
            {incoming.length > 0 && (
              <h3 className="friends-count">
                {t('friends.incoming')} — {incoming.length}
              </h3>
            )}
            <ul className="friend-list">
              {people(incoming).map((u) => (
                <PersonRow key={u.id} user={u}>
                  <button type="button" className="icon-btn is-success-hover" aria-label={`${t('friends.accept')}: ${u.displayName}`} title={t('friends.accept')} onClick={() => void run(accept(u.id))}>
                    <Check size={17} />
                  </button>
                  <button type="button" className="icon-btn is-danger-hover" aria-label={`${t('friends.decline')}: ${u.displayName}`} title={t('friends.decline')} onClick={() => void run(decline(u.id))}>
                    <X size={17} />
                  </button>
                </PersonRow>
              ))}
            </ul>
            {outgoing.length > 0 && (
              <h3 className="friends-count">
                {t('friends.outgoing')} — {outgoing.length}
              </h3>
            )}
            <ul className="friend-list">
              {people(outgoing).map((u) => (
                <PersonRow key={u.id} user={u}>
                  <button type="button" className="icon-btn is-danger-hover" aria-label={`${t('friends.cancel')}: ${u.displayName}`} title={t('friends.cancel')} onClick={() => void run(decline(u.id))}>
                    <X size={17} />
                  </button>
                </PersonRow>
              ))}
            </ul>
          </>
        )}
      </div>
      {removing && (
        <ConfirmDialog
          title={t('friends.removeTitle', { name: removing.displayName })}
          confirmLabel={t('friends.remove')}
          onClose={() => setRemoving(null)}
          onConfirm={async () => {
            try {
              await remove(removing.id);
            } catch (e) {
              throw new Error(friendsErrorText(e), { cause: e });
            }
          }}
        >
          <p>{t('friends.removeBody')}</p>
        </ConfirmDialog>
      )}
    </div>
  );
}
