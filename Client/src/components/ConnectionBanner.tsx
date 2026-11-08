import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { WifiOff } from 'lucide-react';
import { useConnectionStore } from '../stores/connectionStore';

function useOnline(): boolean {
  const [online, setOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => {
      window.removeEventListener('online', up);
      window.removeEventListener('offline', down);
    };
  }, []);
  return online;
}

/** Subtle strip when realtime is down. Waits a moment so brief blips do not flash. */
export function ConnectionBanner() {
  const { t } = useTranslation();
  const socket = useConnectionStore((s) => s.socket);
  const online = useOnline();
  const problem = !online || socket === 'reconnecting';
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!problem) return;
    const timer = setTimeout(() => setVisible(true), 1500);
    return () => {
      clearTimeout(timer);
      setVisible(false);
    };
  }, [problem]);

  if (!visible || !problem) return null;
  return (
    <div className="connection-banner" role="status">
      {online ? <span className="spinner" aria-hidden="true" /> : <WifiOff size={14} aria-hidden="true" />}
      {online ? t('connection.reconnecting') : t('connection.offline')}
    </div>
  );
}
