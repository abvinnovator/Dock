import '@src/Popup.css';
import { useStorage, withErrorBoundary, withSuspense } from '@extension/shared';
import { dockDestinationsStorage, dockPromptsStorage, dockShipmentsStorage } from '@extension/storage';
import { LoadingSpinner, ErrorDisplay } from '@extension/ui';
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { Destination, PlaceMode, Prompt, Shipment } from '@extension/storage';
import type { ReactNode } from 'react';

// ─── Helpers ──────────────────────────────────────────────────────────────────

type Tab = 'ship' | 'manifest' | 'ai';

interface MessageResult {
  ok?: boolean;
  error?: string;
}

const send = (message: Record<string, unknown>): Promise<MessageResult> =>
  chrome.runtime.sendMessage(message).catch(err => ({ ok: false, error: String(err) }));

const hostnameOf = (url?: string) => {
  try {
    return new URL(url ?? '').hostname.replace(/^www\./, '');
  } catch {
    return url ?? '';
  }
};

const isWebUrl = (url?: string) => !!url && /^https?:\/\//i.test(url);

const cx = (...classes: (string | false | null | undefined)[]) => classes.filter(Boolean).join(' ');

// The surface is set in index.tsx: the toolbar popup, or a page (side panel / tab).
const isToolbarPopup = () => document.documentElement.dataset.surface === 'popup';

// Chrome won't let extensions run scripts on its own pages or the Web Store.
const canShipTo = (url?: string) =>
  isWebUrl(url) && !/^https:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore)/i.test(url!);

const requestSiteAccess = (url: string) => chrome.permissions.request({ origins: [`${new URL(url).origin}/*`] });

const closeThisWindow = async () => {
  const win = await chrome.windows.getCurrent();
  if (win.id !== undefined) await chrome.windows.remove(win.id);
};

const formatTime = (at: number) => {
  const date = new Date(at);
  const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return date.toDateString() === new Date().toDateString()
    ? time
    : `${date.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`;
};

// ─── Toast ────────────────────────────────────────────────────────────────────

const ToastContext = createContext<(text: string) => void>(() => {});
const useToast = () => useContext(ToastContext);

// ─── Icons ────────────────────────────────────────────────────────────────────

const ICON_PATHS = {
  close: 'M18 6 6 18M6 6l12 12',
  plus: 'M12 5v14M5 12h14',
  check: 'M20 6 9 17l-5-5',
  ship: 'M5 12h14M13 6l6 6-6 6',
  panel: 'M3 4h18v16H3zM15 4v16',
  save: 'M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2zM17 21v-8H7v8M7 3v5h8',
  trash: 'M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14',
  copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
  download: 'M12 3v12M7 10l5 5 5-5M5 21h14',
  target: 'M12 2v4M12 18v4M2 12h4M18 12h4M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z',
  external: 'M14 3h7v7M10 14 21 3M19 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h5',
  inbox: 'M22 12h-6l-2 3h-4l-2-3H2M5.5 5h13L22 12v7H2v-7z',
  list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
  refresh: 'M21 12a9 9 0 1 1-3-6.7L21 8M21 3v5h-5',
  warn: 'M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z',
} as const;

const Icon = ({ name, size = 14 }: { name: keyof typeof ICON_PATHS; size?: number }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true">
    <path d={ICON_PATHS[name]} />
  </svg>
);

const Favicon = ({ src, url }: { src?: string; url?: string }) => {
  const [failed, setFailed] = useState(false);
  if (!src || failed) {
    return <span className="favicon favicon-fallback">{hostnameOf(url).charAt(0).toUpperCase()}</span>;
  }
  return <img className="favicon" src={src} alt="" onError={() => setFailed(true)} />;
};

// ─── Open Tabs ────────────────────────────────────────────────────────────────

interface ChromeTab {
  id: number;
  title: string;
  url: string;
  favIconUrl?: string;
}

