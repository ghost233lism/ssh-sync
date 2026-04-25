import * as vscode from 'vscode';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

type AuthType = 'password' | 'privateKey';
type FileKind = 'file' | 'directory';
type SyncStatus = 'synced' | 'syncing' | 'failed';

interface ConnectionConfig {
  host: string;
  port: number;
  username: string;
  authType: AuthType;
  privateKeyPath?: string;
  usesSshConfig?: boolean;
}

interface BindingConfig {
  localPath: string;
  remotePath: string;
  connection: ConnectionConfig;
}

interface SyncSettings {
  interval: 'realtime' | number;
  ignore: string[];
}

interface FileEntry {
  relativePath: string;
  kind: FileKind;
  mtimeMs: number;
  size: number;
}

interface SyncRecord {
  local?: FileEntry;
  remote?: FileEntry;
}

type SyncState = Record<string, SyncRecord>;

interface SshHostConfig {
  alias: string;
  hostName?: string;
  user?: string;
  port?: number;
  identityFile?: string;
}

const bindingKey = 'sshSync.binding';
const stateKey = 'sshSync.state';
const passwordKey = 'sshSync.password';
const passphraseKey = 'sshSync.privateKeyPassphrase';
const settingsFileName = 'sync-setting.json';

let manager: SyncManager | undefined;

export function activate(context: vscode.ExtensionContext): void {
  manager = new SyncManager(context);
  context.subscriptions.push(manager);

  context.subscriptions.push(
    vscode.commands.registerCommand('sshSync.bindFolder', () => manager?.bindFolder()),
    vscode.commands.registerCommand('sshSync.syncNow', () => manager?.syncNow()),
    vscode.commands.registerCommand('sshSync.openRemoteTerminal', () => manager?.openRemoteTerminal()),
    vscode.commands.registerCommand('sshSync.unbindFolder', () => manager?.unbindFolder()),
    vscode.window.registerTerminalProfileProvider('sshSync.remoteTerminal', {
      provideTerminalProfile: () => manager?.provideRemoteTerminalProfile()
    })
  );

  void manager.restore();
}

export function deactivate(): void {
  manager?.dispose();
}

