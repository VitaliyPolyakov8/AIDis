import { t } from '../i18n';

export interface FieldErrors {
  username?: string;
  password?: string;
}

export function validateLogin(username: string, password: string): FieldErrors {
  const errors: FieldErrors = {};
  if (!username.trim()) errors.username = t('login.usernameRequired');
  else if (username.trim().length > 64) errors.username = t('login.usernameTooLong');
  if (!password) errors.password = t('login.passwordRequired');
  else if (password.length > 256) errors.password = t('login.passwordTooLong');
  return errors;
}
