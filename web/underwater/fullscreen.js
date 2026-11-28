export function bindFullscreen(button, target = document) {
  button.hidden = !target.fullscreenEnabled || !target.documentElement.requestFullscreen;
  if (button.hidden) return;

  function sync() {
    const active = Boolean(target.fullscreenElement);
    const label = active ? '退出全屏' : '全屏';
    button.setAttribute('aria-pressed', String(active));
    button.setAttribute('aria-label', label);
    button.title = label;
  }

  button.addEventListener('click', async () => {
    try {
      if (target.fullscreenElement) await target.exitFullscreen();
      else await target.documentElement.requestFullscreen();
    } catch (error) {
      console.warn('无法切换全屏', error);
    }
  });
  target.addEventListener('fullscreenchange', sync);
  if (target !== document) {
    window.addEventListener('pagehide', event => {
      if (!event.persisted) target.removeEventListener('fullscreenchange', sync);
    });
  }
  sync();
}
