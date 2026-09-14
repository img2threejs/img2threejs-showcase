# Ocean Blue PRS guitar

The creator also supplied a [Hyper3D model workspace](https://hyper3d.ai/workspace/rodin/a1dddc68-f3dd-403a-bcae-483b94ea13ff).
This additional model is linked for reference only. It has not replaced the embedded measurement
data, and its GLB has not been compared with the displayed model. Geometry, appearance and motion
remain unchanged.

The showcase uses the measured surface route from a Tripo v3.1 generated GLB. The source surface is
embedded as quantized TypeScript data and keeps its measured vertex colours, authored normals and
sampled PBR values. The source mesh has 1,027,623 vertices and 1,972,917 triangles; its measurement
source SHA-256 is `1c1886fdb812bd83eed7384eb281c6705287f45be8e5707a813cf8a8b4129d74`.

The runtime finish is an appearance layer on that same mesh. Its water animation samples a cache
baked from the original vertex colours; it does not introduce a new painted texture. The measured
source mesh remains one body, neck and hardware part, and the six string tubes are an authored detail
layer because the source has no complete string parts.

The standard viewer exposes Water Waves, String Motion, Pluck Strings and Ocean + Strings through its
collapsible Motion panel. Model Parts exposes the measured assembly plus the six strings for selection,
isolation and explode inspection. The default state is the original static appearance: smooth and
water are off.

The water shader and live string motion require the browser runtime. Existing exporters automatically
snapshot this single assembly at its current static pose and report the normal static export limits;
the runtime water shader and string motion are not portable into a static export.
