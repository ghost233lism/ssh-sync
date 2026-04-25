# SSH Sync

VS Code extension that binds one local folder to one remote SSH folder and synchronizes changes with `ssh` and `scp`.

## Commands

- `SSH Sync: Bind Folder`
- `SSH Sync: Sync Now`
- `SSH Sync: Open Remote Terminal`
- `SSH Sync: Unbind Folder`

## Folder settings

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

`interval` can be `"realtime"` or a number in milliseconds. Ignore rules are gitignore-like for common file, folder, and extension patterns.
