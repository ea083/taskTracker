/* ── Notes App (GitHub backend) ─────────────────────────────
   Each note = one .md file in a GitHub repo.
   Title = filename without .md  (Obsidian-compatible).
   Requires github.js to be loaded first.
──────────────────────────────────────────────────────────── */

/* ── State ─────────────────────────────────────────────────── */
let notes         = [];     // [{ filename, title, sha, updatedAt }]
let activeId      = null;   // current filename (e.g. "My Note.md")
let mode          = 'edit'; // 'edit' | 'split' | 'preview'
let saveTimer     = null;
let isSaving      = false;
let operationLock = false;  // true during rename / delete
let pendingTitle  = false;  // title input changed but not yet committed

/* ── DOM refs ──────────────────────────────────────────────── */
const $sidebar        = document.getElementById('sidebar');
const $noteList       = document.getElementById('note-list');
const $search         = document.getElementById('search');
const $btnNew         = document.getElementById('btn-new');
const $btnNewEmpty    = document.getElementById('btn-new-empty');
const $btnToggle      = document.getElementById('btn-toggle-sidebar');
const $btnModeEdit    = document.getElementById('btn-mode-edit');
const $btnModeSplit   = document.getElementById('btn-mode-split');
const $btnModePreview = document.getElementById('btn-mode-preview');
const $divider        = document.getElementById('divider');
const $btnRename      = document.getElementById('btn-rename');
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
/* Rename modal (kept for Ctrl+R / Rename button in preview mode) */
const $modalOverlay = document.getElementById('modal-overlay');
const $modalInput   = document.getElementById('modal-input');
const $modalCancel  = document.getElementById('modal-cancel');
const $modalConfirm = document.getElementById('modal-confirm');

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

/* ── Filename helpers ───────────────────────────────────────── */
function sanitizeFilename(title) {
  return (title || 'Untitled note')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200) || 'Untitled note';
}

function uniqueFilename(title) {
  const base = sanitizeFilename(title);
  let filename = `${base}.md`;
  let counter  = 1;
  while (notes.some(n => n.filename === filename)) {
    filename = `${base} ${counter++}.md`;
  }
  return filename;
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

/* ── Sidebar ────────────────────────────────────────────────── */
function renderList(filterText = '') {
  const q = filterText.trim().toLowerCase();
  $noteList.innerHTML = '';

  const filtered = notes.filter(n => !q || n.title.toLowerCase().includes(q));
  filtered.sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));

  filtered.forEach(n => {
    const li        = document.createElement('li');
    li.dataset.id   = n.filename;
    if (n.filename === activeId) li.classList.add('active');

    const titleSpan       = document.createElement('span');
    titleSpan.textContent = n.title;

    const dateSpan       = document.createElement('span');
    dateSpan.className   = 'note-date';
    dateSpan.textContent = formatDate(n.updatedAt);

    li.appendChild(titleSpan);
    li.appendChild(dateSpan);
    li.addEventListener('click', () => openNote(n.filename));
    $noteList.appendChild(li);
  });
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
async function openNote(filename) {
  if (operationLock) return;
  activeId = filename;
  const note = notes.find(n => n.filename === filename);
  if (!note) return;

  $noteTitleInput.value     = note.title;
  $titleDisplay.textContent = note.title;
  $editor.value             = '';
  setEditorVisible(true);
  renderList($search.value);
  setStatus('Loading…', false, true);

  try {
    const { content, sha } = await GH.getFile(filename);
    note.sha      = sha;
    $editor.value = content;
    if (mode !== 'edit') updatePreview();
    localStorage.setItem('gh_last_open', filename);
    setStatus('');
  } catch (err) {
    setStatus(`Failed to load: ${err.message}`, true);
  }
}

/* ── Create a note ──────────────────────────────────────────── */
async function createNote() {
  if (operationLock) return;
  operationLock = true;

  const filename = uniqueFilename('Untitled note');
  const title    = filename.slice(0, -3);
  setStatus('Creating note…', false, true);

  try {
    const { sha } = await GH.writeFile(filename, '', null, `Create ${title}`);
    const now      = new Date().toISOString();
    GH.setDate(filename, now);
    notes.unshift({ filename, title, sha, updatedAt: now });
    renderList($search.value);
    operationLock = false;
    await openNote(filename);
    $noteTitleInput.focus();
    $noteTitleInput.select();
    setStatus('');
  } catch (err) {
    operationLock = false;
    setStatus(`Failed to create: ${err.message}`, true);
  }
}

