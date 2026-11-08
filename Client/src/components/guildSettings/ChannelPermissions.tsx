import { useEffect, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Plus, Slash, Trash, X } from 'lucide-react';
import type { Channel, OverwriteView, Permission } from '../../api/types';
import { channelsApi } from '../../api/channels';
import { friendlyError } from '../../api/errors';
import { memberDisplay, useGuildChannels, useGuildMembers, useGuildStore } from '../../stores/guildStore';
import { usePresenceStore } from '../../stores/presenceStore';
import { toast } from '../../stores/uiStore';
import { openMenu, type MenuEntry } from '../menu/MenuHost';
import { Avatar } from '../Avatar';
import { channelPermissionGroups } from './permissionGroups';
import { canActOnMember, canEditRole } from './hierarchy';
import { fromOverwrite, isEmpty, sameMap, stateOf, toPayload, withState, type OverwriteMap, type OverwriteState } from './overwriteState';
import type { GuildContext } from './context';

type Target = { type: 'ROLE' | 'MEMBER'; id: string };
const key = (t: Target) => `${t.type}:${t.id}`;
const STATES: OverwriteState[] = ['deny', 'inherit', 'allow'];
const NO_OVERWRITES: OverwriteView[] = [];

/** 0.7.0: who may do what in one channel or category (Discord-like allow / inherit / deny). */
export function ChannelPermissions({ ctx, channel }: { ctx: GuildContext; channel: Channel }) {
  const { t } = useTranslation();
  const guildId = ctx.guild.id;
  const channels = useGuildChannels(guildId);
  const live = channels.find((c) => c.id === channel.id) ?? channel;
  const parent = live.parentId ? channels.find((c) => c.id === live.parentId) : undefined;
  const members = useGuildMembers(guildId);
  const users = usePresenceStore((s) => s.users);
  const myChannelPerms = useGuildStore((s) => s.channelPerms[channel.id]);
  const everyone = ctx.roles.find((r) => r.isEveryone);
  // A synced channel uses its category's overwrites (what the server applies).
  const source: OverwriteView[] = (live.permissionsSynced && parent ? parent.overwrites : live.overwrites) ?? NO_OVERWRITES;

  useEffect(() => {
    void useGuildStore
      .getState()
      .loadChannelPerms(channel.id)
      .catch(() => undefined);
  }, [channel.id]);

  const [added, setAdded] = useState<Target[]>([]);
  const targets = ((): Target[] => {
    const list: Target[] = [];
    if (everyone) list.push({ type: 'ROLE', id: everyone.id });
    const roleIds = new Set([...source.filter((o) => o.targetType === 'ROLE').map((o) => o.targetId), ...added.filter((a) => a.type === 'ROLE').map((a) => a.id)]);
    for (const r of ctx.rolesDesc) if (!r.isEveryone && roleIds.has(r.id)) list.push({ type: 'ROLE', id: r.id });
    const memberIds = [...new Set([...source.filter((o) => o.targetType === 'MEMBER').map((o) => o.targetId), ...added.filter((a) => a.type === 'MEMBER').map((a) => a.id)])];
    for (const id of memberIds) list.push({ type: 'MEMBER', id });
    return list;
  })();

  const [selected, setSelected] = useState<string | null>(null);
  const current = targets.find((x) => key(x) === selected) ?? targets[0];
  const saved = fromOverwrite(current ? source.find((o) => o.targetType === current.type && o.targetId === current.id) : undefined);
  // The edit in progress belongs to one target and to what was saved when it started.
  const sig = `${current ? key(current) : ''}|${JSON.stringify(toPayload(saved))}`;
  const [edit, setEdit] = useState<{ sig: string; map: OverwriteMap } | null>(null);
  const draft = edit?.sig === sig ? edit.map : saved;
  const setDraft = (next: OverwriteMap | ((m: OverwriteMap) => OverwriteMap)) => setEdit({ sig, map: typeof next === 'function' ? next(draft) : next });
  const [busy, setBusy] = useState(false);

  const nameOf = (target: Target) => {
    if (target.type === 'ROLE') {
      const role = ctx.roles.find((r) => r.id === target.id);
      return role?.isEveryone ? '@everyone' : (role?.name ?? '…');
    }
    return memberDisplay(
      users[target.id],
      members.find((m) => m.userId === target.id),
      ctx.roles,
    ).name;
  };
  const editableTarget = (target: Target) => {
    if (target.type === 'ROLE') {
      const role = ctx.roles.find((r) => r.id === target.id);
      return role ? canEditRole(role, ctx.rank) : false;
    }
    const member = members.find((m) => m.userId === target.id);
    return member ? canActOnMember(member, ctx.roles, ctx.rank, ctx.selfId, ctx.guild.ownerId) : false;
  };
  const mine = (p: Permission) => ctx.rank === Infinity || (myChannelPerms ? myChannelPerms.includes(p) : ctx.has(p));

  const save = async (map: OverwriteMap) => {
    if (!current) return;
    setBusy(true);
    try {
      if (isEmpty(map)) await channelsApi.removeOverwrite(channel.id, current.type, current.id);
      else await channelsApi.setOverwrite(channel.id, current.type, current.id, toPayload(map));
      await useGuildStore.getState().refreshChannels(guildId);
      setAdded((list) => list.filter((a) => key(a) !== key(current)));
      toast.success(t('cp.saved'), 'overwrite-save');
    } catch (e) {
      toast.error(friendlyError(e, t('cp.failed')), 'overwrite-save');
    } finally {
      setBusy(false);
    }
  };

  const addMenu = (e: ReactMouseEvent) => {
    const have = new Set(targets.map(key));
    const roles = ctx.rolesDesc.filter((r) => !r.isEveryone && canEditRole(r, ctx.rank) && !have.has(`ROLE:${r.id}`));
    const people = members.filter((m) => !have.has(`MEMBER:${m.userId}`) && canActOnMember(m, ctx.roles, ctx.rank, ctx.selfId, ctx.guild.ownerId));
    const pick = (target: Target) => () => {
      setAdded((list) => [...list, target]);
      setSelected(key(target));
    };
    const entries: MenuEntry[] = [];
    if (roles.length > 0) entries.push({ kind: 'title', label: t('cp.addRole') }, ...roles.map((r) => ({ label: r.name, onSelect: pick({ type: 'ROLE', id: r.id }) })));
    if (people.length > 0)
      entries.push({ kind: 'title', label: t('cp.addMember') }, ...people.slice(0, 50).map((m) => ({ label: memberDisplay(users[m.userId], m, ctx.roles).name, onSelect: pick({ type: 'MEMBER', id: m.userId }) })));
    if (entries.length > 0) openMenu(e, entries, t('cp.add'));
  };

  const locked = current ? !editableTarget(current) : true;
  const dirty = !sameMap(draft, saved);

  return (
    <div className="cp">
      {live.type === 'CATEGORY' ? (
        <p className="field-hint">{t('cp.category')}</p>
      ) : (
        parent && <p className={`cp-sync${live.permissionsSynced ? ' is-synced' : ''}`}>{t(live.permissionsSynced ? 'cp.synced' : 'cp.notSynced', { name: parent.name })}</p>
      )}
      <div className="cp-layout">
        <div className="cp-targets">
          <div className="cp-targets-head">
            <span className="field-label">{t('cp.targets')}</span>
            <button type="button" className="icon-btn icon-btn-xs" aria-label={t('cp.add')} title={t('cp.add')} onClick={addMenu}>
              <Plus size={14} />
            </button>
          </div>
          <ul className="cp-target-list" role="listbox" aria-label={t('cp.targets')}>
            {targets.map((target) => {
              const role = target.type === 'ROLE' ? ctx.roles.find((r) => r.id === target.id) : undefined;
              const user = target.type === 'MEMBER' ? users[target.id] : undefined;
              const active = current && key(current) === key(target);
              return (
                <li key={key(target)}>
                  <button type="button" role="option" aria-selected={active} className={`cp-target${active ? ' is-active' : ''}`} onClick={() => setSelected(key(target))}>
                    {target.type === 'ROLE' ? (
                      <span className="role-dot" style={{ background: role?.color ?? 'var(--text-faint)' }} aria-hidden="true" />
                    ) : (
                      <Avatar userId={target.id} name={nameOf(target)} avatarAttachmentId={user?.avatarAttachmentId ?? null} size={20} />
                    )}
                    <span className="cp-target-name">{nameOf(target)}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
        <div className="cp-editor">
          {!current ? (
            <p className="field-hint">{t('cp.pick')}</p>
          ) : (
            <>
              {current.id === everyone?.id && <p className="field-hint">{t('cp.everyoneHint')}</p>}
              {locked && <p className="field-hint">{t('cp.locked')}</p>}
              {channelPermissionGroups().map((group) => (
                <fieldset key={group.id} className="gs-perm-group">
                  <legend>{t(`perms.groups.${group.id}`)}</legend>
                  <ul className="cp-perm-list">
                    {group.permissions.map((p) => {
                      const state = stateOf(draft, p);
                      const disabled = locked || busy || !mine(p);
                      return (
                        <li key={p} className="cp-perm">
                          <span className="perm-text">
                            <span className="perm-name">{t(`admin.perms.${p}.name`)}</span>
                            <span className="field-hint">{t(`admin.perms.${p}.hint`)}</span>
                          </span>
                          <span className="cp-tri" role="radiogroup" aria-label={t(`admin.perms.${p}.name`)} title={!locked && !mine(p) ? t('cp.notYours') : undefined}>
                            {STATES.map((s) => (
                              <button
                                key={s}
                                type="button"
                                role="radio"
                                aria-checked={state === s}
                                aria-label={t(`cp.${s}`)}
                                title={t(`cp.${s}`)}
                                className={`cp-tri-btn is-${s}${state === s ? ' is-on' : ''}`}
                                disabled={disabled}
                                onClick={() => setDraft((m) => withState(m, p, s))}
                              >
                                {s === 'allow' ? <Check size={14} /> : s === 'deny' ? <X size={14} /> : <Slash size={13} />}
                              </button>
                            ))}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                </fieldset>
              ))}
              <div className="modal-actions modal-actions-split">
                {current.id !== everyone?.id && !locked ? (
                  <button type="button" className="btn btn-ghost is-danger-text" disabled={busy} onClick={() => void save({})}>
                    <Trash size={15} aria-hidden="true" /> {t('cp.remove')}
                  </button>
                ) : (
                  <span />
                )}
                <span className="cp-actions">
                  <button type="button" className="btn btn-ghost" disabled={!dirty || busy} onClick={() => setDraft(saved)}>
                    {t('cp.reset')}
                  </button>
                  <button type="button" className="btn btn-primary" disabled={!dirty || busy || locked} onClick={() => void save(draft)}>
                    {t('cp.save')}
                  </button>
                </span>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
