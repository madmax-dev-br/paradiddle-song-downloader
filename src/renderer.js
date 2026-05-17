const state = {
  settings: null,
  maps: [],
  query: "",
  offset: 0,
  linkLookup: false,
  loading: false,
  searchTimer: null,
  searchSequence: 0,
  installing: new Map(),
  status: null,
  error: "",
  installedScan: null,
  installedEntries: [],
  installedKeys: new Set(),
  scanningLibrary: false,
  scanError: ""
};

const els = {
  searchForm: document.getElementById("searchForm"),
  searchInput: document.getElementById("searchInput"),
  searchStatus: document.getElementById("searchStatus"),
  loadLatest: document.getElementById("loadLatest"),
  loadMore: document.getElementById("loadMore"),
  resultsBody: document.getElementById("resultsBody"),
  resultTitle: document.getElementById("resultTitle"),
  resultMeta: document.getElementById("resultMeta"),
  localDir: document.getElementById("localDir"),
  questDir: document.getElementById("questDir"),
  chooseLocal: document.getElementById("chooseLocal"),
  chooseQuest: document.getElementById("chooseQuest"),
  refreshQuest: document.getElementById("refreshQuest"),
  checkInstalled: document.getElementById("checkInstalled"),
  scanLibrary: document.getElementById("scanLibrary"),
  installedSummary: document.getElementById("installedSummary"),
  adbStatus: document.getElementById("adbStatus"),
  questCandidates: document.getElementById("questCandidates"),
  jobCard: document.getElementById("jobCard"),
  segments: Array.from(document.querySelectorAll(".segment")),
  targetPanels: Array.from(document.querySelectorAll("[data-target-panel]"))
};

function formatDate(value) {
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(new Date(value));
}

function formatDifficulty(map) {
  const names = (map.difficulties || []).map((entry) => entry.difficultyName).filter(Boolean);
  return names.length ? names.join(", ") : "Unknown";
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

function extractMapId(input) {
  const value = String(input || "").trim();
  if (!value) return "";

  const directMatch = value.match(/^M[A-Z0-9]{6}$/i);
  if (directMatch) return directMatch[0].toUpperCase();

  try {
    const url = new URL(value);
    const match = url.pathname.match(/\/map\/(M[A-Z0-9]{6})(?:\/|$)/i);
    return match ? match[1].toUpperCase() : "";
  } catch {
    const looseMatch = value.match(/paradb\.net\/map\/(M[A-Z0-9]{6})/i);
    return looseMatch ? looseMatch[1].toUpperCase() : "";
  }
}

function setBusy(isBusy) {
  state.loading = isBusy;
  els.loadMore.disabled = isBusy || state.linkLookup;
  els.loadMore.textContent = isBusy ? "Loading..." : "Load More";
  els.searchStatus.classList.toggle("active", isBusy);
}

function currentMode() {
  return state.settings?.installMode || "local";
}

async function saveSettings(patch) {
  state.settings = await window.paradiddle.updateSettings(patch);
  renderSettings();
}

function renderSettings() {
  if (!state.settings) return;

  els.localDir.value = state.settings.localSongsDir || "";
  els.questDir.value = state.settings.questSongsDir || "";
  els.checkInstalled.checked = Boolean(state.settings.checkInstalled);

  els.segments.forEach((button) => {
    button.classList.toggle("active", button.dataset.mode === currentMode());
  });

  els.targetPanels.forEach((panel) => {
    panel.classList.toggle("hidden", panel.dataset.targetPanel !== currentMode());
  });

  renderQuestCandidates();
  renderInstalledSummary();
}

function renderQuestCandidates() {
  const candidates = state.status?.questCandidates || state.settings?.questCandidates || [];
  els.questCandidates.innerHTML = "";

  if (candidates.length === 0) {
    const empty = document.createElement("div");
    empty.className = "quiet";
    empty.textContent = "No mounted Quest Songs folder detected.";
    els.questCandidates.appendChild(empty);
    return;
  }

  candidates.forEach((candidate) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "candidate";
    button.textContent = candidate;
    button.addEventListener("click", () => saveSettings({ questSongsDir: candidate }));
    els.questCandidates.appendChild(button);
  });
}