class SyncManager implements vscode.Disposable {
  private binding?: BindingConfig;
  private watcher?: vscode.FileSystemWatcher;
  private pollTimer?: NodeJS.Timeout;
  private localPollTimer?: NodeJS.Timeout;
  private syncQueue: Promise<void> = Promise.resolve();
  private disposed = false;
  private suppressLocalEvents = false;
  private readonly output = vscode.window.createOutputChannel('SSH Sync');
  private readonly statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  private syncStatus: SyncStatus = 'synced';
  private fullySynced = true;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.statusBarItem.command = 'sshSync.syncNow';
    this.updateStatus('synced', true);
    this.statusBarItem.show();
  }

  async restore(): Promise<void> {
    this.binding = this.context.workspaceState.get<BindingConfig>(bindingKey);
    if (this.binding) {
      await this.start();
      void this.enqueueSync('restore');
    }
  }

  async bindFolder(): Promise<void> {
    const localPath = await this.pickLocalFolder();
    if (!localPath) {
      return;
    }

    const connection = await this.collectConnection();
    if (!connection) {
      return;
    }

    const remotePath = await vscode.window.showInputBox({
      title: 'SSH Sync: Remote Folder',
      prompt: 'Enter the absolute remote folder path to bind',
      placeHolder: '/home/user/project',
      ignoreFocusOut: true,
      validateInput: value => value.trim() ? undefined : 'Remote folder is required.'
    });
    if (!remotePath) {
      return;
    }

    await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: 'SSH Sync: Binding folder',
      cancellable: false
    }, async progress => {
      const binding: BindingConfig = {
        localPath,
        remotePath: normalizeRemotePath(remotePath),
        connection
      };

      progress.report({ message: 'Checking folders...' });
      await ensureLocalDirectory(localPath);
      await sshExec(binding, `mkdir -p ${shQuote(binding.remotePath)}`, this.context);

      const [localEmpty, remoteEmpty] = await Promise.all([
        isLocalDirectoryEmpty(localPath),
        isRemoteDirectoryEmpty(binding, this.context)
      ]);

      if (!localEmpty && !remoteEmpty) {
        throw new Error('Both folders contain files. Clear at least one side before binding.');
      }

      if (!localEmpty && remoteEmpty) {
        progress.report({ message: 'Uploading initial files...' });
        await scpUpload(binding, '.', this.context);
      } else if (localEmpty && !remoteEmpty) {
        progress.report({ message: 'Downloading initial files...' });
        await scpDownload(binding, '.', this.context);
      }

      this.binding = binding;
      await this.context.workspaceState.update(bindingKey, binding);
      const state = await this.buildCurrentState(binding);
      await this.saveState(state);
      this.updateStatus(isStateFullySynced(state) ? 'synced' : 'failed', isStateFullySynced(state));
      await this.start();
    });

    vscode.window.showInformationMessage('SSH Sync binding created.');
  }

  async syncNow(): Promise<void> {
    if (!this.binding) {
      vscode.window.showWarningMessage('SSH Sync has no bound folder.');
      return;
    }
    await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: 'SSH Sync: Synchronizing',
      cancellable: false
    }, () => this.enqueueSync('manual'));
  }

  async openRemoteTerminal(): Promise<void> {
    if (!await this.confirmTerminalWhenOutOfSync()) {
      return;
    }
    this.createRemoteTerminal()?.show();
  }

  async provideRemoteTerminalProfile(): Promise<vscode.TerminalProfile | undefined> {
    if (!await this.confirmTerminalWhenOutOfSync()) {
      return undefined;
    }
    const options = this.createRemoteTerminalOptions();
    return options ? new vscode.TerminalProfile(options) : undefined;
  }

  private async confirmTerminalWhenOutOfSync(): Promise<boolean> {
    if (!this.binding) {
      vscode.window.showWarningMessage('SSH Sync has no bound folder.');
      return false;
    }

    if (this.syncStatus === 'syncing' || !this.fullySynced) {
      const choice = await vscode.window.showWarningMessage(
        'SSH Sync: Local and remote folders are not fully synchronized. Opening a remote terminal now may operate on stale files.',
        { modal: true },
        'Open Anyway',
        'Sync Now'
      );
      if (choice === 'Sync Now') {
        await this.syncNow();
        return this.fullySynced;
      }
      return choice === 'Open Anyway';
    }

    return true;
  }

  private createRemoteTerminal(): vscode.Terminal | undefined {
    const options = this.createRemoteTerminalOptions();
    return options ? vscode.window.createTerminal(options) : undefined;
  }

  private createRemoteTerminalOptions(): vscode.TerminalOptions | undefined {
    if (!this.binding) {
      return undefined;
    }
    const { connection, remotePath } = this.binding;
    const args: string[] = [];
    if (!connection.usesSshConfig) {
      args.push('-p', String(connection.port));
    }
    if (connection.authType === 'privateKey' && connection.privateKeyPath) {
      args.push('-i', connection.privateKeyPath);
    }
    args.push('-t');
    args.push(`${connection.username}@${connection.host}`);
    args.push(`cd ${shQuote(remotePath)} && if command -v bash >/dev/null 2>&1; then exec bash -li; else exec sh -l; fi`);
    return {
      name: 'SSH Sync Remote',
      shellPath: 'ssh',
      shellArgs: args,
      iconPath: new vscode.ThemeIcon('remote')
    };
  }

  async unbindFolder(): Promise<void> {
    this.stop();
    this.binding = undefined;
    await this.context.workspaceState.update(bindingKey, undefined);
    await this.context.workspaceState.update(stateKey, undefined);
    vscode.window.showInformationMessage('SSH Sync binding removed.');
  }

  dispose(): void {
    this.disposed = true;
    this.stop();
    this.output.dispose();
    this.statusBarItem.dispose();
  }

  private async start(): Promise<void> {
    if (!this.binding || this.disposed) {
      return;
    }
    this.stop();
    await this.startWatcher();
    await this.schedulePolling();
    this.log(`Started sync for ${this.binding.localPath} <-> ${this.binding.remotePath}`);
  }

  private stop(): void {
    this.watcher?.dispose();
    this.watcher = undefined;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = undefined;
    }
    if (this.localPollTimer) {
      clearTimeout(this.localPollTimer);
      this.localPollTimer = undefined;
    }
  }

  private async startWatcher(): Promise<void> {
    if (!this.binding) {
      return;
    }

    const pattern = new vscode.RelativePattern(this.binding.localPath, '**/*');
    this.watcher = vscode.workspace.createFileSystemWatcher(pattern, false, false, false);

    const trigger = () => {
      if (!this.suppressLocalEvents) {
        this.log('Local file event detected.');
        void this.enqueueSync('local');
      }
    };

    this.watcher.onDidCreate(trigger);
    this.watcher.onDidChange(trigger);
    this.watcher.onDidDelete(trigger);
  }

  private async schedulePolling(): Promise<void> {
    if (!this.binding || this.disposed) {
      return;
    }
    const settings = await readSyncSettings(this.binding.localPath);
    const configured = settings.interval === 'realtime'
      ? vscode.workspace.getConfiguration('sshSync').get<number>('defaultPollInterval', 3000)
      : settings.interval;
    const interval = Math.max(1000, configured);

    this.pollTimer = setTimeout(() => {
      this.log('Remote poll tick.');
      void this.enqueueSync('remote').finally(() => this.schedulePolling());
    }, interval);

    if (settings.interval !== 'realtime') {
      this.localPollTimer = setTimeout(() => {
        this.log('Local poll tick.');
        void this.enqueueSync('local-poll');
      }, interval);
    }
  }

  private enqueueSync(reason: string): Promise<void> {
    this.syncQueue = this.syncQueue
      .catch(() => undefined)
      .then(() => this.performSync(reason))
      .catch(error => {
        this.fullySynced = false;
        this.updateStatus('failed', false);
        vscode.window.showErrorMessage(`SSH Sync failed: ${getErrorMessage(error)}`);
      });
    return this.syncQueue;
  }

  private async performSync(_reason: string): Promise<void> {
    if (!this.binding) {
      return;
    }

    const binding = this.binding;
    this.fullySynced = false;
    this.updateStatus('syncing', false);
    this.log(`Sync started: ${_reason}`);
    const previous = this.context.workspaceState.get<SyncState>(stateKey, {});
    const [localEntries, remoteEntries] = await Promise.all([
      scanLocal(binding.localPath),
      scanRemote(binding, this.context)
    ]);
    const settings = await readSyncSettings(binding.localPath);
    const ignored = createIgnoreMatcher(settings.ignore);
    const local = mapEntries(localEntries.filter(entry => !ignored(entry.relativePath, entry.kind)));
    const remote = mapEntries(remoteEntries.filter(entry => !ignored(entry.relativePath, entry.kind)));
    const paths = new Set([...Object.keys(previous), ...local.keys(), ...remote.keys()]);

    this.suppressLocalEvents = true;
    try {
      for (const relativePath of [...paths].sort()) {
        const localEntry = local.get(relativePath);
        const remoteEntry = remote.get(relativePath);
        const record = previous[relativePath];
        const oldLocal = record?.local;
        const oldRemote = record?.remote;

        if (localEntry?.kind === 'directory' || remoteEntry?.kind === 'directory') {
          await this.syncDirectory(relativePath, localEntry, remoteEntry);
          continue;
        }

        const localChanged = changed(localEntry, oldLocal);
        const remoteChanged = changed(remoteEntry, oldRemote);

        if (localEntry && !remoteEntry) {
          if (oldRemote && !localChanged) {
            this.log(`Deleting local: ${relativePath}`);
            await deleteLocal(binding.localPath, relativePath);
          } else {
            this.log(`Uploading new local file: ${relativePath}`);
            await scpUpload(binding, relativePath, this.context);
          }
          continue;
        }

        if (!localEntry && remoteEntry) {
          if (oldLocal && !remoteChanged) {
            this.log(`Deleting remote: ${relativePath}`);
            await deleteRemote(binding, relativePath, this.context);
          } else {
            this.log(`Downloading new remote file: ${relativePath}`);
            await scpDownload(binding, relativePath, this.context);
          }
          continue;
        }

        if (localEntry && remoteEntry && (localChanged || remoteChanged)) {
          if (localChanged && remoteChanged) {
            if (localEntry.mtimeMs >= remoteEntry.mtimeMs) {
              this.log(`Conflict resolved by upload: ${relativePath}`);
              await scpUpload(binding, relativePath, this.context);
            } else {
              this.log(`Conflict resolved by download: ${relativePath}`);
              await scpDownload(binding, relativePath, this.context);
            }
          } else if (localChanged) {
            this.log(`Uploading changed local file: ${relativePath}`);
            await scpUpload(binding, relativePath, this.context);
          } else if (remoteChanged) {
            this.log(`Downloading changed remote file: ${relativePath}`);
            await scpDownload(binding, relativePath, this.context);
          }
        }
      }
    } finally {
      this.suppressLocalEvents = false;
    }

    const updated = await this.buildCurrentState(binding);
    await this.saveState(updated);
    this.fullySynced = isStateFullySynced(updated);
    this.updateStatus(this.fullySynced ? 'synced' : 'failed', this.fullySynced);
    this.log('Sync finished.');
  }

  private async syncDirectory(relativePath: string, localEntry?: FileEntry, remoteEntry?: FileEntry): Promise<void> {
    if (!this.binding) {
      return;
    }
    if (localEntry && !remoteEntry) {
      await sshExec(this.binding, `mkdir -p ${shQuote(remoteJoin(this.binding.remotePath, relativePath))}`, this.context);
    } else if (!localEntry && remoteEntry) {
      await fs.mkdir(path.join(this.binding.localPath, relativePath), { recursive: true });
    }
  }

  private async buildCurrentState(binding: BindingConfig): Promise<SyncState> {
    const settings = await readSyncSettings(binding.localPath);
    const ignored = createIgnoreMatcher(settings.ignore);
    const [localEntries, remoteEntries] = await Promise.all([
      scanLocal(binding.localPath),
      scanRemote(binding, this.context)
    ]);
    const state: SyncState = {};
    for (const entry of localEntries) {
      if (!ignored(entry.relativePath, entry.kind)) {
        state[entry.relativePath] = { ...state[entry.relativePath], local: entry };
      }
    }
    for (const entry of remoteEntries) {
      if (!ignored(entry.relativePath, entry.kind)) {
        state[entry.relativePath] = { ...state[entry.relativePath], remote: entry };
      }
    }
    return state;
  }

  private saveState(state: SyncState): Thenable<void> {
    return this.context.workspaceState.update(stateKey, state);
  }

  private updateStatus(status: SyncStatus, fullySynced: boolean): void {
    this.syncStatus = status;
    this.fullySynced = fullySynced;
    if (status === 'syncing') {
      this.statusBarItem.text = '$(sync~spin) SSH Sync: 同步中';
      this.statusBarItem.tooltip = 'SSH Sync: synchronization is running.';
      return;
    }
    if (status === 'failed') {
      this.statusBarItem.text = '$(error) SSH Sync: 同步失败';
      this.statusBarItem.tooltip = 'SSH Sync: synchronization failed or local and remote differ. Click to retry.';
      return;
    }
    this.statusBarItem.text = '$(check) SSH Sync: 已同步';
    this.statusBarItem.tooltip = 'SSH Sync: local and remote folders are synchronized. Click to sync now.';
  }

  private log(message: string): void {
    this.output.appendLine(`[${new Date().toISOString()}] ${message}`);
  }

  private async pickLocalFolder(): Promise<string | undefined> {
    const selected = await vscode.window.showOpenDialog({
      title: 'SSH Sync: Local Folder',
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: 'Bind'
    });
    return selected?.[0]?.fsPath;
  }

  private async collectConnection(): Promise<ConnectionConfig | undefined> {
    const configuredHosts = await readSshConfigHosts();
    if (configuredHosts.length > 0) {
      const selected = await vscode.window.showQuickPick([
        ...configuredHosts.map(host => ({
          label: host.alias,
          description: host.hostName,
          detail: [
            host.user ? `User ${host.user}` : undefined,
            host.port ? `Port ${host.port}` : undefined,
            host.identityFile ? `IdentityFile ${host.identityFile}` : undefined
          ].filter(Boolean).join('  '),
          host
        })),
        {
          label: '$(plus) Add New Host',
          description: 'Enter host/IP manually',
          host: undefined
        }
      ], {
        title: 'SSH Sync: SSH Host',
        placeHolder: 'Choose a host from ~/.ssh/config, or add a new host',
        ignoreFocusOut: true
      });
      if (!selected) {
        return undefined;
      }
      if (selected.host) {
        return this.connectionFromSshHost(selected.host);
      }
    }

    const host = await vscode.window.showInputBox({
      title: 'SSH Sync: Host',
      prompt: 'Enter the remote IP address or hostname',
      ignoreFocusOut: true,
      validateInput: value => value.trim() ? undefined : 'Host is required.'
    });
    if (!host) {
      return undefined;
    }

    const username = await vscode.window.showInputBox({
      title: 'SSH Sync: Username',
      prompt: 'Enter the SSH username',
      ignoreFocusOut: true,
      validateInput: value => value.trim() ? undefined : 'Username is required.'
    });
    if (!username) {
      return undefined;
    }

    const portValue = await vscode.window.showInputBox({
      title: 'SSH Sync: Port',
      prompt: 'Enter the SSH port',
      value: '22',
      ignoreFocusOut: true,
      validateInput: value => /^\d+$/.test(value) && Number(value) > 0 ? undefined : 'Port must be a positive number.'
    });
    if (!portValue) {
      return undefined;
    }

    const auth = await vscode.window.showQuickPick([
      { label: 'Password', value: 'password' as AuthType },
      { label: 'Private Key', value: 'privateKey' as AuthType }
    ], {
      title: 'SSH Sync: Authentication',
      placeHolder: 'Choose an SSH login method',
      ignoreFocusOut: true
    });
    if (!auth) {
      return undefined;
    }

    const connection: ConnectionConfig = {
      host: host.trim(),
      username: username.trim(),
      port: Number(portValue),
      authType: auth.value
    };

    if (connection.authType === 'password') {
      const password = await vscode.window.showInputBox({
        title: 'SSH Sync: Password',
        prompt: 'Enter the SSH password',
        password: true,
        ignoreFocusOut: true
      });
      if (password === undefined) {
        return undefined;
      }
      await this.context.secrets.store(passwordKey, password);
    } else {
      const key = await vscode.window.showOpenDialog({
        title: 'SSH Sync: Private Key',
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        openLabel: 'Use Key'
      });
      if (!key?.[0]) {
        return undefined;
      }
      connection.privateKeyPath = key[0].fsPath;

      const passphrase = await vscode.window.showInputBox({
        title: 'SSH Sync: Private Key Passphrase',
        prompt: 'Enter passphrase if the key is encrypted; leave empty otherwise',
        password: true,
        ignoreFocusOut: true
      });
      if (passphrase) {
        await this.context.secrets.store(passphraseKey, passphrase);
      } else {
        await this.context.secrets.delete(passphraseKey);
      }
    }

    return connection;
  }

  private async connectionFromSshHost(host: SshHostConfig): Promise<ConnectionConfig | undefined> {
    const username = host.user ?? await vscode.window.showInputBox({
      title: 'SSH Sync: Username',
      prompt: `Enter the SSH username for ${host.alias}`,
      ignoreFocusOut: true,
      validateInput: value => value.trim() ? undefined : 'Username is required.'
    });
    if (!username) {
      return undefined;
    }

    const connection: ConnectionConfig = {
      host: host.alias,
      username: username.trim(),
      port: host.port ?? 22,
      authType: host.identityFile ? 'privateKey' : 'password',
      privateKeyPath: host.identityFile,
      usesSshConfig: true
    };

    if (host.identityFile) {
      const passphrase = await vscode.window.showInputBox({
        title: 'SSH Sync: Private Key Passphrase',
        prompt: 'Enter passphrase if the configured key is encrypted; leave empty otherwise',
        password: true,
        ignoreFocusOut: true
      });
      if (passphrase) {
        await this.context.secrets.store(passphraseKey, passphrase);
      } else {
        await this.context.secrets.delete(passphraseKey);
      }
      return connection;
    }

    const auth = await vscode.window.showQuickPick([
      { label: 'Password', value: 'password' as AuthType },
      { label: 'Private Key Path', value: 'privateKey' as AuthType }
    ], {
      title: 'SSH Sync: Authentication',
      placeHolder: 'No IdentityFile was found for this host. Choose a login method',
      ignoreFocusOut: true
    });
    if (!auth) {
      return undefined;
    }

    connection.authType = auth.value;
    if (connection.authType === 'password') {
      const password = await vscode.window.showInputBox({
        title: 'SSH Sync: Password',
        prompt: 'Enter the SSH password',
        password: true,
        ignoreFocusOut: true
      });
      if (password === undefined) {
        return undefined;
      }
      await this.context.secrets.store(passwordKey, password);
      return connection;
    }

    const key = await vscode.window.showOpenDialog({
      title: 'SSH Sync: Private Key',
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      openLabel: 'Use Key'
    });
    if (!key?.[0]) {
      return undefined;
    }
    connection.privateKeyPath = key[0].fsPath;
    const passphrase = await vscode.window.showInputBox({
      title: 'SSH Sync: Private Key Passphrase',
      prompt: 'Enter passphrase if the key is encrypted; leave empty otherwise',
      password: true,
      ignoreFocusOut: true
    });
    if (passphrase) {
      await this.context.secrets.store(passphraseKey, passphrase);
    } else {
      await this.context.secrets.delete(passphraseKey);
    }
    return connection;
  }
}

