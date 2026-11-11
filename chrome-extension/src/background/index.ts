import { dockDestinationsStorage, dockShipmentsStorage } from '@extension/storage';
import type { Destination, FieldSpec, PlaceMode } from '@extension/storage';

// ─── Types ────────────────────────────────────────────────────────────────────

type AiTarget = 'chatgpt' | 'gemini' | 'claude';
type MenuContext = 'text' | 'image';

const AI_LABELS: Record<AiTarget, string> = { chatgpt: 'ChatGPT', claude: 'Claude', gemini: 'Gemini' };

interface PendingRequest {
  selectedText?: string;
  imageUrl?: string;
  context: MenuContext;
  aiTarget: AiTarget;
}

interface SourcePage {
  tabId: number;
  windowId: number;
  url?: string;
  title?: string;
}

// A field-picking round trip: from the destination chooser, through the picker
// overlay on the destination page, back to the page the text came from.
interface PickSession {
  text?: string;
  source?: SourcePage;
  // Set when re-picking the field of an existing destination.
  destinationId?: string;
}

interface ShipResult {
  ok: boolean;
  error?: string;
  // Google Sheets: the row that was filled.
  row?: number;
}

// ─── Session State ────────────────────────────────────────────────────────────
// Kept in storage.session so it survives the service worker being suspended, and
// is cleared automatically when the browser restarts.

const PICKER_KEY_PREFIX = 'dock-picker-';
const PICK_KEY = 'dock-pick';

const setPickerRequest = (windowId: number, request: PendingRequest) =>
  chrome.storage.session.set({ [PICKER_KEY_PREFIX + windowId]: request });

const getPickerRequest = async (windowId: number): Promise<PendingRequest | null> => {
  const key = PICKER_KEY_PREFIX + windowId;
  const result = await chrome.storage.session.get(key);
  return (result[key] as PendingRequest | undefined) ?? null;
};

const clearPickerRequest = (windowId: number) => chrome.storage.session.remove(PICKER_KEY_PREFIX + windowId);

const getPickSession = async (): Promise<PickSession | null> => {
  const result = await chrome.storage.session.get(PICK_KEY);
  return (result[PICK_KEY] as PickSession | undefined) ?? null;
};

const setPickSession = (session: PickSession) => chrome.storage.session.set({ [PICK_KEY]: session });

const clearPickSession = () => chrome.storage.session.remove(PICK_KEY);

chrome.windows.onRemoved.addListener(clearPickerRequest);

// ─── Helpers ──────────────────────────────────────────────────────────────────

const isWebUrl = (url?: string): url is string => !!url && /^https?:\/\//i.test(url);

const originPattern = (url: string) => `${new URL(url).origin}/*`;

const hostnameOf = (url?: string) => {
  try {
    return new URL(url ?? '').hostname.replace(/^www\./, '');
  } catch {
    return url ?? '';
  }
};

// Compares pages ignoring query, hash and trailing slash, so e.g. a notes app on
// #note/123 still counts as the saved page.
const samePage = (a: string, b: string) => {
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    const path = (u: URL) => u.pathname.replace(/\/+$/, '');
    return ua.origin === ub.origin && path(ua) === path(ub);
  } catch {
    return a === b;
  }
};

const getTab = async (tabId?: number) => {
  if (tabId === undefined) return null;
  try {
    return await chrome.tabs.get(tabId);
  } catch {
    return null;
  }
};

const waitForTabComplete = (tabId: number, timeoutMs = 20000) =>
  new Promise<void>(resolve => {
    const done = () => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve();
    };
    const onUpdated = (id: number, info: chrome.tabs.TabChangeInfo) => {
      if (id === tabId && info.status === 'complete') done();
    };
    const timer = setTimeout(done, timeoutMs);
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs
      .get(tabId)
      .then(tab => tab.status === 'complete' && done())
      .catch(done);
  });

const focusTab = async (tab: { id?: number; windowId: number }) => {
  await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
  if (tab.id !== undefined) await chrome.tabs.update(tab.id, { active: true }).catch(() => {});
};

// Briefly marks the toolbar icon, so the user sees the result without leaving the page.
const flashBadge = (ok: boolean) => {
  chrome.action.setBadgeBackgroundColor({ color: ok ? '#16a34a' : '#dc2626' });
  chrome.action.setBadgeText({ text: ok ? '✓' : '!' });
  setTimeout(() => chrome.action.setBadgeText({ text: '' }), 2500);
};

// ─── Injected Functions ───────────────────────────────────────────────────────
// These run inside web pages via chrome.scripting, so they must not reference
// anything outside their own body.

const readPageSelection = (): string => {
  const active = document.activeElement;
  if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
    const { selectionStart, selectionEnd, value } = active;
    if (selectionStart !== null && selectionEnd !== null && selectionEnd > selectionStart) {
      return value.slice(selectionStart, selectionEnd);
    }
  }
  return window.getSelection()?.toString() ?? '';
};

