import { readFileSync } from 'node:fs';
import type { ManifestType } from '@extension/shared';

const packageJson = JSON.parse(readFileSync('./package.json', 'utf8'));

const AI_SITES = ['https://chatgpt.com/*', 'https://claude.ai/*', 'https://gemini.google.com/*'];

const manifest = {
  manifest_version: 3,
  default_locale: 'en',
  name: '__MSG_extensionName__',
  version: packageJson.version,
  description: '__MSG_extensionDescription__',
  permissions: ['storage', 'tabs', 'contextMenus', 'scripting', 'activeTab', 'sidePanel'],
  // Requested per site: when the user picks a field on that site to ship text to,
  // or sends an image from it to an AI.
  optional_host_permissions: ['https://*/*', 'http://*/*'],
  side_panel: {
    default_path: 'popup/index.html',
  },
  commands: {
    'ship-selection': {
      suggested_key: { default: 'Alt+Shift+S' },
      description: 'Ship selected text to your last-used destination',
    },
  },
  background: {
    service_worker: 'background.js',
    type: 'module',
  },
  action: {
    default_popup: 'popup/index.html',
    default_icon: {
      '16': 'icon-16.png',
      '32': 'icon-32.png',
    },
  },
  icons: {
    '16': 'icon-16.png',
    '32': 'icon-32.png',
    '48': 'icon-48.png',
    '128': 'icon-128.png',
  },
  content_scripts: [
    {
      matches: AI_SITES,
      js: ['content/ai.iife.js'],
      run_at: 'document_idle',
    },
  ],
} satisfies ManifestType;

export default manifest;
