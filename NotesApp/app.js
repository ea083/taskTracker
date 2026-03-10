/* ── Notes App (GitHub backend) ─────────────────────────────
   Each note = one .md file in a GitHub repo (nested folders supported).
   Title = filename without .md  (Obsidian-compatible).
   Requires github.js to be loaded first.
──────────────────────────────────────────────────────────── */

/* ── State ─────────────────────────────────────────────────── */
let notes         = [];     // [{ path, title, sha, updatedAt }]
let activeId      = null;   // current note path (e.g. "folder/My Note.md")
let mode          = 'edit'; // 'edit' | 'split' | 'preview'
let saveTimer     = null;
let isSaving      = false;
let operationLock = false;  // true during rename / delete / move
let pendingTitle  = false;  // title input changed but not yet committed

/* ── Folder state ───────────────────────────────────────────── */
let knownFolders    = new Set(); // folders from GitHub (.gitkeep) + this session
let expandedFolders = new Set(); // folders open in sidebar
let currentFolder   = '';        // folder where new notes/folders are created
let modalMode       = 'rename';  // 'rename' | 'folder'

/* ── Context menu state ─────────────────────────────────────── */
let ctxTarget       = null;   // { type: 'note'|'folder', path }
let ctxRenamePath   = null;   // path being renamed via context menu

/* ── Drag-and-drop state ────────────────────────────────────── */
let dragItem        = null;   // { type: 'note'|'folder', path, depth }
let dropInfo        = null;   // { folder: string, depth: number, insertBefore: Element|null }

/* ── DOM refs ──────────────────────────────────────────────── */
const $sidebar        = document.getElementById('sidebar');
const $noteList       = document.getElementById('note-list');
const $search         = document.getElementById('search');
const $btnNew         = document.getElementById('btn-new');
const $btnNewEmpty    = document.getElementById('btn-new-empty');
const $btnNewFolder   = document.getElementById('btn-new-folder');
const $btnToggle      = document.getElementById('btn-toggle-sidebar');
const $btnModeEdit    = document.getElementById('btn-mode-edit');
const $btnModeSplit   = document.getElementById('btn-mode-split');
const $btnModePreview = document.getElementById('btn-mode-preview');
const $divider        = document.getElementById('divider');
const $btnRename      = document.getElementById('btn-rename');
const $btnMove        = document.getElementById('btn-move');
const $btnDelete      = document.getElementById('btn-delete');
const $btnSettings    = document.getElementById('btn-settings');
const $editor         = document.getElementById('editor');
const $editorPane     = document.getElementById('editor-pane');
const $noteTitleInput = document.getElementById('note-title-input');
const $preview        = document.getElementById('preview');
const $editorWrap     = document.getElementById('editor-wrap');
const $emptyState     = document.getElementById('empty-state');
const $titleDisplay   = document.getElementById('note-title-display');
const $statusText     = document.getElementById('status-text');
/* Settings modal */
const $settingsOverlay = document.getElementById('settings-overlay');
const $cfgToken        = document.getElementById('cfg-token');
const $cfgOwner        = document.getElementById('cfg-owner');
const $cfgRepo         = document.getElementById('cfg-repo');
const $cfgFolder       = document.getElementById('cfg-folder');
const $cfgTest         = document.getElementById('cfg-test');
const $cfgSave         = document.getElementById('cfg-save');
const $cfgCancel       = document.getElementById('cfg-cancel');
const $cfgStatus       = document.getElementById('cfg-status');
/* Note modal (rename + new folder) */
const $modalOverlay = document.getElementById('modal-overlay');
const $modalLabel   = document.getElementById('modal-label');
const $modalInput   = document.getElementById('modal-input');
const $modalCancel  = document.getElementById('modal-cancel');
const $modalConfirm = document.getElementById('modal-confirm');
/* Move modal */
const $moveOverlay  = document.getElementById('move-overlay');
const $moveNoteName = document.getElementById('move-note-name');
const $moveSelect   = document.getElementById('move-select');
const $moveCancel   = document.getElementById('move-cancel');
const $moveConfirm  = document.getElementById('move-confirm');
/* Context menu + drop bar */
const $ctxMenu      = document.getElementById('ctx-menu');
const $dropBar      = document.getElementById('drop-bar');

/* ── Status bar ────────────────────────────────────────────── */
let statusTimer = null;
function setStatus(msg, isError = false, persist = false) {
  $statusText.textContent = msg;
  $statusText.className   = isError ? 'error' : '';
  clearTimeout(statusTimer);
  if (!persist && msg) {
    statusTimer = setTimeout(() => {
      $statusText.textContent = '';
      $statusText.className   = '';
    }, 3000);
  }
}

/* ── Filename / folder helpers ──────────────────────────────── */
function sanitizeFilename(title) {
  return (title || 'Untitled note')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200) || 'Untitled note';
}

function sanitizeFolderName(name) {
  return (name || 'New Folder')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100) || 'New Folder';
}

/* Parent folder of a note path, e.g. "a/b/c.md" → "a/b", "c.md" → "" */
function noteFolder(path) {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
}

/* Unique filename within a specific folder */
function uniqueFilename(title, folder = '') {
  const base = sanitizeFilename(title);
  let fn     = `${base}.md`;
  let i      = 1;
  while (notes.some(n => {
    return noteFolder(n.path) === folder && n.path.split('/').pop() === fn;
  })) fn = `${base} ${i++}.md`;
  return fn;
}

/* All known folder paths (from GitHub + derived from note paths + this session) */
function allFolderPaths() {
  const set = new Set(knownFolders);
  for (const note of notes) {
    const parts = note.path.split('/');
    for (let i = 1; i < parts.length; i++) {
      set.add(parts.slice(0, i).join('/'));
    }
  }
  return set;
}

