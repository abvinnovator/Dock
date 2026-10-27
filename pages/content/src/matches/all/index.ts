/**
 * Dock - Content Script
 * 1. Text snippet auto-expansion (do/shortcut -> full text, expands instantly)
 * 2. AI auto-submit: fills and submits prompt on ChatGPT / Gemini / Claude
 * 3. In-Page Floating Panels: Persistent iframe overlays for pinned tabs
 */

// ─── Types ────────────────────────────────────────────────────────────────────

interface Snippet {
  id: string;
  shortcut: string;
  text: string;
}

interface AiPending {
  text: string;
  target: 'chatgpt' | 'gemini' | 'claude';
}

interface PinnedWindow {
  id?: string;
  tabId: number;
  windowId: number;
  url: string;
  title: string;
  favicon?: string;
  width?: number;
  height?: number;
  left?: number;
  top?: number;
  minimized?: boolean;
  mode: 'iframe' | 'companion';
}

let snippets: Snippet[] = [];
let isExpanding = false;

// ─── Load snippets from extension storage ─────────────────────────────────────

function loadSnippets() {
  chrome.storage.local.get(['dock-snippets'], result => {
    snippets = (result['dock-snippets'] as Snippet[]) ?? [];
  });
}
loadSnippets();

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes['dock-snippets']) {
    snippets = (changes['dock-snippets'].newValue as Snippet[]) ?? [];
  }

  // React to pinned windows changes for floating panels
  if (area === 'local' && changes['dock-pinned-windows']) {
    const newPinned = (changes['dock-pinned-windows'].newValue as PinnedWindow[]) ?? [];
    syncFloatingPanels(newPinned);
  }
});

// ─── Universal Snippet Expansion Engine ───────────────────────────────────────
// Works across standard inputs, textareas, contenteditables (Gmail, Slack, Notion,
// Jira, Zendesk), Google Docs (canvas & event target iframe), Google Sheets (formula bar
// and cell editors), Google Slides, Monaco/VSCode, and rich text frameworks.

let keyBuffer = '';
let bufferTimer: ReturnType<typeof setTimeout> | null = null;

function resetKeyBufferTimer() {
  if (bufferTimer) clearTimeout(bufferTimer);
  bufferTimer = setTimeout(() => {
    keyBuffer = '';
  }, 10000);
}

function matchSnippet(text: string): { snippet: Snippet; matchLen: number } | null {
  if (!text || snippets.length === 0) return null;
  let best: { snippet: Snippet; matchLen: number } | null = null;
  for (const s of snippets) {
    if (!s.shortcut || s.shortcut.length < 3) continue;
    if (text.endsWith(s.shortcut)) {
      const before = text.slice(0, text.length - s.shortcut.length);
      if (before === '' || /[\s\n\t\.,;:!\?\(\)\[\]\{\}"']$/.test(before)) {
        if (!best || s.shortcut.length > best.matchLen) {
          best = { snippet: s, matchLen: s.shortcut.length };
        }
      }
    }
  }
  return best;
}

// ─── Context 1: Standard Input / Textarea ─────────────────────────────────────

function expandInInput(
  el: HTMLInputElement | HTMLTextAreaElement,
  matchLen: number,
  replacement: string,
) {
  const pos = el.selectionStart ?? el.value.length;
  const start = Math.max(0, pos - matchLen);
  el.focus();
  el.setSelectionRange(start, pos);

  let ok = false;
  try {
    ok = document.execCommand('insertText', false, replacement);
  } catch {}

  if (!ok || el.value.slice(start, start + replacement.length) !== replacement) {
    // Fallback for React/Vue/Angular controlled inputs
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    const before = el.value.slice(0, start);
    const after = el.value.slice(pos);
    const newVal = before + replacement + after;

    if (nativeSetter) {
      nativeSetter.call(el, newVal);
    } else {
      el.value = newVal;
    }

    el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: replacement }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    const newPos = start + replacement.length;
    el.setSelectionRange(newPos, newPos);
  }
}

// ─── Context 2: ContentEditable Range Finder ──────────────────────────────────