// Reloads the open tab list whenever tabs change.
const useOpenTabs = () => {
  const [tabs, setTabs] = useState<ChromeTab[]>([]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = () => {
      chrome.tabs.query({ windowType: 'normal' }, allTabs => {
        setTabs(
          allTabs
            .filter(t => t.id && canShipTo(t.url))
            .map(t => ({ id: t.id!, title: t.title || t.url!, url: t.url!, favIconUrl: t.favIconUrl })),
        );
      });
    };
    const scheduleLoad = () => {
      clearTimeout(timer);
      timer = setTimeout(load, 150);
    };

    load();
    chrome.tabs.onCreated.addListener(scheduleLoad);
    chrome.tabs.onRemoved.addListener(scheduleLoad);
    chrome.tabs.onUpdated.addListener(scheduleLoad);
    return () => {
      clearTimeout(timer);
      chrome.tabs.onCreated.removeListener(scheduleLoad);
      chrome.tabs.onRemoved.removeListener(scheduleLoad);
      chrome.tabs.onUpdated.removeListener(scheduleLoad);
    };
  }, []);

  return tabs;
};

// ─── Ship Panel ───────────────────────────────────────────────────────────────

type ModeOption = { mode: PlaceMode; label: string };

const MODE_OPTIONS: ModeOption[] = [
  { mode: 'newline', label: 'New line' },
  { mode: 'replace', label: 'Replace' },
  { mode: 'comma', label: 'Comma' },
  { mode: 'space', label: 'Space' },
];

// Google Docs and Sheets destinations have no field; they follow the cursor or a column.
const APP_DESTINATIONS: Record<string, { description: string; modes: ModeOption[] }> = {
  gdocs: {
    description: 'Google Docs · types at your cursor',
    modes: MODE_OPTIONS.filter(o => o.mode !== 'replace'),
  },
  gsheets: {
    description: 'Google Sheets',
    modes: [
      { mode: 'newline', label: 'Row by row' },
      { mode: 'replace', label: 'Selected cell' },
    ],
  },
};

const HowItWorks = ({ compact }: { compact: boolean }) => (
  <div className={cx('intro-card', compact && 'compact')}>
    <div className="intro-steps">
      <div className="intro-title">Copy from one tab, land in another — without switching</div>
      {!compact && (
        <p>
          Collecting IDs, names or links from one site into a sheet, form, CRM or notes app? Show Dock the field once.
          After that, every selection ships there in one right-click.
        </p>
      )}
    </div>
    <ol className="steps">
      <li>
        <span className="step-num">1</span>
        <span>
          Select text on any page → right-click → <strong>Dock</strong> → <em>Ship to a field in another tab…</em>
        </span>
      </li>
      <li>
        <span className="step-num">2</span>
        <span>Pick the tab, click the field, and name it — e.g. “SO ID”.</span>
      </li>
      <li>
        <span className="step-num">3</span>
        <span>
          From then on: right-click → <strong>Ship to “SO ID”</strong>, or press <kbd>Alt+Shift+S</kbd>. You stay where
          you are.
        </span>
      </li>
    </ol>
  </div>
);

// Whether Dock may still run on the destination's site; the user can revoke it in Chrome.
const useSiteAccess = (url?: string) => {
  const [granted, setGranted] = useState(true);
  useEffect(() => {
    if (!isWebUrl(url)) return;
    const origins = [`${new URL(url!).origin}/*`];
    const check = () => chrome.permissions.contains({ origins }).then(setGranted);
    check();
    chrome.permissions.onAdded.addListener(check);
    chrome.permissions.onRemoved.addListener(check);
    return () => {
      chrome.permissions.onAdded.removeListener(check);
      chrome.permissions.onRemoved.removeListener(check);
    };
  }, [url]);
  return granted;
};

