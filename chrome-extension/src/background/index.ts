import { dockPinnedWindowsStorage, dockBlockedSitesStorage } from '@extension/storage';

// ─── Types ────────────────────────────────────────────────────────────────────

type AiTarget = 'chatgpt' | 'gemini' | 'claude';
type MenuContext = 'text' | 'image';

interface PendingRequest {
  selectedText?: string;
  imageUrl?: string;
  context: MenuContext;
  aiTarget: AiTarget;
}

const pendingRequests = new Map<number, PendingRequest>();
const originalWindowBounds = new Map<number, { left: number; top: number; width: number; height: number }>();

// ─── Dynamic DeclarativeNetRequest Rule Management ────────────────────────────
// Adds/removes header-stripping rules per pinned URL so iframes can load.
// Only strips X-Frame-Options and CSP frame-ancestors for URLs the user explicitly pins.

function urlToRuleId(url: string): number {
  // Simple hash to get a deterministic rule ID from a URL
  let hash = 0;
  for (let i = 0; i < url.length; i++) {
    hash = ((hash << 5) - hash + url.charCodeAt(i)) | 0;
  }
  // Keep in positive range and avoid 0
  return Math.abs(hash % 100000) + 1;
}

function getDomainPattern(url: string): string {
  try {
    const u = new URL(url);
    return `*://${u.hostname}/*`;
  } catch {
    return url;
  }
}

async function addHeaderStrippingRule(url: string): Promise<void> {
  const ruleId = urlToRuleId(url);
  const urlFilter = getDomainPattern(url);

  try {
    // Remove existing rule with same ID first
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [ruleId],
      addRules: [{
        id: ruleId,
        priority: 1,
        action: {
          type: chrome.declarativeNetRequest.RuleActionType.MODIFY_HEADERS,
          responseHeaders: [
            { header: 'x-frame-options', operation: chrome.declarativeNetRequest.HeaderOperation.REMOVE },
            { header: 'content-security-policy', operation: chrome.declarativeNetRequest.HeaderOperation.REMOVE },
            { header: 'x-content-type-options', operation: chrome.declarativeNetRequest.HeaderOperation.REMOVE },
          ],
        },
        condition: {
          urlFilter,
          resourceTypes: [
            chrome.declarativeNetRequest.ResourceType.SUB_FRAME,
          ],
        },
      }],
    });
  } catch (e) {
    console.warn('[Dock] Failed to add header stripping rule:', e);
  }
}

async function removeHeaderStrippingRule(url: string): Promise<void> {
  const ruleId = urlToRuleId(url);
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [ruleId],
    });
  } catch {}
}

async function clearAllDynamicRules(): Promise<void> {
  try {
    const existing = await chrome.declarativeNetRequest.getDynamicRules();
    if (existing.length > 0) {
      await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: existing.map(r => r.id),
      });
    }
  } catch {}
}

// ─── Blocked Site Detection ───────────────────────────────────────────────────

async function isDomainBlocked(url: string): Promise<boolean> {
  return dockBlockedSitesStorage.isBlocked(url);
}

async function markDomainBlocked(url: string): Promise<void> {
  try {
    const hostname = new URL(url).hostname;
    await dockBlockedSitesStorage.addBlocked(hostname);
  } catch {}
}

// ─── Companion Popup Window Manager ───────────────────────────────────────────
// Used for blocked sites that cannot load in iframes.

