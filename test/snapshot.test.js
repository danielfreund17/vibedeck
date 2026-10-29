'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const snap = require('../src/snapshot');

const PS = `
  100     1 /Applications/VibeDeck.app/Contents/MacOS/VibeDeck
  200   100 zsh (kiro-cli-term)
  201   200 /bin/zsh
  202   201 pi
  203   202 /Users/x/.local/bin/claude
  300   100 -zsh
  301   300 /Users/x/.local/bin/claude
  400   100 -zsh
  401   400 vim
`;

test('parseProcessTable keeps comm names with spaces', () => {
  const rows = snap.parseProcessTable(PS);
  assert.equal(rows.length, 9);
  assert.deepEqual(rows[1], { pid: 200, ppid: 100, comm: 'zsh (kiro-cli-term)' });
});

test('findAgentProcess should find the shallowest agent below a shell', () => {
  const rows = snap.parseProcessTable(PS);
  assert.deepEqual(snap.findAgentProcess(rows, 200), { pid: 202, kind: 'pi' }); // not the nested claude
  assert.deepEqual(snap.findAgentProcess(rows, 300), { pid: 301, kind: 'claude' });
  assert.equal(snap.findAgentProcess(rows, 400), null);
  assert.equal(snap.findAgentProcess(rows, 999), null);
});

test('carryFlags should keep only allow-listed flags with safe values', () => {
  assert.deepEqual(
    snap.carryFlags('claude', ['--dangerously-skip-permissions', '--resume', 'abc', '-p', 'do stuff', '--model', 'opus']),
    ['--dangerously-skip-permissions', '--model', 'opus']
  );
  assert.deepEqual(snap.carryFlags('claude', ['--permission-mode=plan']), ['--permission-mode', 'plan']);
  assert.deepEqual(snap.carryFlags('pi', ['--api-key', 'sk-secret', '--model', 'anthropic/claude-opus-4-5', '--thinking', 'high']), [
    '--model',
    'anthropic/claude-opus-4-5',
    '--thinking',
    'high',
  ]);
  assert.deepEqual(snap.carryFlags('pi', ['--model', '$(rm -rf ~)']), []);
  assert.deepEqual(snap.carryFlags('pi', ['--model']), []);
});

test('buildResumeCommand should build per-agent commands with a quoted cwd', () => {
  assert.equal(
    snap.buildResumeCommand({ kind: 'pi', sessionId: '01a15a8b-9ecc-70d0-8c41-1fb3dfc423f5', cwd: '/Users/x/git-repos/cxllm' }),
    "builtin cd -- '/Users/x/git-repos/cxllm' && pi --session 01a15a8b-9ecc-70d0-8c41-1fb3dfc423f5"
  );
  assert.equal(
    snap.buildResumeCommand({ kind: 'claude', sessionId: 'e6891b25', cwd: "/tmp/it's here", flags: ['--dangerously-skip-permissions'] }),
    "builtin cd -- '/tmp/it'\\''s here' && claude --dangerously-skip-permissions --resume e6891b25"
  );
});

test('buildResumeCommand should reject unsafe input', () => {
  assert.throws(() => snap.buildResumeCommand({ kind: 'pi', sessionId: 'x; rm -rf ~', cwd: '/tmp' }), /session id/);
  assert.throws(() => snap.buildResumeCommand({ kind: 'pi', sessionId: 'abc', cwd: 'relative' }), /cwd/);
  assert.throws(() => snap.buildResumeCommand({ kind: 'bash', sessionId: 'abc', cwd: '/tmp' }), /kind/);
});

const STATE = {
  repos: [
    {
      id: 'r1',
      name: 'cxllm',
      cwd: '/repo/cxllm',
      sessions: [
        { id: 's1', slug: 'tg_a', name: 'Voice OTP', nameSource: 'manual', cwd: '/repo/cxllm' },
        { id: 's2', slug: 'tg_b', name: 'shell', nameSource: 'default' },
      ],
    },
  ],
};

test('buildSnapshot should attach agents by slug and count them', () => {
  const snapshot = snap.buildSnapshot({
    state: STATE,
    agentsBySlug: { tg_a: { kind: 'pi', sessionId: 'abc', cwd: '/repo/wt', sessionFile: '/s.jsonl', flags: [] } },
    trigger: 'manual',
    now: new Date('2026-10-26T14:03:00.000Z'),
  });
  assert.equal(snapshot.agentCount, 1);
  assert.equal(snapshot.takenAt, '2026-10-26T14:03:00.000Z');
  assert.equal(snapshot.repos[0].sessions[0].agent.cwd, '/repo/wt');
  assert.equal(snapshot.repos[0].sessions[1].agent, null);
  assert.equal(snapshot.repos[0].sessions[1].cwd, '/repo/cxllm'); // falls back to repo cwd
});

