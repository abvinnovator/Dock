import { readFileSync } from 'node:fs';
import type { ManifestType } from '@extension/shared';

const packageJson = JSON.parse(readFileSync('./package.json', 'utf8'));

const manifest = {
  manifest_version: 3,
  default_locale: 'en',
  name: '__MSG_extensionName__',
  version: packageJson.version,
  description: '__MSG_extensionDescription__',
  permissions: [
    'storage',
    'tabs',
    'contextMenus',
    'sidePanel',
    'declarativeNetRequest',
    'declarativeNetRequestWithHostAccess',
  ],
  host_permissions: ['<all_urls>'],
  side_panel: {
    default_path: 'side-panel/index.html',
  },
  commands: {
    'bring-companions-front': {
      suggested_key: { default: 'Alt+Shift+D' },
      description: 'Bring all Dock companions to front',
    },
  },
  declarative_net_request: {
    rule_resources: [{
      id: 'dock_rules',
      enabled: true,
      path: 'rules.json',
    }],
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
      matches: ['http://*/*', 'https://*/*'],
      js: ['content/all.iife.js'],
      run_at: 'document_idle',
      all_frames: true,
      match_about_blank: true,
    },
  ],
  web_accessible_resources: [
    {
      resources: ['*.js', '*.css', '*.svg', '*.html', 'icon-16.png', 'icon-32.png', 'icon-48.png', 'icon-128.png'],
      matches: ['*://*/*'],
    },
  ],
} satisfies ManifestType;

export default manifest;
