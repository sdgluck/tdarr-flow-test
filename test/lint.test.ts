import { describe, expect, it } from 'vitest';

import { builtinRegistry, lint } from '../src/index.ts';
import { audioFlow, edge, makeFlow, node } from './fixtures.ts';

const registry = builtinRegistry();
const rules = (flow: Parameters<typeof lint>[0], ignore?: string[]) =>
  lint(flow, { registry, ignore }).map((finding) => finding.rule);

describe('lint', () => {
  it('passes a well-formed flow', () => {
    const findings = lint(audioFlow(), { registry }).filter((f) => f.severity === 'error');
    expect(findings).toEqual([]);
  });

  it('flags an edge on a handle the plugin does not have', () => {
    // The defect that is invisible in the editor: a handle-3 edge on a
    // two-output node looks identical to one that works.
    const flow = makeFlow(
      [
        node('in', 'inputFile'),
        node('check', 'checkAudioCodec', { codec: 'aac' }),
        node('a', 'replaceOriginalFile'),
        node('b', 'setOriginalFile'),
      ],
      [
        edge('in', '1', 'check'),
        edge('check', '1', 'a'),
        edge('check', '2', 'a'),
        edge('check', '3', 'b'),
      ],
    );

    const findings = lint(flow, { registry });
    const nonexistent = findings.find((f) => f.rule === 'nonexistent-handle');
    expect(nonexistent?.severity).toBe('error');
    expect(nonexistent?.message).toContain('handle 3');
  });

  it('flags an error edge on a node with no err1 handle', () => {
    const flow = makeFlow(
      [
        node('in', 'inputFile'),
        node('start', 'ffmpegCommandStart'),
        node('reset', 'resetFlowError'),
        node('replace', 'replaceOriginalFile'),
      ],
      [
        edge('in', '1', 'start'),
        edge('start', '1', 'replace'),
        edge('start', 'err1', 'reset'),
        edge('reset', '1', 'replace'),
      ],
    );

    expect(rules(flow)).toContain('nonexistent-handle');
  });

  it('warns when a node that can fail has no error edge', () => {
    const flow = makeFlow(
      [
        node('in', 'inputFile'),
        node('prop', 'runMkvPropEdit'),
        node('replace', 'replaceOriginalFile'),
      ],
      [edge('in', '1', 'prop'), edge('prop', '1', 'replace')],
    );

    expect(rules(flow)).toContain('missing-error-edge');
  });

  it('scopes an ignore to a single node', () => {
    const flow = makeFlow(
      [
        node('in', 'inputFile'),
        node('prop', 'runMkvPropEdit'),
        node('replace', 'replaceOriginalFile'),
      ],
      [edge('in', '1', 'prop'), edge('prop', '1', 'replace')],
    );

    expect(rules(flow, ['missing-error-edge:prop'])).not.toContain('missing-error-edge');
    expect(rules(flow, ['missing-error-edge:somethingElse'])).toContain('missing-error-edge');
  });

  it('flags an island of nodes that cannot be reached from the entry', () => {
    // The island edges into itself, so both its nodes have inbound edges and
    // neither registers as a second entry - reachability is the only thing
    // that catches it.
    const flow = makeFlow(
      [
        node('in', 'inputFile'),
        node('replace', 'replaceOriginalFile'),
        node('islandA', 'resetFlowError'),
        node('islandB', 'resetFlowError'),
      ],
      [
        edge('in', '1', 'replace'),
        edge('islandA', '1', 'islandB'),
        edge('islandB', '1', 'islandA'),
      ],
    );

    const unreachable = lint(flow, { registry })
      .filter((f) => f.rule === 'unreachable-node')
      .map((f) => f.nodeId);
    expect(unreachable).toEqual(['islandA', 'islandB']);
  });

  it('flags a disconnected node with no inbound edge as a second entry', () => {
    const flow = makeFlow(
      [
        node('in', 'inputFile'),
        node('replace', 'replaceOriginalFile'),
        node('orphan', 'resetFlowError'),
      ],
      [edge('in', '1', 'replace'), edge('orphan', '1', 'replace')],
    );

    const finding = lint(flow, { registry }).find((f) => f.rule === 'entry-node');
    expect(finding?.severity).toBe('error');
    expect(finding?.message).toContain('orphan');
  });

  it('warns when the same plugin is used at more than one version', () => {
    const flow = makeFlow(
      [
        node('in', 'inputFile'),
        node('p1', 'runMkvPropEdit', {}, { version: '1.0.0' }),
        node('p2', 'runMkvPropEdit', {}, { version: '2.0.0' }),
        node('replace', 'replaceOriginalFile'),
      ],
      [
        edge('in', '1', 'p1'),
        edge('p1', '1', 'p2'),
        edge('p1', 'err1', 'p2'),
        edge('p2', '1', 'replace'),
        edge('p2', 'err1', 'replace'),
      ],
    );

    expect(rules(flow)).toContain('mixed-plugin-versions');
  });

  it('warns when two nodes sit on the same coordinates', () => {
    const flow = makeFlow(
      [
        node('in', 'inputFile', {}, { position: { x: 10, y: 10 } }),
        node('replace', 'replaceOriginalFile', {}, { position: { x: 10, y: 10 } }),
      ],
      [edge('in', '1', 'replace')],
    );

    expect(rules(flow)).toContain('overlapping-nodes');
  });

  it('marks findings that rest on an assumed model', () => {
    // A finding is only as good as the model it compared against, so the
    // distinction has to survive into the output.
    const guessy = registry.clone();
    guessy.register('checkAudioCodec', {
      outputs: 2,
      error: false,
      confidence: 'assumed',
      run: () => '1',
    });

    const flow = makeFlow(
      [
        node('in', 'inputFile'),
        node('check', 'checkAudioCodec', { codec: 'aac' }),
        node('a', 'replaceOriginalFile'),
        node('b', 'setOriginalFile'),
      ],
      [
        edge('in', '1', 'check'),
        edge('check', '1', 'a'),
        edge('check', '2', 'a'),
        edge('check', '3', 'b'),
      ],
    );

    const finding = lint(flow, { registry: guessy }).find((f) => f.rule === 'nonexistent-handle');
    expect(finding?.assumed).toBe(true);
    expect(finding?.message).toContain('ASSUMED');
  });

  it('does not mark findings that rest on real plugin source', () => {
    const flow = makeFlow(
      [
        node('in', 'inputFile'),
        node('ratio', 'compareFileSizeRatio', { greaterThan: '0', lessThan: '100' }),
        node('a', 'replaceOriginalFile'),
        node('b', 'setOriginalFile'),
      ],
      [
        edge('in', '1', 'ratio'),
        edge('ratio', '1', 'a'),
        edge('ratio', '2', 'a'),
        edge('ratio', '3', 'b'),
      ],
    );

    const finding = lint(flow, { registry }).find((f) => f.rule === 'nonexistent-handle');
    expect(finding?.severity).toBe('error');
    expect(finding?.assumed).toBeFalsy();
  });
});
