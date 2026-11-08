import { afterEach, describe, expect, it } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describeQuality, lossBetween, parseStatsReport } from './connectionStats';
import { INITIAL_VOICE_STATE, useVoiceStore } from './voiceStore';
import { SignalBars } from '../components/SignalBars';
import { i18next } from '../i18n';

type Stat = Record<string, unknown> & { type: string; id: string };
/**
 * Behaves like a real RTCStatsReport: map-like (values/forEach/get) but NOT a Map instance, and
 * iterating it yields [id, stat] pairs. Tests used a real Map before, which hid the bug that left
 * RTT, loss and transport empty in Electron.
 */
class FakeRTCStatsReport {
  private readonly map: Map<string, Stat>;
  constructor(stats: Stat[]) {
    this.map = new Map(stats.map((s) => [s.id, s]));
  }
  get size() {
    return this.map.size;
  }
  get(id: string) {
    return this.map.get(id);
  }
  values() {
    return this.map.values();
  }
  forEach(cb: (value: Stat, key: string) => void) {
    this.map.forEach(cb);
  }
  [Symbol.iterator]() {
    return this.map.entries();
  }
}
const report = (...stats: Stat[]) => new FakeRTCStatsReport(stats);

/** Shape of a Chromium RTCRtpSender.getStats() report for an audio sender. */
const chromiumSender = (candidateType = 'srflx', protocol = 'udp') =>
  report(
    { type: 'transport', id: 'T1', selectedCandidatePairId: 'CP1' },
    { type: 'candidate-pair', id: 'CP1', localCandidateId: 'L1', remoteCandidateId: 'R1', currentRoundTripTime: 0.034, nominated: true, state: 'succeeded' },
    { type: 'local-candidate', id: 'L1', candidateType, protocol, relayProtocol: candidateType === 'relay' ? 'tcp' : undefined },
    { type: 'outbound-rtp', id: 'O1', kind: 'audio', packetsSent: 1000 },
    { type: 'remote-inbound-rtp', id: 'RI1', kind: 'audio', packetsLost: 2, roundTripTime: 0.05 },
  );

afterEach(() => {
  useVoiceStore.setState(INITIAL_VOICE_STATE);
  void i18next.changeLanguage('en');
});

describe('parseStatsReport', () => {
  it('reads RTT from the selected ICE candidate pair and the transport protocol', () => {
    const parsed = parseStatsReport(chromiumSender());
    expect(parsed.rttMs).toBe(34); // 0.034 s -> 34 ms
    expect(parsed.rttSource).toBe('candidate-pair');
    expect(parsed.pairFound).toBe(true);
    expect(parsed.transport).toBe('UDP');
    expect(parsed.counters).toEqual({ lost: 2, total: 1000 });
  });

  it('detects TURN relays and TCP', () => {
    expect(parseStatsReport(chromiumSender('relay')).transport).toBe('TURN');
    expect(parseStatsReport(chromiumSender('relay')).relayProtocol).toBe('TCP');
    expect(parseStatsReport(chromiumSender('host', 'tcp')).transport).toBe('TCP');
  });

  it('falls back to RTCP RTT and inbound audio counters (receiver side)', () => {
    const parsed = parseStatsReport(
      report(
        { type: 'remote-inbound-rtp', id: 'x', kind: 'video', roundTripTime: 1 },
        { type: 'inbound-rtp', id: 'I1', kind: 'audio', packetsLost: 5, packetsReceived: 995 },
      ),
    );
    expect(parsed.rttMs).toBeNull();
    expect(parsed.transport).toBeNull();
    expect(parsed.counters).toEqual({ lost: 5, total: 1000 });
  });

  it('returns nulls for an empty report instead of throwing', () => {
    expect(parseStatsReport(report())).toEqual({ rttMs: null, rttSource: null, pairFound: false, transport: null, relayProtocol: null, counters: null });
    expect(parseStatsReport(undefined).rttMs).toBeNull();
  });

  it('is not fooled by the report not being a Map (real RTCStatsReport iteration yields pairs)', () => {
    const r = report({ type: 'candidate-pair', id: 'CP', nominated: true, state: 'succeeded', currentRoundTripTime: 0.121, localCandidateId: 'L' }, { type: 'local-candidate', id: 'L', candidateType: 'host', protocol: 'udp' });
    expect(r instanceof Map).toBe(false);
    expect([...r][0]).toHaveLength(2);
    expect(parseStatsReport(r)).toMatchObject({ rttMs: 121, transport: 'UDP' });
  });

  it('uses RTCP RTT, then the averaged pair RTT, when no current RTT exists yet', () => {
    const rtcp = parseStatsReport(
      report(
        { type: 'candidate-pair', id: 'CP', nominated: true, state: 'succeeded' },
        { type: 'remote-inbound-rtp', id: 'RI', kind: 'audio', roundTripTime: 0.048, packetsLost: 0 },
        { type: 'outbound-rtp', id: 'O', kind: 'audio', packetsSent: 10 },
      ),
    );
    expect(rtcp).toMatchObject({ rttMs: 48, rttSource: 'remote-inbound-rtp' });
    const average = parseStatsReport(report({ type: 'candidate-pair', id: 'CP', nominated: true, state: 'succeeded', totalRoundTripTime: 0.3, responsesReceived: 10 }));
    expect(average).toMatchObject({ rttMs: 30, rttSource: 'candidate-pair-average' });
    const none = parseStatsReport(report({ type: 'candidate-pair', id: 'CP', nominated: true, state: 'succeeded', totalRoundTripTime: 0, responsesReceived: 0 }));
    expect(none.rttMs).toBeNull();
  });
});

