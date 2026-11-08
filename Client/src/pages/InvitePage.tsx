import { useEffect } from 'react';
import { Link, useParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { UserPlus } from 'lucide-react';
import { normalizeInviteInput } from '../api/invites';
import { CenterHeader } from '../components/CenterHeader';
import { InvitePreviewCard, useInvitePreview } from '../components/guilds/InvitePreviewCard';
import { homePath } from '../components/guilds/routes';
import { config } from '../config';

/** /invite/:code inside the app: the server's preview and the Join button. */
export function InvitePage() {
  const { t } = useTranslation();
  const { code: raw = '' } = useParams();
  const code = normalizeInviteInput(raw);
  const preview = useInvitePreview(code);

  useEffect(() => {
    document.title = `${t('guilds.page.title')} · ${config.appName}`;
  }, [t]);

  return (
    <div className="chat-view invite-page">
      <CenterHeader icon={<UserPlus size={19} />} title={t('guilds.page.title')} />
      <div className="invite-page-body">
        {code ? <InvitePreviewCard state={preview} /> : <div className="invite-card is-invalid">{t('guilds.card.invalid')}</div>}
        <Link className="btn btn-ghost" to={homePath()}>
          {t('guilds.page.home')}
        </Link>
      </div>
    </div>
  );
}
