# Dock.

> Copy from one tab into another without switching tabs. Select text, right-click, **Dock → Ship to “SO ID”**, and it lands in the field you picked on another page. Also sends text or images to ChatGPT, Claude or Gemini. 100% local.

---

## Who it's for

Anyone who moves the same kind of data from one web app into another, over and over: recruiters copying candidate names into an ATS, employees collecting job or order IDs from an internal portal into a sheet or notes, support agents moving order numbers into a CRM, VAs and ops people filling forms from another tab.

## The problems Dock solves

### 1. Copy, switch tab, find the field, paste, switch back. A hundred times. — Ship
* **The problem:** You're searching an internal jobs portal and need every SO ID, job title and hiring manager in a sheet or a notes app. Each one means copy → switch tab → click the field → paste → switch back.
* **The solution:** Show Dock the field **once**: select text → right-click → **Dock → Ship to a field in another tab…** → pick the tab → click the field → name it (“SO ID”). Dock pastes it and brings you back. From then on, every selection is one right-click: **Dock → Ship to “SO ID”** (or `Alt+Shift+S`). You never leave the page you're reading.
* **How it's placed:** add on a new line (build a list), replace, or add after a comma or space. Set up several destinations (SO ID, Name, Hiring manager) and each shows up in the menu.
* **The Manifest:** every shipment is logged locally. Copy them all as a column for Excel or Google Sheets, download a CSV, or retry anything that didn't land. Destinations can also be **collect-only** (no page): ideal for spreadsheets, whose cells are drawn on a canvas that extensions can't type into reliably.

### 2. AI copy-paste friction — AI actions
* **The problem:** Sending text or an image to an AI means opening the AI tab, pasting, typing your instructions and hitting send.
* **The solution:** Select text or right-click an image → **Dock** → ChatGPT, Claude or Gemini. Pick a saved prompt or type instructions, and Dock opens the AI in your own logged-in account, attaches the image, fills in the prompt and sends it. No extra subscription or API key.

---

## Shortcuts

| Shortcut | Action |
| :--- | :--- |
| `Alt+Shift+S` | Ship the selected text to your last-used destination (change it at `chrome://extensions/shortcuts`) |

## Privacy & permissions

Destinations, the manifest and prompts are stored in `chrome.storage` on your device. Dock has no servers, accounts or analytics.

| Permission | Why |
| :--- | :--- |
| `contextMenus` | The right-click **Dock** menu |
| `activeTab`, `scripting` | Read the text you selected on the page you right-clicked, and show a small “Shipped” confirmation there |
| `tabs` | List your open tabs when you choose where to ship, and find the destination tab again |
| `storage` | Save destinations, the manifest and prompts locally |
| `sidePanel` | Use Dock from Chrome's side panel |
| Content script on chatgpt.com, claude.ai, gemini.google.com | Fill in and send your prompt there |
| Optional, per site | Asked once for each site you pick a destination field on (so Dock can paste there), or send an image from |

---

## Development

```bash
pnpm install          # install dependencies
pnpm build            # production build into dist/
pnpm zip              # build + zip for the Chrome Web Store (dist-zip/)
```

Load in Chrome: `chrome://extensions` → enable Developer mode → **Load unpacked** → select `dist/`.

### Layout

| Path | What |
| :--- | :--- |
| `chrome-extension/src/background/` | Shipping, context menus, AI dispatch |
| `chrome-extension/manifest.ts` | Manifest source |
| `pages/popup/` | The UI: toolbar popup / side panel, destination chooser, AI prompt picker |
| `pages/content/src/matches/picker/` | Field picker overlay, injected only when you pick a destination field |
| `pages/content/src/matches/ai/` | Auto-fill and send on ChatGPT, Claude and Gemini |
| `packages/storage/lib/impl/` | Storage (`dock-storage.ts`) and types |

---

## License

MIT
