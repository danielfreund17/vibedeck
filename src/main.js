'use strict';

const { app, BrowserWindow, ipcMain, dialog, Menu, clipboard, shell: electronShell } = require('electron');
const { execFile } = require('child_process');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const fs = require('fs');
const state = require('./state');
const shell = require('./shell');

// Keep dev (`npm start`) and the packaged .app pointed at the same state/config.
app.setPath('userData', path.join(app.getPath('appData'), 'vibedeck'));

let mainWindow = null;

// ptyId -> { proc, slug }. ptyId identifies a live shell for this app run; slug
// is the app's durable session id (its layout persists in state; the shell
// doesn't survive a restart).
const ptys = new Map();
let sessionUpdateWatcher = null;

function userDataDir() {
  return app.getPath('userData');
}

function sessionUpdatesDir() {
  return path.join(userDataDir(), 'session-updates');
}

// Scan registered parent folders one level deep for git repositories.
function scanRepos(parentFolders) {
  const out = [];
  const seen = new Set();
  for (const parent of Array.isArray(parentFolders) ? parentFolders : []) {
    let entries;
    try {
      entries = fs.readdirSync(parent, { withFileTypes: true });
    } catch {
      continue; // unreadable / removed folder
    }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const full = path.join(parent, ent.name);
      try {
        fs.accessSync(path.join(full, '.git'));
      } catch {
        continue; // not a git repo
      }
      if (seen.has(full)) continue;
      seen.add(full);
      out.push({ name: ent.name, path: full, parent });
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

function execText(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { timeout: options.timeout || 5000, maxBuffer: 1024 * 1024, cwd: options.cwd },
      (error, stdout, stderr) => {
        if (error) {
          error.stderr = stderr;
          reject(error);
          return;
        }
        resolve(String(stdout || '').trim());
      }
    );
  });
}

async function tryExecText(command, args, options) {
  try {
    return await execText(command, args, options);
  } catch {
    return null;
  }
}

async function git(cwd, args) {
  return execText('git', ['-C', cwd, ...args], { timeout: 5000 });
}

async function tryGit(cwd, args) {
  try {
    return await git(cwd, args);
  } catch {
    return null;
  }
}

function parseRemoteUrl(raw) {
  const remote = String(raw || '').trim();
  if (!remote) return null;

  let match = remote.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/);
  if (match) return { owner: match[1], repo: match[2], url: `https://github.com/${match[1]}/${match[2]}` };

  match = remote.match(/^https:\/\/github\.com\/([^/]+)\/(.+?)(?:\.git)?$/);
  if (match) return { owner: match[1], repo: match[2], url: `https://github.com/${match[1]}/${match[2]}` };

  match = remote.match(/^ssh:\/\/git@github\.com\/([^/]+)\/(.+?)(?:\.git)?$/);
  if (match) return { owner: match[1], repo: match[2], url: `https://github.com/${match[1]}/${match[2]}` };

  return null;
}

function parseBranchStatus(statusText) {
  const lines = String(statusText || '').split('\n').filter(Boolean);
  const header = lines.find((line) => line.startsWith('##')) || '';
  const dirty = lines.some((line) => !line.startsWith('##'));
  const ahead = Number(header.match(/ahead (\d+)/)?.[1] || 0);
  const behind = Number(header.match(/behind (\d+)/)?.[1] || 0);
  return { dirty, ahead, behind };
}

function parseWorktrees(porcelain) {
  const worktrees = [];
  let current = null;
  for (const line of String(porcelain || '').split('\n')) {
    if (!line.trim()) {
      if (current) worktrees.push(current);
      current = null;
      continue;
    }
    if (line.startsWith('worktree ')) current = { path: line.slice('worktree '.length), branch: null, head: null };
    else if (current && line.startsWith('HEAD ')) current.head = line.slice('HEAD '.length);
    else if (current && line.startsWith('branch refs/heads/')) current.branch = line.slice('branch refs/heads/'.length);
  }
  if (current) worktrees.push(current);
  return worktrees;
}

function tokens(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/^[πp]i\s*-\s*/i, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length > 2 && !['session', 'dirty', 'fix', 'feat', 'feature', 'chat', 'cxllm'].includes(token));
}

