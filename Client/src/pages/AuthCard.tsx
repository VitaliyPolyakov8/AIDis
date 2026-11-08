import type { ReactNode } from 'react';
import { LogoMark } from '../components/Logo';
import { LanguageSwitch } from '../components/LanguageSwitch';

/** 0.7.1: the login screen frame shared by sign-up, e-mail confirmation and password reset. */
export function AuthCard({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactNode }) {
  return (
    <div className="login-screen">
      <div className="login-lang">
        <LanguageSwitch compact />
      </div>
      <main className="login-card">
        <div className="login-brand">
          <LogoMark size={64} />
          <h1 className="login-title">{title}</h1>
          {subtitle && <p className="login-subtitle">{subtitle}</p>}
        </div>
        {children}
      </main>
    </div>
  );
}
