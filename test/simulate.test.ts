import { describe, expect, it } from 'vitest';

import { buildRegistry, probe, simulate } from '../src/index.ts';
import { audioFlow, edge, makeFlow, node } from './fixtures.ts';

describe('simulate', () => {
  it('takes the skip branch when the file already has the target codec', () => {
    const file = probe.file({
      streams: [probe.video(), probe.audio({ codec: 'eac3', channels: 6 })],
    });

    const result = simulate(audioFlow(), file);

    expect(result.halted).toBeNull();
    expect(result.didVisit('start')).toBe(false);
    expect(result.replaced).toBe(true);
  });

  it('adds a stream and drops the incompatible one when the codec is missing', () => {
    const file = probe.file({
      streams: [probe.video(), probe.audio({ codec: 'dts', channels: 6 })],
    });

    const result = simulate(audioFlow(), file);

    expect(result.halted).toBeNull();
    expect(result.audio).toHaveLength(1);
    expect(result.audio[0]?.codec_name).toBe('eac3');
    expect(result.audio[0]?.channels).toBe(6);
  });

  it('clamps the added stream to the source channel count', () => {
    const file = probe.file({
      streams: [probe.video(), probe.audio({ codec: 'dts', channels: 2 })],
    });

    // The ensure node asks for 6 channels; a stereo source must stay stereo.
    expect(simulate(audioFlow(), file).audio[0]?.channels).toBe(2);
  });

  it('reports a crash when ffprobe found no streams at all', () => {
    const result = simulate(audioFlow(), probe.unreadableFile({ container: 'mp4' }));

    expect(result.halted?.kind).toBe('crash');
    expect(result.halted?.message).toContain('ffmpegCommandStart');
    expect(result.replaced).toBe(false);
  });

  it('ends the flow, without committing, when a handle has no edge', () => {
    // This is how Tdarr behaves, and it is how a deliberate "stop, do nothing"
    // branch is expressed. An *accidental* one is lint's job, not the
    // simulator's - see the unwired-handle rule.
    const flow = makeFlow(
      [
        node('in', 'inputFile'),
        node('check', 'checkAudioCodec', { codec: 'eac3' }),
        node('replace', 'replaceOriginalFile'),
      ],
      [edge('in', '1', 'check'), edge('check', '1', 'replace')],
    );

    // A file with no eac3 leaves by handle 2, which is not wired anywhere.
    const file = probe.file({ streams: [probe.video(), probe.audio({ codec: 'aac' })] });
    const result = simulate(flow, file);

    expect(result.halted).toBeNull();
    expect(result.replaced).toBe(false);
    expect(result.visited).toEqual(['in', 'check']);
  });

  it('records the path it took, in order', () => {
    const file = probe.file({ streams: [probe.video(), probe.audio({ codec: 'eac3' })] });
    expect(simulate(audioFlow(), file).visited).toEqual(['in', 'hasEac3', 'replace']);
  });

  it('routes on the node name for checkFlowVariable', () => {
    const flow = makeFlow(
      [
        node('in', 'inputFile'),
        node('isNvidia', 'checkFlowVariable', {
          variable: '{{{args.configVars.config.nodeName}}}',
          value: 'Nvidia',
        }),
        node('yes', 'replaceOriginalFile'),
        node('no', 'setOriginalFile'),
        node('end', 'replaceOriginalFile'),
      ],
      [
        edge('in', '1', 'isNvidia'),
        edge('isNvidia', '1', 'yes'),
        edge('isNvidia', '2', 'no'),
        edge('no', '1', 'end'),
      ],
    );
    const file = probe.file({ streams: [probe.video()] });

    expect(simulate(flow, file, { nodeName: 'Nvidia' }).visited).toContain('yes');
    expect(simulate(flow, file, { nodeName: 'Intel' }).visited).toContain('no');
  });

  it('leaves the original file alone when the flow never reaches Replace', () => {
    const result = simulate(audioFlow(), probe.unreadableFile());
    expect(result.replaced).toBe(false);
  });

  it('refuses a command where two streams fight over an unqualified option', () => {
    // ffmpeg applies "-ac 6" to EVERY output stream unless it carries a stream
    // specifier, so a second "-ac 2" silently wins for both and the surround
    // track comes out stereo. ffmpeg reports success; only a buried warning
    // hints at it. This cost a real 5.1 track before the check existed.
    const registry = buildRegistry();
    registry.register('addConflictingAudio', {
      outputs: 1,
      error: false,
      confidence: 'observed',
      run: (ctx) => {
        ctx.ffmpegCommand?.streams.push(
          {
            index: 1,
            codec_type: 'audio',
            codec_name: 'eac3',
            channels: 6,
            removed: false,
            inputArgs: [],
            outputArgs: ['-c:{outputIndex}', 'eac3', '-ac', '6'],
          },
          {
            index: 2,
            codec_type: 'audio',
            codec_name: 'eac3',
            channels: 2,
            removed: false,
            inputArgs: [],
            outputArgs: ['-c:{outputIndex}', 'eac3', '-ac', '2'],
          },
        );
        if (ctx.ffmpegCommand) ctx.ffmpegCommand.shouldProcess = true;
        return '1';
      },
    });

    const flow = makeFlow(
      [
        node('in', 'inputFile'),
        node('start', 'ffmpegCommandStart'),
        node('add', 'addConflictingAudio'),
        node('exec', 'ffmpegCommandExecute'),
        node('replace', 'replaceOriginalFile'),
      ],
      [
        edge('in', '1', 'start'),
        edge('start', '1', 'add'),
        edge('add', '1', 'exec'),
        edge('exec', '1', 'replace'),
      ],
    );

    const file = probe.file({ streams: [probe.video(), probe.audio({ codec: 'ac3', channels: 6 })] });
    const result = simulate(flow, file, { registry });

    expect(result.halted?.kind).toBe('crash');
    expect(result.halted?.message).toContain('-ac');
    expect(result.halted?.message).toContain('stream specifier');
    expect(result.replaced).toBe(false);
  });
});
