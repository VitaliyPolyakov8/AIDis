import { useRef, useState, type CSSProperties } from 'react';
import { AVATAR_FRAMES, PROFILE_BANNERS, bannerUrl } from '../../cosmetics/catalog';
import { useTranslation } from 'react-i18next';
import { ImageUp, Plus, Trash, X } from 'lucide-react';
import { usersApi } from '../../api/users';
import { uploadAttachment } from '../../api/attachments';
import { friendlyError } from '../../api/errors';
import type { PublicUser } from '../../api/types';
import { useAuthStore } from '../../stores/authStore';
import { usePresenceStore } from '../../stores/presenceStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { toast } from '../../stores/uiStore';
import { useAttachmentUrl } from '../../hooks/useAttachmentUrl';
import { gameTheme } from '../../utils/gameTheme';
import { Avatar } from '../Avatar';
import { FramedAvatar, PROFILE_FRAMES, UserBadges } from '../profile/ProfileBits';
import { Toggle } from './Toggle';
import { NICKNAME_PRESETS, displayNicknameColor, isReadableNicknameColor } from '../profile/nicknameColor';
import { nameStyleOf } from '../profile/nameStyle';
import { forgetShelf } from '../../games/GameShelf';
import { MyGames } from '../../games/MyGames';
import { NICKNAME_FONTS } from '../../api/types';

const BANNER_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const ACCENTS = ['#5b7cff', '#8b5cf6', '#ec4899', '#ef4444', '#f97316', '#eab308', '#22c55e', '#14b8a6', '#06b6d4', '#64748b'];
const MAX_TAGS = 5;

/** Reads the pixel size of a picked image before uploading it (the server checks the bytes again). */
function imageSize(file: File): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      resolve({ width: img.naturalWidth, height: img.naturalHeight });
      URL.revokeObjectURL(url);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('decode'));
    };
    img.src = url;
  });
}

