// Per-tab work items: the tickets and PRs a tab tracks, and how to show them.
// Pure functions (no DOM) so they can be unit-tested; renderer.js draws them.
//
// Persisted per session:
//   session.tickets    ["<tracker>:<id>", …]   most recently touched last
//   session.prs        ["https://github.com/o/r/pull/N", …]
//   session.hiddenWork [ref, …]  refs the user detached — auto-detection won't re-add them

export const MAX_REFS = 40;

// Most urgent first. A ticket takes the most urgent tone among its PRs.
export const TONE_RANK = {
  failing: 0,
  changes: 1,
  error: 2,
  pending: 3,
  open: 4,
  approved: 4,
  draft: 5,
  ticket: 6,
  unknown: 7,
  merged: 8,
  done: 8,
  closed: 9,
};
const FINISHED = new Set(['merged', 'done', 'closed']);

const TICKET_KEY_RE = /^[a-z0-9_-]{1,32}:\S{1,64}$/;
const PR_URL_RE = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+$/;

function cleanList(list, re) {
  return Array.isArray(list) ? [...new Set(list.filter((v) => typeof v === 'string' && re.test(v)))].slice(-MAX_REFS) : [];
}

export function normalizeSessionWork(session) {
  session.tickets = cleanList(session.tickets, TICKET_KEY_RE);
  session.prs = cleanList(session.prs, PR_URL_RE);
  session.hiddenWork = Array.isArray(session.hiddenWork)
    ? [...new Set(session.hiddenWork.filter((v) => typeof v === 'string'))].slice(-200)
    : [];
  return session;
}

// Add refs, moving re-touched ones to the end (most recent). Auto-detected refs
// the user detached stay detached; a manual attach clears that. Returns true if
// anything changed.
export function mergeRefs(session, { tickets = [], prs = [] } = {}, { manual = false } = {}) {
  const before = JSON.stringify([session.tickets, session.prs, session.hiddenWork]);
  const apply = (list, incoming) => {
    let out = list;
    for (const ref of incoming) {
      if (session.hiddenWork.includes(ref)) {
        if (!manual) continue;
        session.hiddenWork = session.hiddenWork.filter((h) => h !== ref);
      }
      out = [...out.filter((r) => r !== ref), ref];
    }
    return out.slice(-MAX_REFS);
  };
  session.tickets = apply(session.tickets, tickets.filter((k) => TICKET_KEY_RE.test(k)));
  session.prs = apply(session.prs, prs.filter((u) => PR_URL_RE.test(u)));
  return JSON.stringify([session.tickets, session.prs, session.hiddenWork]) !== before;
}

export function detachRef(session, ref) {
  session.tickets = session.tickets.filter((r) => r !== ref);
  session.prs = session.prs.filter((r) => r !== ref);
  if (!session.hiddenWork.includes(ref)) session.hiddenWork = [...session.hiddenWork, ref].slice(-200);
}

export function prLabel(url) {
  const m = String(url).match(/github\.com\/[^/]+\/([^/]+)\/pull\/(\d+)/);
  return m ? `${m[1]}#${m[2]}` : String(url);
}

export function prTone(status) {
  if (!status) return 'unknown';
  if (status.error) return 'error';
  if (status.state === 'MERGED') return 'merged';
  if (status.state === 'CLOSED') return 'closed';
  if (status.checks === 'FAILURE' || status.checks === 'ERROR') return 'failing';
  if (status.reviewDecision === 'CHANGES_REQUESTED') return 'changes';
  if (status.checks === 'PENDING' || status.checks === 'EXPECTED') return 'pending';
  if (status.isDraft) return 'draft';
  if (status.reviewDecision === 'APPROVED') return 'approved';
  return 'open';
}

function mostUrgent(tones) {
  return tones.reduce((best, tone) => (TONE_RANK[tone] < TONE_RANK[best] ? tone : best));
}

function ticketTone(info, prs) {
  if (prs.length) {
    const tone = mostUrgent(prs.map((p) => p.tone));
    if (tone === 'unknown' && info?.done) return 'done';
    return tone;
  }
  if (info?.done) return 'done';
  return info?.error ? 'error' : 'ticket';
}

export function isFinished(item) {
  return FINISHED.has(item.tone);
}

