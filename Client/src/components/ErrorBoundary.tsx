import { Component, type ErrorInfo, type ReactNode } from 'react';
import { t } from '../i18n';
import { desktop } from '../desktop/bridge';

/**
 * 0.4.0: a render error in one part of the UI shows a small "reload" card instead of a blank
 * window. Logged to the desktop log (message only, no user data).
 */
export class ErrorBoundary extends Component<{ children: ReactNode; area?: string }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    const where = this.props.area ?? 'app';
    desktop?.app.log('error', `[ui] ${where} crashed: ${error.message}`);
    console.error(error, info.componentStack);
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="center-empty error-boundary" role="alert">
        <p>{t('errors.uiCrashed')}</p>
        <div className="button-row">
          <button type="button" className="btn btn-secondary" onClick={() => this.setState({ failed: false })}>
            {t('common.tryAgain')}
          </button>
          <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>
            {t('errors.reload')}
          </button>
        </div>
      </div>
    );
  }
}
