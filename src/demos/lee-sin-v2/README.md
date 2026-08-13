# Lee Sin v2

Thin showcase adapter that imports and compiles the real `img2threejs-character` Lee Sin v2
`CharacterIR`; body geometry, rig, accessories, materials, runtime, and conformance remain owned by
the character plugin.

- Turnaround reference owns visible design and front/side/rear proportions.
- T-pose reference owns the bind pose.
- `CharacterSession` compiles the archetype and preserves its real `CharacterRuntime` under
  `root.userData.sculptRuntime`.
- Showcase code only applies display scale, shadows, frame updates, and look-dev lighting; it does
  not duplicate the plugin's lofts, bones, accessories, or materials.
- The demo remains `placeholder`: structural/runtime checks may pass, but the inherited blockout
  diagnosis is still blocked at silhouette IoU `0.6866 < 0.85`, aspect-ratio delta
  `0.1336 > 0.05`, and scale delta `0.1824 > 0.08`.

The source is code-only Three.js. The bitmap reference is evidence, not model geometry.