function getBackwardRange(sel: Selection, length: number): Range | null {
  if (!sel.rangeCount) return null;
  const range = sel.getRangeAt(0);
  const endNode = range.endContainer;
  const endOffset = range.endOffset;

  if (endNode.nodeType === Node.TEXT_NODE && endOffset >= length) {
    const r = document.createRange();
    r.setStart(endNode, endOffset - length);
    r.setEnd(endNode, endOffset);
    return r;
  }

  try {
    const root = (endNode.nodeType === Node.ELEMENT_NODE ? endNode : endNode.parentElement)?.closest('[contenteditable="true"]') || document.body;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    const textNodes: Text[] = [];
    let current: Node | null;
    while ((current = walker.nextNode())) {
      textNodes.push(current as Text);
    }

    const currentIndex = textNodes.indexOf(endNode as Text);
    if (currentIndex === -1) {
      return range.cloneRange();
    }

    let remaining = length;
    let startNode: Text = endNode as Text;
    let startOffset = 0;

    for (let i = currentIndex; i >= 0; i--) {
      const node = textNodes[i];
      const nodeLen = (i === currentIndex) ? endOffset : (node.textContent?.length || 0);
      if (nodeLen >= remaining) {
        startNode = node;
        startOffset = nodeLen - remaining;
        remaining = 0;
        break;
      } else {
        remaining -= nodeLen;
      }
    }

    const r = document.createRange();
    r.setStart(startNode, startOffset);
    r.setEnd(endNode, endOffset);
    return r;
  } catch {
    return null;
  }
}

function getTextBeforeCursor(): string {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return '';
  const range = sel.getRangeAt(0);
  const node = range.startContainer;
  if (node.nodeType === Node.TEXT_NODE) {
    return (node.textContent ?? '').slice(0, range.startOffset);
  }
  if (node.nodeType === Node.ELEMENT_NODE) {
    const el = node as HTMLElement;
    return el.innerText || el.textContent || '';
  }
  return '';
}

function expandInContentEditable(matchLen: number, replacement: string) {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return;

  const targetRange = getBackwardRange(sel, matchLen);
  if (targetRange) {
    sel.removeAllRanges();
    sel.addRange(targetRange);

    let ok = false;
    try {
      ok = document.execCommand('insertText', false, replacement);
    } catch {}

    if (!ok) {
      try {
        targetRange.deleteContents();
        const textNode = document.createTextNode(replacement);
        targetRange.insertNode(textNode);

        const newRange = document.createRange();
        newRange.setStartAfter(textNode);
        newRange.setEndAfter(textNode);
        sel.removeAllRanges();
        sel.addRange(newRange);

        const activeEl = document.activeElement;
        activeEl?.dispatchEvent(new InputEvent('input', {
          bubbles: true,
          composed: true,
          inputType: 'insertText',
          data: replacement,
        }));
      } catch (err) {
        console.warn('[Dock] ContentEditable fallback error:', err);
      }
    }
  }
}

// ─── Context 3: Google Docs (Canvas & Event Target Iframe) ────────────────────