function scoreWorktree(sessionName, candidateText) {
  const queryTokens = tokens(sessionName);
  if (!queryTokens.length) return 0;
  const haystack = String(candidateText || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ');
  let score = 0;
  for (const token of queryTokens) {
    if (haystack.includes(token)) score += token.length >= 6 ? 3 : 2;
  }
  const phrase = queryTokens.join(' ');
  if (phrase && haystack.includes(phrase)) score += 5;
  return score;
}

const prCache = new Map();
const PR_CACHE_TTL_MS = 60 * 1000;

async function resolvePrContext(remote, branch, headSha) {
  if (!remote || !branch) return { lookupState: 'none' };

  const cacheKey = `${remote.owner}/${remote.repo}:${branch}:${headSha || ''}`;
  const cached = prCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < PR_CACHE_TTL_MS) return cached.value;

  let value;
  try {
    const output = await execText(
      'gh',
      [
        'pr',
        'list',
        '--repo',
        `${remote.owner}/${remote.repo}`,
        '--head',
        branch,
        '--state',
        'all',
        '--json',
        'number,state,isDraft,title,url,headRefName,baseRefName,mergedAt,closedAt,updatedAt',
        '--limit',
        '20',
      ],
      { timeout: 8000 }
    );
    const prs = JSON.parse(output || '[]');
    const exact = prs.filter((pr) => pr.headRefName === branch);
    const pr = (exact.length ? exact : prs).sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))[0];
    value = pr
      ? {
          lookupState: 'found',
          number: pr.number,
          state: pr.state,
          isDraft: Boolean(pr.isDraft),
          title: pr.title || '',
          url: pr.url || '',
          updatedAt: pr.updatedAt || null,
        }
      : { lookupState: 'none' };
  } catch (error) {
    value = { lookupState: 'error', message: error.code === 'ENOENT' ? 'GitHub CLI not found' : 'PR lookup failed' };
  }

  prCache.set(cacheKey, { fetchedAt: Date.now(), value });
  return value;
}

async function resolveGitContextForCwd(cwd, cwdSource = 'observed') {
  const requestedCwd = String(cwd || os.homedir());
  const resolvedCwd = fs.existsSync(requestedCwd) ? requestedCwd : os.homedir();

  const worktreeRoot = await tryGit(resolvedCwd, ['rev-parse', '--show-toplevel']);
  if (!worktreeRoot) {
    return { cwd: resolvedCwd, cwdSource, git: { isRepo: false }, pr: { lookupState: 'none' } };
  }

  const [commonGitDir, branchRaw, headSha, shortSha, statusText, remoteRaw] = await Promise.all([
    tryGit(worktreeRoot, ['rev-parse', '--git-common-dir']),
    tryGit(worktreeRoot, ['branch', '--show-current']),
    tryGit(worktreeRoot, ['rev-parse', 'HEAD']),
    tryGit(worktreeRoot, ['rev-parse', '--short=8', 'HEAD']),
    tryGit(worktreeRoot, ['status', '--porcelain=v1', '--branch']),
    tryGit(worktreeRoot, ['remote', 'get-url', 'origin']),
  ]);

  const branch = branchRaw || null;
  const remote = parseRemoteUrl(remoteRaw);
  const branchStatus = parseBranchStatus(statusText);
  const pr = await resolvePrContext(remote, branch, headSha);

  return {
    cwd: resolvedCwd,
    cwdSource,
    git: {
      isRepo: true,
      worktreeRoot,
      commonGitDir: commonGitDir || null,
      repoName: path.basename(worktreeRoot),
      branch,
      headSha: headSha || null,
      shortSha: shortSha || null,
      remote,
      ...branchStatus,
    },
    pr,
  };
}

async function inferWorktreeContext(repoCwd, sessionName) {
  const porcelain = await tryGit(repoCwd, ['worktree', 'list', '--porcelain']);
  const worktrees = parseWorktrees(porcelain).filter((wt) => wt.path && wt.path !== repoCwd);
  if (!worktrees.length) return null;

  const remoteRaw = await tryGit(repoCwd, ['remote', 'get-url', 'origin']);
  const remote = parseRemoteUrl(remoteRaw);
  const candidates = await Promise.all(
    worktrees.map(async (wt) => {
      const pr = await resolvePrContext(remote, wt.branch, wt.head);
      const text = [wt.branch, wt.path, pr.lookupState === 'found' ? pr.title : ''].filter(Boolean).join(' ');
      return { wt, pr, score: scoreWorktree(sessionName, text) };
    })
  );

  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];
  const next = candidates[1];
  if (!best || best.score < 2 || (next && best.score === next.score)) return null;

  const ctx = await resolveGitContextForCwd(best.wt.path, 'inferred');
  return { ...ctx, pr: best.pr.lookupState === 'found' ? best.pr : ctx.pr };
}

