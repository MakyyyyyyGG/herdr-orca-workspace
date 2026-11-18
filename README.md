# Orca Workspace for Herdr

An agent-first workspace layout and mod suite for [Herdr](https://herdr.dev). Orca groups your coding agents beneath their Git repository and worktree checkouts, pairs a fast file browser and Git changes/diff/push inspector on the right, and surfaces Codex and Antigravity quota and credit details in a compact bottom strip.

Tested with Herdr `0.1.16` on Windows (and portable to macOS/Linux).

## Features

- **Projects sidebar (`orca-projects`)**: Groups spaces, branches, linked worktrees, and parent/sub-agent trees under each repository checkout. Highlights agents that are working, done, sleeping, or blocked (`Needs you`), persists folded projects, and detects local listening TCP ports on Windows with validated HTTP/HTTPS **"Open in browser ↗"** links.
- **Tab bar (`orca-tabs`)**: Agent-aware tab titles, drag-to-reorder, wheel-to-switch, zoomed pane badges, native window controls, and per-space inspector memory.
- **Inspector header (`orca-inspector`)**: Displays the active repo/folder, checkout & worktree switcher (including `+ New worktree…`), GitHub repository / PRs / Issues quick links, active listening ports, working/blocked agent counts, and animated **Files** / **Changes** switcher.
- **File tree (`orca-files`)**: Lazy directory browser with filename search, Git status badges (`A`, `M`, `D`, `U`), drag-and-drop paths directly into terminals/agents, collapse-all & refresh controls, and syntax-highlighted read-only file previews.
- **Changes & Push (`orca-changes`)**: Clean filename-only groups for **Uncommitted**, **Staged**, and **Committed** (outgoing commits awaiting push). Click any file to inspect its read-only diff or untracked content inline, switch target remotes, and push local commits safely with **Push branch**.
- **Add project (`orca-add-project`)**: Clone from HTTPS/SSH URLs (or pasted `git clone ...` commands) into your chosen folder, or open any existing local folder.
- **Agent actions (`orca-agent-actions`)**: Sleep (interrupt & keep open), wake, close (with closed-agent history), and delete terminals safely with state-change guards.
- **Usage strip (`orca-usage`)**: Compact quota bars with low-quota (`<= 15%`) alerts, reset countdowns, and a detailed **Usage & credits** dialog for Codex and Antigravity CLIs (degrades gracefully if either CLI isn't installed).

## Install & Upgrade

Start Herdr once to initialize its built-in mods and icons, then clone or extract this repository and run the installer from PowerShell:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -Switch
```

To **upgrade** an existing Orca installation (add `-Backup` to keep timestamped copies of overwritten files):

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -Force -Switch
```

To **uninstall** Orca or return to the default layout:

```powershell
herdr-app do layout.switch --name main
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -Uninstall
```

On macOS/Linux, run `sh ./install.sh --force --switch`. Both installers also respect `HERDR_APP_HOME` (or `-AppHome` / `--app-home`).

## Using the workspace

- **Add a project**: Click the folder-plus button beside **Projects** (or in the empty state) to clone a repository URL or open a local folder.
- **Worktrees & spaces**: Right-click a project or checkout row for the space menu, or click the branch name in the inspector header to switch checkouts, jump to an agent, or create a **New worktree…**.
- **Files**: Click folders to expand, type to filter across the repo, click any file to preview it, or drag a file row into a terminal pane to paste its path.
- **Changes**: Expand/collapse **Uncommitted**, **Staged**, and **Committed**. Click any file to inspect its diff, click the remote name (when multiple remotes exist) to cycle targets, and click **Push branch** to publish existing local commits.
- **New space** starts a local space. **Add project** opens a folder or clones a repository. Both actions stay at the top of the left sidebar if the project list fails to load. Use **Retry** to refresh the list after the core reconnects.
- **Ports**: Click a `:port` badge in the sidebar or inspector header to inspect owned listening sockets and open responding HTTP/HTTPS servers in your browser.
- **Agent lifecycle**: Right-click an agent row or click `⋯` to sleep, wake, close, or delete it. Closed agents remain accessible from the archive button beside **Projects**.
- **Usage**: Click any provider or **Credits** in the bottom strip to view per-window reset timers and manage Antigravity credit fallback.

## Verification

With Herdr running, Git installed, and Node.js 22.12 or later available, run the regression suite from the repository root:

```powershell
node --test tests/orca-workspace.test.mjs tests/sidebar.test.mjs
```

The layout uses Herdr's native GPUI components and bundled `workspace-chrome` icons. The project hierarchy draws on Orca, and the Git inspector draws on [Estro](https://github.com/munza/herdr-mods/tree/main/estro).
