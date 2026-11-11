/**
 * Dock - AI auto-submit content script (ChatGPT, Claude, Gemini only).
 * Picks up the request the background stored in 'dock-ai-pending', attaches the
 * image (if any), fills the prompt and submits it.
 */

interface AiPending {
  text: string;
  target: 'chatgpt' | 'gemini' | 'claude';
  imageDataUrl?: string;
  createdAt?: number;
}

// Requests older than this are ignored, so a stale one never fires on a later visit.
const PENDING_MAX_AGE_MS = 2 * 60 * 1000;

const AI_SELECTORS: Record<string, { target: AiPending['target']; inputs: string[]; submits: string[] }> = {
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

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const findFirst = (selectors: string[]): HTMLElement | null => {
  for (const sel of selectors) {
    const el = document.querySelector<HTMLElement>(sel);
    if (el) return el;
  }
  return null;
};

const waitForAny = (selectors: string[], timeout = 15000): Promise<HTMLElement | null> =>
  new Promise(resolve => {
    const found = findFirst(selectors);
    if (found) {
      resolve(found);
      return;
    }

    const observer = new MutationObserver(() => {
      const el = findFirst(selectors);
      if (el) {
        observer.disconnect();
        resolve(el);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => {
      observer.disconnect();
      resolve(null);
    }, timeout);
  });

// Waits for a send button that is enabled; it stays disabled while an image uploads.
const waitForEnabledSubmit = async (selectors: string[], timeout: number): Promise<HTMLElement | null> => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const el = findFirst(selectors);
    if (el && !(el as HTMLButtonElement).disabled && el.getAttribute('aria-disabled') !== 'true') return el;
    await sleep(250);
  }
  return null;
};

const dataUrlToFile = (dataUrl: string): File | null => {
  const match = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(dataUrl);
  if (!match) return null;
  const [, mime, isBase64, payload] = match;
  const binary = isBase64 ? atob(payload) : decodeURIComponent(payload);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const ext = mime.split('/')[1]?.replace('jpeg', 'jpg').replace(/\+.*/, '') || 'png';
  return new File([bytes], `image.${ext}`, { type: mime });
};

// The chat apps all accept pasted image files.
const attachImage = (inputEl: HTMLElement, file: File) => {
  const dataTransfer = new DataTransfer();
  dataTransfer.items.add(file);
  inputEl.focus();
  inputEl.dispatchEvent(
    new ClipboardEvent('paste', { clipboardData: dataTransfer, bubbles: true, cancelable: true, composed: true }),
  );
};

const insertText = (inputEl: HTMLElement, text: string) => {
  inputEl.focus();
  if (inputEl instanceof HTMLTextAreaElement) {
    inputEl.value = text;
  } else {
    const range = document.createRange();
    range.selectNodeContents(inputEl);
    range.collapse(false);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    document.execCommand('insertText', false, text);
  }
  inputEl.dispatchEvent(new InputEvent('input', { bubbles: true, data: text }));
};

const handleAiAutoSubmit = async () => {
  const hostname = window.location.hostname;
  const config = Object.entries(AI_SELECTORS).find(([h]) => hostname === h || hostname.endsWith('.' + h))?.[1];
  if (!config) return;

  const result = await chrome.storage.local.get(['dock-ai-pending']);
  const pending = result['dock-ai-pending'] as AiPending | undefined;
  if (!pending || pending.target !== config.target) return;

  await chrome.storage.local.remove(['dock-ai-pending']);
  if (pending.createdAt && Date.now() - pending.createdAt > PENDING_MAX_AGE_MS) return;

  const inputEl = await waitForAny(config.inputs);
  if (!inputEl) return;
  await sleep(600);

  const imageFile = pending.imageDataUrl ? dataUrlToFile(pending.imageDataUrl) : null;
  if (imageFile) {
    attachImage(inputEl, imageFile);
    await sleep(800);
  }

  if (pending.text) {
    insertText(inputEl, pending.text);
  }
  await sleep(700);

  const submitEl = await waitForEnabledSubmit(config.submits, imageFile ? 30000 : 5000);
  if (submitEl) {
    submitEl.click();
  } else if (!imageFile) {
    inputEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true, composed: true }));
  }
  // If an image upload never finished, leave the prompt filled for the user to send.
};

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => setTimeout(handleAiAutoSubmit, 1500));
} else {
  setTimeout(handleAiAutoSubmit, 1500);
}
