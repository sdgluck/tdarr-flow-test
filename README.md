# tdarr-flow-test

> Lint, unit test, simulate and fuzz [Tdarr](https://github.com/HaveAGitGat/Tdarr) flows

:mag: Lint a flow graph for impossible edges, unreachable nodes and unhandled failures.

:test_tube: Run your classic and flow plugins from real source, no reimplementation.

:arrows_counterclockwise: Walk a synthetic file through a flow and assert where it lands.

:game_die: Fuzz thousands of file shapes and group the outcomes.

:point_right: Executes the real stock Tdarr plugins, vendored from source.

:warning: Never runs ffmpeg. Use an end-to-end run for anything about ffmpeg's actual output.

## Install

```sh
pnpm add -D tdarr-flow-test
```

```sh
npm install --save-dev tdarr-flow-test
```

Requires Node 24+. Ships TypeScript source, executed by Node's native type
stripping. No build step.

## Import

```js
import { Flow, lint, simulate, fuzz, probe } from 'tdarr-flow-test'
```

## Vendor plugin source

```sh
pnpm plugins:update              # latest master
pnpm plugins:update --ref <sha>  # pin to a commit
```

Pulls `FlowPlugins/CommunityFlowPlugins`, `FlowPlugins/FlowHelpers` and
`methods/` from `HaveAGitGat/Tdarr_Plugins` into `vendor/`. Resolved commit is
written to `vendor/VERSION.json`.

Without it, stock nodes fall back to hand-written models.

## CLI

```sh
tdarr-test lint <flow.json...>
tdarr-test lint --server <url>
tdarr-test fuzz <flow.json>
tdarr-test flows --server <url>
tdarr-test pull <name|id> --server <url> --out <file>
tdarr-test plugins
```

- __--classic-plugins__ {String} Directory of `Tdarr_Plugin_*.js`
- __--flow-plugins__ {String} `LocalFlowPlugins` directory
- __--ignore__ {String} Comma-separated lint rules, e.g. `missing-error-edge:nodeId`
- __--warnings-as-errors__ {Boolean} Exit 1 on warnings too
- __--api-key__ {String} Tdarr API key
- __--limit__ {Number} Fuzz variants to run _(default=`600`)_
- __--full__ {Boolean} Run the entire fuzz matrix
- __--video-only__ {Boolean} Skipping an audio-only file is correct
- __--node-name__ {String} Node name to simulate as _(default=`"Nvidia"`)_
- __--target-container__ {String} _(default=`"mkv"`)_
- __--target-video__ {String} _(default=`"hevc"`)_

Exits `1` on any error-severity finding, or any halted fuzz variant.

## API

### `Flow.fromFile(path) : Flow`

### `Flow.fromObject(json) : Flow`

Load a flow. Accepts the DB shape or a UI export.

- __path__ {String} Path to the flow JSON
- __json__ {Object} Flow document

```js
const flow = Flow.fromFile('flows/transcode-pipeline.json')

flow.node('audNorm')            //=> FlowNode
flow.targets('audNorm', '1')    //=> ['audReorder']
flow.target('audNorm', '1')     //=> 'audReorder'  (throws on fan-out)
flow.usedHandles('audNorm')     //=> ['1']
flow.incoming('audNorm')        //=> FlowEdge[]
flow.byPlugin('runMkvPropEdit') //=> FlowNode[]
flow.entry()                    //=> FlowNode      (throws unless exactly one)
flow.terminals()                //=> FlowNode[]
flow.reachable()                //=> Set<string>
```

### `lint(flow, options) : LintFinding[]`

- __flow__ {Flow}
- __options.registry__ {NodeRegistry}
- [__options.ignore__] {String[]} Rules to skip, optionally `rule:nodeId`
- [__options.includeWarnings__] {Boolean} _(default=`true`)_

```js
lint(flow, { registry: buildRegistry(), ignore: ['missing-error-edge:audProped'] })
//=> [{ rule, severity, nodeId, nodeName, message, assumed }]
```

Rules: `entry-node`, `dangling-edge`, `unreachable-node`, `nonexistent-handle`,
`unwired-handle`, `missing-error-edge`, `mixed-plugin-versions`,
`overlapping-nodes`, `unmodelled-plugin`.

`assertNoLintErrors(flow, options)` throws instead of returning.
`formatFindings(findings)` returns a printable string.

### `simulate(flow, file, options) : SimulationResult`

- __flow__ {Flow}
- __file__ {TdarrFile} Build one with `probe.file()`
- [__options.nodeName__] {String} _(default=`"Tdarr_Node"`)_
- [__options.classicPluginDir__] {String}
- [__options.flowPluginDir__] {String}
- [__options.vendorRoot__] {String}
- [__options.registry__] {NodeRegistry}
- [__options.useRealPlugins__] {Boolean} _(default=`true`)_
- [__options.transcodeRatio__] {Number} Modelled encode output size _(default=`0.6`)_

```js
const result = simulate(flow, file, { classicPluginDir: 'plugins/Local' })

result.file        //=> { path, container, size, streams, probeFailed, medium }
result.audio       //=> FfProbeStream[]   (also .video, .subtitles)
result.replaced    //=> true if it reached Replace Original File
result.halted      //=> null, or { kind, node, message }
result.visited     //=> ['Input File', 'Readable Video?', ...]
result.didVisit(n) //=> Boolean
result.path        //=> [{ id, name, plugin, handle }]
result.messages    //=> String[]
```

`halted.kind` is one of `crash`, `fanout`, `loop`, `unmodelled`. An output
handle with no edge ends the flow without halting.

### `fuzz(flow, options) : FuzzReport`

Sweeps a matrix of containers × video codecs × audio layouts × subtitle layouts.

- __flow__ {Flow}
- [__options.limit__] {Number} Sampled by even stride, never truncated
- [__options.containers__] {String[]}
- [__options.targetContainer__] {String} _(default=`"mkv"`)_
- [__options.targetVideoCodec__] {String} _(default=`"hevc"`)_
- [__options.keepLanguage__] {String} _(default=`"eng"`)_
- [__options.maxAudioTracks__] {Number} _(default=`2`)_
- [__options.surroundMinChannels__] {Number} _(default=`4`)_
- [__options.videoOnly__] {Boolean} Skipping an audio-only file is correct
- Plus every `simulate` option

```js
const report = fuzz(flow, { limit: 400, videoOnly: true })

report.total     //=> 400
report.generated //=> 8568
report.clean     //=> FuzzOutcome[]
report.anomalous //=> FuzzOutcome[]
report.halted    //=> FuzzOutcome[]
report.outcomes  //=> [{ variant, result, shape, anomalies }]
```

Anomalies: `silent`, `duplicate-audio`, `multiple-audio`, `not-target-container`,
`lost-subtitles`, `not-replaced`, `video-not-target-codec`, `skipped-with-media`.

`allVariants(options)` and `generateVariants(options)` return the matrix.
`groupBy(items, keyFn)` groups outcomes, largest first.

### `loadClassicPlugin(id, options) : ClassicPluginModule`

- __id__ {String} e.g. `"Tdarr_Plugin_bsh1_RemuxMKV"`
- __options.dir__ {String} Directory of `Tdarr_Plugin_*.js`
- [__options.vendorRoot__] {String}

```js
const { plugin, details } = loadClassicPlugin('Tdarr_Plugin_bsh1_RemuxMKV', {
  dir: 'plugins/Local',
})

const result = plugin(file, {}, { tag_language: 'eng' }, {})
result.preset.split(',')[0] //=> input args
```

### `loadFlowPlugin(name, options) : FlowPluginModule`

- __name__ {String}
- __options.dir__ {String} Directory of `<category>/<name>/<version>/index.js`
- __options.category__ {String}
- [__options.version__] {String} _(default=`"1.0.0"`)_
- [__options.vendorRoot__] {String}

### `probe`

Builders for synthetic ffprobe data.

```js
probe.file({ container, streams, size, name, path })
probe.unreadableFile({ container })  // ffProbeData is {}, streams ABSENT
probe.video({ codec, width, height })
probe.audio({ codec, channels, language, title, commentary, bitRate, sampleRate })
probe.subtitle({ codec, language, title, commentary, hearingImpaired, forced })
probe.attachedPic()
probe.stream(codecType, extra)
```

Pass `language: null` for an untagged stream.

### `buildRegistry(options) : NodeRegistry`

Built-in models, then real vendored community plugins, then your local flow
plugins.

```js
const registry = buildRegistry({
  classicPluginDir: 'plugins/Local',
  flowPluginDir: 'plugins/FlowPlugins/LocalFlowPlugins',
})

registry.register('checkHdr', {
  outputs: 2,
  error: false,
  confidence: 'assumed',
  run: (ctx, node) => (isHdr(ctx.file.streams) ? '1' : '2'),
})

registry.get(name)     //=> NodeModel | undefined
registry.require(name) //=> NodeModel (throws)
registry.names()       //=> String[]
registry.clone()       //=> NodeRegistry
```

`builtinRegistry(options)` gives models only.
`registerCommunityPlugins(registry, options)` and
`registerLocalFlowPlugins(registry, dir, vendorRoot)` add real source.

`MUST_MODEL` lists the nodes that stay modelled because they shell out or move
files: `inputFile`, `replaceOriginalFile`, `setOriginalFile`, `runMkvPropEdit`,
`runClassicTranscodePlugin`, `ffmpegCommandExecute`, `checkFileChanged`.

### `TdarrClient(options)`

- __options.url__ {String} e.g. `"http://192.168.1.42:8266"`
- [__options.apiKey__] {String}
- [__options.timeoutMs__] {Number} _(default=`10000`)_
- [__options.fetchImpl__] {Function}

```js
const client = new TdarrClient({ url: 'http://192.168.1.42:8266' })

await client.ping()             //=> Boolean
await client.listFlows()        //=> [{ id, name, description, nodeCount, edgeCount }]
await client.getFlowById(id)    //=> Flow
await client.getFlowByName(n)   //=> Flow  (throws if ambiguous)
await client.findFlow(nameOrId) //=> Flow
await client.listLibraries()    //=> [{ id, name, folder, flowId }]
await client.crud({ collection, mode })
await client.raw(path, body)

saveFlow(flow, 'flows/my-flow.json')
```

Verified against Tdarr 2.86.01. Collection names are parameters.

### `vendorInfo() : VendorInfo | null`

```js
vendorInfo()     //=> { repo, ref, sha, committedAt, vendoredPaths }
vendorPaths()    //=> { root, communityFlowPlugins, flowHelpers, methods, available }
describeVendor() //=> 'HaveAGitGat/Tdarr_Plugins@26c97a52f9 (2026-08-04T07:16:30Z)'
```

### `verifyHandles(pluginRoot, registry) : VerifyHandlesResult`

Diffs each plugin's declared `details().outputs` against the registry.

```js
verifyHandles('vendor/FlowPlugins/CommunityFlowPlugins', buildRegistry())
//=> { checked, missing, mismatches, ok }
```

## Notes

- Models carry `confidence: 'observed' | 'assumed'`. Lint marks findings that
  rest on an assumed model with `assumed: true`. Real plugins are always
  `observed`.
- `check*` nodes read `inputFileObj.ffProbeData`, not pending command markup. A
  stream marked `removed` is still visible to a later `checkAudioCodec`.
- Setting a plugin input to `""` does not mean "unset" — `loadDefaultValues`
  rewrites it to the plugin's default.
- `ffProbeData.streams` absent ≠ empty. Several stock plugins throw on the
  former. Use `probe.unreadableFile()`.
- `ffmpegCommandExecute` refuses to plan a command where two streams ask for
  different values of the same unqualified option (`-ac`, `-ar`); ffmpeg would
  apply the last to all of them.

## Development

```sh
pnpm check   # typecheck + lint + test
```

## License

MIT
