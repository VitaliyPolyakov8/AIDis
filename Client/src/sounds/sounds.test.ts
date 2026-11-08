import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSettingsStore } from '../stores/settingsStore';

const instances: { src: string; play: ReturnType<typeof vi.fn>; pause: ReturnType<typeof vi.fn>; volume: number; currentTime: number }[] = [];

class FakeAudio {
  src: string;
  volume = 1;
  currentTime = 0;
  preload = '';
  play = vi.fn(() => Promise.reject(new DOMException('blocked', 'NotAllowedError')));
  pause = vi.fn();
  constructor(src: string) {
    this.src = src;
    instances.push(this);
  }
}

vi.stubGlobal('Audio', FakeAudio);
const { playSound } = await import('./sounds');

describe('interface sounds', () => {
  beforeEach(() => {
    useSettingsStore.setState({ interfaceSounds: true });
    for (const a of instances) {
      a.play.mockClear();
      a.pause.mockClear();
    }
  });

  it('plays a local sound at a reduced volume and ignores autoplay rejections', async () => {
    expect(() => playSound('join')).not.toThrow();
    const audio = instances.find((a) => a.src.includes('join'));
    expect(audio?.play).toHaveBeenCalledTimes(1);
    expect(audio?.volume).toBeLessThan(0.5);
    await Promise.resolve();
  });

  it('respects the Interface sounds setting', () => {
    useSettingsStore.setState({ interfaceSounds: false });
    playSound('leave');
    expect(instances.find((a) => a.src.includes('leave'))?.play ?? vi.fn()).not.toHaveBeenCalled();
    playSound('leave', { force: true });
    expect(instances.find((a) => a.src.includes('leave'))?.play).toHaveBeenCalledTimes(1);
  });

  it('does not stack: a new sound stops the previous one, and quick repeats are dropped', () => {
    playSound('mute');
    playSound('unmute');
    const mute = instances.find((a) => a.src.includes('/mute') || a.src.endsWith('mute.wav'));
    expect(mute?.pause).toHaveBeenCalled();
    const unmute = instances.find((a) => a.src.includes('unmute'));
    playSound('unmute');
    expect(unmute?.play).toHaveBeenCalledTimes(1);
  });
});