/* ── Date formatter ─────────────────────────────────────────── */
function formatDate(iso) {
  if (!iso) return '';
  const d       = new Date(iso);
  const diffMin = Math.floor((Date.now() - d) / 60000);
  if (diffMin < 1)  return 'Just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH  < 24)  return `${diffH}h ago`;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

/* ── Folder state persistence ───────────────────────────────── */
function saveExpandedState() {
  localStorage.setItem('gh_expanded',       JSON.stringify([...expandedFolders]));
  localStorage.setItem('gh_current_folder', currentFolder);
}

function loadExpandedState() {
  try {
    const exp = localStorage.getItem('gh_expanded');
    if (exp) expandedFolders = new Set(JSON.parse(exp));
    currentFolder = localStorage.getItem('gh_current_folder') || '';
  } catch { /* ignore */ }
}

/* ── Sidebar tree rendering ─────────────────────────────────── */
function renderList(filterText = '') {
  const q = filterText.trim().toLowerCase();
  $noteList.innerHTML = '';

  if (q) {
    /* Flat filtered list — show folder path as context */
    const filtered = notes
      .filter(n => n.title.toLowerCase().includes(q))
      .sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
    filtered.forEach(n => appendNoteItem(n, 0, true));
    return;
  }

  const folders = allFolderPaths();
  renderLevel('', 0, folders);
}

function renderLevel(parentPath, depth, folders) {
  const prefix = parentPath ? parentPath + '/' : '';

  /* Child folders at this exact level (no further nesting) */
  const childFolders = [...folders]
    .filter(f => f.startsWith(prefix) && !f.slice(prefix.length).includes('/'))
    .sort();

  /* Notes directly inside this folder */
  const childNotes = notes
    .filter(n => noteFolder(n.path) === parentPath)
    .sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));

  childFolders.forEach(fp => {
    appendFolderItem(fp, depth);
    if (expandedFolders.has(fp)) renderLevel(fp, depth + 1, folders);
  });
  childNotes.forEach(n => appendNoteItem(n, depth, false));
}

function addTreeGuides(li, depth) {
  for (let d = 0; d < depth; d++) {
    const guide = document.createElement('span');
    guide.className    = 'tree-guide';
    guide.style.left   = `${15 + d * 14}px`;
    li.appendChild(guide);
  }
}

function appendFolderItem(folderPath, depth) {
  const name       = folderPath.split('/').pop();
  const isExpanded = expandedFolders.has(folderPath);
  const isActive   = currentFolder === folderPath;

  const li = document.createElement('li');
  li.className         = 'folder-item' + (isActive ? ' active-folder' : '');
  li.style.paddingLeft = `${10 + depth * 14}px`;
  li.dataset.path      = folderPath;
  li.dataset.depth     = String(depth);
  li.dataset.type      = 'folder';
  li.draggable         = true;

  addTreeGuides(li, depth);

  const arrow = document.createElement('span');
  arrow.className   = 'folder-arrow';
  arrow.textContent = isExpanded ? '▾' : '▸';

  const icon = document.createElement('span');
  icon.className   = 'folder-icon';
  icon.textContent = '📁';

  const nameEl = document.createElement('span');
  nameEl.className   = 'folder-name';
  nameEl.textContent = name;

  li.append(arrow, icon, nameEl);
  li.addEventListener('click', () => toggleFolder(folderPath));
  li.addEventListener('contextmenu', e => showCtxMenu(e, { type: 'folder', path: folderPath }));
  li.addEventListener('dragstart', e => {
    dragItem = { type: 'folder', path: folderPath, depth };
    li.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', folderPath);
  });
  $noteList.appendChild(li);
}

function appendNoteItem(note, depth, showFolderHint) {
  const li = document.createElement('li');
  li.dataset.id     = note.path;
  li.dataset.folder = noteFolder(note.path);
  li.dataset.depth  = String(depth);
  li.dataset.type   = 'note';
  li.draggable      = true;
  li.style.paddingLeft = `${10 + depth * 14}px`;
  if (note.path === activeId) li.classList.add('active');

  addTreeGuides(li, depth);

  const titleSpan       = document.createElement('span');
  titleSpan.textContent = note.title;

  const dateSpan     = document.createElement('span');
  dateSpan.className = 'note-date';
  const folderHint   = showFolderHint && noteFolder(note.path)
    ? noteFolder(note.path) + '  ·  ' : '';
  dateSpan.textContent = folderHint + formatDate(note.updatedAt);

  li.append(titleSpan, dateSpan);
  li.addEventListener('click', () => openNote(note.path));
  li.addEventListener('contextmenu', e => showCtxMenu(e, { type: 'note', path: note.path }));
  li.addEventListener('dragstart', e => {
    dragItem = { type: 'note', path: note.path, depth };
    li.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', note.path);
  });
  $noteList.appendChild(li);
}

function toggleFolder(folderPath) {
  if (expandedFolders.has(folderPath)) {
    expandedFolders.delete(folderPath);
  } else {
    expandedFolders.add(folderPath);
  }
  currentFolder = folderPath;
  saveExpandedState();
  renderList($search.value);
}

/* ── Editor visibility ──────────────────────────────────────── */
function setEditorVisible(visible) {
  if (visible) {
    $editorWrap.classList.remove('hidden');
    $emptyState.classList.add('hidden');
  } else {
    $editorWrap.classList.add('hidden');
    $emptyState.classList.remove('hidden');
    $titleDisplay.textContent = '';
  }
}

/* ── Open a note ────────────────────────────────────────────── */
async function openNote(path) {
  if (operationLock) return;
  activeId = path;
  const note = notes.find(n => n.path === path);
  if (!note) return;

  $noteTitleInput.value     = note.title;
  $titleDisplay.textContent = note.title;
  $editor.value             = '';
  setEditorVisible(true);
  renderList($search.value);
  setStatus('Loading…', false, true);

  try {
    const { content, sha } = await GH.getFile(path);
    note.sha      = sha;
    $editor.value = content;
    if (mode !== 'edit') updatePreview();
    localStorage.setItem('gh_last_open', path);
    setStatus('');
  } catch (err) {
    setStatus(`Failed to load: ${err.message}`, true);
  }
}

/* ── Create a note ──────────────────────────────────────────── */
async function createNote() {
  if (operationLock) return;
  operationLock = true;

  const folder   = currentFolder;
  const filename = uniqueFilename('Untitled note', folder);
  const path     = folder ? `${folder}/${filename}` : filename;
  const title    = filename.slice(0, -3);
  setStatus('Creating note…', false, true);

  try {
    const { sha } = await GH.writeFile(path, '', null, `Create ${title}`);
    const now      = new Date().toISOString();
    GH.setDate(path, now);
    notes.unshift({ path, title, sha, updatedAt: now });
    if (folder) expandedFolders.add(folder);
    renderList($search.value);
    operationLock = false;
    await openNote(path);
    $noteTitleInput.focus();
    $noteTitleInput.select();
    setStatus('');
  } catch (err) {
    operationLock = false;
    setStatus(`Failed to create: ${err.message}`, true);
  }
}

