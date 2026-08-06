import type { FfProbeStream } from '../types/ffprobe.ts';
import type { FlowNode, OutputHandle } from '../types/flow.ts';
import type { FfmpegCommandStream } from '../types/flowPlugin.ts';
import { loadClassicPlugin, splitSourceId } from '../loaders/loadPlugin.ts';
import {
  activeCommandStreams,
  isAttachedPic,
  isAudio,
  isVideo,
  languageOf,
  newFfmpegCommand,
  renumber,
  streamsVisibleToChecks,
  type SimContext,
} from './context.ts';
import { HaltError, NodeRegistry, type NodeModel } from './registry.ts';

export interface BuiltinOptions {
  /** Directory holding classic `Tdarr_Plugin_*.js` source. */
  classicPluginDir?: string;
  /**
   * Behaviour for classic plugins whose source is not available locally
   * (anything from the Community repo), keyed by plugin id. Without an entry,
   * a community classic plugin is modelled as a generic video encoder.
   */
  communityClassicPlugins?: Record<string, (ctx: SimContext, node: FlowNode) => OutputHandle>;
}

const inputs = (node: FlowNode): Record<string, string> => node.inputsDB ?? {};

const pass = (): OutputHandle => '1';

/** Every node that just continues, with no effect worth modelling. */
const passthrough = (note: string, confidence: NodeModel['confidence'] = 'observed'): NodeModel => ({
  outputs: 1,
  error: false,
  confidence,
  note,
  run: pass,
});

// --- core -------------------------------------------------------------------

const core: Record<string, NodeModel> = {
  inputFile: passthrough('entry node; hands the library file to the flow'),

  resetFlowError: {
    outputs: 1,
    error: false,
    confidence: 'observed',
    note: 'clears flowFailed so the flow continues past a failed node',
    run: pass,
  },

  runMkvPropEdit: {
    outputs: 1,
    error: true,
    confidence: 'observed',
    note: 'rewrites statistics tags; fails on non-Matroska input',
    run: (ctx) => {
      if (ctx.file.container !== 'mkv') {
        ctx.say('mkvpropedit refused a non-Matroska file');
        return 'err1';
      }
      return '1';
    },
  },

  setOriginalFile: {
    outputs: 1,
    error: false,
    confidence: 'assumed',
    note: 'discards the working file and reverts to the original library file',
    run: (ctx) => {
      ctx.file = { ...ctx.original, streams: renumber(ctx.original.streams) };
      ctx.say('reverted to the original file');
      return '1';
    },
  },

  replaceOriginalFile: {
    outputs: 1,
    error: false,
    confidence: 'assumed',
    terminal: true,
    note: 'terminal; commits the working file over the library file',
    run: (ctx) => {
      ctx.replaced = true;
      return null;
    },
  },

  checkFileChanged: {
    outputs: 2,
    error: false,
    confidence: 'assumed',
    note: 'compares the working file against the original by path and size',
    run: (ctx) => {
      const changed = ctx.file.container !== ctx.original.container
        || ctx.file.size !== ctx.original.size
        || JSON.stringify(ctx.file.streams) !== JSON.stringify(ctx.original.streams);
      ctx.say(changed ? 'file changed' : 'file unchanged');
      return changed ? '1' : '2';
    },
  },

  compareFileSizeRatio: {
    outputs: 2,
    error: false,
    confidence: 'observed',
    note:
      'CONFIRMED 2 handles, from the real plugin source: 1 = within range, '
      + '2 = not within range. A flow wiring a handle 3 has a dead edge.',
    run: (ctx, node) => {
      const cfg = inputs(node);
      const pct = (ctx.file.size / ctx.original.size) * 100;
      const within = pct > Number(cfg.greaterThan ?? 0) && pct < Number(cfg.lessThan ?? 100);
      ctx.say(`${pct.toFixed(1)}% of original (${within ? 'within' : 'outside'} range)`);
      return within ? '1' : '2';
    },
  },

  checkFlowVariable: {
    outputs: 2,
    error: false,
    confidence: 'observed',
    note: 'string equality against a templated flow variable',
    run: (ctx, node) => {
      const cfg = inputs(node);
      // The common use is templating the node name in; the harness substitutes
      // the configured nodeName for any {{{...nodeName}}} expression.
      const variable = cfg.variable ?? '';
      const resolved = variable.includes('nodeName') ? ctx.nodeName : variable;
      return resolved === cfg.value ? '1' : '2';
    },
  },

  checkFileExtension: {
    outputs: 2,
    error: false,
    confidence: 'observed',
    note: 'matches the working file container against a comma-separated list',
    run: (ctx, node) => {
      const wanted = String(inputs(node).extensions ?? '')
        .split(',')
        .map((ext) => ext.trim().toLowerCase())
        .filter(Boolean);
      return wanted.includes(ctx.file.container.toLowerCase()) ? '1' : '2';
    },
  },
};

