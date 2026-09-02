/* ---------------------------------------------------------
   ftnMDReader — reads a folder on disk, lists its markdown files,
   and lets you open, create, edit and save them.

   Built on the File System Access API (Chrome / Edge / other
   Chromium browsers). No file ever leaves the machine — every
   read and write goes straight through the browser to disk.
--------------------------------------------------------- */

(() => {
  "use strict";

  const APP_VERSION = "1.0.0";

  // ---------- DOM references ----------

  const el = {
    folderLabel:   document.getElementById("folderLabel"),
    openFolderBtn: document.getElementById("openFolderBtn"),
    emptyOpenBtn:  document.getElementById("emptyOpenBtn"),
    newFileBtn:    document.getElementById("newFileBtn"),
    fileList:      document.getElementById("fileList"),
    fileCount:     document.getElementById("fileCount"),
    emptyState:    document.getElementById("emptyState"),
    docView:       document.getElementById("docView"),
    docName:       document.getElementById("docName"),
    docDirty:      document.getElementById("docDirty"),
    docBody:       document.getElementById("docBody"),
    docResizer:    document.getElementById("docResizer"),
    editorWrap:    document.getElementById("editorWrap"),
    editorHighlight: document.getElementById("editorHighlight"),
    editor:        document.getElementById("editor"),
    preview:       document.getElementById("preview"),
    saveBtn:       document.getElementById("saveBtn"),
    tabEdit:       document.getElementById("tabEdit"),
    tabPreview:    document.getElementById("tabPreview"),
    tabSplit:      document.getElementById("tabSplit"),
    toolbar:       document.getElementById("toolbar"),
    reconnectBanner:  document.getElementById("reconnectBanner"),
    reconnectName:    document.getElementById("reconnectName"),
    reconnectBtn:     document.getElementById("reconnectBtn"),
    reconnectDismiss: document.getElementById("reconnectDismiss"),
    workspace:          document.getElementById("workspace"),
    sidebar:            document.getElementById("sidebar"),
    sidebarHead:        document.getElementById("sidebarHead"),
    sidebarResizer:     document.getElementById("sidebarResizer"),
    toggleSidebarBtn:   document.getElementById("toggleSidebarBtn"),
    searchInput:        document.getElementById("searchInput"),
    searchClear:        document.getElementById("searchClear"),
    searchContentToggle: document.getElementById("searchContentToggle"),
    newFileDialog: document.getElementById("newFileDialog"),
    newFileForm:   document.getElementById("newFileForm"),
    newFileName:   document.getElementById("newFileName"),
    newFileLocationLabel: document.getElementById("newFileLocationLabel"),
    cancelNewFile: document.getElementById("cancelNewFile"),
    newFolderBtn:      document.getElementById("newFolderBtn"),
    newFolderDialog:   document.getElementById("newFolderDialog"),
    newFolderForm:     document.getElementById("newFolderForm"),
    newFolderName:     document.getElementById("newFolderName"),
    newFolderLocationLabel: document.getElementById("newFolderLocationLabel"),
    cancelNewFolder:   document.getElementById("cancelNewFolder"),
    moveFileDialog:    document.getElementById("moveFileDialog"),
    moveFileForm:      document.getElementById("moveFileForm"),
    moveFileName:      document.getElementById("moveFileName"),
    moveFileTarget:    document.getElementById("moveFileTarget"),
    cancelMoveFile:    document.getElementById("cancelMoveFile"),
    renameDialog:      document.getElementById("renameDialog"),
    renameForm:        document.getElementById("renameForm"),
    renameDialogTitle: document.getElementById("renameDialogTitle"),
    renameInput:       document.getElementById("renameInput"),
    renameExt:         document.getElementById("renameExt"),
    cancelRename:      document.getElementById("cancelRename"),
    renameCurrentBtn:  document.getElementById("renameCurrentBtn"),
    revealBtn:         document.getElementById("revealBtn"),
    appVersion:        document.getElementById("appVersion"),
    toast:         document.getElementById("toast"),
  };

  // ---------- App state ----------

  const state = {
    dirHandle: null,
    files: new Map(),        // path -> { handle, name, parentPath }
    folders: new Map(),      // path -> { handle, name, parentPath }
    expandedPaths: new Set(),// folder paths currently expanded in the tree
    currentPath: null,
    currentHandle: null,
    savedValue: "",            // last saved/opened text, for two-way dirty comparison
    dirty: false,
    view: "edit",             // edit | preview | split
    toastTimer: null,
    query: "",
    searchContent: false,
    contentMatches: new Map(), // path -> snippet, populated by content search
    searchToken: 0,            // guards against stale async content searches
    newItemTarget: null,       // { handle, path } — where the next new file/folder is created
    draggingPath: null,        // path currently being dragged, for drop targets to read
    moveTargetFile: null,      // path pending a move via the "Move to folder…" dialog
    renameTarget: null,        // { path, kind } pending a rename via the "Rename" dialog
    splitPct: 50,               // editor's share of width in split view
  };

  const isMarkdown = (name) => /\.(md|markdown)$/i.test(name);
  const basename = (path) => path.split("/").pop();
  const joinPath = (parentPath, name) => (parentPath ? `${parentPath}/${name}` : name);

  // ---------- Persisting the last folder (IndexedDB) ----------
  // FileSystemDirectoryHandle objects are structured-cloneable, so they
  // can be stored directly in IndexedDB and retrieved on the next visit.
  // The browser still requires a fresh permission grant each session,
  // which is why reconnecting shows a banner rather than opening silently.

  const DB_NAME = "ftnMDReader";
  const STORE_NAME = "handles";
  const LAST_FOLDER_KEY = "lastFolder";

  function idbOpen() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE_NAME);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function idbSet(key, value) {
    const db = await idbOpen();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function idbGet(key) {
    const db = await idbOpen();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const req = tx.objectStore(STORE_NAME).get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }

  async function idbDelete(key) {
    const db = await idbOpen();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function rememberFolder(handle) {
    try { await idbSet(LAST_FOLDER_KEY, handle); }
    catch (err) { console.warn("Couldn't remember this folder:", err); }
  }

  async function forgetFolder() {
    try { await idbDelete(LAST_FOLDER_KEY); }
    catch (err) { console.warn(err); }
  }

  // ---------- Feature check ----------

  if (!("showDirectoryPicker" in window)) {
    el.openFolderBtn.disabled = true;
    el.emptyOpenBtn.disabled = true;
    showToast("This browser can't open local folders — try Chrome or Edge.", 6000);
  }

  // ---------- Folder handling ----------

  async function openFolder() {
    try {
      const handle = await window.showDirectoryPicker();
      await useFolder(handle);
      await rememberFolder(handle);
    } catch (err) {
      // AbortError just means the user closed the picker — ignore it.
      if (err.name !== "AbortError") {
        console.error(err);
        showToast("Couldn't open that folder.");
      }
    }
  }

  async function useFolder(handle) {
    state.dirHandle = handle;
    el.folderLabel.textContent = handle.name;
    el.newFileBtn.disabled = false;
    el.newFolderBtn.disabled = false;
    hideReconnectBanner();
    await refreshFileList();
  }

  // On load, check whether a folder was left open last time and offer to
  // reconnect to it. Browsers require a user gesture to re-grant file
  // permissions across sessions, so this can't happen silently — but if
  // permission is already granted (e.g. same tab, soft reload) it skips
  // straight to opening it.
  async function restoreLastFolder() {
    let handle;
    try { handle = await idbGet(LAST_FOLDER_KEY); }
    catch { return; }
    if (!handle) return;

    const permission = await handle.queryPermission({ mode: "readwrite" });
    if (permission === "granted") {
      await useFolder(handle);
      showToast(`Reopened ${handle.name}`);
    } else {
      showReconnectBanner(handle);
    }
  }

  function showReconnectBanner(handle) {
    el.reconnectName.textContent = handle.name;
    el.reconnectBanner.hidden = false;
    el.reconnectBtn.onclick = async () => {
      try {
        const permission = await handle.requestPermission({ mode: "readwrite" });
        if (permission === "granted") {
          await useFolder(handle);
          showToast(`Reopened ${handle.name}`);
        } else {
          showToast("Permission wasn't granted.");
        }
      } catch (err) {
        console.error(err);
        showToast("Couldn't reconnect to that folder.");
      }
    };
    el.reconnectDismiss.onclick = () => {
      hideReconnectBanner();
      forgetFolder();
    };
  }

  function hideReconnectBanner() {
    el.reconnectBanner.hidden = true;
  }

  async function refreshFileList() {
    state.files.clear();
    state.folders.clear();
    state.expandedPaths.clear();
    await scanDirectory(state.dirHandle, "");
    renderFileList();
  }

  // Walks the whole folder tree up front (rather than lazily per-expand)
  // so search and the tree view share one simple, always-current index.
  // A depth guard avoids runaway recursion on unusually deep trees.
  async function scanDirectory(dirHandle, path, depth = 0) {
    if (depth > 12) return;

    for await (const [name, handle] of dirHandle.entries()) {
      const childPath = joinPath(path, name);
      if (handle.kind === "directory") {
        state.folders.set(childPath, { handle, name, parentPath: path });
        await scanDirectory(handle, childPath, depth + 1);
      } else if (handle.kind === "file" && isMarkdown(name)) {
        state.files.set(childPath, { handle, name, parentPath: path });
      }
    }
  }

  function highlight(text, query) {
    if (!query) return escapeHtml(text);
    const idx = text.toLowerCase().indexOf(query.toLowerCase());
    if (idx === -1) return escapeHtml(text);
    return escapeHtml(text.slice(0, idx)) +
      "<mark>" + escapeHtml(text.slice(idx, idx + query.length)) + "</mark>" +
      escapeHtml(text.slice(idx + query.length));
  }

  function snippetAround(text, query, radius = 40) {
    const idx = text.toLowerCase().indexOf(query.toLowerCase());
    if (idx === -1) return "";
    const start = Math.max(0, idx - radius);
    const end = Math.min(text.length, idx + query.length + radius);
    const prefix = start > 0 ? "…" : "";
    const suffix = end < text.length ? "…" : "";
    return prefix + highlight(text.slice(start, end), query) + suffix;
  }

  function sortedChildren(map, parentPath) {
    return [...map.entries()]
      .filter(([, info]) => info.parentPath === parentPath)
      .sort((a, b) => a[1].name.localeCompare(b[1].name, undefined, { sensitivity: "base" }));
  }

  function renderFileList() {
    el.fileList.innerHTML = "";
    el.fileCount.textContent = state.files.size ? String(state.files.size) : "";

    if (state.files.size === 0 && state.folders.size === 0) {
      const li = document.createElement("li");
      li.className = "empty-hint";
      li.textContent = "This folder is empty. Create a file or folder to get started.";
      el.fileList.appendChild(li);
      return;
    }

    const query = state.query.trim();
    if (query) {
      renderSearchResults(query);
    } else {
      renderTreeLevel(el.fileList, "", 0);
    }
  }

  function renderTreeLevel(container, parentPath, depth) {
    for (const [path, info] of sortedChildren(state.folders, parentPath)) {
      container.appendChild(buildFolderRow(path, info, depth));
    }
    for (const [path, info] of sortedChildren(state.files, parentPath)) {
      container.appendChild(buildFileRow(path, info, depth, ""));
    }
  }

  function buildRowActionButton(symbol, title, onClick) {
    const btn = document.createElement("button");
    btn.className = "row-action";
    btn.type = "button";
    btn.title = title;
    btn.textContent = symbol;
    btn.addEventListener("click", (e) => { e.stopPropagation(); onClick(); });
    return btn;
  }

  function buildFolderRow(path, info, depth) {
    const expanded = state.expandedPaths.has(path);

    const li = document.createElement("li");
    li.className = "folder-item";

    const row = document.createElement("div");
    row.className = "item-row";
    row.style.paddingLeft = (depth * 14) + "px";
    row.innerHTML =
      `<span class="caret">${expanded ? "▾" : "▸"}</span>` +
      `<span class="icon">📁</span>` +
      `<span class="name">${escapeHtml(info.name)}</span>`;

    const actions = document.createElement("span");
    actions.className = "row-actions";
    actions.appendChild(buildRowActionButton("📄+", "New file here", () => openNewFileDialog(path)));
    actions.appendChild(buildRowActionButton("📁+", "New folder here", () => openNewFolderDialog(path)));
    actions.appendChild(buildRowActionButton("✏️", "Rename folder…", () => openRenameDialog(path, "folder")));
    row.appendChild(actions);

    row.addEventListener("click", () => toggleFolder(path));

    // Drop target: dragging a file onto a folder row moves it there.
    row.addEventListener("dragover", (e) => {
      if (!state.draggingPath) return;
      e.preventDefault();
      row.classList.add("drop-target");
    });
    row.addEventListener("dragleave", () => row.classList.remove("drop-target"));
    row.addEventListener("drop", (e) => {
      e.preventDefault();
      row.classList.remove("drop-target");
      const draggedPath = e.dataTransfer.getData("text/plain") || state.draggingPath;
      if (draggedPath) moveFile(draggedPath, path);
    });

    li.appendChild(row);

    if (expanded) {
      const childUl = document.createElement("ul");
      childUl.className = "folder-children";
      renderTreeLevel(childUl, path, depth + 1);
      li.appendChild(childUl);
    }

    return li;
  }

  function buildFileRow(path, info, depth, query) {
    const li = document.createElement("li");
    li.className = "file-item" + (path === state.currentPath ? " selected" : "");
    if (path === state.currentPath && state.dirty) li.classList.add("dirty");
    li.tabIndex = 0;
    li.dataset.path = path;

    const row = document.createElement("div");
    row.className = "item-row";
    row.draggable = true;
    row.style.paddingLeft = (depth * 14) + "px";
    row.innerHTML =
      `<span class="dot"></span><span class="name">${highlight(info.name, query)}</span>`;

    const actions = document.createElement("span");
    actions.className = "row-actions";
    actions.appendChild(buildRowActionButton("✏️", "Rename file…", () => openRenameDialog(path, "file")));
    actions.appendChild(buildRowActionButton("📂", "Move to folder…", () => openMoveDialog(path)));
    row.appendChild(actions);

    row.addEventListener("dragstart", (e) => {
      state.draggingPath = path;
      e.dataTransfer.setData("text/plain", path);
      e.dataTransfer.effectAllowed = "move";
      li.classList.add("dragging");
    });
    row.addEventListener("dragend", () => {
      state.draggingPath = null;
      li.classList.remove("dragging");
    });

    li.appendChild(row);

    if (query && info.parentPath) {
      const hint = document.createElement("span");
      hint.className = "path-hint";
      hint.textContent = info.parentPath;
      li.appendChild(hint);
    }

    const snippet = state.contentMatches.get(path);
    if (snippet) {
      const s = document.createElement("span");
      s.className = "snippet";
      s.innerHTML = snippet;
      li.appendChild(s);
    }

    li.addEventListener("click", () => openFile(path));
    li.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openFile(path); }
    });
    return li;
  }

  function renderSearchResults(query) {
    const lowerQuery = query.toLowerCase();
    const nameMatches = [...state.files.keys()].filter((p) => p.toLowerCase().includes(lowerQuery));
    const contentOnly = [...state.contentMatches.keys()].filter(
      (p) => !nameMatches.includes(p) && state.files.has(p)
    );
    const shown = [...nameMatches, ...contentOnly].sort((a, b) => a.localeCompare(b));

    if (shown.length === 0) {
      const li = document.createElement("li");
      li.className = "no-results";
      li.textContent = state.searchContent
        ? `No files match "${query}".`
        : `No file names match "${query}". Try "Also search inside files".`;
      el.fileList.appendChild(li);
      return;
    }

    for (const path of shown) {
      el.fileList.appendChild(buildFileRow(path, state.files.get(path), 0, query));
    }
  }

  function toggleFolder(path) {
    if (state.expandedPaths.has(path)) state.expandedPaths.delete(path);
    else state.expandedPaths.add(path);
    renderFileList();
  }

  // ---------- Search ----------

  function debounce(fn, wait) {
    let timer;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), wait);
    };
  }

  const handleSearchInput = debounce(() => {
    el.searchClear.hidden = state.query.length === 0;
    state.contentMatches.clear();
    renderFileList();
    if (state.searchContent && state.query.trim().length >= 2) {
      runContentSearch(state.query.trim());
    }
  }, 150);

  // Reads every markdown file in the folder looking for the query. Runs
  // only when "Also search inside files" is on, since it means opening
  // every file in the folder rather than just checking names.
  async function runContentSearch(query) {
    const token = ++state.searchToken;
    const lowerQuery = query.toLowerCase();

    for (const [path, info] of state.files) {
      if (token !== state.searchToken) return; // a newer search superseded this one
      try {
        const file = await info.handle.getFile();
        const text = await file.text();
        if (text.toLowerCase().includes(lowerQuery)) {
          state.contentMatches.set(path, snippetAround(text, query));
          if (token === state.searchToken) renderFileList();
        }
      } catch {
        // Skip files that fail to read (e.g. removed mid-search)
      }
    }
  }

  // ---------- File open / save ----------

  async function openFile(path) {
    if (state.dirty && !(await confirmDiscard())) return;

    const info = state.files.get(path);
    if (!info) return;

    try {
      const file = await info.handle.getFile();
      const text = await file.text();

      state.currentPath = path;
      state.currentHandle = info.handle;
      state.dirty = false;
      state.savedValue = text;

      el.editor.value = text;
      updateHighlight();
      el.docName.textContent = info.name;
      el.docName.title = path;
      el.docDirty.hidden = true;
      el.saveBtn.disabled = true;
      el.emptyState.hidden = true;
      el.docView.hidden = false;

      renderPreview();
      renderFileList();
      el.editor.focus();
    } catch (err) {
      console.error(err);
      showToast(`Couldn't open ${info.name}.`);
    }
  }

  async function confirmDiscard() {
    return window.confirm(`${basename(state.currentPath)} has unsaved changes. Discard them?`);
  }

  async function saveCurrentFile() {
    if (!state.currentHandle || !state.dirty) return;

    try {
      const writable = await state.currentHandle.createWritable();
      await writable.write(el.editor.value);
      await writable.close();

      state.savedValue = el.editor.value;
      state.dirty = false;
      el.docDirty.hidden = true;
      el.saveBtn.disabled = true;
      renderFileList();
      showToast(`Saved ${basename(state.currentPath)}`);
    } catch (err) {
      console.error(err);
      showToast("Couldn't save — check the file is still writable.");
    }
  }

  // Recomputes dirty state by comparing the live text against the last
  // saved/opened snapshot, rather than only ever flipping dirty on — so
  // undoing back to the saved text correctly clears the "unsaved" mark.
  function updateDirtyState() {
    const isDirty = el.editor.value !== state.savedValue;
    if (isDirty === state.dirty) return;
    state.dirty = isDirty;
    el.docDirty.hidden = !isDirty;
    el.saveBtn.disabled = !isDirty;
    renderFileList();
  }

  // ---------- New file / New folder ----------
  // Both accept an optional target folder path. Passing none targets the
  // root of the open folder, which is what the top-bar buttons do; the
  // per-folder "+" icons in the tree pass that folder's path instead.

  function resolveTarget(targetPath) {
    if (!targetPath) return { handle: state.dirHandle, path: "" };
    const info = state.folders.get(targetPath);
    return info ? { handle: info.handle, path: targetPath } : { handle: state.dirHandle, path: "" };
  }

  function openNewFileDialog(targetPath) {
    state.newItemTarget = resolveTarget(targetPath);
    el.newFileLocationLabel.textContent = state.newItemTarget.path
      ? `File name — in ${state.newItemTarget.path}/`
      : "File name — in root";
    el.newFileName.value = "";
    el.newFileDialog.showModal();
    el.newFileName.focus();
  }

  async function createNewFile(rawName) {
    let name = rawName.trim();
    if (!name) return;
    if (!isMarkdown(name)) name += ".md";

    const target = state.newItemTarget || resolveTarget();
    const path = joinPath(target.path, name);

    if (state.files.has(path)) {
      showToast(`${name} already exists.`);
      return;
    }

    try {
      const handle = await target.handle.getFileHandle(name, { create: true });
      const writable = await handle.createWritable();
      await writable.write(`# ${name.replace(/\.(md|markdown)$/i, "")}\n\n`);
      await writable.close();

      state.files.set(path, { handle, name, parentPath: target.path });
      if (target.path) state.expandedPaths.add(target.path);
      renderFileList();
      await openFile(path);
      showToast(`Created ${name}`);
    } catch (err) {
      console.error(err);
      showToast("Couldn't create that file.");
    }
  }

  function openNewFolderDialog(targetPath) {
    state.newItemTarget = resolveTarget(targetPath);
    el.newFolderLocationLabel.textContent = state.newItemTarget.path
      ? `Folder name — in ${state.newItemTarget.path}/`
      : "Folder name — in root";
    el.newFolderName.value = "";
    el.newFolderDialog.showModal();
    el.newFolderName.focus();
  }

  async function createNewFolder(rawName) {
    const name = rawName.trim();
    if (!name) return;
    if (/[/\\]/.test(name)) {
      showToast("Folder names can't contain slashes.");
      return;
    }

    const target = state.newItemTarget || resolveTarget();
    const path = joinPath(target.path, name);

    if (state.folders.has(path)) {
      showToast(`${name} already exists.`);
      return;
    }

    try {
      const handle = await target.handle.getDirectoryHandle(name, { create: true });
      state.folders.set(path, { handle, name, parentPath: target.path });
      if (target.path) state.expandedPaths.add(target.path);
      state.expandedPaths.add(path); // open it so the new, empty folder is visible
      renderFileList();
      showToast(`Created folder ${name}`);
    } catch (err) {
      console.error(err);
      showToast("Couldn't create that folder.");
    }
  }

  // ---------- Move file ----------
  // Prefers the native FileSystemHandle.move() when available (Chrome 116+),
  // which relocates the file in place. Older browsers fall back to a
  // copy-then-delete, which is otherwise equivalent from the user's view.

  function parentHandleFor(parentPath) {
    if (!parentPath) return state.dirHandle;
    const info = state.folders.get(parentPath);
    return info ? info.handle : state.dirHandle;
  }

  async function moveFile(path, targetFolderPath) {
    const info = state.files.get(path);
    if (!info) return;

    const destPath = targetFolderPath || "";
    if (destPath === info.parentPath) return; // already there

    const newPath = joinPath(destPath, info.name);
    if (state.files.has(newPath)) {
      showToast(`${info.name} already exists in that folder.`);
      return;
    }

    const destHandle = destPath ? state.folders.get(destPath)?.handle : state.dirHandle;
    if (!destHandle) return;

    try {
      if (typeof info.handle.move === "function") {
        await info.handle.move(destHandle);
      } else {
        // Fallback for browsers without FileSystemHandle.move(): copy the
        // contents into a new handle in the destination, then remove the original.
        const file = await info.handle.getFile();
        const text = await file.text();
        const newHandle = await destHandle.getFileHandle(info.name, { create: true });
        const writable = await newHandle.createWritable();
        await writable.write(text);
        await writable.close();
        await parentHandleFor(info.parentPath).removeEntry(info.name);
        info.handle = newHandle;
      }

      state.files.delete(path);
      state.files.set(newPath, { handle: info.handle, name: info.name, parentPath: destPath });
      if (destPath) state.expandedPaths.add(destPath);
      if (state.currentPath === path) {
        state.currentPath = newPath;
        el.docName.title = newPath;
      }

      renderFileList();
      showToast(`Moved ${info.name}`);
    } catch (err) {
      console.error(err);
      showToast("Couldn't move that file.");
    }
  }

  function openMoveDialog(path) {
    const info = state.files.get(path);
    if (!info) return;

    const destinations = [...state.folders.keys()]
      .filter((p) => p !== info.parentPath)
      .sort((a, b) => a.localeCompare(b));

    el.moveFileTarget.innerHTML = "";
    if (info.parentPath !== "") {
      const rootOpt = document.createElement("option");
      rootOpt.value = "";
      rootOpt.textContent = "Root (top level)";
      el.moveFileTarget.appendChild(rootOpt);
    }
    for (const p of destinations) {
      const opt = document.createElement("option");
      opt.value = p;
      opt.textContent = p;
      el.moveFileTarget.appendChild(opt);
    }

    if (el.moveFileTarget.options.length === 0) {
      showToast("No other folders to move into yet — create one first.");
      return;
    }

    state.moveTargetFile = path;
    el.moveFileName.textContent = info.name;
    el.moveFileDialog.showModal();
  }

  // ---------- Rename file / folder ----------
  // Prefers the native FileSystemHandle.move(newName) when available, which
  // renames in place without touching contents. The fallback (older
  // browsers) copies byte-for-byte via ArrayBuffer — safe for any file
  // type, not just text — then deletes the original. For folders, the
  // fallback copies the whole subtree recursively, then the local index
  // for that subtree is dropped and rescanned against the new handle so
  // every cached child handle stays valid.

  async function copyFileTo(sourceHandle, destParentHandle, name) {
    const file = await sourceHandle.getFile();
    const buffer = await file.arrayBuffer();
    const newHandle = await destParentHandle.getFileHandle(name, { create: true });
    const writable = await newHandle.createWritable();
    await writable.write(buffer);
    await writable.close();
    return newHandle;
  }

  async function copyDirectoryRecursive(sourceHandle, destParentHandle, name) {
    const newDirHandle = await destParentHandle.getDirectoryHandle(name, { create: true });
    for await (const [entryName, entryHandle] of sourceHandle.entries()) {
      if (entryHandle.kind === "directory") {
        await copyDirectoryRecursive(entryHandle, newDirHandle, entryName);
      } else {
        await copyFileTo(entryHandle, newDirHandle, entryName);
      }
    }
    return newDirHandle;
  }

  function pruneSubtree(folderPath) {
    const prefix = folderPath + "/";
    for (const p of [...state.folders.keys()]) {
      if (p === folderPath || p.startsWith(prefix)) state.folders.delete(p);
    }
    for (const p of [...state.files.keys()]) {
      if (p.startsWith(prefix)) state.files.delete(p);
    }
    for (const p of [...state.expandedPaths]) {
      if (p === folderPath || p.startsWith(prefix)) state.expandedPaths.delete(p);
    }
    for (const p of [...state.contentMatches.keys()]) {
      if (p.startsWith(prefix)) state.contentMatches.delete(p);
    }
  }

  async function renameEntry(path, kind, rawName) {
    let finalName = rawName.trim();
    if (!finalName) return;
    if (/[/\\]/.test(finalName)) {
      showToast("Names can't contain slashes.");
      return;
    }
    if (kind === "file" && !isMarkdown(finalName)) finalName += ".md";

    const map = kind === "file" ? state.files : state.folders;
    const info = map.get(path);
    if (!info) return;

    if (finalName === info.name) return; // no-op

    const parentPath = info.parentPath;
    const newPath = joinPath(parentPath, finalName);
    if (state.files.has(newPath) || state.folders.has(newPath)) {
      showToast(`${finalName} already exists.`);
      return;
    }

    const parentHandle = parentHandleFor(parentPath);

    try {
      let newHandle;
      if (typeof info.handle.move === "function") {
        await info.handle.move(finalName);
        newHandle = info.handle;
      } else if (kind === "file") {
        newHandle = await copyFileTo(info.handle, parentHandle, finalName);
        await parentHandle.removeEntry(info.name);
      } else {
        newHandle = await copyDirectoryRecursive(info.handle, parentHandle, finalName);
        await parentHandle.removeEntry(info.name, { recursive: true });
      }

      if (kind === "file") {
        state.files.delete(path);
        state.files.set(newPath, { handle: newHandle, name: finalName, parentPath });
        if (state.currentPath === path) {
          state.currentPath = newPath;
          state.currentHandle = newHandle;
          el.docName.textContent = finalName;
          el.docName.title = newPath;
        }
      } else {
        const wasExpanded = state.expandedPaths.has(path);
        const currentInsideRenamed = state.currentPath && state.currentPath.startsWith(path + "/")
          ? state.currentPath.slice(path.length + 1)
          : null;

        pruneSubtree(path);
        state.folders.set(newPath, { handle: newHandle, name: finalName, parentPath });
        if (wasExpanded) state.expandedPaths.add(newPath);
        await scanDirectory(newHandle, newPath);

        if (currentInsideRenamed) {
          const newCurrentPath = joinPath(newPath, currentInsideRenamed);
          const reopened = state.files.get(newCurrentPath);
          if (reopened) {
            state.currentPath = newCurrentPath;
            state.currentHandle = reopened.handle;
            el.docName.title = newCurrentPath;
          }
        }
      }

      renderFileList();
      showToast(`Renamed to ${finalName}`);
    } catch (err) {
      console.error(err);
      showToast("Couldn't rename that.");
    }
  }

  function openRenameDialog(path, kind) {
    const map = kind === "file" ? state.files : state.folders;
    const info = map.get(path);
    if (!info) return;

    state.renameTarget = { path, kind };
    el.renameDialogTitle.textContent = kind === "file" ? "Rename file" : "Rename folder";

    if (kind === "file") {
      el.renameInput.value = info.name.replace(/\.(md|markdown)$/i, "");
      el.renameExt.hidden = false;
    } else {
      el.renameInput.value = info.name;
      el.renameExt.hidden = true;
    }

    el.renameDialog.showModal();
    el.renameInput.focus();
    el.renameInput.select();
  }

  // ---------- Reveal in sidebar ----------
  // Browsers can't open the OS file explorer from a web page for security
  // reasons — this is the closest useful equivalent: expand every ancestor
  // folder and scroll the file into view in the tree, briefly highlighted.

  function revealInSidebar(path) {
    const info = state.files.get(path);
    if (!info) return;

    let p = info.parentPath;
    while (p) {
      state.expandedPaths.add(p);
      const parentInfo = state.folders.get(p);
      p = parentInfo ? parentInfo.parentPath : "";
    }

    if (state.query) {
      state.query = "";
      el.searchInput.value = "";
      el.searchClear.hidden = true;
      state.contentMatches.clear();
    }

    renderFileList();

    requestAnimationFrame(() => {
      const row = el.fileList.querySelector(`li.file-item[data-path="${CSS.escape(path)}"]`);
      if (!row) return;
      row.scrollIntoView({ block: "center", behavior: "smooth" });
      row.classList.add("flash");
      setTimeout(() => row.classList.remove("flash"), 1200);
    });
  }

  // ---------- View mode (edit / preview / split) ----------

  function setView(view) {
    state.view = view;
    el.docBody.className = "doc-body mode-" + view;
    for (const [tab, name] of [[el.tabEdit, "edit"], [el.tabPreview, "preview"], [el.tabSplit, "split"]]) {
      tab.classList.toggle("active", name === view);
    }
    el.toolbar.hidden = view === "preview";
    el.editorWrap.style.flex = view === "split" ? `0 0 ${state.splitPct}%` : "";
    if (view !== "edit") renderPreview();
  }

  // ---------- Formatting toolbar ----------
  // Each action describes an edit as "replace this range with this text"
  // rather than building the whole new document string. Applying it via
  // document.execCommand("insertText", …) — instead of just assigning
  // textarea.value — keeps the edit on the browser's native undo/redo
  // stack, so Ctrl/Cmd+Z works for toolbar actions exactly like typing.

  function wrapSelection(value, start, end, before, after, placeholder) {
    const hasSelection = end > start;
    const selected = hasSelection ? value.slice(start, end) : placeholder;
    const replacement = before + selected + after;
    const selStart = start + before.length;
    const selEnd = selStart + selected.length;
    return { rangeStart: start, rangeEnd: end, replacement, selStart, selEnd };
  }

  function lineRange(value, start, end) {
    const lineStart = value.lastIndexOf("\n", start - 1) + 1;
    let lineEnd = value.indexOf("\n", end);
    if (lineEnd === -1) lineEnd = value.length;
    return { lineStart, lineEnd };
  }

  function prefixLines(value, start, end, prefix) {
    const { lineStart, lineEnd } = lineRange(value, start, end);
    const block = value.slice(lineStart, lineEnd);
    const replacement = block.split("\n").map((l) => prefix + l).join("\n");
    return { rangeStart: lineStart, rangeEnd: lineEnd, replacement, selStart: lineStart, selEnd: lineStart + replacement.length };
  }

  function setHeading(value, start, end, level) {
    const { lineStart, lineEnd } = lineRange(value, start, end);
    const block = value.slice(lineStart, lineEnd);
    const marker = "#".repeat(level) + " ";
    const replacement = block.split("\n")
      .map((l) => marker + l.replace(/^#{1,6}\s+/, ""))
      .join("\n");
    return { rangeStart: lineStart, rangeEnd: lineEnd, replacement, selStart: lineStart, selEnd: lineStart + replacement.length };
  }

  function insertAtCursor(value, start, end, text, cursorOffset) {
    const pos = start + (cursorOffset ?? text.length);
    return { rangeStart: start, rangeEnd: end, replacement: text, selStart: pos, selEnd: pos };
  }

  const TABLE_TEMPLATE =
    "\n| Column 1 | Column 2 |\n| --- | --- |\n| Cell | Cell |\n";

  function applyFormatting(action) {
    const ta = el.editor;
    const { value, selectionStart: start, selectionEnd: end } = ta;
    let result;

    switch (action) {
      case "undo": ta.focus(); document.execCommand("undo"); return;
      case "redo": ta.focus(); document.execCommand("redo"); return;
      case "h1": result = setHeading(value, start, end, 1); break;
      case "h2": result = setHeading(value, start, end, 2); break;
      case "h3": result = setHeading(value, start, end, 3); break;
      case "bold": result = wrapSelection(value, start, end, "**", "**", "bold text"); break;
      case "italic": result = wrapSelection(value, start, end, "_", "_", "italic text"); break;
      case "strike": result = wrapSelection(value, start, end, "~~", "~~", "strikethrough"); break;
      case "code": result = wrapSelection(value, start, end, "`", "`", "code"); break;
      case "codeblock": result = wrapSelection(value, start, end, "```\n", "\n```", "code"); break;
      case "quote": result = prefixLines(value, start, end, "> "); break;
      case "ul": result = prefixLines(value, start, end, "- "); break;
      case "ol": result = prefixLines(value, start, end, "1. "); break;
      case "task": result = prefixLines(value, start, end, "- [ ] "); break;
      case "hr": result = insertAtCursor(value, start, end, "\n---\n", 5); break;
      case "table": result = insertAtCursor(value, start, end, TABLE_TEMPLATE, TABLE_TEMPLATE.length); break;
      case "link": {
        const hasSelection = end > start;
        const text = hasSelection ? value.slice(start, end) : "link text";
        const replacement = `[${text}](url)`;
        const urlStart = start + text.length + 3; // position inside "(url)"
        result = { rangeStart: start, rangeEnd: end, replacement, selStart: urlStart, selEnd: urlStart + 3 };
        break;
      }
      case "image": {
        const hasSelection = end > start;
        const alt = hasSelection ? value.slice(start, end) : "alt text";
        const replacement = `![${alt}](image-url)`;
        const urlStart = start + alt.length + 4; // position inside "(image-url)"
        result = { rangeStart: start, rangeEnd: end, replacement, selStart: urlStart, selEnd: urlStart + 9 };
        break;
      }
      default: return;
    }

    replaceEditorRange(result.rangeStart, result.rangeEnd, result.replacement);
    ta.setSelectionRange(result.selStart, result.selEnd);
    updateDirtyState();
    if (state.view !== "edit") renderPreview();
  }

  // Selects [rangeStart, rangeEnd] and replaces it via execCommand so the
  // edit lands on the native undo stack. Falls back to a direct value
  // assignment (not undoable) only if execCommand is unsupported.
  function replaceEditorRange(rangeStart, rangeEnd, replacement) {
    const ta = el.editor;
    ta.focus();
    ta.setSelectionRange(rangeStart, rangeEnd);
    const applied = document.execCommand("insertText", false, replacement);
    if (!applied) {
      const value = ta.value;
      ta.value = value.slice(0, rangeStart) + replacement + value.slice(rangeEnd);
    }
  }

  // ---------- Markdown rendering ----------
  // A small, dependency-free markdown-to-HTML renderer covering the
  // common subset: headings, emphasis, links, images, code, lists,
  // blockquotes, rules and tables.

  function renderPreview() {
    el.preview.innerHTML = markdownToHtml(el.editor.value);
    enhanceCodeBlocks();
  }

  // Wraps each rendered <pre> in a positioning container, applies
  // highlight.js syntax coloring for the fence's declared language (or
  // its best guess if none was given), shows a small language label, and
  // adds a "Copy" button that copies the code block's plain text.
  function enhanceCodeBlocks() {
    const blocks = el.preview.querySelectorAll("pre");
    blocks.forEach((pre) => {
      const wrapper = document.createElement("div");
      wrapper.className = "code-block-wrap";
      pre.parentNode.insertBefore(wrapper, pre);
      wrapper.appendChild(pre);

      const codeEl = pre.querySelector("code");
      if (codeEl && window.hljs) {
        try { hljs.highlightElement(codeEl); } catch { /* unrecognized language — leave as plain text */ }
      }

      const lang = codeEl?.dataset.lang;
      if (lang) {
        wrapper.classList.add("has-label");
        const label = document.createElement("span");
        label.className = "code-lang-label";
        label.textContent = lang;
        wrapper.appendChild(label);
      }

      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "copy-code-btn";
      btn.textContent = "Copy";
      btn.addEventListener("click", () => copyCodeBlock(pre, btn));
      wrapper.appendChild(btn);
    });
  }

  async function copyCodeBlock(pre, btn) {
    const code = pre.querySelector("code");
    const text = code ? code.textContent : pre.textContent;

    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
      } else {
        copyWithFallback(text);
      }
      btn.textContent = "Copied!";
      btn.classList.add("copied");
    } catch (err) {
      console.error(err);
      btn.textContent = "Couldn't copy";
    }

    setTimeout(() => {
      btn.textContent = "Copy";
      btn.classList.remove("copied");
    }, 1600);
  }

  // Fallback for contexts where the async Clipboard API isn't available
  // (e.g. some file:// pages): a hidden, selected textarea + execCommand.
  function copyWithFallback(text) {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
  }

  function escapeHtml(str) {
    return str.replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  // ---------- Editor syntax highlighting ----------
  // Renders the same text as the textarea, but with markdown syntax
  // colored per convention. Unlike the preview renderer, this must keep
  // every original character (including the markdown punctuation) so the
  // overlay lines up exactly with the transparent textarea on top of it —
  // it only ever wraps runs of text in <span> elements, never removes or
  // replaces characters.

  function highlightInline(text) {
    let out = escapeHtml(text);
    out = out.replace(/(`[^`]+`)/g, '<span class="tok-code">$1</span>');
    out = out.replace(/(!\[[^\]]*\]\([^)\s]+\))/g, '<span class="tok-link">$1</span>');
    out = out.replace(/(\[[^\]]+\]\([^)\s]+\))/g, '<span class="tok-link">$1</span>');
    out = out.replace(/(\*\*[^*]+\*\*)/g, '<span class="tok-bold">$1</span>');
    out = out.replace(/(__[^_]+__)/g, '<span class="tok-bold">$1</span>');
    out = out.replace(/(\*[^*]+\*)/g, '<span class="tok-italic">$1</span>');
    out = out.replace(/(?<!_)(_[^_]+_)(?!_)/g, '<span class="tok-italic">$1</span>');
    out = out.replace(/(~~[^~]+~~)/g, '<span class="tok-strike">$1</span>');
    return out;
  }

  function highlightMarkdown(src) {
    let inFence = false;

    const lines = src.split("\n").map((line) => {
      if (/^\s*```/.test(line)) {
        inFence = !inFence;
        return `<span class="tok-fence">${escapeHtml(line)}</span>`;
      }
      if (inFence) {
        return `<span class="tok-code-line">${escapeHtml(line)}</span>`;
      }
      if (/^\s*(---|\*\*\*|___)\s*$/.test(line)) {
        return `<span class="tok-hr">${escapeHtml(line)}</span>`;
      }

      const heading = line.match(/^(#{1,6}\s+)(.*)$/);
      if (heading) {
        return `<span class="tok-heading">${escapeHtml(heading[1])}${highlightInline(heading[2])}</span>`;
      }

      const quote = line.match(/^(\s*>\s?)(.*)$/);
      if (quote) {
        return `<span class="tok-quote-marker">${escapeHtml(quote[1])}</span>` +
               `<span class="tok-quote">${highlightInline(quote[2])}</span>`;
      }

      const task = line.match(/^(\s*[-*+]\s+)(\[[ xX]\])(\s*)(.*)$/);
      if (task) {
        const checked = /[xX]/.test(task[2]);
        return `<span class="tok-list-marker">${escapeHtml(task[1])}</span>` +
               `<span class="${checked ? "tok-task-checked" : "tok-task-unchecked"}">${escapeHtml(task[2])}</span>` +
               `${escapeHtml(task[3])}${highlightInline(task[4])}`;
      }

      const ul = line.match(/^(\s*[-*+]\s+)(.*)$/);
      if (ul) {
        return `<span class="tok-list-marker">${escapeHtml(ul[1])}</span>${highlightInline(ul[2])}`;
      }

      const ol = line.match(/^(\s*\d+\.\s+)(.*)$/);
      if (ol) {
        return `<span class="tok-list-marker">${escapeHtml(ol[1])}</span>${highlightInline(ol[2])}`;
      }

      return highlightInline(line);
    });

    return lines.join("\n");
  }

  function updateHighlight() {
    el.editorHighlight.innerHTML = highlightMarkdown(el.editor.value);
  }

  function inline(text) {
    let out = escapeHtml(text);
    out = out.replace(/`([^`]+)`/g, "<code>$1</code>");
    out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, '<img alt="$1" src="$2">');
    out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    out = out.replace(/__([^_]+)__/g, "<strong>$1</strong>");
    out = out.replace(/\*([^*]+)\*/g, "<em>$1</em>");
    out = out.replace(/(?<!_)_([^_]+)_(?!_)/g, "<em>$1</em>");
    out = out.replace(/~~([^~]+)~~/g, "<del>$1</del>");
    return out;
  }

  function markdownToHtml(src) {
    const lines = src.replace(/\r\n/g, "\n").split("\n");
    const html = [];
    let i = 0;
    let listStack = []; // stack of 'ul' | 'ol'

    const closeLists = () => {
      while (listStack.length) html.push(`</${listStack.pop()}>`);
    };

    while (i < lines.length) {
      const line = lines[i];

      // fenced code block
      if (/^```/.test(line)) {
        const lang = line.slice(3).trim();
        const buf = [];
        i++;
        while (i < lines.length && !/^```/.test(lines[i])) { buf.push(lines[i]); i++; }
        i++; // skip closing fence
        closeLists();
        const langAttr = lang ? ` data-lang="${escapeHtml(lang)}" class="language-${escapeHtml(lang)}"` : "";
        html.push(`<pre><code${langAttr}>${escapeHtml(buf.join("\n"))}</code></pre>`);
        continue;
      }

      // horizontal rule
      if (/^\s*(---|\*\*\*|___)\s*$/.test(line)) {
        closeLists();
        html.push("<hr>");
        i++; continue;
      }

      // headings
      const heading = line.match(/^(#{1,6})\s+(.*)$/);
      if (heading) {
        closeLists();
        const level = heading[1].length;
        html.push(`<h${level}>${inline(heading[2].trim())}</h${level}>`);
        i++; continue;
      }

      // blockquote
      if (/^\s*>\s?/.test(line)) {
        closeLists();
        const buf = [];
        while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
          buf.push(lines[i].replace(/^\s*>\s?/, "")); i++;
        }
        html.push(`<blockquote>${markdownToHtml(buf.join("\n"))}</blockquote>`);
        continue;
      }

      // unordered list
      if (/^\s*[-*+]\s+/.test(line)) {
        if (listStack[listStack.length - 1] !== "ul") { closeLists(); html.push("<ul>"); listStack.push("ul"); }
        html.push(`<li>${inline(line.replace(/^\s*[-*+]\s+/, ""))}</li>`);
        i++; continue;
      }

      // ordered list
      if (/^\s*\d+\.\s+/.test(line)) {
        if (listStack[listStack.length - 1] !== "ol") { closeLists(); html.push("<ol>"); listStack.push("ol"); }
        html.push(`<li>${inline(line.replace(/^\s*\d+\.\s+/, ""))}</li>`);
        i++; continue;
      }

      // table (header + separator row)
      if (/^\s*\|.*\|\s*$/.test(line) && lines[i + 1] && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1])) {
        closeLists();
        const headCells = line.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
        i += 2;
        const rows = [];
        while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
          rows.push(lines[i].trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim()));
          i++;
        }
        html.push("<table><thead><tr>" +
          headCells.map((c) => `<th>${inline(c)}</th>`).join("") + "</tr></thead><tbody>" +
          rows.map((r) => "<tr>" + r.map((c) => `<td>${inline(c)}</td>`).join("") + "</tr>").join("") +
          "</tbody></table>");
        continue;
      }

      // blank line
      if (/^\s*$/.test(line)) { closeLists(); i++; continue; }

      // paragraph (gather contiguous non-blank plain lines)
      closeLists();
      const buf = [line];
      i++;
      while (i < lines.length && !/^\s*$/.test(lines[i]) &&
             !/^(#{1,6})\s+/.test(lines[i]) && !/^\s*[-*+]\s+/.test(lines[i]) &&
             !/^\s*\d+\.\s+/.test(lines[i]) && !/^\s*>\s?/.test(lines[i]) &&
             !/^```/.test(lines[i]) && !/^\s*(---|\*\*\*|___)\s*$/.test(lines[i])) {
        buf.push(lines[i]); i++;
      }
      html.push(`<p>${inline(buf.join(" "))}</p>`);
    }

    closeLists();
    return html.join("\n");
  }

  // ---------- Toast ----------

  function showToast(message, duration = 2600) {
    clearTimeout(state.toastTimer);
    el.toast.textContent = message;
    el.toast.hidden = false;
    state.toastTimer = setTimeout(() => { el.toast.hidden = true; }, duration);
  }

  // ---------- Sidebar resize & collapse ----------
  // Purely a UI preference, so it's kept in localStorage rather than
  // alongside the folder handle in IndexedDB.

  const SIDEBAR_WIDTH_KEY = "ftnMDReader:sidebarWidth";
  const SIDEBAR_HIDDEN_KEY = "ftnMDReader:sidebarHidden";

  function restoreSidebarPrefs() {
    try {
      const savedWidth = localStorage.getItem(SIDEBAR_WIDTH_KEY);
      if (savedWidth) el.sidebar.style.width = savedWidth;

      const savedHidden = localStorage.getItem(SIDEBAR_HIDDEN_KEY);
      if (savedHidden === "1") el.workspace.classList.add("sidebar-hidden");
    } catch {
      // localStorage unavailable (e.g. private browsing) — fall back to defaults
    }
  }

  function initSidebarResizer() {
    let dragging = false;

    el.sidebarResizer.addEventListener("mousedown", (e) => {
      dragging = true;
      el.sidebarResizer.classList.add("active");
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      e.preventDefault();
    });

    window.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      const rect = el.workspace.getBoundingClientRect();
      const min = 160;
      const max = Math.round(rect.width * 0.7);
      const width = Math.min(max, Math.max(min, e.clientX - rect.left));
      el.sidebar.style.width = width + "px";
    });

    window.addEventListener("mouseup", () => {
      if (!dragging) return;
      dragging = false;
      el.sidebarResizer.classList.remove("active");
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      try { localStorage.setItem(SIDEBAR_WIDTH_KEY, el.sidebar.style.width); } catch {}
    });
  }

  function toggleSidebar() {
    el.workspace.classList.toggle("sidebar-hidden");
    try {
      localStorage.setItem(
        SIDEBAR_HIDDEN_KEY,
        el.workspace.classList.contains("sidebar-hidden") ? "1" : "0"
      );
    } catch {}
  }

  // ---------- Split view resize ----------
  // The editor pane gets an explicit flex-basis (as a percentage of the
  // doc body's width) so it scales sensibly if the window is resized too.

  const SPLIT_WIDTH_KEY = "ftnMDReader:splitEditorWidth";

  function restoreSplitPref() {
    try {
      const saved = parseFloat(localStorage.getItem(SPLIT_WIDTH_KEY));
      if (saved && saved > 0) state.splitPct = saved;
    } catch {
      // localStorage unavailable — fall back to the default 50/50 split
    }
  }

  function initDocResizer() {
    let dragging = false;

    el.docResizer.addEventListener("mousedown", (e) => {
      if (state.view !== "split") return;
      dragging = true;
      el.docResizer.classList.add("active");
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      e.preventDefault();
    });

    window.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      const rect = el.docBody.getBoundingClientRect();
      const pct = ((e.clientX - rect.left) / rect.width) * 100;
      state.splitPct = Math.min(80, Math.max(20, pct));
      el.editorWrap.style.flex = `0 0 ${state.splitPct}%`;
    });

    window.addEventListener("mouseup", () => {
      if (!dragging) return;
      dragging = false;
      el.docResizer.classList.remove("active");
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      try { localStorage.setItem(SPLIT_WIDTH_KEY, String(state.splitPct)); } catch {}
    });
  }

  // ---------- Wiring ----------

  el.openFolderBtn.addEventListener("click", openFolder);
  el.emptyOpenBtn.addEventListener("click", openFolder);
  el.newFileBtn.addEventListener("click", () => openNewFileDialog());
  el.cancelNewFile.addEventListener("click", () => el.newFileDialog.close());

  el.newFileForm.addEventListener("submit", (e) => {
    e.preventDefault();
    el.newFileDialog.close();
    createNewFile(el.newFileName.value);
  });

  el.newFolderBtn.addEventListener("click", () => openNewFolderDialog());
  el.cancelNewFolder.addEventListener("click", () => el.newFolderDialog.close());

  el.newFolderForm.addEventListener("submit", (e) => {
    e.preventDefault();
    el.newFolderDialog.close();
    createNewFolder(el.newFolderName.value);
  });

  el.cancelMoveFile.addEventListener("click", () => el.moveFileDialog.close());
  el.moveFileForm.addEventListener("submit", (e) => {
    e.preventDefault();
    el.moveFileDialog.close();
    if (state.moveTargetFile) moveFile(state.moveTargetFile, el.moveFileTarget.value);
    state.moveTargetFile = null;
  });

  el.cancelRename.addEventListener("click", () => el.renameDialog.close());
  el.renameForm.addEventListener("submit", (e) => {
    e.preventDefault();
    el.renameDialog.close();
    if (state.renameTarget) renameEntry(state.renameTarget.path, state.renameTarget.kind, el.renameInput.value);
    state.renameTarget = null;
  });

  el.renameCurrentBtn.addEventListener("click", () => {
    if (state.currentPath) openRenameDialog(state.currentPath, "file");
  });

  el.revealBtn.addEventListener("click", () => {
    if (state.currentPath) revealInSidebar(state.currentPath);
  });

  // Dropping a file on the "Files" header moves it back to the root.
  el.sidebarHead.addEventListener("dragover", (e) => {
    if (!state.draggingPath) return;
    e.preventDefault();
    el.sidebarHead.classList.add("drop-target");
  });
  el.sidebarHead.addEventListener("dragleave", () => el.sidebarHead.classList.remove("drop-target"));
  el.sidebarHead.addEventListener("drop", (e) => {
    e.preventDefault();
    el.sidebarHead.classList.remove("drop-target");
    const draggedPath = e.dataTransfer.getData("text/plain") || state.draggingPath;
    if (draggedPath) moveFile(draggedPath, "");
  });

  el.saveBtn.addEventListener("click", saveCurrentFile);

  el.searchInput.addEventListener("input", () => {
    state.query = el.searchInput.value;
    handleSearchInput();
  });

  el.searchClear.addEventListener("click", () => {
    el.searchInput.value = "";
    state.query = "";
    state.contentMatches.clear();
    el.searchClear.hidden = true;
    renderFileList();
    el.searchInput.focus();
  });

  el.searchContentToggle.addEventListener("change", () => {
    state.searchContent = el.searchContentToggle.checked;
    if (state.searchContent && state.query.trim().length >= 2) {
      runContentSearch(state.query.trim());
    } else {
      state.contentMatches.clear();
      renderFileList();
    }
  });

  el.toggleSidebarBtn.addEventListener("click", toggleSidebar);
  initSidebarResizer();
  restoreSidebarPrefs();
  initDocResizer();
  restoreSplitPref();

  el.editor.addEventListener("input", () => {
    updateDirtyState();
    updateHighlight();
    if (state.view !== "edit") renderPreview();
  });

  el.editor.addEventListener("scroll", () => {
    el.editorHighlight.scrollTop = el.editor.scrollTop;
    el.editorHighlight.scrollLeft = el.editor.scrollLeft;
  });

  el.tabEdit.addEventListener("click", () => setView("edit"));
  el.tabPreview.addEventListener("click", () => setView("preview"));
  el.tabSplit.addEventListener("click", () => setView("split"));

  el.toolbar.addEventListener("click", (e) => {
    const btn = e.target.closest(".toolbar-btn");
    if (btn) applyFormatting(btn.dataset.action);
  });

  document.addEventListener("keydown", (e) => {
    const cmdOrCtrl = e.metaKey || e.ctrlKey;
    if (cmdOrCtrl && e.key.toLowerCase() === "s") {
      e.preventDefault();
      saveCurrentFile();
    }
    if (cmdOrCtrl && e.key.toLowerCase() === "f" && !el.workspace.classList.contains("sidebar-hidden")) {
      e.preventDefault();
      el.searchInput.focus();
      el.searchInput.select();
    }
    if (document.activeElement === el.editor && cmdOrCtrl && e.key.toLowerCase() === "b") {
      e.preventDefault();
      applyFormatting("bold");
    }
    if (document.activeElement === el.editor && cmdOrCtrl && e.key.toLowerCase() === "i") {
      e.preventDefault();
      applyFormatting("italic");
    }
  });

  window.addEventListener("beforeunload", (e) => {
    if (state.dirty) { e.preventDefault(); e.returnValue = ""; }
  });

  setView("edit");
  el.appVersion.textContent = `v${APP_VERSION}`;

  if ("showDirectoryPicker" in window) {
    restoreLastFolder();
  }
})();