/* ── Create a folder ────────────────────────────────────────── */
async function createFolder(name) {
  const clean = sanitizeFolderName(name);
  if (!clean) return;

  const folderPath = currentFolder ? `${currentFolder}/${clean}` : clean;

  if (allFolderPaths().has(folderPath)) {
    /* Already exists — just navigate to it */
    currentFolder = folderPath;
    expandedFolders.add(folderPath);
    saveExpandedState();
    renderList($search.value);
    return;
  }

  setStatus('Creating folder…', false, true);
  try {
    /* GitHub removes empty directories, so write a .gitkeep to anchor the folder */
    await GH.writeFile(`${folderPath}/.gitkeep`, '', null, `Create folder ${clean}`);
    knownFolders.add(folderPath);
    expandedFolders.add(folderPath);
    currentFolder = folderPath;
    saveExpandedState();
    renderList($search.value);
    setStatus('Folder created');
  } catch (err) {
    setStatus(`Failed to create folder: ${err.message}`, true);
  }
}

/* ── Delete a note ──────────────────────────────────────────── */
async function deleteNote() {
  if (!activeId || operationLock) return;
  const note = notes.find(n => n.path === activeId);
  if (!note) return;
  if (!confirm(`Delete "${note.title}"? This cannot be undone.`)) return;

  operationLock = true;
  clearTimeout(saveTimer);
  setStatus('Deleting…', false, true);

  try {
    await GH.deleteFile(note.path, note.sha, `Delete ${note.title}`);
    GH.removeDate(note.path);
    notes.splice(notes.findIndex(n => n.path === note.path), 1);

    if (notes.length > 0) {
      const sorted = [...notes].sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
      operationLock = false;
      await openNote(sorted[0].path);
    } else {
      activeId = null;
      setEditorVisible(false);
      operationLock = false;
    }
    renderList($search.value);
    setStatus('Deleted');
  } catch (err) {
    operationLock = false;
    setStatus(`Failed to delete: ${err.message}`, true);
  }
}

/* ── Save (debounced) ───────────────────────────────────────── */
function onEditorInput() {
  if (!activeId) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(performSave, 1500);
  if (mode !== 'edit') updatePreview();
}

async function performSave() {
  if (!activeId || isSaving || operationLock) return;
  const note = notes.find(n => n.path === activeId);
  if (!note) return;

  isSaving = true;
  setStatus('Saving…', false, true);
  try {
    const { sha } = await GH.writeFile(
      note.path, $editor.value, note.sha, `Update ${note.title}`);
    note.sha       = sha;
    note.updatedAt = new Date().toISOString();
    GH.setDate(note.path, note.updatedAt);
    renderList($search.value);
    setStatus('Saved ✓');
  } catch (err) {
    setStatus(`Save failed: ${err.message}`, true);
  } finally {
    isSaving = false;
  }
}

/* ── Rename (title input blur/Enter) ───────────────────────── */
async function commitTitleChange() {
  if (!pendingTitle || !activeId || operationLock) return;
  pendingTitle = false;

  const note = notes.find(n => n.path === activeId);
  if (!note) return;

  const newTitle = ($noteTitleInput.value || '').trim() || 'Untitled note';
  if (newTitle === note.title) return;

  clearTimeout(saveTimer);
  operationLock = true;
  setStatus('Renaming…', false, true);

  try {
    const folder         = noteFolder(note.path);
    const newFilename    = uniqueFilename(newTitle, folder);
    const newPath        = folder ? `${folder}/${newFilename}` : newFilename;
    const currentContent = $editor.value;

    /* GitHub has no rename — create new file, delete old */
    const { sha: newSha } = await GH.writeFile(
      newPath, currentContent, null, `Rename: ${note.title} → ${newTitle}`);
    await GH.deleteFile(note.path, note.sha, `Rename: ${note.title} → ${newTitle}`);

    GH.removeDate(note.path);
    const now      = new Date().toISOString();
    note.path      = newPath;
    note.title     = newTitle;
    note.sha       = newSha;
    note.updatedAt = now;
    GH.setDate(newPath, now);

    activeId = newPath;
    localStorage.setItem('gh_last_open', newPath);
    $titleDisplay.textContent = newTitle;
    renderList($search.value);
    setStatus('Renamed ✓');
  } catch (err) {
    const n = notes.find(n => n.path === activeId);
    if (n) $noteTitleInput.value = n.title;
    setStatus(`Rename failed: ${err.message}`, true);
  } finally {
    operationLock = false;
  }
}

/* ── Move note to another folder ────────────────────────────── */
function openMoveModal() {
  if (!activeId) return;
  const note = notes.find(n => n.path === activeId);
  if (!note) return;

  $moveNoteName.textContent = note.title;

  /* Populate folder list */
  $moveSelect.innerHTML = '<option value="">(root)</option>';
  const curFolder = noteFolder(note.path);
  [...allFolderPaths()].sort().forEach(f => {
    const opt       = document.createElement('option');
    opt.value       = f;
    opt.textContent = f;
    if (f === curFolder) opt.selected = true;
    $moveSelect.appendChild(opt);
  });
  if (!curFolder) $moveSelect.value = '';

  $moveOverlay.classList.remove('hidden');
}

function closeMoveModal() { $moveOverlay.classList.add('hidden'); }

async function confirmMove() {
  const note = notes.find(n => n.path === activeId);
  if (!note) { closeMoveModal(); return; }

  const targetFolder = $moveSelect.value;
  const curFolder    = noteFolder(note.path);
  if (targetFolder === curFolder) { closeMoveModal(); return; }

  closeMoveModal();
  operationLock = true;
  clearTimeout(saveTimer);
  setStatus('Moving…', false, true);

  try {
    const baseName = note.path.split('/').pop();
    let newPath    = targetFolder ? `${targetFolder}/${baseName}` : baseName;

    /* Resolve name collisions in target folder */
    let counter = 1;
    while (notes.some(n => n.path !== note.path && n.path === newPath)) {
      const stem = baseName.slice(0, -3);
      newPath    = targetFolder ? `${targetFolder}/${stem} ${counter++}.md` : `${stem} ${counter++}.md`;
    }

    const content = $editor.value;
    const { sha: newSha } = await GH.writeFile(newPath, content, null, `Move ${note.title}`);
    await GH.deleteFile(note.path, note.sha, `Move ${note.title}`);

    GH.removeDate(note.path);
    const now      = new Date().toISOString();
    note.path      = newPath;
    note.sha       = newSha;
    note.updatedAt = now;
    GH.setDate(newPath, now);

    activeId = newPath;
    localStorage.setItem('gh_last_open', newPath);
    if (targetFolder) expandedFolders.add(targetFolder);
    renderList($search.value);
    setStatus('Moved ✓');
  } catch (err) {
    setStatus(`Move failed: ${err.message}`, true);
  } finally {
    operationLock = false;
  }
}

