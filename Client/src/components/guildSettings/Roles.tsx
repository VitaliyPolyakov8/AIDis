import { useState, type DragEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronLeft, GripVertical, Lock, Pencil, Plus, Trash } from 'lucide-react';
import type { Permission, RoleView } from '../../api/types';
import { guildsApi } from '../../api/guilds';
import { friendlyError } from '../../api/errors';
import { useGuildStore } from '../../stores/guildStore';
import { toast } from '../../stores/uiStore';
import { ConfirmDialog } from '../ConfirmDialog';
import { Toggle } from '../settings/Toggle';
import { PERMISSION_GROUPS } from './permissionGroups';
import { canEditRole } from './hierarchy';
import type { GuildContext } from './context';

const DEFAULT_COLOR = '#5b7cff';

function RoleEditor({ ctx, role, onBack }: { ctx: GuildContext; role: RoleView; onBack: () => void }) {
  const { t } = useTranslation();
  const [name, setName] = useState(role.name);
  const [color, setColor] = useState<string | null>(role.color);
  const [hoist, setHoist] = useState(role.hoist);
  const [mentionable, setMentionable] = useState(role.mentionable);
  const [perms, setPerms] = useState<Permission[]>(role.permissions);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const editable = canEditRole(role, ctx.rank) && ctx.has('MANAGE_ROLES');
  // Nobody hands out a permission they do not have (owner / administrator / superadmin have all).
  const mine = (p: Permission) => ctx.rank === Infinity || ctx.has(p);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await guildsApi.updateRole(ctx.guild.id, role.id, role.isEveryone ? { permissions: perms } : { name: name.trim(), color, hoist, mentionable, permissions: perms });
      await useGuildStore.getState().refreshRoles(ctx.guild.id);
      toast.success(t('gs.roles.saved'), 'role-save');
      onBack();
    } catch (e) {
      setError(friendlyError(e, t('gs.roles.failed')));
      setBusy(false);
    }
  };

  return (
    <form
      className="gs-role-editor"
      onSubmit={(e) => {
        e.preventDefault();
        if (editable && (role.isEveryone || name.trim())) void save();
      }}
    >
      <button type="button" className="btn btn-ghost btn-sm gs-back" onClick={onBack}>
        <ChevronLeft size={15} aria-hidden="true" /> {t('gs.roles.back')}
      </button>
      {role.isEveryone ? (
        <p className="field-hint">{t('gs.roles.everyoneHint')}</p>
      ) : (
        <>
          <div className="inline-form">
            <label className="field gs-grow">
              <span className="field-label">{t('gs.roles.name')}</span>
              <input className="input" value={name} maxLength={100} disabled={!editable} onChange={(e) => setName(e.target.value)} />
            </label>
            <label className="field">
              <span className="field-label">{t('gs.roles.color')}</span>
              <span className="gs-color">
                <input type="color" className="color-input" value={color ?? DEFAULT_COLOR} disabled={!editable} onChange={(e) => setColor(e.target.value)} aria-label={t('gs.roles.color')} />
                <button type="button" className={`chip${color === null ? ' is-on' : ''}`} disabled={!editable} onClick={() => setColor(null)}>
                  {t('gs.roles.noColor')}
                </button>
              </span>
            </label>
          </div>
          <Toggle label={t('gs.roles.hoist')} hint={t('gs.roles.hoistHint')} checked={hoist} disabled={!editable} onChange={setHoist} />
          <Toggle label={t('gs.roles.mentionable')} hint={t('gs.roles.mentionableHint')} checked={mentionable} disabled={!editable} onChange={setMentionable} />
        </>
      )}
      <div className="gs-perm-head">
        <h4 className="gs-subtitle">{t('gs.roles.permissions')}</h4>
        {editable && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setPerms((list) => list.filter((p) => !mine(p)))}>
            {t('gs.roles.clearAll')}
          </button>
        )}
      </div>
      {PERMISSION_GROUPS.map((group) => (
        <fieldset key={group.id} className="gs-perm-group">
          <legend>{t(`perms.groups.${group.id}`)}</legend>
          <ul className="perm-list">
            {group.permissions.map((p) => {
              const on = perms.includes(p);
              const locked = !editable || !mine(p);
              return (
                <li key={p}>
                  <label className={`perm-row${locked ? ' is-locked' : ''}`} title={!editable ? t('gs.roles.aboveYou') : locked ? t('gs.roles.notYours') : undefined}>
                    <input type="checkbox" checked={on} disabled={locked} onChange={() => setPerms((list) => (on ? list.filter((x) => x !== p) : [...list, p]))} />
                    <span className="perm-text">
                      <span className="perm-name">{t(`admin.perms.${p}.name`)}</span>
                      <span className="field-hint">{t(`admin.perms.${p}.hint`)}</span>
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        </fieldset>
      ))}
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      <div className="modal-actions modal-actions-split">
        {editable && !role.isEveryone ? (
          <button type="button" className="btn btn-ghost is-danger-text" onClick={() => setDeleting(true)}>
            <Trash size={15} aria-hidden="true" /> {t('gs.roles.delete')}
          </button>
        ) : (
          <span />
        )}
        <button type="submit" className="btn btn-primary" disabled={busy || !editable || (!role.isEveryone && !name.trim())}>
          {t('common.save')}
        </button>
      </div>
      {deleting && (
        <ConfirmDialog
          title={t('gs.roles.deleteTitle', { name: role.name })}
          confirmLabel={t('common.delete')}
          onClose={() => setDeleting(false)}
          onConfirm={async () => {
            try {
              await guildsApi.deleteRole(ctx.guild.id, role.id);
              await useGuildStore.getState().refreshRoles(ctx.guild.id);
            } catch (e) {
              throw new Error(friendlyError(e, t('gs.roles.failed')), { cause: e });
            }
            onBack();
          }}
        >
          <p>{t('gs.roles.deleteBody')}</p>
        </ConfirmDialog>
      )}
    </form>
  );
}

/** Roles high to low; drag roles below yours; @everyone at the bottom. */
export function RolesSection({ ctx }: { ctx: GuildContext }) {
  const { t } = useTranslation();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const canManage = ctx.has('MANAGE_ROLES');
  const editing = editingId ? ctx.roles.find((r) => r.id === editingId) : undefined;
  if (editing) return <RoleEditor key={editing.id} ctx={ctx} role={editing} onBack={() => setEditingId(null)} />;

  const ordered = ctx.rolesDesc.filter((r) => !r.isEveryone);
  const everyone = ctx.roles.find((r) => r.isEveryone);

  const create = async () => {
    try {
      const { role } = await guildsApi.createRole(ctx.guild.id, { name: t('gs.roles.newName') });
      await useGuildStore.getState().refreshRoles(ctx.guild.id);
      setEditingId(role.id);
    } catch (e) {
      toast.error(friendlyError(e, t('gs.roles.failed')), 'role-create');
    }
  };

  const drop = (targetId: string) => {
    const from = dragging;
    setDragging(null);
    setOver(null);
    if (!from || from === targetId) return;
    const ids = ordered.map((r) => r.id).filter((id) => id !== from);
    ids.splice(ids.indexOf(targetId), 0, from);
    // The list is high -> low; the server wants low -> high.
    guildsApi
      .reorderRoles(ctx.guild.id, [...ids].reverse())
      .then(() => useGuildStore.getState().refreshRoles(ctx.guild.id))
      .catch((e: unknown) => toast.error(friendlyError(e, t('gs.roles.reorderFailed')), 'role-order'));
  };

  const dragProps = (role: RoleView) => {
    const movable = canManage && canEditRole(role, ctx.rank);
    if (!movable) return {};
    return {
      draggable: true,
      onDragStart: (e: DragEvent) => {
        setDragging(role.id);
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('application/x-aidis-role', role.id);
      },
      onDragOver: (e: DragEvent) => {
        if (!dragging || dragging === role.id) return;
        e.preventDefault();
        setOver(role.id);
      },
      onDragLeave: () => setOver((o) => (o === role.id ? null : o)),
      onDragEnd: () => {
        setDragging(null);
        setOver(null);
      },
      onDrop: (e: DragEvent) => {
        e.preventDefault();
        drop(role.id);
      },
      'data-drop-target': over === role.id ? 'true' : undefined,
    };
  };

  const row = (role: RoleView) => {
    const editable = canManage && canEditRole(role, ctx.rank);
    return (
      <li key={role.id} className="admin-row gs-role-row" {...(role.isEveryone ? {} : dragProps(role))}>
        {!role.isEveryone && editable ? <GripVertical size={14} className="gs-grip" aria-hidden="true" /> : <span className="gs-grip-spacer" aria-hidden="true" />}
        <span className="role-dot" style={{ background: role.color ?? 'var(--text-faint)' }} aria-hidden="true" />
        <span className="admin-row-name">{role.isEveryone ? t('gs.roles.everyone') : role.name}</span>
        {!role.isEveryone && <span className="admin-tag">{t('gs.roles.members', { count: role.memberCount })}</span>}
        {!editable && !role.isEveryone && (
          <span className="admin-tag" title={t('gs.roles.aboveYou')}>
            <Lock size={11} aria-hidden="true" />
          </span>
        )}
        <span className="admin-row-actions">
          <button type="button" className="icon-btn" aria-label={`${t('admin.roles.edit')}: ${role.name}`} onClick={() => setEditingId(role.id)}>
            <Pencil size={15} />
          </button>
        </span>
      </li>
    );
  };

  return (
    <div className="gs-section">
      <p className="field-hint">{t('gs.roles.hint')}</p>
      {canManage && (
        <button type="button" className="btn btn-secondary" onClick={() => void create()}>
          <Plus size={15} aria-hidden="true" /> {t('gs.roles.create')}
        </button>
      )}
      <ul className="admin-list gs-role-list">
        {ordered.map(row)}
        {everyone && row(everyone)}
      </ul>
    </div>
  );
}
