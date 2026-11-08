import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('../../api/voice', () => ({
  voiceApi: { disconnectParticipant: vi.fn(() => Promise.resolve()) },
}));

const { ParticipantMenuHost } = await import('./ParticipantMenu');
const { ModerationDialogHost } = await import('./ModerationDialogs');
const { setGuildPermissions } = await import('../../test/fixtures');
const { openParticipantMenu, useParticipantMenu } = await import('./participantMenuState');
const { voiceApi } = await import('../../api/voice');
const { useVoiceStore, INITIAL_VOICE_STATE } = await import('../../voice/voiceStore');
const { useAuthStore } = await import('../../stores/authStore');
const { useSettingsStore } = await import('../../stores/settingsStore');

const person = (identity: string, isLocal = false) => ({
  identity,
  name: identity,
  isLocal,
  isSpeaking: false,
  micMuted: false,
  screenSharing: false,
});

function Row({ id }: { id: string }) {
  return <div onContextMenu={(e) => openParticipantMenu(e, id, id === 'bob' ? 'Bob' : id)}>{`row-${id}`}</div>;
}

async function setup(role: 'ADMIN' | 'USER') {
  useAuthStore.setState({ user: { id: 'me', username: 'me', displayName: 'Me', avatarAttachmentId: null, role, lastSeenAt: null } });
  // 0.4.0: moderation follows permissions (admins have all of them).
  await setGuildPermissions(role === 'ADMIN' ? ['VIEW_CHANNEL', 'SEND_MESSAGES', 'CONNECT_VOICE', 'MOVE_USERS', 'DISCONNECT_USERS'] : ['VIEW_CHANNEL', 'SEND_MESSAGES', 'CONNECT_VOICE']);
  render(
    <>
      <Row id="bob" />
      <Row id="me" />
      <Row id="stranger" />
      <ParticipantMenuHost />
      <ModerationDialogHost />
    </>,
  );
}

describe('voice participant context menu', () => {
  beforeEach(() => {
    vi.mocked(voiceApi.disconnectParticipant).mockClear();
    useParticipantMenu.setState({ target: null, confirm: null });
    useSettingsStore.setState({ userVolumes: {}, userMutes: {} });
    useVoiceStore.setState({ ...INITIAL_VOICE_STATE, status: 'connected', channelId: 'vc1', participants: [person('me', true), person('bob')] });
  });

  it('offers local volume and mute for another participant, without admin actions for users', async () => {
    await setup('USER');
    fireEvent.contextMenu(screen.getByText('row-bob'), { clientX: 50, clientY: 60 });
    const menu = screen.getByRole('menu', { name: 'Bob' });
    expect(menu).toHaveTextContent('User volume');
    expect(screen.queryByText('Disconnect from voice')).toBeNull();

    fireEvent.change(screen.getByLabelText(/User volume/), { target: { value: '50' } });
    expect(useSettingsStore.getState().userVolumes).toEqual({ bob: 50 });
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: /Mute/ }));
    expect(useSettingsStore.getState().userMutes).toEqual({ bob: true });
    expect(useSettingsStore.getState().userVolumes).toEqual({ bob: 50 });
  });

  it('opens nothing for yourself or for people outside your call, and closes on Escape', async () => {
    await setup('ADMIN');
    fireEvent.contextMenu(screen.getByText('row-me'));
    fireEvent.contextMenu(screen.getByText('row-stranger'));
    expect(screen.queryByRole('menu')).toBeNull();
    fireEvent.contextMenu(screen.getByText('row-bob'));
    expect(screen.getByRole('menu')).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('lets an admin disconnect after confirming, via the server', async () => {
    await setup('ADMIN');
    fireEvent.contextMenu(screen.getByText('row-bob'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Disconnect from voice' }));
    expect(screen.getByRole('dialog', { name: 'Disconnect Bob from the voice channel?' })).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/ban/i);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    });
    await waitFor(() => expect(voiceApi.disconnectParticipant).toHaveBeenCalledWith('vc1', 'bob'));
  });

  it('says the user already left, or that the server is outdated, instead of a generic error', async () => {
    const { ApiError } = await import('../../api/errors');
    await setup('ADMIN');
    vi.mocked(voiceApi.disconnectParticipant).mockRejectedValueOnce(new ApiError('http', 404, 'VOICE_PARTICIPANT_NOT_FOUND', 'gone'));
    fireEvent.contextMenu(screen.getByText('row-bob'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Disconnect from voice' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    });
    expect(await screen.findByText('The user has already left the voice channel.')).toBeInTheDocument();

    vi.mocked(voiceApi.disconnectParticipant).mockRejectedValueOnce(new ApiError('http', 404, 'NOT_FOUND', 'Route not found'));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    });
    expect(await screen.findByText(/does not support disconnecting/)).toBeInTheDocument();
  });

  it('closes when the participant leaves', async () => {
    await setup('USER');
    fireEvent.contextMenu(screen.getByText('row-bob'));
    act(() => {
      useVoiceStore.setState({ participants: [person('me', true)] });
    });
    expect(screen.queryByRole('menu')).toBeNull();
  });
});
