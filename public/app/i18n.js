/**
 * 全局中英切换 i18n（v1.13）—— 默认中文，可切英文
 *
 * - localStorage `xiyu_lang` = 'zh' | 'en'，默认 'zh'（老用户/默认无感）
 * - HTML 里中文为默认文案；要翻译的元素加属性：
 *     data-i18n="key"        → 替换 textContent
 *     data-i18n-html="key"   → 替换 innerHTML（文案含标签时用）
 *     data-i18n-ph="key"     → 替换 placeholder
 *     data-i18n-title="key"  → 替换 title
 *     data-i18n-aria="key"   → 替换 aria-label
 *   英文文案由各页在引入本脚本「之前」定义：window.XIYU_I18N = { key: 'English …' }
 *   （中文 = 首次捕获的原始 DOM 文案，切回 zh 自动还原，无需写 zh 字典）
 * - 右下角注入「中 / EN」浮动开关（与 theme.js 同风格，位于主题开关上方）
 * - 暴露 window.XiyuI18n = { lang, t(key, zhFallback), set(lang), apply(), onChange(cb) }
 * - 切换时广播 window 事件 'xiyu:langchange'，聊天页据此把 AI 也切成英文
 *
 * Copyright (c) 2026 溪语 AI Contributors. MIT License.
 */
(function () {
  const KEY = 'xiyu_lang';
  const DICT = Object.assign({}, window.XIYU_I18N_BASE || {}, window.XIYU_I18N || {});
  const listeners = [];

  function getLang() {
    try { return localStorage.getItem(KEY) === 'en' ? 'en' : 'zh'; } catch { return 'zh'; }
  }
  function setPref(v) {
    try { localStorage.setItem(KEY, v === 'en' ? 'en' : 'zh'); } catch {}
  }

  // 首次捕获中文原文，存到元素上，供切回 zh 还原
  function capture(el, prop) {
    const k = '_i18nZh_' + prop;
    if (el[k] === undefined) {
      el[k] = prop === 'text' ? el.textContent
            : prop === 'html' ? el.innerHTML
            : prop === 'ph' ? el.getAttribute('placeholder')
            : prop === 'title' ? el.getAttribute('title')
            : prop === 'aria' ? el.getAttribute('aria-label')
            : null;
    }
    return el[k];
  }
  function setProp(el, prop, val) {
    if (val == null) return;
    if (prop === 'text') el.textContent = val;
    else if (prop === 'html') el.innerHTML = val;
    else if (prop === 'ph') el.setAttribute('placeholder', val);
    else if (prop === 'title') el.setAttribute('title', val);
    else if (prop === 'aria') el.setAttribute('aria-label', val);
  }

  const SPECS = [
    ['[data-i18n]', 'data-i18n', 'text'],
    ['[data-i18n-html]', 'data-i18n-html', 'html'],
    ['[data-i18n-ph]', 'data-i18n-ph', 'ph'],
    ['[data-i18n-title]', 'data-i18n-title', 'title'],
    ['[data-i18n-aria]', 'data-i18n-aria', 'aria'],
  ];

  function apply(lang) {
    for (const [sel, attr, prop] of SPECS) {
      document.querySelectorAll(sel).forEach((el) => {
        const key = el.getAttribute(attr);
        const zh = capture(el, prop);
        // 切英文：有翻译就用，没翻译保留中文（优雅降级）；切中文：还原原文
        setProp(el, prop, lang === 'en' ? (DICT[key] != null ? DICT[key] : zh) : zh);
      });
    }
    document.documentElement.setAttribute('lang', lang === 'en' ? 'en' : 'zh-CN');
  }

  function t(key, zhFallback) {
    if (getLang() === 'en' && DICT[key] != null) return DICT[key];
    return zhFallback != null ? zhFallback : (DICT[key] != null ? DICT[key] : key);
  }

  function set(lang) {
    const v = lang === 'en' ? 'en' : 'zh';
    setPref(v);
    apply(v);
    renderBtn();
    listeners.forEach((cb) => { try { cb(v); } catch {} });
    try { window.dispatchEvent(new CustomEvent('xiyu:langchange', { detail: { lang: v } })); } catch {}
    // 若在某个 companion 上下文（已登录 + 选定 companion），把它的语言也切了，AI 回复随之换
    try {
      const token = localStorage.getItem('xiyu_token');
      const cid = localStorage.getItem('xiyu_companion_id');
      if (token && cid) {
        fetch('/api/companions/' + encodeURIComponent(cid) + '/locale', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
          body: JSON.stringify({ locale: v }),
        }).catch(function () {});
      }
    } catch {}
  }

  // ── 浮动开关（位于主题开关上方）────────────────────────────────────────────
  let _btn = null;
  function renderBtn() {
    if (!_btn) return;
    const en = getLang() === 'en';
    _btn.textContent = en ? 'EN' : '中';
    _btn.title = en ? 'Language: English (click for 中文)' : '语言：中文（点击切换 English）';
  }
  function injectToggle() {
    if (document.getElementById('xiyu-lang-toggle')) return;
    const b = document.createElement('button');
    b.id = 'xiyu-lang-toggle';
    b.setAttribute('aria-label', 'Switch language / 切换语言');
    // 内联定位，避免依赖 glass.css；放在主题开关上方
    b.style.cssText = [
      'position:fixed', 'right:1rem', 'bottom:4.5rem', 'z-index:9999',
      'width:2.5rem', 'height:2.5rem', 'border-radius:9999px', 'border:none',
      'cursor:pointer', 'font-size:0.85rem', 'font-weight:700', 'line-height:1',
      'background:#fff', 'color:#1D1D1F', 'box-shadow:0 4px 16px rgba(0,0,0,0.12)',
    ].join(';');
    _btn = b;
    renderBtn();
    b.addEventListener('click', () => set(getLang() === 'en' ? 'zh' : 'en'));
    document.body.appendChild(b);
  }

  // ── 启动 ──────────────────────────────────────────────────────────────────
  apply(getLang());
  window.XiyuI18n = {
    get lang() { return getLang(); },
    t,
    set,
    apply: () => apply(getLang()),
    onChange: (cb) => { if (typeof cb === 'function') listeners.push(cb); },
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectToggle);
  } else {
    injectToggle();
  }
})();