async function sshExec(binding: BindingConfig, command: string, context: vscode.ExtensionContext): Promise<string> {
  const args = sshArgs(binding.connection, command);
  return runCommand('ssh', args, context, binding.connection);
}

async function scpUpload(binding: BindingConfig, relativePath: string, context: vscode.ExtensionContext): Promise<void> {
  const localSource = relativePath === '.'
    ? path.join(binding.localPath, '.')
    : path.join(binding.localPath, relativePath);
  const remoteDirectory = relativePath === '.'
    ? binding.remotePath
    : remoteJoin(binding.remotePath, path.posix.dirname(toPosix(relativePath)));
  const remoteTarget = remoteScpTarget(binding, `${remoteDirectory.replace(/\/+$/, '')}/`);
  await sshExec(binding, `mkdir -p ${shQuote(remoteDirectory)}`, context);
  await runCommand('scp', scpArgs(binding.connection, ['-p', '-r', localSource, remoteTarget]), context, binding.connection);
}

async function scpDownload(binding: BindingConfig, relativePath: string, context: vscode.ExtensionContext): Promise<void> {
  const localTarget = relativePath === '.'
    ? binding.localPath
    : path.dirname(path.join(binding.localPath, relativePath));
  await fs.mkdir(localTarget, { recursive: true });
  const remoteSourcePath = relativePath === '.'
    ? `${binding.remotePath}/.`
    : remoteJoin(binding.remotePath, relativePath);
  await runCommand('scp', scpArgs(binding.connection, ['-p', '-r', remoteScpTarget(binding, remoteSourcePath), localTarget]), context, binding.connection);
}

