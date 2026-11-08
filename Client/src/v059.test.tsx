import { describe, expect, it, vi } from 'vitest';

const { voice } = await import('./voice/voiceService');

describe('0.5.9 voice moves', () => {
  it('rejoins at once when the server says LiveKit did not move the connection', async () => {
    const join = vi.spyOn(voice, 'join').mockResolvedValue(undefined);
    const started = Date.now();
    await voice.followMove('channel-2', true);
    expect(join).toHaveBeenCalledWith('channel-2');
    expect(Date.now() - started).toBeLessThan(500);
    join.mockRestore();
  });
});
