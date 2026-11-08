import { describe, expect, it, vi } from 'vitest';
vi.mock('electron', () => ({ app: { isPackaged: true, getAppPath: () => 'C:/app' }, screen: {} }));
Object.assign(process, { resourcesPath: 'C:/app/resources' });
const { sanitizeStreamHint, hintPosition } = await import('../src/main/streamHints');
describe('stream hints', () => {
  it('only accepts bounded normalized markers and fixed reactions', () => {
    expect(sanitizeStreamHint({ sourceId: 'window:123:0', type: 'pointer', x: 0.5, y: 0.25 })).toMatchObject({ x: 0.5, y: 0.25 });
    for (const x of [NaN, Infinity, -0.1, 1.1, '0.5']) expect(sanitizeStreamHint({ sourceId: 'window:123:0', type: 'pointer', x, y: 0.5 })).toBeNull();
    expect(sanitizeStreamHint({ sourceId: 'window:1;calc:0', type: 'pointer', x: 0.5, y: 0.5 })).toBeNull();
    expect(sanitizeStreamHint({ sourceId: 'screen:0:0', type: 'reaction', reaction: '<script>' })).toBeNull();
    expect(sanitizeStreamHint({ sourceId: 'screen:0:0', type: 'reaction', reaction: 'f' })).toMatchObject({ reaction: 'f' });
  });
  it('maps normalized content to capture bounds, including monitors left of primary', () => {
    expect(hintPosition({ x: -1920, y: 0, width: 1920, height: 1080 }, 0.25, 0.5)).toEqual({ x: -1440, y: 540 });
  });
});