const showPageToast = (message: string, ok: boolean) => {
  const HOST_ID = 'dock-ship-toast';
  document.getElementById(HOST_ID)?.remove();
  const host = document.createElement('div');
  host.id = HOST_ID;
  host.style.cssText = 'all: initial; position: fixed; z-index: 2147483647; right: 20px; bottom: 20px;';
  const root = host.attachShadow({ mode: 'closed' });
  const box = document.createElement('div');
  box.textContent = message;
  box.style.cssText = [
    'font: 600 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    `background: ${ok ? '#ffffff' : '#1a0000'}`,
    `color: ${ok ? '#000000' : '#ffb4b4'}`,
    `border: 1px solid ${ok ? '#ffffff' : '#dc2626'}`,
    'border-radius: 8px',
    'padding: 9px 14px',
    'max-width: 360px',
    'box-shadow: 0 8px 28px rgba(0, 0, 0, 0.35)',
    'transition: opacity 0.25s ease, transform 0.25s ease',
    'opacity: 0',
    'transform: translateY(6px)',
  ].join(';');
  root.appendChild(box);
  document.documentElement.appendChild(host);
  requestAnimationFrame(() => {
    box.style.opacity = '1';
    box.style.transform = 'none';
  });
  setTimeout(
    () => {
      box.style.opacity = '0';
      setTimeout(() => host.remove(), 300);
    },
    ok ? 2600 : 4500,
  );
};

