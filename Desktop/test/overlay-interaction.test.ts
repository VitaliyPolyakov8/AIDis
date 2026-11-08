import { describe, expect, it, vi } from 'vitest';
vi.mock('electron', () => ({
  app: { isPackaged: true, getAppPath: () => 'C:/app' },
  screen: { on: vi.fn(), off: vi.fn() },
}));
Object.assign(process, { resourcesPath: 'C:/app/resources' });
const { OverlayService } = await import('../src/main/overlay');
const { DEFAULT_OVERLAY } = await import('../../Client/src/desktop/contract');

describe('shared overlay interaction lifecycle', () => {
  it('synchronizes video click-through on hotkey, Done, preview and disabling overlays', () => {
    const change = vi.fn<(on: boolean) => void>();
    const service = new OverlayService({ savePosition: vi.fn(), onAction: vi.fn(), onReply: vi.fn(), onInteractiveChange: change });
    // Native window boundary; exercise the real overlay state and action handlers.
    const boundary = service as unknown as { ensureWindow(): unknown; applyLayout(): void; sendConfig(): void; updateVisibility(): void };
    vi.spyOn(boundary, 'ensureWindow').mockReturnValue({ setIgnoreMouseEvents: vi.fn(), setFocusable: vi.fn() });
    vi.spyOn(boundary, 'applyLayout').mockImplementation(() => undefined);
    vi.spyOn(boundary, 'sendConfig').mockImplementation(() => undefined);
    vi.spyOn(boundary, 'updateVisibility').mockImplementation(() => undefined);
    service.configure({ ...DEFAULT_OVERLAY, enabled: true }, 'en');
    service.toggleInteractive();
    service.handleFromOverlay('done');
    service.toggleInteractive();
    service.handleFromOverlay('done');
    service.preview();
    service.configure({ ...DEFAULT_OVERLAY, enabled: false }, 'en');
    expect(change.mock.calls.map(([on]) => on)).toEqual([true, false, true, false, true, false]);
    service.dispose();
  });
});
