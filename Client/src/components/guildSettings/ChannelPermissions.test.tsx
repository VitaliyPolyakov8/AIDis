import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { RoleView } from '../../api/types';
import { channelsApi } from '../../api/channels';
import { guildsApi } from '../../api/guilds';
import { useGuildStore } from '../../stores/guildStore';
import { useAuthStore } from '../../stores/authStore';
import { alice, general, GUILD_ID, makeGuild } from '../../test/fixtures';
import { ChannelPermissions } from './ChannelPermissions';
import { useGuildContext } from './context';

const everyone: RoleView = { id: 'role-everyone', guildId: GUILD_ID, name: '@everyone', color: null, position: 0, permissions: [], hoist: false, mentionable: false, isEveryone: true, memberCount: 0 };

function Harness() {
  const ctx = useGuildContext(GUILD_ID);
  return ctx ? <ChannelPermissions ctx={ctx} channel={general} /> : null;
}

describe('channel permissions editor', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useAuthStore.setState({ status: 'authenticated', user: alice });
    useGuildStore.setState({
      guilds: [makeGuild(['VIEW_CHANNEL', 'SEND_MESSAGES', 'MANAGE_ROLES', 'MANAGE_CHANNELS'], { ownerId: alice.id })],
      loaded: true,
      activeGuildId: GUILD_ID,
      byGuild: { [GUILD_ID]: { channels: [{ ...general, permissionsSynced: false, overwrites: [] }], roles: [everyone], members: [], rolesLoaded: true, membersLoaded: true } },
      channelPerms: {},
    });
    vi.spyOn(guildsApi, 'permissions').mockResolvedValue({ permissions: ['VIEW_CHANNEL', 'SEND_MESSAGES', 'MANAGE_ROLES'], all: [] });
    vi.spyOn(guildsApi, 'channels').mockResolvedValue({ channels: [general] });
  });

  it('saves allow / deny for @everyone', async () => {
    const set = vi.spyOn(channelsApi, 'setOverwrite').mockResolvedValue({ overwrite: { targetType: 'ROLE', targetId: everyone.id, allow: [], deny: ['SEND_MESSAGES'] } });
    render(<Harness />);
    const group = screen.getByRole('radiogroup', { name: 'Send messages' });
    fireEvent.click(within(group).getByRole('radio', { name: 'Deny' }));
    expect(within(group).getByRole('radio', { name: 'Deny' })).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Save permissions' }));
    await waitFor(() => expect(set).toHaveBeenCalledWith(general.id, 'ROLE', everyone.id, { allow: [], deny: ['SEND_MESSAGES'] }));
  });

  it('offers only channel permissions', () => {
    render(<Harness />);
    expect(screen.queryByRole('radiogroup', { name: 'Ban members' })).not.toBeInTheDocument();
    expect(screen.getByRole('radiogroup', { name: 'Connect' })).toBeInTheDocument();
  });
});
