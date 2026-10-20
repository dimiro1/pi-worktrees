import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

export async function loadPiExtensions() {
  let packageDir = process.env.PI_PACKAGE_DIR;
  if (!packageDir) {
    try {
      packageDir = dirname(dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'))));
    } catch (error) {
      if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
      // Personal extensions can also run the suite without a local npm install.
      const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi/agent');
      const version = (await readFile(join(agentDir, 'install/current-version'), 'utf8')).trim();
      packageDir = join(agentDir, 'install/releases', version, 'node_modules/@earendil-works/pi-coding-agent');
    }
  }
  const { loadExtensions } = await import(pathToFileURL(join(packageDir, 'dist/core/extensions/loader.js')).href);
  return loadExtensions;
}
