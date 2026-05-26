import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { app, BrowserWindow, ipcMain, nativeTheme, safeStorage, shell } from "electron";

let server: ChildProcessWithoutNullStreams | undefined;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isDev = !app.isPackaged;

function startLocalServer() {
  if (isDev) return;
  const serverEntry = bundledServerPath();
  server = spawn(serverEntry, [], {
    env: { ...process.env, POLYLAB_SERVER_PORT: "3917" },
    stdio: "pipe"
  });
}

function bundledServerPath() {
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const platform = process.platform === "darwin" ? "darwin" : "linux";
  return path.join(process.resourcesPath, "server-bin", `polylab-server-${platform}-${arch}`);
}

function credentialPath(name = "api-token") {
  const safeName = name.replace(/[^a-zA-Z0-9._:-]/g, "_");
  return path.join(app.getPath("userData"), "credentials", `${safeName}.bin`);
}

async function saveCredential(name: unknown, value: unknown) {
  if (typeof name !== "string" || !name.trim()) return { ok: false, reason: "missing-name" };
  if (typeof value !== "string" || !value.trim()) return { ok: false, reason: "empty-token" };
  if (!safeStorage.isEncryptionAvailable()) return { ok: false, reason: "encryption-unavailable" };
  const file = credentialPath(name.trim());
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, safeStorage.encryptString(value.trim()));
  return { ok: true };
}

async function loadCredential(name: unknown) {
  if (typeof name !== "string" || !name.trim()) return { ok: false, reason: "missing-name" };
  if (!safeStorage.isEncryptionAvailable()) return { ok: false, reason: "encryption-unavailable" };
  try {
    const encrypted = await readFile(credentialPath(name.trim()));
    return { ok: true, value: safeStorage.decryptString(encrypted) };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return { ok: false, reason: "missing" };
    return { ok: false, reason: "read-failed" };
  }
}

async function clearCredential(name: unknown) {
  if (typeof name !== "string" || !name.trim()) return { ok: false, reason: "missing-name" };
  await rm(credentialPath(name.trim()), { force: true });
  return { ok: true };
}

function registerCredentialIpc() {
  ipcMain.handle("polylab:credential-status", () => ({
    available: safeStorage.isEncryptionAvailable(),
    backend: safeStorage.getSelectedStorageBackend?.() ?? "unknown"
  }));

  ipcMain.handle("polylab:credential-save", async (_event, token: unknown) => {
    return saveCredential("api-token", token);
  });

  ipcMain.handle("polylab:credential-load", async () => {
    const result = await loadCredential("api-token");
    return result.ok ? { ok: true, token: result.value } : result;
  });

  ipcMain.handle("polylab:credential-clear", async () => {
    return clearCredential("api-token");
  });

  ipcMain.handle("polylab:credential-save-named", async (_event, name: unknown, value: unknown) => saveCredential(name, value));
  ipcMain.handle("polylab:credential-load-named", async (_event, name: unknown) => loadCredential(name));
  ipcMain.handle("polylab:credential-clear-named", async (_event, name: unknown) => clearCredential(name));
}

async function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1100,
    minHeight: 720,
    title: "PolyLab",
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#191a1d" : "#f5f5f2",
    titleBarStyle: "hiddenInset",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  if (isDev) {
    await win.loadURL(process.env.POLYLAB_DESKTOP_URL ?? "http://127.0.0.1:5173");
    win.webContents.openDevTools({ mode: "detach" });
  } else {
    await win.loadFile(path.resolve(__dirname, "../dist/index.html"));
  }
}

app.whenReady().then(() => {
  registerCredentialIpc();
  startLocalServer();
  void createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  server?.kill();
});
