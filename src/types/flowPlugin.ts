/**
 * The flow plugin contract (Tdarr 2.x "FlowPlugins").
 *
 * Flow plugins mutate a shared `variables` object and return which numbered
 * output to leave by. The ffmpeg-command block is the important part: nodes
 * between `ffmpegCommandStart` and `ffmpegCommandExecute` do not touch the
 * file, they mark up `variables.ffmpegCommand.streams` - notably by setting
 * `removed: true` rather than filtering the array - and Execute turns the
 * accumulated markup into a single ffmpeg invocation.
 */

import type { FfProbeStream, TdarrFile } from './ffprobe.ts';

export interface FfmpegCommandStream extends FfProbeStream {
  /** Marked for exclusion by a later `-map -0:n`. The stream stays in the array. */
  removed: boolean;
  inputArgs: string[];
  outputArgs: string[];
}

export interface FfmpegCommand {
  init: boolean;
  inputFiles: string[];
  streams: FfmpegCommandStream[];
  /** Extension without a leading dot. */
  container: string;
  hardwareDecoding: boolean;
  /** Execute skips ffmpeg entirely when this is false. */
  shouldProcess: boolean;
  overallInputArguments: string[];
  /** Tdarr's own spelling; kept so plugin source ports across unchanged. */
  overallOuputArguments: string[];
}

export interface FlowVariables {
  ffmpegCommand: FfmpegCommand;
  flowFailed: boolean;
  user: Record<string, string>;
  [key: string]: unknown;
}

export interface FlowPluginConfigVars {
  config: {
    nodeName?: string;
    serverIP?: string;
    serverPort?: string;
    [key: string]: unknown;
  };
}

export interface FlowPluginArgs {
  inputFileObj: TdarrFile;
  originalLibraryFile: TdarrFile;
  inputs: Record<string, unknown>;
  variables: FlowVariables;
  jobLog: (message: string) => void;
  workDir: string;
  librarySettings: Record<string, unknown>;
  configVars: FlowPluginConfigVars;
  platform: string;
  logFullCliOutput: boolean;
  [key: string]: unknown;
}

export interface FlowPluginOutputDef {
  number: number;
  tooltip?: string;
}

export interface FlowPluginInputDef {
  label: string;
  name: string;
  type: 'string' | 'boolean' | 'number';
  defaultValue: unknown;
  inputUI: { type: string; options?: string[] };
  tooltip?: string;
}

export interface FlowPluginDetails {
  name: string;
  description: string;
  style?: Record<string, unknown>;
  tags?: string;
  isStartPlugin: boolean;
  pType: string;
  requiresVersion?: string;
  sidebarPosition?: number;
  icon?: string;
  inputs: FlowPluginInputDef[];
  outputs: FlowPluginOutputDef[];
}

export interface FlowPluginResult {
  outputFileObj: TdarrFile | { _id: string };
  outputNumber: number;
  variables: FlowVariables;
}

export interface FlowPluginModule {
  details: () => FlowPluginDetails;
  plugin: (args: FlowPluginArgs) => FlowPluginResult | Promise<FlowPluginResult>;
}