function Preview({ user }: { user: PublicUser }) {
  const builtIn = bannerUrl(user.profileBannerId);
  const uploaded = useAttachmentUrl(builtIn ? null : (user.bannerAttachmentId ?? null)).url;
  const url = builtIn ?? uploaded;
  const accent = user.accentColor ?? '#5b7cff';
  return (
    <div
      className={`profile-preview${user.accentColor && user.accentColor2 ? ' has-theme' : ''}`}
      style={{ '--profile-accent': accent, ...(user.accentColor && user.accentColor2 ? { '--profile-theme-1': user.accentColor, '--profile-theme-2': user.accentColor2 } : {}) } as CSSProperties}
    >
      <div className={`profile-banner${url ? ' has-image' : ''}`} style={url ? { backgroundImage: `url("${url}")` } : { background: `linear-gradient(135deg, ${accent}, color-mix(in srgb, ${accent} 35%, #0f1220))` }} />
      <div className="profile-card-head">
        <span className="profile-card-avatar">
          <FramedAvatar frame={user.profileFrame} size={72}>
            <Avatar userId={user.id} name={user.displayName} avatarAttachmentId={user.avatarAttachmentId} size={72} status="online" />
          </FramedAvatar>
        </span>
        <UserBadges user={user} size={15} />
      </div>
      <div className="profile-card-names">
        <span className="profile-card-name">
          <span className={nameStyleOf(user).className} style={nameStyleOf(user).style}>
            {user.displayName}
          </span>
        </span>
        <span className="profile-card-username">@{user.username}</span>
      </div>
      {user.profileTags && user.profileTags.length > 0 && (
        <div className="chip-list profile-preview-tags">
          {user.profileTags.map((tag) => {
            const theme = gameTheme(tag);
            return (
              <span key={tag} className="tag-chip" style={{ '--game-accent': theme.accent, '--game-soft': theme.soft } as CSSProperties}>
                {tag}
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** 0.4.0 profile personalization: banner, accent color, frame, tags (shown in the profile card). */
export function ProfileSettings() {
  const { t } = useTranslation();
  const user = useAuthStore((s) => s.user);
  const full = usePresenceStore((s) => (user ? s.users[user.id] : undefined));
  const setUser = useAuthStore((s) => s.setUser);
  const upsertUser = usePresenceStore((s) => s.upsertUser);
  const animated = useSettingsStore((s) => s.profileAnimations);
  const updateSettings = useSettingsStore((s) => s.update);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tagInput, setTagInput] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const me = full ?? user;
  if (!me) return null;

  const save = async (patch: Parameters<typeof usersApi.updateMe>[0], okText?: string) => {
    setBusy(true);
    setError(null);
    try {
      const { user: next } = await usersApi.updateMe(patch);
      setUser(next);
      upsertUser(next);
      if (okText) toast.success(okText, 'profile');
    } catch (e) {
      setError(friendlyError(e, t('settings.profile.failed')));
    } finally {
      setBusy(false);
    }
  };

  const pickBanner = async (file: File) => {
    if (!BANNER_TYPES.includes(file.type)) {
      setError(t('settings.profile.bannerType'));
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      setError(t('settings.profile.bannerSize'));
      return;
    }
    try {
      const { width, height } = await imageSize(file);
      if (width > 4096 || height > 2048) {
        setError(t('settings.profile.bannerDimensions'));
        return;
      }
    } catch {
      setError(t('settings.profile.bannerType'));
      return;
    }
    setBusy(true);
    try {
      const attachment = await uploadAttachment(file, () => undefined).promise;
      await save({ bannerAttachmentId: attachment.id }, t('settings.profile.bannerSaved'));
    } catch (e) {
      setError(friendlyError(e, t('settings.profile.failed')));
      setBusy(false);
    }
  };

  const tags = me.profileTags ?? [];
  const addTag = () => {
    const value = tagInput.trim().slice(0, 32);
    if (!value || tags.includes(value) || tags.length >= MAX_TAGS) return;
    setTagInput('');
    void save({ profileTags: [...tags, value] });
  };

  return (
    <div className="settings-section profile-settings">
      <Preview user={me} />

      <div className="settings-group">
        <h4 className="settings-group-title">{t('settings.profile.banner')}</h4>
        <p className="field-hint">{t('settings.profile.bannerHint')}</p>
        <div className="button-row">
          <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => fileRef.current?.click()}>
            <ImageUp size={15} aria-hidden="true" /> {t('settings.profile.uploadBanner')}
          </button>
          {me.bannerAttachmentId && (
            <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void save({ bannerAttachmentId: null })}>
              <Trash size={15} aria-hidden="true" /> {t('settings.profile.removeBanner')}
            </button>
          )}
          <input
            ref={fileRef}
            type="file"
            hidden
            accept={BANNER_TYPES.join(',')}
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (file) void pickBanner(file);
            }}
          />
        </div>
      </div>

      <CosmeticsGroups me={me} busy={busy} save={save} />

      <NicknameColorGroup current={me.nicknameColor ?? null} busy={busy} save={(color) => save({ nicknameColor: color })} name={me.displayName} />

      <NameStyleGroup me={me} busy={busy} save={save} />

      <div className="settings-group">
        <h4 className="settings-group-title">{t('settings.profile.accent')}</h4>
        <div className="swatch-row" role="radiogroup" aria-label={t('settings.profile.accent')}>
          {ACCENTS.map((c) => (
            <button
              key={c}
              type="button"
              role="radio"
              aria-checked={me.accentColor === c}
              aria-label={c}
              className={`swatch${me.accentColor === c ? ' is-active' : ''}`}
              style={{ background: c }}
              disabled={busy}
              onClick={() => void save({ accentColor: c })}
            />
          ))}
          <label className="swatch swatch-custom" title={t('settings.profile.customColor')}>
            <input type="color" value={me.accentColor ?? '#5b7cff'} onChange={(e) => void save({ accentColor: e.target.value })} aria-label={t('settings.profile.customColor')} />
          </label>
          {me.accentColor && (
            <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void save({ accentColor: null })}>
              {t('settings.profile.resetColor')}
            </button>
          )}
        </div>
      </div>

      <div className="settings-group">
        <h4 className="settings-group-title">{t('settings.profile.theme')}</h4>
        <p className="field-hint">{me.accentColor ? t('settings.profile.themeHint') : t('settings.profile.themeNeedsAccent')}</p>
        <div className="swatch-row" role="radiogroup" aria-label={t('settings.profile.theme')}>
          {ACCENTS.map((c) => (
            <button
              key={c}
              type="button"
              role="radio"
              aria-checked={me.accentColor2 === c}
              aria-label={c}
              className={`swatch${me.accentColor2 === c ? ' is-active' : ''}`}
              style={{ background: me.accentColor ? `linear-gradient(135deg, ${me.accentColor}, ${c})` : c }}
              disabled={busy || !me.accentColor}
              onClick={() => void save({ accentColor2: c })}
            />
          ))}
          <label className="swatch swatch-custom" title={t('settings.profile.customColor')}>
            <input type="color" value={me.accentColor2 ?? '#c56cf0'} disabled={!me.accentColor} onChange={(e) => void save({ accentColor2: e.target.value })} aria-label={t('settings.profile.customColor')} />
          </label>
          {me.accentColor2 && (
            <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void save({ accentColor2: null })}>
              {t('settings.profile.themeOff')}
            </button>
          )}
        </div>
      </div>

      <BioGroup me={me} busy={busy} save={save} />

      <BirthdayGroup me={me} busy={busy} save={save} />

      <div className="settings-group">
        <h4 className="settings-group-title">{t('settings.profile.privacy')}</h4>
        <Toggle
          label={t('settings.profile.showRecentGames')}
          hint={t('settings.profile.showRecentGamesHint')}
          checked={me.showRecentGames !== false}
          disabled={busy}
          onChange={(v) => {
            forgetShelf(me.id);
            void save({ showRecentGames: v });
          }}
        />
      </div>

      <MyGames />

      <div className="settings-group">
        <h4 className="settings-group-title">{t('settings.profile.frame')}</h4>
        <p className="field-hint">{t('settings.profile.frameHint')}</p>
        <div className="frame-grid" role="radiogroup" aria-label={t('settings.profile.frame')}>
          <button type="button" role="radio" aria-checked={!me.profileFrame} className={`frame-option${!me.profileFrame ? ' is-active' : ''}`} disabled={busy} onClick={() => void save({ profileFrame: null })}>
            {/* 0.5.6: previews of the speaking ring alone (never mixed with the animated frame). */}
            <Avatar userId={me.id} name={me.displayName} avatarAttachmentId={me.avatarAttachmentId} size={44} frame={false} />
            <span>{t('settings.profile.frames.none')}</span>
          </button>
          {PROFILE_FRAMES.map((f) => (
            <button
              key={f}
              type="button"
              role="radio"
              aria-checked={me.profileFrame === f}
              className={`frame-option${me.profileFrame === f ? ' is-active' : ''}`}
              disabled={busy}
              onClick={() => void save({ profileFrame: f })}
            >
              <FramedAvatar frame={f} size={44}>
                <Avatar userId={me.id} name={me.displayName} avatarAttachmentId={me.avatarAttachmentId} size={44} frame={false} />
              </FramedAvatar>
              <span>{t(`settings.profile.frames.${f}`)}</span>
            </button>
          ))}
        </div>
        <Toggle label={t('settings.profile.animations')} hint={t('settings.profile.animationsHint')} checked={animated} onChange={(v) => updateSettings({ profileAnimations: v })} />
      </div>

      <div className="settings-group">
        <h4 className="settings-group-title">{t('settings.profile.tags')}</h4>
        <p className="field-hint">{t('settings.profile.tagsHint', { max: MAX_TAGS })}</p>
        <div className="chip-list">
          {tags.map((tag) => (
            <span key={tag} className="tag-chip is-editable" style={{ '--game-accent': gameTheme(tag).accent, '--game-soft': gameTheme(tag).soft } as CSSProperties}>
              {tag}
              <button type="button" aria-label={t('settings.profile.removeTag', { tag })} disabled={busy} onClick={() => void save({ profileTags: tags.filter((x) => x !== tag) })}>
                <X size={12} />
              </button>
            </span>
          ))}
        </div>
        {tags.length < MAX_TAGS && (
          <form
            className="inline-form"
            onSubmit={(e) => {
              e.preventDefault();
              addTag();
            }}
          >
            <input className="input" value={tagInput} maxLength={32} placeholder={t('settings.profile.tagPlaceholder')} onChange={(e) => setTagInput(e.target.value)} />
            <button type="submit" className="btn btn-secondary" disabled={busy || !tagInput.trim()}>
              <Plus size={15} aria-hidden="true" /> {t('settings.profile.addTag')}
            </button>
          </form>
        )}
      </div>
      {error && <p className="field-error">{error}</p>}
    </div>
  );
}

type Save = (patch: Parameters<typeof usersApi.updateMe>[0], okText?: string) => Promise<void>;

/**
 * 0.5.5 name style: gradient (second color), glow and font. Fixed options only; the preview shows
 * the name exactly as everyone will see it.
 */
function NameStyleGroup({ me, busy, save }: { me: PublicUser; busy: boolean; save: Save }) {
  const { t } = useTranslation();
  const preview = nameStyleOf(me);
  return (
    <div className="settings-group">
      <h4 className="settings-group-title">{t('settings.profile.nameStyle')}</h4>
      <p className="nickname-preview name-style-preview">
        <span className={preview.className} style={preview.style}>
          {me.displayName}
        </span>
      </p>
      <span className="field-label">{t('settings.profile.nameGradient')}</span>
      <p className="field-hint">{me.nicknameColor ? t('settings.profile.nameGradientHint') : t('settings.profile.nameGradientNeedsColor')}</p>
      <div className="swatch-row" role="radiogroup" aria-label={t('settings.profile.nameGradient')}>
        {NICKNAME_PRESETS.map((c) => (
          <button
            key={c}
            type="button"
            role="radio"
            aria-checked={me.nicknameColor2 === c}
            aria-label={c}
            className={`swatch${me.nicknameColor2 === c ? ' is-active' : ''}`}
            style={{ background: me.nicknameColor ? `linear-gradient(90deg, ${me.nicknameColor}, ${c})` : c }}
            disabled={busy || !me.nicknameColor}
            onClick={() => void save({ nicknameColor2: c })}
          />
        ))}
        {me.nicknameColor2 && (
          <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void save({ nicknameColor2: null })}>
            {t('settings.profile.nameGradientOff')}
          </button>
        )}
      </div>
      <Toggle label={t('settings.profile.nameGlow')} hint={t('settings.profile.nameGlowHint')} checked={me.nicknameGlow === true} disabled={busy} onChange={(v) => void save({ nicknameGlow: v })} />
      <span className="field-label">{t('settings.profile.nameFont')}</span>
      <div className="font-grid" role="radiogroup" aria-label={t('settings.profile.nameFont')}>
        <button type="button" role="radio" aria-checked={!me.nicknameFont} className={`font-option${!me.nicknameFont ? ' is-active' : ''}`} disabled={busy} onClick={() => void save({ nicknameFont: null })}>
          <span>{me.displayName}</span>
          <small>{t('settings.profile.nameFontDefault')}</small>
        </button>
        {NICKNAME_FONTS.map((f) => (
          <button
            key={f}
            type="button"
            role="radio"
            aria-checked={me.nicknameFont === f}
            className={`font-option${me.nicknameFont === f ? ' is-active' : ''}`}
            disabled={busy}
            onClick={() => void save({ nicknameFont: f })}
          >
            <span className={nameStyleOf({ nicknameFont: f }).className} style={nameStyleOf({ nicknameFont: f }).style}>
              {me.displayName}
            </span>
            <small>{t(`settings.profile.fonts.${f}`)}</small>
          </button>
        ))}
      </div>
    </div>
  );
}

