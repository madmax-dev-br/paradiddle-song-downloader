const { app, BrowserWindow, dialog, ipcMain, shell } = require("electron");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { Readable } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const extract = require("extract-zip");

const PARADB_ORIGIN = "https://paradb.net";
const QUEST_REMOTE_SONGS = "/sdcard/Paradiddle/Songs";
const SEARCH_LIMIT = 24;
const MAP_ID_PATTERN = /^M[A-Z0-9]{6}$/i;

let mainWindow;
let settingsCache;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 900,
    minHeight: 620,
    title: "Paradiddle Song Downloader",
    backgroundColor: "#101217",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.loadFile(path.join(__dirname, "index.html"));
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://paradb.net/")) shell.openExternal(url);
    return { action: "deny" };
  });
}

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

function settingsPath() {
  return path.join(app.getPath("userData"), "settings.json");
}

function defaultSettings() {
  return {
    installMode: "local",
    localSongsDir: path.join(os.homedir(), "Documents", "Paradiddle", "Songs"),
    questSongsDir: "",
    lastQuery: "",
    checkInstalled: true
  };
}

async function readSettings() {
  if (settingsCache) return settingsCache;
  try {
    const raw = await fsp.readFile(settingsPath(), "utf8");
    settingsCache = { ...defaultSettings(), ...JSON.parse(raw) };
  } catch {
    settingsCache = defaultSettings();
  }
  return settingsCache;
}

async function writeSettings(nextSettings) {
  settingsCache = { ...defaultSettings(), ...nextSettings };
  await fsp.mkdir(path.dirname(settingsPath()), { recursive: true });
  await fsp.writeFile(settingsPath(), JSON.stringify(settingsCache, null, 2));
  return settingsCache;
}

function sendProgress(mapId, message, detail = {}) {
  mainWindow?.webContents.send("install:progress", { mapId, message, ...detail });
}

