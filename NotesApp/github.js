/* ── GitHub API wrapper ──────────────────────────────────────
   Stores each note as a .md file in a GitHub repository.
   Supports nested folders — all file operations use paths
   relative to the configured base folder.
   Auth: Personal Access Token stored in localStorage.
   All content is UTF-8 safe (TextEncoder/TextDecoder).
──────────────────────────────────────────────────────────── */
const GH = (() => {
  const LS = {
    get:    k => localStorage.getItem('gh_' + k) || '',
    set:    (k, v) => localStorage.setItem('gh_' + k, v),
    remove: k => localStorage.removeItem('gh_' + k)
  };

  /* Returns the full GitHub contents API URL for a path relative to the
     configured base folder. relPath may contain '/' for sub-folders. */
  function pathUrl(relPath) {
    const base     = LS.get('folder').replace(/^\/+|\/+$/g, '');
    const fullPath = [base, relPath].filter(Boolean).join('/');
    const encoded  = fullPath.split('/').map(encodeURIComponent).join('/');
    return `https://api.github.com/repos/${LS.get('owner')}/${LS.get('repo')}/contents${encoded ? '/' + encoded : ''}`;
  }

  function hdrs() {
    return {
      'Authorization':        `Bearer ${LS.get('token')}`,
      'Accept':               'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type':         'application/json'
    };
  }

  async function req(method, url, body) {
    const opts = { method, headers: hdrs() };
    if (body !== undefined) opts.body = JSON.stringify(body);
    const res  = await fetch(url, opts);
    if (res.status === 204) return null;
    const data = await res.json();
    if (!res.ok) throw new Error(`GitHub ${res.status}: ${data.message || res.statusText}`);
    return data;
  }

  /* UTF-8-safe base64 encode/decode */
  function toB64(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = '';
    bytes.forEach(b => (bin += String.fromCharCode(b)));
    return btoa(bin);
  }

  function fromB64(b64) {
    const bin   = atob(b64.replace(/\s/g, ''));
    const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  }

  /* Recursively fetch all files under a directory URL (parallel sub-dirs) */
  async function fetchDirRecursive(url) {
    let data;
    try { data = await req('GET', url); }
    catch (err) { if (err.message.includes('404')) return []; throw err; }
    if (!Array.isArray(data)) return [];
    const files    = data.filter(i => i.type === 'file');
    const subFiles = (await Promise.all(
      data.filter(i => i.type === 'dir').map(d => fetchDirRecursive(d.url))
    )).flat();
    return [...files, ...subFiles];
  }

  return {
    /* ── Config ── */
    get configured() {
      return !!(LS.get('token') && LS.get('owner') && LS.get('repo'));
    },

    saveConfig({ token, owner, repo, folder }) {
      LS.set('token',  token.trim());
      LS.set('owner',  owner.trim());
      LS.set('repo',   repo.trim());
      LS.set('folder', (folder || '').trim());
    },

    getConfig() {
      return {
        token:  LS.get('token'),
        owner:  LS.get('owner'),
        repo:   LS.get('repo'),
        folder: LS.get('folder')
      };
    },

    /* ── API calls ── */
    async testConnection() {
      const data = await req('GET',
        `https://api.github.com/repos/${LS.get('owner')}/${LS.get('repo')}`);
      return data.full_name;
    },

    /* Returns all files recursively as { relPath, name, sha }
       relPath is relative to the configured base folder. */
    async listAllFiles() {
      const base     = LS.get('folder').replace(/^\/+|\/+$/g, '');
      const allFiles = await fetchDirRecursive(pathUrl(''));
      return allFiles.map(f => ({
        relPath: base ? f.path.slice(base.length + 1) : f.path,
        name:    f.name,
        sha:     f.sha
      }));
    },

    async getFile(relPath) {
      const data = await req('GET', pathUrl(relPath));
      return { content: fromB64(data.content), sha: data.sha };
    },

    /* sha is undefined/null for new files, required for updates */
    async writeFile(relPath, content, sha, message) {
      const body = { message: message || `Update ${relPath}`, content: toB64(content) };
      if (sha) body.sha = sha;
      const data = await req('PUT', pathUrl(relPath), body);
      return { sha: data.content.sha };
    },

    async deleteFile(relPath, sha, message) {
      await req('DELETE', pathUrl(relPath),
        { message: message || `Delete ${relPath}`, sha });
    },

    /* Convenience: cached metadata stored locally */
    getDate:    relPath => localStorage.getItem(`gh_date_${relPath}`) || null,
    setDate:    (relPath, iso) => localStorage.setItem(`gh_date_${relPath}`, iso),
    removeDate: relPath => localStorage.removeItem(`gh_date_${relPath}`)
  };
})();
