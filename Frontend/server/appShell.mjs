import { readFile } from 'node:fs/promises';

// Anchor the asset to this traced module, not process.cwd(): monorepo function
// launchers can use the repository root rather than the Frontend project root.
export async function readBuiltAppShell() {
  try {
    return await readFile(new URL('../dist/index.html', import.meta.url), 'utf8');
  } catch {
    throw Error('SEO_APP_SHELL_UNAVAILABLE');
  }
}
