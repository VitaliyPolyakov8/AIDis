import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Info, Megaphone, X } from 'lucide-react';
import { adminApi } from '../api/admin';
import { useAnnouncementStore } from '../stores/announcementStore';

/** 0.5.8: the admin's announcement at the top of the app (closable; a new text shows again). */
export function AnnouncementBanner() {
  const { t } = useTranslation();
  const announcement = useAnnouncementStore((s) => s.announcement);
  const dismissedId = useAnnouncementStore((s) => s.dismissedId);
  useEffect(() => {
    // Realtime keeps it current afterwards; an older server without the route just has none.
    adminApi.announcement().then(
      ({ announcement: value }) => useAnnouncementStore.getState().set(value),
      () => undefined,
    );
  }, []);
  if (!announcement || announcement.id === dismissedId) return null;
  const Icon = announcement.level === 'warning' ? Megaphone : Info;
  return (
    <div className={`announcement-banner is-${announcement.level}`} role="status">
      <Icon size={16} aria-hidden="true" />
      <span className="announcement-text">{announcement.text}</span>
      <button type="button" className="icon-btn icon-btn-xs" aria-label={t('common.close')} onClick={() => useAnnouncementStore.getState().dismiss()}>
        <X size={14} />
      </button>
    </div>
  );
}
