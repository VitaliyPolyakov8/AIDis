import { useCallback, useMemo, useState, type DragEvent } from 'react';
import { useParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronRight, Plus } from 'lucide-react';
import type { Channel } from '../../api/types';
import { guildsApi } from '../../api/guilds';
import { friendlyError } from '../../api/errors';
import { useGuildChannels, useGuildStore } from '../../stores/guildStore';
import { useCan } from '../../stores/permsStore';
import { toast } from '../../stores/uiStore';
import { openCreateChannel } from '../admin/ChannelDialog';
import { buildTree, moveInTree, type ChannelTree as Tree, type DropTarget } from './channelTree';
import { TextChannelLink, VoiceChannelItem, useChannelMenu } from './ChannelItems';

// ---- collapsed categories (per server, per device) ----------------------------------------------

const collapsedKey = (guildId: string) => `aidis.collapsed.${guildId}`;

function readCollapsed(guildId: string): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(collapsedKey(guildId)) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function useCollapsed(guildId: string) {
  const [state, setState] = useState(() => ({ guildId, list: readCollapsed(guildId) }));
  const collapsed = state.guildId === guildId ? state.list : readCollapsed(guildId);
  const toggle = useCallback(
    (categoryId: string) =>
      setState((current) => {
        const list = current.guildId === guildId ? current.list : readCollapsed(guildId);
        const next = list.includes(categoryId) ? list.filter((id) => id !== categoryId) : [...list, categoryId];
        try {
          localStorage.setItem(collapsedKey(guildId), JSON.stringify(next));
        } catch {
          // Not remembered without storage.
        }
        return { guildId, list: next };
      }),
    [guildId],
  );
  return [collapsed, toggle] as const;
}

// ---- drag & drop (MANAGE_CHANNELS) --------------------------------------------------------------

const DRAG_TYPE = 'application/x-aidis-channel';

function useTreeDrag(guildId: string, tree: Tree, enabled: boolean) {
  const { t } = useTranslation();
  const [dragging, setDragging] = useState<{ id: string; category: boolean } | null>(null);
  const [over, setOver] = useState<string | null>(null);

  const drop = (target: DropTarget) => {
    const from = dragging?.id;
    setDragging(null);
    setOver(null);
    if (!from) return;
    const items = moveInTree(tree, from, target);
    if (!items) return;
    // Optimistic; the server then sends channels.changed to everyone who sees the server.
    useGuildStore.getState().applyChannelOrder(guildId, items);
    guildsApi.reorderChannels(guildId, items).catch((err: unknown) => {
      toast.error(friendlyError(err, t('admin.channels.reorderFailed')), 'reorder');
      void useGuildStore
        .getState()
        .refreshChannels(guildId)
        .catch(() => undefined);
    });
  };

  const base = (channel: Channel) => ({
    draggable: true,
    onDragStart: (e: DragEvent) => {
      e.stopPropagation();
      setDragging({ id: channel.id, category: channel.type === 'CATEGORY' });
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData(DRAG_TYPE, channel.id);
    },
    onDragEnd: () => {
      setDragging(null);
      setOver(null);
    },
  });

  /** A channel row: others drop before it (categories cannot). */
  const channelProps = (channel: Channel) => {
    if (!enabled) return {};
    return {
      ...base(channel),
      onDragOver: (e: DragEvent) => {
        if (!dragging || dragging.category || dragging.id === channel.id) return;
        e.preventDefault();
        e.stopPropagation();
        setOver(channel.id);
      },
      onDragLeave: () => setOver((o) => (o === channel.id ? null : o)),
      onDrop: (e: DragEvent) => {
        if (!dragging || dragging.category) return;
        e.preventDefault();
        e.stopPropagation();
        drop({ kind: 'before', id: channel.id });
      },
      'data-drop-target': over === channel.id ? 'true' : undefined,
    };
  };

  /** A category header: a channel goes to its end, a category goes before it. */
  const categoryProps = (category: Channel) => {
    if (!enabled) return {};
    return {
      ...base(category),
      onDragOver: (e: DragEvent) => {
        if (!dragging || dragging.id === category.id) return;
        e.preventDefault();
        setOver(category.id);
      },
      onDragLeave: () => setOver((o) => (o === category.id ? null : o)),
      onDrop: (e: DragEvent) => {
        if (!dragging) return;
        e.preventDefault();
        drop(dragging.category ? { kind: 'before', id: category.id } : { kind: 'into', categoryId: category.id });
      },
      'data-drop-target': over === category.id ? 'true' : undefined,
    };
  };

  return { channelProps, categoryProps };
}

// ---- the tree -----------------------------------------------------------------------------------

function ChannelRows({ channels, onMenu, drag }: { channels: Channel[]; onMenu: ReturnType<typeof useChannelMenu>; drag: ReturnType<typeof useTreeDrag> }) {
  return (
    <>
      {channels.map((c) =>
        c.type === 'VOICE' ? (
          <VoiceChannelItem key={c.id} channel={c} onMenu={onMenu} dragProps={drag.channelProps(c)} />
        ) : (
          <li key={c.id} {...drag.channelProps(c)}>
            <TextChannelLink channel={c} onMenu={onMenu} />
          </li>
        ),
      )}
    </>
  );
}

/** 0.7.0: the open server's channels, grouped by category (Discord-like). */
export function GuildChannelList({ guildId }: { guildId: string }) {
  const { t } = useTranslation();
  const { channelId: openChannelId } = useParams();
  const channels = useGuildChannels(guildId);
  const tree = useMemo(() => buildTree(channels), [channels]);
  const canManage = useCan('MANAGE_CHANNELS');
  const onMenu = useChannelMenu();
  const drag = useTreeDrag(guildId, tree, canManage);
  const [collapsed, toggle] = useCollapsed(guildId);

  return (
    <>
      {tree.orphans.length > 0 && (
        <ul className="channel-list channel-list-top">
          <ChannelRows channels={tree.orphans} onMenu={onMenu} drag={drag} />
        </ul>
      )}
      {tree.categories.map(({ category, children }) => {
        const isCollapsed = collapsed.includes(category.id);
        // A collapsed category still shows the open channel (as in Discord).
        const visible = isCollapsed ? children.filter((c) => c.id === openChannelId) : children;
        const headingId = `category-${category.id}`;
        return (
          <section key={category.id} className={`channel-section channel-category${isCollapsed ? ' is-collapsed' : ''}`} aria-labelledby={headingId}>
            <h2 id={headingId} className="channel-section-title" onContextMenu={(e) => onMenu(e, category)} {...drag.categoryProps(category)}>
              <button type="button" className="category-toggle" aria-expanded={!isCollapsed} title={isCollapsed ? t('channels.expand') : t('channels.collapse')} onClick={() => toggle(category.id)}>
                {isCollapsed ? <ChevronRight size={12} aria-hidden="true" /> : <ChevronDown size={12} aria-hidden="true" />}
                <span>{category.name}</span>
              </button>
              {canManage && (
                <button type="button" className="icon-btn icon-btn-xs" aria-label={t('channels.newChannel')} title={t('channels.newChannel')} onClick={() => openCreateChannel(guildId, 'TEXT', category.id)}>
                  <Plus size={14} />
                </button>
              )}
            </h2>
            <ul className="channel-list">
              <ChannelRows channels={visible} onMenu={onMenu} drag={drag} />
            </ul>
          </section>
        );
      })}
      {channels.length === 0 && <p className="channel-empty">{t('sidebar.noText')}</p>}
    </>
  );
}
