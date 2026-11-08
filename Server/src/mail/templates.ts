/** 0.7.1 letters AIDis sends (plain text + a minimal HTML copy), in Russian and English. */
export type MailLang = 'ru' | 'en';

export interface MailTemplate {
  kind: 'verify' | 'reset' | 'email-change' | 'test';
  link?: string;
  username?: string;
}

export interface Letter {
  subject: string;
  text: string;
  html: string;
}

interface Copy {
  subject: string;
  lines: string[];
  button?: string;
  footer?: string;
}

function copy(template: MailTemplate, lang: MailLang): Copy {
  const hi = template.username ? (lang === 'ru' ? `Здравствуйте, ${template.username}!` : `Hello, ${template.username}!`) : lang === 'ru' ? 'Здравствуйте!' : 'Hello!';
  const ignore = lang === 'ru' ? 'Если это были не вы, просто проигнорируйте письмо.' : 'If it was not you, just ignore this letter.';
  switch (template.kind) {
    case 'verify':
      return lang === 'ru'
        ? { subject: 'AIDis: подтвердите почту', lines: [hi, 'Чтобы закончить регистрацию в AIDis, подтвердите почту. Ссылка действует 24 часа.'], button: 'Подтвердить почту', footer: ignore }
        : { subject: 'AIDis: confirm your e-mail', lines: [hi, 'To finish signing up for AIDis, confirm your e-mail. The link works for 24 hours.'], button: 'Confirm e-mail', footer: ignore };
    case 'email-change':
      return lang === 'ru'
        ? { subject: 'AIDis: подтвердите новую почту', lines: [hi, 'Этот адрес указали как новую почту аккаунта AIDis. Ссылка действует 24 часа.'], button: 'Подтвердить почту', footer: ignore }
        : { subject: 'AIDis: confirm your new e-mail', lines: [hi, 'This address was set as the new e-mail of an AIDis account. The link works for 24 hours.'], button: 'Confirm e-mail', footer: ignore };
    case 'reset':
      return lang === 'ru'
        ? { subject: 'AIDis: сброс пароля', lines: [hi, 'Кто-то попросил сбросить пароль вашего аккаунта AIDis. Ссылка действует 1 час и сработает один раз.'], button: 'Задать новый пароль', footer: ignore }
        : { subject: 'AIDis: password reset', lines: [hi, 'Someone asked to reset the password of your AIDis account. The link works once, for 1 hour.'], button: 'Set a new password', footer: ignore };
    case 'test':
      return lang === 'ru'
        ? { subject: 'AIDis: тестовое письмо', lines: ['Почта AIDis настроена: это письмо пришло через ваш SMTP-сервер.'] }
        : { subject: 'AIDis: test letter', lines: ['AIDis mail works: this letter came through your SMTP server.'] };
  }
}

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function renderLetter(template: MailTemplate, lang: MailLang): Letter {
  const c = copy(template, lang);
  const link = template.link;
  const text = [...c.lines, ...(link ? ['', link] : []), ...(c.footer ? ['', c.footer] : [])].join('\n');
  const paragraphs = c.lines.map((l) => `<p>${escapeHtml(l)}</p>`).join('');
  const button =
    link && c.button
      ? `<p><a href="${escapeHtml(link)}" style="display:inline-block;padding:10px 18px;background:#5865f2;color:#fff;border-radius:6px;text-decoration:none">${escapeHtml(c.button)}</a></p><p style="color:#666;font-size:12px">${escapeHtml(link)}</p>`
      : '';
  const footer = c.footer ? `<p style="color:#666;font-size:12px">${escapeHtml(c.footer)}</p>` : '';
  const html = `<!doctype html><html><body style="font-family:Segoe UI,Arial,sans-serif;font-size:15px;color:#222">${paragraphs}${button}${footer}</body></html>`;
  return { subject: c.subject, text, html };
}