/* ── Context menu ───────────────────────────────────────────── */
function hideCtxMenu() {
  $ctxMenu.classList.add('hidden');
  $ctxMenu.innerHTML = '';
  ctxTarget = null;
}

function addCtxItem(label, isDanger, fn) {
  const el = document.createElement('div');
  el.className   = 'ctx-item' + (isDanger ? ' danger' : '');
  el.textContent = label;
  el.addEventListener('mousedown', e => { e.preventDefault(); });
  el.addEventListener('click', () => { hideCtxMenu(); fn(); });
  $ctxMenu.appendChild(el);
}

function addCtxSep() {
  const el = document.createElement('div');
  el.className = 'ctx-sep';
  $ctxMenu.appendChild(el);
}

function showCtxMenu(e, target) {
  e.preventDefault();
  e.stopPropagation();
  ctxTarget = target;
  $ctxMenu.innerHTML = '';

  if (target.type === 'folder') {
    addCtxItem('New note here', false, () => {
      currentFolder = target.path;
      expandedFolders.add(target.path);
      saveExpandedState();
      createNote();
    });
    addCtxItem('New subfolder', false, () => {
      currentFolder = target.path;
      saveExpandedState();
      openCreateFolderModal();
    });
    addCtxSep();
    addCtxItem('Rename folder', false, () => {
      ctxRenamePath = target.path;
      modalMode     = 'rename-folder';
      $modalLabel.textContent = 'Rename folder';
      $modalInput.value       = target.path.split('/').pop();
      $modalOverlay.classList.remove('hidden');
      $modalInput.select();
      $modalInput.focus();
    });
    addCtxSep();
    addCtxItem('Delete folder', true, () => deleteFolder(target.path));
  } else {
    addCtxItem('Rename note', false, () => {
      ctxRenamePath = target.path;
      const note    = notes.find(n => n.path === target.path);
      if (!note) return;
      modalMode               = 'rename-note-ctx';
      $modalLabel.textContent = 'Rename note';
      $modalInput.value       = note.title;
      $modalOverlay.classList.remove('hidden');
      $modalInput.select();
      $modalInput.focus();
    });
    addCtxItem('Move to…', false, () => openMoveModalForPath(target.path));
    addCtxSep();
    addCtxItem('Delete note', true, () => deleteNoteByPath(target.path));
  }

  /* Position */
  $ctxMenu.classList.remove('hidden');
  const vw = window.innerWidth, vh = window.innerHeight;
  const mw = $ctxMenu.offsetWidth, mh = $ctxMenu.offsetHeight;
  let x = e.clientX, y = e.clientY;
  if (x + mw > vw) x = vw - mw - 4;
  if (y + mh > vh) y = vh - mh - 4;
  $ctxMenu.style.left = x + 'px';
  $ctxMenu.style.top  = y + 'px';
}

/* ── Delete / rename helpers for context menu ───────────────── */
async function deleteNoteByPath(path) {
  const note = notes.find(n => n.path === path);
  if (!note) return;
  if (!confirm(`Delete "${note.title}"? This cannot be undone.`)) return;

  operationLock = true;
  clearTimeout(saveTimer);
  setStatus('Deleting…', false, true);
  try {
    await GH.deleteFile(note.path, note.sha, `Delete ${note.title}`);
    GH.removeDate(note.path);
    notes.splice(notes.findIndex(n => n.path === path), 1);
    if (activeId === path) {
      activeId = null;
      if (notes.length > 0) {
        operationLock = false;
        const sorted = [...notes].sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
        await openNote(sorted[0].path);
      } else {
        setEditorVisible(false);
      }
    }
    renderList($search.value);
    setStatus('Deleted');
  } catch (err) {
    setStatus(`Failed to delete: ${err.message}`, true);
  } finally {
    operationLock = false;
  }
}

async function deleteFolder(folderPath) {
  const childNotes = notes.filter(n => n.path === folderPath || n.path.startsWith(folderPath + '/'));
  const childFolders = [...allFolderPaths()].filter(f => f === folderPath || f.startsWith(folderPath + '/'));
  const noteCount = childNotes.length;
  if (!confirm(`Delete folder "${folderPath.split('/').pop()}"${noteCount ? ` and its ${noteCount} note(s)` : ''}? This cannot be undone.`)) return;

  operationLock = true;
  setStatus('Deleting folder…', false, true);
  try {
    /* Delete .gitkeep files for all child folders */
    for (const fp of childFolders) {
      try { await GH.deleteFile(`${fp}/.gitkeep`, undefined, `Delete folder ${fp}`); } catch { /* may not exist */ }
    }
    /* Delete all notes inside */
    for (const note of childNotes) {
      await GH.deleteFile(note.path, note.sha, `Delete ${note.title}`);
      GH.removeDate(note.path);
    }
    notes = notes.filter(n => !childNotes.includes(n));
    childFolders.forEach(f => { knownFolders.delete(f); expandedFolders.delete(f); });
    if (activeId && (activeId === folderPath || activeId.startsWith(folderPath + '/'))) {
      activeId = null;
      setEditorVisible(false);
    }
    if (currentFolder === folderPath || currentFolder.startsWith(folderPath + '/')) {
      currentFolder = noteFolder(folderPath);
    }
    saveExpandedState();
    renderList($search.value);
    setStatus('Folder deleted');
  } catch (err) {
    setStatus(`Failed to delete folder: ${err.message}`, true);
  } finally {
    operationLock = false;
  }
}

