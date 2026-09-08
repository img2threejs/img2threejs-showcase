# Local forest streaming

3H cells; actor radii **8/12/18H** at70/85/100. Total accounted identities remain **81/169/289**, including staging ground. Only70 selects medium source/shadow/reflection quality. Source geometry, near density, fades and collisions remain unchanged. T19 now separates per-cell source ownership from bounded spatial draw ownership.

`GrootStreaming` prepares one phase per main frame. T19 caches exact-position/radius/content-epoch readiness, reuses unchanged envelopes, skips settled planning and selects the next job without allocating/sorting a queue. Subcell movement still updates radial visibility and canopy LOD. Same-frame high→low→high transitions explicitly bypass the settled fast path.

## Dense four-cell vegetation / fixed sixteen-cell ground buckets

`GrootSpatialBatches` shares each compatible opaque procedural family across a 6H (2×2 cell) bucket. Records are now dense: `mesh.count` equals the sum of owned source counts, so unused capacity is never drawn. Arrival appends; promotion/count changes and retirement may relocate the following allocations within that same four-cell bucket (at most three neighbours). Retired trailing records are also cleared. SOURCE cells are never regenerated for membership changes.

This is an explicitly approved refinement of the original strict fixed-span upload rule: **relocated spans are changed GPU spans**, not “unchanged neighbours.” Cached offsets are invalid after membership/count changes; inspect current `userData.streamSpans`. Only the edited local suffix is uploaded; the prefix and other buckets are untouched. `batches.stats.relocatedCells/relocatedBytes` report relocation work; `copiedBytes/retiredBytes` count changed ranges, not driver uploads. Capacity-based stream `preparedBytes` is only a preparation estimate; independent actual-GL bytes and whole-frame CPU include real copying/upload work.

`GrootGroundBatches` owns 12H (4×4 cell) pages with sixteen fixed independent vertex/index spans. Only the arriving tile is copied and retired indices become degenerate; ground neighbours are never repacked. Larger ground culling adds a small number of triangles. Shared base geometries/materials remain disposed by the original source owner; empty buckets are immediately released. Reserved source identity caps are unchanged.

Source generation, slot identity and readiness are still per cell. CPU-only `sourceMeshes`/`sourceGeometry` support deterministic promotion/inspection; they are not scene proxies. `grassTiles` returns actual bucket meshes. Actual ground ray tests use `chunks.groundBatches.buckets`, not source tiles. Every rendered bucket exposes **all** `userData.streamSpans` owners and conservative source-union bounds. Transparent water and authored grove materials/order stay separate. Bucket frustum culling is coarser; shader radial clipping still uses the approved radius.

Three r169 uses `DynamicDrawUsage` plus `addUpdateRange(start,count)` in scalar components. Initial bufferData uploads the whole bounded capacity and leaves ranges intact; subsequent updates merge/clear ranges **before** onUpload. The stream observer accounts for that order and clears stale initial ranges. No global/neighbourhood repacking or whole-buffer upload fallback. A changed dense suffix can cover the entire active range of one small bucket; tests explicitly authorize and measure that case.

**Performance acceptance FAIL / incomplete.** One bounded follow-up compared two options. Dense6H vegetation/12H ground was retained: high idle draws294→286, triangles2.58M→2.30M, and pinned idle CPU about2.3–2.4→2.2ms. Dense9H vegetation was rejected despite fewer draws: high idle GPU time grew to13.92ms and triangles3.38M. No further architectural iterations were made.

The retained option preserves70 crossing savings: authentic3,838,240→1,386,836 triangles (−63.9%) and ordinary boundary-window CPU p957.7–7.9→2.1–2.7ms (−65–73%). All-tier authentic-baseline CPU≤10% acceptance still fails; authentic high idle remains1.5–1.6ms. No universal GPU/FPS claim. Retained far canopy detail was inventoried but reversible LOD was not changed: its potential savings were modest compared with submission/padding costs and would add relocation work.

Evidence: `.img2threejs/groot-streaming/t19-report.md`, `t19/measurements.md`, `t19/summary.json`, raw A/B/C/D reports and hashed archives. A/B has two ABBA sequences; the final safety-guard revision has only one diagnostic block, **not final repeated acceptance**. See the report for functional tests, loading latency, upload-counter limitations and remaining gates.

Batch continuation evidence: `.img2threejs/groot-streaming/t19-batch-report.md`, `t19-batch-progress.md`, and `t19/batch-*`. Bounded dense follow-up: `t19-bounded-report.md`, `t19-bounded-progress.md`, and `t19/bounded-*`. Historical fixed-span and scheduler reports/archives are not overwritten or relabelled.

Focused checks: `scripts/test-groot-streaming-batches.mjs` (actual GL ranges, all owners, rendered-buffer fidelity and cleanup), `scripts/test-groot-streaming.mjs`, `scripts/test-groot-streaming-ownership.mjs`, `scripts/test-groot-streaming-t19-counters.mjs`. Benchmark: `scripts/benchmark-groot-streaming-t19.mjs <isolated-url> <new-output> <block-label>`; use the frozen protocol and serial owned browsers/builds.
