import type { MouseEvent as ReactMouseEvent } from 'react';
import { Copy, Download, ExternalLink, Link2 } from 'lucide-react';
import { openMenu, type MenuEntry } from '../menu/MenuHost';
import { t } from '../../i18n';
import { toast } from '../../stores/uiStore';
import { copyImageFromUrl, copyText } from '../../utils/imageClipboard';

export interface ChatImage {
  /** What is displayed (object URL / proxy URL): copied as a bitmap. */
  src: string;
  /** The original (attachment / GIF / page) for "Copy image link"; null = none. */
  link: string | null;
  /** "Open original" (lightbox for attachments, the original page for GIFs / previews). */
  onOpen?: () => void;
  /** "Save image as…" (attachments). */
  onSave?: () => void;
}

/** Copies the picture and tells the user what happened (also used by Ctrl+C in the image viewer). */
export async function copyChatImage(image: ChatImage): Promise<void> {
  const result = await copyImageFromUrl(image.src);
  if (result === 'copied') {
    toast.success(t('attachments.copy.done'), 'image-copy');
    return;
  }
  if (image.link && (await copyText(image.link))) {
    toast.info(result === 'unsupported' ? t('attachments.copy.linkInstead') : t('attachments.copy.failedLink'), 'image-copy');
  } else {
    toast.error(result === 'unsupported' ? t('attachments.copy.unsupported') : t('attachments.copy.failed'), 'image-copy');
  }
}

/** 0.5.0 right-click menu on a chat image: Copy image, Copy image link, Open original, Save image as. */
export function openImageMenu(e: ReactMouseEvent, image: ChatImage): void {
  e.preventDefault();
  e.stopPropagation();
  const entries: MenuEntry[] = [{ label: t('attachments.copy.image'), icon: <Copy size={15} />, onSelect: () => void copyChatImage(image) }];
  if (image.link) {
    const link = image.link;
    entries.push({
      label: t('attachments.copy.link'),
      icon: <Link2 size={15} />,
      onSelect: () => void copyText(link).then((ok) => (ok ? toast.success(t('attachments.copy.linkDone'), 'image-copy') : toast.error(t('attachments.copy.failed'), 'image-copy'))),
    });
  }
  if (image.onOpen) entries.push({ label: t('attachments.copy.open'), icon: <ExternalLink size={15} />, onSelect: image.onOpen });
  if (image.onSave) entries.push({ label: t('attachments.copy.save'), icon: <Download size={15} />, onSelect: image.onSave });
  openMenu(e, entries);
}
