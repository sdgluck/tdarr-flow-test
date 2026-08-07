import type { Flow } from './flow.ts';
import * as probe from './probe.ts';
import {
  buildRegistry,
  simulate,
  type SimulateOptions,
  type SimulationResult,
} from './simulation/simulate.ts';
import type { FfProbeStream, TdarrFile } from './types/ffprobe.ts';

/**
 * Sweeps a flow with a broad matrix of synthetic files and reports what comes
 * out of each.
 *
 * The findings suite answers "is this specific defect still there?". Fuzzing
 * answers the question you did not think to ask: which shapes of file crash,
 * come out silent, or quietly keep the wrong container. It is a discovery tool
 * - anything it surfaces should become a named test.
 */

export interface Variant {
  label: string;
  file: TdarrFile;
}

// --- the matrix -------------------------------------------------------------

const CONTAINERS = ['mkv', 'mp4', 'avi', 'ts', 'wmv', 'mov', 'webm', 'vob', 'm2ts'];

const VIDEO: { label: string; streams: () => FfProbeStream[] }[] = [
  { label: 'h264', streams: () => [probe.video({ codec: 'h264' })] },
  { label: 'hevc', streams: () => [probe.video({ codec: 'hevc' })] },
  { label: 'mpeg4', streams: () => [probe.video({ codec: 'mpeg4' })] },
  { label: 'mpeg2', streams: () => [probe.video({ codec: 'mpeg2video' })] },
  { label: 'av1', streams: () => [probe.video({ codec: 'av1' })] },
  { label: 'vp9', streams: () => [probe.video({ codec: 'vp9' })] },
  { label: 'h264+cover', streams: () => [probe.video({ codec: 'h264' }), probe.attachedPic()] },
  { label: 'no-video', streams: () => [] },
];

const AUDIO: { label: string; streams: () => FfProbeStream[] }[] = [
  { label: 'none', streams: () => [] },
  { label: 'eac3-5.1', streams: () => [probe.audio({ codec: 'eac3', channels: 6 })] },
  { label: 'ac3-5.1', streams: () => [probe.audio({ codec: 'ac3', channels: 6 })] },
  { label: 'aac-2.0', streams: () => [probe.audio({ codec: 'aac', channels: 2 })] },
  { label: 'dts-5.1', streams: () => [probe.audio({ codec: 'dts', channels: 6 })] },
  { label: 'truehd-7.1', streams: () => [probe.audio({ codec: 'truehd', channels: 8 })] },
  { label: 'mp3-mono', streams: () => [probe.audio({ codec: 'mp3', channels: 1 })] },
  { label: 'flac-2.0', streams: () => [probe.audio({ codec: 'flac', channels: 2 })] },
  { label: 'opus-5.1', streams: () => [probe.audio({ codec: 'opus', channels: 6 })] },
  { label: 'pcm-2.0', streams: () => [probe.audio({ codec: 'pcm_s16le', channels: 2 })] },
  { label: 'dts-4ch', streams: () => [probe.audio({ codec: 'dts', channels: 4 })] },
  { label: 'untagged-dts-5.1', streams: () => [probe.audio({ codec: 'dts', channels: 6, language: null })] },
  { label: 'fre-dts-5.1', streams: () => [probe.audio({ codec: 'dts', channels: 6, language: 'fre' })] },
  {
    label: 'dts-5.1+aac-2.0',
    streams: () => [
      probe.audio({ codec: 'dts', channels: 6 }),
      probe.audio({ codec: 'aac', channels: 2 }),
    ],
  },
  {
    label: 'truehd-7.1+ac3-5.1',
    streams: () => [
      probe.audio({ codec: 'truehd', channels: 8 }),
      probe.audio({ codec: 'ac3', channels: 6 }),
    ],
  },
  {
    label: 'eng+fre',
    streams: () => [
      probe.audio({ codec: 'ac3', channels: 6, language: 'eng' }),
      probe.audio({ codec: 'ac3', channels: 6, language: 'fre' }),
    ],
  },
  {
    label: 'eac3+commentary',
    streams: () => [
      probe.audio({ codec: 'eac3', channels: 6 }),
      probe.audio({ codec: 'eac3', channels: 2, commentary: true, title: 'Commentary' }),
    ],
  },
];

const SUBTITLES: { label: string; streams: () => FfProbeStream[] }[] = [
  { label: 'none', streams: () => [] },
  { label: 'eng', streams: () => [probe.subtitle({ language: 'eng' })] },
  { label: 'eng-sdh', streams: () => [probe.subtitle({ language: 'eng', title: 'English SDH' })] },
  { label: 'fre', streams: () => [probe.subtitle({ language: 'fre' })] },
  { label: 'mov_text', streams: () => [probe.subtitle({ codec: 'mov_text' })] },
  { label: 'pgs', streams: () => [probe.subtitle({ codec: 'hdmv_pgs_subtitle' })] },
  { label: 'untagged', streams: () => [probe.subtitle({ language: null })] },
];