async function deleteRemote(binding: BindingConfig, relativePath: string, context: vscode.ExtensionContext): Promise<void> {
  await sshExec(binding, `rm -rf ${shQuote(remoteJoin(binding.remotePath, relativePath))}`, context);
}

async function deleteLocal(localRoot: string, relativePath: string): Promise<void> {
  await fs.rm(path.join(localRoot, relativePath), { recursive: true, force: true });
}

function sshArgs(connection: ConnectionConfig, command: string): string[] {
  const args = ['-o', 'BatchMode=no', '-o', 'StrictHostKeyChecking=accept-new'];
  if (!connection.usesSshConfig) {
    args.unshift('-p', String(connection.port));
  }
  if (connection.authType === 'privateKey' && connection.privateKeyPath) {
    args.push('-i', connection.privateKeyPath);
  }
  args.push(`${connection.username}@${connection.host}`, command);
  return args;
}

function scpArgs(connection: ConnectionConfig, extra: string[]): string[] {
  const args = ['-o', 'BatchMode=no', '-o', 'StrictHostKeyChecking=accept-new'];
  if (!connection.usesSshConfig) {
    args.unshift('-P', String(connection.port));
  }
  if (connection.authType === 'privateKey' && connection.privateKeyPath) {
    args.push('-i', connection.privateKeyPath);
  }
  return [...args, ...extra];
}

