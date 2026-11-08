import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MonitorUp } from 'lucide-react';
import { useLocalGame } from '../../desktop/localGame';
import { requestGameStream } from '../../desktop/screenCapture';
import { GameArt, gameStyle, useGameTheme } from '../profile/GameArt';

/**
 * 0.4.1: "Stream <game>" in the voice dock, shown only while a game is detected on this PC AND we
 * are connected to voice (the dock itself only exists in a call). Opens the normal picker with
 * the game window preselected; streaming starts only after "Share" there.
 */
export function StreamGameSuggestion() {
  const game = useLocalGame((s) => s.info);
  if (!game) return null;
  return <Suggestion name={game.name} steamAppId={game.steamAppId} icon={game.icon} />;
}

function Suggestion({ name, steamAppId, icon }: { name: string; steamAppId: number | null; icon: string | null }) {
  const { t } = useTranslation();
  const theme = useGameTheme(name, steamAppId);
  const [busy, setBusy] = useState(false);
  const label = t('voice.streamGame', { game: name });
  return (
    <button
      type="button"
      className="dock-game"
      style={gameStyle(theme)}
      title={label}
      aria-label={label}
      disabled={busy}
      onClick={() => {
        setBusy(true);
        void requestGameStream().finally(() => setBusy(false));
      }}
    >
      <GameArt name={name} steamAppId={steamAppId} icon={icon} kind="icon" />
      <span className="dock-game-text">
        <span className="dock-game-name">{name}</span>
        <span className="dock-game-hint">{t('voice.streamGameHint')}</span>
      </span>
      <MonitorUp size={16} className="dock-game-icon" aria-hidden="true" />
    </button>
  );
}
