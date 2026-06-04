/**
 * 全局主题切换（v1.10.0）
 *
 * - localStorage `xiyu_theme` = 'auto' | 'light' | 'dark'，默认 'auto'
 * - 'auto' 跟随 prefers-color-scheme：浏览器换深色 → 网页立刻换
 * - 渲染前必须立刻写 <html data-theme>，避免闪烁。所以本脚本不能 defer，
 *   要在 <head> 内 sync 加载，或者由每个页面的 inline pre-script 先把
 *   data-theme 写上，再异步加载 theme.js 注入切换按钮。
 *
 * Copyright (c) 2026 溪语 AI Contributors. MIT License.
 */
(function () {
  const KEY = 'xiyu_theme';
  function getPref() {
    try { return localStorage.getItem(KEY) || 'auto'; } catch { return 'auto'; }
  }
  function setPref(v) {
    try { localStorage.setItem(KEY, v); } catch {}
  }
  function systemDark() {
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  }
  function effectiveTheme(pref) {
    if (pref === 'dark') return 'dark';
    if (pref === 'light') return 'light';
    return systemDark() ? 'dark' : 'light';
  }
  function apply(pref) {
    const t = effectiveTheme(pref);
    document.documentElement.setAttribute('data-theme', t);
  }
  // 立即应用（如果 inline pre-script 漏掉这步，至少补上）
  apply(getPref());

  // 监听系统主题变化（仅 auto 模式响应）
  if (window.matchMedia) {
    try {
      window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
        if (getPref() === 'auto') apply('auto');
      });
    } catch {}
  }

  // 注入切换按钮 + 引导气泡
  function injectToggle() {
    if (document.getElementById('xiyu-theme-toggle')) return;

    function showBubble(text, ms) {
      let b = document.getElementById('xiyu-theme-bubble');
      if (!b) {
        b = document.createElement('div');
        b.id = 'xiyu-theme-bubble';
        b.className = 'xiyu-theme-bubble';
        document.body.appendChild(b);
      }
      b.textContent = text;
      b.classList.add('show');
      clearTimeout(b._t);
      b._t = setTimeout(() => b.classList.remove('show'), ms);
    }

    const btn = document.createElement('button');
    btn.id = 'xiyu-theme-toggle';
    btn.className = 'xiyu-theme-toggle';
    btn.setAttribute('aria-label', '切换主题');
    function render() {
      const pref = getPref();
      btn.textContent = pref === 'dark' ? '🌙' : pref === 'light' ? '☀️' : '🌓';
      btn.title = '主题：' + (pref === 'auto' ? '跟随系统' : pref === 'dark' ? '深色' : '浅色') + '（点击切换：跟随系统 → 浅色 → 深色）';
    }
    render();
    btn.addEventListener('click', () => {
      const order = ['auto', 'light', 'dark'];
      const cur = getPref();
      const next = order[(order.indexOf(cur) + 1) % order.length];
      setPref(next);
      apply(next);
      render();
      showBubble(next === 'auto' ? '已切换：跟随系统' : next === 'dark' ? '已切换：深色模式' : '已切换：浅色模式', 1600);
    });
    document.body.appendChild(btn);

    // 首次访问引导一次（让用户知道右下角能切深 / 浅色）
    try {
      if (!localStorage.getItem('xiyu_theme_hint_seen')) {
        setTimeout(() => showBubble('切换深色 / 浅色 →', 5000), 900);
        localStorage.setItem('xiyu_theme_hint_seen', '1');
      }
    } catch {}
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectToggle);
  } else {
    injectToggle();
  }
})();