// --- stream checks ----------------------------------------------------------

const checks: Record<string, NodeModel> = {
  checkVideoCodec: {
    outputs: 2,
    error: false,
    confidence: 'observed',
    note: 'matches the first non-thumbnail video stream',
    run: (ctx, node) => {
      const video = streamsVisibleToChecks(ctx).find((s) => isVideo(s) && !isAttachedPic(s));
      const hit = video?.codec_name === inputs(node).codec;
      ctx.say(`video is ${video?.codec_name ?? 'absent'}; ${hit ? 'match' : 'no match'}`);
      return hit ? '1' : '2';
    },
  },

  checkAudioCodec: {
    outputs: 2,
    error: false,
    confidence: 'observed',
    note: 'true if ANY audio stream matches - not the stream the flow will keep',
    run: (ctx, node) => {
      const codec = inputs(node).codec;
      const hit = streamsVisibleToChecks(ctx).some((s) => isAudio(s) && s.codec_name === codec);
      ctx.say(`has ${codec}? ${hit ? 'yes' : 'no'}`);
      return hit ? '1' : '2';
    },
  },

  checkChannelCount: {
    outputs: 2,
    error: false,
    confidence: 'observed',
    note: 'EXACT channel match, not >=. Ladders must be ordered largest-first.',
    run: (ctx, node) => {
      const want = Number(inputs(node).channelCount);
      const hit = streamsVisibleToChecks(ctx).some((s) => isAudio(s) && s.channels === want);
      ctx.say(`${want}ch? ${hit ? 'yes' : 'no'}`);
      return hit ? '1' : '2';
    },
  },
};

// --- ffmpeg command block ---------------------------------------------------