function renderStatus() {
  const adb = state.status?.adb;
  if (!adb) {
    els.adbStatus.textContent = "Checking adb...";
    return;
  }

  if (!adb.installed) {
    els.adbStatus.textContent = "adb not found. Install Android platform tools or use Quest Folder mode.";
    return;
  }

  if (adb.devices.length === 0) {
    els.adbStatus.textContent = "adb found, no authorized Quest connected.";
    return;
  }

  els.adbStatus.textContent = `Ready: ${adb.devices.length} device${adb.devices.length === 1 ? "" : "s"} connected.`;
}

function renderJobs() {
  const jobs = Array.from(state.installing.values());
  els.jobCard.innerHTML = "";

  if (jobs.length === 0) {
    const empty = document.createElement("span");
    empty.className = "quiet";
    empty.textContent = "No active install.";
    els.jobCard.appendChild(empty);
    return;
  }

  jobs.slice(-4).reverse().forEach((job) => {
    const item = document.createElement("div");
    item.className = `job ${job.done ? "done" : ""}`;
    item.innerHTML = `
      <strong>${escapeHtml(job.title)}</strong>
      <span>${escapeHtml(job.message)}</span>
      ${job.destination ? `<button type="button" data-open="${escapeAttr(job.destination)}">Open</button>` : ""}
    `;
    els.jobCard.appendChild(item);
  });

  els.jobCard.querySelectorAll("[data-open]").forEach((button) => {
    button.addEventListener("click", () => window.paradiddle.openPath(button.dataset.open));
  });
}

function renderInstalledSummary() {
  if (state.scanningLibrary) {
    els.scanLibrary.disabled = true;
    els.scanLibrary.textContent = "Scanning...";
    els.installedSummary.textContent = "Checking song folders...";
    return;
  }

  els.scanLibrary.disabled = false;
  els.scanLibrary.textContent = "Scan";

  if (!state.settings?.checkInstalled) {
    els.installedSummary.textContent = "Installed marker off.";
    return;
  }

  if (state.scanError) {
    els.installedSummary.textContent = state.scanError;
    return;
  }

  if (!state.installedScan) {
    els.installedSummary.textContent = "Not scanned.";
    return;
  }

  const time = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(state.installedScan.scannedAt));
  els.installedSummary.textContent = `${state.installedEntries.length} installed folder${state.installedEntries.length === 1 ? "" : "s"} found at ${time}.`;
}

function findInstalledEntry(map) {
  const titleKey = normalizeLibraryKey(map.title);
  if (!titleKey) return null;

  for (const entry of state.installedEntries) {
    if ((entry.keys || []).includes(titleKey)) return entry;
  }

  if (titleKey.length < 7) return null;
  return state.installedEntries.find((entry) => {
    return (entry.keys || []).some((key) => {
      return key.length >= 7 && (key.includes(titleKey) || titleKey.includes(key));
    });
  }) || null;
}

function renderResults() {
  els.resultsBody.innerHTML = "";

  if (state.loading && state.maps.length === 0) {
    const row = document.createElement("tr");
    row.innerHTML = `<td colspan="7" class="empty-cell"><span class="inline-loader"><span class="spinner active"></span>Searching ParaDB...</span></td>`;
    els.resultsBody.appendChild(row);
    return;
  }

  if (state.maps.length === 0 && !state.loading) {
    const row = document.createElement("tr");
    row.innerHTML = `<td colspan="7" class="empty-cell">No maps found.</td>`;
    els.resultsBody.appendChild(row);
    return;
  }

  state.maps.forEach((map) => {
    const job = state.installing.get(map.id);
    const installedEntry = state.settings?.checkInstalled ? findInstalledEntry(map) : null;
    const isInstalling = job && !job.done;
    const row = document.createElement("tr");
    row.className = `map-row ${installedEntry ? "installed-row" : ""}`;
    row.innerHTML = `
      <td>
        <button class="song-button" type="button" data-install="${escapeAttr(map.id)}">
          <strong>${escapeHtml(map.title)}</strong>
          <span>${escapeHtml(formatDate(map.submissionDate))}</span>
        </button>
      </td>
      <td>${escapeHtml(map.artist)}</td>
      <td>${escapeHtml(map.author || "Unknown")}</td>
      <td><span class="difficulty">${escapeHtml(formatDifficulty(map))}</span></td>
      <td>${Number(map.downloadCount || 0).toLocaleString()}</td>
      <td>
        ${installedEntry ? `<span class="installed-badge" title="${escapeAttr(installedEntry.folderPath || installedEntry.folderName)}">Installed</span>` : `<span class="quiet">New</span>`}
      </td>
      <td>
        <button class="install-button" type="button" data-install="${escapeAttr(map.id)}" ${isInstalling ? "disabled" : ""}>
          ${isInstalling ? "Installing" : installedEntry ? "Reinstall" : "Install"}
        </button>
      </td>
    `;
    els.resultsBody.appendChild(row);
  });

  els.resultsBody.querySelectorAll("[data-install]").forEach((button) => {
    button.addEventListener("click", () => installMap(button.dataset.install));
  });
}