async function renameFolderTo(oldPath, newName) {
  const clean = sanitizeFolderName(newName);
  if (!clean || clean === oldPath.split('/').pop()) return;

  const parentPath = noteFolder(oldPath);
  const newPath    = parentPath ? `${parentPath}/${clean}` : clean;
  if (allFolderPaths().has(newPath)) { setStatus('A folder with that name already exists', true); return; }

  operationLock = true;
  setStatus('Renaming folder…', false, true);
  try {
    const childNotes   = notes.filter(n => n.path.startsWith(oldPath + '/') || n.path === oldPath);
    const childFolders = [...allFolderPaths()].filter(f => f === oldPath || f.startsWith(oldPath + '/'));

    /* Move all notes */
    for (const note of childNotes) {
      const rel     = note.path.slice(oldPath.length);
      const destPath = newPath + rel;
      const { content } = await GH.getFile(note.path);
      const { sha: newSha } = await GH.writeFile(destPath, content, null, `Move ${note.title}`);
      await GH.deleteFile(note.path, note.sha, `Move ${note.title}`);
      GH.removeDate(note.path);
      const now    = new Date().toISOString();
      note.path    = destPath;
      note.sha     = newSha;
      note.updatedAt = now;
      GH.setDate(destPath, now);
      if (activeId === note.path) activeId = destPath;
    }

    /* Update .gitkeep files */
    for (const fp of childFolders) {
      const destFp = newPath + fp.slice(oldPath.length);
      try { await GH.writeFile(`${destFp}/.gitkeep`, '', null, `Rename folder`); } catch {}
      try { await GH.deleteFile(`${fp}/.gitkeep`, undefined, `Rename folder`); } catch {}
      knownFolders.delete(fp);
      knownFolders.add(destFp);
      if (expandedFolders.has(fp)) { expandedFolders.delete(fp); expandedFolders.add(destFp); }
      if (currentFolder === fp) currentFolder = destFp;
    }

    if (activeId && activeId.startsWith(oldPath + '/')) {
      activeId = newPath + activeId.slice(oldPath.length);
      localStorage.setItem('gh_last_open', activeId);
    }
    saveExpandedState();
    renderList($search.value);
    setStatus('Folder renamed ✓');
  } catch (err) {
    setStatus(`Rename failed: ${err.message}`, true);
  } finally {
    operationLock = false;
  }
}

/* ── Move modal for an arbitrary note path ──────────────────── */
function openMoveModalForPath(path) {
  const note = notes.find(n => n.path === path);
  if (!note) return;
  /* Temporarily override activeId for confirmMove */
  const prevActive = activeId;
  activeId = path;
  openMoveModal();
  /* Restore after modal closes handled by closeMoveModal */
  if (prevActive !== path) {
    /* We'll let confirmMove use activeId, which is now path */
  }
}

/* ── Note modal (rename + new folder) ──────────────────────── */
function openRenameModal() {
  if (mode !== 'edit' && mode !== 'split') {
    const note = notes.find(n => n.path === activeId);
    if (!note) return;
    modalMode = 'rename';
    $modalLabel.textContent = 'Rename note';
    $modalInput.value = note.title;
    $modalOverlay.classList.remove('hidden');
    $modalInput.select();
    $modalInput.focus();
  } else {
    $noteTitleInput.focus();
    $noteTitleInput.select();
  }
}

function openCreateFolderModal() {
  modalMode = 'folder';
  $modalLabel.textContent = currentFolder
    ? `New folder inside "${currentFolder.split('/').pop()}"`
    : 'New folder at root';
  $modalInput.value = '';
  $modalOverlay.classList.remove('hidden');
  $modalInput.focus();
}

function closeModal() { $modalOverlay.classList.add('hidden'); }

function confirmModal() {
  const val = $modalInput.value.trim();
  closeModal();
  if (!val) return;
  if (modalMode === 'rename') {
    $noteTitleInput.value = val;
    pendingTitle = true;
    commitTitleChange();
  } else if (modalMode === 'rename-note-ctx') {
    const note = notes.find(n => n.path === ctxRenamePath);
    if (note) {
      const prevActive = activeId;
      activeId = note.path;
      $noteTitleInput.value = val;
      pendingTitle = true;
      commitTitleChange().then(() => {
        if (prevActive && prevActive !== note.path) activeId = prevActive;
      });
    }
    ctxRenamePath = null;
  } else if (modalMode === 'rename-folder') {
    const path = ctxRenamePath;
    ctxRenamePath = null;
    renameFolderTo(path, val);
  } else {
    createFolder(val);
  }
}

/* ── Settings modal ─────────────────────────────────────────── */
function showSettings() {
  const cfg        = GH.getConfig();
  $cfgToken.value  = cfg.token;
  $cfgOwner.value  = cfg.owner;
  $cfgRepo.value   = cfg.repo;
  $cfgFolder.value = cfg.folder;
  $cfgStatus.textContent = '';
  $cfgStatus.className   = '';
  $settingsOverlay.classList.remove('hidden');
  ($cfgToken.value ? $cfgOwner : $cfgToken).focus();
}

function hideSettings() { $settingsOverlay.classList.add('hidden'); }

async function testConnection() {
  const token = $cfgToken.value.trim(), owner = $cfgOwner.value.trim(),
        repo  = $cfgRepo.value.trim(),  folder = $cfgFolder.value.trim();
  if (!token || !owner || !repo) {
    $cfgStatus.textContent = 'Token, owner and repo are required.';
    $cfgStatus.className   = 'error';
    return;
  }
  GH.saveConfig({ token, owner, repo, folder });
  $cfgStatus.textContent = 'Testing connection…';
  $cfgStatus.className   = '';
  try {
    const name = await GH.testConnection();
    $cfgStatus.textContent = `✓ Connected to ${name}`;
    $cfgStatus.className   = 'success';
  } catch (err) {
    $cfgStatus.textContent = `✗ ${err.message}`;
    $cfgStatus.className   = 'error';
  }
}

async function saveSettings() {
  const token = $cfgToken.value.trim(), owner = $cfgOwner.value.trim(),
        repo  = $cfgRepo.value.trim(),  folder = $cfgFolder.value.trim();
  if (!token || !owner || !repo) {
    $cfgStatus.textContent = 'Token, owner and repo are required.';
    $cfgStatus.className   = 'error';
    return;
  }
  GH.saveConfig({ token, owner, repo, folder });
  hideSettings();
  await init();
}

