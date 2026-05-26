import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("polylabDesktop", {
  platform: process.platform,
  versions: process.versions,
  credentials: {
    status: () => ipcRenderer.invoke("polylab:credential-status"),
    saveApiToken: (token: string) => ipcRenderer.invoke("polylab:credential-save", token),
    loadApiToken: () => ipcRenderer.invoke("polylab:credential-load"),
    clearApiToken: () => ipcRenderer.invoke("polylab:credential-clear"),
    saveCredential: (name: string, value: string) => ipcRenderer.invoke("polylab:credential-save-named", name, value),
    loadCredential: (name: string) => ipcRenderer.invoke("polylab:credential-load-named", name),
    clearCredential: (name: string) => ipcRenderer.invoke("polylab:credential-clear-named", name)
  },
  codex: {
    status: () => ipcRenderer.invoke("polylab:codex-status"),
    login: () => ipcRenderer.invoke("polylab:codex-login")
  }
});
