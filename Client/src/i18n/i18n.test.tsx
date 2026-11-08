import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { en } from './en';
import { ru } from './ru';
import { detectLanguage, i18next, setLanguage } from './index';
import { LoginPage } from '../pages/LoginPage';
import { useAuthStore } from '../stores/authStore';
import { formatLastSeen, formatMessageTimestamp } from '../utils/time';

type Tree = { [key: string]: string | Tree };

/** Leaf keys with plural suffixes folded together (Russian has _few/_many that English lacks). */
function keys(tree: Tree, prefix = ''): Set<string> {
  const out = new Set<string>();
  for (const [k, v] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'string') out.add(path.replace(/_(one|few|many|other)$/, ''));
    else for (const nested of keys(v, path)) out.add(nested);
  }
  return out;
}

afterEach(() => {
  void i18next.changeLanguage('en');
  vi.unstubAllGlobals();
});

describe('dictionaries', () => {
  it('Russian and English have the same keys', () => {
    const enKeys = keys(en as unknown as Tree);
    const ruKeys = keys(ru as unknown as Tree);
    expect([...enKeys].filter((k) => !ruKeys.has(k))).toEqual([]);
    expect([...ruKeys].filter((k) => !enKeys.has(k))).toEqual([]);
  });

  it('Russian plurals use all forms', () => {
    void i18next.changeLanguage('ru');
    const now = new Date(2026, 9, 5, 15, 0);
    const ago = (min: number) => new Date(now.getTime() - min * 60_000).toISOString();
    expect(formatLastSeen(ago(1), now)).toBe('Был(а) 1 минуту назад');
    expect(formatLastSeen(ago(3), now)).toBe('Был(а) 3 минуты назад');
    expect(formatLastSeen(ago(5), now)).toBe('Был(а) 5 минут назад');
    expect(formatMessageTimestamp(new Date(2026, 9, 5, 13, 42).toISOString(), now)).toBe('Сегодня в 13:42');
  });
});

describe('language selection', () => {
  it('uses the saved preference first', () => {
    localStorage.setItem('aidis.language', 'ru');
    vi.stubGlobal('navigator', { languages: ['en-US'], language: 'en-US' });
    expect(detectLanguage()).toBe('ru');
  });

  it('falls back to the browser language: Russian -> ru, anything else -> en', () => {
    vi.stubGlobal('navigator', { languages: ['ru-RU'], language: 'ru-RU' });
    expect(detectLanguage()).toBe('ru');
    vi.stubGlobal('navigator', { languages: ['de-DE'], language: 'de-DE' });
    expect(detectLanguage()).toBe('en');
  });

  it('persists the choice locally', () => {
    setLanguage('ru');
    expect(localStorage.getItem('aidis.language')).toBe('ru');
    expect(document.documentElement.lang).toBe('ru');
    expect(detectLanguage()).toBe('ru');
  });

  it('switches the visible UI between English and Russian', async () => {
    useAuthStore.setState({ status: 'unauthenticated', notice: null });
    render(
      <MemoryRouter>
        <LoginPage />
      </MemoryRouter>,
    );
    expect(screen.getByRole('button', { name: 'Log in' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('radio', { name: 'RU' }));
    expect(await screen.findByRole('button', { name: 'Войти' })).toBeInTheDocument();
    expect(screen.getByLabelText('Имя пользователя')).toBeInTheDocument();
    act(() => setLanguage('en'));
    expect(await screen.findByRole('button', { name: 'Log in' })).toBeInTheDocument();
  });
});
