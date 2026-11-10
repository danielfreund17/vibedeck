'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const w = require('../src/work-items');
const { normalizeConfig } = require('../src/trackers');

// A made-up tracker: an `acme` issue CLI with ACME-123 ids, worked on in
// ~/work/ACME-123/<repo> worktrees.
const { trackers } = normalizeConfig({
  trackers: [
    {
      name: 'acme',
      detect: {
        command: ['\\bacme\\s+(?:start|done)\\s+(ACME-\\d+)', '/work/(ACME-\\d+)/'],
        output: [{ when: '\\bacme\\s+new\\b', match: 'Created (ACME-\\d+)' }],
      },
    },
  ],
});

const shell = (command, output = '') => w.refsFromToolCall({ toolName: 'bash', command, output }, trackers);

test('prUrlsIn should extract and normalize PR URLs, ignoring non-PR GitHub links', () => {
  const text = [
    'https://github.com/o/r/pull/12',
    'see https://github.com/o/r/pull/012/files and https://github.com/o/r/issues/3',
    'https://github.com/o/other/pull/7.',
  ].join('\n');
  assert.deepEqual(w.prUrlsIn(text), ['https://github.com/o/r/pull/12', 'https://github.com/o/other/pull/7']);
});

test('parsePrUrl should accept sub-pages and query strings, and reject other URLs', () => {
  assert.deepEqual(w.parsePrUrl('https://github.com/o/r/pull/42/files?w=1'), {
    owner: 'o',
    repo: 'r',
    number: 42,
    url: 'https://github.com/o/r/pull/42',
  });
  assert.equal(w.parsePrUrl('https://github.com/o/r/issues/42'), null);
  assert.equal(w.parsePrUrl('github.com/o/r/pull/42'), null);
  assert.equal(w.prShortLabel('https://github.com/o/r/pull/42'), 'r#42');
});

test('ticket keys should round-trip tracker and id', () => {
  assert.equal(w.ticketKey('acme', 'ACME-1'), 'acme:ACME-1');
  assert.deepEqual(w.splitTicketKey('acme:ACME-1'), { tracker: 'acme', id: 'ACME-1' });
  assert.equal(w.splitTicketKey('nokey'), null);
});

test('refsFromToolCall should detect tickets from tracker command regexes', () => {
  assert.deepEqual(shell('acme start ACME-12').tickets, ['acme:ACME-12']);
  assert.deepEqual(shell('cd ~/work/ACME-7/api && git status').tickets, ['acme:ACME-7']);
  assert.deepEqual(shell('cd ~/work/ACME-7/api && acme done ACME-8').tickets, ['acme:ACME-7', 'acme:ACME-8']);
  assert.deepEqual(shell('echo ACME-99').tickets, [], 'a bare id is not a signal');
});

test('refsFromToolCall should detect tickets in output only when the command matches', () => {
  assert.deepEqual(shell('acme new "fix it"', 'Created ACME-50').tickets, ['acme:ACME-50']);
  assert.deepEqual(shell('cat log.txt', 'Created ACME-50').tickets, []);
});

test('refsFromToolCall should find nothing without trackers', () => {
  assert.deepEqual(w.refsFromToolCall({ toolName: 'bash', command: 'acme start ACME-12' }).tickets, []);
});

test('refsFromToolCall should take PR URLs only from gh pr create output', () => {
  const created = shell('gh pr create --draft --title x', 'https://github.com/o/r/pull/5\n');
  assert.deepEqual(created.prs, ['https://github.com/o/r/pull/5']);
  assert.equal(created.prEvent, true);
  const viewed = shell('gh pr view https://github.com/o/r/pull/9', 'https://github.com/o/r/pull/9');
  assert.deepEqual(viewed.prs, [], 'merely looking at a PR does not make it this tab\'s work');
  assert.equal(viewed.prEvent, false);
  assert.equal(shell('git push -u origin HEAD').prEvent, true);
  assert.equal(shell('gh pr merge 5 --squash').prEvent, true);
  assert.equal(shell('git -C ~/w/api push').prEvent, true);
});

