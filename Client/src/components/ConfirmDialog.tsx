import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal } from './Modal';

interface ConfirmDialogProps {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  tone?: 'danger' | 'primary';
  onConfirm: () => Promise<void> | void;
  onClose: () => void;
  /** 0.7.0: e.g. until the server name is typed. */
  confirmDisabled?: boolean;
}

export function ConfirmDialog({ title, children, confirmLabel, tone = 'danger', onConfirm, onClose, confirmDisabled = false }: ConfirmDialogProps) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
      onClose();
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : t('errors.fallback'));
      setBusy(false);
    }
  };

  return (
    <Modal
      title={title}
      onClose={onClose}
      size="sm"
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="button" className={`btn ${tone === 'danger' ? 'btn-danger' : 'btn-primary'}`} onClick={() => void confirm()} disabled={busy || confirmDisabled} data-autofocus>
            {busy && <span className="spinner spinner-on-accent" aria-hidden="true" />}
            {confirmLabel}
          </button>
        </>
      }
    >
      <div className="confirm-body">{children}</div>
      {error && (
        <p className="alert alert-error" role="alert">
          {error}
        </p>
      )}
    </Modal>
  );
}
