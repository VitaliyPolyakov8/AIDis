import { Navigate, useParams } from 'react-router';
import { guildPath, homePath, HOME_SEGMENT } from '../components/guilds/routes';

/** The open channel or DM is gone (deleted, hidden, left): back to the server's landing channel, or Home. */
export function DefaultChannelRedirect() {
  const { guildId } = useParams();
  return <Navigate to={guildId && guildId !== HOME_SEGMENT ? guildPath(guildId) : homePath()} replace />;
}
