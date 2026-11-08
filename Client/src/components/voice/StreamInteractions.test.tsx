import { createRef } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StreamInteractions } from './StreamInteractions';
import { streamInteractions, useStreamInteractions } from '../../voice/streamInteractions';

describe('transient stream controls', () => {
  beforeEach(() => useStreamInteractions.setState({ streams: { bob: { sid: 'track-bob', generation: 'g1', pointers: false, seq: 1 } }, pointers: [], reactions: [] }));
  function mount(local = false) {
    const video = document.createElement('video');
    Object.defineProperties(video, { videoWidth: { value: 1920 }, videoHeight: { value: 1080 } });
    video.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 400 } as DOMRect);
    const videoRef = createRef<HTMLVideoElement>(); videoRef.current = video;
    return render(<StreamInteractions owner="bob" local={local} videoRef={videoRef} ready />);
  }
  it('requires owner consent before offering the viewer pointer control', () => {
    mount(); expect(screen.queryByRole('button', { name: 'Point here' })).toBeNull();
    act(() => useStreamInteractions.setState({ streams: { bob: { sid: 'track-bob', generation: 'g1', pointers: true, seq: 2 } } }));
    expect(screen.getByRole('button', { name: 'Point here' })).toHaveAttribute('aria-pressed', 'false');
  });
  it('sends a click within video content and disarms when the source generation changes', () => {
    useStreamInteractions.setState({ streams: { bob: { sid: 'track-bob', generation: 'g1', pointers: true, seq: 2 } } });
    const point = vi.spyOn(streamInteractions, 'point').mockReturnValue(true);
    const { container } = mount();
    fireEvent.click(screen.getByRole('button', { name: 'Point here' }));
    const target = container.querySelector('.stream-pointer-target')!;
    expect(target).toHaveStyle({ top: '87.5px', height: '225px' });
    fireEvent.click(target, { clientX: 100, clientY: 200, detail: 1 });
    expect(point).toHaveBeenCalledWith('bob', { x: 0.25, y: 0.5 });
    fireEvent.click(target, { detail: 0 });
    expect(point).toHaveBeenLastCalledWith('bob', { x: 0.5, y: 0.5 });
    fireEvent.keyDown(target, { key: 'Escape' });
    expect(container.querySelector('.stream-pointer-target')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Point here' }));
    act(() => useStreamInteractions.setState({ streams: { bob: { sid: 'track-bob', generation: 'g2', pointers: true, seq: 3 } } }));
    expect(container.querySelector('.stream-pointer-target')).toBeNull();
  });
  it('supports keyboard pointer placement, enumerated reactions and owner opt-in', () => {
    const consent = vi.spyOn(streamInteractions, 'setPointers').mockReturnValue(true);
    const react = vi.spyOn(streamInteractions, 'react').mockReturnValue(true);
    mount(true);
    expect(screen.getByRole('button', { name: 'Allow viewer pointers' })).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(screen.getByRole('button', { name: 'Allow viewer pointers' }));
    expect(consent).toHaveBeenCalledWith(true);
    fireEvent.click(screen.getByRole('button', { name: 'Laugh' }));
    fireEvent.click(screen.getByRole('button', { name: 'Applaud' }));
    fireEvent.click(screen.getByRole('button', { name: 'Pay respects' }));
    expect(react.mock.calls).toEqual([['bob', 'laugh'], ['bob', 'clap'], ['bob', 'f']]);
  });
  it('renders markers in the actual video rectangle and escapes sender text', () => {
    useStreamInteractions.setState({ pointers: [{ type: 'pointer', id: 'p', at: Date.now(), expiresAt: Date.now() + 2000, owner: 'bob', sender: '<img src=x>', x: 0.5, y: 1 }] });
    const { container } = mount(true);
    expect(container.querySelector('.stream-pointer-marker')).toHaveStyle({ left: '200px', top: '312.5px' });
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText('<img src=x>')).toBeInTheDocument();
  });
});