test('buildSnapshot should carry tab tags (empty list when none)', () => {
  const state = { repos: [{ id: 'r', name: 'r', cwd: '/r', sessions: [{ id: 'a', slug: 'tg_a', name: 'a', tags: ['needs QA'] }, { id: 'b', slug: 'tg_b', name: 'b' }] }] };
  const snapshot = snap.buildSnapshot({ state, agentsBySlug: {}, trigger: 'manual' });
  assert.deepEqual(snapshot.repos[0].sessions.map((s) => s.tags), [['needs QA'], []]);
});

test('snapshot file names should round-trip and sort newest first', () => {
  const name = snap.snapshotFileName(new Date('2026-10-26T14:03:05.123Z'), 'daily');
  assert.equal(name, '2026-10-26T14-03-05-123Z-daily.json');
  const parsed = snap.parseSnapshotFileName(name);
  assert.equal(parsed.trigger, 'daily');
  assert.equal(snap.stampToDate(parsed.stamp).toISOString(), '2026-10-26T14:03:05.123Z');
  assert.equal(snap.parseSnapshotFileName('../../etc/passwd'), null);
  const sorted = snap.sortSnapshotNames([
    '2026-10-25T10-00-00-000Z-quit.json',
    'junk.txt',
    '2026-10-26T10-00-00-000Z-daily.json',
  ]);
  assert.deepEqual(sorted.map((e) => e.name), ['2026-10-26T10-00-00-000Z-daily.json', '2026-10-25T10-00-00-000Z-quit.json']);
});

test('hasDailyFor should look at the local calendar day', () => {
  const now = new Date(2026, 9, 26, 18, 0, 0); // local time
  const todayName = snap.snapshotFileName(new Date(2026, 9, 26, 9, 0, 0), 'daily');
  const yesterdayName = snap.snapshotFileName(new Date(2026, 9, 25, 9, 0, 0), 'daily');
  const todayQuit = snap.snapshotFileName(new Date(2026, 9, 26, 9, 0, 0), 'quit');
  assert.equal(snap.hasDailyFor([todayName], now), true);
  assert.equal(snap.hasDailyFor([yesterdayName, todayQuit], now), false);
});

test('namesToPrune should keep the newest N per trigger', () => {
  const names = [];
  for (let d = 1; d <= 5; d++) names.push(`2026-10-0${d}T10-00-00-000Z-daily.json`);
  for (let d = 1; d <= 3; d++) names.push(`2026-10-0${d}T11-00-00-000Z-quit.json`);
  assert.deepEqual(snap.namesToPrune(names, { keepDaily: 3, keepOther: 2 }).sort(), [
    '2026-10-01T10-00-00-000Z-daily.json',
    '2026-10-01T11-00-00-000Z-quit.json',
    '2026-10-02T10-00-00-000Z-daily.json',
  ]);
});

test('planRestore should resume, skip running, and skip missing paths', () => {
  const snapshot = {
    repos: [
      {
        id: 'r1',
        sessions: [
          { id: 's1', slug: 'tg_a', name: 'A', agent: { kind: 'pi', sessionId: 'p1', cwd: '/ok', sessionFile: '/ok/p1.jsonl' } },
          { id: 's2', slug: 'tg_b', name: 'B', agent: { kind: 'claude', sessionId: 'c1', cwd: '/ok' } },
          { id: 's3', slug: 'tg_c', name: 'C', agent: { kind: 'claude', sessionId: 'c2', cwd: '/gone' } },
          { id: 's4', slug: 'tg_d', name: 'D', agent: { kind: 'pi', sessionId: 'p2', cwd: '/ok', sessionFile: '/gone.jsonl' } },
          { id: 's5', slug: 'tg_e', name: 'E', agent: null },
        ],
      },
    ],
  };
  const items = snap.planRestore(snapshot, {
    liveAgentSlugs: new Set(['tg_b']),
    exists: (p) => !p.includes('gone'),
  });
  assert.deepEqual(
    items.map((i) => [i.sessionId, i.action, i.reason || i.command]),
    [
      ['s1', 'resume', "builtin cd -- '/ok' && pi --session p1"],
      ['s2', 'skip', 'already running'],
      ['s3', 'skip', 'directory missing: /gone'],
      ['s4', 'skip', 'session file missing'],
    ]
  );
});
