import { describe, expect, it } from 'vitest';

const { compareVersions, generatePassword, platformLabelKey } = await import('./components/admin/adminUtils');
describe('0.5.8 admin helpers', () => {
  it('generates readable passwords and compares versions', () => {
    const a = generatePassword();
    expect(a).toHaveLength(14);
    expect(a).toMatch(/^[a-km-zA-HJ-NP-Z2-9]+$/);
    expect(generatePassword()).not.toBe(a);
    expect(compareVersions('0.5.6', '0.5.8')).toBe(-1);
    expect(compareVersions('0.5.10', '0.5.8')).toBe(1);
    expect(compareVersions('0.5.8', '0.5.8-qa')).toBe(0);
    expect(platformLabelKey('desktop')).toBe('adminPanel.platform.desktop');
    expect(platformLabelKey('toaster')).toBe('adminPanel.platform.web');
  });
});