async function runCommand(command: string, args: string[], context: vscode.ExtensionContext, connection: ConnectionConfig): Promise<string> {
  const askpass = await createAskpass(context, connection);
  try {
    return await new Promise((resolve, reject) => {
      execFile(command, args, {
        timeout: 120000,
        maxBuffer: 20 * 1024 * 1024,
        env: {
          ...process.env,
          ...askpass.env
        },
        windowsHide: true
      }, (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr.trim() || error.message));
        } else {
          resolve(stdout);
        }
      });
    });
  } finally {
    await askpass.cleanup();
  }
}

async function createAskpass(context: vscode.ExtensionContext, connection: ConnectionConfig): Promise<{ env: NodeJS.ProcessEnv; cleanup: () => Promise<void> }> {
  const secret = connection.authType === 'password'
    ? await context.secrets.get(passwordKey)
    : await context.secrets.get(passphraseKey);
  if (!secret) {
    return { env: {}, cleanup: async () => undefined };
  }

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ssh-sync-askpass-'));
  const helperPath = path.join(dir, 'askpass.js');
  await fs.writeFile(helperPath, 'process.stdout.write(process.env.SSH_SYNC_ASKPASS_SECRET || "");\n', { mode: 0o700 });

  const scriptPath = process.platform === 'win32'
    ? path.join(dir, 'askpass.cmd')
    : path.join(dir, 'askpass.sh');
  const content = process.platform === 'win32'
    ? `@echo off\r\n"${process.execPath}" "${helperPath}"\r\n`
    : `#!/bin/sh\nexec "${process.execPath}" "${helperPath}"\n`;
  await fs.writeFile(scriptPath, content, { mode: 0o700 });

  return {
    env: {
      SSH_ASKPASS: scriptPath,
      SSH_ASKPASS_REQUIRE: 'force',
      SSH_SYNC_ASKPASS_SECRET: secret,
      DISPLAY: process.env.DISPLAY || 'ssh-sync'
    },
    cleanup: async () => {
      await fs.rm(dir, { recursive: true, force: true });
    }
  };
}

