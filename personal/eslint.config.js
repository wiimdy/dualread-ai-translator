import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'native/vendor/**', 'native/**/node_modules/**', 'native/dist/**', 'native/runtime/**', '**/.omx/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { files: ['**/*.{js,mjs,cjs}'], languageOptions: { globals: { ...globals.node, ...globals.browser, chrome: 'readonly' } } },
  { files: ['src/**/*.ts'], languageOptions: { globals: { ...globals.browser, chrome: 'readonly' } } },
);