async function expandInGoogleDocs(matchLen: number, replacement: string) {
  isExpanding = true;
  try {
    const iframe = document.querySelector<HTMLIFrameElement>('iframe.docs-texteventtarget-iframe') ||
                   document.querySelector<HTMLIFrameElement>('.docs-texteventtarget-iframe');
    const targetDoc = iframe?.contentDocument || document;
    const targetEl = iframe?.contentDocument?.activeElement ||
                     iframe?.contentDocument?.body ||
                     document.activeElement ||
                     document.body;

    // 1. Dispatch Backspace key events to delete shortcut in Google Docs canvas
    for (let i = 0; i < matchLen; i++) {
      const backspaceKeyDown = new KeyboardEvent('keydown', {
        key: 'Backspace',
        code: 'Backspace',
        keyCode: 8,
        which: 8,
        bubbles: true,
        cancelable: true,
        composed: true,
      });
      const backspaceKeyUp = new KeyboardEvent('keyup', {
        key: 'Backspace',
        code: 'Backspace',
        keyCode: 8,
        which: 8,
        bubbles: true,
        cancelable: true,
        composed: true,
      });
      targetEl.dispatchEvent(backspaceKeyDown);
      targetDoc.dispatchEvent(backspaceKeyDown);
      targetEl.dispatchEvent(backspaceKeyUp);
      targetDoc.dispatchEvent(backspaceKeyUp);
    }

    await new Promise(r => setTimeout(r, 15));

    // 2. Insert replacement text
    let inserted = false;
    try {
      inserted = targetDoc.execCommand('insertText', false, replacement);
    } catch {}
    if (!inserted) {
      try {
        inserted = document.execCommand('insertText', false, replacement);
      } catch {}
    }

    // Try Clipboard Event paste
    try {
      const dt = new DataTransfer();
      dt.setData('text/plain', replacement);
      const pasteEvt = new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        composed: true,
        clipboardData: dt,
      });
      targetEl.dispatchEvent(pasteEvt);
      targetDoc.dispatchEvent(pasteEvt);
    } catch {}

    // Try navigator.clipboard and execCommand('paste')
    try {
      await navigator.clipboard.writeText(replacement);
      targetDoc.execCommand('paste');
      document.execCommand('paste');
    } catch {}
  } catch (err) {
    console.warn('[Dock] Google Docs expansion error:', err);
  } finally {
    keyBuffer = '';
    setTimeout(() => { isExpanding = false; }, 150);
  }
}

// ─── Universal Expansion Dispatcher ───────────────────────────────────────────

function triggerExpansion(match: { snippet: Snippet; matchLen: number }, targetHint?: HTMLElement | null) {
  if (isExpanding) return;
  isExpanding = true;

  const isGDocs = window.location.hostname.includes('docs.google.com') && window.location.pathname.includes('/document');
  const target = targetHint ?? (document.activeElement as HTMLElement | null);

  if (isGDocs) {
    expandInGoogleDocs(match.matchLen, match.snippet.text);
    return;
  }

  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
    expandInInput(target, match.matchLen, match.snippet.text);
    keyBuffer = '';
    setTimeout(() => { isExpanding = false; }, 150);
    return;
  }

  const editableEl = target?.isContentEditable
    ? target
    : target?.closest<HTMLElement>('[contenteditable="true"]') ||
      document.querySelector<HTMLElement>('[contenteditable="true"]:focus') ||
      document.querySelector<HTMLElement>('#waffle-rich-text-editor, .cell-input, #t-formula-bar-input');

  if (editableEl) {
    expandInContentEditable(match.matchLen, match.snippet.text);
    keyBuffer = '';
    setTimeout(() => { isExpanding = false; }, 150);
    return;
  }

  // Fallback: try execCommand insertText or clipboard
  try {
    document.execCommand('insertText', false, match.snippet.text);
  } catch {}
  keyBuffer = '';
  setTimeout(() => { isExpanding = false; }, 150);
}

// ─── Global Event Listeners (Input, BeforeInput, KeyDown) ─────────────────────

function handleGlobalKeyDown(e: KeyboardEvent) {
  if (isExpanding) return;

  if (e.key === 'Backspace') {
    if (keyBuffer.length > 0) {
      keyBuffer = keyBuffer.slice(0, -1);
    }
    resetKeyBufferTimer();
    return;
  }

  if (e.key === 'Escape' || e.key === 'Enter') {
    keyBuffer = '';
    return;
  }

  if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
    keyBuffer += e.key;
    if (keyBuffer.length > 60) {
      keyBuffer = keyBuffer.slice(-60);
    }
    resetKeyBufferTimer();

    const match = matchSnippet(keyBuffer);
    if (match) {
      setTimeout(() => {
        triggerExpansion(match, e.target as HTMLElement);
      }, 0);
    }
  }
}