async function scanLocal(root: string): Promise<FileEntry[]> {
  const result: FileEntry[] = [];

  async function walk(current: string, relative: string): Promise<void> {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      const rel = relative ? path.join(relative, entry.name) : entry.name;
      const stat = await fs.stat(fullPath);
      const normalized = toPosix(rel);
      if (entry.isDirectory()) {
        result.push({ relativePath: normalized, kind: 'directory', mtimeMs: stat.mtimeMs, size: 0 });
        await walk(fullPath, rel);
      } else if (entry.isFile()) {
        result.push({ relativePath: normalized, kind: 'file', mtimeMs: stat.mtimeMs, size: stat.size });
      }
    }
  }

  await walk(root, '');
  return result;
}

async function scanRemote(binding: BindingConfig, context: vscode.ExtensionContext): Promise<FileEntry[]> {
  const command = `cd ${shQuote(binding.remotePath)} && find . -mindepth 1 \\( -type f -o -type d \\) -printf '%y\\0%T@\\0%s\\0%P\\0'`;
  const output = await sshExec(binding, command, context);
  const parts = output.split('\0');
  const entries: FileEntry[] = [];
  for (let index = 0; index + 3 < parts.length; index += 4) {
    const type = parts[index];
    const mtime = Number(parts[index + 1]);
    const size = Number(parts[index + 2]);
    const relativePath = parts[index + 3];
    if (!relativePath) {
      continue;
    }
    entries.push({
      relativePath,
      kind: type === 'd' ? 'directory' : 'file',
      mtimeMs: mtime * 1000,
      size: type === 'd' ? 0 : size
    });
  }
  return entries;
}

