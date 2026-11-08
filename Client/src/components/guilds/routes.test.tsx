import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import type { Channel } from '../../api/types';
import { useGuildStore } from '../../stores/guildStore';
import { channelPath, dmCallPath, dmPath, homePath, invitePath, lastChannelOf, legacyRedirect, linkTo, rememberChannel } from './routes';
import { GuildRedirect } from './GuildRedirect';

const channel = (id: string, guildId: string | null, type: Channel['type'] = 'TEXT', position = 0): Channel => ({
  id,
  guildId,
  type,
  name: id,
  description: null,
  position,
  createdAt: '2026-01-01T00:00:00.000Z',
  parentId: null,
  permissionsSynced: true,
});

const text = channel('t1', 'G');
const voiceCh = channel('v1', 'G', 'VOICE');
const dm = channel('d1', null, 'DM');
const lookup = (id: string) => [text, voiceCh, dm].find((c) => c.id === id);

function Where() {
  const location = useLocation();
  return <p data-testid="where">{location.pathname}</p>;
}

describe('0.7.0 routes', () => {
  beforeEach(() => {
    localStorage.clear();
    useGuildStore.getState().reset();
  });

  it('builds paths', () => {
    expect(homePath()).toBe('/channels/@me');
    expect(dmPath('d1')).toBe('/channels/@me/d1');
    expect(dmCallPath('d1')).toBe('/channels/@me/d1/call');
    expect(invitePath('abc')).toBe('/invite/abc');
    // Text and voice channels share one path: the view follows the channel type.
    expect(channelPath('G', 't1')).toBe('/channels/G/t1');
    expect(linkTo(text)).toBe(linkTo({ ...text, id: 't1', type: 'VOICE' }));
    expect(linkTo(dm)).toBe('/channels/@me/d1');
    expect(linkTo(dm, { call: true })).toBe('/channels/@me/d1/call');
  });

  it('redirects 0.6 links to the new places', () => {
    expect(legacyRedirect('/channels/t1', lookup)).toBe('/channels/G/t1');
    expect(legacyRedirect('/voice/v1', lookup)).toBe('/channels/G/v1');
    expect(legacyRedirect('/voice/d1', lookup)).toBe('/channels/@me/d1/call');
    expect(legacyRedirect('/dm/d1', lookup)).toBe('/channels/@me/d1');
    expect(legacyRedirect('/dm', lookup)).toBe('/channels/@me');
    expect(legacyRedirect('/channels/unknown', lookup)).toBeNull();
    expect(legacyRedirect('/voice/unknown', lookup)).toBeNull();
  });

  it('remembers the last channel per server', () => {
    rememberChannel('G', 't1');
    rememberChannel('H', 'x');
    expect(lastChannelOf('G')).toBe('t1');
    expect(lastChannelOf('H')).toBe('x');
    expect(lastChannelOf('nope')).toBeNull();
  });

  it('/channels/:guildId opens the first visible text channel', () => {
    useGuildStore.setState({
      byGuild: { G: { channels: [channel('cat', 'G', 'CATEGORY', 0), voiceCh, channel('t2', 'G', 'TEXT', 2), channel('t1', 'G', 'TEXT', 1)], roles: [], members: [], rolesLoaded: true, membersLoaded: true } },
    });
    render(
      <MemoryRouter initialEntries={['/channels/G']}>
        <Routes>
          <Route path="/channels/:guildId" element={<GuildRedirect />} />
          <Route path="*" element={<Where />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByTestId('where').textContent).toBe('/channels/G/t1');
  });

  it('/channels/:guildId prefers the last opened channel of that server', () => {
    useGuildStore.setState({ byGuild: { G: { channels: [channel('t1', 'G', 'TEXT', 1), channel('t2', 'G', 'TEXT', 2)], roles: [], members: [], rolesLoaded: true, membersLoaded: true } } });
    rememberChannel('G', 't2');
    render(
      <MemoryRouter initialEntries={['/channels/G']}>
        <Routes>
          <Route path="/channels/:guildId" element={<GuildRedirect />} />
          <Route path="*" element={<Where />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByTestId('where').textContent).toBe('/channels/G/t2');
  });

  it('an old /channels/:channelId link lands in the new place', () => {
    useGuildStore.setState({ byGuild: { G: { channels: [text], roles: [], members: [], rolesLoaded: true, membersLoaded: true } } });
    render(
      <MemoryRouter initialEntries={['/channels/t1']}>
        <Routes>
          <Route path="/channels/:guildId" element={<GuildRedirect />} />
          <Route path="*" element={<Where />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByTestId('where').textContent).toBe('/channels/G/t1');
  });
});
