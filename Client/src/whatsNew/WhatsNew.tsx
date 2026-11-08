import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Sparkles } from 'lucide-react';
import { Modal } from '../components/Modal';
import { config } from '../config';
import { formatDate } from '../utils/time';
import { CHANGELOG, changelogFor, localized, type ChangelogEntry } from './changelog';
import { readSeen, shouldShowWhatsNew, useWhatsNewStore } from './whatsNewStore';

/** Mounted once in the app shell: opens the notes after an update and renders the window. */
export function WhatsNewHost() {
  const open = useWhatsNewStore((s) => s.open);
  useEffect(() => {
    // Tests mount the shell many times; the window would only get in their way.
    if (import.meta.env.MODE === 'test') return;
    if (shouldShowWhatsNew(config.clientVersion, readSeen())) useWhatsNewStore.getState().show();
  }, []);
  return open ? <WhatsNewDialog onClose={() => useWhatsNewStore.getState().hide()} /> : null;
}

export function WhatsNewDialog({ onClose }: { onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const current = changelogFor(config.clientVersion) ?? CHANGELOG[0];
  const older = CHANGELOG.filter((entry) => entry !== current);
  return (
    <Modal
      title={t('whatsNew.title')}
      onClose={onClose}
      size="lg"
      className="whats-new"
      footer={
        <button type="button" className="btn btn-primary" data-autofocus onClick={onClose}>
          {t('whatsNew.close')}
        </button>
      }
    >
      {current && <Release entry={current} language={i18n.language} latest />}
      {older.length > 0 && (
        <details className="whats-new-older">
          <summary>{t('whatsNew.earlier')}</summary>
          {older.map((entry) => (
            <Release key={entry.version} entry={entry} language={i18n.language} />
          ))}
        </details>
      )}
    </Modal>
  );
}

function Release({ entry, language, latest = false }: { entry: ChangelogEntry; language: string | undefined; latest?: boolean }) {
  const { t } = useTranslation();
  return (
    <section className={`whats-new-release${latest ? ' is-latest' : ''}`} aria-label={t('whatsNew.version', { version: entry.version })}>
      <header className="whats-new-head">
        {latest && <Sparkles size={18} aria-hidden="true" className="whats-new-icon" />}
        <h3>{t('whatsNew.version', { version: entry.version })}</h3>
        <time dateTime={entry.date}>{formatDate(new Date(`${entry.date}T12:00:00`))}</time>
      </header>
      <p className="whats-new-summary">{localized(entry.summary, language)}</p>
      {entry.sections.map((section) => (
        <div key={section.title.en} className="whats-new-section">
          <h4>{localized(section.title, language)}</h4>
          <ul>
            {section.items.map((item) => (
              <li key={item.en}>{localized(item, language)}</li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}
