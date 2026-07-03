'use strict';

// Session backend: each session is the user's login shell running under its own
// pty, wired straight to xterm.js — no multiplexer in between. This is how a
// native terminal (Warp/iTerm/VS Code) works, so rendering is clean and fast.
//
// Trade-off vs a tmux-backed design: sessions do NOT persist across an app
// restart — the shell dies with its pty. VibeDeck persists the scope/session
// *layout* (names, working dirs) in state.json and reopens a fresh shell on
// demand; run `tmux`/`screen` inside a session yourself if you need a running
// process to survive a quit.

const os = require('os');
const fs = require('fs');
const pty = require('node-pty');

// Slugs are app-generated identifiers (tg_<hex>); validate defensively before
// letting one influence a spawn.
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

// Pick the shell to launch: honor $SHELL, else fall back to zsh (macOS default),
// then bash/sh. A GUI app launched from Finder may not inherit $SHELL.
function resolveShell() {
  const candidates = [process.env.SHELL, '/bin/zsh', '/bin/bash', '/bin/sh'];
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return '/bin/sh';
}

function shellEnv() {
  const env = { ...process.env };
  // A GUI-launched app doesn't inherit the shell PATH; guarantee the common
  // bin dirs so tools (git, brew-installed binaries, agents) resolve.
  const extra = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'];
  env.PATH = [...new Set([...extra, ...(env.PATH ? env.PATH.split(':') : [])])].join(':');
  // Let programs (e.g. Claude Code) own the terminal title so VibeDeck can
  // auto-name sessions; suppress oh-my-zsh's idle title churn for our shells.
  env.DISABLE_AUTO_TITLE = 'true';
  // Don't leak a launcher's Claude Code session context into our shells — it
  // would make a nested `claude` treat itself as a child session and fail.
  for (const key of Object.keys(env)) {
    if (key === 'CLAUDECODE' || key.startsWith('CLAUDE_CODE_')) delete env[key];
  }
  // GUI-launched apps don't inherit the shell's locale, leaving a C/POSIX locale
  // where TUIs render box-drawing/glyphs as ASCII garbage. Ensure UTF-8, like
  // Terminal.app does.
  if (![env.LC_ALL, env.LC_CTYPE, env.LANG].some((v) => /utf-?8/i.test(v || ''))) {
    env.LANG = 'en_US.UTF-8';
  }
  return env;
}

// Spawn a login shell in `cwd`. Returns the pty, whether this created the
// session (always true — nothing is reattached), and the resolved start dir so
// the caller can settle the shell into the repo dir (see main.js).
function spawnSession({ slug, cwd, cols, rows }) {
  if (!isValidSlug(slug)) throw new Error(`invalid session slug: ${slug}`);
  const startDir = cwd && dirExists(cwd) ? cwd : os.homedir();
  const proc = pty.spawn(resolveShell(), ['-l'], {
    name: 'xterm-256color',
    cols: cols || 80,
    rows: rows || 24,
    cwd: startDir,
    env: shellEnv(),
  });
  return { proc, isNew: true, startDir };
}

// Nothing survives a restart, so no sessions are ever live at launch time.
// (Kept for the renderer's reconciliation step, which marks live-dot state.)
function listSessions() {
  return Promise.resolve([]);
}

module.exports = { spawnSession, listSessions };
