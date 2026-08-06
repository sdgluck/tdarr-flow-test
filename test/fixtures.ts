import { Flow } from '../src/index.ts';
import type { FlowEdge, FlowJson, FlowNode } from '../src/types/flow.ts';

let seq = 0;

export function node(
  id: string,
  pluginName: string,
  inputsDB: Record<string, string> = {},
  overrides: Partial<FlowNode> = {},
): FlowNode {
  seq += 1;
  return {
    id,
    name: overrides.name ?? id,
    sourceRepo: 'Community',
    pluginName,
    version: '1.0.0',
    fpEnabled: true,
    inputsDB,
    position: { x: 0, y: seq * 100 },
    ...overrides,
  };
}

export function edge(source: string, sourceHandle: string, target: string): FlowEdge {
  return {
    id: `${source}-${sourceHandle}-${target}`,
    source,
    sourceHandle,
    target,
    targetHandle: null,
  };
}

export function makeFlow(nodes: FlowNode[], edges: FlowEdge[], name = 'test flow'): Flow {
  const raw: FlowJson = {
    _id: 'test_flow',
    name,
    flowPlugins: nodes,
    flowEdges: edges,
  };
  return new Flow(raw);
}

/**
 * A small but complete flow: check whether the file already has E-AC3, and if
 * not, run a command block that adds one.
 */
export function audioFlow(): Flow {
  return makeFlow(
    [
      node('in', 'inputFile'),
      node('hasEac3', 'checkAudioCodec', { codec: 'eac3' }),
      node('start', 'ffmpegCommandStart'),
      node('ensure', 'ffmpegCommandEnsureAudioStream', {
        audioEncoder: 'eac3',
        language: 'eng',
        channels: '6',
        enableBitrate: 'true',
        bitrate: '384k',
      }),
      node('drop', 'ffmpegCommandRemoveStreamByProperty', {
        codecType: 'audio',
        propertyToCheck: 'codec_name',
        valuesToRemove: 'eac3',
        condition: 'not_equals',
      }),
      node('exec', 'ffmpegCommandExecute'),
      node('replace', 'replaceOriginalFile'),
    ],
    [
      edge('in', '1', 'hasEac3'),
      edge('hasEac3', '1', 'replace'),
      edge('hasEac3', '2', 'start'),
      edge('start', '1', 'ensure'),
      edge('ensure', '1', 'drop'),
      edge('drop', '1', 'exec'),
      edge('exec', '1', 'replace'),
    ],
  );
}
