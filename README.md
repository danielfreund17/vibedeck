# VibeDeck

A lean terminal, organized in two dimensions.

- **Scopes** (top bar) — one per project/folder. Switching scopes swaps which sessions you see.
- **Sessions** (left bar) — terminal tabs within the active scope. Run whatever you like in them: a shell, a coding agent, a dev server.

Each session is your login shell running on its own pty, wired straight to the terminal — the same way a native terminal (Warp/iTerm/VS Code) works — so rendering is clean and fast, and modern TUIs (Claude Code, pi, …) behave exactly as they would anywhere else.

> A session's scope is an organizational label (its default working directory). It does **not** sandbox the session — any session can still touch any file on your machine.

## Persistence

VibeDeck remembers your **layout** — scopes, session names, and working directories — and restores it on the next launch, reopening a fresh shell in each session's directory. The shells themselves do **not** survive quitting the app: a process running in a session dies on ⌘Q. If you need something to keep running across a restart, start `tmux` (or `screen`) inside a session yourself.

## Requirements

- macOS (developed/tested there; Linux likely works with minor tweaks)
- [Node.js](https://nodejs.org) 18+

## Install & run

```bash
npm install     # installs deps, rebuilds node-pty for Electron, vendors xterm assets
npm start
```

Open a repo as a scope with `⌘P` (or the `+` in the top bar): register a **parent folder** like `~/git-repos` once, then fuzzy-search the git repos under it and press Enter to open one as a tab. You can also open any folder manually. Then add sessions with **+ New session** in the side bar.

## Build a macOS app

One command — build, install to `/Applications`, and launch:

```bash
npm run install-app
```

Or step by step:

```bash
npm run icon                  # (re)generate build/icon.icns from build/icon.svg — optional
npm run dist                  # -> dist/VibeDeck-<version>-arm64.dmg  (unsigned)
bash scripts/install-app.sh   # copy the built app into /Applications + launch
```

Prefer to install by hand? Open the `.dmg` and drag **VibeDeck** to Applications. The build is **unsigned**; a *downloaded* copy may be blocked on first launch — right-click the app → **Open** once, or run `xattr -dr com.apple.quarantine /Applications/VibeDeck.app`. (A locally built copy isn't quarantined.)

## How it works

```
Electron renderer (UI)  ──IPC──►  main process  ──►  node-pty  ──►  your login shell
   scopes × sessions                pty manager                       (zsh -l, in the scope's dir)
```

- Each session is a login shell on a dedicated pty; the terminal (xterm.js) talks straight to it — no multiplexer in between.
- The app owns the scope→session model in `state.json` (in Electron's userData dir). That layout persists; the shells don't.
- VibeDeck speaks the [kitty keyboard protocol](https://sw.kovidgoyal.net/kitty/keyboard-protocol/) so modified keys (like Shift+Enter) reach apps unambiguously, and ⌘V pastes a clipboard **image** as a temp-file path so agents can attach it.

## Keyboard

- `⌘P` — open the repo palette (search repos under your parent folders, open as a tab)
- `⌘T` — new session in the active scope (or `Ctrl`+`Shift`+backtick, VS Code style)
- `⌘1`–`⌘9` — jump to a session in the active scope
- `⌘⇧[` / `⌘⇧]` — previous / next scope (the top bar)
- `⌘⇧'` / `⌘⇧\` — previous / next session (the side bar)
- `⌘C` / `⌘V` — copy the selection / paste · `⌘A` — select all
- `⇧⏎` (Shift+Enter) — insert a newline instead of submitting (works in Claude Code, pi, and any app that speaks the keyboard protocol)
- **Paste an image** — copy an image (screenshot, browser "Copy Image", …) and `⌘V`: VibeDeck saves it to a temp PNG and types the path, so Claude Code / pi attach it (like a drag-and-drop)
- Double-click a scope or session name to rename it

## Roadmap

- Opt-in persistent sessions (reattach a background shell across restarts)
- Split panes within a session
- Drag to reorder scopes and sessions
- Configurable theme and font

## License

MIT — see [LICENSE](LICENSE).
