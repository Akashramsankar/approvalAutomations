import { defineConfig } from 'vitest/config';

const TESTABLE_RUNTIME_FILES = [
  '/server/server.js',
  '/app/scripts/app.js',
  '/app/scripts/runtime.js',
  '/app/scripts/sidebar.js'
];

function exposeRuntimeInternalsForTests() {
  return {
    name: 'expose-runtime-internals-for-tests',
    enforce: 'pre',
    transform(code, id) {
      const normalizedId = id.replace(/\\/g, '/');
      if (!TESTABLE_RUNTIME_FILES.some((file) => normalizedId.endsWith(file))) {
        return null;
      }

      const functionNames = Array.from(
        code.matchAll(/^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/gm),
        (match) => match[1]
      );
      let transformed = code;
      const exports = [`export const __testApi__ = { ${functionNames.join(', ')} };`];

      if (normalizedId.endsWith('/server/server.js')) {
        transformed = transformed
          .replace(
            'const { APP_SLUG, APP_VERSION } = require("./app_metadata");',
            'const APP_SLUG = "freshdesk-approvals-automation-pro";\nconst APP_VERSION = "test";'
          )
          .replace('\nexports = {', '\nconst fdkExports = {');
        exports.push('export const __handlers__ = fdkExports;');
      }

      return {
        code: `${transformed}\n${exports.join('\n')}\n`,
        map: null
      };
    }
  };
}

export default defineConfig({
  plugins: [exposeRuntimeInternalsForTests()],
  test: {
    globals: true,
    environment: 'jsdom',
    coverage: {
      provider: 'v8',
      reportsDirectory: 'coverage/unit',
      reporter: ['json', 'text'],
      include: ['server/**/*.js', 'app/scripts/**/*.js']
    },
    environmentMatchGlobs: [
      ['tests/server*.js', 'node'],
      ['tests/app*.js', 'jsdom']
    ]
  }
});
