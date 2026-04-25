# SSH Sync

[English](https://github.com/ghost233lism/ssh-sync/blob/main/README.md) | [中文](https://github.com/ghost233lism/ssh-sync/blob/main/README_ZH.md)

SSH Sync is a VS Code extension for binding a local folder to a remote SSH folder and keeping both sides synchronized with the system `ssh` and `scp` commands.

It also provides a lightweight remote file tree for browsing, editing, and creating remote files without adding the remote folder as a VS Code workspace folder.

## Features

- Bind one local folder to one remote SSH folder.
- Use hosts from `~/.ssh/config` when available.
- Authenticate with an SSH private key or password.
- Synchronize local and remote changes with `ssh` and `scp`.
- Show sync status in the lower-left status bar:
  - syncing
  - synced
  - failed
- Open a remote terminal in the bound remote folder.
- Browse a separate remote folder in the `SSH Sync Remote` Explorer view.
- Edit remote files from the remote tree and save them back to the remote host.
- Create remote files and folders from the remote tree.
- If a remote tree edit is inside the bound remote folder, mirror that change back to the bound local folder.

## Requirements

- VS Code 1.90.0 or later.
- `ssh` and `scp` must be available in your PATH.
- The remote system must support common shell tools such as `find`, `mkdir`, `rm`, and `bash` or `sh`.

## Commands

Open the Command Palette and run:

- `SSH Sync: Bind Folder`
- `SSH Sync: Sync Now`
- `SSH Sync: Open Remote Folder`
- `SSH Sync: Refresh Remote Folder`
- `SSH Sync: New Remote File`
- `SSH Sync: New Remote Folder`
- `SSH Sync: Open Remote Terminal`
- `SSH Sync: Unbind Folder`

## Basic Usage

1. Run `SSH Sync: Bind Folder`.
2. Choose the local folder.
3. Select an existing host from `~/.ssh/config`, or add a new SSH host manually.
4. Choose password or private-key authentication when needed.
5. Enter the remote folder path to bind.
6. Use `SSH Sync: Sync Now` or let automatic polling keep changes synchronized.

If both the local folder and remote folder already contain files, SSH Sync will refuse to bind them. Clear one side first to avoid accidental merges.

## Remote File Tree

Run `SSH Sync: Open Remote Folder` to open the `SSH Sync Remote` view in the Explorer sidebar.

The remote tree is separate from the VS Code workspace. It does not mount a `ssh-sync://` workspace folder.

From the remote tree you can:

- Click a remote file to open it.
- Edit and save the file. Saving uploads it back to the remote host.
- Use the title-bar buttons to create a remote file or folder.
- Right-click a remote folder to create a file or folder under it.
- Use the refresh button to reload the tree.

Note: VS Code custom tree views do not expose the native inline file-name editor, so creating remote files and folders uses an input box.

## Remote Terminal

Run `SSH Sync: Open Remote Terminal`, or select the `SSH Sync Remote Terminal` terminal profile from the terminal dropdown.

If the last confirmed sync state is not clean, SSH Sync warns before opening the remote terminal.

## Folder Settings

Create `sync-setting.json` in the bound local root:

```json
{
  "interval": "realtime",
  "ignore": [
    "node_modules/",
    "dist/",
    "*.log",
    ".env"
  ]
}
```

`interval` can be:

- `"realtime"`: use the extension default polling interval.
- A number: polling interval in milliseconds.

Ignore rules support common file, folder, and extension patterns.

## Extension Setting

- `sshSync.defaultPollInterval`: default polling interval in milliseconds when `sync-setting.json` uses `"realtime"` or is missing.