test('refsFromToolCall should only count gh pr create in command position', () => {
  const url = 'https://github.com/o/r/pull/5';
  assert.deepEqual(shell('cd ~/w/api && GH_PROMPT_DISABLED=1 gh pr create -f', url).prs, [url]);
  assert.deepEqual(shell('if true; then gh pr create -f; fi', url).prs, [url]);
  assert.deepEqual(shell("cat > t.js <<'X'\nshell('x gh pr create')\nX\nnode scan.js", url).prs, []);
  assert.deepEqual(shell('grep -rn "gh pr create" .', url).prs, []);
  assert.equal(shell('echo "git push"').prEvent, false);
});

test('refsFromToolCall should accept create_pull_request MCP tools and ignore file-writing tools', () => {
  const mcp = w.refsFromToolCall({ toolName: 'mcp__github__create_pull_request', output: '{"html_url":"https://github.com/o/r/pull/8"}' });
  assert.deepEqual(mcp.prs, ['https://github.com/o/r/pull/8']);
  const write = w.refsFromToolCall({ toolName: 'Write', command: 'acme start ACME-1', output: '' }, trackers);
  assert.deepEqual(write, { tickets: [], prs: [], prEvent: false });
});

test('scanTranscriptLines should pair pi tool calls with their results', () => {
  const lines = [
    JSON.stringify({ type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'c1', name: 'bash', arguments: { command: 'gh pr create -t x' } }] } }),
    JSON.stringify({ type: 'message', message: { role: 'toolResult', toolCallId: 'c1', content: [{ type: 'text', text: 'https://github.com/o/r/pull/3' }] } }),
    JSON.stringify({ type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'c2', name: 'bash', arguments: { command: 'acme start ACME-4' } }] } }),
  ];
  const pending = new Map();
  const first = w.scanTranscriptLines(lines, { trackers, pending });
  assert.deepEqual(first.prs, ['https://github.com/o/r/pull/3']);
  assert.deepEqual(first.tickets, [], 'c2 has no result yet');
  assert.equal(pending.size, 1);
  const second = w.scanTranscriptLines(
    [JSON.stringify({ type: 'message', message: { role: 'toolResult', toolCallId: 'c2', content: [{ type: 'text', text: 'ok' }] } })],
    { trackers, pending }
  );
  assert.deepEqual(second.tickets, ['acme:ACME-4'], 'result read in a later chunk completes the call');
});

test('scanTranscriptLines should pair Claude Code tool_use with tool_result', () => {
  const lines = [
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'u1', name: 'Bash', input: { command: 'cd ~/work/ACME-2/web && gh pr create -f' } }] } }),
    JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'u1', content: 'https://github.com/o/web/pull/11\nShell cwd was reset to /x' }] } }),
    'not json',
    '{"broken":',
  ];
  const refs = w.scanTranscriptLines(lines, { trackers });
  assert.deepEqual(refs, { tickets: ['acme:ACME-2'], prs: ['https://github.com/o/web/pull/11'], prEvent: true });
});

test('buildPrStatusQuery / parsePrStatusResponse should batch and map PR status', () => {
  const { urls, query } = w.buildPrStatusQuery(['https://github.com/o/r/pull/1/files', 'nope', 'https://github.com/o/r/pull/2']);
  assert.deepEqual(urls, ['https://github.com/o/r/pull/1', 'https://github.com/o/r/pull/2']);
  assert.match(query, /p0: resource\(url: "https:\/\/github.com\/o\/r\/pull\/1"\)/);
  assert.match(query, /p1: resource/);
  assert.equal(w.buildPrStatusQuery([]).query, '');

  const response = {
    data: {
      p0: {
        number: 1,
        title: 'A',
        state: 'OPEN',
        isDraft: true,
        merged: false,
        headRefName: 'feat',
        reviewDecision: null,
        repository: { nameWithOwner: 'o/r' },
        commits: { nodes: [{ commit: { statusCheckRollup: { state: 'FAILURE' } } }] },
      },
      p1: { number: 2, title: 'B', state: 'CLOSED', merged: true, repository: { nameWithOwner: 'o/r' }, commits: { nodes: [] } },
    },
  };
  const out = w.parsePrStatusResponse(JSON.stringify(response), urls);
  assert.equal(out[urls[0]].checks, 'FAILURE');
  assert.equal(out[urls[0]].isDraft, true);
  assert.equal(out[urls[1]].state, 'MERGED');
  assert.equal(out[urls[1]].checks, null);
  assert.deepEqual(w.parsePrStatusResponse('garbage', urls), {});
});