// Places text into the destination the way a user pasting would, so the page's
// own scripts see the change. Rich editors (Notion, Google Docs, Sheets) take a
// paste event; plain fields get their value set. Every path checks that the text
// actually landed, so Dock never reports a shipment that didn't happen.
const pasteIntoField = async (
  field: FieldSpec,
  text: string,
  mode: PlaceMode,
  waitMs: number,
  startRow: number | null,
): Promise<{ ok: boolean; error?: string; row?: number }> => {
  const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  const flat = (value: string) => value.replace(/\s+/g, ' ').trim();
  const count = (haystack: string, needle: string) => (needle ? haystack.split(needle).length - 1 : 0);
  // Returns true when the page's editor handled the paste itself.
  const pasteEvent = (target: EventTarget, data: string) => {
    const clipboardData = new DataTransfer();
    clipboardData.setData('text/plain', data);
    const event = new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true });
    target.dispatchEvent(event);
    return event.defaultPrevented;
  };
  const separator = (multiline: boolean) =>
    mode === 'newline' ? (multiline ? '\n' : ' ') : mode === 'comma' ? ', ' : mode === 'space' ? ' ' : '';

  // Google Docs draws text on a canvas; keystrokes and pastes go to a hidden
  // iframe, and land wherever the document's cursor is.
  if (field.tag === 'gdocs') {
    const frame = document.querySelector<HTMLIFrameElement>('iframe.docs-texteventtarget-iframe');
    const doc = frame?.contentDocument;
    const target = doc?.querySelector('[contenteditable="true"]') ?? doc?.body;
    if (!target) return { ok: false, error: 'app-not-ready' };
    const after = mode === 'replace' ? '' : separator(true);
    return pasteEvent(target, text + after) ? { ok: true } : { ok: false, error: 'unconfirmed' };
  }

  // Google Sheets. A destination is a column. All columns on one sheet share the
  // current row: Dock fills this column's cell in that row, or moves down to the
  // next empty one, so each record (Job ID, Description, …) lands on one row.
  if (field.tag === 'gsheets') {
    const nameBox = () => document.querySelector<HTMLInputElement>('#t-name-box');
    const cellRef = () => (nameBox()?.value ?? '').split(':')[0].replace(/\$/g, '').toUpperCase();
    const cellText = () => flat(document.querySelector('#t-formula-bar-input')?.textContent ?? '');
    const activeSheet = () =>
      flat(document.querySelector('.docs-sheet-active-tab .docs-sheet-tab-name')?.textContent ?? '');
    const focused = () => document.activeElement ?? document.body;
    // The grid's own input, remembered before Dock touches the name box.
    const grid = focused() !== nameBox() ? focused() : document.body;
    const press = (target: Element, key: string, keyCode: number, times = 1) => {
      for (let i = 0; i < times; i++) {
        for (const type of ['keydown', 'keyup']) {
          target.dispatchEvent(new KeyboardEvent(type, { key, code: key, keyCode, bubbles: true, cancelable: true }));
        }
      }
    };
    const parse = (ref: string) => {
      const match = /^([A-Z]+)(\d+)$/.exec(ref);
      return match ? { column: match[1], row: Number(match[2]) } : null;
    };
    const columnIndex = (column: string) => [...column].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0);
    const settle = async (want: string) => {
      for (let i = 0; i < 12 && cellRef() !== want; i++) await sleep(80);
      return cellRef() === want;
    };

    // Selects a cell by typing its reference into the name box, the way a user
    // would; falls back to arrow keys.
    let nameBoxIgnored = false;
    const goTo = async (column: string, row: number) => {
      const want = `${column}${row}`;
      const current = cellRef();
      if (current === want) return true;
      const box = nameBox();
      if (box && !nameBoxIgnored) {
        const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        box.focus();
        setValue?.call(box, field.sheet ? `'${field.sheet.replace(/'/g, "''")}'!${want}` : want);
        box.dispatchEvent(new Event('input', { bubbles: true }));
        press(box, 'Enter', 13);
        if (await settle(want)) return true;
        // The sheet didn't take it: put the name box back the way it was.
        nameBoxIgnored = true;
        setValue?.call(box, current);
        press(box, 'Escape', 27);
      }
      // Arrow keys only work within the sheet tab that's open.
      if (field.sheet && activeSheet() && activeSheet() !== field.sheet) return false;
      const here = parse(current);
      if (!here) return false;
      if (grid instanceof HTMLElement) grid.focus();
      const rows = row - here.row;
      const columns = columnIndex(column) - columnIndex(here.column);
      press(grid, rows > 0 ? 'ArrowDown' : 'ArrowUp', rows > 0 ? 40 : 38, Math.abs(rows));
      press(grid, columns > 0 ? 'ArrowRight' : 'ArrowLeft', columns > 0 ? 39 : 37, Math.abs(columns));
      return settle(want);
    };

    const pasteHere = async (row?: number) => {
      const target = focused() !== nameBox() ? focused() : grid;
      if (!pasteEvent(target, text)) return { ok: false, error: 'unconfirmed' };
      for (let i = 0; i < 10 && cellText() !== flat(text); i++) await sleep(150);
      return cellText() === flat(text) ? { ok: true, row } : { ok: false, error: 'unconfirmed' };
    };

    if (!cellRef()) return { ok: false, error: 'app-not-ready' };

    if (field.column && mode !== 'replace') {
      let row = startRow ?? field.row ?? 1;
      for (let moves = 0; ; moves++) {
        if (moves >= 500 || !(await goTo(field.column, row))) return { ok: false, error: 'sheets-cant-move' };
        await sleep(150);
        if (!cellText()) break;
        row++;
      }
      return pasteHere(row);
    }

    // "Always the selected cell", or a destination saved before columns were remembered.
    if (mode !== 'replace') {
      for (let moves = 0; cellText() && moves < 500; moves++) {
        const before = cellRef();
        press(focused(), 'ArrowDown', 40);
        await sleep(120);
        if (cellRef() === before) return { ok: false, error: 'sheets-cant-move' };
      }
    }
    return pasteHere();
  }

  const query = (selector: string) => {
    try {
      return document.querySelector<HTMLElement>(selector);
    } catch {
      return null;
    }
  };
  const escapeAttr = (value: string) => value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const find = () => {
    const bySelector = query(field.selector);
    if (bySelector) return bySelector;
    const fallbacks: [string, string | undefined][] = [
      ['name', field.name],
      ['aria-label', field.ariaLabel],
      ['placeholder', field.placeholder],
    ];
    for (const [attr, value] of fallbacks) {
      const el = value ? query(`${field.tag}[${attr}="${escapeAttr(value)}"]`) : null;
      if (el) return el;
    }
    return null;
  };

  // Pages that were just opened may render their fields a moment after loading.
  let el = find();
  const deadline = Date.now() + waitMs;
  while (!el && Date.now() < deadline) {
    await sleep(250);
    el = find();
  }
  if (!el) return { ok: false, error: 'field-missing' };

  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    if (el.disabled || el.readOnly) return { ok: false, error: 'field-readonly' };
    const multiline = el instanceof HTMLTextAreaElement;
    const current = el.value;
    let next = mode === 'replace' || !current.trim() ? text : current.replace(/\s+$/, '') + separator(multiline) + text;
    if (!multiline) next = next.replace(/\s*\n\s*/g, ' ');
    el.focus({ preventScroll: true });
    // Use the native setter so frameworks that track the value notice the change.
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set;
    if (setter) setter.call(el, next);
    else el.value = next;
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    if (multiline) el.scrollTop = el.scrollHeight;
    return { ok: true };
  }

  if (!el.isContentEditable) return { ok: false, error: 'not-editable' };

  // Block editors like Notion give every paragraph its own editable element, so
  // keep going from the cursor left by the previous shipment when it's still in
  // the same editor; otherwise start at the end of the picked field.
  const root = el.closest<HTMLElement>('.notion-page-content, main, [role="main"], article, form') ?? document.body;
  const active = document.activeElement;
  const selection = window.getSelection();
  const continuing =
    mode !== 'replace' &&
    active instanceof HTMLElement &&
    active.isContentEditable &&
    root.contains(active) &&
    !!selection?.anchorNode &&
    active.contains(selection.anchorNode);
  const target = continuing ? (active as HTMLElement) : el;

  if (!continuing) {
    el.focus({ preventScroll: true });
    const range = document.createRange();
    range.selectNodeContents(el);
    if (mode !== 'replace' && (el.textContent ?? '').trim()) range.collapse(false);
    selection?.removeAllRanges();
    selection?.addRange(range);
  }

  const here = continuing ? (selection?.anchorNode?.textContent ?? '') : (el.textContent ?? '');
  const sep = mode === 'replace' || !here.trim() ? '' : separator(true);
  const before = count(flat(root.textContent ?? ''), flat(text));

  const handled = pasteEvent(target, sep + text);
  if (!handled) {
    const beforeText = target.textContent ?? '';
    if (sep === '\n') {
      document.execCommand('insertParagraph');
      document.execCommand('insertText', false, text);
    } else {
      document.execCommand('insertText', false, sep + text);
    }
    // Some editors ignore execCommand when the tab isn't focused; edit the DOM directly.
    if ((target.textContent ?? '') === beforeText) {
      if (!sep) {
        target.textContent = mode === 'replace' ? text : beforeText + text;
      } else if (sep === '\n') {
        const line = document.createElement('div');
        line.textContent = text;
        target.appendChild(line);
      } else {
        target.appendChild(document.createTextNode(sep + text));
      }
      target.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    }
  }

  // Editors update their content asynchronously and may undo direct DOM edits.
  for (let i = 0; i < 8; i++) {
    await sleep(100);
    if (count(flat(root.textContent ?? ''), flat(text)) > before) return { ok: true };
  }
  return { ok: false, error: 'unconfirmed' };
};

