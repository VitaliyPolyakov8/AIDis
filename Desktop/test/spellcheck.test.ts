import { describe, expect, it, vi } from 'vitest';
import { configureSpellcheck } from '../src/main/spellcheck';

describe('Russian and English native spellcheck', () => {
  it('enables both dictionaries regardless of the UI language', () => {
    const session = { availableSpellCheckerLanguages: ['en-US', 'ru', 'de'], setSpellCheckerEnabled: vi.fn(), setSpellCheckerLanguages: vi.fn() };
    configureSpellcheck(session);
    expect(session.setSpellCheckerEnabled).toHaveBeenCalledWith(true);
    expect(session.setSpellCheckerLanguages).toHaveBeenCalledWith(['ru', 'en-US']);
  });

  it('does not ask Electron for an unsupported dictionary', () => {
    const session = { availableSpellCheckerLanguages: ['en-US'], setSpellCheckerEnabled: vi.fn(), setSpellCheckerLanguages: vi.fn() };
    configureSpellcheck(session);
    expect(session.setSpellCheckerLanguages).toHaveBeenCalledWith(['en-US']);
  });

  it('keeps the system checker when there are no configurable dictionaries', () => {
    const session = { availableSpellCheckerLanguages: [], setSpellCheckerEnabled: vi.fn(), setSpellCheckerLanguages: vi.fn() };
    configureSpellcheck(session);
    expect(session.setSpellCheckerEnabled).toHaveBeenCalledWith(true);
    expect(session.setSpellCheckerLanguages).not.toHaveBeenCalled();
  });
});
