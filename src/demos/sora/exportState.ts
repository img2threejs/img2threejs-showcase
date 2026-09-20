import * as THREE from 'three';

/**
 * A mounted model can be temporarily changed by viewer-only tools (explode/isolate) and runtime
 * decoration (idle/VFX). Exporters must see the authored model, not that inspection state.
 *
 * Neutralizers are synchronous by design: exportModel clones while every hook is active, then
 * restores the live scene before any asynchronous serializer work begins.
 */
export type ExportStateRestore = () => void;
export type ExportStateNeutralizer = () => ExportStateRestore | void;

interface ExportStateHook {
  owner: string;
  neutralize: ExportStateNeutralizer;
}

const HOOKS_KEY = '__img2threejsExportStateHooks';

function hooks(root: THREE.Object3D): ExportStateHook[] {
  const current = root.userData[HOOKS_KEY] as ExportStateHook[] | undefined;
  if (current) return current;
  const created: ExportStateHook[] = [];
  root.userData[HOOKS_KEY] = created;
  return created;
}

/** Register or replace one owner's neutralizer without accumulating stale closures. */
export function registerExportStateNeutralizer(
  root: THREE.Object3D,
  owner: string,
  neutralize: ExportStateNeutralizer | null,
): void {
  const list = hooks(root);
  const index = list.findIndex((hook) => hook.owner === owner);
  if (!neutralize) {
    if (index >= 0) list.splice(index, 1);
    return;
  }
  const next = { owner, neutralize };
  if (index >= 0) list[index] = next;
  else list.push(next);
}

/**
 * Enter the authored export state and return a single LIFO restore callback.
 * A failed hook restores every hook that already ran before propagating the failure.
 */
export function neutralizeExportState(root: THREE.Object3D): ExportStateRestore {
  const list = (root.userData[HOOKS_KEY] as ExportStateHook[] | undefined) ?? [];
  const restores: ExportStateRestore[] = [];
  try {
    for (const hook of list) {
      const restore = hook.neutralize();
      if (restore) restores.push(restore);
    }
  } catch (error) {
    for (const restore of restores.reverse()) restore();
    throw error;
  }
  return () => {
    for (const restore of restores.reverse()) restore();
  };
}
