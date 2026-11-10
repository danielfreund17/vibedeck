'use strict';

// Session work items: the PRs (and, with a configured tracker, the tickets) a
// tab's agent worked on. Pure helpers, no I/O — the polling, file watching and
// `gh` calls live in work-tracker.js; tracker config loading in trackers.js.
//
// A tab doesn't map to one cwd / branch / PR: agents `cd` into several
// worktrees in subshells, open PRs in many repos, and hand work to remote
// agents. So we anchor on what the agent *did*, read from its transcript:
//   - PRs: URLs printed by `gh pr create` (or a create-pull-request tool)
//   - tickets: whatever the configured trackers' regexes match in the shell
//     commands the agent ran (and, optionally, in their output)

const PR_URL_RE = /https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)(?![\w/])/g;
const SHELL_TOOL_RE = /^(bash|shell|exec|run_?command)$/i;
const CREATE_PR_TOOL_RE = /create_pull_request/i;
// Only in command position (start, or after ; && || | ( `then`/`do`), so a
// heredoc or script that merely *mentions* "gh pr create" doesn't count.
const CMD_START = String.raw`(?:^|[;&|(\n]\s*|\b(?:then|do|else)\s+)(?:[A-Z_][A-Z0-9_]*=\S*\s+)*`;
const GH_PR_CREATE_RE = new RegExp(String.raw`${CMD_START}gh\s+pr\s+create\b`);
// Commands after which a PR's status is worth re-checking right away.
const PR_EVENT_RE = new RegExp(String.raw`${CMD_START}(?:gh\s+pr\s+(?:create|merge|ready|close|reopen|edit)\b|git\s+(?:-C\s+\S+\s+)?push\b)`);

// Keep each ref once, at its *last* position — most recently touched last.
function uniqLast(list) {
  const seen = new Set();
  const out = [];
  for (let i = list.length - 1; i >= 0; i--) {
    if (seen.has(list[i])) continue;
    seen.add(list[i]);
    out.unshift(list[i]);
  }
  return out;
}

function normalizePrUrl(owner, repo, number) {
  return `https://github.com/${owner}/${repo}/pull/${Number(number)}`;
}

function prUrlsIn(text) {
  const out = [];
  for (const m of String(text || '').matchAll(PR_URL_RE)) out.push(normalizePrUrl(m[1], m[2], m[3]));
  return uniqLast(out);
}

