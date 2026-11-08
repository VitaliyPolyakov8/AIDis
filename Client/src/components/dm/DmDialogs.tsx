import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Check, Search } from 'lucide-react';
import { create } from 'zustand';
import type { Channel } from '../../api/types';
import { dmsApi } from '../../api/channels';
import { friendlyError } from '../../api/errors';
import { useChatStore } from '../../stores/chatStore';
import { usePresenceStore } from '../../stores/presenceStore';
import { useFriendsStore } from '../../stores/friendsStore';
import { useAuthStore } from '../../stores/authStore';
import { dmPath } from '../guilds/routes';
import { Modal } from '../Modal';
import { Avatar } from '../Avatar';
import { StyledName } from '../profile/StyledName';

/** Group DMs: me + up to this many (same limit as the server). */
const MAX_OTHERS = 10;

type DialogState = { kind: 'new' } | { kind: 'add'; channel: Channel } | null;
const useDmDialog = create<{ dialog: DialogState }>(() => ({ dialog: null }));

export function openNewDm(): void {
  useDmDialog.setState({ dialog: { kind: 'new' } });
}
export function openAddPeople(channel: Channel): void {
  useDmDialog.setState({ dialog: { kind: 'add', channel } });
}
const close = () => useDmDialog.setState({ dialog: null });

/** Opens (or reuses) the 1:1 DM with someone and shows it. */
export function useOpenDm() {
  const navigate = useNavigate();
  return async (userId: string) => {
    const { dm } = await dmsApi.open([userId]);
    useChatStore.getState().upsertDm(dm);
    void navigate(dmPath(dm.id));
  };
}

function PeoplePicker({ exclude, onSubmit, submitLabel, withTitle }: { exclude: string[]; onSubmit: (ids: string[], title: string) => Promise<void>; submitLabel: string; withTitle: boolean }) {
  const { t } = useTranslation();
  const users = usePresenceStore((s) => s.users);
  // 0.7.0: conversations only with friends (the server checks too).
  const friendIds = useFriendsStore((st) => st.friendIds);
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const list = useMemo(
    () =>
      Object.values(users)
        .filter((u) => !exclude.includes(u.id) && friendIds.includes(u.id))
        .filter((u) => !query || u.displayName.toLowerCase().includes(query.toLowerCase()) || u.username.toLowerCase().includes(query.toLowerCase()))
        .sort((a, b) => a.displayName.localeCompare(b.displayName)),
    [users, exclude, query, friendIds],
  );
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : p.length >= MAX_OTHERS ? p : [...p, id]));
  return (
    <form
      className="people-picker"
      onSubmit={(e) => {
        e.preventDefault();
        if (picked.length === 0) return;
        setBusy(true);
        setError(null);
        onSubmit(picked, title.trim()).then(close, (err: unknown) => {
          setError(friendlyError(err, t('dm.failed')));
          setBusy(false);
        });
      }}
    >
      <label className="search-field">
        <Search size={14} aria-hidden="true" />
        <input data-autofocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('dm.findPeople')} aria-label={t('dm.findPeople')} />
      </label>
      <ul className="people-list" role="listbox" aria-multiselectable="true">
        {list.map((u) => {
          const on = picked.includes(u.id);
          return (
            <li key={u.id}>
              <button type="button" role="option" aria-selected={on} className={`people-option${on ? ' is-on' : ''}`} onClick={() => toggle(u.id)}>
                <Avatar userId={u.id} name={u.displayName} avatarAttachmentId={u.avatarAttachmentId} size={30} />
                <span className="people-option-names">
                  <StyledName userId={u.id} name={u.displayName} fallback={u} />
                  <span className="people-option-user">@{u.username}</span>
                </span>
                <span className="people-check" aria-hidden="true">
                  {on && <Check size={14} />}
                </span>
              </button>
            </li>
          );
        })}
        {list.length === 0 && <li className="people-empty">{t('dm.nobody')}</li>}
      </ul>
      {withTitle && picked.length > 1 && (
        <label className="field">
          <span className="field-label">{t('dm.groupName')}</span>
          <input className="input" value={title} maxLength={64} onChange={(e) => setTitle(e.target.value)} placeholder={t('dm.groupNamePlaceholder')} />
        </label>
      )}
      {error && <p className="field-error">{error}</p>}
      <div className="modal-actions">
        <span className="people-count">{t('dm.selected', { count: picked.length, max: MAX_OTHERS })}</span>
        <button type="button" className="btn btn-ghost" onClick={close}>
          {t('common.cancel')}
        </button>
        <button type="submit" className="btn btn-primary" disabled={busy || picked.length === 0}>
          {submitLabel}
        </button>
      </div>
    </form>
  );
}

/** Mounted once in the shell. */
export function DmDialogHost() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const dialog = useDmDialog((s) => s.dialog);
  const selfId = useAuthStore((s) => s.user?.id ?? '');
  if (!dialog) return null;
  if (dialog.kind === 'new') {
    return (
      <Modal title={t('dm.new')} onClose={close} size="sm" className="people-modal">
        <p className="modal-text">{t('dm.newHint')}</p>
        <PeoplePicker
          exclude={[selfId]}
          withTitle
          submitLabel={t('dm.start')}
          onSubmit={async (ids, title) => {
            const { dm } = await dmsApi.open(ids, title || undefined);
            useChatStore.getState().upsertDm(dm);
            void navigate(dmPath(dm.id));
          }}
        />
      </Modal>
    );
  }
  return (
    <Modal title={t('dm.addPeople')} onClose={close} size="sm" className="people-modal">
      <PeoplePicker
        exclude={dialog.channel.memberIds ?? []}
        withTitle={false}
        submitLabel={t('dm.add')}
        onSubmit={async (ids) => {
          const { dm } = await dmsApi.update(dialog.channel.id, { addUserIds: ids });
          useChatStore.getState().upsertDm(dm);
        }}
      />
    </Modal>
  );
}