export interface GenerateOptions {
  containers?: string[];
  /** Cap the matrix. Variants are sampled evenly across it, never truncated. */
  limit?: number;
}

/** The full matrix, before any sampling. */
export function allVariants(options: GenerateOptions = {}): Variant[] {
  const containers = options.containers ?? CONTAINERS;
  const all: Variant[] = [];

  for (const container of containers) {
    for (const video of VIDEO) {
      for (const audio of AUDIO) {
        for (const subtitle of SUBTITLES) {
          const streams = [...video.streams(), ...audio.streams(), ...subtitle.streams()];
          if (streams.length === 0) continue;
          all.push({
            label: `${container} | ${video.label} | ${audio.label} | subs:${subtitle.label}`,
            file: probe.file({
              container,
              streams,
              name: `fuzz.${container}`,
              size: 1_000_000_000,
            }),
          });
        }
      }
    }
  }

  // Cases the matrix cannot express.
  for (const container of containers) {
    all.push({
      label: `${container} | UNREADABLE (ffprobe returned nothing)`,
      file: probe.unreadableFile({ container, name: `broken.${container}` }),
    });
  }

  return all;
}

/** Builds the matrix, sampled down to `limit` if one is given. */
export function generateVariants(options: GenerateOptions = {}): Variant[] {
  const all = allVariants(options);
  const { limit } = options;
  if (limit === undefined || all.length <= limit) return all;

  // Even stride rather than head-truncation, so the sample still spans every
  // container and codec rather than stopping inside the first one.
  const stride = all.length / limit;
  const sampled: Variant[] = [];
  for (let i = 0; i < limit; i += 1) sampled.push(all[Math.floor(i * stride)] as Variant);
  return sampled;
}

// --- running and classifying ------------------------------------------------

export type Anomaly =
  | 'skipped-with-media'
  | 'silent'
  | 'not-target-container'
  | 'multiple-audio'
  | 'duplicate-audio'
  | 'not-replaced'
  | 'lost-subtitles'
  | 'video-not-target-codec';

export interface FuzzOutcome {
  variant: Variant;
  result: SimulationResult;
  /** One-line description of the file the flow produced. */
  shape: string;
  anomalies: Anomaly[];
}

export interface FuzzOptions extends SimulateOptions, GenerateOptions {
  /** Container every file is expected to end up in. Defaults to mkv. */
  targetContainer?: string;
  /** Video codec every file is expected to end up in. Defaults to hevc. */
  targetVideoCodec?: string;
  /**
   * How many audio tracks the flow is meant to produce. Defaults to 2, which
   * suits a "one surround plus one stereo mate" policy; set 1 for a
   * single-track policy.
   */
  maxAudioTracks?: number;
  /** Channel count at which a track counts as surround. */
  surroundMinChannels?: number;
  /**
   * Set when the flow deliberately only handles video, so a skipped audio-only
   * file is correct rather than a defect. A skipped file that DOES have video
   * is still reported - declaring scope must not become a blanket exemption.
   */
  videoOnly?: boolean;
  /**
   * Language the flow is expected to keep. Subtitles and audio in other
   * languages are *supposed* to be stripped, so losing them is not an anomaly.
   */
  keepLanguage?: string;
}

function describeShape(result: SimulationResult, target: string): string {
  if (result.halted) return `HALTED (${result.halted.kind})`;

  const untouched = !result.replaced
    && result.file.container === result.original.container
    && JSON.stringify(result.file.streams) === JSON.stringify(result.original.streams);
  if (untouched) return `SKIPPED (${result.file.container}, left untouched)`;

  // Begin Command reclassifies attached pictures to codec_type 'attachment',
  // so whether a cover image counts as "video" depends on whether the command
  // block ran. Exclude them explicitly, or an untouched file looks different
  // from an identical processed one for no real reason.
  const video = result.video
    .filter((s) => s.disposition?.attached_pic !== 1)
    .map((s) => s.codec_name)
    .join('+') || 'no-video';
  const audio = result.audio.map((s) => `${s.codec_name}/${s.channels ?? '?'}ch`).join('+')
    || 'NO AUDIO';
  const subs = result.subtitles.length;

  return `${result.file.container === target ? '' : `${result.file.container} `}`
    + `${video} | ${audio} | subs:${subs}${result.replaced ? '' : ' | NOT REPLACED'}`;
}