async function openOrFocusCompanion(data: { url: string; title?: string; favicon?: string; tabId?: number; tile?: boolean }) {
  // Clean up any lingering DNR rule for this URL before creating companion window
  await removeHeaderStrippingRule(data.url);

  const currentList = await dockPinnedWindowsStorage.get();
  const existing = currentList.find(p => p.url === data.url && p.mode === 'companion');

  if (existing && existing.windowId) {
    try {
      const win = await chrome.windows.get(existing.windowId);
      if (win) {
        await chrome.windows.update(existing.windowId, { focused: true });
        return { ok: true, windowId: existing.windowId };
      }
    } catch {
      // Window was closed, recreate
    }
  }

  const activeCount = currentList.filter(p => p.windowId > 0 && p.mode === 'companion').length;
  const companionWidth = 480;
  const offset = (activeCount % 5) * 30;

  let left = 1000 + offset;
  let top = 40 + offset;
  let companionHeight = 750;
  const shouldTile = data.tile !== false;

  try {
    const currentWin = await chrome.windows.getCurrent();
    if (currentWin && currentWin.id) {
      const winLeft = Math.max(0, currentWin.left ?? 0);
      const winTop = Math.max(0, currentWin.top ?? 0);
      const winWidth = Math.max(800, currentWin.width ?? 1200);
      const winHeight = Math.max(600, currentWin.height ?? 800);
      companionHeight = winHeight;

      if (shouldTile) {
        if (!originalWindowBounds.has(currentWin.id)) {
          originalWindowBounds.set(currentWin.id, {
            left: winLeft,
            top: winTop,
            width: winWidth,
            height: winHeight,
          });
        }

        const mainWidth = Math.max(600, winWidth - companionWidth - 10);

        try {
          await chrome.windows.update(currentWin.id, {
            state: 'normal',
            left: winLeft,
            top: winTop,
            width: mainWidth,
            height: winHeight,
          });
        } catch {}

        left = winLeft + mainWidth + 6;
        top = winTop;
      } else {
        left = Math.max(0, winLeft + winWidth - companionWidth - 20 - offset);
        top = Math.max(0, winTop + 30 + offset);
      }
    }
  } catch {}

  const win = await chrome.windows.create({
    url: data.url,
    type: 'popup',
    width: companionWidth,
    height: companionHeight,
    left,
    top,
    focused: true,
  });

  const windowId = win.id ?? 0;
  const tabId = win.tabs?.[0]?.id ?? data.tabId ?? 0;

  await dockPinnedWindowsStorage.addPinned({
    tabId,
    windowId,
    url: data.url,
    title: data.title || win.tabs?.[0]?.title || data.url,
    favicon: data.favicon || win.tabs?.[0]?.favIconUrl,
    width: companionWidth,
    height: companionHeight,
    left,
    top,
    mode: 'companion',
  });

  return { ok: true, windowId };
}

// Keep storage in sync and restore main window bounds when companions are closed
chrome.windows.onRemoved.addListener(async (removedWindowId) => {
  const list = await dockPinnedWindowsStorage.get();
  const removedItem = list.find(p => p.windowId === removedWindowId);

  await dockPinnedWindowsStorage.removePinned(removedWindowId);
  pendingRequests.delete(removedWindowId);

  // Clean up DNR rule if it was a companion that had one
  if (removedItem) {
    removeHeaderStrippingRule(removedItem.url);
  }

  const remaining = await dockPinnedWindowsStorage.get();
  const activeCompanions = remaining.filter(p => p.windowId > 0 && p.mode === 'companion');
  if (activeCompanions.length === 0) {
    try {
      const currentWin = await chrome.windows.getCurrent();
      if (currentWin.id && originalWindowBounds.has(currentWin.id)) {
        const bounds = originalWindowBounds.get(currentWin.id)!;
        await chrome.windows.update(currentWin.id, bounds);
        originalWindowBounds.delete(currentWin.id);
      }
    } catch {}
  }
});

// Clean up stale window references on startup
async function cleanupStaleWindows() {
  const currentList = await dockPinnedWindowsStorage.get();
  for (const item of currentList) {
    if (item.windowId && item.mode === 'companion') {
      try {
        await chrome.windows.get(item.windowId);
      } catch {
        await dockPinnedWindowsStorage.removePinned(item.windowId);
      }
    }
  }
}

// ─── Keyboard Shortcut: Bring All Companions to Front ─────────────────────────

chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'bring-companions-front') {
    const list = await dockPinnedWindowsStorage.get();
    const activeCompanions = list.filter(p => p.windowId && p.windowId > 0 && p.mode === 'companion');
    for (const comp of activeCompanions) {
      try {
        await chrome.windows.update(comp.windowId, { focused: true });
      } catch {}
    }
  }
});

// ─── Lifecycle and Context Menu Setup ─────────────────────────────────────────

chrome.runtime.onInstalled.addListener((details) => {
  chrome.runtime.setUninstallURL(
    'https://docs.google.com/forms/d/e/1FAIpQLScb5y0IGzQyhToLt-A0XAMZoSJed9_iIMWV4gdhek4AnjBagw/viewform?usp=sharing&ouid=102550442351225860550'
  );

  if (details.reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('install/index.html') });
  }

  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'dock-parent', title: 'Dock', contexts: ['selection', 'image'] });
    chrome.contextMenus.create({ id: 'dock-text-chatgpt', parentId: 'dock-parent', title: 'Ask ChatGPT', contexts: ['selection'] });
    chrome.contextMenus.create({ id: 'dock-text-gemini', parentId: 'dock-parent', title: 'Ask Gemini', contexts: ['selection'] });
    chrome.contextMenus.create({ id: 'dock-text-claude', parentId: 'dock-parent', title: 'Ask Claude', contexts: ['selection'] });
    chrome.contextMenus.create({ id: 'dock-sep', parentId: 'dock-parent', type: 'separator', contexts: ['image'] });
    chrome.contextMenus.create({ id: 'dock-img-chatgpt', parentId: 'dock-parent', title: 'Send image to ChatGPT', contexts: ['image'] });
    chrome.contextMenus.create({ id: 'dock-img-gemini', parentId: 'dock-parent', title: 'Send image to Gemini', contexts: ['image'] });
    chrome.contextMenus.create({ id: 'dock-img-claude', parentId: 'dock-parent', title: 'Send image to Claude', contexts: ['image'] });
  });

  // Clean up any stale DNR rules from previous session
  clearAllDynamicRules();
});

chrome.runtime.onStartup.addListener(() => {
  cleanupStaleWindows();
  // Re-add DNR rules for any iframe-mode pins that survived restart
  (async () => {
    const list = await dockPinnedWindowsStorage.get();
    for (const item of list) {
      if (item.mode === 'iframe') {
        await addHeaderStrippingRule(item.url);
      }
    }
  })();
});

// ─── Context Menu Click Handler ───────────────────────────────────────────────

chrome.contextMenus.onClicked.addListener(async (info) => {
  const menuId = info.menuItemId as string;
  if (!menuId.startsWith('dock-')) return;

  const aiMap: Record<string, AiTarget> = { chatgpt: 'chatgpt', gemini: 'gemini', claude: 'claude' };
  const parts = menuId.split('-');
  const aiKey = parts[2];
  if (!aiKey || !aiMap[aiKey]) return;

  const aiTarget = aiMap[aiKey];
  const context: MenuContext = parts[1] === 'img' ? 'image' : 'text';

  if (context === 'text' && info.selectionText) {
    await openPromptPicker({ selectedText: info.selectionText, context: 'text', aiTarget });
  } else if (context === 'image' && info.srcUrl) {
    await openPromptPicker({ imageUrl: info.srcUrl, context: 'image', aiTarget });
  }
});

// ─── Prompt Picker Window ─────────────────────────────────────────────────────

async function openPromptPicker(request: PendingRequest) {
  const pickerUrl = chrome.runtime.getURL('popup/index.html') + '?mode=prompt-picker';
  const win = await chrome.windows.create({ url: pickerUrl, type: 'popup', width: 380, height: 420, focused: true });
  if (win.id) { pendingRequests.set(win.id, request); }
}

