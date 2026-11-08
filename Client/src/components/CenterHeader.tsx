import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Menu, Users } from 'lucide-react';
import { useUiStore } from '../stores/uiStore';

interface CenterHeaderProps {
  icon: ReactNode;
  title: string;
  description?: string | null;
  children?: ReactNode;
}

export function CenterHeader({ icon, title, description, children }: CenterHeaderProps) {
  const { t } = useTranslation();
  const setChannelDrawer = useUiStore((s) => s.setChannelDrawer);
  const setMembersDrawer = useUiStore((s) => s.setMembersDrawer);
  const toggleMembers = useUiStore((s) => s.toggleMembers);
  const membersOpen = useUiStore((s) => s.membersOpen);
  return (
    <header className="center-header">
      <button type="button" className="icon-btn only-mobile" aria-label={t('header.openChannels')} onClick={() => setChannelDrawer(true)}>
        <Menu size={20} />
      </button>
      <span className="center-header-icon" aria-hidden="true">
        {icon}
      </span>
      <h1 className="center-header-title">{title}</h1>
      {description && <span className="center-header-desc">{description}</span>}
      <div className="center-header-actions">
        {children}
        <button
          type="button"
          className="icon-btn only-desktop"
          aria-label={membersOpen ? t('header.hideMembers') : t('header.showMembers')}
          aria-pressed={membersOpen}
          title={t('header.memberList')}
          onClick={toggleMembers}
        >
          <Users size={18} />
        </button>
        <button type="button" className="icon-btn only-narrow" aria-label={t('header.showMembers')} onClick={() => setMembersDrawer(true)}>
          <Users size={18} />
        </button>
      </div>
    </header>
  );
}
