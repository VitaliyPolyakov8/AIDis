import { requestBlob } from '../api/client';
import type { SoundView } from '../api/types';
import { useSettingsStore } from '../stores/settingsStore';

type SinkAudio = HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };

/**
 * 0.7.1 plays soundboard sounds locally (each listener plays the file; nothing goes through the
 * microphone). Files are fetched once and kept as object URLs; volume = the sound's own volume ×
 * my soundboard volume; the chosen output device is used where the browser allows it.
 */
class SoundPlayer {
  private readonly urls = new Map<string, Promise<string>>();

  private url(id: string): Promise<string> {
    let url = this.urls.get(id);
    if (!url) {
      url = requestBlob(`/api/v1/sounds/${id}/content`).then((blob) => URL.createObjectURL(blob));
      url.catch(() => this.urls.delete(id));
      this.urls.set(id, url);
    }
    return url;
  }

  /** Mute / deafen are checked by the caller (a preview plays even then). */
  async play(sound: SoundView): Promise<void> {
    const settings = useSettingsStore.getState();
    const audio: SinkAudio = new Audio(await this.url(sound.id));
    audio.volume = Math.max(0, Math.min(1, (sound.volume / 100) * (settings.soundboardVolume / 100)));
    if (settings.outputDeviceId && settings.outputDeviceId !== 'default' && typeof audio.setSinkId === 'function') {
      await audio.setSinkId(settings.outputDeviceId).catch(() => undefined);
    }
    await audio.play();
  }

  /** A sound was deleted or re-uploaded: drop its cached file. */
  forget(id: string): void {
    const url = this.urls.get(id);
    this.urls.delete(id);
    void url?.then(
      (u) => URL.revokeObjectURL(u),
      () => undefined,
    );
  }
}

export const soundPlayer = new SoundPlayer();
