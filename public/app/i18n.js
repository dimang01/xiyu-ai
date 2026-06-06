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
  const TEXT_MAP = window.XIYU_I18N_TEXT || {};   // 「中文原文 → English」整页批量翻译（大页面用，免逐元素加 data-i18n）
  const hasTextMap = Object.keys(TEXT_MAP).length > 0;
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

  // 「按中文原文整页翻译」——大页面用：提供 window.XIYU_I18N_TEXT={中文:'English'} 即可，
  // 无需逐元素加 data-i18n。en 时把匹配的文本节点 / 常见属性换成英文，zh 时还原。
  const SKIP_TAGS = { SCRIPT: 1, STYLE: 1, TEXTAREA: 1, NOSCRIPT: 1 };
  function walkText(lang) {
    if (!hasTextMap || !document.body) return;
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        const p = n.parentNode;
        if (!p || SKIP_TAGS[p.nodeName]) return NodeFilter.FILTER_REJECT;
        if (p.closest && p.closest('[data-i18n],[data-i18n-html],#xiyu-lang-toggle,#xiyu-theme-toggle,#xiyu-theme-bubble')) return NodeFilter.FILTER_REJECT;
        return (n.nodeValue && n.nodeValue.trim()) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      },
    });
    const nodes = [];
    let n; while ((n = w.nextNode())) nodes.push(n);
    nodes.forEach((node) => {
      if (node._i18nOrig === undefined) node._i18nOrig = node.nodeValue;
      const orig = node._i18nOrig, key = orig.trim();
      node.nodeValue = (lang === 'en' && TEXT_MAP[key] != null) ? orig.replace(key, () => TEXT_MAP[key]) : orig;
    });
  }
  function walkAttrs(lang) {
    if (!hasTextMap) return;
    document.querySelectorAll('[placeholder],[title],[aria-label]').forEach((el) => {
      ['placeholder', 'title', 'aria-label'].forEach((a) => {
        if (!el.hasAttribute(a)) return;
        const sk = '_i18nAttr_' + a;
        if (el[sk] === undefined) el[sk] = el.getAttribute(a);
        const orig = el[sk]; if (orig == null) return;
        const key = orig.trim();
        el.setAttribute(a, (lang === 'en' && TEXT_MAP[key] != null) ? orig.replace(key, () => TEXT_MAP[key]) : orig);
      });
    });
  }

  function apply(lang) {
    for (const [sel, attr, prop] of SPECS) {
      document.querySelectorAll(sel).forEach((el) => {
        const key = el.getAttribute(attr);
        const zh = capture(el, prop);
        // 切英文：有翻译就用，没翻译保留中文（优雅降级）；切中文：还原原文
        setProp(el, prop, lang === 'en' ? (DICT[key] != null ? DICT[key] : zh) : zh);
      });
    }
    walkText(lang);
    walkAttrs(lang);
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
