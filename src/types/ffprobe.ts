/**
 * ffprobe shapes, as Tdarr stores them on a file record. Field names follow
 * ffprobe's JSON output (snake_case) rather than being renamed, so fixtures and
 * plugin source read identically.
 */

export type CodecType = 'video' | 'audio' | 'subtitle' | 'data' | 'attachment';

export interface StreamDisposition {
  default?: number;
  comment?: number;
  hearing_impaired?: number;
  visual_impaired?: number;
  attached_pic?: number;
  forced?: number;
  [key: string]: number | undefined;
}

export interface StreamTags {
  language?: string;
  title?: string;
  [key: string]: string | undefined;
}

export interface FfProbeStream {
  index: number;
  codec_type: CodecType;
  codec_name?: string;
  codec_long_name?: string;
  profile?: string;
  /** Audio only. */
  channels?: number;
  channel_layout?: string;
  sample_rate?: string;
  /** ffprobe reports bit_rate as a string, and frequently omits it entirely. */
  bit_rate?: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
  disposition?: StreamDisposition;
  tags?: StreamTags;
}

export interface FfProbeFormat {
  format_name?: string;
  duration?: string;
  size?: string;
  bit_rate?: string;
  tags?: StreamTags;
}

export interface FfProbeData {
  /**
   * Absent - not merely empty - when ffprobe could not read the file at all.
   * Tdarr stores `ffProbeData: {}` in that case, and several stock plugins
   * throw on the missing property rather than handling it, so the distinction
   * between "no streams" and "never probed" is load-bearing.
   */
  streams?: FfProbeStream[];
  format?: FfProbeFormat;
}

/**
 * The file record Tdarr passes to plugins. Only the fields a plugin can
 * reasonably read are typed; the index signature keeps the rest addressable
 * without pretending we know their shapes.
 */
export interface TdarrFile {
  _id: string;
  file: string;
  /** Extension without a leading dot, e.g. "mkv". */
  container: string;
  file_size: number;
  ffProbeData: FfProbeData;
  fileMedium?: string;
  video_codec_name?: string;
  audio_codec_name?: string;
  videoStreamIndex?: number;
  [key: string]: unknown;
}
