# Orca Workspace for Herdr

A Windows workspace for running coding agents across Git repositories and worktrees. The sidebar groups agents beneath each checkout. The right inspector shows filenames by Git status, with commit history and a branch push action.

## Install

Start Herdr once to initialize its built-in mods and icons. This layout was tested with Herdr 0.1.16 on Windows and Git for Windows installed in its default location.

Download and extract the repository, or clone it. From PowerShell in its folder, run

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
herdr-app do layout.switch --name orca
```

The installer copies the layout and eight mods into the current user's Herdr app folder. It also supports `HERDR_APP_HOME` or an explicit `-AppHome`. It checks existing files before copying and stops on a conflicting customization. To return to the default layout, run `herdr-app do layout.switch --name main`.

## Using the workspace

- Use the folder button beside **Projects** to add a repository by clone URL. Expand a checkout to see its agents. The agent menu includes sleep, wake, close, and delete.
- In **Changes**, expand **Conflicts**, **Staged**, **Unstaged**, or **Committed** to see filenames. The **Commits** tab shows recent history. Select a commit there to inspect its patch. **Push branch** publishes the branch's existing commits.
- Click a port badge to see listeners owned by a local Herdr terminal or one of its child processes. **Open in browser** appears after a listener responds over HTTP or HTTPS.
- The bottom usage strip opens quota and credit details. Codex and Antigravity usage depend on the corresponding signed-in CLI on the local machine. Each installation reads its own account data.

## Checks

With Herdr running, Git for Windows installed and Node.js 22.12 or later available, run the workspace regression suite from the checkout. It creates temporary Git repositories, listeners, and a disposable Herdr terminal.

```powershell
node --test tests/orca-workspace.test.mjs
```

The layout uses Herdr's native GPUI components and bundled chrome. The project hierarchy draws on Orca, and the Git inspector draws on [Estro](https://github.com/munza/herdr-mods/tree/main/estro).
