// The soft-tissue rig clears each deformed skinned mesh's bounding sphere on every update. Those
// meshes are never frustum-culled, but renderer.sortObjects asks for the sphere centre every frame, so
// three recomputes it by skinning every vertex (tens of thousands per character) - the dominant
// cost once characters move. Pin one conservative, pre-computed sphere per soft mesh instead.
// It is used only for render sorting; picking uses its own posed-triangle hierarchy.
export function pinSortSpheres(rig) {
  const pins = [...rig.meshes.values()].map(({ mesh }) => {
    mesh.boundingSphere = null; mesh.computeBoundingSphere();
    const sphere = mesh.boundingSphere.clone();
    sphere.radius *= 2; // the posed body stays inside twice its rest radius
    return { mesh, sphere };
  });
  return () => { for (const pin of pins) pin.mesh.boundingSphere = pin.sphere; };
}
