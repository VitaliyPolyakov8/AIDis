import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Folder, Hash, LayoutGrid, Map as MapIcon, RefreshCw, Volume2 } from 'lucide-react';
import { create } from 'zustand';
import type { Channel, VoiceLayout } from '../../api/types';
import { channelsApi } from '../../api/channels';
import { guildsApi } from '../../api/guilds';
import { voiceNodesApi } from '../../api/voiceNodes';
import { friendlyError } from '../../api/errors';
import { useGuildChannels, useGuildStore } from '../../stores/guildStore';
import { useAuthStore } from '../../stores/authStore';
import { toast } from '../../stores/uiStore';
import { Modal } from '../Modal';
import { ConfirmDialog } from '../ConfirmDialog';
import { Toggle } from '../settings/Toggle';
import { DEFAULT_VOICE_BITRATE, VOICE_BITRATES, bitrateIndex } from '../../voice/channelVoice';
import { useGuildContext } from '../guildSettings/context';
import { ChannelPermissions } from '../guildSettings/ChannelPermissions';

export type CreatableType = 'TEXT' | 'VOICE' | 'CATEGORY';

type State = { kind: 'create'; guildId: string; type: CreatableType; parentId: string | null } | { kind: 'edit'; channel: Channel } | { kind: 'delete'; channel: Channel } | null;
const useChannelDialog = create<{ state: State }>(() => ({ state: null }));

/** 0.7.0: a new channel (or category) on a server, optionally inside a category. */
export const openCreateChannel = (guildId: string, type: CreatableType, parentId: string | null = null) => useChannelDialog.setState({ state: { kind: 'create', guildId, type, parentId } });
export const openEditChannel = (channel: Channel) => useChannelDialog.setState({ state: { kind: 'edit', channel } });
export const openDeleteChannel = (channel: Channel) => useChannelDialog.setState({ state: { kind: 'delete', channel } });
const close = () => useChannelDialog.setState({ state: null });

const TYPE_ICONS = { TEXT: Hash, VOICE: Volume2, CATEGORY: Folder } as const;

