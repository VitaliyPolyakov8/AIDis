import { t as translate } from '../i18n';

const KEY_LABELS: Record<string, string> = {
  Up: '↑',
  Down: '↓',
  Left: '←',
  Right: '→',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backquote: '`',
  NumAdd: 'Num +',
  NumSubtract: 'Num -',
  NumMultiply: 'Num *',
  NumDivide: 'Num /',
  NumDecimal: 'Num .',
  LeftCtrl: 'Left Ctrl',
  RightCtrl: 'Right Ctrl',
  LeftShift: 'Left Shift',
  RightShift: 'Right Shift',
  LeftAlt: 'Left Alt',
  RightAlt: 'Right Alt',
};

/** "Ctrl+Shift+M" -> "Ctrl + Shift + M"; mouse buttons are localized. */
export function displayBinding(binding: string): string {
  return binding
    .split('+')
    .map((part) => {
      const mouse = /^Mouse(\d)$/.exec(part);
      if (mouse) return translate('desktop.keybinds.mouse', { n: mouse[1] });
      const num = /^Num(\d)$/.exec(part);
      if (num) return `Num ${num[1] ?? ''}`;
      return KEY_LABELS[part] ?? part;
    })
    .join(' + ');
}