function handleGlobalInput(e: Event) {
  if (isExpanding) return;

  const target = (e.target ?? document.activeElement) as HTMLElement | null;

  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
    const pos = target.selectionStart ?? target.value.length;
    const textBefore = target.value.slice(0, pos);
    const match = matchSnippet(textBefore);
    if (match) {
      triggerExpansion(match, target);
    }
    return;
  }

  const isGDocs = window.location.hostname.includes('docs.google.com') && window.location.pathname.includes('/document');
  if (isGDocs) {
    const match = matchSnippet(keyBuffer);
    if (match) {
      triggerExpansion(match, target);
    }
    return;
  }

  const editableEl = target?.isContentEditable
    ? target
    : target?.closest<HTMLElement>('[contenteditable="true"]');

  if (editableEl) {
    const textBefore = getTextBeforeCursor();
    const match = matchSnippet(textBefore) || matchSnippet(keyBuffer);
    if (match) {
      triggerExpansion(match, editableEl);
    }
  }
}

// Register listeners on window and document
window.addEventListener('keydown', handleGlobalKeyDown, true);
document.addEventListener('keydown', handleGlobalKeyDown, true);
document.addEventListener('input', handleGlobalInput, true);
document.addEventListener('beforeinput', handleGlobalInput, true);

// Reset buffer on mouse click or window blur
window.addEventListener('mousedown', () => { keyBuffer = ''; }, true);
window.addEventListener('blur', () => { keyBuffer = ''; }, true);

// ─── Attach to Google Docs dynamic iframes ────────────────────────────────────

function attachGoogleDocsListeners() {
  if (!window.location.hostname.includes('docs.google.com')) return;

  const tryAttach = () => {
    const iframes = document.querySelectorAll<HTMLIFrameElement>(
      'iframe.docs-texteventtarget-iframe, .docs-texteventtarget-iframe, iframe[class*="docs-"]',
    );
    iframes.forEach(iframe => {
      try {
        const doc = iframe.contentDocument || iframe.contentWindow?.document;
        if (doc && !(doc as any).__dock_listener_attached) {
          (doc as any).__dock_listener_attached = true;
          doc.addEventListener('keydown', handleGlobalKeyDown, true);
          doc.addEventListener('input', handleGlobalInput, true);
          doc.addEventListener('beforeinput', handleGlobalInput, true);
        }
      } catch {}
    });
  };

  tryAttach();
  const obs = new MutationObserver(tryAttach);
  obs.observe(document.body || document.documentElement, { childList: true, subtree: true });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', attachGoogleDocsListeners);
} else {
  attachGoogleDocsListeners();
}

// ─── AI Auto-Submit ───────────────────────────────────────────────────────────

const AI_SELECTORS: Record<
  string,
  { target: AiPending['target']; inputs: string[]; submits: string[] }
> = {
  'chatgpt.com': {
    target: 'chatgpt',
    inputs: ['#prompt-textarea', 'div[contenteditable="true"][data-lexical-editor]'],
    submits: ['button[data-testid="send-button"]', 'button[aria-label*="Send"]'],
  },
  'gemini.google.com': {
    target: 'gemini',
    inputs: ['.ql-editor', 'rich-textarea [contenteditable="true"]', '[contenteditable="true"]'],
    submits: ['.send-button', 'button[aria-label*="Send"]', 'button[aria-label*="send"]'],
  },
  'claude.ai': {
    target: 'claude',
    inputs: ['.ProseMirror[contenteditable="true"]', 'div[contenteditable="true"]'],
    submits: ['button[aria-label="Send message"]', 'button[aria-label*="Send"]', 'button[aria-label*="send"]'],
  },
};

