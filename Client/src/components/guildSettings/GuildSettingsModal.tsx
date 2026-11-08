import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Ban, Info, Link2, ScrollText, Shield, Smile, Users, AudioLines } from 'lucide-react';
import { Modal } from '../Modal';
import { EmojiSettings } from '../../emojis/EmojiSettings';
import { SoundsSection } from './Sounds';
import { closeGuildDialog } from '../guilds/guildDialogs';
import { useGuildContext, type GuildContext } from './context';
import { OverviewSection } from './Overview';
import { RolesSection } from './Roles';
import { MembersSection } from './Members';
import { AuditSection, BansSection, InvitesSection } from './Lists';

export type GuildSettingsSection = 'overview' | 'roles' | 'members' | 'bans' | 'invites' | 'emojis' | 'sounds' | 'audit';

const SECTIONS: { id: GuildSettingsSection; icon: typeof Info; visible: (ctx: GuildContext) => boolean }[] = [
  { id: 'overview', icon: Info, visible: (c) => c.has('MANAGE_GUILD') || c.owner || c.superadmin },
  { id: 'roles', icon: Shield, visible: (c) => c.has('MANAGE_ROLES') },
  { id: 'members', icon: Users, visible: () => true },
  { id: 'bans', icon: Ban, visible: (c) => c.has('BAN_MEMBERS') },
  { id: 'invites', icon: Link2, visible: (c) => c.has('CREATE_INVITE') || c.has('MANAGE_GUILD') },
  { id: 'emojis', icon: Smile, visible: () => true },
  { id: 'sounds', icon: AudioLines, visible: () => true },
  { id: 'audit', icon: ScrollText, visible: (c) => c.has('VIEW_AUDIT_LOG') },
];

/** 0.7.0: one server's settings; each section shows only with its permission (the server checks again). */
export function GuildSettingsModal({ guildId, initial }: { guildId: string; initial?: string }) {
  const { t } = useTranslation();
  const ctx = useGuildContext(guildId);
  const [requested, setRequested] = useState<string | undefined>(initial);
  if (!ctx) return null;
  const sections = SECTIONS.filter((s) => s.visible(ctx));
  const section = sections.find((s) => s.id === requested)?.id ?? sections[0]?.id ?? 'members';

  return (
    <Modal title={t('gs.title')} onClose={closeGuildDialog} size="lg" className="settings-modal guild-settings" hideTitle>
      <div className="settings-layout">
        <nav className="settings-nav" aria-label={t('gs.title')}>
          <div className="settings-nav-title" title={ctx.guild.name}>
            {ctx.guild.name}
          </div>
          <div role="tablist" aria-orientation="vertical" className="settings-tabs">
            {sections.map(({ id, icon: Icon }) => (
              <button
                key={id}
                type="button"
                role="tab"
                id={`gs-tab-${id}`}
                aria-selected={section === id}
                aria-controls="gs-panel"
                className={`settings-tab${section === id ? ' is-active' : ''}`}
                onClick={() => setRequested(id)}
              >
                <Icon size={16} aria-hidden="true" />
                {t(`gs.sections.${id}`)}
              </button>
            ))}
          </div>
        </nav>
        <section id="gs-panel" role="tabpanel" aria-labelledby={`gs-tab-${section}`} className="settings-panel">
          <h3 className="settings-panel-title">{t(`gs.sections.${section}`)}</h3>
          {section === 'overview' && <OverviewSection ctx={ctx} />}
          {section === 'roles' && <RolesSection ctx={ctx} />}
          {section === 'members' && <MembersSection ctx={ctx} />}
          {section === 'bans' && <BansSection ctx={ctx} />}
          {section === 'invites' && <InvitesSection ctx={ctx} />}
          {section === 'emojis' && <EmojiSettings guildId={guildId} />}
          {section === 'sounds' && <SoundsSection guildId={guildId} />}
          {section === 'audit' && <AuditSection ctx={ctx} />}
        </section>
      </div>
    </Modal>
  );
}