async function resolveSessionContext(input) {
  const options = typeof input === 'object' && input !== null ? input : { cwd: input };
  const cwd = options.cwd || os.homedir();
  const repoCwd = options.repoCwd || cwd;
  const cwdSource = options.cwdSource || 'observed';

  if (cwdSource === 'default' && repoCwd && cwd === repoCwd) {
    const inferred = await inferWorktreeContext(repoCwd, options.sessionName || '');
    if (inferred) return inferred;

    const worktrees = parseWorktrees(await tryGit(repoCwd, ['worktree', 'list', '--porcelain']));
    if (worktrees.length > 1) {
      return {
        cwd: repoCwd,
        cwdSource: 'default',
        git: { isRepo: false, unknownWorktree: true, worktreeCount: worktrees.length - 1 },
        pr: { lookupState: 'none' },
      };
    }
  }

  return resolveGitContextForCwd(cwd, cwdSource);
}

async function listWorktreeContexts(repoCwd) {
  const root = await tryGit(repoCwd, ['rev-parse', '--show-toplevel']);
  if (!root) return [];
  const worktrees = parseWorktrees(await tryGit(root, ['worktree', 'list', '--porcelain']));
  const contexts = await Promise.all(
    worktrees.map(async (worktree) => {
      const ctx = await resolveGitContextForCwd(worktree.path, 'manual');
      return { ...ctx, isMainWorktree: worktree.path === root };
    })
  );
  contexts.sort((a, b) => Number(b.isMainWorktree) - Number(a.isMainWorktree) || String(a.cwd).localeCompare(String(b.cwd)));
  return contexts;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 720,
    minHeight: 480,
    backgroundColor: '#0e0f13',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // App keyboard shortcuts, handled before the page so Chromium/xterm can't
  // claim them (⌘P, ⌘T, ⌘1-9, ⌘⌥ arrows, ⌘⇧[ ]). Dispatched to the renderer
  // via the same "menu-action" channel the menu items use.
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    let action = null;
    if (
      input.shift &&
      !input.meta &&
      !input.control &&
      !input.alt &&
      (input.key === 'Enter' || input.code === 'Enter' || input.code === 'NumpadEnter')
    ) {
      action = 'newline'; // Shift+Enter — insert a newline instead of submitting
    } else if (input.control && input.shift && input.code === 'Backquote') {
      action = 'new-session'; // Ctrl+Shift+` — new session (VS Code style)
    } else if (input.meta && input.shift) {
      // brackets = horizontal (scopes); ' \ = vertical (sessions)
      if ((input.key || '').toLowerCase() === 'p') action = 'command-palette';
      else if (input.code === 'BracketLeft') action = 'prev-scope';
      else if (input.code === 'BracketRight') action = 'next-scope';
      else if (input.code === 'Quote') action = 'prev-session';
      else if (input.code === 'Backslash') action = 'next-session';
    } else if (input.meta) {
      const k = (input.key || '').toLowerCase();
      if (k === 'p') action = 'palette';
      else if (k === 't') action = 'new-session';
      else if (k === 'w') action = 'close-session';
      else if (/^[1-9]$/.test(input.key)) action = `session:${input.key}`;
    }
    if (action) {
      event.preventDefault();
      sendMenu(action);
    }
  });
}

function sendMenu(action) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('menu-action', action);
  }
}

function shellIntegrationScript() {
  // Emit OSC 7 (current directory) on each prompt so the renderer can track the
  // session's real cwd/worktree without modifying user dotfiles.
  return [
    '__vibedeck_emit_cwd() {',
    '  printf \'\\033]7;file://%s%s\\007\' "$(hostname 2>/dev/null || printf localhost)" "$PWD"',
    '}',
    'if [ -n "${ZSH_VERSION-}" ]; then',
    '  autoload -Uz add-zsh-hook 2>/dev/null || true',
    '  if command -v add-zsh-hook >/dev/null 2>&1; then',
    '    add-zsh-hook precmd __vibedeck_emit_cwd 2>/dev/null || true',
    '  else',
    '    case " ${precmd_functions[*]-} " in',
    '      *" __vibedeck_emit_cwd "*) ;;',
    '      *) precmd_functions+=(__vibedeck_emit_cwd) ;;',
    '    esac',
    '  fi',
    'elif [ -n "${BASH_VERSION-}" ]; then',
    '  case ";${PROMPT_COMMAND-};" in',
    '    *";__vibedeck_emit_cwd;"*) ;;',
    '    *) PROMPT_COMMAND="__vibedeck_emit_cwd${PROMPT_COMMAND:+;$PROMPT_COMMAND}" ;;',
    '  esac',
    'fi',
    '__vibedeck_emit_cwd',
  ].join('\n');
}

