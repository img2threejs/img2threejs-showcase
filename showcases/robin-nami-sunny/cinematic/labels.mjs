// Shared, user-facing English names for the soft-body regions and interaction modes.
export const REGIONS = Object.freeze([
  { id: 'chest-left', label: 'Chest · left', feel: 'Soft · inertial' },
  { id: 'chest-right', label: 'Chest · right', feel: 'Soft · inertial' },
  { id: 'hips-left', label: 'Hip · left', feel: 'Soft · inertial' },
  { id: 'hips-right', label: 'Hip · right', feel: 'Soft · inertial' },
  { id: 'waist-left', label: 'Waist · left', feel: 'Firm · fast damping' },
  { id: 'waist-right', label: 'Waist · right', feel: 'Firm · fast damping' },
  { id: 'abdomen', label: 'Abdomen', feel: 'Medium soft · damped' },
  { id: 'cheek-left', label: 'Cheek · left', feel: 'Taut · slight stretch' },
  { id: 'cheek-right', label: 'Cheek · right', feel: 'Taut · slight stretch' },
]);
const byId = new Map(REGIONS.map(region => [region.id, region]));
export const regionLabel = id => byId.get(id)?.label ?? id;
export const regionFeel = id => byId.get(id)?.feel ?? '';

export const INTERACTION_MODES = Object.freeze([
  { id: 'squeeze', label: 'Squeeze' },
  { id: 'grab', label: 'Pull' },
  { id: 'fabric', label: 'Pull fabric' },
]);