function waitForAny(selectors: string[], timeout = 15000): Promise<HTMLElement | null> {
  return new Promise(resolve => {
    const check = () => {
      for (const sel of selectors) {
        const el = document.querySelector<HTMLElement>(sel);
        if (el) return el;
      }
      return null;
    };

    const found = check();
    if (found) { resolve(found); return; }

    const observer = new MutationObserver(() => {
      const el = check();
      if (el) { observer.disconnect(); resolve(el); }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => { observer.disconnect(); resolve(null); }, timeout);
  });
}

async function handleAiAutoSubmit() {
  const hostname = window.location.hostname;
  const config = Object.entries(AI_SELECTORS).find(([h]) => hostname.includes(h))?.[1];
  if (!config) return;

  const result = await chrome.storage.local.get(['dock-ai-pending']);
  const pending = result['dock-ai-pending'] as AiPending | undefined;
  if (!pending || pending.target !== config.target) return;

  await chrome.storage.local.remove(['dock-ai-pending']);

  const inputEl = await waitForAny(config.inputs);
  if (!inputEl) return;

  await new Promise(r => setTimeout(r, 600));

  isExpanding = true;
  inputEl.focus();

  const range = document.createRange();
  range.selectNodeContents(inputEl);
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(range);
  document.execCommand('insertText', false, pending.text);

  inputEl.dispatchEvent(new InputEvent('input', { bubbles: true, data: pending.text }));

  await new Promise(r => setTimeout(r, 700));
  isExpanding = false;

  const submitEl = await waitForAny(config.submits, 5000);
  if (submitEl && !(submitEl as HTMLButtonElement).disabled) {
    submitEl.click();
  } else {
    inputEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true, composed: true }));
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => setTimeout(handleAiAutoSubmit, 1500));
} else {
  setTimeout(handleAiAutoSubmit, 1500);
}

// ─── In-Page Floating Panel System ────────────────────────────────────────────
// Injects iframe panels into the current page for pinned tabs in "iframe" mode.
// Uses Shadow DOM for CSS isolation from the host page.

const PANEL_HOST_ID = 'dock-panel-host';
const activePanels = new Map<string, HTMLElement>(); // url -> shadow host element

function getPanelStyles(): string {
  return `
    :host {
      all: initial;
      position: fixed;
      z-index: 2147483646;
      pointer-events: none;
    }
    * { box-sizing: border-box; }

    .dock-panel {
      position: fixed;
      width: 420px;
      height: 550px;
      right: 16px;
      bottom: 16px;
      background: #1a1a2e;
      border: 1px solid rgba(255,255,255,0.12);
      border-radius: 10px;
      box-shadow: 0 8px 32px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.06);
      display: flex;
      flex-direction: column;
      overflow: hidden;
      pointer-events: auto;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      transition: opacity 0.2s ease;
    }

    .dock-panel.minimized {
      height: 38px;
    }
    .dock-panel.minimized .dock-panel-body {
      display: none;
    }

    .dock-panel-header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 10px;
      background: #16213e;
      border-bottom: 1px solid rgba(255,255,255,0.08);
      cursor: grab;
      user-select: none;
      min-height: 36px;
      flex-shrink: 0;
    }
    .dock-panel-header:active { cursor: grabbing; }

    .dock-panel-favicon {
      width: 16px;
      height: 16px;
      border-radius: 3px;
      flex-shrink: 0;
    }

    .dock-panel-title {
      color: #e2e8f0;
      font-size: 12px;
      font-weight: 500;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      flex: 1;
    }

    .dock-panel-brand {
      color: rgba(255,255,255,0.3);
      font-size: 10px;
      font-weight: 600;
      letter-spacing: 0.5px;
      flex-shrink: 0;
    }

    .dock-panel-btn {
      background: none;
      border: 1px solid rgba(255,255,255,0.15);
      color: #94a3b8;
      width: 24px;
      height: 24px;
      border-radius: 5px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 13px;
      padding: 0;
      flex-shrink: 0;
      transition: background 0.15s, color 0.15s;
    }
    .dock-panel-btn:hover {
      background: rgba(255,255,255,0.1);
      color: #e2e8f0;
    }
    .dock-panel-btn.close-btn:hover {
      background: rgba(239,68,68,0.3);
      color: #fca5a5;
    }

    .dock-panel-body {
      flex: 1;
      position: relative;
      overflow: hidden;
    }

    .dock-panel-body iframe {
      width: 100%;
      height: 100%;
      border: none;
      background: #fff;
    }

    .dock-panel-loading {
      position: absolute;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      background: #1a1a2e;
      color: #94a3b8;
      font-size: 13px;
    }

    .dock-panel-error {
      position: absolute;
      inset: 0;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      background: #1a1a2e;
      color: #94a3b8;
      font-size: 13px;
      gap: 12px;
      padding: 20px;
      text-align: center;
    }

    .dock-panel-error-btn {
      background: #3b82f6;
      color: #fff;
      border: none;
      padding: 8px 16px;
      border-radius: 6px;
      cursor: pointer;
      font-size: 12px;
      font-weight: 500;
    }
    .dock-panel-error-btn:hover {
      background: #2563eb;
    }

    .dock-resize-handle {
      position: absolute;
      background: transparent;
    }
    .dock-resize-handle.right { top: 0; right: -3px; width: 6px; height: 100%; cursor: ew-resize; }
    .dock-resize-handle.bottom { bottom: -3px; left: 0; width: 100%; height: 6px; cursor: ns-resize; }
    .dock-resize-handle.corner { bottom: -3px; right: -3px; width: 14px; height: 14px; cursor: nwse-resize; }
    .dock-resize-handle.left { top: 0; left: -3px; width: 6px; height: 100%; cursor: ew-resize; }
    .dock-resize-handle.top { top: -3px; left: 0; width: 100%; height: 6px; cursor: ns-resize; }
  `;
}

