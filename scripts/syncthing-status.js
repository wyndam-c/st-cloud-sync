// syncthing-status.js - 酒馆右上角小状态条，60秒查一次同步状态
(function () {
  const POLL_INTERVAL = 60 * 1000;
  const DONE_HOLD_MS = 10 * 1000;
  // 用相对路径，自动适配当前域名（东京走 ai.kuyoai.com 反代，家用走 chat.kuyoai.com 反代）
  const API_PATH = '/syncthing-status';

  let bar = document.createElement('div');
  bar.id = 'syncthing-status-bar';
  bar.style.cssText = `
    position: fixed; top: 10px; right: 10px; z-index: 99999;
    padding: 8px 14px; border-radius: 8px; font-size: 12px;
    font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
    box-shadow: 0 2px 8px rgba(0,0,0,0.25);
    transition: opacity 0.3s; opacity: 0; pointer-events: none;
    display: flex; align-items: center; gap: 6px;
  `;
  document.body.appendChild(bar);

  function show(html, bg) {
    bar.innerHTML = html;
    bar.style.background = bg;
    bar.style.color = '#fff';
    bar.style.opacity = '1';
  }
  function hide() { bar.style.opacity = '0'; }

  let lastState = 'idle';
  let doneTimer = null;

  async function check() {
    try {
      const r = await fetch(API_PATH, { cache: 'no-store' });
      if (!r.ok) return;
      const d = await r.json();
      const state = d.state;
      const need = d.needFiles || 0;

      if (state === 'syncing' && need > 0) {
        show('🔄 正在同步 ' + need + ' 个文件…', '#f0ad4e');
        lastState = 'syncing';
        if (doneTimer) { clearTimeout(doneTimer); doneTimer = null; }
      } else if (lastState === 'syncing' && state === 'idle') {
        show('✅ 数据已同步到最新', '#5cb85c');
        lastState = 'idle';
        if (doneTimer) clearTimeout(doneTimer);
        doneTimer = setTimeout(hide, DONE_HOLD_MS);
      }
    } catch (e) { /* 静默 */ }
  }

  check();
  setInterval(check, POLL_INTERVAL);
})();
