import type { FfProbeStream, TdarrFile } from '../types/ffprobe.ts';
import type { FfmpegCommand, FfmpegCommandStream } from '../types/flowPlugin.ts';

export interface WorkingFile {
  path: string;
  /** Extension without a leading dot. */
  container: string;
  size: number;
  streams: FfProbeStream[];
  /**
   * True when ffprobe returned nothing at all. Distinct from `streams` being
   * empty: plugins that read `ffProbeData.streams` blindly throw on the former
   * and cope with the latter.
   */
  probeFailed: boolean;
}

export interface LogEntry {
  node: string;
  message: string;
}

export interface HaltReason {
  kind: 'crash' | 'deadEnd' | 'fanout' | 'loop' | 'unmodelled';
  node?: string;
  message: string;
}

export interface PathEntry {
  id: string;
  name: string;
  plugin: string;
  handle: string | null;
}

export interface SimContext {
  file: WorkingFile;
  original: WorkingFile;
  /** Null until `ffmpegCommandStart` runs. */
  ffmpegCommand: FfmpegCommand | null;
  nodeName: string;
  transcodeRatio: number;
  log: LogEntry[];
  path: PathEntry[];
  replaced: boolean;
  halted: HaltReason | null;
  /** Set by whichever node is executing, so models can log without plumbing. */
  currentNode: string;
  say: (message: string) => void;
}

export function renumber(streams: FfProbeStream[]): FfProbeStream[] {
  return streams.map((stream, index) => ({ ...stream, index }));
}

export function toWorkingFile(file: TdarrFile): WorkingFile {
  const streams = file.ffProbeData?.streams;
  return {
    path: file.file ?? file._id,
    container: file.container,
    size: file.file_size,
    streams: renumber(streams ?? []),
    probeFailed: !Array.isArray(streams),
  };
}

export function toCommandStreams(streams: FfProbeStream[]): FfmpegCommandStream[] {
  return streams.map((stream) => ({
    ...stream,
    removed: false,
    inputArgs: [],
    outputArgs: [],
  }));
}

export function newFfmpegCommand(file: WorkingFile): FfmpegCommand {
  return {
    init: true,
    inputFiles: [],
    streams: toCommandStreams(file.streams),
    container: file.container,
    hardwareDecoding: false,
    shouldProcess: false,
    overallInputArguments: [],
    overallOuputArguments: [],
  };
}

/**
 * The streams a `check*` node sees.
 *
 * MODELLING ASSUMPTION: check plugins read `args.inputFileObj.ffProbeData`,
 * i.e. the file as it exists on disk - NOT the pending markup in
 * `variables.ffmpegCommand.streams`. They are general-purpose nodes usable
 * outside a command block, so reading the file is the behaviour that makes
 * them work everywhere.
 *
 * This matters: it means a stream marked `removed` inside a command block is
 * still visible to a later `check*` node. Any fix that relies on removing
 * streams to change a downstream check's answer will NOT work unless the
 * removal is executed first. Verify against a real server before depending on
 * it either way.
 */
export function streamsVisibleToChecks(ctx: SimContext): FfProbeStream[] {
  return ctx.file.streams;
}

/** The streams an ffmpeg-command node operates on: pending markup, minus removals. */
export function activeCommandStreams(ctx: SimContext): FfmpegCommandStream[] {
  if (!ctx.ffmpegCommand) {
    throw new Error('ffmpeg command node ran outside a command block');
  }
  return ctx.ffmpegCommand.streams.filter((stream) => !stream.removed);
}

export const isAudio = (stream: FfProbeStream): boolean => stream.codec_type === 'audio';
export const isVideo = (stream: FfProbeStream): boolean => stream.codec_type === 'video';
export const isSubtitle = (stream: FfProbeStream): boolean => stream.codec_type === 'subtitle';
export const isAttachedPic = (stream: FfProbeStream): boolean =>
  stream.disposition?.attached_pic === 1;

export const languageOf = (stream: FfProbeStream): string =>
  (stream.tags?.language ?? '').toLowerCase();