// ─── Shipping ─────────────────────────────────────────────────────────────────

const toast = async (tabId: number | undefined, message: string, ok: boolean) => {
  flashBadge(ok);
  if (tabId === undefined) return;
  await chrome.scripting.executeScript({ target: { tabId }, func: showPageToast, args: [message, ok] }).catch(() => {});
};

const readSelection = async (tabId: number, frameId?: number): Promise<string> => {
  try {
    const target: chrome.scripting.InjectionTarget = { tabId };
    if (frameId !== undefined) target.frameIds = [frameId];
    const [res] = await chrome.scripting.executeScript({ target, func: readPageSelection });
    return typeof res?.result === 'string' ? res.result : '';
  } catch {
    return '';
  }
};

// Finds the destination's tab: the one it was last seen in, or any tab on the same
// page. Opens the page in the background if it isn't open anymore.
const resolveDestinationTab = async (dest: Destination): Promise<{ tab: chrome.tabs.Tab; opened: boolean }> => {
  const url = dest.url!;
  const last = await getTab(dest.tabId);
  if (last?.url && samePage(last.url, url)) return { tab: last, opened: false };

  const tabs = await chrome.tabs.query({});
  const match =
    tabs.find(t => t.url && samePage(t.url, url)) ??
    (last?.url && new URL(last.url).origin === new URL(url).origin ? last : undefined);
  if (match) return { tab: match, opened: false };

  const created = await chrome.tabs.create({ url, active: false });
  await waitForTabComplete(created.id!);
  return { tab: (await getTab(created.id)) ?? created, opened: true };
};

const FIELD_ERRORS: Record<string, string> = {
  'field-missing': 'couldn’t find the field on that page. Open Dock and re-pick it.',
  'field-readonly': 'the field is read-only right now.',
  'not-editable': 'that element doesn’t accept text. Open Dock and re-pick the field.',
  unconfirmed: 'the page didn’t accept the text. Click into the field on that page once, then retry from the Manifest.',
  'app-not-ready': 'the document isn’t ready yet. Try again in a moment.',
  'sheets-cant-move':
    'Sheets didn’t move to the next row, so Dock stopped rather than overwrite a cell. Click an empty cell and retry.',
};

// Some editors only accept input while their tab is showing. Shows the tab for a
// moment, then returns to whatever the user was looking at.
const withTabInFront = async <T>(tab: chrome.tabs.Tab, fn: () => Promise<T>): Promise<T> => {
  const [previous] = await chrome.tabs.query({ active: true, lastFocusedWindow: true, windowType: 'normal' });
  await focusTab(tab);
  await new Promise(resolve => setTimeout(resolve, 300));
  try {
    return await fn();
  } finally {
    if (previous?.id !== undefined && previous.id !== tab.id) await focusTab(previous);
  }
};

// ─── Google Sheets Rows ───────────────────────────────────────────────────────
// Columns on the same sheet share a current row, so a record's fields line up.

