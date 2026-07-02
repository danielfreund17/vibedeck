'use strict';

// tmux integration. Every command is invoked with an argv array (never a shell
// string), so slugs and paths can't be interpreted by a shell — no injection
// surface even though slugs/cwds originate from app state.

const os = require('os');
const fs = require('fs');
const path = require('path');
const { execFile, execFileSync } = require('child_process');
const pty = require('node-pty');

// Dedicated socket name so VibeDeck's sessions never collide with a tmux the
// user runs by hand.
const SOCKET = 'vibedeck';

// Session/IPC markers a parent Claude Code process exports. If VibeDeck is
// launched from within a Claude Code session these would leak into our shells
// and make a nested `claude` treat itself as a child session and fail (EPERM).
// We keep them out of both the session env and tmux's global environment.
const NEST_VARS = [
  'CLAUDECODE',
  'CLAUDE_CODE_SSE_PORT',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION',
];

const TMUX_CONF = `# VibeDeck managed config (socket: ${SOCKET})
set -g mouse on
set -g window-size latest
set -g history-limit 50000
set -g escape-time 10
set -g default-terminal "screen-256color"
set -g status off
set -g set-titles on
set -g set-titles-string "#T"
`;

function confPath(userDataDir) {
  return path.join(userDataDir, 'tmux.conf');
}

function ensureConf(userDataDir) {
  const p = confPath(userDataDir);
  fs.writeFileSync(p, TMUX_CONF, 'utf8');
  return p;
}

// Resolve the tmux binary explicitly: a GUI app launched from Finder does not
// inherit the shell PATH, so brew's /opt/homebrew/bin may be missing.
function resolveTmux() {
  const candidates = ['/opt/homebrew/bin/tmux', '/usr/local/bin/tmux', '/usr/bin/tmux'];
  for (const c of candidates) {
    try {
      fs.accessSync(c, fs.constants.X_OK);
      return c;
    } catch {
      /* try next */
    }
  }
  return 'tmux'; // fall back to PATH
}

// Slugs are app-generated (tg_<hex>); validate defensively before any use.
function isValidSlug(slug) {
  return typeof slug === 'string' && /^[A-Za-z0-9_-]+$/.test(slug);
}

function dirExists(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function shellEnv() {
  const env = { ...process.env };
  // Guarantee common bin dirs are present regardless of how the app launched.
  const extra = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'];
  env.PATH = [...new Set([...extra, ...(env.PATH ? env.PATH.split(':') : [])])].join(':');
  // Let programs (e.g. Claude Code) own the terminal title so VibeDeck can
  // auto-name sessions; suppress oh-my-zsh's idle title churn for our shells.
  env.DISABLE_AUTO_TITLE = 'true';
  // Don't leak a launcher's Claude Code session context into our shells.
  for (const key of Object.keys(env)) {
    if (key === 'CLAUDECODE' || key.startsWith('CLAUDE_CODE_')) delete env[key];
  }
  // GUI-launched apps don't inherit the shell's locale, leaving a C/POSIX locale
  // where TUIs (e.g. Claude Code) render box-drawing/glyphs as ASCII garbage.
  // Ensure a UTF-8 locale, like Terminal.app does.
  if (![env.LC_ALL, env.LC_CTYPE, env.LANG].some((v) => /utf-?8/i.test(v || ''))) {
    env.LANG = 'en_US.UTF-8';
  }
  return env;
}

// Spawn a pty running a tmux client attached to `slug` (creating it if needed).
// The tmux server keeps the shell alive after this client/pty dies. Returns the
// pty, whether this call created the session, and the resolved start dir — the
// caller fixes the cwd only for new sessions (see main.js scheduleInitialCd).
function spawnSession({ userDataDir, slug, cwd, cols, rows }) {
  if (!isValidSlug(slug)) throw new Error(`invalid session slug: ${slug}`);
  const tmuxBin = resolveTmux();
  const conf = ensureConf(userDataDir);
  const startDir = cwd && dirExists(cwd) ? cwd : os.homedir();
  const isNew = !sessionExists(tmuxBin, slug);

  const args = ['-L', SOCKET, '-f', conf, 'new-session', '-A', '-s', slug, '-c', startDir];
  const proc = pty.spawn(tmuxBin, args, {
    name: 'xterm-256color',
    cols: cols || 80,
    rows: rows || 24,
    cwd: startDir,
    env: shellEnv(),
  });
  return { proc, isNew, startDir };
}

// Exact-match check (the `=` prefix prevents tmux prefix matching).
function sessionExists(tmuxBin, slug) {
  try {
    execFileSync(tmuxBin, ['-L', SOCKET, 'has-session', '-t', `=${slug}`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}


// List slugs of sessions currently alive on our socket (for reconciliation).
function listSessions() {
  return new Promise((resolve) => {
    execFile(
      resolveTmux(),
      ['-L', SOCKET, 'list-sessions', '-F', '#{session_name}'],
      (err, stdout) => {
        if (err) return resolve([]); // no server or no sessions yet
        resolve(stdout.split('\n').map((s) => s.trim()).filter(Boolean));
      }
    );
  });
}

// Permanently destroy a session (user removed it).
function killSession(slug) {
  return new Promise((resolve) => {
    if (!isValidSlug(slug)) return resolve(false);
    execFile(resolveTmux(), ['-L', SOCKET, 'kill-session', '-t', slug], () => resolve(true));
  });
}

// Ensure the tmux server is running with our options applied, even if it was
// started earlier (a running server won't re-read the config file on its own).
function initServer(userDataDir) {
  const conf = ensureConf(userDataDir);
  const args = [
    '-L', SOCKET, '-f', conf, 'start-server',
    ';', 'set', '-g', 'set-titles', 'on',
    ';', 'set', '-g', 'set-titles-string', '#T',
  ];
  // Scrub inherited Claude Code markers from the global env so new sessions
  // (which inherit it) start as clean shells — also fixes an already-running
  // server, since start-server alone won't touch its existing global env.
  for (const v of NEST_VARS) args.push(';', 'set-environment', '-gu', v);
  return new Promise((resolve) => {
    execFile(resolveTmux(), args, { env: shellEnv() }, () => resolve());
  });
}

module.exports = { spawnSession, listSessions, killSession, isValidSlug, initServer };