function renderResultHeader() {
  const trimmed = state.query.trim();
  els.resultTitle.textContent = state.linkLookup ? "Map From Link" : trimmed ? `Results for "${trimmed}"` : "Latest Maps";
  els.resultMeta.textContent = state.error || `${state.maps.length} map${state.maps.length === 1 ? "" : "s"} loaded from ParaDB.`;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  }[char]));
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/`/g, "&#096;");
}

async function runSearch({ reset = true } = {}) {
  const sequence = ++state.searchSequence;

  if (reset) {
    const mapId = extractMapId(state.query);
    if (mapId) {
      await runLinkLookup(mapId, sequence);
      return;
    }
  }

  setBusy(true);

  try {
    state.error = "";
    state.linkLookup = false;
    if (reset) {
      state.offset = 0;
      state.maps = [];
    }

    renderResults();
    const maps = await window.paradiddle.search({ query: state.query, offset: state.offset });
    if (sequence !== state.searchSequence) return;
    state.maps = reset ? maps : [...state.maps, ...maps];
    state.offset = state.maps.length;
    await saveSettings({ lastQuery: state.query });
    if (reset && state.settings.checkInstalled && !state.installedScan) {
      await scanInstalledLibrary();
    }
  } catch (error) {
    if (sequence !== state.searchSequence) return;
    state.error = error.message;
  } finally {
    if (sequence !== state.searchSequence) return;
    setBusy(false);
    renderResultHeader();
    renderResults();
  }
}

async function runLinkLookup(mapId = extractMapId(els.searchInput.value), sequence = ++state.searchSequence) {
  if (!mapId) {
    state.error = "Paste a ParaDB map link or id like https://paradb.net/map/M3EA11F.";
    state.linkLookup = false;
    renderResultHeader();
    renderResults();
    return;
  }

  setBusy(true);

  try {
    state.error = "";
    state.linkLookup = true;
    state.offset = 0;
    state.maps = [];
    state.query = els.searchInput.value.trim() || mapId;
    renderResults();

    const map = await window.paradiddle.getMap(mapId);
    if (sequence !== state.searchSequence) return;
    state.maps = [map];
    state.offset = 1;
    await saveSettings({ lastQuery: state.query });

    if (state.settings.checkInstalled && !state.installedScan) {
      await scanInstalledLibrary();
    }
  } catch (error) {
    if (sequence !== state.searchSequence) return;
    state.error = error.message;
  } finally {
    if (sequence !== state.searchSequence) return;
    setBusy(false);
    renderResultHeader();
    renderResults();
  }
}

function scheduleSearch(delayMs = 2000) {
  if (state.searchTimer) clearTimeout(state.searchTimer);
  state.query = els.searchInput.value;
  state.searchTimer = setTimeout(() => {
    state.searchTimer = null;
    runSearch({ reset: true });
  }, delayMs);
}

async function installMap(id) {
  const map = state.maps.find((entry) => entry.id === id);
  if (!map) return;

  state.installing.set(id, { title: map.title, message: "Queued", done: false });
  renderJobs();
  renderResults();

  try {
    const result = await window.paradiddle.install({ map, mode: currentMode(), folderName: map.title });
    addInstalledEntry(result.folderName, result.destination);
    state.installing.set(id, {
      title: map.title,
      message: `Installed as ${result.folderName}`,
      destination: result.destination,
      done: true
    });
  } catch (error) {
    state.installing.set(id, { title: map.title, message: error.message, done: true });
  } finally {
    renderJobs();
    renderResults();
  }
}

function addInstalledEntry(folderName, folderPath) {
  const keys = [normalizeLibraryKey(folderName)].filter(Boolean);
  const existingIndex = state.installedEntries.findIndex((entry) => entry.folderPath === folderPath || entry.folderName === folderName);
  const entry = { folderName, folderPath, keys };

  if (existingIndex >= 0) {
    state.installedEntries[existingIndex] = entry;
  } else {
    state.installedEntries.push(entry);
  }

  state.installedKeys = new Set(state.installedEntries.flatMap((item) => item.keys || []));
  state.installedScan = state.installedScan || { scannedAt: new Date().toISOString(), entries: state.installedEntries };
}

async function scanInstalledLibrary() {
  if (state.scanningLibrary || !state.settings?.checkInstalled) return;

  state.scanningLibrary = true;
  state.scanError = "";
  renderInstalledSummary();

  try {
    const scan = await window.paradiddle.scanLibrary(currentMode());
    state.installedScan = scan;
    state.installedEntries = scan.entries || [];
    state.installedKeys = new Set(state.installedEntries.flatMap((entry) => entry.keys || []));
  } catch (error) {
    state.scanError = error.message;
    state.installedScan = null;
    state.installedEntries = [];
    state.installedKeys = new Set();
  } finally {
    state.scanningLibrary = false;
    renderInstalledSummary();
    renderResults();
  }
}

async function refreshQuestStatus() {
  els.adbStatus.textContent = "Checking adb...";
  state.status = await window.paradiddle.questStatus();
  renderStatus();
  renderQuestCandidates();
}

function bindEvents() {
  els.searchForm.addEventListener("submit", (event) => {
    event.preventDefault();
    state.query = els.searchInput.value;
    runSearch({ reset: true });
  });

  els.searchInput.addEventListener("input", () => {
    scheduleSearch(2000);
  });

  els.loadLatest.addEventListener("click", () => {
    if (state.searchTimer) clearTimeout(state.searchTimer);
    state.query = "";
    els.searchInput.value = "";
    state.linkLookup = false;
    runSearch({ reset: true });
  });

  els.loadMore.addEventListener("click", () => runSearch({ reset: false }));

  els.chooseLocal.addEventListener("click", async () => {
    const folder = await window.paradiddle.chooseFolder("local");
    if (folder) await saveSettings({ localSongsDir: folder });
  });

  els.chooseQuest.addEventListener("click", async () => {
    const folder = await window.paradiddle.chooseFolder("questFolder");
    if (folder) await saveSettings({ questSongsDir: folder });
  });

  els.refreshQuest.addEventListener("click", refreshQuestStatus);
  els.scanLibrary.addEventListener("click", scanInstalledLibrary);
  els.checkInstalled.addEventListener("change", async () => {
    await saveSettings({ checkInstalled: els.checkInstalled.checked });
    if (state.settings.checkInstalled) {
      await scanInstalledLibrary();
    } else {
      renderResults();
    }
  });

  els.segments.forEach((button) => {
    button.addEventListener("click", async () => {
      await saveSettings({ installMode: button.dataset.mode });
      state.installedScan = null;
      state.installedEntries = [];
      state.installedKeys = new Set();
      if (state.settings.checkInstalled) await scanInstalledLibrary();
      renderResults();
    });
  });

  window.paradiddle.onInstallProgress((payload) => {
    const title = state.maps.find((map) => map.id === payload.mapId)?.title || payload.mapId;
    state.installing.set(payload.mapId, {
      title,
      message: payload.message,
      destination: payload.destination,
      done: payload.message === "Installed"
    });
    renderJobs();
    renderResults();
  });
}

async function boot() {
  bindEvents();
  state.settings = await window.paradiddle.getSettings();
  state.query = state.settings.lastQuery || "";
  els.searchInput.value = state.query;
  renderSettings();
  renderJobs();
  await refreshQuestStatus();
  if (state.settings.checkInstalled) await scanInstalledLibrary();
  await runSearch({ reset: true });
}

boot();
