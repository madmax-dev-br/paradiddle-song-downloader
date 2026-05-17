const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("paradiddle", {
  getSettings: () => ipcRenderer.invoke("settings:get"),
  updateSettings: (patch) => ipcRenderer.invoke("settings:update", patch),
  chooseFolder: (mode) => ipcRenderer.invoke("folder:choose", mode),
  search: (params) => ipcRenderer.invoke("paradb:search", params),
  getMap: (id) => ipcRenderer.invoke("paradb:getMap", id),
  install: (request) => ipcRenderer.invoke("paradb:install", request),
  questStatus: () => ipcRenderer.invoke("quest:status"),
  scanLibrary: (mode) => ipcRenderer.invoke("library:scan", mode),
  openPath: (targetPath) => ipcRenderer.invoke("shell:openPath", targetPath),
  onInstallProgress: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("install:progress", listener);
    return () => ipcRenderer.removeListener("install:progress", listener);
  }
});
