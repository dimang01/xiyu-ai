/**
 * ESLint flat config（v1.21.2 PR-A，#263 事故后续）。
 *
 * 定位：抓"静默炸"级别的真 bug（no-const-assign / no-undef / no-dupe-* …），
 * 不做风格审美——风格类规则一律不开，保持与现有代码零摩擦。
 * 红色验证：对 #263 坏版本（v1.20.1 proactive.mjs 的 const systemPrompt +=）
 * 跑 no-const-assign 必须红——CI 见 .github/workflows/ci.yml。
 */
import js from '@eslint/js';

export default [
  js.configs.recommended,
  {
    files: ['src/**/*.mjs', 'scripts/**/*.mjs', 'index.mjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        // Node.js 运行时全局（不引 globals 包，列实际用到的）
        process: 'readonly', console: 'readonly', Buffer: 'readonly',
        setTimeout: 'readonly', clearTimeout: 'readonly',
        setInterval: 'readonly', clearInterval: 'readonly',
        URL: 'readonly', URLSearchParams: 'readonly',
        fetch: 'readonly', AbortSignal: 'readonly', AbortController: 'readonly',
        crypto: 'readonly', structuredClone: 'readonly',
        TextEncoder: 'readonly', TextDecoder: 'readonly',
        FormData: 'readonly', Blob: 'readonly', File: 'readonly',
        Headers: 'readonly', Request: 'readonly', Response: 'readonly',
        atob: 'readonly', btoa: 'readonly', queueMicrotask: 'readonly',
        setImmediate: 'readonly', performance: 'readonly',
      },
    },
    rules: {
      // 真 bug 级规则保持 error（recommended 默认）；以下是对存量的务实调整：
      // 未用变量：函数参数不查（回调签名占位是惯例），变量以 _ 开头豁免
      'no-unused-vars': ['error', { args: 'none', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      // 空块：catch 吞错是本仓刻意模式（fail-open），但必须留注释说明
      'no-empty': ['error', { allowEmptyCatch: true }],
      // 正则控制字符/转义：词表正则里常见，降噪
      'no-control-regex': 'off',
      'no-useless-escape': 'off',
    },
  },
];
