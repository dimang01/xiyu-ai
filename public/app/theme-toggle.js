/**
 * 溪语AI - 主题切换控制器
 * 支持深色/浅色模式切换，带本地存储记忆
 */

(function() {
  'use strict';

  const STORAGE_KEY = 'xiyu-theme';
  const DARK_CLASS = 'dark';
  const DARK_ATTR = 'data-theme';

  // 获取保存的主题或系统偏好
  function getSavedTheme() {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) return saved;
    
    // 检测系统偏好
    if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
      return 'dark';
    }
    return 'light';
  }

  // 应用主题
  function applyTheme(theme) {
    const html = document.documentElement;
    
    if (theme === 'dark') {
      html.classList.add(DARK_CLASS);
      html.setAttribute(DARK_ATTR, 'dark');
    } else {
      html.classList.remove(DARK_CLASS);
      html.setAttribute(DARK_ATTR, 'light');
    }
    
    localStorage.setItem(STORAGE_KEY, theme);
    
    // 更新 meta theme-color
    const metaThemeColor = document.querySelector('meta[name="theme-color"]');
    if (metaThemeColor) {
      metaThemeColor.content = theme === 'dark' ? '#0a0a12' : '#FAF7FB';
    }
  }

  // 切换主题
  function toggleTheme() {
    const current = document.documentElement.getAttribute(DARK_ATTR) || 'light';
    const next = current === 'dark' ? 'light' : 'dark';
    applyTheme(next);
  }

  // 创建切换按钮
  function createToggleButton() {
    const button = document.createElement('button');
    button.className = 'theme-toggle';
    button.setAttribute('aria-label', '切换主题');
    button.setAttribute('title', '切换深色/浅色模式');
    
    // 太阳图标 (深色模式下显示)
    button.innerHTML = `
      <svg class="icon-sun" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="5"/>
        <line x1="12" y1="1" x2="12" y2="3"/>
        <line x1="12" y1="21" x2="12" y2="23"/>
        <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/>
        <line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/>
        <line x1="1" y1="12" x2="3" y2="12"/>
        <line x1="21" y1="12" x2="23" y2="12"/>
        <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/>
        <line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>
      </svg>
      <svg class="icon-moon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
      </svg>
    `;
    
    button.addEventListener('click', toggleTheme);
    
    document.body.appendChild(button);
  }

  // 监听系统主题变化
  function watchSystemTheme() {
    if (!window.matchMedia) return;
    
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
      // 只有在用户没有手动设置过主题时才跟随系统
      if (!localStorage.getItem(STORAGE_KEY)) {
        applyTheme(e.matches ? 'dark' : 'light');
      }
    });
  }

  // 初始化
  function init() {
    // 立即应用保存的主题（避免闪烁）
    applyTheme(getSavedTheme());
    
    // DOM 加载后创建按钮
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => {
        createToggleButton();
        watchSystemTheme();
      });
    } else {
      createToggleButton();
      watchSystemTheme();
    }
  }

  // 暴露给全局
  window.xiyuTheme = {
    toggle: toggleTheme,
    set: applyTheme,
    get: () => document.documentElement.getAttribute(DARK_ATTR) || 'light'
  };

  // 立即初始化
  init();

})();
