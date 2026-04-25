# SSH Sync

[English](README.md) | [中文](README_ZH.md)

SSH Sync 是一个 VS Code 扩展，用于将一个本地文件夹绑定到一个远程 SSH 文件夹，并通过系统 `ssh` 和 `scp` 命令让两端保持同步。

它还提供了一个轻量级远程文件树，可以浏览、编辑和创建远程文件，同时不会把远程文件夹添加为 VS Code 工作区文件夹。

## 功能

- 将一个本地文件夹绑定到一个远程 SSH 文件夹。
- 如果存在 `~/.ssh/config`，可以直接选择其中的 Host。
- 支持 SSH 私钥或密码认证。
- 使用 `ssh` 和 `scp` 同步本地和远程变更。
- 在左下角状态栏显示同步状态：
  - syncing
  - synced
  - failed
- 在绑定的远程文件夹中打开远程终端。
- 在 Explorer 侧边栏的 `SSH Sync Remote` 视图中浏览单独的远程文件夹。
- 从远程文件树打开远程文件进行编辑，并在保存时上传回远程主机。
- 从远程文件树中新建远程文件和文件夹。
- 如果远程文件树中的编辑发生在已绑定的远程文件夹内，会将该变更镜像回绑定的本地文件夹。

## 环境要求

- VS Code 1.90.0 或更高版本。
- `ssh` 和 `scp` 必须可在 PATH 中访问。
- 远程系统需要支持常见 shell 工具，例如 `find`、`mkdir`、`rm`，以及 `bash` 或 `sh`。

## 命令

打开命令面板并运行：

- `SSH Sync: Bind Folder`
- `SSH Sync: Sync Now`
- `SSH Sync: Open Remote Folder`
- `SSH Sync: Refresh Remote Folder`
- `SSH Sync: New Remote File`
- `SSH Sync: New Remote Folder`
- `SSH Sync: Open Remote Terminal`
- `SSH Sync: Unbind Folder`

## 基本使用

1. 运行 `SSH Sync: Bind Folder`。
2. 选择本地文件夹。
3. 从 `~/.ssh/config` 中选择已有 Host，或手动新增 SSH Host。
4. 根据需要选择密码或私钥认证。
5. 输入要绑定的远程文件夹路径。
6. 使用 `SSH Sync: Sync Now` 手动同步，或让自动轮询保持同步。

如果本地文件夹和远程文件夹都已经包含文件，SSH Sync 会拒绝绑定。请先清空其中一端，以避免意外合并。

## 远程文件树

运行 `SSH Sync: Open Remote Folder`，即可在 Explorer 侧边栏中打开 `SSH Sync Remote` 视图。

远程文件树与 VS Code 工作区相互独立。它不会挂载 `ssh-sync://` 工作区文件夹。

在远程文件树中可以：

- 点击远程文件打开。
- 编辑并保存文件。保存时会上传回远程主机。
- 使用视图标题栏按钮创建远程文件或文件夹。
- 右键远程文件夹，在其中创建文件或文件夹。
- 使用刷新按钮重新加载文件树。

注意：VS Code 自定义树视图不开放原生的行内文件名编辑器，因此创建远程文件和文件夹时会使用输入框。

## 远程终端

运行 `SSH Sync: Open Remote Terminal`，或在终端下拉菜单中选择 `SSH Sync Remote Terminal` 终端配置。

如果上一次确认的同步状态并不干净，SSH Sync 会在打开远程终端前给出警告。

## 文件夹设置

在绑定的本地根目录中创建 `sync-setting.json`：

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

`interval` 可以是：

- `"realtime"`：使用扩展默认轮询间隔。
- 数字：以毫秒为单位的轮询间隔。

忽略规则支持常见的文件、文件夹和扩展名模式。

## 扩展设置

- `sshSync.defaultPollInterval`：当 `sync-setting.json` 使用 `"realtime"` 或不存在时采用的默认轮询间隔，单位为毫秒。


