import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import { Globe, Monitor, Smartphone } from 'lucide-react';
import { usePresenceStore } from '../../stores/presenceStore';
import type { ClientPlatform } from '../../api/types';

const ICONS: Record<ClientPlatform, typeof Monitor> = { desktop: Monitor, web: Globe, android: Smartphone, ios: Smartphone };

/**
 * 0.5.1: small icons for the kinds of clients a user is connected with RIGHT NOW (desktop app,
 * web, Android), one per active kind, from realtime presence (the clients identify themselves to
 * the server). Offline users show none. Tooltip + accessible label, no text in the list.
 */
export const PlatformIcons = memo(function PlatformIcons({ userId, size = 12 }: { userId: string; size?: number }) {
  const { t } = useTranslation();
  const platforms = usePresenceStore((s) => s.presence[userId]?.platforms);
  if (!platforms || platforms.length === 0) return null;
  return (
    <span className="platform-icons">
      {platforms.map((p) => {
        const Icon = ICONS[p];
        const label = t(`platform.${p}`);
        return (
          <span key={p} className={`platform-icon is-${p}`} title={label} role="img" aria-label={t('platform.via', { platform: label })}>
            <Icon size={size} aria-hidden="true" />
          </span>
        );
      })}
    </span>
  );
});