const SHEET_ROWS_KEY = 'dock-sheet-rows';

const sheetRowKey = (url: string | undefined, field: FieldSpec | undefined) => {
  const spreadsheetId = /\/spreadsheets\/d\/([^/]+)/.exec(url ?? '')?.[1];
  return spreadsheetId && field?.column ? `${spreadsheetId}|${field.sheet ?? ''}` : null;
};

const getSheetRow = async (key: string) => {
  const rows = (await chrome.storage.local.get(SHEET_ROWS_KEY))[SHEET_ROWS_KEY] as Record<string, number> | undefined;
  return rows?.[key];
};

const setSheetRow = async (key: string, row: number) => {
  const rows = ((await chrome.storage.local.get(SHEET_ROWS_KEY))[SHEET_ROWS_KEY] ?? {}) as Record<string, number>;
  await chrome.storage.local.set({ [SHEET_ROWS_KEY]: { ...rows, [key]: row } });
};

// Shipments run one at a time, so quick right-clicks can't race for the same row.
let shipQueue: Promise<unknown> = Promise.resolve();
const serially = <T>(fn: () => Promise<T>): Promise<T> => {
  const run = shipQueue.then(fn, fn);
  shipQueue = run.catch(() => {});
  return run;
};

const deliver = (dest: Destination, text: string) => serially(() => deliverNow(dest, text));

const deliverNow = async (dest: Destination, text: string): Promise<ShipResult> => {
  if (!dest.url || !dest.field) return { ok: false, error: 'This destination has no field. Re-pick it in Dock.' };

  if (!(await chrome.permissions.contains({ origins: [originPattern(dest.url)] }))) {
    return { ok: false, error: `Dock needs access to ${hostnameOf(dest.url)}. Open Dock and click Allow.` };
  }

  let { tab, opened } = await resolveDestinationTab(dest);
  if (tab.discarded && tab.id !== undefined) {
    await chrome.tabs.reload(tab.id);
    await waitForTabComplete(tab.id);
    tab = (await getTab(tab.id)) ?? tab;
    opened = true;
  }
  if (tab.id === undefined) return { ok: false, error: 'Couldn’t open the destination page.' };

  const tabId = tab.id;
  const rowKey = sheetRowKey(dest.url, dest.field);
  const startRow = rowKey ? ((await getSheetRow(rowKey)) ?? dest.field.row ?? null) : null;
  const paste = async (waitMs: number) => {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId },
      func: pasteIntoField,
      args: [dest.field!, text, dest.mode, waitMs, startRow],
    });
    return (res?.result as ShipResult | undefined) ?? { ok: false };
  };

  try {
    // Google Docs only takes input while showing; elsewhere, try in the background
    // first and bring the tab forward only if the page didn't take the text.
    let result: ShipResult;
    if (dest.field.tag === 'gdocs' && !tab.active) {
      result = await withTabInFront(tab, () => paste(1500));
    } else {
      result = await paste(opened ? 6000 : 1500);
      if (!result.ok && result.error === 'unconfirmed' && !tab.active) {
        result = await withTabInFront(tab, () => paste(1500));
      }
    }
    if (tabId !== dest.tabId) await dockDestinationsStorage.updateDestination(dest.id, { tabId });
    if (result.ok && rowKey && result.row) await setSheetRow(rowKey, result.row);
    if (!result.ok) {
      const reason = FIELD_ERRORS[result.error ?? ''] ?? 'something went wrong.';
      return { ok: false, error: `“${dest.name}”: ${reason}` };
    }
    return { ok: true };
  } catch (err) {
    console.warn('[Dock] ship failed:', err);
    return { ok: false, error: `Couldn’t reach ${hostnameOf(dest.url)}. Reload that tab and try again.` };
  }
};

// Ships text to a destination and records it in the manifest.
const ship = async (dest: Destination, text: string, source?: SourcePage): Promise<ShipResult> => {
  const result = dest.kind === 'collect' ? { ok: true } : await deliver(dest, text);

  await dockShipmentsStorage.addShipment({
    text,
    destinationId: dest.id,
    destinationName: dest.name,
    sourceUrl: source?.url,
    sourceTitle: source?.title,
    ok: result.ok,
    error: result.error,
  });
  await dockDestinationsStorage.updateDestination(dest.id, {
    lastUsedAt: Date.now(),
    ...(result.ok ? { count: dest.count + 1 } : {}),
  });
  return result;
};

const truncate = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

const shipAndReport = async (dest: Destination, text: string, source: SourcePage) => {
  const result = await ship(dest, text, source);
  await toast(
    source.tabId,
    result.ok ? `Shipped “${truncate(text, 40)}” → ${dest.name}` : (result.error ?? 'Couldn’t ship that'),
    result.ok,
  );
};

const getDestination = async (id: string) => (await dockDestinationsStorage.get()).find(d => d.id === id) ?? null;

