import { useEffect } from 'react';
import { Navigate, useParams } from 'react-router';
import { useGuildStore } from '../stores/guildStore';
import { guildPath, rememberChannel } from '../components/guilds/routes';
import { ChatView } from './ChatView';
import { VoiceView } from './VoiceView';

/** /channels/:guildId/:channelId: text and voice channels share one path, the view follows the type. */
export function GuildChannelView() {
  const { guildId = '', channelId = '' } = useParams();
  const type = useGuildStore((s) => s.byGuild[guildId]?.channels.find((c) => c.id === channelId)?.type);

  useEffect(() => {
    if (type === 'TEXT') rememberChannel(guildId, channelId);
  }, [type, guildId, channelId]);

  if (type === 'TEXT') return <ChatView />;
  if (type === 'VOICE') return <VoiceView />;
  // Unknown here, a category, or gone: the server's landing channel (or Home when the server is gone too).
  return <Navigate to={guildPath(guildId)} replace />;
}
