import type { FlowPluginArgs, FlowVariables } from '../types/flowPlugin.ts';
import { HaltError } from './registry.ts';
import type { SimContext } from './context.ts';

/**
 * Tdarr resolves `{{{...}}}` expressions in a node's inputs before handing them
 * to the plugin, so a plugin never sees a raw template. The harness does the
 * same for the handful of expressions that appear in real flows.
 */
function resolveTemplates(
  inputs: Record<string, string>,
  args: Pick<FlowPluginArgs, 'configVars' | 'inputFileObj'>,
): Record<string, string> {
  const lookup: Record<string, string> = {
    'args.configVars.config.nodeName': args.configVars.config.nodeName ?? '',
    'args.inputFileObj.container': args.inputFileObj.container,
    'args.inputFileObj.file': args.inputFileObj.file,
    'args.inputFileObj._id': args.inputFileObj._id,
  };

  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(inputs)) {
    out[key] = value.replace(/\{\{\{\s*([^}]+?)\s*\}\}\}/g, (whole, expression: string) =>
      lookup[expression] ?? whole);
  }
  return out;
}

/**
 * Builds the `args` object a flow plugin receives. `variables.ffmpegCommand` is
 * passed by reference, so a plugin that marks streams `removed` mutates the
 * simulation's own state - which is exactly how Tdarr works.
 */
export function buildPluginArgs(
  ctx: SimContext,
  rawInputs: Record<string, string>,
  { requiresCommand = false }: { requiresCommand?: boolean } = {},
): FlowPluginArgs {
  if (requiresCommand && !ctx.ffmpegCommand) {
    throw new HaltError(
      'crash',
      'an ffmpeg command plugin ran outside a command block',
    );
  }

  const inputFileObj = {
    _id: ctx.file.path,
    file: ctx.file.path,
    container: ctx.file.container,
    file_size: ctx.file.size,
    // Preserve "never probed" vs "no streams" - plugins behave differently.
    ffProbeData: ctx.file.probeFailed ? {} : { streams: ctx.file.streams },
    fileMedium: ctx.file.medium,
  };

  const variables: FlowVariables = {
    // Plugins that run before Begin Command still read this property, so it is
    // always present - just uninitialised until Start runs.
    ffmpegCommand: ctx.ffmpegCommand ?? {
      init: false,
      inputFiles: [],
      streams: [],
      container: ctx.file.container,
      hardwareDecoding: false,
      shouldProcess: false,
      overallInputArguments: [],
      overallOuputArguments: [],
    },
    flowFailed: false,
    user: {},
  };

  const configVars = { config: { nodeName: ctx.nodeName } };

  return {
    inputFileObj,
    originalLibraryFile: {
      _id: ctx.original.path,
      file: ctx.original.path,
      container: ctx.original.container,
      file_size: ctx.original.size,
      ffProbeData: ctx.original.probeFailed ? {} : { streams: ctx.original.streams },
    },
    inputs: resolveTemplates(rawInputs, { configVars, inputFileObj }),
    variables,
    jobLog: (message: string) => ctx.say(String(message).trim()),
    workDir: '/tmp/tdarr-flow-test',
    librarySettings: {},
    configVars,
    platform: 'linux',
    logFullCliOutput: false,
  };
}

/** Applies whatever a plugin mutated back onto the simulation state. */
export function applyPluginResult(ctx: SimContext, args: FlowPluginArgs): void {
  if (args.variables.ffmpegCommand.init) ctx.ffmpegCommand = args.variables.ffmpegCommand;
}