function createFloatingPanel(pin: PinnedWindow): HTMLElement {
  const host = document.createElement('div');
  host.id = `dock-panel-${btoa(pin.url).slice(0, 12)}`;
  host.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0;z-index:2147483646;pointer-events:none;';

  const shadow = host.attachShadow({ mode: 'closed' });

  const style = document.createElement('style');
  style.textContent = getPanelStyles();
  shadow.appendChild(style);

  // Restore saved position or use defaults
  const savedPos = getSavedPanelPosition(pin.url);
  const panelCount = activePanels.size;
  const defaultRight = 16 + panelCount * 30;
  const defaultBottom = 16 + panelCount * 30;

  const panel = document.createElement('div');
  panel.className = 'dock-panel';
  if (savedPos) {
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
    panel.style.left = savedPos.left + 'px';
    panel.style.top = savedPos.top + 'px';
    panel.style.width = savedPos.width + 'px';
    panel.style.height = savedPos.height + 'px';
  } else {
    panel.style.right = defaultRight + 'px';
    panel.style.bottom = defaultBottom + 'px';
  }

  // Header
  const header = document.createElement('div');
  header.className = 'dock-panel-header';

  if (pin.favicon) {
    const favicon = document.createElement('img');
    favicon.className = 'dock-panel-favicon';
    favicon.src = pin.favicon;
    favicon.onerror = () => { favicon.style.display = 'none'; };
    header.appendChild(favicon);
  }

  const title = document.createElement('span');
  title.className = 'dock-panel-title';
  title.textContent = pin.title || new URL(pin.url).hostname;
  header.appendChild(title);

  const brand = document.createElement('span');
  brand.className = 'dock-panel-brand';
  brand.textContent = 'Dock';
  header.appendChild(brand);

  // Minimize button
  const minimizeBtn = document.createElement('button');
  minimizeBtn.className = 'dock-panel-btn';
  minimizeBtn.title = 'Minimize';
  minimizeBtn.textContent = '_';
  minimizeBtn.addEventListener('click', () => {
    panel.classList.toggle('minimized');
  });
  header.appendChild(minimizeBtn);

  // Open in companion window button
  const popupBtn = document.createElement('button');
  popupBtn.className = 'dock-panel-btn';
  popupBtn.title = 'Open in companion window';
  popupBtn.innerHTML = '&#x2197;'; // arrow
  popupBtn.addEventListener('click', () => {
    removeFloatingPanel(pin.url);
    chrome.runtime.sendMessage({
      type: 'SWITCH_TO_COMPANION',
      url: pin.url,
      title: pin.title,
      favicon: pin.favicon,
      tabId: pin.tabId,
    });
  });
  header.appendChild(popupBtn);

  // Close button
  const closeBtn = document.createElement('button');
  closeBtn.className = 'dock-panel-btn close-btn';
  closeBtn.title = 'Close';
  closeBtn.textContent = 'x';
  closeBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'UNPIN_WINDOW', url: pin.url });
    removeFloatingPanel(pin.url);
  });
  header.appendChild(closeBtn);

  panel.appendChild(header);

  // Body with iframe
  const body = document.createElement('div');
  body.className = 'dock-panel-body';

  const loading = document.createElement('div');
  loading.className = 'dock-panel-loading';
  loading.textContent = 'Loading...';
  body.appendChild(loading);

  const iframe = document.createElement('iframe');
  iframe.src = pin.url;
  iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox');
  iframe.setAttribute('allow', 'clipboard-read; clipboard-write');
  iframe.style.opacity = '0';

  let loadTimeout: ReturnType<typeof setTimeout>;

  iframe.addEventListener('load', () => {
    clearTimeout(loadTimeout);
    loading.style.display = 'none';
    iframe.style.opacity = '1';
  });

  // Timeout: if iframe doesn't load within 8 seconds, it's likely blocked
  loadTimeout = setTimeout(() => {
    // Check if iframe loaded something
    if (iframe.style.opacity === '0') {
      showBlockedError(body, loading, iframe, pin);
    }
  }, 8000);

  body.appendChild(iframe);

  // Resize handles
  const resizeRight = document.createElement('div');
  resizeRight.className = 'dock-resize-handle right';
  body.appendChild(resizeRight);

  const resizeBottom = document.createElement('div');
  resizeBottom.className = 'dock-resize-handle bottom';
  body.appendChild(resizeBottom);

  const resizeCorner = document.createElement('div');
  resizeCorner.className = 'dock-resize-handle corner';
  body.appendChild(resizeCorner);

  const resizeLeft = document.createElement('div');
  resizeLeft.className = 'dock-resize-handle left';
  body.appendChild(resizeLeft);

  panel.appendChild(body);
  shadow.appendChild(panel);

  // Drag functionality
  setupDrag(header, panel, pin.url);

  // Resize functionality
  setupResize(resizeRight, panel, 'right', pin.url);
  setupResize(resizeBottom, panel, 'bottom', pin.url);
  setupResize(resizeCorner, panel, 'corner', pin.url);
  setupResize(resizeLeft, panel, 'left', pin.url);

  return host;
}