const mostRecentDestination = async () => {
  const list = await dockDestinationsStorage.get();
  return [...list].sort((a, b) => (b.lastUsedAt ?? b.createdAt) - (a.lastUsedAt ?? a.createdAt))[0] ?? null;
};

// ─── Picking a Destination Field ──────────────────────────────────────────────

const openDestinationChooser = async (session: PickSession) => {
  await setPickSession(session);
  await chrome.windows.create({
    url: chrome.runtime.getURL('popup/index.html') + '?mode=destination-chooser',
    type: 'popup',
    width: 440,
    height: 600,
    focused: true,
  });
};

// Shows the destination page and lets the user click the field to ship into.
const startFieldPick = async (tab: chrome.tabs.Tab) => {
  if (tab.id === undefined) throw new Error('No tab');
  await focusTab(tab);
  if (tab.status !== 'complete') await waitForTabComplete(tab.id);
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content/picker.iife.js'] });
};

const returnToSource = async (session: PickSession | null) => {
  if (!session?.source) return;
  const tab = await getTab(session.source.tabId);
  if (tab) await focusTab(tab);
};

// ─── Keyboard Shortcuts ───────────────────────────────────────────────────────

chrome.commands.onCommand.addListener(async (command, commandTab) => {
  if (command !== 'ship-selection') return;

  const tab = commandTab ?? (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];
  if (tab?.id === undefined) return;
  const source: SourcePage = { tabId: tab.id, windowId: tab.windowId, url: tab.url, title: tab.title };

  const text = (await readSelection(tab.id)).trim();
  if (!text) {
    await toast(tab.id, 'Select some text first, then press the shortcut again.', false);
    return;
  }

  const dest = await mostRecentDestination();
  if (dest) {
    await shipAndReport(dest, text, source);
  } else {
    await openDestinationChooser({ text, source });
  }
});

// ─── Context Menu ─────────────────────────────────────────────────────────────

const SHIP_PREFIX = 'dock-ship-';
const SHIP_NEW_ID = 'dock-ship-new';
const MAX_MENU_DESTINATIONS = 12;

const createMenu = (props: chrome.contextMenus.CreateProperties) =>
  new Promise<void>(resolve => chrome.contextMenus.create(props, () => resolve(void chrome.runtime.lastError)));

const buildMenus = async () => {
  const destinations = (await dockDestinationsStorage.get()).slice(0, MAX_MENU_DESTINATIONS);
  await new Promise<void>(resolve => chrome.contextMenus.removeAll(() => resolve()));

  await createMenu({ id: 'dock-parent', title: 'Dock', contexts: ['selection', 'image'] });
  for (const dest of destinations) {
    await createMenu({
      id: SHIP_PREFIX + dest.id,
      parentId: 'dock-parent',
      title: `Ship to “${truncate(dest.name, 40)}”`,
      contexts: ['selection'],
    });
  }
  await createMenu({
    id: SHIP_NEW_ID,
    parentId: 'dock-parent',
    title: destinations.length ? 'Ship to a new field…' : 'Ship to a field in another tab…',
    contexts: ['selection'],
  });
  await createMenu({ id: 'dock-sep', parentId: 'dock-parent', type: 'separator', contexts: ['selection'] });
  for (const [key, label] of Object.entries(AI_LABELS)) {
    await createMenu({
      id: `dock-text-${key}`,
      parentId: 'dock-parent',
      title: `Ask ${label}`,
      contexts: ['selection'],
    });
  }
  for (const [key, label] of Object.entries(AI_LABELS)) {
    await createMenu({
      id: `dock-img-${key}`,
      parentId: 'dock-parent',
      title: `Send image to ${label}`,
      contexts: ['image'],
    });
  }
};

// Menus are rebuilt whenever destinations are added, renamed or removed.
let menuQueue: Promise<void> = Promise.resolve();
let menuSignature = '';
const rebuildMenus = (force = false) => {
  menuQueue = menuQueue
    .then(async () => {
      const signature = (await dockDestinationsStorage.get()).map(d => `${d.id}:${d.name}`).join('|');
      if (!force && signature === menuSignature) return;
      menuSignature = signature;
      await buildMenus();
    })
    .catch(err => console.warn('[Dock] menu build failed:', err));
};

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes['dock-destinations']) rebuildMenus();
});

const openPromptPicker = async (request: PendingRequest) => {
  const pickerUrl = chrome.runtime.getURL('popup/index.html') + '?mode=prompt-picker';
  const height = request.context === 'image' ? 560 : 460;
  const win = await chrome.windows.create({ url: pickerUrl, type: 'popup', width: 400, height, focused: true });
  if (win.id) await setPickerRequest(win.id, request);
};