/* ── HTML escape ────────────────────────────────────────────── */
function esc(str) {
  return str
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/* ── Markdown preview ───────────────────────────────────────── */
function updatePreview() {
  const raw   = $editor.value;
  const title = $noteTitleInput.value.trim();
  if (typeof marked !== 'undefined') {
    const titleHtml = title ? `<h1 class="preview-note-title">${esc(title)}</h1>` : '';
    const rawHtml = titleHtml + marked.parse(raw, { breaks: true, gfm: true });
    $preview.innerHTML = typeof DOMPurify !== 'undefined'
      ? DOMPurify.sanitize(rawHtml)
      : rawHtml;
    $preview.querySelectorAll('a[href]').forEach(a => {
      const proto = a.protocol.toLowerCase();
      if (proto === 'javascript:' || proto === 'data:' || proto === 'vbscript:') {
        a.removeAttribute('href');
        return;
      }
      a.target = '_blank';
      a.rel    = 'noopener noreferrer';
    });
    makeCollapsible();
  } else {
    $preview.textContent = raw;
  }
}

/* ── Collapsible headings (syntax: ## > Title) ──────────────── */
function makeCollapsible() {
  const headings = Array.from($preview.querySelectorAll('h1,h2,h3,h4,h5,h6'));
  headings.forEach(heading => {
    const raw = heading.textContent.trim();
    if (!raw.startsWith('> ') && raw !== '>') return;

    heading.textContent = raw.replace(/^>\s*/, '');
    heading.classList.add('collapsible-heading');
    heading.dataset.collapsed = 'false';

    const arrow = document.createElement('span');
    arrow.className = 'collapse-arrow';
    arrow.setAttribute('aria-hidden', 'true');
    heading.prepend(arrow);

    const level     = parseInt(heading.tagName[1], 10);
    const collected = [];
    let sibling     = heading.nextElementSibling;
    while (sibling) {
      const tag = sibling.tagName.toLowerCase();
      if (/^h[1-6]$/.test(tag) && parseInt(tag[1], 10) <= level) break;
      collected.push(sibling);
      sibling = sibling.nextElementSibling;
    }
    if (collected.length === 0) return;

    const wrapper     = document.createElement('div');
    wrapper.className = 'collapsible-content';
    heading.after(wrapper);
    collected.forEach(el => wrapper.appendChild(el));

    heading.addEventListener('click', () => {
      const isCollapsed = heading.dataset.collapsed === 'true';
      heading.dataset.collapsed = isCollapsed ? 'false' : 'true';
      wrapper.classList.toggle('collapsed', !isCollapsed);
    });
  });
}

/* ── Drag-and-drop ──────────────────────────────────────────── */
function hideDropBar() {
  $dropBar.style.display = 'none';
  dropInfo = null;
}

function showDropBar(targetEl, targetDepth) {
  const rect    = targetEl.getBoundingClientRect();
  const listRect = $noteList.getBoundingClientRect();
  const left    = listRect.left + 10 + targetDepth * 14;
  const width   = Math.max(20, listRect.right - left - 6);
  $dropBar.style.display = 'block';
  $dropBar.style.top     = (rect.bottom - 1) + 'px';
  $dropBar.style.left    = left + 'px';
  $dropBar.style.width   = width + 'px';
}

function getItemDepth(li) {
  return parseInt(li.dataset.depth || '0', 10);
}

/* Move a note to a target folder (used by drop) */
async function dropMoveNote(notePath, targetFolder) {
  const note = notes.find(n => n.path === notePath);
  if (!note) return;
  if (noteFolder(note.path) === targetFolder) return;

  operationLock = true;
  clearTimeout(saveTimer);
  setStatus('Moving…', false, true);
  try {
    const baseName = note.path.split('/').pop();
    let newPath    = targetFolder ? `${targetFolder}/${baseName}` : baseName;
    let counter    = 1;
    while (notes.some(n => n.path !== note.path && n.path === newPath)) {
      const stem = baseName.slice(0, -3);
      newPath    = targetFolder ? `${targetFolder}/${stem} ${counter++}.md` : `${stem} ${counter++}.md`;
    }

    /* Use editor content if this is the active note, otherwise fetch */
    let content;
    if (activeId === note.path) {
      content = $editor.value;
    } else {
      const fetched = await GH.getFile(note.path);
      content       = fetched.content;
      note.sha      = fetched.sha;
    }

    const { sha: newSha } = await GH.writeFile(newPath, content, null, `Move ${note.title}`);
    await GH.deleteFile(note.path, note.sha, `Move ${note.title}`);
    GH.removeDate(note.path);
    const now      = new Date().toISOString();
    const oldPath  = note.path;
    note.path      = newPath;
    note.sha       = newSha;
    note.updatedAt = now;
    GH.setDate(newPath, now);
    if (activeId === oldPath) {
      activeId = newPath;
      localStorage.setItem('gh_last_open', newPath);
    }
    if (targetFolder) expandedFolders.add(targetFolder);
    renderList($search.value);
    setStatus('Moved ✓');
  } catch (err) {
    setStatus(`Move failed: ${err.message}`, true);
  } finally {
    operationLock = false;
  }
}

/* Move a folder tree to a new full destination path */
async function moveFolderToPath(srcPath, destPath) {
  if (destPath === srcPath) return;
  if (destPath.startsWith(srcPath + '/')) { setStatus('Cannot move a folder into itself', true); return; }
  if (allFolderPaths().has(destPath)) { setStatus('A folder with that name already exists there', true); return; }

  operationLock = true;
  setStatus('Moving folder…', false, true);
  try {
    const affectedFolders = [...allFolderPaths()].filter(f => f === srcPath || f.startsWith(srcPath + '/'));
    const affectedNotes   = notes.filter(n => n.path.startsWith(srcPath + '/') || noteFolder(n.path) === srcPath);

    for (const note of affectedNotes) {
      const rel      = note.path.slice(srcPath.length);
      const nDest    = destPath + rel;
      const { content } = activeId === note.path
        ? { content: $editor.value }
        : await GH.getFile(note.path);
      if (activeId !== note.path) { const f = await GH.getFile(note.path); note.sha = f.sha; }
      const fetched   = await GH.getFile(note.path);
      const { sha: newSha } = await GH.writeFile(nDest, fetched.content, null, `Move ${note.title}`);
      await GH.deleteFile(note.path, fetched.sha, `Move ${note.title}`);
      GH.removeDate(note.path);
      const now    = new Date().toISOString();
      const oldP   = note.path;
      note.path    = nDest; note.sha = newSha; note.updatedAt = now;
      GH.setDate(nDest, now);
      if (activeId === oldP) { activeId = nDest; localStorage.setItem('gh_last_open', nDest); }
    }

    for (const fp of affectedFolders) {
      const fDest = destPath + fp.slice(srcPath.length);
      try { await GH.writeFile(`${fDest}/.gitkeep`, '', null, 'Move folder'); } catch {}
      try { await GH.deleteFile(`${fp}/.gitkeep`, undefined, 'Move folder'); } catch {}
      knownFolders.delete(fp); knownFolders.add(fDest);
      if (expandedFolders.has(fp)) { expandedFolders.delete(fp); expandedFolders.add(fDest); }
      if (currentFolder === fp || currentFolder.startsWith(fp + '/')) {
        currentFolder = fDest + currentFolder.slice(fp.length);
      }
    }
    saveExpandedState();
    renderList($search.value);
    setStatus('Folder moved ✓');
  } catch (err) {
    setStatus(`Move failed: ${err.message}`, true);
    await init();
  } finally {
    operationLock = false;
  }
}

function initDragAndDrop() {
  $noteList.addEventListener('dragover', e => {
    e.preventDefault();
    if (!dragItem) return;

    /* Find the li under the pointer */
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const li = el ? el.closest('#note-list li') : null;
    if (!li) { hideDropBar(); return; }

    const targetDepth  = getItemDepth(li);
    const isFolder     = li.classList.contains('folder-item');
    const targetFolder = isFolder ? li.dataset.path : (li.dataset.folder || '');

    /* Prevent dropping folder onto itself or descendant */
    if (dragItem.type === 'folder') {
      if (targetFolder === dragItem.path || targetFolder.startsWith(dragItem.path + '/')) {
        hideDropBar(); return;
      }
    }

    dropInfo = { folder: targetFolder, depth: targetDepth };
    showDropBar(li, targetDepth);
  });

  $noteList.addEventListener('dragleave', e => {
    if (!$noteList.contains(e.relatedTarget)) hideDropBar();
  });

  $noteList.addEventListener('drop', async e => {
    e.preventDefault();
    if (!dragItem || !dropInfo) { hideDropBar(); return; }
    const { folder } = dropInfo;
    hideDropBar();
    if (dragItem.type === 'note') {
      await dropMoveNote(dragItem.path, folder);
    } else {
      const name    = dragItem.path.split('/').pop();
      const destPath = folder ? `${folder}/${name}` : name;
      if (destPath !== dragItem.path) await moveFolderToPath(dragItem.path, destPath);
    }
    dragItem = null;
  });

  document.addEventListener('dragend', () => {
    hideDropBar();
    document.querySelectorAll('#note-list li.dragging').forEach(el => el.classList.remove('dragging'));
    dragItem = null;
  });
}

/* ── Mode switching ─────────────────────────────────────────── */
function setMode(newMode) {
  mode = newMode;
  [$btnModeEdit, $btnModeSplit, $btnModePreview].forEach(b => b.classList.remove('active'));
  if (mode === 'edit')    $btnModeEdit.classList.add('active');
  if (mode === 'split')   $btnModeSplit.classList.add('active');
  if (mode === 'preview') $btnModePreview.classList.add('active');

  $editorWrap.classList.remove('split');
  if (mode === 'edit') {
    $editorPane.classList.remove('hidden');
    $preview.classList.add('hidden');
    $divider.classList.add('hidden');
    $editor.focus();
  } else if (mode === 'split') {
    $editorWrap.classList.add('split');
    $editorPane.classList.remove('hidden');
    $divider.classList.remove('hidden');
    $preview.classList.remove('hidden');
    updatePreview();
    $editor.focus();
  } else {
    $editorPane.classList.add('hidden');
    $divider.classList.add('hidden');
    $preview.classList.remove('hidden');
    updatePreview();
  }
}

function cycleMode() {
  const order = ['edit', 'split', 'preview'];
  setMode(order[(order.indexOf(mode) + 1) % order.length]);
}

/* ── Divider drag-to-resize ─────────────────────────────────── */
(function initDivider() {
  let dragging = false, startX = 0, startW = 0;
  $divider.addEventListener('mousedown', e => {
    dragging = true;
    startX   = e.clientX;
    startW   = $editorPane.getBoundingClientRect().width;
    $divider.classList.add('dragging');
    document.body.style.cursor     = 'col-resize';
    document.body.style.userSelect = 'none';
  });
  document.addEventListener('mousemove', e => {
    if (!dragging) return;
    const totalW = $editorWrap.getBoundingClientRect().width - $divider.offsetWidth;
    const newW   = Math.max(150, Math.min(totalW - 150, startW + e.clientX - startX));
    const pct    = (newW / totalW) * 100;
    $editorPane.style.flex = `0 0 ${pct}%`;
    $preview.style.flex    = `0 0 ${100 - pct}%`;
  });
  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    $divider.classList.remove('dragging');
    document.body.style.cursor     = '';
    document.body.style.userSelect = '';
  });
})();

