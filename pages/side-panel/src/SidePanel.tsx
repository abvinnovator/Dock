import '@src/SidePanel.css';
import { useEffect, useState } from 'react';
import { useStorage, withErrorBoundary, withSuspense } from '@extension/shared';
import { dockSnippetsStorage, dockPromptsStorage, dockPinnedWindowsStorage } from '@extension/storage';
import type { Snippet, Prompt, PinnedWindow } from '@extension/storage';
import { LoadingSpinner, ErrorDisplay } from '@extension/ui';

type NavTab = 'dock' | 'snippets' | 'prompts';

interface ChromeTab {
  id: number;
  title: string;
  url: string;
  favIconUrl?: string;
}

const SidePanel = () => {
  const [activeTab, setActiveTab] = useState<NavTab>('dock');
  const [tabs, setTabs] = useState<ChromeTab[]>([]);
  const [customUrl, setCustomUrl] = useState('');
  
  const snippets = (useStorage(dockSnippetsStorage) as Snippet[]) ?? [];
  const prompts = (useStorage(dockPromptsStorage) as Prompt[]) ?? [];
  const pinnedData = (useStorage(dockPinnedWindowsStorage) as PinnedWindow[]) ?? [];

  const [snippetSearch, setSnippetSearch] = useState('');
  const [copiedId, setCopiedId] = useState<string | null>(null);

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

  const activeCompanions = pinnedData.filter(p => (p.windowId && p.windowId > 0) || p.mode === 'iframe');
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

  const handleClose = (windowId: number | undefined, url: string) => {
    if (windowId && windowId > 0) {
      chrome.runtime.sendMessage({ type: 'CLOSE_COMPANION', windowId, url });
    } else {
      chrome.runtime.sendMessage({ type: 'UNPIN_WINDOW', url });
    }
  };

  const handleCopySnippet = (snip: Snippet) => {
    navigator.clipboard.writeText(snip.text);
    setCopiedId(snip.id);
    setTimeout(() => setCopiedId(null), 1500);
  };

  const handleSendAi = (promptText: string, target: 'chatgpt' | 'gemini' | 'claude') => {
    chrome.runtime.sendMessage({
      type: 'SEND_TO_AI',
      aiTarget: target,
      promptText,
      selectedText: '',
    });
  };

  const filteredSnippets = snippets.filter(s =>
    s.shortcut.toLowerCase().includes(snippetSearch.toLowerCase()) ||
    s.text.toLowerCase().includes(snippetSearch.toLowerCase()),
  );

  return (
    <div className="dock-sidepanel-root">
      {/* Header */}
      <header className="dock-header">
        <span className="brand-title">Dock<span>.</span></span>
        <span className="brand-badge">Side Panel</span>
      </header>

      {/* Navigation */}
      <nav className="dock-nav">
        <button
          className={`nav-tab-btn ${activeTab === 'dock' ? 'active' : ''}`}
          onClick={() => setActiveTab('dock')}
        >
          Pinned
        </button>
        <button
          className={`nav-tab-btn ${activeTab === 'snippets' ? 'active' : ''}`}
          onClick={() => setActiveTab('snippets')}
        >
          Snippets
        </button>
        <button
          className={`nav-tab-btn ${activeTab === 'prompts' ? 'active' : ''}`}
          onClick={() => setActiveTab('prompts')}
        >
          AI Prompts
        </button>
      </nav>

      {/* Main Body */}
      <main className="dock-sidepanel-body">
        {activeTab === 'dock' && (
          <div>
            <div className="info-banner">
              Pin any tab to keep it visible while you work. Sites that support embedding stay right on your page. Others open in a companion window.
            </div>

            {/* Quick Launch */}
            <form className="quick-launch-bar" onSubmit={handleLaunchCustomUrl}>
              <input
                type="text"
                className="dock-input"
                placeholder="Launch any URL (e.g. mail.google.com)..."
                value={customUrl}
                onChange={e => setCustomUrl(e.target.value)}
                style={{ background: '#1e293b', color: '#e2e8f0', border: '1px solid rgba(255,255,255,0.12)' }}
              />
              <button type="submit" className="dock-btn-primary">
                Launch
              </button>
            </form>

            {/* Active Companions */}
            {activeCompanions.length > 0 && (
              <div className="section-group">
                <div className="section-head">
                  <span className="section-label">Active Pinned ({activeCompanions.length})</span>
                </div>
                <div className="item-list">
                  {activeCompanions.map(comp => (
                    <div className="card-item" key={comp.windowId || comp.url}>
                      <div className="card-item-left" onClick={() => comp.windowId && comp.mode === 'companion' && handleFocus(comp.windowId)} style={{ cursor: 'pointer' }}>
                        {comp.favicon ? (
                          <img src={comp.favicon} alt="" onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                        ) : (
                          <span>W</span>
                        )}
                        <span className="card-item-title" title={comp.title}>{comp.title}</span>
                        <span style={{ fontSize: '10px', color: '#64748b', marginLeft: '4px', flexShrink: 0 }}>
                          {comp.mode === 'iframe' ? '(in-page)' : '(window)'}
                        </span>
                      </div>
                      <div className="card-actions">
                        {comp.mode === 'companion' && comp.windowId > 0 && (
                          <>
                            <button className="action-btn" title="Bring to front" onClick={() => handleFocus(comp.windowId)}>↗</button>
                            <button className="action-btn" title="Toggle Fullscreen" onClick={() => handleToggleFullscreen(comp.windowId)}>F</button>
                          </>
                        )}
                        {comp.mode === 'iframe' && (
                          <button
                            className="action-btn"
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
                        <button className="action-btn delete-btn" title="Close" onClick={() => handleClose(comp.windowId, comp.url)}>x</button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Open Tabs */}
            <div className="section-group">
              <div className="section-head">
                <span className="section-label">Open Tabs ({tabs.length})</span>
                <button className="action-btn" title="Refresh" onClick={loadTabs}>↻</button>
              </div>
              <div className="item-list">
                {tabs.length === 0 ? (
                  <div className="empty-placeholder">No open tabs found.</div>
                ) : (
                  tabs.map(t => {
                    const isPinned = pinnedUrls.has(t.url);
                    return (
                      <div className="card-item" key={t.id}>
                        <div className="card-item-left">
                          {t.favIconUrl ? (
                            <img src={t.favIconUrl} alt="" onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                          ) : (
                            <span>⊞</span>
                          )}
                          <span className="card-item-title" title={t.title}>{t.title}</span>
                        </div>
                        <div className="card-actions">
                          <button
                            className="action-btn"
                            title={isPinned ? 'Bring to front' : 'Launch companion'}
                            onClick={() => handleLaunchTab(t)}
                          >
                            {isPinned ? '✓' : '⊞'}
                          </button>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          </div>
        )}

        {activeTab === 'snippets' && (
          <div>
            <div className="info-banner">
              Type any shortcut (e.g. <code>do/reply</code>) in any text field or editor on any website to expand instantly.
            </div>

            <div className="quick-launch-bar">
              <input
                type="text"
                className="dock-input"
                placeholder="Search snippets..."
                value={snippetSearch}
                onChange={e => setSnippetSearch(e.target.value)}
              />
            </div>

            <div className="item-list">
              {filteredSnippets.length === 0 ? (
                <div className="empty-placeholder">No snippets found.</div>
              ) : (
                filteredSnippets.map(snip => (
                  <div className="card-item" key={snip.id}>
                    <div className="card-item-left" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 2 }}>
                      <span style={{ fontSize: 11, fontWeight: 700, color: '#fff' }}>{snip.shortcut}</span>
                      <span style={{ fontSize: 11, color: '#888', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 220 }}>
                        {snip.text}
                      </span>
                    </div>
                    <div className="card-actions">
                      <button className="action-btn" title="Copy to clipboard" onClick={() => handleCopySnippet(snip)}>
                        {copiedId === snip.id ? '✓' : '⎘'}
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        )}

        {activeTab === 'prompts' && (
          <div>
            <div className="info-banner">
              Send prompt instructions directly to ChatGPT, Claude, or Gemini in one click.
            </div>

            <div className="item-list">
              {prompts.length === 0 ? (
                <div className="empty-placeholder">No prompts saved.</div>
              ) : (
                prompts.map(p => (
                  <div className="card-item" key={p.id} style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 6 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', width: '100%' }}>
                      <span style={{ fontWeight: 600, color: '#fff' }}>{p.name}</span>
                    </div>
                    <span style={{ fontSize: 11, color: '#888', lineHeight: 1.3 }}>{p.text}</span>
                    <div style={{ display: 'flex', gap: 6, width: '100%', marginTop: 4 }}>
                      <button className="dock-btn-primary" style={{ fontSize: 10, padding: '4px 8px', flex: 1 }} onClick={() => handleSendAi(p.text, 'chatgpt')}>
                        ChatGPT
                      </button>
                      <button className="dock-btn-primary" style={{ fontSize: 10, padding: '4px 8px', flex: 1 }} onClick={() => handleSendAi(p.text, 'claude')}>
                        Claude
                      </button>
                      <button className="dock-btn-primary" style={{ fontSize: 10, padding: '4px 8px', flex: 1 }} onClick={() => handleSendAi(p.text, 'gemini')}>
                        Gemini
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        )}
      </main>
    </div>
  );
};

export default withErrorBoundary(withSuspense(SidePanel, <LoadingSpinner />), ErrorDisplay);

