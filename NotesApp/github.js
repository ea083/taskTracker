/* ── GitHub API wrapper ──────────────────────────────────────
   Stores each note as a .md file in a GitHub repository.
   Auth: Personal Access Token stored in localStorage.
   All content is UTF-8 safe (TextEncoder/TextDecoder).
──────────────────────────────────────────────────────────── */
const GH = (() => {
  const LS = {
    get:    k => localStorage.getItem('gh_' + k) || '',
    set:    (k, v) => localStorage.setItem('gh_' + k, v),
    remove: k => localStorage.removeItem('gh_' + k)
  };

  function apiBase() {
    const folder = LS.get('folder').replace(/^\/+|\/+$/g, '');
    const path   = folder ? '/' + folder : '';
    return `https://api.github.com/repos/${LS.get('owner')}/${LS.get('repo')}/contents${path}`;
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
    const res = await fetch(url, opts);
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

    async listFiles() {
      const data = await req('GET', apiBase());
      return Array.isArray(data) ? data : [];
    },

    async getFile(filename) {
      const data = await req('GET', `${apiBase()}/${encodeURIComponent(filename)}`);
      return { content: fromB64(data.content), sha: data.sha };
    },

    /* sha is undefined/null for new files, required for updates */
    async writeFile(filename, content, sha, message) {
      const body = { message: message || `Update ${filename}`, content: toB64(content) };
      if (sha) body.sha = sha;
      const data = await req('PUT', `${apiBase()}/${encodeURIComponent(filename)}`, body);
      return { sha: data.content.sha };
    },

    async deleteFile(filename, sha, message) {
      await req('DELETE', `${apiBase()}/${encodeURIComponent(filename)}`,
        { message: message || `Delete ${filename}`, sha });
    },

    /* Convenience: cached metadata stored locally */
    getDate:    filename => localStorage.getItem(`gh_date_${filename}`) || null,
    setDate:    (filename, iso) => localStorage.setItem(`gh_date_${filename}`, iso),
    removeDate: filename => localStorage.removeItem(`gh_date_${filename}`)
  };
})();
