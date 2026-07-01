# VibeDeck

A lean terminal, organized in two dimensions.

- **Scopes** (top bar) — one per project/folder. Switching scopes swaps which sessions you see.
- **Sessions** (left bar) — persistent terminal tabs within the active scope. Run whatever you like in them: a shell, a coding agent, a dev server.

Sessions are backed by `tmux`, so they **survive quitting and reopening the app** — reopen and your long-running processes are still there. VibeDeck is just a clean UI on top; it doesn't restrict what any session can do.

> A session's scope is an organizational label (its default working directory). It does **not** sandbox the session — any session can still touch any file on your machine.

## Requirements

- macOS (developed/tested there; Linux likely works with minor tweaks)
- [Node.js](https://nodejs.org) 18+
- [`tmux`](https://github.com/tmux/tmux) on your `PATH` — `brew install tmux`

## Install & run

```bash
npm install     # installs deps, rebuilds node-pty for Electron, vendors xterm assets
npm start
```

Add a scope with the `+` in the top bar (pick a folder), then add sessions with **+ New session** in the side bar.

## How it works

```
Electron renderer (UI)  ──IPC──►  main process  ──►  node-pty  ──►  tmux -L vibedeck new-session -A -t <slug>
   scopes × sessions                pty manager                         tmux server (persists) ──► your shell
```

- Each session is a `tmux` session on a **dedicated socket** (`-L vibedeck`), isolated from any tmux you run by hand.
- The app owns the scope→session model in `state.json` (in Electron's userData dir). tmux only knows opaque slugs.
- Closing the app kills the tmux *clients*, not the server — so sessions keep running and reattach on the next launch.

## Keyboard

- `⌘T` — new session in the active scope
- `⌘1`–`⌘9` — jump to a session in the active scope
- Double-click a scope or session name to rename it

## Roadmap

- Split panes within a session
- Live running/idle indicator from `tmux` activity
- Drag to reorder scopes and sessions
- Configurable theme and font

## License

MIT — see [LICENSE](LICENSE).
