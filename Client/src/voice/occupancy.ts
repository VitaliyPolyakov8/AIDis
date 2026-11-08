import { voiceApi } from '../api/voice';
import { isApiError } from '../api/errors';
import type { VoiceParticipantView } from '../api/types';
import { useChatStore } from '../stores/chatStore';
import { mergePolledOccupancy, useVoiceStore } from './voiceStore';

/**
 * Who is in voice channels we are NOT connected to. The server has no realtime event for voice
 * membership, so GET /voice/channels/:id/participants (which asks LiveKit) is polled. The channel
 * we are in is written live by the voice service from LiveKit room events and is never
 * overwritten by a poll (see mergePolledOccupancy).
 */
const INTERVAL_MS = 15_000;

let timer: ReturnType<typeof setTimeout> | null = null;
let running = false;
let controller: AbortController | null = null;

async function poll(): Promise<void> {
  // 0.4.1 servers push occupancy over the socket (voice.sessions / voice.session): no polling.
  if (useVoiceStore.getState().occupancyRealtime) return;
  const voiceChannels = useChatStore.getState().channels.filter((c) => c.type === 'VOICE');
  controller = new AbortController();
  const signal = controller.signal;
  const startedAt = Date.now();
  const results = await Promise.allSettled(voiceChannels.map((c) => voiceApi.participants(c.id, signal)));
  if (!running) return;
  const polled: Record<string, VoiceParticipantView[]> = {};
  let unavailable = false;
  results.forEach((result, i) => {
    const channel = voiceChannels[i];
    if (!channel) return;
    if (result.status === 'fulfilled') {
      polled[channel.id] = result.value.participants;
    } else if (isApiError(result.reason) && result.reason.code === 'VOICE_NOT_CONFIGURED') {
      unavailable = true;
    }
  });
  const state = useVoiceStore.getState();
  useVoiceStore.setState({ occupancy: mergePolledOccupancy(state, polled, startedAt), occupancyAvailable: !unavailable });
}

function schedule(delay: number): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    void poll()
      .catch(() => undefined)
      .finally(() => {
        if (!running) return;
        // Voice disabled on the server, or the server pushes occupancy itself: check rarely.
        const { occupancyAvailable, occupancyRealtime } = useVoiceStore.getState();
        if (!occupancyAvailable || occupancyRealtime) schedule(5 * 60_000);
        else schedule(document.hidden ? INTERVAL_MS * 4 : INTERVAL_MS);
      });
  }, delay);
}

function onVisible(): void {
  if (running && !document.hidden) schedule(0);
}

export function startOccupancyPolling(): void {
  if (running) return;
  running = true;
  document.addEventListener('visibilitychange', onVisible);
  schedule(0);
}

export function stopOccupancyPolling(): void {
  running = false;
  if (timer) clearTimeout(timer);
  timer = null;
  controller?.abort();
  controller = null;
  document.removeEventListener('visibilitychange', onVisible);
}
