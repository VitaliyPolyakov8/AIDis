import { useTranslation } from 'react-i18next';
import { CircleAlert, Check, Info, TriangleAlert, X } from 'lucide-react';
import { useUiStore } from '../stores/uiStore';

const ICONS = { info: Info, success: Check, warning: TriangleAlert, error: CircleAlert };

export function Toasts() {
  const { t } = useTranslation();
  const toasts = useUiStore((s) => s.toasts);
  const dismiss = useUiStore((s) => s.dismissToast);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((item) => {
        const Icon = ICONS[item.tone];
        return (
          <div key={item.id} className={`toast toast-${item.tone}`}>
            <Icon size={16} aria-hidden="true" />
            <span className="toast-text">{item.message}</span>
            <button type="button" className="icon-btn toast-close" aria-label={t('common.dismiss')} onClick={() => dismiss(item.id)}>
              <X size={14} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
