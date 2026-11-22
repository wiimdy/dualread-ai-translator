import { cp } from 'node:fs/promises';

const source = (relative) => new URL(relative, import.meta.url);
await Promise.all([
  cp(source('../static/'), source('../dist/'), { recursive: true }),
  cp(source('../../shared.js'), source('../dist/shared.js')),
  cp(source('../../_locales/'), source('../dist/_locales/'), { recursive: true }),
  cp(source('../../icons/'), source('../dist/icons/'), { recursive: true }),
  cp(source('../../LICENSE'), source('../dist/LICENSE')),
]);

// The fork's repository root is loadable directly as an unpacked extension.
const entryFiles = ['manifest.json', 'background.js', 'routing.js', 'page.js', 'popup.js',
  'popup.html', 'options.js', 'options.html', 'ui.css'];
await Promise.all(entryFiles.map((file) => cp(source('../dist/' + file), source('../../' + file))));