function findAnomalies(
  variant: Variant,
  result: SimulationResult,
  options: FuzzOptions,
): Anomaly[] {
  const anomalies: Anomaly[] = [];
  if (result.halted) return anomalies; // the halt is the finding

  const target = options.targetContainer ?? 'mkv';
  const targetVideo = options.targetVideoCodec ?? 'hevc';
  const inputStreams = variant.file.ffProbeData.streams ?? [];

  const hadAudio = inputStreams.some((s) => s.codec_type === 'audio');
  // Only subtitles the flow is meant to KEEP count. Dropping foreign subs is
  // the whole point of the cleanup step, and flagging it buries real findings.
  const keepLanguage = (options.keepLanguage ?? 'eng').toLowerCase();
  const hadSubs = inputStreams.some((s) => {
    if (s.codec_type !== 'subtitle') return false;
    if (s.codec_name === 'mov_text') return false; // dropped on purpose: MKV cannot carry it
    const language = (s.tags?.language ?? '').toLowerCase();
    return language === '' || language === keepLanguage;
  });
  const hadVideo = inputStreams.some(
    (s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1,
  );

  const changed = result.file.container !== result.original.container
    || JSON.stringify(result.file.streams) !== JSON.stringify(result.original.streams);

  // The flow ran, changed nothing, and committed nothing - it deliberately
  // declined this file. That is correct for a file with no media in it (a
  // subtitle-only file has nothing to transcode, and an unreadable one cannot
  // be read), and a defect for anything else. Judging container or codec
  // targets against a file the flow never touched only produces noise, so the
  // distinction is drawn here rather than exempting skips wholesale.
  if (!result.replaced && !changed) {
    const inScope = options.videoOnly ? hadVideo : hadVideo || hadAudio;
    if (inScope) anomalies.push('skipped-with-media');
    return anomalies;
  }

  if (hadAudio && result.audio.length === 0) anomalies.push('silent');

  if (result.audio.length > (options.maxAudioTracks ?? 2)) anomalies.push('multiple-audio');

  // Two tracks of the same kind is a defect under any policy: it means a
  // generated track landed beside the original it was meant to replace.
  const surroundMin = options.surroundMinChannels ?? 4;
  const surroundCount = result.audio.filter((s) => (s.channels ?? 0) >= surroundMin).length;
  const otherCount = result.audio.length - surroundCount;
  if (surroundCount > 1 || otherCount > 1) anomalies.push('duplicate-audio');
  if (result.file.container !== target) anomalies.push('not-target-container');
  if (hadSubs && result.subtitles.length === 0) anomalies.push('lost-subtitles');
  if (!result.replaced) anomalies.push('not-replaced');
  if (hadVideo && result.video[0] && result.video[0].codec_name !== targetVideo) {
    anomalies.push('video-not-target-codec');
  }

  return anomalies;
}

export interface FuzzReport {
  flowName: string;
  total: number;
  generated: number;
  outcomes: FuzzOutcome[];
  halted: FuzzOutcome[];
  anomalous: FuzzOutcome[];
  clean: FuzzOutcome[];
}

export function fuzz(flow: Flow, options: FuzzOptions = {}): FuzzReport {
  const generated = allVariants({ containers: options.containers }).length;
  const variants = generateVariants(options);

  // Build the registry once; rebuilding it per variant dominates the runtime.
  const registry = options.registry ?? buildRegistry(options);

  const outcomes = variants.map((variant) => {
    const result = simulate(flow, variant.file, { ...options, registry });
    return {
      variant,
      result,
      shape: describeShape(result, options.targetContainer ?? 'mkv'),
      anomalies: findAnomalies(variant, result, options),
    };
  });

  return {
    flowName: flow.name,
    total: outcomes.length,
    generated,
    outcomes,
    halted: outcomes.filter((o) => o.result.halted !== null),
    anomalous: outcomes.filter((o) => o.result.halted === null && o.anomalies.length > 0),
    clean: outcomes.filter((o) => o.result.halted === null && o.anomalies.length === 0),
  };
}

/** Groups outcomes that tell the same story, so the report stays readable. */
export function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    groups.set(k, [...(groups.get(k) ?? []), item]);
  }
  return new Map([...groups].sort((a, b) => b[1].length - a[1].length));
}

export const ANOMALY_EXPLANATION: Record<Anomaly, string> = {
  silent: 'input had audio, output has none',
  'not-target-container': 'did not end up in the target container',
  'multiple-audio': 'more audio streams survived than the policy allows',
  'duplicate-audio':
    'two audio streams of the same kind survived (two surround, or two stereo/mono)',
  'not-replaced': 'file was modified but the result was never committed',
  'skipped-with-media':
    'flow declined to touch a file that has video or audio streams',
  'lost-subtitles': 'input had subtitles, output has none',
  'video-not-target-codec': 'video was not transcoded to the target codec',
};