function showBlockedError(body: HTMLElement, loading: HTMLElement, iframe: HTMLIFrameElement, pin: PinnedWindow) {
  loading.style.display = 'none';
  iframe.style.display = 'none';

  const errorDiv = document.createElement('div');
  errorDiv.className = 'dock-panel-error';
  errorDiv.innerHTML = `
    <div>This site works best in a dedicated companion window</div>
    <div style="font-size:11px;color:#64748b;">Click below to open it in a persistent companion window.</div>
  `;

  const switchBtn = document.createElement('button');
  switchBtn.className = 'dock-panel-error-btn';
  switchBtn.textContent = 'Open in Companion Mode';
  switchBtn.addEventListener('click', () => {
    removeFloatingPanel(pin.url);
    chrome.runtime.sendMessage({
      type: 'SWITCH_TO_COMPANION',
      url: pin.url,
      title: pin.title,
      favicon: pin.favicon,
      tabId: pin.tabId,
    });
  });
  errorDiv.appendChild(switchBtn);

  body.appendChild(errorDiv);
}

function removeFloatingPanel(url: string) {
  const host = activePanels.get(url);
  if (host) {
    host.remove();
    activePanels.delete(url);
  }
}

// ─── Drag and Resize ──────────────────────────────────────────────────────────

function setupDrag(header: HTMLElement, panel: HTMLElement, url: string) {
  let isDragging = false;
  let startX = 0, startY = 0, startLeft = 0, startTop = 0;

  header.addEventListener('mousedown', (e) => {
    if ((e.target as HTMLElement).tagName === 'BUTTON') return;
    isDragging = true;
    startX = e.clientX;
    startY = e.clientY;

    const rect = panel.getBoundingClientRect();
    startLeft = rect.left;
    startTop = rect.top;

    // Convert from right/bottom to left/top positioning
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
    panel.style.left = startLeft + 'px';
    panel.style.top = startTop + 'px';

    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    panel.style.left = (startLeft + dx) + 'px';
    panel.style.top = (startTop + dy) + 'px';
  });

  document.addEventListener('mouseup', () => {
    if (isDragging) {
      isDragging = false;
      savePanelPosition(url, panel);
    }
  });
}

