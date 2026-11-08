import { useMemo, useState } from 'react';
import { moveTargets } from './moveTargets';
import { useTranslation } from 'react-i18next';
import { Volume2 } from 'lucide-react';
import { create } from 'zustand';
import type { PublicUser } from '../../api/types';
import { voiceApi } from '../../api/voice';
import { friendlyError, isApiError } from '../../api/errors';
import { t as translate } from '../../i18n';
import { useChatStore } from '../../stores/chatStore';
import { toast } from '../../stores/uiStore';
import { Modal } from '../Modal';
import { ConfirmDialog } from '../ConfirmDialog';

type Target = Pick<PublicUser, 'id' | 'displayName'>;
type State = { kind: 'move'; user: Target; channelId: string } | { kind: 'disconnect'; user: Target; channelId: string } | null;
const useModeration = create<{ state: State }>(() => ({ state: null }));

/** MOVE_USERS: pick another voice channel; the server moves the LiveKit connection. */
export const openMoveUser = (user: Target, channelId: string) => useModeration.setState({ state: { kind: 'move', user, channelId } });
/** DISCONNECT_USERS: remove from voice (not a ban). */
export const openVoiceDisconnect = (user: Target, channelId: string) => useModeration.setState({ state: { kind: 'disconnect', user, channelId } });
const close = () => useModeration.setState({ state: null });

/**
 * MOVE_USERS (picker and, 0.5.2, drag & drop in the channel list): asks the server to move `user`
 * from `channelId` to `targetId`. Shows the success toast; returns null, or the error text.
 */
export async function moveVoiceUser(user: Target, channelId: string, targetId: string, targetName: string): Promise<string | null> {
  try {
    await voiceApi.moveParticipant(channelId, user.id, targetId);
    toast.success(translate('voice.moderation.moved', { name: user.displayName, channel: targetName }), 'voice-move');
    return null;
  } catch (e) {
    const code = isApiError(e) ? e.code : '';
    return code === 'VOICE_PARTICIPANT_NOT_FOUND'
      ? translate('voice.menu.alreadyLeft')
      : code === 'TARGET_NOT_ALLOWED'
        ? translate('voice.moderation.notAllowed')
        : friendlyError(e, translate('voice.moderation.moveFailed'));
  }
}

function MovePicker({ user, channelId }: { user: Target; channelId: string }) {
  const { t } = useTranslation();
  const allChannels = useChatStore((s) => s.channels);
  const channels = useMemo(() => moveTargets(allChannels, channelId), [allChannels, channelId]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const move = async (targetId: string, targetName: string) => {
    setBusy(targetId);
    setError(null);
    const failure = await moveVoiceUser(user, channelId, targetId, targetName);
    if (failure === null) {
      close();
      return;
    }
    setError(failure);
    setBusy(null);
  };
  return (
    <div className="move-picker">
      <p className="modal-text">{t('voice.moderation.moveHint', { name: user.displayName })}</p>
      <ul className="move-list">
        {channels.map((c) => (
          <li key={c.id}>
            <button type="button" className="move-option" disabled={busy !== null} onClick={() => void move(c.id, c.name)}>
              <Volume2 size={16} aria-hidden="true" />
              <span>{c.name}</span>
              {busy === c.id && <span className="spinner" aria-hidden="true" />}
            </button>
          </li>
        ))}
        {channels.length === 0 && <li className="people-empty">{t('voice.moderation.noOther')}</li>}
      </ul>
      {error && <p className="field-error">{error}</p>}
    </div>
  );
}

export function ModerationDialogHost() {
  const { t } = useTranslation();
  const state = useModeration((s) => s.state);
  if (!state) return null;
  if (state.kind === 'move') {
    return (
      <Modal title={t('voice.moderation.moveTitle', { name: state.user.displayName })} onClose={close} size="sm">
        <MovePicker user={state.user} channelId={state.channelId} />
      </Modal>
    );
  }
  return (
    <ConfirmDialog
      title={t('voice.menu.disconnectTitle', { name: state.user.displayName })}
      confirmLabel={t('voice.menu.disconnectConfirm')}
      tone="primary"
      onClose={close}
      onConfirm={async () => {
        try {
          await voiceApi.disconnectParticipant(state.channelId, state.user.id);
          toast.info(translate('voice.menu.disconnected', { name: state.user.displayName }), 'voice-disconnect');
        } catch (error) {
          const code = isApiError(error) ? error.code : '';
          // NOT_FOUND ("Route not found"): the server does not have the endpoint yet (not redeployed).
          const message =
            code === 'VOICE_PARTICIPANT_NOT_FOUND' ? translate('voice.menu.alreadyLeft') : code === 'NOT_FOUND' ? translate('voice.menu.serverOutdated') : friendlyError(error, translate('voice.menu.disconnectFailed'));
          throw new Error(message, { cause: error });
        }
      }}
    >
      <p>{t('voice.menu.disconnectBody')}</p>
    </ConfirmDialog>
  );
}
