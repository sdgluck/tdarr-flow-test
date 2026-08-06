/**
 * The classic (pre-flow) Tdarr plugin contract. A classic plugin is a pure
 * function from a file record to an ffmpeg preset, which makes it the easiest
 * part of a Tdarr setup to unit test.
 */

import type { TdarrFile } from './ffprobe.ts';

export interface ClassicPluginInputDef {
  name: string;
  type: 'string' | 'boolean' | 'number';
  defaultValue: unknown;
  inputUI: { type: string; options?: string[] };
  tooltip?: string;
}

export interface ClassicPluginDetails {
  id: string;
  Stage: string;
  Name: string;
  Type: string;
  Operation: string;
  Description: string;
  Version: string;
  Tags: string;
  Inputs: ClassicPluginInputDef[];
}

export interface ClassicPluginResponse {
  processFile: boolean;
  /**
   * ffmpeg arguments. Everything before the first comma is passed as *input*
   * arguments and everything after as output arguments - a detail that is easy
   * to get wrong, since a flag in the wrong half is silently ineffective.
   */
  preset: string;
  handBrakeMode: boolean;
  FFmpegMode: boolean;
  reQueueAfter: boolean;
  infoLog: string;
  /** Output container including the leading dot, e.g. ".mkv". */
  container: string;
}

/**
 * Values come off the flow node's `inputsDB`, which stores everything as a
 * string - booleans arrive as "true"/"false". Plugins are expected to coerce.
 */
export type ClassicPluginInputs = Record<string, unknown>;

export type ClassicPluginFn = (
  file: TdarrFile,
  librarySettings: Record<string, unknown>,
  inputs: ClassicPluginInputs,
  otherArguments: Record<string, unknown>,
) => ClassicPluginResponse;

export interface ClassicPluginModule {
  details: () => ClassicPluginDetails;
  plugin: ClassicPluginFn;
}
