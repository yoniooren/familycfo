import { existsSync } from 'fs';
import { delimiter, dirname, join } from 'path';

/**
 * How to start the Claude Code CLI as a child process, on every OS.
 *
 * On macOS / Linux `claude` is an executable on the PATH. On Windows it is either `claude.exe` (native installer)
 * or `claude.cmd` (npm install). Node refuses to spawn a `.cmd` without `shell: true`, and a shell would re-parse
 * our arguments (the system prompt has quotes and newlines), so for the npm install we run its `cli.js` with node.
 * `CLAUDE_BIN` overrides the lookup (a path to claude / claude.exe / cli.js).
 */
export function claudeCommand(): { command: string; prefixArgs: string[] } {
  const override = process.env.CLAUDE_BIN;
  if (override) {
    return override.endsWith('.js') || override.endsWith('.mjs')
      ? { command: process.execPath, prefixArgs: [override] }
      : { command: override, prefixArgs: [] };
  }
  if (process.platform !== 'win32') return { command: 'claude', prefixArgs: [] };

  const dirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean);
  for (const dir of dirs) {
    const exe = join(dir, 'claude.exe');
    if (existsSync(exe)) return { command: exe, prefixArgs: [] };
  }
  for (const dir of dirs) {
    if (!existsSync(join(dir, 'claude.cmd'))) continue;
    // npm's global shim sits next to node_modules/@anthropic-ai/claude-code
    for (const base of [dir, dirname(dir)]) {
      const cli = join(base, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
      if (existsSync(cli)) return { command: process.execPath, prefixArgs: [cli] };
    }
  }
  // not found: spawn fails with ENOENT and the chat says Claude Code isn't installed
  return { command: 'claude.exe', prefixArgs: [] };
}

/** A path as a hook command can use it under both cmd.exe and Git Bash (forward slashes, quoted). */
export const shellPath = (p: string): string => JSON.stringify(process.platform === 'win32' ? p.replace(/\\/g, '/') : p);
