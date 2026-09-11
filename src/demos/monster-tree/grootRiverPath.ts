/** Shared river coordinates in figure heights: terrain, vegetation and water agree. */
export const riverCentreH=(x:number):number=>-8+1.35*Math.sin(x*.16)+.38*Math.sin(x*.43);
export const riverWidthH=(x:number):number=>(.85+.16*Math.cos(x*.21))*Math.min(1,Math.max(0,(34-Math.abs(x))/3));
export const riverDistanceH=(x:number,z:number):number=>Math.abs(z-riverCentreH(x));
export const inRiverH=(x:number,z:number,margin=0):boolean=>Math.abs(x)<34&&riverDistanceH(x,z)<riverWidthH(x)+margin;
export const RIVER_LEVEL_H=-.26;
