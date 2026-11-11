export interface Prompt {
  id: string;
  name: string;
  text: string;
}

// How shipped text is placed into the field: replace what's there, or add to it.
export type PlaceMode = 'replace' | 'newline' | 'comma' | 'space';

// Enough about a field to find it again after the page reloads: a CSS selector,
// plus attributes to fall back on when the page's structure shifts.
export interface FieldSpec {
  selector: string;
  tag: string;
  name?: string;
  placeholder?: string;
  ariaLabel?: string;
  label?: string;
  // Google Sheets: the column this destination fills, the row it started at, and
  // the sheet tab it's on.
  column?: string;
  row?: number;
  sheet?: string;
}

// Where shipped text goes: a field on a web page, or just Dock's manifest
// ("collect"), for copying into a spreadsheet in one go later.
export interface Destination {
  id: string;
  kind: 'field' | 'collect';
  name: string;
  url?: string;
  title?: string;
  favicon?: string;
  // Last tab the field was found in; re-resolved by URL when the tab is gone.
  tabId?: number;
  field?: FieldSpec;
  mode: PlaceMode;
  count: number;
  createdAt: number;
  lastUsedAt?: number;
}

// One entry in the manifest: a piece of text shipped to a destination.
export interface Shipment {
  id: string;
  text: string;
  destinationId: string;
  destinationName: string;
  sourceUrl?: string;
  sourceTitle?: string;
  at: number;
  ok: boolean;
  error?: string;
}