async function readSyncSettings(localRoot: string): Promise<SyncSettings> {
  const defaults: SyncSettings = { interval: 'realtime', ignore: [] };
  try {
    const raw = await fs.readFile(path.join(localRoot, settingsFileName), 'utf8');
    const parsed = JSON.parse(raw) as Partial<SyncSettings>;
    return {
      interval: parsed.interval === 'realtime' || typeof parsed.interval === 'number' ? parsed.interval : defaults.interval,
      ignore: Array.isArray(parsed.ignore) ? parsed.ignore.filter(item => typeof item === 'string') : []
    };
  } catch {
    return defaults;
  }
}

async function readSshConfigHosts(): Promise<SshHostConfig[]> {
  const configPath = path.join(os.homedir(), '.ssh', 'config');
  let content: string;
  try {
    content = await fs.readFile(configPath, 'utf8');
  } catch {
    return [];
  }

  const hosts: SshHostConfig[] = [];
  let currentAliases: string[] = [];
  let current: Omit<SshHostConfig, 'alias'> = {};

  const flush = () => {
    for (const alias of currentAliases) {
      if (!alias || /[*?!]/.test(alias)) {
        continue;
      }
      hosts.push({
        alias,
        hostName: current.hostName,
        user: current.user,
        port: current.port,
        identityFile: current.identityFile ? expandSshPath(current.identityFile, current.hostName ?? alias) : undefined
      });
    }
  };

  for (const rawLine of content.split(/\r?\n/)) {
    const line = stripSshConfigComment(rawLine).trim();
    if (!line) {
      continue;
    }

    const match = /^(\S+)\s+(.*)$/.exec(line);
    if (!match) {
      continue;
    }

    const key = match[1].toLowerCase();
    const value = unquoteSshValue(match[2].trim());

    if (key === 'host') {
      flush();
      currentAliases = value.split(/\s+/);
      current = {};
      continue;
    }

    if (currentAliases.length === 0) {
      continue;
    }

    if (key === 'hostname') {
      current.hostName = value;
    } else if (key === 'user') {
      current.user = value;
    } else if (key === 'port' && /^\d+$/.test(value)) {
      current.port = Number(value);
    } else if (key === 'identityfile' && !current.identityFile && value.toLowerCase() !== 'none') {
      current.identityFile = value;
    }
  }

  flush();
  return hosts;
}