/* ── Smart Enter: list continuation + indentation ──────────── */
function handleEditorEnter(e) {
  const pos       = $editor.selectionStart;
  const sel       = $editor.selectionEnd;
  const text      = $editor.value;
  const lineStart = text.lastIndexOf('\n', pos - 1) + 1;
  const lineText  = text.slice(lineStart, pos);
  let m, insertion;

  if ((m = lineText.match(/^(\s*)-\s\[[ x]\]\s*/))) {
    const content = lineText.slice(m[0].length);
    if (!content.trim()) {
      e.preventDefault();
      $editor.value = text.slice(0, lineStart) + m[1] + text.slice(pos);
      $editor.selectionStart = $editor.selectionEnd = lineStart + m[1].length;
      onEditorInput(); return;
    }
    e.preventDefault();
    insertion = `\n${m[1]}- [ ] `;

  } else if ((m = lineText.match(/^(\s*)([-*+])\s+/))) {
    const content = lineText.slice(m[0].length);
    if (!content.trim()) {
      e.preventDefault();
      $editor.value = text.slice(0, lineStart) + m[1] + text.slice(pos);
      $editor.selectionStart = $editor.selectionEnd = lineStart + m[1].length;
      onEditorInput(); return;
    }
    e.preventDefault();
    insertion = `\n${m[1]}${m[2]} `;

  } else if ((m = lineText.match(/^(\s*)(\d+)\.\s+/))) {
    const content = lineText.slice(m[0].length);
    if (!content.trim()) {
      e.preventDefault();
      $editor.value = text.slice(0, lineStart) + m[1] + text.slice(pos);
      $editor.selectionStart = $editor.selectionEnd = lineStart + m[1].length;
      onEditorInput(); return;
    }
    e.preventDefault();
    insertion = `\n${m[1]}${parseInt(m[2], 10) + 1}. `;

  } else if ((m = lineText.match(/^(\s+)/))) {
    e.preventDefault();
    insertion = `\n${m[1]}`;
  }

  if (insertion != null) {
    $editor.value = text.slice(0, pos) + insertion + text.slice(sel);
    $editor.selectionStart = $editor.selectionEnd = pos + insertion.length;
    onEditorInput();
  }
}