const DestinationCard = ({
  dest,
  isShortcutTarget,
  onShowShipments,
}: {
  dest: Destination;
  isShortcutTarget: boolean;
  onShowShipments: () => void;
}) => {
  const toast = useToast();
  const [name, setName] = useState(dest.name);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const hasAccess = useSiteAccess(dest.url);
  const isField = dest.kind === 'field';
  const appDestination = dest.field ? APP_DESTINATIONS[dest.field.tag] : undefined;

  useEffect(() => setName(dest.name), [dest.name]);

  const commitName = () => {
    const trimmed = name.trim();
    if (!trimmed) setName(dest.name);
    else if (trimmed !== dest.name) dockDestinationsStorage.updateDestination(dest.id, { name: trimmed });
  };

  const handleRepick = async () => {
    if (!dest.url) return;
    if (!hasAccess && !(await requestSiteAccess(dest.url))) return;
    const res = await send({ type: 'REPICK_FIELD', destinationId: dest.id });
    if (res.ok === false) toast(res.error ?? 'Could not open the page');
    else if (isToolbarPopup()) window.close();
  };

  const handleOpen = async () => {
    const res = await send({ type: 'OPEN_DESTINATION', destinationId: dest.id });
    if (res.ok === false) toast(res.error ?? 'Could not open the page');
  };

  return (
    <div className="dest-card">
      <div className="dest-top">
        {isField ? (
          <Favicon src={dest.favicon} url={dest.url} />
        ) : (
          <span className="dest-kind-icon">
            <Icon name="inbox" size={13} />
          </span>
        )}
        <input
          className="dest-name"
          value={name}
          onChange={e => setName(e.target.value)}
          onBlur={commitName}
          onKeyDown={e => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
          aria-label="Destination name"
          spellCheck={false}
        />
        {isShortcutTarget && <kbd title="Alt+Shift+S ships here (your last-used destination)">Alt+Shift+S</kbd>}
        <button className="dest-count" title="See what was shipped here" onClick={onShowShipments}>
          {dest.count} shipped
        </button>
      </div>

      <div className="dest-sub">
        {appDestination ? (
          <>
            {appDestination.description}
            {dest.field?.column && <> · column {dest.field.column}</>}
            {dest.field?.sheet && <> · {dest.field.sheet}</>}
          </>
        ) : isField ? (
          <>
            {hostnameOf(dest.url)}
            {dest.field?.label && <> · field “{dest.field.label}”</>}
          </>
        ) : (
          'Collected in the Manifest. Copy them into a spreadsheet anytime.'
        )}
      </div>

      {isField && !hasAccess && (
        <div className="dest-warning">
          <Icon name="warn" size={13} />
          <span>Dock can’t reach {hostnameOf(dest.url)} anymore.</span>
          <button className="chip" onClick={() => dest.url && requestSiteAccess(dest.url)}>
            Allow
          </button>
        </div>
      )}

      {isField && (
        <div className="mode-row" role="radiogroup" aria-label="How shipped text is placed">
          {(appDestination?.modes ?? MODE_OPTIONS).map(option => (
            <button
              key={option.mode}
              role="radio"
              aria-checked={dest.mode === option.mode}
              className={cx('mode-chip', dest.mode === option.mode && 'on')}
              onClick={() => dockDestinationsStorage.updateDestination(dest.id, { mode: option.mode })}>
              {option.label}
            </button>
          ))}
        </div>
      )}

      <div className="dest-actions">
        {isField && (
          <>
            <button className="chip" onClick={handleOpen}>
              <Icon name="external" size={12} />
              Open page
            </button>
            <button className="chip" onClick={handleRepick}>
              <Icon name="target" size={12} />
              Re-pick field
            </button>
          </>
        )}
        <button className="chip" onClick={onShowShipments}>
          <Icon name="list" size={12} />
          Shipped
        </button>
        {confirmDelete ? (
          <span className="confirm-inline">
            Delete?
            <button className="chip danger" onClick={() => dockDestinationsStorage.removeDestination(dest.id)}>
              Yes
            </button>
            <button className="chip" onClick={() => setConfirmDelete(false)}>
              No
            </button>
          </span>
        ) : (
          <button className="chip" title="Delete destination" onClick={() => setConfirmDelete(true)}>
            <Icon name="trash" size={12} />
          </button>
        )}
      </div>
    </div>
  );
};

const ShipPanel = ({ onShowShipments }: { onShowShipments: (destinationId: string) => void }) => {
  const toast = useToast();
  const destinations = useStorage(dockDestinationsStorage) as Destination[];

  const shortcutTargetId = [...destinations].sort(
    (a, b) => (b.lastUsedAt ?? b.createdAt) - (a.lastUsedAt ?? a.createdAt),
  )[0]?.id;

  const handleNew = async () => {
    const res = await send({ type: 'OPEN_DESTINATION_CHOOSER' });
    if (res.ok === false) toast(res.error ?? 'Could not open');
    else if (isToolbarPopup()) window.close();
  };

  return (
    <div className="dock-content">
      <HowItWorks compact={destinations.length > 0} />

      <button className="btn btn-primary btn-block" onClick={handleNew}>
        <Icon name="plus" size={13} />
        New destination
      </button>

      {destinations.length > 0 && (
        <section className="section">
          <div className="section-header-row">
            <span className="section-title">Destinations</span>
            <span className="section-badge">{destinations.length}</span>
          </div>
          {destinations.map(dest => (
            <DestinationCard
              key={dest.id}
              dest={dest}
              isShortcutTarget={destinations.length > 1 && dest.id === shortcutTargetId}
              onShowShipments={() => onShowShipments(dest.id)}
            />
          ))}
        </section>
      )}
    </div>
  );
};

// ─── Manifest Panel ───────────────────────────────────────────────────────────

// Quotes a CSV cell, and keeps spreadsheet apps from running text as a formula.
const csvCell = (value: string) => {
  const safe = /^[=+\-@]/.test(value) ? `'${value}` : value;
  return `"${safe.replace(/"/g, '""')}"`;
};

const ManifestPanel = ({ filter, onFilter }: { filter: string; onFilter: (id: string) => void }) => {
  const toast = useToast();
  const shipments = useStorage(dockShipmentsStorage) as Shipment[];
  const destinations = useStorage(dockDestinationsStorage) as Destination[];
  const [confirmClear, setConfirmClear] = useState(false);
  const [retrying, setRetrying] = useState<string | null>(null);

  const visible = filter === 'all' ? shipments : shipments.filter(s => s.destinationId === filter);
  const delivered = visible.filter(s => s.ok);
  const newestFirst = [...visible].reverse();

  const copyText = async (text: string, message: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast(message);
    } catch {
      toast('Could not copy to the clipboard');
    }
  };

  // One item per line, oldest first: pastes into a spreadsheet as a column.
  const handleCopyColumn = () =>
    copyText(
      delivered.map(s => s.text.replace(/\s*\r?\n\s*/g, ' ')).join('\n'),
      `Copied ${delivered.length} — paste into a spreadsheet column`,
    );

  const handleDownloadCsv = () => {
    const rows = [
      ['Time', 'Destination', 'Text', 'Source page', 'Source URL', 'Status'],
      ...visible.map(s => [
        new Date(s.at).toISOString(),
        s.destinationName,
        s.text,
        s.sourceTitle ?? '',
        s.sourceUrl ?? '',
        s.ok ? 'shipped' : `failed: ${s.error ?? ''}`,
      ]),
    ];
    const csv = rows.map(row => row.map(csvCell).join(',')).join('\r\n');
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }));
    link.download = `dock-manifest-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  };

  const handleRetry = async (shipment: Shipment) => {
    setRetrying(shipment.id);
    const res = await send({ type: 'SHIP_AGAIN', shipmentId: shipment.id });
    setRetrying(null);
    toast(res.ok === false ? (res.error ?? 'Still couldn’t ship that') : `Shipped to ${shipment.destinationName}`);
  };

  const handleClear = async () => {
    await dockShipmentsStorage.removeShipments(visible.map(s => s.id));
    setConfirmClear(false);
  };

  return (
    <div className="dock-content">
      <div className="manifest-toolbar">
        <select className="custom-select" value={filter} onChange={e => onFilter(e.target.value)}>
          <option value="all">All destinations</option>
          {destinations.map(d => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
        <button
          className="btn btn-primary"
          disabled={delivered.length === 0}
          onClick={handleCopyColumn}
          title="Copy every shipped item, one per line">
          <Icon name="copy" size={13} />
          Copy {delivered.length || ''}
        </button>
        <button className="btn btn-ghost" disabled={visible.length === 0} onClick={handleDownloadCsv} title="CSV">
          <Icon name="download" size={13} />
          CSV
        </button>
      </div>

      {newestFirst.length === 0 ? (
        <div className="intro-card">
          <div className="intro-steps">
            <div className="intro-title">The manifest</div>
            <p>
              Everything you ship is logged here, so nothing gets lost: copy it all as a column for Excel or Google
              Sheets, download a CSV, or retry anything that didn’t land.
            </p>
          </div>
        </div>
      ) : (
        <section className="section">
          <div className="section-header-row">
            <span className="section-title">Shipped</span>
            {confirmClear ? (
              <span className="confirm-inline">
                Clear {visible.length}?
                <button className="chip danger" onClick={handleClear}>
                  Yes
                </button>
                <button className="chip" onClick={() => setConfirmClear(false)}>
                  No
                </button>
              </span>
            ) : (
              <button className="text-btn danger" onClick={() => setConfirmClear(true)}>
                Clear
              </button>
            )}
          </div>
          <div className="item-list">
            {newestFirst.map(s => (
              <div className={cx('shipment-row', !s.ok && 'failed')} key={s.id}>
                <button className="shipment-text" title="Copy" onClick={() => copyText(s.text, 'Copied')}>
                  {s.text}
                </button>
                <div className="shipment-meta">
                  <span>
                    → {s.destinationName}
                    {s.sourceUrl && <> · from {hostnameOf(s.sourceUrl)}</>} · {formatTime(s.at)}
                  </span>
                  {!s.ok && (
                    <button className="chip" disabled={retrying === s.id} onClick={() => handleRetry(s)}>
                      <Icon name="refresh" size={11} />
                      {retrying === s.id ? 'Shipping…' : 'Retry'}
                    </button>
                  )}
                </div>
                {!s.ok && s.error && <div className="shipment-error">{s.error}</div>}
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
};

// ─── AI Prompts Panel ─────────────────────────────────────────────────────────

const AiPanel = () => {
  const prompts = useStorage(dockPromptsStorage) as Prompt[];
  const [editId, setEditId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [text, setText] = useState('');

  const reset = () => {
    setEditId(null);
    setName('');
    setText('');
  };

  const handleSave = async () => {
    if (!name.trim() || !text.trim()) return;
    if (editId) {
      await dockPromptsStorage.updatePrompt(editId, { name: name.trim(), text: text.trim() });
    } else {
      await dockPromptsStorage.addPrompt({ name: name.trim(), text: text.trim() });
    }
    reset();
  };

  const startEdit = (p: Prompt) => {
    setEditId(p.id);
    setName(p.name);
    setText(p.text);
  };

  return (
    <div className="dock-content">
      <div className="intro-card compact">
        <div className="intro-steps">
          <div className="intro-title">Right-click → Dock → Ask ChatGPT, Claude or Gemini</div>
          <p>
            Select text or right-click an image on any page. Dock opens the AI you chose in your own logged-in account,
            adds your saved instructions and sends it. No extra subscription, no API key.
          </p>
        </div>
      </div>

      <div className="form-card">
        <div className="form-card-header">
          <span className="form-card-title">{editId ? 'Edit prompt' : 'New prompt'}</span>
          {editId && (
            <button className="text-btn" onClick={reset}>
              Cancel
            </button>
          )}
        </div>
        <div className="form-fields-group">
          <input
            className="custom-input"
            placeholder="Title — e.g. Summarize, Reply politely, Explain"
            value={name}
            onChange={e => setName(e.target.value)}
          />
          <textarea
            className="custom-textarea"
            placeholder="Instructions — e.g. Summarize this in 3 bullet points:"
            value={text}
            onChange={e => setText(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) handleSave();
            }}
          />
          <button className="btn btn-primary btn-block" onClick={handleSave} disabled={!name.trim() || !text.trim()}>
            <Icon name="save" size={13} />
            {editId ? 'Save changes' : 'Save prompt'}
          </button>
        </div>
      </div>

      {prompts.length > 0 && (
        <section className="section">
          <div className="section-header-row">
            <span className="section-title">Saved prompts</span>
            <span className="section-badge">{prompts.length}</span>
          </div>
          {prompts.map(p => (
            <div className="prompt-card" key={p.id}>
              <div className="prompt-card-header">
                <span className="prompt-name">{p.name}</span>
                <div className="item-actions">
                  <button className="text-btn" onClick={() => startEdit(p)}>
                    Edit
                  </button>
                  <button className="text-btn danger" onClick={() => dockPromptsStorage.removePrompt(p.id)}>
                    Delete
                  </button>
                </div>
              </div>
              <div className="prompt-text">{p.text}</div>
            </div>
          ))}
        </section>
      )}
    </div>
  );
};

// ─── Prompt Picker (Context Menu Flow) ────────────────────────────────────────

interface PickerData {
  selectedText?: string;
  imageUrl?: string;
  context: 'text' | 'image';
  aiTarget: 'chatgpt' | 'gemini' | 'claude';
}

const AI_LABELS: Record<PickerData['aiTarget'], string> = { chatgpt: 'ChatGPT', gemini: 'Gemini', claude: 'Claude' };

// Images are passed through extension storage, which has a 10 MB quota.
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

const blobToDataUrl = (blob: Blob) =>
  new Promise<string | null>(resolve => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(blob);
  });

// Copies the image so it can be attached to the chat. Must be started from the
// click, because Chrome asks once per site for permission to read the image.
const fetchImageAsDataUrl = async (url: string): Promise<string | null> => {
  if (url.startsWith('data:image/')) return url;
  if (!isWebUrl(url)) return null;
  try {
    const granted = await chrome.permissions.request({ origins: [`${new URL(url).origin}/*`] });
    if (!granted) return null;
    const res = await fetch(url);
    if (!res.ok) return null;
    const blob = await res.blob();
    if (!blob.type.startsWith('image/') || blob.size > MAX_IMAGE_BYTES) return null;
    return await blobToDataUrl(blob);
  } catch {
    return null;
  }
};

const PromptPickerView = () => {
  const prompts = useStorage(dockPromptsStorage) as Prompt[];
  const [pickerData, setPickerData] = useState<PickerData | null>(null);
  const [selectedPromptId, setSelectedPromptId] = useState<string | null>(null);
  const [customPrompt, setCustomPrompt] = useState('');
  const [currentWindowId, setCurrentWindowId] = useState<number | undefined>(undefined);
  const [sending, setSending] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    chrome.windows.getCurrent({}, win => setCurrentWindowId(win.id));
    chrome.runtime.sendMessage({ type: 'GET_PICKER_DATA' }, (res: { data: PickerData | null }) => {
      if (res?.data) setPickerData(res.data);
    });
  }, []);

  // The picker is a dedicated window, so start typing right away.
  useEffect(() => {
    if (pickerData) textareaRef.current?.focus();
  }, [pickerData]);

  const handleSend = async () => {
    if (!pickerData || sending) return;
    setSending(true);
    const promptText = selectedPromptId
      ? (prompts.find(p => p.id === selectedPromptId)?.text ?? '')
      : customPrompt.trim();
    const imageDataUrl = pickerData.imageUrl ? await fetchImageAsDataUrl(pickerData.imageUrl) : null;

    await send({
      type: 'SEND_TO_AI',
      aiTarget: pickerData.aiTarget,
      promptText,
      selectedText: pickerData.selectedText,
      imageUrl: pickerData.imageUrl,
      imageDataUrl: imageDataUrl ?? undefined,
      windowId: currentWindowId,
    });
  };

  const handleClose = () => {
    if (currentWindowId !== undefined) {
      send({ type: 'CLOSE_PICKER', windowId: currentWindowId });
    } else {
      window.close();
    }
  };

  // Ctrl/Cmd+Enter sends, Escape cancels, from anywhere in the picker window.
  const shortcutsRef = useRef({ handleSend, handleClose });
  shortcutsRef.current = { handleSend, handleClose };
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) shortcutsRef.current.handleSend();
      if (e.key === 'Escape') shortcutsRef.current.handleClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  if (!pickerData) {
    return (
      <div className="picker-root centered">
        <LoadingSpinner />
      </div>
    );
  }

  const label = AI_LABELS[pickerData.aiTarget];

  return (
    <div className="picker-root">
      <div className="picker-header">
        <div className="dock-logo">
          Dock<span className="dock-logo-dot">.</span>
        </div>
        <span className="picker-ai-badge">→ {label}</span>
      </div>

      <div>
        <div className="picker-label">{pickerData.context === 'image' ? 'Image' : 'Selected text'}</div>
        {pickerData.context === 'image' && pickerData.imageUrl ? (
          <div className="picker-image-box">
            <img src={pickerData.imageUrl} alt="" />
          </div>
        ) : (
          <div className="picker-context-box">{pickerData.selectedText}</div>
        )}
      </div>

      {prompts.length > 0 && (
        <div>
          <div className="picker-label">Saved prompt</div>
          <div className="picker-prompts">
            {prompts.map(p => (
              <button
                key={p.id}
                className={cx('picker-prompt-item', selectedPromptId === p.id && 'selected')}
                onClick={() => setSelectedPromptId(prev => (prev === p.id ? null : p.id))}>
                <span className="picker-prompt-radio" />
                <span className="picker-prompt-name">{p.name}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      <div>
        <div className="picker-label">{prompts.length > 0 ? 'Or type instructions' : 'Instructions (optional)'}</div>
        <textarea
          className="custom-textarea"
          placeholder={pickerData.context === 'image' ? 'e.g. What is in this image?' : 'e.g. Explain this simply'}
          ref={textareaRef}
          value={customPrompt}
          onChange={e => {
            setCustomPrompt(e.target.value);
            setSelectedPromptId(null);
          }}
        />
      </div>

      {pickerData.context === 'image' && (
        <div className="hint">Chrome may ask once per site so Dock can copy the image into the chat.</div>
      )}

      <div className="picker-actions">
        <button className="btn btn-primary picker-send-btn" onClick={handleSend} disabled={sending}>
          {sending ? 'Opening…' : `Send to ${label}`}
          <kbd>Ctrl+Enter</kbd>
        </button>
        <button className="btn btn-ghost" onClick={handleClose}>
          Cancel
        </button>
      </div>
    </div>
  );
};

// ─── Destination Chooser (Context Menu Flow) ──────────────────────────────────

interface PickSessionInfo {
  text: string;
  sourceTabId?: number;
}

const DestinationChooserView = () => {
  const tabs = useOpenTabs();
  const [session, setSession] = useState<PickSessionInfo | null>(null);
  const [filter, setFilter] = useState('');
  const [customUrl, setCustomUrl] = useState('');
  const [collectName, setCollectName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    send({ type: 'GET_PICK_SESSION' }).then(res => setSession(res as unknown as PickSessionInfo));
  }, []);

  const cancel = useCallback(async () => {
    await send({ type: 'PICKER_CANCEL' });
    await closeThisWindow().catch(() => window.close());
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => e.key === 'Escape' && cancel();
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [cancel]);

  // Chrome asks once per site, so Dock can paste into that site's fields.
  const pick = async (target: { tabId?: number; url: string }) => {
    setError('');
    const granted = await requestSiteAccess(target.url).catch(() => false);
    if (!granted) {
      setError(`Dock needs access to ${hostnameOf(target.url)} to paste into it.`);
      return;
    }
    setBusy(true);
    const res = await send({ type: 'START_FIELD_PICK', ...target });
    setBusy(false);
    if (res?.ok === false) setError(res.error ?? 'Could not open that page');
  };

  const handleOpenUrl = (e: React.FormEvent) => {
    e.preventDefault();
    let url = customUrl.trim();
    if (!url) return;
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
    try {
      new URL(url);
    } catch {
      setError('That doesn’t look like a web address');
      return;
    }
    pick({ url });
  };

  const handleCollect = async (e: React.FormEvent) => {
    e.preventDefault();
    await send({ type: 'CREATE_COLLECTION', name: collectName.trim() || 'Collected' });
  };

  if (!session) {
    return (
      <div className="picker-root centered">
        <LoadingSpinner />
      </div>
    );
  }

  const query = filter.trim().toLowerCase();
  const visibleTabs = query
    ? tabs.filter(t => t.title.toLowerCase().includes(query) || t.url.toLowerCase().includes(query))
    : tabs;

  return (
    <div className="picker-root">
      <div className="picker-header">
        <div className="dock-logo">
          Dock<span className="dock-logo-dot">.</span>
        </div>
        <span className="picker-ai-badge">Ship to…</span>
      </div>

      {session.text && (
        <div>
          <div className="picker-label">Shipping</div>
          <div className="picker-context-box">{session.text}</div>
        </div>
      )}

      <div>
        <div className="picker-label">1 · Pick the tab with the field</div>
        {tabs.length > 6 && (
          <input
            type="search"
            className="custom-input filter-input"
            placeholder="Filter tabs…"
            value={filter}
            onChange={e => setFilter(e.target.value)}
          />
        )}
        <div className="item-list chooser-tabs">
          {visibleTabs.length === 0 ? (
            <div className="empty-state">{tabs.length === 0 ? 'No open web pages.' : 'No tabs match.'}</div>
          ) : (
            visibleTabs.map(tab => (
              <button
                className="item-row chooser-tab"
                key={tab.id}
                disabled={busy}
                onClick={() => pick({ tabId: tab.id, url: tab.url })}>
                <span className="item-info">
                  <Favicon src={tab.favIconUrl} url={tab.url} />
                  <span className="item-text">
                    <span className="item-title">{tab.title}</span>
                    <span className="item-sub">
                      {hostnameOf(tab.url)}
                      {tab.id === session.sourceTabId && ' · this page'}
                    </span>
                  </span>
                </span>
                <Icon name="ship" />
              </button>
            ))
          )}
        </div>
        <form className="launch-bar chooser-url" onSubmit={handleOpenUrl}>
          <input
            type="text"
            className="custom-input"
            placeholder="Or open a site… e.g. docs.google.com/forms/…"
            value={customUrl}
            onChange={e => setCustomUrl(e.target.value)}
            spellCheck={false}
          />
          <button type="submit" className="btn btn-ghost" disabled={busy}>
            Open
          </button>
        </form>
        <div className="hint">2 · Then click the field on that page. Dock brings you back here after.</div>
      </div>

      <form className="collect-card" onSubmit={handleCollect}>
        <div className="collect-title">
          <Icon name="inbox" size={13} />
          Or just collect, no page
        </div>
        <p className="hint">
          Best for spreadsheets: Dock keeps every item in its Manifest, then you paste them all as a column at once.
        </p>
        <div className="launch-bar">
          <input
            className="custom-input"
            placeholder="Name it — e.g. SO IDs"
            value={collectName}
            onChange={e => setCollectName(e.target.value)}
          />
          <button type="submit" className="btn btn-ghost">
            Collect
          </button>
        </div>
      </form>

      {error && <div className="error-line">{error}</div>}

      <div className="picker-actions">
        <button className="btn btn-ghost btn-block" onClick={cancel}>
          Cancel <kbd>Esc</kbd>
        </button>
      </div>
    </div>
  );
};

// ─── Root ─────────────────────────────────────────────────────────────────────

const TABS: { id: Tab; label: string }[] = [
  { id: 'ship', label: 'Ship' },
  { id: 'manifest', label: 'Manifest' },
  { id: 'ai', label: 'AI' },
];

const ACTIVE_TAB_KEY = 'dock-popup-tab';

const ToastHost = ({ children }: { children: ReactNode }) => {
  const [message, setMessage] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const show = useCallback((text: string) => {
    setMessage(text);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setMessage(null), 2600);
  }, []);

  return (
    <ToastContext.Provider value={show}>
      {children}
      {message && (
        <div className="toast" role="status">
          {message}
        </div>
      )}
    </ToastContext.Provider>
  );
};

const Popup = () => {
  const [activeTab, setActiveTab] = useState<Tab>(() => {
    try {
      const saved = localStorage.getItem(ACTIVE_TAB_KEY) as Tab | null;
      return saved && TABS.some(t => t.id === saved) ? saved : 'ship';
    } catch {
      return 'ship';
    }
  });
  const [manifestFilter, setManifestFilter] = useState('all');

  const mode = new URLSearchParams(window.location.search).get('mode');
  if (mode === 'prompt-picker') return <PromptPickerView />;
  if (mode === 'destination-chooser') {
    return (
      <ToastHost>
        <DestinationChooserView />
      </ToastHost>
    );
  }

  const selectTab = (tab: Tab) => {
    setActiveTab(tab);
    try {
      localStorage.setItem(ACTIVE_TAB_KEY, tab);
    } catch {
      // Storage unavailable; the tab just won't be remembered.
    }
  };

  const handleOpenSidePanel = async () => {
    try {
      const win = await chrome.windows.getCurrent();
      if (win?.id) await chrome.sidePanel.open({ windowId: win.id });
      window.close();
    } catch {
      send({ type: 'OPEN_SIDE_PANEL' });
    }
  };

  return (
    <ToastHost>
      <div className="dock-app-container">
        <header className="dock-header">
          <div className="dock-brand">
            <div className="dock-logo">
              Dock<span className="dock-logo-dot">.</span>
            </div>
            <span className="dock-tagline">Ship text between tabs</span>
          </div>
          {isToolbarPopup() && (
            <div className="dock-header-actions">
              <button className="dock-icon-btn" title="Open in side panel" onClick={handleOpenSidePanel}>
                <Icon name="panel" size={15} />
              </button>
            </div>
          )}
        </header>

        <nav className="tab-bar">
          {TABS.map(t => (
            <button
              key={t.id}
              id={`tab-${t.id}`}
              className={cx('tab-btn', activeTab === t.id && 'active')}
              onClick={() => selectTab(t.id)}>
              {t.label}
            </button>
          ))}
        </nav>

        <main className="dock-scroll">
          {activeTab === 'ship' && (
            <ShipPanel
              onShowShipments={id => {
                setManifestFilter(id);
                selectTab('manifest');
              }}
            />
          )}
          {activeTab === 'manifest' && <ManifestPanel filter={manifestFilter} onFilter={setManifestFilter} />}
          {activeTab === 'ai' && <AiPanel />}
        </main>

        <footer className="dock-footer">
          <span className="dock-footer-middle">100% local · no account · no tracking</span>
          <span className="dock-footer-version">v{chrome.runtime.getManifest().version}</span>
        </footer>
      </div>
    </ToastHost>
  );
};

export default withErrorBoundary(withSuspense(Popup, <LoadingSpinner />), ErrorDisplay);
