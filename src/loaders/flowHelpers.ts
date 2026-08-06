import type { FlowPluginArgs } from '../types/flowPlugin.ts';

/**
 * Stubs for `FlowHelpers/1.0.0/...`, which ships inside the Tdarr image rather
 * than with plugin source. These reproduce the helpers' observable behaviour
 * (guard clauses, pure transforms) so a local flow plugin can be executed
 * unmodified.
 *
 * Anything that would touch the filesystem or spawn a process throws, loudly.
 * A plugin that needs one of those is not unit-testable here and belongs in an
 * end-to-end test against a real server.
 */

export function checkFfmpegCommandInit(args: FlowPluginArgs): void {
  if (!args.variables.ffmpegCommand?.init) {
    throw new Error(
      'FFmpeg command plugins must be preceded by the "Begin Command" plugin',
    );
  }
}

export function getContainer(filePath: string): string {
  return filePath.split('.').pop() ?? '';
}

export function getFileName(filePath: string): string {
  const base = filePath.split('/').pop() ?? '';
  return base.slice(0, base.lastIndexOf('.'));
}

export function getFileAbosluteDir(filePath: string): string {
  return filePath.slice(0, filePath.lastIndexOf('/'));
}

function unsupported(name: string): never {
  throw new Error(
    `FlowHelpers.${name} is not available in the test harness - it touches the `
      + 'filesystem or spawns a process. Cover this plugin with an end-to-end test instead.',
  );
}

/** Maps a `require(...)` path suffix onto the stub module it should resolve to. */
export const FLOW_HELPER_MODULES: Record<string, Record<string, unknown>> = {
  'interfaces/flowUtils': { checkFfmpegCommandInit },
  'fileUtils': {
    getContainer,
    getFileName,
    getFileAbosluteDir,
    fileExists: () => unsupported('fileExists'),
    getFileSize: () => unsupported('getFileSize'),
  },
  'cliUtils': {
    CLI: class {
      runCli(): never {
        return unsupported('CLI.runCli');
      }
    },
  },
  'hardwareUtils': {
    getEncoder: () => unsupported('getEncoder'),
    hasEncoder: () => unsupported('hasEncoder'),
  },
};
