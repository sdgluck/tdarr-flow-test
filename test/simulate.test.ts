import { describe, expect, it } from 'vitest';

import { probe, simulate } from '../src/index.ts';
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

  it('reports a dead end rather than silently stopping', () => {
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

    expect(result.halted?.kind).toBe('deadEnd');
    expect(result.halted?.message).toContain('handle 2');
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
});
