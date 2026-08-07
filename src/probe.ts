/**
 * Builders for synthetic ffprobe data, so a test reads as the scenario it
 * describes rather than as a wall of JSON.
 *
 *   const f = file({ container: 'mkv', streams: [
 *     video({ codec: 'h264' }),
 *     audio({ codec: 'dts', channels: 6 }),
 *     audio({ codec: 'aac', channels: 2 }),
 *   ]})
 */

import type { CodecType, FfProbeStream, TdarrFile } from './types/ffprobe.ts';

export interface VideoOptions {
  codec?: string;
  width?: number;
  height?: number;
}

export interface AudioOptions {
  codec?: string;
  channels?: number;
  /** Pass null for an untagged stream, which behaves very differently. */
  language?: string | null;
  title?: string;
  commentary?: boolean;
  bitRate?: number;
  sampleRate?: number;
}

export interface SubtitleOptions {
  codec?: string;
  language?: string | null;
  title?: string;
  commentary?: boolean;
  hearingImpaired?: boolean;
  forced?: boolean;
}

function tagsFor(language: string | null | undefined, title?: string) {
  const tags: Record<string, string> = {};
  if (language !== null && language !== undefined) tags.language = language;
  if (title) tags.title = title;
  return tags;
}

export function video(options: VideoOptions = {}): FfProbeStream {
  const { codec = 'h264', width = 1920, height = 1080 } = options;
  return {
    index: 0,
    codec_type: 'video',
    codec_name: codec,
    width,
    height,
    disposition: {},
    tags: {},
  };
}

export function audio(options: AudioOptions = {}): FfProbeStream {
  const {
    codec = 'aac',
    channels = 2,
    language = 'eng',
    title,
    commentary = false,
    bitRate,
    sampleRate = 48_000,
  } = options;
  return {
    index: 0,
    codec_type: 'audio',
    codec_name: codec,
    channels,
    sample_rate: String(sampleRate),
    bit_rate: bitRate === undefined ? undefined : String(bitRate),
    disposition: { comment: commentary ? 1 : 0 },
    tags: tagsFor(language, title),
  };
}

export function subtitle(options: SubtitleOptions = {}): FfProbeStream {
  const {
    codec = 'subrip',
    language = 'eng',
    title,
    commentary = false,
    hearingImpaired = false,
    forced = false,
  } = options;
  return {
    index: 0,
    codec_type: 'subtitle',
    codec_name: codec,
    disposition: {
      comment: commentary ? 1 : 0,
      hearing_impaired: hearingImpaired ? 1 : 0,
      forced: forced ? 1 : 0,
    },
    tags: tagsFor(language, title),
  };
}

/** An embedded cover image. These break MKV muxing if mapped as video. */
export function attachedPic(): FfProbeStream {
  return {
    index: 0,
    codec_type: 'video',
    codec_name: 'mjpeg',
    disposition: { attached_pic: 1 },
    tags: {},
  };
}

export function stream(codecType: CodecType, extra: Partial<FfProbeStream> = {}): FfProbeStream {
  return { index: 0, codec_type: codecType, disposition: {}, tags: {}, ...extra };
}

export interface FileOptions {
  container?: string;
  streams?: FfProbeStream[];
  size?: number;
  name?: string;
  path?: string;
}

/** Assembles a Tdarr file record, renumbering stream indexes in order. */
export function file(options: FileOptions = {}): TdarrFile {
  const {
    container = 'mkv',
    streams = [],
    size = 1_000_000,
    name = `test.${container}`,
    path = `/mnt/media/test/${name}`,
  } = options;

  const renumbered = streams.map((s, index) => ({ ...s, index }));
  const firstVideo = renumbered.find((s) => s.codec_type === 'video');
  const firstAudio = renumbered.find((s) => s.codec_type === 'audio');

  return {
    _id: path,
    file: path,
    container,
    file_size: size,
    ffProbeData: { streams: renumbered },
    fileMedium: firstVideo ? 'video' : (firstAudio ? 'audio' : 'other'),
    video_codec_name: firstVideo?.codec_name ?? '',
    audio_codec_name: firstAudio?.codec_name ?? '',
    videoStreamIndex: firstVideo?.index ?? -1,
  };
}

/**
 * A file ffprobe could not read at all - a truncated download, or an MP4 whose
 * moov atom was lost. Tdarr records these with no streams and fileMedium
 * "other", and they are the input that most often finds unguarded nodes.
 */
export function unreadableFile(options: Omit<FileOptions, 'streams'> = {}): TdarrFile {
  // ffProbeData is `{}` - the `streams` property is ABSENT, not empty. Stock
  // plugins that do JSON.parse(JSON.stringify(ffProbeData.streams)) throw on
  // this and cope fine with an empty array, so the distinction decides whether
  // a flow survives an unreadable source.
  return { ...file({ ...options, streams: [] }), ffProbeData: {} };
}
