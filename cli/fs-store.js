// Хранилище в локальном клоне investments_db (только Node).
import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

export class FsStore {
  constructor(dir, { gitCommit = false } = {}) {
    this.dir = dir;
    this.gitCommit = gitCommit;
    this.label = dir;
  }

  read(path) { return readFile(join(this.dir, path), 'utf8'); }

  async commit(files, message) {
    for (const [path, text] of Object.entries(files)) await writeFile(join(this.dir, path), text, 'utf8');
    if (this.gitCommit) {
      execFileSync('git', ['-C', this.dir, 'add', ...Object.keys(files)], { stdio: 'inherit' });
      execFileSync('git', ['-C', this.dir, 'commit', '-m', message], { stdio: 'inherit' });
    }
    return { files: Object.keys(files) };
  }
}