const ffmpegCommand: Record<string, NodeModel> = {
  ffmpegCommandStart: {
    outputs: 1,
    error: false,
    confidence: 'observed',
    note:
      'Snapshots the stream list. Has NO error handle, and throws outright when '
      + 'ffprobe returned nothing - an unreadable source kills the whole job here.',
    run: (ctx) => {
      // Mirrors the real plugin, which does
      // JSON.parse(JSON.stringify(ffProbeData.streams)) - that throws when the
      // property is absent, and succeeds on an empty array.
      if (ctx.file.probeFailed) {
        throw new HaltError(
          'crash',
          'ffmpegCommandStart: Error parsing FFprobe streams, it seems FFprobe '
            + 'could not scan the file: {}',
        );
      }
      ctx.ffmpegCommand = newFfmpegCommand(ctx.file);
      return '1';
    },
  },

  ffmpegCommandSetContainer: {
    outputs: 1,
    error: false,
    confidence: 'assumed',
    note: 'pins the output container for the command block',
    run: (ctx, node) => {
      const command = ctx.ffmpegCommand;
      if (!command) throw new HaltError('crash', 'Set Container ran outside a command block');
      const container = inputs(node).container ?? command.container;
      if (container !== command.container) {
        command.container = container;
        command.shouldProcess = true;
        ctx.say(`container pinned to ${container}`);
      }
      return '1';
    },
  },

  ffmpegCommandEnsureAudioStream: {
    outputs: 1,
    error: false,
    confidence: 'assumed',
    note:
      'Adds a transcoded audio stream when none matches. Channel count clamps to '
      + 'min(requested, source). ASSUMES candidate sources are filtered by the '
      + 'configured language tag.',
    run: (ctx, node) => {
      const command = ctx.ffmpegCommand;
      if (!command) throw new HaltError('crash', 'Ensure Audio ran outside a command block');
      const cfg = inputs(node);
      const wantCodec = cfg.audioEncoder ?? 'aac';
      const wantLang = (cfg.language ?? '').toLowerCase();
      const wantChannels = Number(cfg.channels ?? 2);

      const audio = activeCommandStreams(ctx).filter(isAudio);

      const satisfied = audio.find(
        (s) => s.codec_name === wantCodec && (!wantLang || languageOf(s) === wantLang),
      );
      if (satisfied) {
        ctx.say(`${wantCodec} already present, nothing to add`);
        return '1';
      }

      // ASSUMPTION: sources are filtered by language tag, so untagged audio
      // yields no candidate and this node silently does nothing.
      const candidates = wantLang ? audio.filter((s) => languageOf(s) === wantLang) : audio;
      const source = candidates.reduce<FfmpegCommandStream | null>(
        (best, s) => (best === null || (s.channels ?? 0) > (best.channels ?? 0) ? s : best),
        null,
      );
      if (!source) {
        ctx.say(`no ${wantLang || 'audio'} source stream to convert; no stream added`);
        return '1';
      }

      const channels = Math.min(wantChannels, source.channels ?? wantChannels);
      const bitrate = cfg.enableBitrate === 'true' ? cfg.bitrate : undefined;
      ctx.say(
        `adding ${wantCodec} ${channels}ch${bitrate ? ` @ ${bitrate}` : ''} `
          + `from stream ${source.index}`,
      );
      command.streams.push({
        index: command.streams.length,
        codec_type: 'audio',
        codec_name: wantCodec,
        channels,
        bit_rate: bitrate ? String(Number.parseInt(bitrate, 10) * 1000) : undefined,
        disposition: {},
        tags: wantLang ? { language: wantLang } : {},
        removed: false,
        inputArgs: [],
        outputArgs: [`-c:a ${wantCodec}`],
      });
      command.shouldProcess = true;
      return '1';
    },
  },

  ffmpegCommandRemoveStreamByProperty: {
    outputs: 1,
    error: false,
    confidence: 'assumed',
    note:
      'Marks streams removed by property comparison. The *includes* conditions '
      + 'do substring matching, so "eac3".includes("ac3") is true.',
    run: (ctx, node) => {
      const command = ctx.ffmpegCommand;
      if (!command) throw new HaltError('crash', 'Remove Stream ran outside a command block');
      const cfg = inputs(node);
      const values = String(cfg.valuesToRemove ?? '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean);
      const property = cfg.propertyToCheck ?? 'codec_name';

      let removed = 0;
      for (const stream of command.streams) {
        if (stream.removed) continue;
        if (cfg.codecType && stream.codec_type !== cfg.codecType) continue;

        const actual = String((stream as unknown as Record<string, unknown>)[property] ?? '');
        let shouldRemove: boolean;
        switch (cfg.condition) {
          case 'equals':
            shouldRemove = values.includes(actual);
            break;
          case 'not_equals':
            shouldRemove = !values.includes(actual);
            break;
          case 'includes':
            shouldRemove = values.some((value) => actual.includes(value));
            break;
          case 'not_includes':
            shouldRemove = !values.some((value) => actual.includes(value));
            break;
          default:
            throw new HaltError('unmodelled', `unknown condition "${cfg.condition}"`);
        }

        if (shouldRemove) {
          stream.removed = true;
          removed += 1;
        }
      }

      if (removed > 0) {
        command.shouldProcess = true;
        ctx.say(`marked ${removed} ${cfg.codecType ?? ''} stream(s) for removal`.trim());
      }
      return '1';
    },
  },

  ffmpegCommandRorderStreams: {
    outputs: 1,
    error: false,
    confidence: 'assumed',
    note: 'sorts the pending stream list; only streamTypes is modelled',
    run: (ctx, node) => {
      const command = ctx.ffmpegCommand;
      if (!command) throw new HaltError('crash', 'Reorder ran outside a command block');
      const order = String(inputs(node).streamTypes ?? 'video,audio,subtitle')
        .split(',')
        .map((type) => type.trim());
      command.streams.sort(
        (a, b) => order.indexOf(a.codec_type) - order.indexOf(b.codec_type),
      );
      return '1';
    },
  },

  ffmpegCommandExecute: {
    outputs: 1,
    error: true,
    confidence: 'assumed',
    note:
      'materialises the pending command. Modelled rather than executed because '
      + 'the real plugin is async and spawns ffmpeg, but its shouldProcess '
      + 'derivation is reproduced from source.',
    run: (ctx) => {
      const command = ctx.ffmpegCommand;
      if (!command) throw new HaltError('crash', 'Execute ran outside a command block');

      // Execute re-derives shouldProcess rather than trusting the flag: several
      // stock nodes (removeStreamByProperty among them) mark streams removed
      // without ever setting it. Gating on the flag alone silently drops their
      // work.
      const shouldProcess = command.shouldProcess
        || command.overallInputArguments.length > 0
        || command.overallOuputArguments.length > 0
        || command.streams.some((stream) => stream.removed);

      if (command.streams.filter((stream) => !stream.removed).length === 0) {
        throw new HaltError('crash', 'No streams mapped for new file');
      }

      if (!shouldProcess) {
        ctx.say('No need to process file, already as required');
        return '1';
      }

      // Drop the command-only bookkeeping fields; what is left is what ffmpeg
      // would have written to the output file.
      const kept: FfProbeStream[] = command.streams
        .filter((stream) => !stream.removed)
        .map((stream) => {
          const plain: Record<string, unknown> = { ...stream };
          delete plain.removed;
          delete plain.inputArgs;
          delete plain.outputArgs;
          return plain as unknown as FfProbeStream;
        });

      ctx.file = {
        ...ctx.file,
        container: command.container,
        streams: renumber(kept),
      };
      ctx.say(`executed; ${kept.length} stream(s) written to ${command.container}`);
      ctx.ffmpegCommand = null;
      return '1';
    },
  },
};

// --- classic plugin bridge --------------------------------------------------

function makeClassicRunner(options: BuiltinOptions): NodeModel {
  return {
    outputs: 2,
    error: true,
    confidence: 'observed',
    note: 'runs a classic plugin, then its ffmpeg preset, as a separate full pass',
    run: (ctx, node) => {
      const sourceId = inputs(node).pluginSourceId;
      if (!sourceId) throw new HaltError('unmodelled', `${node.id} has no pluginSourceId`);
      const { repo, id } = splitSourceId(sourceId);

      if (repo !== 'Local') {
        const override = options.communityClassicPlugins?.[id];
        if (override) return override(ctx, node);
        return genericEncoder(ctx, id);
      }

      if (!options.classicPluginDir) {
        throw new HaltError(
          'unmodelled',
          `${node.name} runs local classic plugin "${id}" but no classicPluginDir was configured`,
        );
      }

      const { plugin } = loadClassicPlugin(id, { dir: options.classicPluginDir });
      const response = plugin(
        {
          _id: ctx.file.path,
          file: ctx.file.path,
          container: ctx.file.container,
          file_size: ctx.file.size,
          ffProbeData: ctx.file.probeFailed ? {} : { streams: ctx.file.streams },
        },
        {},
        { ...inputs(node) },
        {},
      );

      for (const line of response.infoLog.split('\n').map((l) => l.trim()).filter(Boolean)) {
        ctx.say(line);
      }

      if (!response.processFile) return '2';

      // The plugin decided to run ffmpeg. If ffprobe never read the file,
      // ffmpeg cannot open it either, and the node takes its error handle.
      if (ctx.file.probeFailed) {
        ctx.say('ffmpeg could not open the input');
        return 'err1';
      }

      ctx.file = {
        ...ctx.file,
        container: response.container.replace(/^\./, '') || ctx.file.container,
        streams: renumber(applyPreset(ctx.file.streams, response.preset)),
      };
      return '1';
    },
  };
}

/**
 * Applies a classic plugin's preset to a stream list: explicit negative maps
 * remove streams, `-map 0:V:0` drops attached pictures, and an absent
 * `-map 0:s?` drops subtitles.
 */
function applyPreset(streams: FfProbeStream[], preset: string): FfProbeStream[] {
  const removed = new Set(
    [...preset.matchAll(/-map\s+-0:(\d+)/g)].map((match) => Number(match[1])),
  );

  let out = streams.filter((stream) => !removed.has(stream.index));
  if (/-map\s+0:V:0/.test(preset)) out = out.filter((stream) => !isAttachedPic(stream));
  if (!/-map\s+0:s\??/.test(preset)) out = out.filter((stream) => stream.codec_type !== 'subtitle');
  return out;
}

/** Fallback for community classic plugins whose source is not available. */
function genericEncoder(ctx: SimContext, id: string): OutputHandle {
  const video = ctx.file.streams.find((s) => isVideo(s) && !isAttachedPic(s));
  if (!video) {
    ctx.say(`${id}: file is not a video, skipping`);
    return '2';
  }
  ctx.say(`${id}: modelled generically as a video encoder`);
  ctx.file = {
    ...ctx.file,
    size: Math.round(ctx.original.size * ctx.transcodeRatio),
    streams: ctx.file.streams.map((s) => (s === video ? { ...s, codec_name: 'hevc' } : s)),
  };
  return '1';
}

/** A registry preloaded with every stock node this library models. */
export function builtinRegistry(options: BuiltinOptions = {}): NodeRegistry {
  return new NodeRegistry()
    .registerAll(core)
    .registerAll(checks)
    .registerAll(ffmpegCommand)
    .register('runClassicTranscodePlugin', makeClassicRunner(options));
}