/* ── Delete a note ──────────────────────────────────────────── */
async function deleteNote() {
  if (!activeId || operationLock) return;
  const note = notes.find(n => n.filename === activeId);
  if (!note) return;
  if (!confirm(`Delete "${note.title}"? This cannot be undone.`)) return;

  operationLock = true;
  clearTimeout(saveTimer);
  setStatus('Deleting…', false, true);

  try {
    await GH.deleteFile(note.filename, note.sha, `Delete ${note.title}`);
    GH.removeDate(note.filename);
    const idx = notes.findIndex(n => n.filename === note.filename);
    notes.splice(idx, 1);

    if (notes.length > 0) {
      const sorted = [...notes].sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
      operationLock = false;
      await openNote(sorted[0].filename);
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
  const note = notes.find(n => n.filename === activeId);
  if (!note) return;

  isSaving = true;
  setStatus('Saving…', false, true);
  try {
    const { sha } = await GH.writeFile(
      note.filename, $editor.value, note.sha, `Update ${note.title}`);
    note.sha        = sha;
    note.updatedAt  = new Date().toISOString();
    GH.setDate(note.filename, note.updatedAt);
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

  const note     = notes.find(n => n.filename === activeId);
  if (!note) return;

  const newTitle = ($noteTitleInput.value || '').trim() || 'Untitled note';
  if (newTitle === note.title) return;

  clearTimeout(saveTimer);
  operationLock = true;
  setStatus('Renaming…', false, true);

  try {
    const newFilename    = uniqueFilename(newTitle);
    const currentContent = $editor.value;

    /* GitHub has no rename — create new file, delete old */
    const { sha: newSha } = await GH.writeFile(
      newFilename, currentContent, null,
      `Rename: ${note.title} → ${newTitle}`);
    await GH.deleteFile(note.filename, note.sha,
      `Rename: ${note.title} → ${newTitle}`);

    GH.removeDate(note.filename);
    const now         = new Date().toISOString();
    const oldFilename = note.filename;

    note.filename  = newFilename;
    note.title     = newTitle;
    note.sha       = newSha;
    note.updatedAt = now;
    GH.setDate(newFilename, now);

    activeId = newFilename;
    localStorage.setItem('gh_last_open', newFilename);
    $titleDisplay.textContent = newTitle;
    renderList($search.value);
    setStatus('Renamed ✓');
  } catch (err) {
    /* Revert the input */
    const n = notes.find(n => n.filename === activeId);
    if (n) $noteTitleInput.value = n.title;
    setStatus(`Rename failed: ${err.message}`, true);
  } finally {
    operationLock = false;
  }
}

function openRenameModal() {
  /* In non-edit modes the editor pane is hidden; use the old modal */
  if (mode !== 'edit' && mode !== 'split') {
    const note = notes.find(n => n.filename === activeId);
    if (!note) return;
    $modalInput.value = note.title;
    $modalOverlay.classList.remove('hidden');
    $modalInput.select();
    $modalInput.focus();
  } else {
    $noteTitleInput.focus();
    $noteTitleInput.select();
  }
}

function closeModal() { $modalOverlay.classList.add('hidden'); }

function confirmRename() {
  const newTitle = $modalInput.value.trim();
  if (!newTitle || !activeId) { closeModal(); return; }
  $noteTitleInput.value = newTitle;
  pendingTitle = true;
  closeModal();
  commitTitleChange();
}

/* ── Settings modal ─────────────────────────────────────────── */
function showSettings() {
  const cfg       = GH.getConfig();
  $cfgToken.value  = cfg.token;
  $cfgOwner.value  = cfg.owner;
  $cfgRepo.value   = cfg.repo;
  $cfgFolder.value = cfg.folder;
  $cfgStatus.textContent = '';
  $cfgStatus.className   = '';
  $settingsOverlay.classList.remove('hidden');
  ($cfgToken.value ? $cfgOwner : $cfgToken).focus();
}

function hideSettings() {
  $settingsOverlay.classList.add('hidden');
}

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

    const wrapper       = document.createElement('div');
    wrapper.className   = 'collapsible-content';
    heading.after(wrapper);
    collected.forEach(el => wrapper.appendChild(el));

    heading.addEventListener('click', () => {
      const isCollapsed = heading.dataset.collapsed === 'true';
      heading.dataset.collapsed = isCollapsed ? 'false' : 'true';
      wrapper.classList.toggle('collapsed', !isCollapsed);
    });
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
  if (e.key === 'Escape') { hideSettings(); closeModal(); }
  if (e.key === 'Enter' && !$modalOverlay.classList.contains('hidden')) {
    e.preventDefault(); confirmRename();
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
  if (e.key === 'Enter' && document.activeElement === $cfgOwner ||
      e.key === 'Enter' && document.activeElement === $cfgRepo  ||
      e.key === 'Enter' && document.activeElement === $cfgFolder) {
    /* Allow Enter to move between settings fields naturally */
  }
});

/* ── Wire up events ─────────────────────────────────────────── */
$btnNew.addEventListener('click', createNote);
$btnNewEmpty.addEventListener('click', createNote);
$btnToggle.addEventListener('click', toggleSidebar);
$btnModeEdit.addEventListener('click',    () => { if (activeId) setMode('edit'); });
$btnModeSplit.addEventListener('click',   () => { if (activeId) setMode('split'); });
$btnModePreview.addEventListener('click', () => { if (activeId) setMode('preview'); });
$btnRename.addEventListener('click', openRenameModal);
$btnDelete.addEventListener('click', deleteNote);
$btnSettings.addEventListener('click', showSettings);
$editor.addEventListener('input', onEditorInput);
$search.addEventListener('input', () => renderList($search.value));

/* Inline title — update preview live, commit on blur/Enter */
$noteTitleInput.addEventListener('input', () => {
  if (!activeId) return;
  pendingTitle = true;
  $titleDisplay.textContent = $noteTitleInput.value ||
    (notes.find(n => n.filename === activeId) || {}).title || '';
  if (mode !== 'edit') updatePreview();
  renderList($search.value);
});
$noteTitleInput.addEventListener('blur', commitTitleChange);
$noteTitleInput.addEventListener('keydown', e => {
  if (e.key === 'Enter')  { e.preventDefault(); $editor.focus(); }
  if (e.key === 'Escape') {
    const note = notes.find(n => n.filename === activeId);
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

/* Rename modal */
$modalCancel.addEventListener('click', closeModal);
$modalConfirm.addEventListener('click', confirmRename);
$modalOverlay.addEventListener('click', e => {
  if (e.target === $modalOverlay) closeModal();
});

/* ── Boot ───────────────────────────────────────────────────── */
async function init() {
  notes    = [];
  activeId = null;
  renderList();
  setEditorVisible(false);

  if (!GH.configured) {
    showSettings();
    return;
  }

  setStatus('Connecting to GitHub…', false, true);
  try {
    let files;
    try {
      files = await GH.listFiles();
    } catch (err) {
      /* 404 means the folder doesn't exist yet — treat as empty notes list */
      if (err.message.includes('404')) {
        files = [];
      } else {
        throw err;
      }
    }
    notes = files
      .filter(f => f.type === 'file' && f.name.endsWith('.md'))
      .map(f => ({
        filename:  f.name,
        title:     f.name.slice(0, -3),
        sha:       f.sha,
        updatedAt: GH.getDate(f.name)
      }));
    notes.sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
    renderList();
    setStatus('');

    if (notes.length > 0) {
      const lastOpen = localStorage.getItem('gh_last_open');
      const toOpen   = notes.find(n => n.filename === lastOpen) || notes[0];
      await openNote(toOpen.filename);
    }
  } catch (err) {
    setStatus(`Connection failed: ${err.message}`, true, true);
    showSettings();
  }
}

$btnModeEdit.classList.add('active');
init();