function sanitizeFolderName(input, fallback = "Paradiddle Map") {
  const cleaned = String(input || fallback)
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  return cleaned || fallback;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function normalizeLibraryKey(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function stripDifficultySuffix(value) {
  return String(value || "")
    .replace(/[_\-\s]+(easy|normal|medium|hard|expert|expert\+|expert plus)$/i, "")
    .trim();
}

function buildLibraryEntry(folderName, extraNames = [], folderPath = "") {
  const keys = new Set([folderName, ...extraNames].map(normalizeLibraryKey).filter(Boolean));
  return {
    folderName,
    folderPath,
    keys: Array.from(keys)
  };
}

function normalizeMapId(value) {
  const id = String(value || "").trim().toUpperCase();
  if (!MAP_ID_PATTERN.test(id)) {
    throw new Error("Paste a ParaDB map link or id like M3EA11F.");
  }
  return id;
}

function ensureChildPath(parent, child) {
  const relative = path.relative(parent, child);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Unsafe archive path: ${child}`);
  }
}

async function cleanDir(dir) {
  await fsp.rm(dir, { recursive: true, force: true });
  await fsp.mkdir(dir, { recursive: true });
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      "Accept": "application/json",
      "User-Agent": "ParadiddleDownloader/0.1 (+local Electron app)"
    }
  });

  if (!response.ok) {
    throw new Error(`ParaDB request failed: ${response.status} ${response.statusText}`);
  }

  return response.json();
}

async function downloadMapZip(map, destinationZip) {
  const response = await fetch(`${PARADB_ORIGIN}/api/maps/${encodeURIComponent(map.id)}/download`, {
    redirect: "follow",
    headers: {
      "User-Agent": "ParadiddleDownloader/0.1 (+local Electron app)"
    }
  });

  if (!response.ok || !response.body) {
    throw new Error(`Download failed: ${response.status} ${response.statusText}`);
  }

  await fsp.mkdir(path.dirname(destinationZip), { recursive: true });
  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(destinationZip));
}

async function findSingleTopLevelDirectory(dir) {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const visibleEntries = entries.filter((entry) => !entry.name.startsWith("__MACOSX") && entry.name !== ".DS_Store");
  if (visibleEntries.length !== 1 || !visibleEntries[0].isDirectory()) return null;
  return path.join(dir, visibleEntries[0].name);
}

async function copyDirectoryContents(source, destination) {
  await fsp.mkdir(destination, { recursive: true });
  const entries = await fsp.readdir(source, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.name === "__MACOSX" || entry.name === ".DS_Store") continue;
    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);
    ensureChildPath(destination, destinationPath);

    if (entry.isDirectory()) {
      await copyDirectoryContents(sourcePath, destinationPath);
    } else if (entry.isFile()) {
      await fsp.copyFile(sourcePath, destinationPath);
    }
  }
}

async function extractZipToMapFolder(zipPath, mapFolderName, stagingRoot) {
  const extractDir = path.join(stagingRoot, "extracted");
  await cleanDir(extractDir);
  await extract(zipPath, { dir: extractDir });

  const singleFolder = await findSingleTopLevelDirectory(extractDir);
  const contentRoot = singleFolder || extractDir;
  const mapFolder = path.join(stagingRoot, "map", mapFolderName);
  await cleanDir(mapFolder);
  await copyDirectoryContents(contentRoot, mapFolder);
  return mapFolder;
}

async function installToLocalFolder(mapFolder, destinationSongsDir, mapFolderName) {
  if (!destinationSongsDir) {
    throw new Error("Choose a Paradiddle Songs folder first.");
  }

  const resolvedSongsDir = path.resolve(destinationSongsDir);
  await fsp.mkdir(resolvedSongsDir, { recursive: true });
  const destination = path.join(resolvedSongsDir, mapFolderName);
  ensureChildPath(resolvedSongsDir, destination);
  await cleanDir(destination);
  await copyDirectoryContents(mapFolder, destination);
  return destination;
}

function execFile(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    childProcess.execFile(command, args, { timeout: 30000, ...options }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }

      resolve({ stdout, stderr });
    });
  });
}

async function findAdb() {
  const command = process.platform === "win32" ? "where" : "which";
  const { stdout } = await execFile(command, ["adb"]);
  return stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
}

async function getQuestDevices() {
  const adbPath = await findAdb();
  const { stdout } = await execFile(adbPath, ["devices"]);
  return stdout
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim().split(/\s+/))
    .filter(([serial, state]) => serial && state === "device")
    .map(([serial]) => serial);
}

async function installToQuestWithAdb(mapFolder, mapFolderName) {
  const adbPath = await findAdb();
  const devices = await getQuestDevices();
  if (devices.length === 0) {
    throw new Error("No authorized Quest found through adb.");
  }

  const serialArgs = ["-s", devices[0]];
  const remoteFolder = `${QUEST_REMOTE_SONGS}/${mapFolderName}`;
  await execFile(adbPath, [...serialArgs, "shell", "mkdir", "-p", QUEST_REMOTE_SONGS], { timeout: 30000 });
  await execFile(adbPath, [...serialArgs, "shell", "rm", "-rf", shellQuote(remoteFolder)], { timeout: 30000 });
  await execFile(adbPath, [...serialArgs, "push", mapFolder, QUEST_REMOTE_SONGS], { timeout: 120000 });
  return remoteFolder;
}

async function scanLocalSongsFolder(songsDir) {
  if (!songsDir) throw new Error("Choose a Paradiddle Songs folder first.");

  const resolvedSongsDir = path.resolve(songsDir);
  let entries;
  try {
    entries = await fsp.readdir(resolvedSongsDir, { withFileTypes: true });
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return {
      mode: "folder",
      songsDir: resolvedSongsDir,
      scannedAt: new Date().toISOString(),
      entries: []
    };
  }

  const library = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;

    const folderPath = path.join(resolvedSongsDir, entry.name);
    const extraNames = [];

    try {
      const folderEntries = await fsp.readdir(folderPath, { withFileTypes: true });
      for (const folderEntry of folderEntries) {
        if (folderEntry.isFile() && folderEntry.name.toLowerCase().endsWith(".rlrr")) {
          extraNames.push(stripDifficultySuffix(path.parse(folderEntry.name).name));
        }
      }
    } catch {
      // Keep folder-name match even if files cannot be read.
    }

    library.push(buildLibraryEntry(entry.name, extraNames, folderPath));
  }

  return {
    mode: "folder",
    songsDir: resolvedSongsDir,
    scannedAt: new Date().toISOString(),
    entries: library
  };
}

async function scanQuestWithAdb() {
  const adbPath = await findAdb();
  const devices = await getQuestDevices();
  if (devices.length === 0) {
    throw new Error("No authorized Quest found through adb.");
  }

  const serialArgs = ["-s", devices[0]];
  await execFile(adbPath, [...serialArgs, "shell", "mkdir", "-p", QUEST_REMOTE_SONGS], { timeout: 30000 });
  let folderPaths;

  try {
    const { stdout } = await execFile(adbPath, [...serialArgs, "shell", "find", QUEST_REMOTE_SONGS, "-mindepth", "1", "-maxdepth", "1", "-type", "d"], { timeout: 30000 });
    folderPaths = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  } catch {
    const { stdout } = await execFile(adbPath, [...serialArgs, "shell", "ls", "-1", QUEST_REMOTE_SONGS], { timeout: 30000 });
    folderPaths = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((folderName) => `${QUEST_REMOTE_SONGS}/${folderName}`);
  }

  const entries = folderPaths.map((folderPath) => buildLibraryEntry(path.posix.basename(folderPath), [], folderPath));

  return {
    mode: "adb",
    songsDir: QUEST_REMOTE_SONGS,
    scannedAt: new Date().toISOString(),
    entries
  };
}

async function detectQuestMounts() {
  const candidates = [];
  const volumeRoot = process.platform === "win32" ? "" : "/Volumes";

  if (process.platform !== "win32") {
    try {
      const volumes = await fsp.readdir(volumeRoot, { withFileTypes: true });
      for (const volume of volumes) {
        if (!volume.isDirectory()) continue;
        const base = path.join(volumeRoot, volume.name);
        candidates.push(path.join(base, "Internal Shared Storage", "Paradiddle", "Songs"));
        candidates.push(path.join(base, "Paradiddle", "Songs"));
      }
    } catch {
      return [];
    }
  }

  const existing = [];
  for (const candidate of candidates) {
    try {
      const stat = await fsp.stat(candidate);
      if (stat.isDirectory()) existing.push(candidate);
    } catch {
      // Candidate not mounted.
    }
  }

  return existing;
}

ipcMain.handle("settings:get", async () => {
  const settings = await readSettings();
  const questCandidates = await detectQuestMounts();
  return { ...settings, questCandidates };
});

ipcMain.handle("settings:update", async (_event, patch) => {
  const current = await readSettings();
  const next = {
    ...current,
    installMode: ["local", "questFolder", "adb"].includes(patch.installMode) ? patch.installMode : current.installMode,
    localSongsDir: typeof patch.localSongsDir === "string" ? patch.localSongsDir : current.localSongsDir,
    questSongsDir: typeof patch.questSongsDir === "string" ? patch.questSongsDir : current.questSongsDir,
    lastQuery: typeof patch.lastQuery === "string" ? patch.lastQuery.slice(0, 120) : current.lastQuery,
    checkInstalled: typeof patch.checkInstalled === "boolean" ? patch.checkInstalled : current.checkInstalled
  };
  return writeSettings(next);
});

ipcMain.handle("folder:choose", async (_event, mode) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: mode === "questFolder" ? "Choose Quest Paradiddle/Songs folder" : "Choose Paradiddle/Songs folder",
    properties: ["openDirectory", "createDirectory"]
  });

  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

ipcMain.handle("paradb:search", async (_event, params = {}) => {
  const query = typeof params.query === "string" ? params.query.trim() : "";
  const offset = Number.isFinite(params.offset) ? Math.max(0, Math.floor(params.offset)) : 0;
  const url = new URL(`${PARADB_ORIGIN}/api/maps`);
  url.searchParams.set("query", query);
  url.searchParams.set("limit", String(SEARCH_LIMIT));
  url.searchParams.set("offset", String(offset));
  url.searchParams.set("sort", "submissionDate");
  url.searchParams.set("sortDirection", "desc");

  const payload = await fetchJson(url);
  if (!payload.success) {
    throw new Error(payload.errorMessage || "ParaDB search failed.");
  }

  return payload.maps;
});

ipcMain.handle("paradb:getMap", async (_event, id) => {
  const mapId = normalizeMapId(id);
  const payload = await fetchJson(`${PARADB_ORIGIN}/api/maps/${encodeURIComponent(mapId)}`);

  if (!payload.success) {
    throw new Error(payload.errorMessage || "ParaDB map lookup failed.");
  }

  return payload.map;
});

ipcMain.handle("paradb:install", async (_event, request) => {
  const settings = await readSettings();
  const map = request?.map;
  if (!map?.id || !map?.title) throw new Error("Map payload missing id/title.");

  const mode = request.mode || settings.installMode;
  const mapFolderName = sanitizeFolderName(request.folderName || map.title, map.id);
  const stagingRoot = await fsp.mkdtemp(path.join(app.getPath("temp"), `paradiddle-${map.id}-`));
  const zipPath = path.join(stagingRoot, `${map.id}.zip`);

  try {
    sendProgress(map.id, "Downloading zip");
    await downloadMapZip(map, zipPath);

    sendProgress(map.id, "Extracting map");
    const mapFolder = await extractZipToMapFolder(zipPath, mapFolderName, stagingRoot);

    let destination;
    if (mode === "adb") {
      sendProgress(map.id, "Pushing to Quest with adb");
      destination = await installToQuestWithAdb(mapFolder, mapFolderName);
    } else if (mode === "questFolder") {
      sendProgress(map.id, "Copying to mounted Quest folder");
      destination = await installToLocalFolder(mapFolder, settings.questSongsDir, mapFolderName);
    } else {
      sendProgress(map.id, "Copying to local Songs folder");
      destination = await installToLocalFolder(mapFolder, settings.localSongsDir, mapFolderName);
    }

    sendProgress(map.id, "Installed", { destination });
    return { destination, folderName: mapFolderName };
  } finally {
    await fsp.rm(stagingRoot, { recursive: true, force: true });
  }
});

ipcMain.handle("quest:status", async () => {
  const questCandidates = await detectQuestMounts();
  let adb = { installed: false, devices: [] };

  try {
    const adbPath = await findAdb();
    const devices = await getQuestDevices();
    adb = { installed: true, path: adbPath, devices };
  } catch (error) {
    adb = { installed: false, error: error.message, devices: [] };
  }

  return { questCandidates, adb };
});

ipcMain.handle("library:scan", async (_event, mode) => {
  const settings = await readSettings();

  if (mode === "adb") return scanQuestWithAdb();
  if (mode === "questFolder") return scanLocalSongsFolder(settings.questSongsDir);
  return scanLocalSongsFolder(settings.localSongsDir);
});

ipcMain.handle("shell:openPath", async (_event, targetPath) => {
  if (typeof targetPath !== "string" || targetPath.trim() === "") return;
  await shell.openPath(targetPath);
});