const isAiTarget = (key: string): key is AiTarget => key in AI_LABELS;

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const menuId = String(info.menuItemId);

  if (menuId.startsWith(SHIP_PREFIX)) {
    if (tab?.id === undefined) return;
    const source: SourcePage = { tabId: tab.id, windowId: tab.windowId, url: tab.url, title: tab.title };
    // Prefer the live selection: selectionText collapses line breaks.
    const text = ((await readSelection(tab.id, info.frameId)) || info.selectionText || '').trim();
    if (!text) return;

    if (menuId === SHIP_NEW_ID) {
      await openDestinationChooser({ text, source });
      return;
    }
    const dest = await getDestination(menuId.slice(SHIP_PREFIX.length));
    if (dest) await shipAndReport(dest, text, source);
    return;
  }

  const [, kind, aiKey] = menuId.split('-');
  if (!aiKey || !isAiTarget(aiKey)) return;
  if (kind === 'text' && info.selectionText) {
    await openPromptPicker({ selectedText: info.selectionText, context: 'text', aiTarget: aiKey });
  } else if (kind === 'img' && info.srcUrl) {
    await openPromptPicker({ imageUrl: info.srcUrl, context: 'image', aiTarget: aiKey });
  }
});

// ─── Lifecycle ────────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(details => {
  chrome.runtime.setUninstallURL(
    'https://docs.google.com/forms/d/e/1FAIpQLScb5y0IGzQyhToLt-A0XAMZoSJed9_iIMWV4gdhek4AnjBagw/viewform?usp=sharing&ouid=102550442351225860550',
  );

  if (details.reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('install/index.html') });
  }

  // Data from removed features (in-page panels, snippets, companions, workspaces).
  chrome.storage.local.remove([
    'dock-blocked-sites',
    'dock-snippets',
    'dock-pinned-windows',
    'dock-workspaces',
    'dock-startup-workspace',
  ]);

  rebuildMenus(true);
});

chrome.runtime.onStartup.addListener(() => rebuildMenus(true));

// ─── Message Handlers ─────────────────────────────────────────────────────────

