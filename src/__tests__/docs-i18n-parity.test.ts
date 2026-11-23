import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const DOCS_DIR = resolve(__dirname, '../../docs');
const VI_DIR = resolve(DOCS_DIR, 'vi');

function findMarkdownFiles(dir: string, baseDir: string = dir): string[] {
  const results: string[] = [];
  const entries = readdirSync(dir);

  for (const entry of entries) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);

    if (stat.isDirectory()) {
      // Skip .vitepress, vi locale folder, and node_modules
      if (entry === '.vitepress' || entry === 'vi' || entry === 'node_modules') {
        continue;
      }
      results.push(...findMarkdownFiles(fullPath, baseDir));
    } else if (stat.isFile() && entry.endsWith('.md')) {
      // Skip plan files excluded in vitepress config
      if (entry.endsWith('-plan.md')) {
        continue;
      }
      // Skip changelog.md which is explicitly kept English-only
      if (entry === 'changelog.md') {
        continue;
      }
      results.push(relative(baseDir, fullPath).replace(/\\/g, '/'));
    }
  }

  return results;
}

describe('Documentation i18n Parity', () => {
  const englishPages = findMarkdownFiles(DOCS_DIR);

  it('finds published English documentation pages', () => {
    expect(englishPages.length).toBeGreaterThan(0);
  });

  for (const relPath of englishPages) {
    it(`has a Vietnamese counterpart for ${relPath}`, () => {
      const viFilePath = join(VI_DIR, relPath);
      const exists = existsSync(viFilePath);
      expect(exists, `Missing Vietnamese translation: docs/vi/${relPath}`).toBe(true);
    });
  }
});