const MONTHS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** 0.5.5 birthday (day and month only): confetti on the profile that day. */
/** 0.7.0: "About me" (global; each server can override it in the server profile). */
function BioGroup({ me, busy, save }: { me: PublicUser; busy: boolean; save: Save }) {
  const { t } = useTranslation();
  const [bio, setBio] = useState(me.bio ?? '');
  const dirty = (bio.trim() || null) !== (me.bio ?? null);
  return (
    <div className="settings-group">
      <h4 className="settings-group-title">{t('profile.bio')}</h4>
      <textarea className="input" rows={3} value={bio} maxLength={190} onChange={(e) => setBio(e.target.value)} aria-label={t('profile.bio')} />
      <p className="field-hint">
        {t('profile.bioHint')} {bio.length}/190
      </p>
      <div className="button-row">
        <button type="button" className="btn btn-secondary btn-sm" disabled={busy || !dirty} onClick={() => void save({ bio: bio.trim() || null }, t('profile.bioSaved'))}>
          {t('common.save')}
        </button>
      </div>
    </div>
  );
}

function BirthdayGroup({ me, busy, save }: { me: PublicUser; busy: boolean; save: Save }) {
  const { t, i18n } = useTranslation();
  const [month, setMonth] = useState(me.birthday?.month ?? 0);
  const [day, setDay] = useState(me.birthday?.day ?? 0);
  const maxDay = month ? (DAYS_IN_MONTH[month - 1] ?? 31) : 31;
  const monthName = (m: number) => new Date(2024, m - 1, 1).toLocaleDateString(i18n.language, { month: 'long' });
  const changed = (me.birthday?.month ?? 0) !== month || (me.birthday?.day ?? 0) !== day;
  return (
    <div className="settings-group">
      <h4 className="settings-group-title">{t('settings.profile.birthday')}</h4>
      <p className="field-hint">{t('settings.profile.birthdayHint')}</p>
      <div className="inline-form birthday-form">
        <select className="select" aria-label={t('settings.profile.birthdayDay')} value={day} onChange={(e) => setDay(Number(e.target.value))}>
          <option value={0}>{t('settings.profile.birthdayDay')}</option>
          {Array.from({ length: maxDay }, (_, i) => i + 1).map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </select>
        <select
          className="select"
          aria-label={t('settings.profile.birthdayMonth')}
          value={month}
          onChange={(e) => {
            const m = Number(e.target.value);
            setMonth(m);
            if (m && day > (DAYS_IN_MONTH[m - 1] ?? 31)) setDay(0);
          }}
        >
          <option value={0}>{t('settings.profile.birthdayMonth')}</option>
          {MONTHS.map((m) => (
            <option key={m} value={m}>
              {monthName(m)}
            </option>
          ))}
        </select>
        <button type="button" className="btn btn-secondary" disabled={busy || !changed || !month || !day} onClick={() => void save({ birthday: { month, day } }, t('settings.profile.birthdaySaved'))}>
          {t('common.save')}
        </button>
        {me.birthday && (
          <button
            type="button"
            className="btn btn-ghost"
            disabled={busy}
            onClick={() => {
              setMonth(0);
              setDay(0);
              void save({ birthday: null });
            }}
          >
            {t('settings.profile.birthdayClear')}
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * 0.5.0 nickname color: presets, a custom picker and "Reset to default". Too dark colors are not
 * saved (the name would vanish on the dark background); the preview shows the real result.
 */
function NicknameColorGroup({ current, busy, save, name }: { current: string | null; busy: boolean; save: (color: string | null) => Promise<void>; name: string }) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? current ?? '#dbdee1';
  const readable = isReadableNicknameColor(shown);
  const pick = (color: string) => {
    setDraft(color);
    if (isReadableNicknameColor(color)) void save(color).then(() => setDraft(null));
  };
  return (
    <div className="settings-group">
      <h4 className="settings-group-title">{t('settings.profile.nicknameColor')}</h4>
      <p className="settings-hint">{t('settings.profile.nicknameColorHint')}</p>
      <div className="swatch-row" role="radiogroup" aria-label={t('settings.profile.nicknameColor')}>
        {NICKNAME_PRESETS.map((c) => (
          <button
            key={c}
            type="button"
            role="radio"
            aria-checked={current === c}
            aria-label={c}
            className={`swatch${current === c ? ' is-active' : ''}`}
            style={{ background: c }}
            disabled={busy}
            onClick={() => pick(c)}
          />
        ))}
        <label className="swatch swatch-custom" title={t('settings.profile.customColor')}>
          <input type="color" value={shown} onChange={(e) => pick(e.target.value)} aria-label={t('settings.profile.customColor')} />
        </label>
        {current && (
          <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void save(null).then(() => setDraft(null))}>
            {t('settings.profile.resetColor')}
          </button>
        )}
      </div>
      <p className="nickname-preview">
        <span style={{ color: readable ? shown : (displayNicknameColor(shown) ?? undefined) }}>{name}</span>
      </p>
      {!readable && (
        <p className="field-error" role="alert">
          {t('settings.profile.nicknameColorTooDark')}
        </p>
      )}
    </div>
  );
}

/**
 * 0.5.1 built-in animated profile banner and avatar frame (server-side ids, shown on every client).
 * Previews animate natively (GIF / WebP); "None" removes the choice.
 */
function CosmeticsGroups({ me, busy, save }: { me: PublicUser; busy: boolean; save: (patch: { profileBannerId?: string | null; avatarFrameId?: string | null }) => Promise<void> }) {
  const { t } = useTranslation();
  const banner = me.profileBannerId ?? null;
  const frame = me.avatarFrameId ?? null;
  return (
    <>
      <div className="settings-group">
        <h4 className="settings-group-title">{t('settings.profile.bannerPick')}</h4>
        <div className="cosmetic-grid is-banners" role="radiogroup" aria-label={t('settings.profile.bannerPick')}>
          <button
            type="button"
            role="radio"
            aria-checked={banner === null}
            className={`cosmetic-option is-none${banner === null ? ' is-active' : ''}`}
            disabled={busy}
            onClick={() => void save({ profileBannerId: null })}
          >
            {t('settings.profile.none')}
          </button>
          {PROFILE_BANNERS.map((b) => (
            <button
              key={b.id}
              type="button"
              role="radio"
              aria-checked={banner === b.id}
              aria-label={b.name}
              title={b.name}
              className={`cosmetic-option${banner === b.id ? ' is-active' : ''}`}
              disabled={busy}
              onClick={() => void save({ profileBannerId: b.id })}
            >
              <img src={bannerUrl(b.id) ?? ''} alt="" loading="lazy" decoding="async" draggable={false} />
            </button>
          ))}
        </div>
      </div>
      <div className="settings-group">
        <h4 className="settings-group-title">{t('settings.profile.framePick')}</h4>
        <div className="cosmetic-grid is-frames" role="radiogroup" aria-label={t('settings.profile.framePick')}>
          <button type="button" role="radio" aria-checked={frame === null} className={`cosmetic-option is-none${frame === null ? ' is-active' : ''}`} disabled={busy} onClick={() => void save({ avatarFrameId: null })}>
            <Avatar userId={me.id} name={me.displayName} avatarAttachmentId={me.avatarAttachmentId} size={52} frame={false} />
            <span>{t('settings.profile.none')}</span>
          </button>
          {AVATAR_FRAMES.map((f) => (
            <button
              key={f.id}
              type="button"
              role="radio"
              aria-checked={frame === f.id}
              aria-label={f.name}
              title={f.name}
              className={`cosmetic-option${frame === f.id ? ' is-active' : ''}`}
              disabled={busy}
              onClick={() => void save({ avatarFrameId: f.id })}
            >
              <Avatar userId={me.id} name={me.displayName} avatarAttachmentId={me.avatarAttachmentId} size={52} frame={f.id} />
              <span>{f.name}</span>
            </button>
          ))}
        </div>
      </div>
    </>
  );
}
