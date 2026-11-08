import { Navigate, useLocation, useParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { useGuildStore } from '../../stores/guildStore';
import { useChatStore } from '../../stores/chatStore';
import { channelPath, homePath, landingChannel, lastGuild, legacyRedirect } from './routes';

/** Finds a channel or DM by id across all my servers (for 0.6 links). */
function lookupChannel(id: string) {
  return useGuildStore.getState().channelById(id) ?? useChatStore.getState().dms.find((d) => d.id === id);
}

/** /channels/:guildId -> that server's last or first text channel; an old /channels/:channelId -> its new path. */
export function GuildRedirect() {
  const { t } = useTranslation();
  const { guildId = '' } = useParams();
  const location = useLocation();
  const channels = useGuildStore((s) => s.byGuild[guildId]?.channels);
  const guildsLoaded = useGuildStore((s) => s.loaded);
  if (!channels) {
    const legacy = legacyRedirect(location.pathname, lookupChannel);
    if (legacy) return <Navigate to={legacy} replace />;
    // Still loading: wait instead of bouncing to Home.
    if (!guildsLoaded && Object.keys(useGuildStore.getState().byGuild).length === 0) return null;
    // Unknown server (left or removed): Home.
    return <Navigate to={homePath()} replace />;
  }
  const target = landingChannel(guildId, channels);
  if (!target) {
    return (
      <div className="center-empty">
        <p>{t('splash.noTextChannels')}</p>
      </div>
    );
  }
  return <Navigate to={channelPath(guildId, target.id)} replace />;
}

/** Old 0.6 paths (/voice/:id, /dm/:id, /dm) and unknown paths. */
export function LegacyRedirect() {
  const location = useLocation();
  const legacy = legacyRedirect(location.pathname, lookupChannel);
  if (legacy) return <Navigate to={legacy} replace />;
  return <DefaultRedirect />;
}

/** "/" and unknown paths: the last opened server, else Home. */
export function DefaultRedirect() {
  const guilds = useGuildStore((s) => s.guilds);
  const last = lastGuild();
  const target = guilds.find((g) => g.id === last) ?? guilds[0];
  return <Navigate to={target ? `/channels/${encodeURIComponent(target.id)}` : homePath()} replace />;
}
