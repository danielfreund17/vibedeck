// Session tags: a shared, user-extendable list of labels (statuses like
// "needs QA" plus anything custom) that can be put on vertical tabs.
// Pure functions only, so they're unit-testable outside the renderer.
//
// Model: state.tags = [{ name, color }] (the list, in display order);
//        session.tags = [name, ...] — names from that list, matched case-insensitively.

export const DEFAULT_TAGS = [
  { name: 'exploration', color: '#f78fb3' },
  { name: 'in progress', color: '#6d8cff' },
  { name: 'needs review', color: '#b48cff' },
  { name: 'needs QA', color: '#ffb547' },
  { name: 'needs monitoring', color: '#4fd1c5' },
  { name: 'done monitoring', color: '#9ad66b' },
  { name: 'blocked', color: '#ff6b6b' },
  { name: 'done', color: '#3ddc84' },
];

// Custom tags get a stable color from their name.
const CUSTOM_COLORS = ['#f78fb3', '#f5a97f', '#e5c07b', '#56b6c2', '#61afef', '#c678dd', '#98c379', '#d19a66'];
export const MAX_TAG_LENGTH = 32;
const COLOR_RE = /^#[0-9a-f]{6}$/i;

export function normalizeTagName(raw) {
  return String(raw ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TAG_LENGTH);
}

export function tagKey(name) {
  return normalizeTagName(name).toLowerCase();
}

export function colorForTag(name) {
  const key = tagKey(name);
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  return CUSTOM_COLORS[hash % CUSTOM_COLORS.length];
}

function findTag(library, name) {
  const key = tagKey(name);
  return key ? library.find((t) => tagKey(t.name) === key) || null : null;
}

// A missing list (first run / old state) starts from the defaults; an existing
// one is cleaned (valid unique names, a color each) but never re-seeded, so
// deleting a default sticks.
export function normalizeTagLibrary(library) {
  if (!Array.isArray(library)) return DEFAULT_TAGS.map((t) => ({ ...t }));
  const out = [];
  for (const entry of library) {
    const name = normalizeTagName(entry?.name);
    if (!name || findTag(out, name)) continue;
    out.push({ name, color: COLOR_RE.test(entry?.color || '') ? entry.color : colorForTag(name) });
  }
  return out;
}

// Add a tag to the list unless it's already there (case-insensitively).
// Returns the canonical entry, or null for an empty name.
export function ensureTag(library, rawName) {
  const name = normalizeTagName(rawName);
  if (!name) return null;
  const existing = findTag(library, name);
  if (existing) return existing;
  const tag = { name, color: colorForTag(name) };
  library.push(tag);
  return tag;
}

export function hasTag(tags, name) {
  const key = tagKey(name);
  return (tags || []).some((t) => tagKey(t) === key);
}

export function withTag(tags, name) {
  const list = Array.isArray(tags) ? tags : [];
  return hasTag(list, name) ? list : [...list, name];
}

export function withoutTag(tags, name) {
  const key = tagKey(name);
  return (tags || []).filter((t) => tagKey(t) !== key);
}

// Session tags always point at a list entry, using its canonical spelling.
// Unknown names (e.g. a restored snapshot from before a tag was deleted) are
// added back to the list rather than silently dropped.
export function normalizeSessionTags(tags, library) {
  const out = [];
  for (const raw of Array.isArray(tags) ? tags : []) {
    const tag = ensureTag(library, raw);
    if (tag && !hasTag(out, tag.name)) out.push(tag.name);
  }
  return out;
}

// Order tags on a tab by their position in the list, so pills read consistently.
export function sortByLibrary(tags, library) {
  const index = (name) => {
    const i = library.findIndex((t) => tagKey(t.name) === tagKey(name));
    return i === -1 ? Infinity : i;
  };
  return [...(tags || [])].sort((a, b) => index(a) - index(b));
}

export function tagColor(library, name) {
  return findTag(library, name)?.color || colorForTag(name);
}

export function tagUsageCount(repos, name) {
  let count = 0;
  for (const repo of repos || []) for (const s of repo.sessions || []) if (hasTag(s.tags, name)) count++;
  return count;
}

// Picker rows for "Add Tag": tags not yet on the tab that match the query —
// exact match first (so typing "done" + Enter never picks "done monitoring"),
// then prefix, then substring, list order within each — plus a "create" row
// when the typed name isn't in the list yet.
export function tagPickerRows(library, query, currentTags = []) {
  const q = tagKey(query);
  const rank = (name) => {
    const key = tagKey(name);
    if (!q) return 0;
    if (key === q) return 0;
    if (key.startsWith(q)) return 1;
    return key.includes(q) ? 2 : -1;
  };
  const rows = library
    .filter((t) => !hasTag(currentTags, t.name))
    .map((t, i) => ({ tag: t, i, rank: rank(t.name) }))
    .filter((r) => r.rank !== -1)
    .sort((a, b) => a.rank - b.rank || a.i - b.i)
    .map((r) => ({ kind: 'existing', name: r.tag.name, color: r.tag.color }));
  const typed = normalizeTagName(query);
  if (typed && !findTag(library, typed)) rows.push({ kind: 'create', name: typed, color: colorForTag(typed) });
  return rows;
}