function prItem(url, statuses) {
  const status = statuses[url] || null;
  return { kind: 'pr', key: url, url, label: prLabel(url), title: status?.title || '', status, tone: prTone(status) };
}

// session + { [ticketKey]: info } + { [prUrl]: status } → display items, most
// relevant first: unfinished before finished, then by urgency, then recency.
// PRs that belong to a listed ticket are shown under it, not on their own.
export function buildWorkItems(session, tickets = {}, statuses = {}) {
  const items = [];
  const underTickets = new Set();
  session.tickets.forEach((key, recency) => {
    const info = tickets[key] || null;
    const prs = (info?.prs || []).map((url) => prItem(url, statuses));
    prs.forEach((p) => underTickets.add(p.url));
    items.push({
      kind: 'ticket',
      key,
      label: info?.label || key.slice(key.indexOf(':') + 1),
      title: info?.title || '',
      state: info?.state || '',
      url: info?.url || null,
      error: info?.error || null,
      prs,
      tone: ticketTone(info, prs),
      recency,
    });
  });
  session.prs.forEach((url, recency) => {
    if (!underTickets.has(url)) items.push({ ...prItem(url, statuses), recency });
  });
  return items.sort(
    (a, b) =>
      Number(isFinished(a)) - Number(isFinished(b)) || TONE_RANK[a.tone] - TONE_RANK[b.tone] || b.recency - a.recency
  );
}

const TONE_TEXT = {
  failing: 'CI ✗',
  changes: 'changes',
  error: '?',
  pending: 'CI …',
  approved: '✓',
  draft: 'draft',
  merged: 'merged',
  done: 'done',
  closed: 'closed',
};

export function toneText(tone) {
  return TONE_TEXT[tone] || '';
}

// "t196476 · 3 PRs · CI ✗" / "cxllm#4712 · draft"
export function chipText(item) {
  const parts = [item.label];
  if (item.kind === 'ticket' && item.prs.length) parts.push(item.prs.length === 1 ? '1 PR' : `${item.prs.length} PRs`);
  const tone = toneText(item.tone);
  if (tone) parts.push(tone);
  return parts.join(' · ');
}

function prLine(pr) {
  const tone = toneText(pr.tone) || (pr.tone === 'unknown' ? 'checking…' : pr.tone);
  return `${pr.label} — ${tone}${pr.title ? ` — ${pr.title}` : ''}${pr.status?.error ? ` (${pr.status.error})` : ''}`;
}

export function itemTooltip(item) {
  if (item.kind === 'pr') return [prLine(item), item.url].join('\n');
  const head = [item.label, item.title].filter(Boolean).join(' — ');
  const lines = [head + (item.state ? ` [${item.state}]` : '')];
  if (item.error) lines.push(`(${item.error})`);
  for (const pr of item.prs) lines.push(`  ${prLine(pr)}`);
  if (!item.prs.length) lines.push('  no PRs yet');
  return lines.join('\n');
}

// First `max` items, plus how many more are hidden. Finished items only show
// when nothing unfinished is left (they'd crowd out live work otherwise).
export function chipsFor(items, max = 2) {
  const live = items.filter((item) => !isFinished(item));
  // Nothing live left: one chip (the latest finished item) is enough.
  const shown = live.length ? live.slice(0, max) : items.slice(0, 1);
  return { shown, more: items.length - shown.length };
}

// Rows for the work-items list picker: each ticket, its PRs indented, ad-hoc PRs.
export function workListRows(items) {
  const rows = [];
  for (const item of items) {
    if (item.kind === 'ticket') {
      rows.push({
        label: [item.label, item.title].filter(Boolean).join(' — '),
        detail: [item.state, toneText(item.tone)].filter(Boolean).join(' · ') || (item.prs.length ? '' : 'no PRs yet'),
        value: { kind: 'ticket', ref: item.key, url: item.url },
      });
      for (const pr of item.prs) {
        rows.push({ label: `   ${pr.label}${pr.title ? ` — ${pr.title}` : ''}`, detail: toneText(pr.tone) || 'open', value: { kind: 'pr', ref: null, url: pr.url } });
      }
    } else {
      rows.push({ label: `${item.label}${item.title ? ` — ${item.title}` : ''}`, detail: toneText(item.tone) || 'open', value: { kind: 'pr', ref: item.url, url: item.url } });
    }
  }
  return rows;
}
