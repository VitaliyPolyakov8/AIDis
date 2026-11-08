import type { GameView } from '../api/types';
import { useAttachmentUrl } from '../hooks/useAttachmentUrl';
import { useServerConfig } from '../api/clientConfig';
import { GameArt } from '../components/profile/GameArt';

/** The player's own cover, else Steam art (only when the server allows it), else a generated tile. */
export function GameCover({ game, className = '' }: { game: Pick<GameView, 'name' | 'steamAppId' | 'coverAttachmentId'>; className?: string }) {
  const { url } = useAttachmentUrl(game.coverAttachmentId);
  const steamArt = useServerConfig((s) => s.steamArt);
  if (url) return <img className={`game-cover-img ${className}`} src={url} alt="" draggable={false} />;
  return <GameArt name={game.name} steamAppId={steamArt ? game.steamAppId : null} kind="capsule" className={className} />;
}