describe('loss and quality', () => {
  it('computes loss over the last interval only', () => {
    expect(lossBetween({ lost: 10, total: 1000 }, { lost: 11, total: 1500 })).toBeCloseTo(0.2);
    expect(lossBetween(null, { lost: 1, total: 10 })).toBeNull();
    expect(lossBetween({ lost: 1, total: 10 }, { lost: 1, total: 10 })).toBeNull();
  });

  it('keeps LiveKit levels and only refines good -> fair on measured degradation', () => {
    expect(describeQuality('excellent', { rttMs: 300, lossPercent: 5, transport: null, relayProtocol: null })).toBe('excellent');
    expect(describeQuality('good', { rttMs: 40, lossPercent: 0.1, transport: null, relayProtocol: null })).toBe('good');
    expect(describeQuality('good', { rttMs: 180, lossPercent: 0, transport: null, relayProtocol: null })).toBe('fair');
    expect(describeQuality('poor', null)).toBe('poor');
  });
});

describe('connection tooltip on the signal bars', () => {
  it('shows real stats on hover, localized', async () => {
    useVoiceStore.setState({
      status: 'connected',
      quality: 'excellent',
      stats: { rttMs: 34, lossPercent: 0.2, transport: 'UDP', relayProtocol: null },
    });
    render(<SignalBars quality="excellent" status="connected" />);
    await userEvent.hover(screen.getByRole('button', { name: 'Connection details' }));
    const tip = screen.getByRole('tooltip');
    expect(tip).toHaveTextContent('Connection quality');
    expect(tip).toHaveTextContent('Excellent');
    expect(tip).toHaveTextContent('34 ms');
    expect(tip).toHaveTextContent('0.2%');
    expect(tip).toHaveTextContent('UDP');

    await act(() => i18next.changeLanguage('ru'));
    expect(screen.getByRole('tooltip')).toHaveTextContent('Качество соединения');
    expect(screen.getByRole('tooltip')).toHaveTextContent('34 мс');
    expect(screen.getByRole('tooltip')).toHaveTextContent('0,2%');

    await userEvent.unhover(screen.getByRole('button'));
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it('shows the reconnecting state and hides transport when unknown', async () => {
    useVoiceStore.setState({ status: 'reconnecting', quality: 'good', stats: null });
    render(<SignalBars quality="good" status="reconnecting" />);
    await userEvent.hover(screen.getByRole('button'));
    expect(screen.getByRole('tooltip')).toHaveTextContent('Reconnecting to voice server…');
  });

  it('shows "measuring" while stats are not available yet', async () => {
    useVoiceStore.setState({ status: 'connected', quality: 'unknown', stats: null });
    render(<SignalBars quality="unknown" status="connected" />);
    await userEvent.hover(screen.getByRole('button'));
    expect(screen.getByRole('tooltip')).toHaveTextContent('Calculating…');
    expect(screen.getByRole('tooltip')).not.toHaveTextContent('Transport');
  });

  it('is a plain indicator when not in a call', () => {
    render(<SignalBars quality="unknown" status="idle" />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