function stripSshConfigComment(line: string): string {
  let quote: string | undefined;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if ((char === '"' || char === "'") && line[index - 1] !== '\\') {
      quote = quote === char ? undefined : quote ?? char;
    } else if (char === '#' && !quote) {
      return line.slice(0, index);
    }
  }
  return line;
}

function unquoteSshValue(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function expandSshPath(value: string, host: string): string {
  const home = os.homedir();
  const username = os.userInfo().username;
  let expanded = value
    .replace(/^~(?=$|[\\/])/, home)
    .replaceAll('%d', home)
    .replaceAll('%u', username)
    .replaceAll('%r', username)
    .replaceAll('%h', host);
  if (!path.isAbsolute(expanded)) {
    expanded = path.join(home, '.ssh', expanded);
  }
  return expanded;
}

function createIgnoreMatcher(patterns: string[]): (relativePath: string, kind: FileKind) => boolean {
  const normalized = patterns.map(pattern => pattern.replaceAll('\\', '/').trim()).filter(Boolean);
  return (relativePath, kind) => normalized.some(pattern => matchesPattern(relativePath, kind, pattern));
}

function matchesPattern(relativePath: string, kind: FileKind, pattern: string): boolean {
  if (pattern.endsWith('/')) {
    const folder = pattern.slice(0, -1);
    return relativePath === folder || relativePath.startsWith(`${folder}/`);
  }
  if (pattern.startsWith('*.')) {
    return kind === 'file' && relativePath.endsWith(pattern.slice(1));
  }
  if (!pattern.includes('/')) {
    return relativePath === pattern || relativePath.endsWith(`/${pattern}`);
  }
  return relativePath === pattern || relativePath.startsWith(`${pattern}/`);
}

function mapEntries(entries: FileEntry[]): Map<string, FileEntry> {
  return new Map(entries.map(entry => [entry.relativePath, entry]));
}

function changed(current?: FileEntry, previous?: FileEntry): boolean {
  if (!current && !previous) {
    return false;
  }
  if (!current || !previous) {
    return true;
  }
  return current.kind !== previous.kind
    || current.size !== previous.size
    || Math.abs(current.mtimeMs - previous.mtimeMs) > 1;
}

function isStateFullySynced(state: SyncState): boolean {
  return Object.values(state).every(record => {
    if (!record.local || !record.remote) {
      return false;
    }
    return record.local.kind === record.remote.kind && record.local.size === record.remote.size;
  });
}

async function ensureLocalDirectory(localPath: string): Promise<void> {
  await fs.mkdir(localPath, { recursive: true });
}

async function isLocalDirectoryEmpty(localPath: string): Promise<boolean> {
  const entries = await fs.readdir(localPath);
  return entries.length === 0;
}

async function isRemoteDirectoryEmpty(binding: BindingConfig, context: vscode.ExtensionContext): Promise<boolean> {
  const output = await sshExec(binding, `find ${shQuote(binding.remotePath)} -mindepth 1 -maxdepth 1 -print -quit`, context);
  return output.trim().length === 0;
}

function remoteScpTarget(binding: BindingConfig, remotePath: string): string {
  return `${binding.connection.username}@${binding.connection.host}:${escapeScpRemotePath(remotePath)}`;
}

function escapeScpRemotePath(remotePath: string): string {
  return remotePath.replaceAll('\\', '\\\\').replaceAll(' ', '\\ ');
}

function remoteJoin(root: string, relativePath: string): string {
  const rel = toPosix(relativePath);
  if (!rel || rel === '.') {
    return root;
  }
  return `${root.replace(/\/+$/, '')}/${rel.replace(/^\/+/, '')}`;
}

function normalizeRemotePath(remotePath: string): string {
  const trimmed = remotePath.trim();
  return trimmed.length > 1 ? trimmed.replace(/\/+$/, '') : trimmed;
}

function toPosix(value: string): string {
  return value.replaceAll(path.sep, '/').replaceAll('\\', '/');
}

function shQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