function setupResize(handle: HTMLElement, panel: HTMLElement, direction: string, url: string) {
  let isResizing = false;
  let startX = 0, startY = 0, startW = 0, startH = 0, startLeft = 0;

  handle.addEventListener('mousedown', (e) => {
    isResizing = true;
    startX = e.clientX;
    startY = e.clientY;
    const rect = panel.getBoundingClientRect();
    startW = rect.width;
    startH = rect.height;
    startLeft = rect.left;
    e.preventDefault();
    e.stopPropagation();
  });

  document.addEventListener('mousemove', (e) => {
    if (!isResizing) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;

    if (direction === 'right' || direction === 'corner') {
      panel.style.width = Math.max(280, startW + dx) + 'px';
    }
    if (direction === 'bottom' || direction === 'corner') {
      panel.style.height = Math.max(200, startH + dy) + 'px';
    }
    if (direction === 'left') {
      const newWidth = Math.max(280, startW - dx);
      panel.style.width = newWidth + 'px';
      panel.style.left = (startLeft + (startW - newWidth)) + 'px';
      panel.style.right = 'auto';
    }
  });

  document.addEventListener('mouseup', () => {
    if (isResizing) {
      isResizing = false;
      savePanelPosition(url, panel);
    }
  });
}

// ─── Position Persistence ─────────────────────────────────────────────────────

function savePanelPosition(url: string, panel: HTMLElement) {
  const rect = panel.getBoundingClientRect();
  const positions = JSON.parse(localStorage.getItem('dock-panel-positions') || '{}');
  positions[url] = {
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
  };
  localStorage.setItem('dock-panel-positions', JSON.stringify(positions));
}

function getSavedPanelPosition(url: string): { left: number; top: number; width: number; height: number } | null {
  try {
    const positions = JSON.parse(localStorage.getItem('dock-panel-positions') || '{}');
    return positions[url] || null;
  } catch {
    return null;
  }
}

// ─── Panel Sync (reacts to storage changes) ───────────────────────────────────

let isCompanionTab = false;

function syncFloatingPanels(pinnedList: PinnedWindow[]) {
  // Never inject or sync panels inside iframes or companion windows
  if (window.self !== window.top || isCompanionTab) return;

  const iframePins = pinnedList.filter(p => p.mode === 'iframe');
  const iframeUrls = new Set(iframePins.map(p => p.url));

  // Remove panels that are no longer pinned
  for (const [url] of activePanels) {
    if (!iframeUrls.has(url)) {
      removeFloatingPanel(url);
    }
  }

  // Add panels for newly pinned URLs
  for (const pin of iframePins) {
    if (!activePanels.has(pin.url)) {
      const host = createFloatingPanel(pin);
      document.body.appendChild(host);
      activePanels.set(pin.url, host);
    }
  }
}

// ─── Initialize floating panels on page load ─────────────────────────────────

function initFloatingPanels() {
  // Never inject panels inside iframes, chrome pages, or extension pages
  if (window.self !== window.top) return;
  if (window.location.protocol === 'chrome-extension:' || window.location.protocol === 'chrome:') return;

  // Check if this window was opened as a companion window
  try {
    chrome.runtime.sendMessage({ type: 'IS_COMPANION_TAB' }, (res) => {
      if (chrome.runtime.lastError || res?.isCompanion) {
        isCompanionTab = true;
        // Clean up any panels if already created
        for (const [, host] of activePanels) {
          host.remove();
        }
        activePanels.clear();
        return;
      }

      chrome.storage.local.get(['dock-pinned-windows'], result => {
        const pinned = (result['dock-pinned-windows'] as PinnedWindow[]) ?? [];
        syncFloatingPanels(pinned);
      });
    });
  } catch {}
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initFloatingPanels);
} else {
  initFloatingPanels();
}

// Re-inject if host page removes our elements (only on normal tabs)
const panelObserver = new MutationObserver(() => {
  if (window.self !== window.top || isCompanionTab) return;
  for (const [url, host] of activePanels) {
    if (!document.body.contains(host)) {
      document.body.appendChild(host);
    }
  }
});
panelObserver.observe(document.body, { childList: true });

