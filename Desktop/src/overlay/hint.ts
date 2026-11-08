/// <reference lib="dom" />
export {};
window.aidisOverlay.onUpdate((update) => {
  if (update.type !== 'stream-hint') return;
  const node = document.getElementById('hint');
  if (!node) return;
  node.className = update.hint.type === 'reaction' ? 'reaction' : '';
  node.textContent = update.hint.type === 'reaction' ? ({ laugh: '😂', clap: '👏', f: 'F' }[update.hint.reaction]) : '';
});
