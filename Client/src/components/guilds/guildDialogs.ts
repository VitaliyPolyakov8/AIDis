import { create } from 'zustand';

/** 0.7.0 server dialogs (create / join / invite / leave / server profile / server settings). Hosts: GuildDialogHost. */
export type GuildDialog =
  | { kind: 'create' }
  | { kind: 'join'; code?: string }
  | { kind: 'invite'; guildId: string; channelId?: string | null }
  | { kind: 'leave'; guildId: string }
  | { kind: 'profile'; guildId: string }
  | { kind: 'settings'; guildId: string; section?: string }
  | null;

export const useGuildDialogs = create<{ dialog: GuildDialog }>(() => ({ dialog: null }));

export const openGuildDialog = (dialog: Exclude<GuildDialog, null>) => useGuildDialogs.setState({ dialog });
export const closeGuildDialog = () => useGuildDialogs.setState({ dialog: null });
