/**
 * `velixar-mcp-server install` — set up an MCP host without hand-editing JSON.
 *
 * The worst step in the whole onboarding was "open claude_desktop_config.json and
 * merge this block into it". People do not have that file, or they have it with
 * other servers already in it, or they paste the snippet over the top and silently
 * delete someone else's MCP server. A config edit is a job for a program.
 *
 * SAFETY, because this writes to a file the user did not create:
 *   · MERGE, never replace — every other mcpServers entry is preserved verbatim.
 *   · BACK UP first — the previous file is copied to <name>.velixar-backup-<ts>.
 *   · IDEMPOTENT — running it twice updates the velixar entry, it does not duplicate.
 *   · DRY RUN by default is NOT the right call here (the user asked to install), but
 *     --print emits the config instead of writing, for anyone who wants to do it by hand.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join, dirname } from 'node:path';
import { VERSION, SERVER_NAME } from './version.js';

// Derived, never hardcoded — the installer must pin the version it IS.
const MCP_SPEC = `${SERVER_NAME}@${VERSION}`;

type Host = {
  id: string;
  name: string;
  /** Where the config lives, per platform. */
  path(): string | null;
  /** Some hosts nest servers under a different key (Zed: context_servers). */
  key: string;
  /** Build the entry for this host. */
  entry(apiKey: string): unknown;
};

const HOSTS: Host[] = [
  {
    id: 'claude-desktop',
    name: 'Claude Desktop',
    key: 'mcpServers',
    path() {
      const h = homedir();
      switch (platform()) {
        case 'darwin':
          return join(h, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
        case 'win32':
          return join(process.env.APPDATA || join(h, 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json');
        default:
          return join(h, '.config', 'Claude', 'claude_desktop_config.json');
      }
    },
    entry(apiKey) {
      return { command: 'npx', args: ['-y', MCP_SPEC], env: { VELIXAR_API_KEY: apiKey } };
    },
  },
  {
    id: 'cursor',
    name: 'Cursor',
    key: 'mcpServers',
    path() {
      return join(homedir(), '.cursor', 'mcp.json');
    },
    entry(apiKey) {
      return { command: 'npx', args: ['-y', MCP_SPEC], env: { VELIXAR_API_KEY: apiKey } };
    },
  },
  {
    id: 'windsurf',
    name: 'Windsurf',
    key: 'mcpServers',
    path() {
      return join(homedir(), '.codeium', 'windsurf', 'mcp_config.json');
    },
    entry(apiKey) {
      return { command: 'npx', args: ['-y', MCP_SPEC], env: { VELIXAR_API_KEY: apiKey } };
    },
  },
];

function arg(name: string, argv: string[]): string | undefined {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--')) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  return eq ? eq.slice(name.length + 3) : undefined;
}

/** Merge the velixar entry into an existing config, preserving everything else. */
export function mergeConfig(existing: string | null, hostKey: string, entry: unknown): string {
  let cfg: Record<string, unknown> = {};
  if (existing && existing.trim()) {
    try {
      cfg = JSON.parse(existing);
    } catch {
      // A malformed config is the user's file, not ours to silently overwrite.
      throw new Error(
        'the existing config is not valid JSON. Fix or move it, then run this again — ' +
          'refusing to overwrite a file we cannot parse.'
      );
    }
  }
  const servers = (cfg[hostKey] && typeof cfg[hostKey] === 'object' ? cfg[hostKey] : {}) as Record<string, unknown>;
  servers.velixar = entry; // idempotent: updates in place, never duplicates
  cfg[hostKey] = servers;
  return JSON.stringify(cfg, null, 2) + '\n';
}

export async function runInstall(argv: string[]): Promise<number> {
  const hostId = (arg('client', argv) || 'claude-desktop').toLowerCase();
  const apiKey = arg('key', argv) || process.env.VELIXAR_API_KEY;
  const printOnly = argv.includes('--print');

  const host = HOSTS.find((h) => h.id === hostId);
  if (!host) {
    console.error(`unknown --client "${hostId}". known: ${HOSTS.map((h) => h.id).join(', ')}`);
    return 2;
  }
  if (!apiKey) {
    console.error('missing API key. pass --key vlx_… or set VELIXAR_API_KEY.');
    console.error('get one free at https://velixarai.com');
    return 2;
  }
  if (!apiKey.startsWith('vlx_')) {
    console.error('that does not look like a Velixar key (they start with "vlx_").');
    return 2;
  }

  const entry = host.entry(apiKey);

  if (printOnly) {
    console.log(mergeConfig(null, host.key, entry));
    return 0;
  }

  const path = host.path();
  if (!path) {
    console.error(`could not work out where ${host.name} keeps its config on this platform.`);
    return 2;
  }

  const existed = existsSync(path);
  const before = existed ? readFileSync(path, 'utf8') : null;

  let merged: string;
  try {
    merged = mergeConfig(before, host.key, entry);
  } catch (e) {
    console.error(`✗ ${(e as Error).message}`);
    console.error(`  file: ${path}`);
    return 1;
  }

  // Back up whatever was there. This is someone's machine.
  if (existed && before) {
    const backup = `${path}.velixar-backup-${Date.now()}`;
    copyFileSync(path, backup);
    console.log(`  backed up your existing config -> ${backup}`);
  }

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, merged, 'utf8');

  const others = Object.keys(JSON.parse(merged)[host.key] as object).filter((k) => k !== 'velixar');
  console.log(`\n  ✓ Velixar installed for ${host.name}`);
  console.log(`    ${path}`);
  if (others.length) console.log(`    kept your other MCP servers: ${others.join(', ')}`);
  console.log(`\n  Restart ${host.name} (fully quit and reopen), then ask it:`);
  console.log(`    "search my Velixar memories"\n`);
  return 0;
}