/* ── Sidebar toggle ─────────────────────────────────────────── */
function toggleSidebar() { $sidebar.classList.toggle('collapsed'); }

/* ── Keyboard shortcuts ─────────────────────────────────────── */
document.addEventListener('keydown', e => {
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key === 'n') { e.preventDefault(); createNote(); }
  if (mod && e.key === 'p') { e.preventDefault(); if (activeId) cycleMode(); }
  if (mod && e.key === '1') { e.preventDefault(); if (activeId) setMode('edit'); }
  if (mod && e.key === '2') { e.preventDefault(); if (activeId) setMode('split'); }
  if (mod && e.key === '3') { e.preventDefault(); if (activeId) setMode('preview'); }
  if (mod && e.key === 'r') { e.preventDefault(); if (activeId) openRenameModal(); }
  if (mod && e.key === ',') { e.preventDefault(); showSettings(); }
  if (mod && e.shiftKey && e.key === 'B') { e.preventDefault(); toggleSidebar(); }
  if (e.key === 'Escape') { hideSettings(); closeModal(); closeMoveModal(); hideCtxMenu(); }
  if (e.key === 'Enter' && !$modalOverlay.classList.contains('hidden')) {
    e.preventDefault(); confirmModal();
  }
  if (document.activeElement === $editor) {
    if (e.key === 'Tab') {
      e.preventDefault();
      const s = $editor.selectionStart, end = $editor.selectionEnd;
      $editor.value = $editor.value.slice(0, s) + '    ' + $editor.value.slice(end);
      $editor.selectionStart = $editor.selectionEnd = s + 4;
      onEditorInput();
    }
    if (e.key === 'Enter') handleEditorEnter(e);
  }
});

/* ── Wire up events ─────────────────────────────────────────── */
$btnNew.addEventListener('click', createNote);
$btnNewEmpty.addEventListener('click', createNote);
$btnNewFolder.addEventListener('click', openCreateFolderModal);
$btnToggle.addEventListener('click', toggleSidebar);
$btnModeEdit.addEventListener('click',    () => { if (activeId) setMode('edit'); });
$btnModeSplit.addEventListener('click',   () => { if (activeId) setMode('split'); });
$btnModePreview.addEventListener('click', () => { if (activeId) setMode('preview'); });
$btnRename.addEventListener('click', openRenameModal);
$btnMove.addEventListener('click', openMoveModal);
$btnDelete.addEventListener('click', deleteNote);
$btnSettings.addEventListener('click', showSettings);
$editor.addEventListener('input', onEditorInput);
$search.addEventListener('input', () => renderList($search.value));

/* Inline title — update preview live, commit on blur/Enter */
$noteTitleInput.addEventListener('input', () => {
  if (!activeId) return;
  pendingTitle = true;
  $titleDisplay.textContent = $noteTitleInput.value ||
    (notes.find(n => n.path === activeId) || {}).title || '';
  if (mode !== 'edit') updatePreview();
  renderList($search.value);
});
$noteTitleInput.addEventListener('blur', commitTitleChange);
$noteTitleInput.addEventListener('keydown', e => {
  if (e.key === 'Enter')  { e.preventDefault(); $editor.focus(); }
  if (e.key === 'Escape') {
    const note = notes.find(n => n.path === activeId);
    if (note) $noteTitleInput.value = note.title;
    pendingTitle = false;
    $editor.focus();
  }
});

/* Settings modal */
$cfgTest.addEventListener('click', testConnection);
$cfgSave.addEventListener('click', saveSettings);
$cfgCancel.addEventListener('click', hideSettings);
$settingsOverlay.addEventListener('click', e => {
  if (e.target === $settingsOverlay) hideSettings();
});

/* Note modal (rename + folder) */
$modalCancel.addEventListener('click', closeModal);
$modalConfirm.addEventListener('click', confirmModal);
$modalOverlay.addEventListener('click', e => {
  if (e.target === $modalOverlay) closeModal();
});

/* Move modal */
$moveCancel.addEventListener('click', closeMoveModal);
$moveConfirm.addEventListener('click', confirmMove);
$moveOverlay.addEventListener('click', e => {
  if (e.target === $moveOverlay) closeMoveModal();
});

/* Dismiss context menu on outside click */
document.addEventListener('click', e => {
  if (!$ctxMenu.contains(e.target)) hideCtxMenu();
});
document.addEventListener('contextmenu', e => {
  /* Hide menu if clicking outside a list item */
  if (!e.target.closest('#note-list li')) hideCtxMenu();
});

/* Init drag-and-drop listeners */
initDragAndDrop();

/* ── Boot ───────────────────────────────────────────────────── */
async function init() {
  notes        = [];
  activeId     = null;
  knownFolders = new Set();
  loadExpandedState();
  renderList();
  setEditorVisible(false);

  if (!GH.configured) {
    showSettings();
    return;
  }

  setStatus('Connecting to GitHub…', false, true);
  try {
    let allFiles;
    try {
      allFiles = await GH.listAllFiles();
    } catch (err) {
      if (err.message.includes('404')) {
        allFiles = [];
      } else {
        throw err;
      }
    }

    /* Folders anchored by .gitkeep files */
    allFiles
      .filter(f => f.name === '.gitkeep')
      .forEach(f => {
        const folder = f.relPath.split('/').slice(0, -1).join('/');
        if (folder) knownFolders.add(folder);
      });

    /* Notes */
    notes = allFiles
      .filter(f => f.name.endsWith('.md'))
      .map(f => ({
        path:      f.relPath,
        title:     f.name.slice(0, -3),
        sha:       f.sha,
        updatedAt: GH.getDate(f.relPath)
      }));

    /* Validate saved currentFolder still exists */
    if (currentFolder && !allFolderPaths().has(currentFolder)) {
      currentFolder = '';
      saveExpandedState();
    }

    renderList();
    setStatus('');

    if (notes.length > 0) {
      const lastOpen = localStorage.getItem('gh_last_open');
      const toOpen   = notes.find(n => n.path === lastOpen) || notes[0];
      await openNote(toOpen.path);
    }
  } catch (err) {
    setStatus(`Connection failed: ${err.message}`, true, true);
    showSettings();
  }
}

$btnModeEdit.classList.add('active');
init();
