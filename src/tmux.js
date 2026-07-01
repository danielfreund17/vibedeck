'use strict';

// tmux integration. Every command is invoked with an argv array (never a shell
// string), so slugs and paths can't be interpreted by a shell — no injection
// surface even though slugs/cwds originate from app state.

const os = require('os');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const pty = require('node-pty');

// Dedicated socket name so VibeDeck's sessions never collide with a tmux the
// user runs by hand.
const SOCKET = 'vibedeck';

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
  return env;
}

// Spawn a pty running a tmux client attached to `slug` (creating it if needed).
// The tmux server keeps the shell alive after this client/pty dies.
function spawnSession({ userDataDir, slug, cwd, cols, rows }) {
  if (!isValidSlug(slug)) throw new Error(`invalid session slug: ${slug}`);
  const tmuxBin = resolveTmux();
  const conf = ensureConf(userDataDir);
  const startDir = cwd && dirExists(cwd) ? cwd : os.homedir();
  const args = [
    '-L', SOCKET,
    '-f', conf,
    'new-session', '-A',
    '-s', slug,
    '-c', startDir,
  ];
  return pty.spawn(tmuxBin, args, {
    name: 'xterm-256color',
    cols: cols || 80,
    rows: rows || 24,
    cwd: startDir,
    env: shellEnv(),
  });
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
  return new Promise((resolve) => {
    execFile(
      resolveTmux(),
      [
        '-L', SOCKET, '-f', conf, 'start-server',
        ';', 'set', '-g', 'set-titles', 'on',
        ';', 'set', '-g', 'set-titles-string', '#T',
      ],
      () => resolve()
    );
  });
}

module.exports = { spawnSession, listSessions, killSession, isValidSlug, initServer };
