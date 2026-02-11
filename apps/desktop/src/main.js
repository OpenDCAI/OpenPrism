const { app, BrowserWindow, dialog, shell } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const path = require('path');

let backendProc = null;
let backendUrl = process.env.OPENPRISM_ELECTRON_BACKEND_URL || '';

function resolveWorkspaceRoot() {
  return path.resolve(__dirname, '..', '..', '..');
}

function resolveRuntimeRoot() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'openprism-runtime');
  }
  return resolveWorkspaceRoot();
}

function resolveBackendEntry() {
  return path.join(resolveRuntimeRoot(), 'apps', 'backend', 'src', 'index.js');
}

function resolvePreloadEntry() {
  return path.join(__dirname, 'preload.js');
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Failed to resolve a free port')));
        return;
      }
      const port = address.port;
      server.close((err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(port);
      });
    });
  });
}

async function waitForHealth(url, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { method: 'GET' });
      if (res.ok) return;
    } catch {
      // retry
    }
    await delay(300);
  }
  throw new Error(`Backend health check timed out: ${url}`);
}

function stopBackendProcess() {
  if (!backendProc || backendProc.killed) return;
  backendProc.kill('SIGTERM');
  setTimeout(() => {
    if (backendProc && !backendProc.killed) {
      backendProc.kill('SIGKILL');
    }
  }, 2000);
}

async function startBackendProcessIfNeeded() {
  const useExternalBackend = process.env.OPENPRISM_ELECTRON_EXTERNAL_BACKEND === '1';
  if (useExternalBackend) {
    const external = process.env.OPENPRISM_ELECTRON_BACKEND_URL || 'http://127.0.0.1:8787';
    backendUrl = external;
    await waitForHealth(`${external.replace(/\/$/, '')}/api/health`);
    return;
  }

  const backendEntry = resolveBackendEntry();
  if (!fs.existsSync(backendEntry)) {
    throw new Error(`Backend entry not found: ${backendEntry}`);
  }

  const port = process.env.PORT ? Number(process.env.PORT) : await findFreePort();
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error(`Invalid backend port: ${port}`);
  }

  const dataDir = process.env.OPENPRISM_DATA_DIR || path.join(app.getPath('userData'), 'data');
  fs.mkdirSync(dataDir, { recursive: true });

  const env = {
    ...process.env,
    PORT: String(port),
    OPENPRISM_DESKTOP: '1',
    OPENPRISM_TUNNEL: 'false',
    OPENPRISM_DATA_DIR: dataDir,
    OPENPRISM_REPO_ROOT: resolveRuntimeRoot(),
    ELECTRON_RUN_AS_NODE: '1'
  };

  backendProc = spawn(process.execPath, [backendEntry], {
    cwd: resolveRuntimeRoot(),
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  backendProc.stdout.on('data', (chunk) => {
    process.stdout.write(`[backend] ${chunk}`);
  });

  backendProc.stderr.on('data', (chunk) => {
    process.stderr.write(`[backend] ${chunk}`);
  });

  backendProc.on('exit', (code, signal) => {
    if (!app.isQuitting) {
      console.error(`[backend] exited unexpectedly (code=${code}, signal=${signal})`);
    }
  });

  backendUrl = `http://127.0.0.1:${port}`;
  await waitForHealth(`${backendUrl}/api/health`);
}

function wireNavigationGuards(win) {
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  win.webContents.on('will-navigate', (event, url) => {
    if (!backendUrl) return;
    const allowedDevUrl = process.env.OPENPRISM_ELECTRON_DEV_URL || '';
    const isAllowed = url.startsWith(backendUrl) || (allowedDevUrl && url.startsWith(allowedDevUrl));
    if (!isAllowed) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });
}

async function createMainWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1100,
    minHeight: 720,
    show: false,
    webPreferences: {
      preload: resolvePreloadEntry(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  wireNavigationGuards(win);

  const devUrl = process.env.OPENPRISM_ELECTRON_DEV_URL;
  if (devUrl) {
    await win.loadURL(devUrl);
  } else {
    await win.loadURL(backendUrl);
  }

  win.once('ready-to-show', () => win.show());
}

app.on('before-quit', () => {
  app.isQuitting = true;
  stopBackendProcess();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', async () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    await createMainWindow();
  }
});

app.whenReady().then(async () => {
  try {
    await startBackendProcessIfNeeded();
    await createMainWindow();
  } catch (error) {
    dialog.showErrorBox('OpenPrism startup failed', String(error));
    app.quit();
  }
});
