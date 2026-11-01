// Returns a function that releases every geometry, material, texture and skeleton under `root`.
export function collectDisposer(root) {
  const geometries = new Set(), materials = new Set(), textures = new Set(), skeletons = new Set();
  root.traverse(node => {
    if (!node.isMesh) return;
    geometries.add(node.geometry);
    for (const material of Array.isArray(node.material) ? node.material : [node.material]) {
      materials.add(material);
      for (const value of Object.values(material)) if (value?.isTexture) textures.add(value);
    }
    if (node.skeleton) skeletons.add(node.skeleton);
  });
  return () => {
    for (const skeleton of skeletons) skeleton.dispose();
    for (const geometry of geometries) geometry.dispose();
    for (const material of materials) material.dispose();
    const images = new Set();
    for (const texture of textures) {
      texture.dispose();
      for (const image of Array.isArray(texture.image) ? texture.image : [texture.image]) {
        if (image) images.add(image);
      }
    }
    for (const image of images) image.close?.();
  };
}
