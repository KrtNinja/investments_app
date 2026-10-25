// Хранилище данных в приватном репозитории GitHub.
// Чтение — Contents API на зафиксированном коммите, запись — один атомарный коммит через Git Data API.
// Работает в браузере и в Node 18+ (нужен глобальный fetch).

const API = 'https://api.github.com';

export class GitHubStore {
  constructor({ owner, repo, branch = 'main', token }) {
    if (!owner || !repo || !token) throw new Error('Нужны owner, repo и token');
    Object.assign(this, { owner, repo, branch, token });
    this.head = null; // коммит, на котором прочитаны данные
  }

  get label() { return `${this.owner}/${this.repo}@${this.branch}`; }

  async api(path, { method = 'GET', body, accept = 'application/vnd.github+json' } = {}) {
    const res = await fetch(`${API}/repos/${this.owner}/${this.repo}${path}`, {
      method,
      headers: {
        Accept: accept,
        Authorization: `Bearer ${this.token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      cache: 'no-store',
    });
    if (!res.ok) {
      let msg = '';
      try { msg = (await res.json()).message || ''; } catch { /* тело не JSON */ }
      const err = new Error(explain(res.status, msg, this));
      err.status = res.status;
      throw err;
    }
    return accept.endsWith('raw+json') ? res.text() : res.json();
  }

  // Запоминает текущий коммит ветки: все чтения идут с него.
  async refresh() {
    const ref = await this.api(`/git/ref/heads/${encodeURIComponent(this.branch)}`);
    this.head = ref.object.sha;
    return this.head;
  }

  async read(path) {
    if (!this.head) await this.refresh();
    return this.api(`/contents/${encodePath(path)}?ref=${this.head}`, { accept: 'application/vnd.github.raw+json' });
  }

  async exists(path) {
    try { await this.read(path); return true; } catch (e) { if (e.status === 404) return false; throw e; }
  }

  // files: { 'portfolios/ipoteka/operations.csv': 'текст', ... } — всё одним коммитом.
  // Если с момента чтения в ветку кто-то закоммитил, запись отклоняется (409), ничего не теряется.
  async commit(files, message) {
    if (!this.head) await this.refresh();
    const parent = await this.api(`/git/commits/${this.head}`);
    const tree = await this.api('/git/trees', {
      method: 'POST',
      body: {
        base_tree: parent.tree.sha,
        tree: Object.entries(files).map(([path, content]) => ({ path, mode: '100644', type: 'blob', content })),
      },
    });
    const commit = await this.api('/git/commits', {
      method: 'POST',
      body: { message, tree: tree.sha, parents: [this.head] },
    });
    try {
      await this.api(`/git/refs/heads/${encodeURIComponent(this.branch)}`, {
        method: 'PATCH',
        body: { sha: commit.sha, force: false },
      });
    } catch (e) {
      if (e.status === 422) {
        const err = new Error('Данные в репозитории изменились после загрузки (кто-то закоммитил). Обновите страницу и повторите.');
        err.status = 409;
        throw err;
      }
      throw e;
    }
    this.head = commit.sha;
    return commit;
  }
}

function encodePath(p) { return p.split('/').map(encodeURIComponent).join('/'); }

function explain(status, msg, s) {
  if (status === 401) return 'Токен GitHub не подошёл (401): истёк или введён с ошибкой.';
  if (status === 403) return `Доступ запрещён (403): ${msg || 'проверьте права токена — нужен Contents: Read and write'}.`;
  if (status === 404) return `Не найдено (404) в ${s.label}: нет файла или репозитория, либо токен не выдан на этот репозиторий.`;
  return `GitHub ${status}: ${msg}`;
}
