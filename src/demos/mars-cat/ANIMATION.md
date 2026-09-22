# Mars Cat animation provenance

Mars Cat's procedural meshes and skin weights remain code-authored. The animation pack GLB is an
offline measurement instrument only; the running demo fetches no `.glb` or `.bin` file.

- Source SHA-256: `D6B5654EDB526F65ADE95644EDE8F26FB073703B83B5884ECF93A8B0B68C5304`
- Source rig: one skin, 95 deform joints, no technical-node animation targets
- Measured correspondence: 95/95 joints, no unmatched joints, maximum rest-position residual
  `6.559622553102678e-7 m`
- Source clips: 12
- Source tracks: 3,420 (`translation`, quaternion `rotation`, and `scale` for every joint)
- Retained tracks: 2,280 translation/quaternion tracks, copied as float32 streams with per-accessor
  SHA-256 metadata
- Normalized tracks: 1,140 scale tracks are omitted. Their maximum departure from unit scale is
  `4.112720489501953e-6`; their maximum temporal range is `7.152557373046875e-7`. The runtime keeps
  each bone's bind-pose scale and measures zero animated scale drift.

Source names are preserved in clip metadata. `Idle` and the geometrically descriptive
`Pose_Bent_Knees` do not imply intent. The remaining human-readable action names are useful UI
labels but carry `inferred: true`; the kinematics cannot prove narrative intent.

The pack contains Idle, Wave, Fist Clench, Look Around, four static poses, Squat, Punch Left,
Punch Right, and Punch Combo. It does not contain walk, run, jump, or kick clips; those are not
invented by this demo.
