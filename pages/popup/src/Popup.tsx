import '@src/Popup.css';
import { useEffect, useState } from 'react';
import { useStorage, withErrorBoundary, withSuspense } from '@extension/shared';
import { dockSnippetsStorage, dockPromptsStorage, dockPinnedWindowsStorage } from '@extension/storage';
import type { Snippet, Prompt, PinnedWindow } from '@extension/storage';
import { LoadingSpinner, ErrorDisplay } from '@extension/ui';

// ─── Tab definitions ──────────────────────────────────────────────────────────

type Tab = 'pintabs' | 'txt_shortcut' | 'prompt';

const TABS: { id: Tab; icon: string; label: string }[] = [
  { id: 'pintabs', icon: '⊞', label: 'Dock' },
  { id: 'txt_shortcut', icon: '≡', label: 'Snippets' },
  { id: 'prompt', icon: '◉', label: 'AI Prompts' },
];

// ─── PinTabs (Companions) Panel ───────────────────────────────────────────────

interface ChromeTab {
  id: number;
  title: string;
  url: string;
  favIconUrl?: string;
}

const PinTabsPanel = () => {
  const [tabs, setTabs] = useState<ChromeTab[]>([]);
  const [customUrl, setCustomUrl] = useState('');
  const pinnedData = useStorage(dockPinnedWindowsStorage) as PinnedWindow[];

  const loadTabs = () => {
    chrome.tabs.query({}, allTabs => {
      setTabs(
        allTabs
          .filter(t => t.id && t.url && !t.url.startsWith('chrome://') && !t.url.startsWith('chrome-extension://'))
          .map(t => ({
            id: t.id!,
            title: t.title ?? t.url ?? 'Untitled',
            url: t.url!,
            favIconUrl: t.favIconUrl,
          })),
      );
    });
  };

  useEffect(() => {
    loadTabs();
  }, []);

  const pinned: PinnedWindow[] = Array.isArray(pinnedData) ? pinnedData : [];
  const activeCompanions = pinned.filter(p => (p.windowId && p.windowId > 0) || p.mode === 'iframe');
  const pinnedUrls = new Set(activeCompanions.map(p => p.url));

  const handleLaunchTab = (tab: ChromeTab) => {
    if (pinnedUrls.has(tab.url)) {
      const match = activeCompanions.find(p => p.url === tab.url);
      if (match?.windowId && match.mode === 'companion') {
        chrome.runtime.sendMessage({ type: 'FOCUS_COMPANION', windowId: match.windowId });
      }
    } else {
      chrome.runtime.sendMessage({
        type: 'PIN_TAB',
        url: tab.url,
        title: tab.title,
        favicon: tab.favIconUrl,
        tabId: tab.id,
      });
    }
  };

  const handleLaunchCustomUrl = (e?: React.FormEvent) => {
    e?.preventDefault();
    let url = customUrl.trim();
    if (!url) return;
    if (!/^https?:\/\//i.test(url)) {
      url = 'https://' + url;
    }
    chrome.runtime.sendMessage({
      type: 'PIN_TAB',
      url,
      title: url.replace(/^https?:\/\/(www\.)?/, ''),
    });
    setCustomUrl('');
  };

  const handleFocus = (windowId: number) => {
    chrome.runtime.sendMessage({ type: 'FOCUS_COMPANION', windowId });
  };

  const handleToggleFullscreen = (windowId: number) => {
    chrome.runtime.sendMessage({ type: 'TOGGLE_COMPANION_FULLSCREEN', windowId });
  };

  const handleCloseCompanion = (windowId: number, url: string) => {
    chrome.runtime.sendMessage({ type: 'CLOSE_COMPANION', windowId, url });
  };

  const handleOpenSidePanel = async () => {
    try {
      const win = await chrome.windows.getCurrent();
      if (win?.id) {
        await chrome.sidePanel.open({ windowId: win.id });
      }
    } catch {
      chrome.runtime.sendMessage({ type: 'OPEN_SIDE_PANEL' });
    }
  };

  return (
    <div className="dock-content">
      <div className="info-box">
        <span className="info-icon">i</span>
        <span>
          Pin any tab to keep it visible while you work. Sites that support embedding stay right on your page. Others open in a companion window.
        </span>
      </div>

      {/* Side Panel Quick Action */}
      <button
        type="button"
        className="dock-primary-btn"
        style={{ width: '100%', padding: '8px 12px', marginBottom: '12px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px' }}
        onClick={handleOpenSidePanel}
        title="Open persistent Chrome Side Panel"
      >
        <span>◨</span> Open in Chrome Side Panel
      </button>

      {/* Quick Launch Custom URL */}
      <form className="companion-quick-launch" onSubmit={handleLaunchCustomUrl}>
        <input
          type="text"
          className="dock-input companion-url-input"
          placeholder="Launch any URL (e.g. mail.google.com, x.com)..."
          value={customUrl}
          onChange={e => setCustomUrl(e.target.value)}
          style={{ background: '#1e293b', color: '#e2e8f0', border: '1px solid rgba(255,255,255,0.12)' }}
        />
        <button type="submit" className="dock-primary-btn companion-launch-btn" title="Launch companion window">
          Launch
        </button>
      </form>

      {/* Active Companions Section */}
      {activeCompanions.length > 0 && (
        <div className="companion-section">
          <div className="section-header-row">
            <div className="section-title-group">
              <span className="section-title">Active Companions</span>
            </div>
            <span className="section-badge active-badge">{activeCompanions.length} Running</span>
          </div>

          <div className="tab-list">
            {activeCompanions.map(comp => (
              <div className="tab-item active-companion-item" key={comp.windowId || comp.url}>
                <div className="tab-item-info" onClick={() => comp.windowId && comp.mode === 'companion' && handleFocus(comp.windowId)} style={{ cursor: 'pointer' }}>
                  {comp.favicon ? (
                    <img src={comp.favicon} alt="" onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                  ) : (
                    <span className="favicon-fallback">W</span>
                  )}
                  <span title={comp.title}>{comp.title}</span>
                  <span style={{ fontSize: '10px', color: '#64748b', marginLeft: '4px', flexShrink: 0 }}>
                    {comp.mode === 'iframe' ? '(in-page)' : '(window)'}
                  </span>
                </div>
                <div className="companion-actions">
                  {comp.mode === 'companion' && comp.windowId > 0 && (
                    <>
                      <button
                        className="companion-action-btn"
                        title="Bring to front"
                        onClick={() => handleFocus(comp.windowId)}
                      >
                        ↗
                      </button>
                      <button
                        className="companion-action-btn"
                        title="Toggle full screen"
                        onClick={() => handleToggleFullscreen(comp.windowId)}
                      >
                        F
                      </button>
                    </>
                  )}
                  {comp.mode === 'iframe' && (
                    <button
                      className="companion-action-btn"
                      title="Open in companion window"
                      onClick={() => {
                        chrome.runtime.sendMessage({
                          type: 'SWITCH_TO_COMPANION',
                          url: comp.url,
                          title: comp.title,
                          favicon: comp.favicon,
                          tabId: comp.tabId,
                        });
                      }}
                    >
                      ↗
                    </button>
                  )}
                  <button
                    className="companion-action-btn close-btn"
                    title="Close"
                    onClick={() => {
                      if (comp.windowId && comp.windowId > 0) {
                        handleCloseCompanion(comp.windowId, comp.url);
                      } else {
                        chrome.runtime.sendMessage({ type: 'UNPIN_WINDOW', url: comp.url });
                      }
                    }}
                  >
                    x
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Available Tabs Section */}
      <div className="companion-section">
        <div className="section-header-row">
          <div className="section-title-group">
            <span className="section-title">Open Tabs</span>
            <button
              className="refresh-inline-btn"
              title="Refresh open tabs list"
              onClick={loadTabs}
            >
              ↻
            </button>
          </div>
          <span className="section-badge">{tabs.length} Available</span>
        </div>

        <div className="tab-list">
          {tabs.length === 0 ? (
            <div className="empty-state">No open tabs found.</div>
          ) : (
            tabs.map(tab => {
              const isPinned = pinnedUrls.has(tab.url);
              return (
                <div className="tab-item" key={tab.id}>
                  <div className="tab-item-info">
                    {tab.favIconUrl ? (
                      <img src={tab.favIconUrl} alt="" onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                    ) : (
                      <span className="favicon-fallback">⊞</span>
                    )}
                    <span title={tab.title}>{tab.title}</span>
                  </div>
                  <button
                    id={`pin-tab-${tab.id}`}
                    className={`pin-btn${isPinned ? ' pinned' : ''}`}
                    title={isPinned ? 'Companion is active (Click to focus)' : 'Launch as companion window'}
                    onClick={() => handleLaunchTab(tab)}
                  >
                    {isPinned ? '✓' : '⊞'}
                  </button>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
};

// ─── Text Snippets Panel ──────────────────────────────────────────────────────

const TxtShortcutPanel = () => {
  const snippets = useStorage(dockSnippetsStorage) as Snippet[];
  const [editId, setEditId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const [editShortcut, setEditShortcut] = useState('');
  const [newText, setNewText] = useState('');
  const [newShortcut, setNewShortcut] = useState('do/');

  const handleAdd = async () => {
    if (!newText.trim()) return;
    let formattedShortcut = newShortcut.trim();
    if (!formattedShortcut || formattedShortcut === 'do/') {
      formattedShortcut = `do/snip${Date.now().toString().slice(-3)}`;
    } else if (!formattedShortcut.startsWith('do/')) {
      formattedShortcut = 'do/' + formattedShortcut;
    }

    await dockSnippetsStorage.addSnippet({ shortcut: formattedShortcut, text: newText.trim() });
    setNewText('');
    setNewShortcut('do/');
  };

  const handleDelete = async (id: string) => {
    await dockSnippetsStorage.removeSnippet(id);
  };

  const startEdit = (s: Snippet) => {
    setEditId(s.id);
    setEditText(s.text);
    setEditShortcut(s.shortcut);
  };

  const saveEdit = async () => {
    if (!editId || !editText.trim()) return;
    let formattedShortcut = editShortcut.trim();
    if (!formattedShortcut.startsWith('do/')) {
      formattedShortcut = 'do/' + formattedShortcut;
    }
    await dockSnippetsStorage.updateSnippet(editId, { text: editText.trim(), shortcut: formattedShortcut });
    setEditId(null);
  };

  const list = Array.isArray(snippets) ? snippets : [];

  return (
    <div className="dock-content">
      <div className="info-box">
        <span className="info-icon">i</span>
        <span>Type a shortcut (e.g. <code>do/greet</code>) in any input or document — it replaces with your saved snippet instantly.</span>
      </div>

      {/* Add Snippet Form Card — Always Visible */}
      <div>
        <div className="form-card-header">
          <span className="form-card-title">New Snippet</span>
          <button
            className="icon-save-btn"
            title="Save Snippet"
            onClick={handleAdd}
          >
            ✓ Save
          </button>
        </div>
        <div className="form-fields-group">
          <input
            className="custom-input"
            value={newShortcut}
            onChange={e => setNewShortcut(e.target.value)}
            placeholder="Shortcut (e.g. do/reply)"
            spellCheck={false}
          />
          <textarea
            className="custom-textarea"
            value={newText}
            onChange={e => setNewText(e.target.value)}
            placeholder="Expanded snippet or response text..."
            onKeyDown={e => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                handleAdd();
              }
            }}
          />
        </div>
      </div>

      {/* Saved Snippets List */}
      {list.length > 0 && (
        <div>
          <div className="section-header-row">
            <span className="section-title">Saved Snippets</span>
            <span className="section-badge">{list.length} Items</span>
          </div>

          <div>
            {list.map(s => (
              <div className="snippet-card" key={s.id}>
                {editId === s.id ? (
                  <div className="form-fields-group">
                    <input
                      className="custom-input"
                      value={editShortcut}
                      onChange={e => setEditShortcut(e.target.value)}
                      placeholder="do/shortcut"
                      spellCheck={false}
                    />
                    <textarea
                      className="custom-textarea"
                      value={editText}
                      onChange={e => setEditText(e.target.value)}
                      placeholder="Snippet text..."
                      autoFocus
                    />
                    <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', marginTop: 4 }}>
                      <button className="icon-save-btn" onClick={saveEdit}>✓ Save</button>
                      <button className="snippet-action-btn" onClick={() => setEditId(null)}>Cancel</button>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="snippet-card-top">
                      <span className="snippet-shortcut-tag">{s.shortcut}</span>
                      <div className="snippet-actions">
                        <button className="snippet-action-btn" onClick={() => startEdit(s)}>Edit</button>
                        <button className="snippet-action-btn" onClick={() => handleDelete(s.id)}>Delete</button>
                      </div>
                    </div>
                    <div className="snippet-text-preview">{s.text || '(empty)'}</div>
                  </>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

// ─── Prompt Panel ─────────────────────────────────────────────────────────────

const PromptPanel = () => {
  const prompts = useStorage(dockPromptsStorage) as Prompt[];
  const [newName, setNewName] = useState('');
  const [newText, setNewText] = useState('');

  const handleSave = async () => {
    if (!newName.trim() || !newText.trim()) return;
    await dockPromptsStorage.addPrompt({ name: newName.trim(), text: newText.trim() });
    setNewName('');
    setNewText('');
  };

  const handleDelete = async (id: string) => {
    await dockPromptsStorage.removePrompt(id);
  };

  const list = Array.isArray(prompts) ? prompts : [];

  return (
    <div className="dock-content">
      <div className="info-box">
        <span className="info-icon">i</span>
        <span>Highlight text or right-click images to dispatch directly to ChatGPT, Claude, or Gemini with saved prompts.</span>
      </div>

      {/* Add Prompt Form Card — Always Visible */}
      <div>
        <div className="form-card-header">
          <span className="form-card-title">New AI Prompt</span>
          <button
            className="icon-save-btn"
            title="Save Prompt"
            onClick={handleSave}
          >
            ✓ Save
          </button>
        </div>
        <div className="form-fields-group">
          <input
            id="new-prompt-name"
            className="custom-input"
            placeholder="Prompt Title (e.g. Summarize, Polish, Code Review)"
            value={newName}
            onChange={e => setNewName(e.target.value)}
          />
          <textarea
            id="new-prompt-text"
            className="custom-textarea"
            placeholder="Prompt instructions (e.g. Summarize the following in 3 concise bullet points:)"
            value={newText}
            onChange={e => setNewText(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                handleSave();
              }
            }}
          />
        </div>
      </div>

      {/* Saved Prompts List */}
      {list.length > 0 && (
        <div>
          <div className="section-header-row">
            <span className="section-title">Saved Prompts</span>
            <span className="section-badge">{list.length} Items</span>
          </div>
          <div>
            {list.map(p => (
              <div className="prompt-card" key={p.id}>
                <div className="prompt-card-header">
                  <span className="prompt-name">{p.name}</span>
                  <button
                    className="snippet-action-btn"
                    title="Delete Prompt"
                    onClick={() => handleDelete(p.id)}
                  >
                    Delete
                  </button>
                </div>
                <div className="prompt-text">{p.text}</div>
              </div>
            ))}
          </div>
        </div>
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

const AI_LABELS: Record<string, string> = { chatgpt: 'ChatGPT', gemini: 'Gemini', claude: 'Claude' };

const PromptPickerView = () => {
  const prompts = useStorage(dockPromptsStorage) as Prompt[];
  const [pickerData, setPickerData] = useState<PickerData | null>(null);
  const [selectedPromptId, setSelectedPromptId] = useState<string | null>(null);
  const [customPrompt, setCustomPrompt] = useState('');
  const [currentWindowId, setCurrentWindowId] = useState<number | undefined>(undefined);

  useEffect(() => {
    chrome.windows.getCurrent({}, win => { setCurrentWindowId(win.id); });
    chrome.runtime.sendMessage({ type: 'GET_PICKER_DATA' }, (res: { data: PickerData | null }) => {
      if (res?.data) setPickerData(res.data);
    });
  }, []);

  const handleSend = () => {
    if (!pickerData) return;
    const promptText = selectedPromptId
      ? (prompts ?? []).find(p => p.id === selectedPromptId)?.text ?? ''
      : customPrompt.trim();

    chrome.runtime.sendMessage({
      type: 'SEND_TO_AI',
      aiTarget: pickerData.aiTarget,
      promptText,
      selectedText: pickerData.selectedText,
      imageUrl: pickerData.imageUrl,
      windowId: currentWindowId,
    });
  };

  const handleClose = () => {
    if (currentWindowId !== undefined) {
      chrome.runtime.sendMessage({ type: 'CLOSE_PICKER', windowId: currentWindowId });
    } else {
      window.close();
    }
  };

  if (!pickerData) {
    return <div className="picker-root" style={{ alignItems: 'center', justifyContent: 'center' }}><LoadingSpinner /></div>;
  }

  const contextSnippet = pickerData.selectedText
    ? pickerData.selectedText.slice(0, 140) + (pickerData.selectedText.length > 140 ? '…' : '')
    : pickerData.imageUrl ?? '';

  return (
    <div className="picker-root">
      <div className="picker-header">
        <div className="dock-logo">Dock<span className="dock-logo-dot">.</span></div>
        <span className="picker-ai-badge">→ {AI_LABELS[pickerData.aiTarget] ?? pickerData.aiTarget}</span>
      </div>

      <div>
        <div className="picker-label">
          {pickerData.context === 'image' ? 'Selected Image' : 'Selected Text'}
        </div>
        <div className="picker-context-box">{contextSnippet}</div>
      </div>

      {(prompts ?? []).length > 0 && (
        <div>
          <div className="picker-label">Choose Saved Prompt</div>
          <div className="picker-prompts">
            {(prompts ?? []).map(p => (
              <div
                key={p.id}
                id={`picker-prompt-${p.id}`}
                className={`picker-prompt-item${selectedPromptId === p.id ? ' selected' : ''}`}
                onClick={() => setSelectedPromptId(prev => prev === p.id ? null : p.id)}
              >
                <div className="picker-prompt-radio" />
                <span className="picker-prompt-name">{p.name}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div>
        <div className="picker-label">
          {(prompts ?? []).length > 0 ? 'Or Type Custom Prompt' : 'Custom Prompt (Optional)'}
        </div>
        <textarea
          id="picker-custom-prompt"
          className="custom-textarea"
          placeholder="Type prompt instructions here..."
          value={customPrompt}
          onChange={e => { setCustomPrompt(e.target.value); setSelectedPromptId(null); }}
        />
      </div>

      <div className="picker-actions">
        <button className="picker-send-btn" onClick={handleSend}>
          Send to {AI_LABELS[pickerData.aiTarget] ?? pickerData.aiTarget}
        </button>
        <button className="picker-cancel-btn" onClick={handleClose}>
          Cancel
        </button>
      </div>
    </div>
  );
};

// ─── Root Popup ───────────────────────────────────────────────────────────────

const Popup = () => {
  const [activeTab, setActiveTab] = useState<Tab>('pintabs');

  const isPickerMode = new URLSearchParams(window.location.search).get('mode') === 'prompt-picker';
  if (isPickerMode) {
    return <PromptPickerView />;
  }

  const handleOpenFullscreen = () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('popup/index.html') });
  };

  return (
    <div className="dock-app-container">
      {/* Header */}
      <div className="dock-header">
        <div className="dock-brand">
          <div className="dock-logo">Dock<span className="dock-logo-dot">.</span></div>
        </div>
        <div className="dock-header-actions">
          <button
            className="dock-icon-btn"
            title="Open in Fullscreen Tab"
            onClick={handleOpenFullscreen}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
            </svg>
          </button>
        </div>
      </div>

      {/* Tab Navigation */}
      <div className="tab-bar">
        {TABS.map(t => (
          <button
            key={t.id}
            id={`tab-${t.id}`}
            className={`tab-btn${activeTab === t.id ? ' active' : ''}`}
            onClick={() => setActiveTab(t.id)}
          >
            <span className="tab-btn-icon">{t.icon}</span>
            {t.label}
          </button>
        ))}
      </div>

      {/* Panel Content */}
      <div style={{ flex: 1 }}>
        {activeTab === 'pintabs' && <PinTabsPanel />}
        {activeTab === 'txt_shortcut' && <TxtShortcutPanel />}
        {activeTab === 'prompt' && <PromptPanel />}
      </div>

      {/* Footer */}
      <div className="dock-footer">
        <span className="dock-footer-brand">
          Crafted by <strong>Nitytec.</strong>
        </span>
        <span className="dock-footer-middle">
          100% Local • Private & Secure
        </span>
        <span className="dock-footer-version">v1.0.0</span>
      </div>
    </div>
  );
};

export default withErrorBoundary(withSuspense(Popup, <LoadingSpinner />), ErrorDisplay);