// After a session's shell settles at its first prompt (output goes quiet), cd it
// into the repo. `builtin cd` bypasses shell `cd` wrappers (e.g. RVM's), and
// waiting for quiet avoids racing shell startup.
function scheduleInitialCd(proc, dir) {
  const quoted = `'${String(dir).replace(/'/g, `'\\''`)}'`;
  let timer = null;
  let done = false;
  const sub = proc.onData(() => {
    if (done) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      done = true;
      try {
        proc.write(`${shellIntegrationScript()}\rbuiltin cd -- ${quoted} && clear\r`);
      } catch {
        /* pty gone */
      }
      try {
        sub.dispose();
      } catch {
        /* noop */
      }
    }, 700);
  });
}

// A native menu owns the app shortcuts. Menu accelerators are handled before
// the web contents, so keys Chromium would otherwise claim (⌘P, ⌘T, ⌘1-9,
// ⌘⌥ arrows) reliably reach the app even when the terminal is focused.
function buildMenu() {
  const item = (label, accelerator, action) => ({
    label,
    accelerator,
    registerAccelerator: false, // show the shortcut, but let before-input-event own it
    click: () => sendMenu(action),
  });
  const jump = [];
  for (let i = 1; i <= 9; i++) jump.push(item(`Session ${i}`, `Cmd+${i}`, `session:${i}`));

  const template = [
    { role: 'appMenu' },
    {
      label: 'Edit',
      submenu: [
        { label: 'Copy', accelerator: 'CmdOrCtrl+C', click: () => sendMenu('copy') },
        { label: 'Paste', accelerator: 'CmdOrCtrl+V', click: () => sendMenu('paste') },
        { type: 'separator' },
        { label: 'Select All', accelerator: 'CmdOrCtrl+A', click: () => sendMenu('select-all') },
      ],
    },
    {
      label: 'Go',
      submenu: [
        item('Open Repo Palette', 'Cmd+P', 'palette'),
        item('Command Palette', 'Cmd+Shift+P', 'command-palette'),
        item('New Session', 'Cmd+T', 'new-session'),
        item('Close Active Session', 'Cmd+W', 'close-session'),
        { type: 'separator' },
        item('Previous Scope', 'Cmd+Shift+[', 'prev-scope'),
        item('Next Scope', 'Cmd+Shift+]', 'next-scope'),
        item('Previous Session', "Cmd+Shift+'", 'prev-session'),
        item('Next Session', 'Cmd+Shift+\\', 'next-session'),
        { type: 'separator' },
        { label: 'Jump to Session', submenu: jump },
      ],
    },
    { role: 'viewMenu' },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        { role: 'front' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(() => {
  createWindow();
  buildMenu();
  startSessionUpdateWatcher();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Kill every session's shell on quit — nothing persists past the app.
app.on('before-quit', () => {
  try {
    sessionUpdateWatcher?.close();
  } catch {
    /* noop */
  }
  for (const { proc } of ptys.values()) {
    try {
      proc.kill();
    } catch {
      /* already gone */
    }
  }
});

function readSessionUpdate(fileName) {
  if (!fileName || !fileName.endsWith('.json')) return;
  const file = path.join(sessionUpdatesDir(), fileName);
  setTimeout(() => {
    let update;
    try {
      update = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return;
    }
    if (!update || typeof update.slug !== 'string' || !update.cwd) return;
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('session:externalContextUpdate', update);
    try {
      fs.unlinkSync(file);
    } catch {
      /* best effort cleanup */
    }
  }, 50);
}

function startSessionUpdateWatcher() {
  const dir = sessionUpdatesDir();
  fs.mkdirSync(dir, { recursive: true });
  try {
    sessionUpdateWatcher = fs.watch(dir, (_event, fileName) => readSessionUpdate(fileName));
  } catch {
    sessionUpdateWatcher = null;
  }
  try {
    for (const fileName of fs.readdirSync(dir)) readSessionUpdate(fileName);
  } catch {
    /* noop */
  }
}

// ---- app info ----
ipcMain.handle('app:info', () => ({ hostname: os.hostname(), homedir: os.homedir() }));

// ---- clipboard (xterm manages its own selection, so we copy/paste explicitly) ----
ipcMain.handle('clipboard:write', (_e, text) => {
  clipboard.writeText(String(text ?? ''));
  return true;
});
ipcMain.handle('clipboard:read', () => clipboard.readText());

// Open terminal links in the user's default browser. Only allow web URLs; terminal
// output is untrusted and must not be able to launch arbitrary app protocols.
ipcMain.handle('shell:openExternalUrl', async (_e, rawUrl) => {
  let url;
  try {
    url = new URL(String(rawUrl ?? ''));
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  await electronShell.openExternal(url.toString());
  return true;
});

// If the clipboard holds an image, stash it as a temp PNG and return the path so
// the renderer can type it into the terminal — Claude Code / pi read an image
// path from the prompt, the same way a drag-and-drop works. Returns null when
// there's no image (the renderer then falls back to a normal text paste).
ipcMain.handle('clipboard:readImage', () => {
  const img = clipboard.readImage();
  if (img.isEmpty()) return null;
  try {
    const dir = path.join(os.tmpdir(), 'vibedeck-paste');
    fs.mkdirSync(dir, { recursive: true });
    // Best-effort prune of pastes older than a day so the dir doesn't grow.
    try {
      const cutoff = Date.now() - 24 * 60 * 60 * 1000;
      for (const name of fs.readdirSync(dir)) {
        const p = path.join(dir, name);
        if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p);
      }
    } catch {
      /* pruning is best-effort */
    }
    const file = path.join(dir, `img-${crypto.randomUUID()}.png`);
    fs.writeFileSync(file, img.toPNG());
    return file;
  } catch {
    return null; // fall back to text paste
  }
});

// ---- state ----
ipcMain.handle('state:load', () => state.loadState(userDataDir()));
ipcMain.handle('state:save', (_e, s) => {
  state.saveState(userDataDir(), s);
  return true;
});

// ---- folder picker ----
ipcMain.handle('dialog:pickFolder', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose a project folder',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (res.canceled || !res.filePaths.length) return null;
  const p = res.filePaths[0];
  return { path: p, name: path.basename(p) };
});

// ---- live-session reconciliation on launch (always empty: nothing persists) ----
ipcMain.handle('sessions:live', () => shell.listSessions());

// ---- repo discovery under registered parent folders ----
ipcMain.handle('repos:scan', (_e, parentFolders) => scanRepos(parentFolders));

// ---- session intelligence ----
ipcMain.handle('session:resolveContext', (_e, cwd) => resolveSessionContext(cwd));
ipcMain.handle('session:listWorktrees', (_e, repoCwd) => listWorktreeContexts(repoCwd));

// ---- sessions ----
ipcMain.handle('session:start', (_e, { slug, cwd, cols, rows }) => {
  const { proc, isNew, startDir } = shell.spawnSession({ slug, cwd, cols, rows, updatesDir: sessionUpdatesDir() });
  const ptyId = crypto.randomUUID();
  ptys.set(ptyId, { proc, slug });

  proc.onData((data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('session:data', { ptyId, data });
    }
  });
  proc.onExit(() => {
    ptys.delete(ptyId);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('session:exit', { ptyId });
    }
  });

  // Some shells cd on startup (RVM/oh-my-zsh here), overriding the pty's cwd.
  // Once the shell settles at its first prompt, cd into the repo.
  if (isNew) scheduleInitialCd(proc, startDir);

  return { ptyId };
});

ipcMain.on('session:write', (_e, { ptyId, data }) => {
  const entry = ptys.get(ptyId);
  if (entry) {
    try {
      entry.proc.write(data);
    } catch {
      /* pty gone */
    }
  }
});

ipcMain.on('session:resize', (_e, { ptyId, cols, rows }) => {
  const entry = ptys.get(ptyId);
  if (entry && cols > 0 && rows > 0) {
    try {
      entry.proc.resize(cols, rows);
    } catch {
      /* pty gone */
    }
  }
});

// Destroy a session: kill its shell.
ipcMain.handle('session:kill', (_e, { ptyId }) => {
  if (ptyId && ptys.has(ptyId)) {
    try {
      ptys.get(ptyId).proc.kill();
    } catch {
      /* already gone */
    }
    ptys.delete(ptyId);
  }
  return true;
});