// "https://github.com/o/r/pull/12[/files][?…]" → { owner, repo, number, url } or null.
function parsePrUrl(raw) {
  const m = String(raw || '')
    .trim()
    .match(/^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)(?:\/[\w-]+)*\/?(?:[?#].*)?$/);
  return m ? { owner: m[1], repo: m[2], number: Number(m[3]), url: normalizePrUrl(m[1], m[2], m[3]) } : null;
}

function prShortLabel(url) {
  const pr = parsePrUrl(url);
  return pr ? `${pr.repo}#${pr.number}` : String(url || '');
}

// Ticket ref key: "<tracker>:<id>", e.g. "jira:ABC-123".
function ticketKey(tracker, id) {
  return `${tracker}:${id}`;
}

function splitTicketKey(key) {
  const i = String(key || '').indexOf(':');
  return i > 0 ? { tracker: key.slice(0, i), id: key.slice(i + 1) } : null;
}

function firstCapture(match) {
  for (let i = 1; i < match.length; i++) if (match[i]) return match[i];
  return match[0];
}

// Tickets in one finished shell call, per tracker detector:
//   { name, command: [RegExp], output: [{ when: RegExp, match: RegExp }] }
// Ordered by where they appear (command first, then output).
function ticketsInShellCall(trackers, command, output) {
  const hits = [];
  const text = String(command);
  const out = String(output || '');
  for (const tracker of trackers || []) {
    for (const re of tracker.command || []) {
      for (const m of text.matchAll(re)) hits.push({ at: m.index, key: ticketKey(tracker.name, firstCapture(m)) });
    }
    for (const rule of tracker.output || []) {
      if (!rule.when.test(text)) continue;
      for (const m of out.matchAll(rule.match)) hits.push({ at: text.length + m.index, key: ticketKey(tracker.name, firstCapture(m)) });
    }
  }
  return uniqLast(hits.sort((a, b) => a.at - b.at).map((h) => h.key));
}

// Refs from one finished tool call. Only shell tools count for tickets and
// `gh pr create`, so a Write/Edit whose *content* mentions them is ignored.
function refsFromToolCall({ toolName, command, output }, trackers = []) {
  const refs = { tickets: [], prs: [], prEvent: false };
  const name = String(toolName || '');
  if (CREATE_PR_TOOL_RE.test(name)) {
    refs.prs = prUrlsIn(output);
    refs.prEvent = refs.prs.length > 0;
    return refs;
  }
  if (!SHELL_TOOL_RE.test(name) || !command) return refs;
  refs.tickets = ticketsInShellCall(trackers, command, output);
  if (GH_PR_CREATE_RE.test(command)) refs.prs = prUrlsIn(output);
  refs.prEvent = PR_EVENT_RE.test(command);
  return refs;
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => (typeof part === 'string' ? part : part && typeof part.text === 'string' ? part.text : ''))
    .join('\n');
}

function commandOf(input) {
  if (!input || typeof input !== 'object') return '';
  return typeof input.command === 'string' ? input.command : typeof input.cmd === 'string' ? input.cmd : '';
}

const MAX_PENDING_CALLS = 200;

// Feed transcript lines (pi or Claude Code JSONL) through the scanner.
// `pending` (Map callId → { toolName, command }) carries calls whose result
// hasn't been read yet across incremental reads.
function scanTranscriptLines(lines, { trackers = [], pending = new Map() } = {}) {
  const tickets = [];
  const prs = [];
  let prEvent = false;
  const finish = (callId, output) => {
    const call = pending.get(callId);
    if (!call) return;
    pending.delete(callId);
    const refs = refsFromToolCall({ ...call, output }, trackers);
    tickets.push(...refs.tickets);
    prs.push(...refs.prs);
    prEvent = prEvent || refs.prEvent;
  };

  for (const line of lines) {
    if (!line || line[0] !== '{') continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const message = entry.message;
    if (!message || typeof message !== 'object') continue;

    if (message.role === 'toolResult') {
      finish(message.toolCallId, textOf(message.content)); // pi: result is its own message
      continue;
    }
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (!part || typeof part !== 'object') continue;
      if (part.type === 'toolCall') pending.set(part.id, { toolName: part.name, command: commandOf(part.arguments) }); // pi
      else if (part.type === 'tool_use') pending.set(part.id, { toolName: part.name, command: commandOf(part.input) }); // Claude Code
      else if (part.type === 'tool_result') finish(part.tool_use_id, textOf(part.content)); // Claude Code
    }
  }
  // Aborted calls never get a result; don't let them pile up.
  if (pending.size > MAX_PENDING_CALLS) {
    [...pending.keys()].slice(0, pending.size - MAX_PENDING_CALLS).forEach((key) => pending.delete(key));
  }
  return { tickets: uniqLast(tickets), prs: uniqLast(prs), prEvent };
}

// ---- GitHub PR status: one GraphQL call for many PRs ----
const PR_FIELDS = `... on PullRequest {
  number title url state isDraft merged headRefName reviewDecision
  repository { nameWithOwner }
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
}`;

// URLs are validated/normalized by parsePrUrl, so embedding them is safe.
function buildPrStatusQuery(urls) {
  const valid = uniqLast((urls || []).map((u) => parsePrUrl(u)?.url).filter(Boolean));
  const body = valid.map((url, i) => `p${i}: resource(url: ${JSON.stringify(url)}) { ${PR_FIELDS} }`).join('\n');
  return { urls: valid, query: valid.length ? `query {\n${body}\n}` : '' };
}

function parsePrStatusResponse(json, urls) {
  let parsed = json;
  if (typeof json === 'string') {
    try {
      parsed = JSON.parse(json);
    } catch {
      parsed = null;
    }
  }
  const data = parsed?.data || {};
  const out = {};
  urls.forEach((url, i) => {
    const pr = data[`p${i}`];
    if (!pr || !pr.number) return;
    out[url] = {
      number: pr.number,
      title: pr.title || '',
      url,
      repo: pr.repository?.nameWithOwner || '',
      state: pr.merged ? 'MERGED' : pr.state || 'OPEN', // OPEN | CLOSED | MERGED
      isDraft: Boolean(pr.isDraft),
      headRefName: pr.headRefName || '',
      reviewDecision: pr.reviewDecision || null, // APPROVED | CHANGES_REQUESTED | REVIEW_REQUIRED | null
      checks: pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state || null, // SUCCESS | FAILURE | ERROR | PENDING | EXPECTED | null
    };
  });
  return out;
}

module.exports = {
  uniqLast,
  prUrlsIn,
  parsePrUrl,
  prShortLabel,
  ticketKey,
  splitTicketKey,
  ticketsInShellCall,
  refsFromToolCall,
  scanTranscriptLines,
  buildPrStatusQuery,
  parsePrStatusResponse,
};