const AI_URLS: Record<AiTarget, string> = {
  chatgpt: 'https://chatgpt.com/',
  gemini: 'https://gemini.google.com/app',
  claude: 'https://claude.ai/new',
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const msg = message as { type: string; [key: string]: unknown };

  // Every handler is async; reply once it finishes.
  const reply = (work: Promise<unknown>) => {
    work
      .then(result => sendResponse(result ?? { ok: true }))
      .catch(err => {
        console.warn(`[Dock] ${msg.type} failed:`, err);
        sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
      });
    return true;
  };

  const closeSenderWindow = async () => {
    if (sender.tab?.windowId !== undefined) await chrome.windows.remove(sender.tab.windowId).catch(() => {});
  };

  switch (msg.type) {
    // ── AI prompt picker ─────────────────────────────────────────────────────
    case 'GET_PICKER_DATA': {
      const windowId = sender.tab?.windowId;
      return reply(windowId ? getPickerRequest(windowId).then(data => ({ data })) : Promise.resolve({ data: null }));
    }

    case 'CLOSE_PICKER': {
      const windowId = msg.windowId as number;
      return reply(chrome.windows.remove(windowId).catch(() => {}));
    }

    case 'SEND_TO_AI': {
      const { aiTarget, promptText, selectedText, imageUrl, imageDataUrl, windowId } = msg as {
        type: string;
        aiTarget: AiTarget;
        promptText: string;
        selectedText?: string;
        imageUrl?: string;
        imageDataUrl?: string;
        windowId?: number;
      };

      const parts = [promptText, selectedText];
      // When the image itself couldn't be attached, fall back to its address.
      if (imageUrl && !imageDataUrl) parts.push(`Image: ${imageUrl}`);
      const text = parts.filter(Boolean).join('\n\n').trim();

      return reply(
        (async () => {
          await chrome.storage.local.set({
            'dock-ai-pending': { text, target: aiTarget, imageDataUrl, createdAt: Date.now() },
          });
          await chrome.tabs.create({ url: AI_URLS[aiTarget] });
          if (windowId !== undefined) await chrome.windows.remove(windowId).catch(() => {});
        })(),
      );
    }

    // ── Destination chooser and field picker ─────────────────────────────────
    case 'GET_PICK_SESSION':
      return reply(
        (async () => {
          const session = await getPickSession();
          const dest = session?.destinationId ? await getDestination(session.destinationId) : null;
          return { text: session?.text ?? '', sourceTabId: session?.source?.tabId, destinationName: dest?.name };
        })(),
      );

    case 'OPEN_DESTINATION_CHOOSER':
      return reply(openDestinationChooser({}));

    // The user chose the page (an open tab, or a site to open) holding the field.
    case 'START_FIELD_PICK': {
      const { tabId, url } = msg as { type: string; tabId?: number; url?: string };
      return reply(
        (async () => {
          let tab = await getTab(tabId);
          if (!tab && isWebUrl(url)) {
            const win = await chrome.windows.getLastFocused({ windowTypes: ['normal'] }).catch(() => null);
            tab = await chrome.tabs.create({ url, active: true, ...(win?.id ? { windowId: win.id } : {}) });
          }
          if (!tab) return { ok: false, error: 'That tab is closed.' };
          await startFieldPick(tab);
          await closeSenderWindow();
          return { ok: true };
        })(),
      );
    }

    // "Just collect": ship into the manifest only, no web page.
    case 'CREATE_COLLECTION': {
      const name = String(msg.name ?? '').trim() || 'Collected';
      return reply(
        (async () => {
          const session = await getPickSession();
          const dest = await dockDestinationsStorage.addDestination({ kind: 'collect', name, mode: 'newline' });
          await clearPickSession();
          await closeSenderWindow();
          if (session?.text && session.source) await shipAndReport(dest, session.text, session.source);
          await returnToSource(session);
        })(),
      );
    }

    case 'REPICK_FIELD': {
      const destinationId = msg.destinationId as string;
      return reply(
        (async () => {
          const dest = await getDestination(destinationId);
          if (!dest?.url) return { ok: false, error: 'Destination not found' };
          await setPickSession({ destinationId });
          const { tab } = await resolveDestinationTab(dest);
          await startFieldPick(tab);
          return { ok: true };
        })(),
      );
    }

    // Sent by the picker overlay once the user has clicked the field and named it.
    case 'PICKER_DONE': {
      const { field, name, mode } = msg as { type: string; field: FieldSpec; name: string; mode: PlaceMode };
      const tab = sender.tab;
      return reply(
        (async () => {
          if (!tab?.id || !tab.url) return { ok: false, error: 'No tab' };
          const session = await getPickSession();
          await clearPickSession();

          const page = { url: tab.url, title: tab.title, favicon: tab.favIconUrl, tabId: tab.id, field, mode };
          // The cell the user just clicked is where the next record starts.
          const rowKey = sheetRowKey(tab.url, field);
          if (rowKey && field.row) await setSheetRow(rowKey, field.row);
          let dest: Destination | null;
          if (session?.destinationId) {
            await dockDestinationsStorage.updateDestination(session.destinationId, { ...page, name });
            dest = await getDestination(session.destinationId);
          } else {
            dest = await dockDestinationsStorage.addDestination({ kind: 'field', name, ...page });
          }
          if (!dest) return { ok: false, error: 'Destination not found' };

          if (session?.text && session.source) {
            const result = await ship(dest, session.text, session.source);
            await returnToSource(session);
            await toast(
              session.source.tabId,
              result.ok
                ? `Shipped to “${dest.name}”. Next time: right-click → Dock → Ship to “${dest.name}”.`
                : (result.error ?? 'Couldn’t ship that'),
              result.ok,
            );
          } else {
            await toast(tab.id, `Saved “${dest.name}”. Select text anywhere → right-click → Dock.`, true);
          }
          return { ok: true };
        })(),
      );
    }

    case 'PICKER_CANCEL':
      return reply(
        (async () => {
          const session = await getPickSession();
          await clearPickSession();
          await returnToSource(session);
        })(),
      );

    // ── Destinations and manifest ────────────────────────────────────────────
    case 'OPEN_DESTINATION': {
      const destinationId = msg.destinationId as string;
      return reply(
        (async () => {
          const dest = await getDestination(destinationId);
          if (!dest?.url) return { ok: false, error: 'Destination not found' };
          const { tab } = await resolveDestinationTab(dest);
          await focusTab(tab);
          return { ok: true };
        })(),
      );
    }

    case 'SHIP_AGAIN': {
      const shipmentId = msg.shipmentId as string;
      return reply(
        (async () => {
          const shipment = (await dockShipmentsStorage.get()).find(s => s.id === shipmentId);
          const dest = shipment ? await getDestination(shipment.destinationId) : null;
          if (!shipment || !dest) return { ok: false, error: 'That destination was deleted.' };
          const result = dest.kind === 'collect' ? { ok: true } : await deliver(dest, shipment.text);
          await dockShipmentsStorage.updateShipment(shipment.id, {
            ok: result.ok,
            error: result.error,
            at: Date.now(),
          });
          if (result.ok) await dockDestinationsStorage.updateDestination(dest.id, { count: dest.count + 1 });
          return result;
        })(),
      );
    }

    // ── Side panel ───────────────────────────────────────────────────────────
    case 'OPEN_SIDE_PANEL':
      return reply(
        chrome.windows
          .getLastFocused({ windowTypes: ['normal'] })
          .then(win => (win?.id ? chrome.sidePanel.open({ windowId: win.id }) : undefined)),
      );

    default:
      return undefined;
  }
});
