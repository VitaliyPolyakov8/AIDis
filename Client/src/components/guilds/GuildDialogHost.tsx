import { useNavigate } from 'react-router';
import { ServerProfileDialog } from './ServerProfileDialog';
import { useTranslation } from 'react-i18next';
import { guildsApi } from '../../api/guilds';
import { friendlyError } from '../../api/errors';
import { useGuildStore } from '../../stores/guildStore';
import { useVoiceStore } from '../../voice/voiceStore';
import { voice } from '../../voice/voiceService';
import { toast } from '../../stores/uiStore';
import { ConfirmDialog } from '../ConfirmDialog';
import { closeGuildDialog, useGuildDialogs } from './guildDialogs';
import { CreateGuildDialog } from './CreateGuildDialog';
import { JoinGuildDialog } from './JoinGuildDialog';
import { InviteDialog } from './InviteDialog';
import { homePath } from './routes';
import { GuildSettingsModal } from '../guildSettings/GuildSettingsModal';

function LeaveGuildDialog({ guildId }: { guildId: string }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const name = useGuildStore((s) => s.guilds.find((g) => g.id === guildId)?.name ?? '');
  return (
    <ConfirmDialog
      title={t('server.leaveTitle', { name })}
      confirmLabel={t('server.leave')}
      onClose={closeGuildDialog}
      onConfirm={async () => {
        try {
          await guildsApi.leave(guildId);
        } catch (e) {
          throw new Error(friendlyError(e, t('server.leaveFailed')), { cause: e });
        }
        const { channelId, status } = useVoiceStore.getState();
        const inCall = channelId !== null && status !== 'idle' && useGuildStore.getState().byGuild[guildId]?.channels.some((c) => c.id === channelId);
        if (inCall) void voice.leave({ silent: true });
        useGuildStore.getState().removeGuild(guildId);
        toast.info(t('guilds.leave.done', { name }), `guild-left-${guildId}`);
        void navigate(homePath());
      }}
    >
      <p>{t('server.leaveBody')}</p>
    </ConfirmDialog>
  );
}

/** 0.7.0: shows the open server dialog (see guildDialogs.ts). Server settings and profile: later tasks. */
export function GuildDialogHost() {
  const dialog = useGuildDialogs((s) => s.dialog);
  if (!dialog) return null;
  switch (dialog.kind) {
    case 'create':
      return <CreateGuildDialog />;
    case 'join':
      return <JoinGuildDialog key={dialog.code ?? 'join'} initialCode={dialog.code} />;
    case 'invite':
      return <InviteDialog guildId={dialog.guildId} channelId={dialog.channelId} />;
    case 'leave':
      return <LeaveGuildDialog guildId={dialog.guildId} />;
    case 'profile':
      return <ServerProfileDialog key={dialog.guildId} guildId={dialog.guildId} />;
    case 'settings':
      return <GuildSettingsModal key={dialog.guildId} guildId={dialog.guildId} initial={dialog.section} />;
    default:
      return null;
  }
}