function Editor({ guildId, initialType, initialParent, channel }: { guildId: string; initialType: CreatableType; initialParent: string | null; channel?: Channel }) {
  const { t } = useTranslation();
  const channels = useGuildChannels(guildId);
  const categories = useMemo(() => channels.filter((c) => c.type === 'CATEGORY').sort((a, b) => a.position - b.position), [channels]);
  const [type, setType] = useState<CreatableType>(initialType);
  const [name, setName] = useState(channel?.name ?? '');
  const [description, setDescription] = useState(channel?.description ?? '');
  const [parentId, setParentId] = useState<string | null>(channel ? channel.parentId : initialParent);
  const [isPrivate, setPrivate] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 0.5.5 voice channel settings.
  const [bitrate, setBitrate] = useState(channel?.voiceBitrate ?? DEFAULT_VOICE_BITRATE);
  const [layout, setLayout] = useState<VoiceLayout>(channel?.voiceLayout ?? 'standard');
  // 0.7.1: extra voice servers this server may use (none = the select is hidden).
  const [voiceNode, setVoiceNode] = useState<string | null>(channel?.voiceNodeId ?? null);
  const [nodes, setNodes] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    let alive = true;
    voiceNodesApi.forGuild(guildId).then(
      ({ nodes: list }) => alive && setNodes(list),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [guildId]);
  const isCategory = type === 'CATEGORY';
  const Icon = TYPE_ICONS[type];
  // The live channel (the dialog may be open while channels.changed arrives).
  const current = channel ? (channels.find((c) => c.id === channel.id) ?? channel) : undefined;

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const common = {
        name: name.trim(),
        ...(isCategory ? {} : { description: description.trim() || null, parentId }),
        ...(type === 'VOICE' ? { voiceBitrate: bitrate, voiceLayout: layout, ...(nodes.length > 0 || voiceNode ? { voiceNodeId: voiceNode } : {}) } : {}),
      };
      if (channel) {
        await channelsApi.update(channel.id, common);
      } else {
        const { channel: created } = await guildsApi.createChannel(guildId, { ...common, type });
        if (isPrivate) {
          // Discord-like private channel: hidden from @everyone, open for its creator.
          const everyone = useGuildStore.getState().byGuild[guildId]?.roles.find((r) => r.isEveryone);
          const selfId = useAuthStore.getState().user?.id;
          if (selfId) await channelsApi.setOverwrite(created.id, 'MEMBER', selfId, { allow: ['VIEW_CHANNEL'], deny: [] });
          if (everyone) await channelsApi.setOverwrite(created.id, 'ROLE', everyone.id, { allow: [], deny: ['VIEW_CHANNEL'] });
        }
      }
      await useGuildStore.getState().refreshChannels(guildId);
      toast.success(channel ? t('admin.channels.saved') : t('admin.channels.created'), 'channel-save');
      close();
    } catch (e) {
      setError(friendlyError(e, t('admin.channels.saveFailed')));
      setBusy(false);
    }
  };

  const sync = async () => {
    if (!channel) return;
    setBusy(true);
    try {
      await channelsApi.update(channel.id, { syncWithParent: true });
      await useGuildStore.getState().refreshChannels(guildId);
      toast.success(t('channels.syncDone'), 'channel-sync');
    } catch (e) {
      setError(friendlyError(e, t('admin.channels.saveFailed')));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="channel-editor"
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim()) void save();
      }}
    >
      {!channel && (
        <div className="field">
          <span className="field-label">{t('channels.typeLabel')}</span>
          <div className="layout-choice channel-type-choice" role="radiogroup" aria-label={t('channels.typeLabel')}>
            {(['TEXT', 'VOICE', 'CATEGORY'] as const).map((value) => {
              const TypeIcon = TYPE_ICONS[value];
              return (
                <button key={value} type="button" role="radio" aria-checked={type === value} className={`layout-option${type === value ? ' is-active' : ''}`} onClick={() => setType(value)}>
                  <TypeIcon size={18} aria-hidden="true" />
                  <span className="layout-option-title">{t(`channels.${value}`)}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}
      <label className="field">
        <span className="field-label">{isCategory ? t('channels.categoryName') : t('admin.channels.name')}</span>
        <span className="input-with-icon">
          <Icon size={16} aria-hidden="true" />
          <input className="input" data-autofocus value={name} maxLength={64} onChange={(e) => setName(e.target.value)} placeholder={type === 'VOICE' ? 'Gaming' : isCategory ? 'General' : 'announcements'} />
        </span>
      </label>
      {!isCategory && (
        <>
          <label className="field">
            <span className="field-label">{t('admin.channels.description')}</span>
            <input className="input" value={description} maxLength={300} onChange={(e) => setDescription(e.target.value)} />
          </label>
          <label className="field">
            <span className="field-label">{t('channels.category')}</span>
            <select className="input" value={parentId ?? ''} onChange={(e) => setParentId(e.target.value || null)}>
              <option value="">{t('channels.noCategory')}</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
        </>
      )}
      {current && !isCategory && current.parentId && (
        <div className="channel-sync">
          <span className="field-hint">{current.permissionsSynced ? t('channels.synced') : t('channels.notSynced')}</span>
          {!current.permissionsSynced && (
            <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => void sync()}>
              <RefreshCw size={14} aria-hidden="true" /> {t('channels.sync')}
            </button>
          )}
        </div>
      )}
      {type === 'VOICE' && (
        <div className="voice-channel-settings">
          {(nodes.length > 0 || voiceNode) && (
            <label className="field">
              <span className="field-label">{t('vn.channelField')}</span>
              <select className="input" value={voiceNode ?? ''} onChange={(e) => setVoiceNode(e.target.value || null)}>
                <option value="">{t('vn.mainOption')}</option>
                {nodes.map((n) => (
                  <option key={n.id} value={n.id}>
                    {n.name}
                  </option>
                ))}
                {voiceNode && !nodes.some((n) => n.id === voiceNode) && <option value={voiceNode}>{t('vn.unavailableOption')}</option>}
              </select>
              <span className="field-hint">{t('vn.channelHint')}</span>
            </label>
          )}
          <span className="field-label">{t('admin.channels.voiceLayout')}</span>
          <div className="layout-choice" role="radiogroup" aria-label={t('admin.channels.voiceLayout')}>
            {(['standard', 'room'] as const).map((value) => (
              <button key={value} type="button" role="radio" aria-checked={layout === value} className={`layout-option${layout === value ? ' is-active' : ''}`} onClick={() => setLayout(value)}>
                {value === 'room' ? <MapIcon size={18} aria-hidden="true" /> : <LayoutGrid size={18} aria-hidden="true" />}
                <span className="layout-option-title">{t(`admin.channels.layouts.${value}`)}</span>
                <span className="layout-option-hint">{t(`admin.channels.layouts.${value}Hint`)}</span>
              </button>
            ))}
          </div>
          <label className="field">
            <span className="field-label">
              {t('admin.channels.voiceBitrate')}: {bitrate} {t('admin.channels.kbps')}
            </span>
            <input
              className="range"
              type="range"
              min={0}
              max={VOICE_BITRATES.length - 1}
              step={1}
              value={bitrateIndex(bitrate)}
              onChange={(e) => setBitrate(VOICE_BITRATES[Number(e.target.value)] ?? DEFAULT_VOICE_BITRATE)}
            />
            <span className="field-hint">{t(bitrate > 96 ? 'admin.channels.voiceBitrateMusic' : 'admin.channels.voiceBitrateHint')}</span>
          </label>
        </div>
      )}
      {!channel && <Toggle label={t('channels.privateCreate')} hint={t('channels.privateCreateHint')} checked={isPrivate} onChange={setPrivate} />}
      {error && <p className="field-error">{error}</p>}
      <div className="modal-actions">
        <button type="button" className="btn btn-ghost" onClick={close}>
          {t('common.cancel')}
        </button>
        <button type="submit" className="btn btn-primary" disabled={busy || !name.trim()}>
          {channel ? t('common.save') : t('admin.channels.create')}
        </button>
      </div>
    </form>
  );
}

export function ChannelDialogHost() {
  const { t } = useTranslation();
  const state = useChannelDialog((s) => s.state);
  if (!state) return null;
  if (state.kind === 'delete') {
    const category = state.channel.type === 'CATEGORY';
    return (
      <ConfirmDialog
        title={category ? t('channels.deleteCategoryTitle', { name: state.channel.name }) : t('admin.channels.deleteTitle', { name: state.channel.name })}
        confirmLabel={t('common.delete')}
        onClose={close}
        onConfirm={async () => {
          try {
            await channelsApi.remove(state.channel.id);
            if (state.channel.guildId) await useGuildStore.getState().refreshChannels(state.channel.guildId);
          } catch (e) {
            throw new Error(friendlyError(e, t('admin.channels.deleteFailed')), { cause: e });
          }
        }}
      >
        <p>{category ? t('channels.deleteCategoryBody') : t('admin.channels.deleteBody')}</p>
      </ConfirmDialog>
    );
  }
  const guildId = state.kind === 'create' ? state.guildId : (state.channel.guildId ?? '');
  const type: CreatableType = state.kind === 'create' ? state.type : state.channel.type === 'VOICE' ? 'VOICE' : state.channel.type === 'CATEGORY' ? 'CATEGORY' : 'TEXT';
  const title = state.kind === 'create' ? t(type === 'CATEGORY' ? 'channels.newCategory' : 'channels.newChannel') : t(type === 'CATEGORY' ? 'channels.editCategory' : 'admin.channels.edit');
  if (state.kind === 'edit') return <EditChannelModal title={title} guildId={guildId} type={type} channel={state.channel} />;
  return (
    <Modal title={title} onClose={close} size="sm">
      <Editor key={`new-${type}`} guildId={guildId} initialType={type} initialParent={state.parentId} />
    </Modal>
  );
}

/** Editing: the settings, and (MANAGE_ROLES) who may do what in the channel. */
function EditChannelModal({ title, guildId, type, channel }: { title: string; guildId: string; type: CreatableType; channel: Channel }) {
  const { t } = useTranslation();
  const ctx = useGuildContext(guildId);
  const [tab, setTab] = useState<'overview' | 'permissions'>('overview');
  const canPermissions = ctx !== null && ctx.has('MANAGE_ROLES');
  return (
    <Modal title={title} onClose={close} size={tab === 'permissions' ? 'lg' : 'sm'}>
      {canPermissions && (
        <div className="segmented channel-dialog-tabs" role="tablist">
          {(['overview', 'permissions'] as const).map((id) => (
            <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? 'is-active' : ''} onClick={() => setTab(id)}>
              {t(id === 'overview' ? 'cp.tabOverview' : 'cp.tabPermissions')}
            </button>
          ))}
        </div>
      )}
      {tab === 'permissions' && ctx ? <ChannelPermissions ctx={ctx} channel={channel} /> : <Editor key={channel.id} guildId={guildId} initialType={type} initialParent={null} channel={channel} />}
    </Modal>
  );
}