// ─── Message Handlers ─────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const msg = message as { type: string; [key: string]: unknown };

  // ── Check if sender tab/window is a companion window ───────────────────────
  if (msg.type === 'IS_COMPANION_TAB') {
    const senderWinId = _sender.tab?.windowId;
    const senderTabId = _sender.tab?.id;
    (async () => {
      const list = await dockPinnedWindowsStorage.get();
      const isComp = list.some(p => p.mode === 'companion' && ((senderWinId && p.windowId === senderWinId) || (senderTabId && p.tabId === senderTabId)));
      sendResponse({ isCompanion: isComp });
    })();
    return true;
  }

  // ── Prompt picker data request ─────────────────────────────────────────────
  if (msg.type === 'GET_PICKER_DATA') {
    chrome.windows.getCurrent({}, win => {
      sendResponse({ data: win.id !== undefined ? (pendingRequests.get(win.id) ?? null) : null });
    });
    return true;
  }

  // ── Send to AI ─────────────────────────────────────────────────────────────
  if (msg.type === 'SEND_TO_AI') {
    const { aiTarget, promptText, selectedText, imageUrl, windowId } = msg as {
      type: string; aiTarget: AiTarget; promptText: string;
      selectedText?: string; imageUrl?: string; windowId?: number;
    };

    const combined = imageUrl
      ? `${promptText ? promptText + '\n\n' : ''}Image URL: ${imageUrl}`
      : `${promptText ? promptText + '\n\n' : ''}${selectedText ?? ''}`;

    chrome.storage.local.set({ 'dock-ai-pending': { text: combined.trim(), target: aiTarget } });

    const urlMap: Record<AiTarget, string> = {
      chatgpt: 'https://chatgpt.com/',
      gemini: 'https://gemini.google.com/app',
      claude: 'https://claude.ai/new',
    };
    chrome.tabs.create({ url: urlMap[aiTarget] });

    if (windowId !== undefined) {
      pendingRequests.delete(windowId);
      chrome.windows.remove(windowId).catch(() => {});
    }
    sendResponse({ ok: true });
    return true;
  }

  // ── Pin Tab (Hybrid: Companion-First for blocked sites, Iframe for normal) ──
  if (msg.type === 'PIN_TAB' || msg.type === 'OPEN_COMPANION') {
    const { url, title, favicon, tabId } = msg as {
      type: string; url: string; title?: string; favicon?: string; tabId?: number;
    };

    (async () => {
      try {
        const isBlocked = await isDomainBlocked(url);

        if (isBlocked) {
          // COMPANION_FIRST: Site does not support iframes, launch directly in clean companion popup window
          await removeHeaderStrippingRule(url);
          const result = await openOrFocusCompanion({
            url,
            title,
            favicon,
            tabId,
          });
          sendResponse({ ok: true, mode: 'companion', windowId: result.windowId });
          return;
        }

        // NORMAL mode: Strip X-Frame-Options and CSP headers for this URL so it renders in the dock overlay
        await addHeaderStrippingRule(url);

        const currentList = await dockPinnedWindowsStorage.get();
        const existing = currentList.find(p => p.url === url);
        if (existing) {
          sendResponse({ ok: true, mode: existing.mode });
          return;
        }

        await dockPinnedWindowsStorage.addPinned({
          tabId: tabId ?? 0,
          windowId: 0,
          url,
          title: title || url.replace(/^https?:\/\/(www\.)?/, ''),
          favicon,
          mode: 'iframe',
        });

        sendResponse({ ok: true, mode: 'iframe' });
      } catch (err) {
        console.warn('Failed to pin tab:', err);
        sendResponse({ ok: false, error: String(err) });
      }
    })();
    return true;
  }

  // ── Iframe blocked - content script detected the iframe failed ─────────────
  if (msg.type === 'IFRAME_BLOCKED') {
    const { url } = msg as { type: string; url: string };
    (async () => {
      await markDomainBlocked(url);
      await removeHeaderStrippingRule(url);
      sendResponse({ ok: true });
    })();
    return true;
  }

  // ── Switch from iframe to companion window ────────────────────────────────
  if (msg.type === 'SWITCH_TO_COMPANION') {
    const { url, title, favicon, tabId } = msg as {
      type: string;
      url: string;
      title?: string;
      favicon?: string;
      tabId?: number;
    };

    (async () => {
      try {
        // 1. Remove DNR header stripping rule first to eliminate race conditions
        await removeHeaderStrippingRule(url);

        // 2. Mark this domain as blocked for future companion-first pinning
        await markDomainBlocked(url);

        // 3. Remove the old iframe pin from storage
        await dockPinnedWindowsStorage.removePinned(url);

        // 4. Open clean companion window
        const result = await openOrFocusCompanion({ url, title, favicon, tabId });
        sendResponse(result);
      } catch (err) {
        console.warn('Failed to switch to companion:', err);
        sendResponse({ ok: false, error: String(err) });
      }
    })();
    return true;
  }

  // ── Unpin (works for both iframe and companion modes) ─────────────────────
  if (msg.type === 'UNPIN_WINDOW' || msg.type === 'CLOSE_COMPANION') {
    const { url, windowId } = msg as { type: string; url?: string; windowId?: number };
    (async () => {
      if (windowId !== undefined && windowId > 0) {
        const list = await dockPinnedWindowsStorage.get();
        const item = list.find(p => p.windowId === windowId);
        if (item) {
          await removeHeaderStrippingRule(item.url);
        }
        chrome.windows.remove(windowId).catch(() => {});
        await dockPinnedWindowsStorage.removePinned(windowId);
      } else if (url) {
        await removeHeaderStrippingRule(url);
        const list = await dockPinnedWindowsStorage.get();
        const item = list.find(p => p.url === url);
        if (item?.windowId) {
          chrome.windows.remove(item.windowId).catch(() => {});
        }
        await dockPinnedWindowsStorage.removePinned(url);
      }
      sendResponse({ ok: true });
    })();
    return true;
  }

  // ── Focus Companion Window ────────────────────────────────────────────────
  if (msg.type === 'FOCUS_COMPANION') {
    const { windowId } = msg as { type: string; windowId: number };
    if (windowId) {
      chrome.windows.update(windowId, { focused: true }).catch(() => {});
    }
    sendResponse({ ok: true });
    return true;
  }

  // ── Toggle Fullscreen ─────────────────────────────────────────────────────
  if (msg.type === 'TOGGLE_COMPANION_FULLSCREEN') {
    const { windowId } = msg as { type: string; windowId: number };
    if (windowId) {
      (async () => {
        try {
          const win = await chrome.windows.get(windowId);
          const nextState = win.state === 'fullscreen' ? 'normal' : 'fullscreen';
          await chrome.windows.update(windowId, { state: nextState, focused: true });
        } catch {}
        sendResponse({ ok: true });
      })();
      return true;
    }
    sendResponse({ ok: false });
    return true;
  }

  // ── Open Side Panel ───────────────────────────────────────────────────────
  if (msg.type === 'OPEN_SIDE_PANEL') {
    chrome.windows.getCurrent({}, (win) => {
      if (win.id) {
        chrome.sidePanel.open({ windowId: win.id }).catch(() => {});
      }
    });
    sendResponse({ ok: true });
    return true;
  }

  // ── Open in Full Standard Tab ─────────────────────────────────────────────
  if (msg.type === 'OPEN_IN_TAB') {
    const { url } = msg as { type: string; url: string };
    if (url) {
      chrome.tabs.query({ url }, matchingTabs => {
        if (matchingTabs && matchingTabs.length > 0 && matchingTabs[0].id) {
          chrome.tabs.update(matchingTabs[0].id, { active: true });
          if (matchingTabs[0].windowId) {
            chrome.windows.update(matchingTabs[0].windowId, { focused: true });
          }
        } else {
          chrome.tabs.create({ url });
        }
      });
    }
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'CLOSE_PICKER') {
    const { windowId } = msg as { type: string; windowId: number };
    pendingRequests.delete(windowId);
    chrome.windows.remove(windowId).catch(() => {});
    sendResponse({ ok: true });
    return true;
  }

  return undefined;
});

