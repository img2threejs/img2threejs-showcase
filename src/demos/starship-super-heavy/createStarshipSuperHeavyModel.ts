import * as THREE from 'three';

export interface StarshipSuperHeavyOptions {
  /** World scale; 0.1 keeps the 70-unit authored stack gallery-sized. */
  scale?: number;
  shadows?: boolean;
  animate?: boolean;
}

/**
 * Procedural Starship + Super Heavy reconstruction generated with img2threejs v1.2.0.
 *
 * No imported meshes or runtime assets: the stainless finish, heat-shield tiles,
 * flaps, grid fins, domes, seams, and 40 total engine assemblies are authored in code.
 */
export function createStarshipSuperHeavyModel(
  options: StarshipSuperHeavyOptions = {},
): THREE.Group {
  const { scale = 0.1, shadows = true, animate = true } = options;
  function makeBrushedMetalMaps(): { colorMap: THREE.CanvasTexture; roughnessMap: THREE.CanvasTexture } {
    const size=512, colorCanvas=document.createElement('canvas'), roughCanvas=document.createElement('canvas'); colorCanvas.width=colorCanvas.height=roughCanvas.width=roughCanvas.height=size;
    const colorCtx=colorCanvas.getContext('2d')!, roughCtx=roughCanvas.getContext('2d')!; let seed=928371;
    const random=()=>{seed=(seed*1664525+1013904223)>>>0;return seed/4294967296};
    colorCtx.fillStyle='#d8dde0'; colorCtx.fillRect(0,0,size,size); roughCtx.fillStyle='#777'; roughCtx.fillRect(0,0,size,size);
    for(let x=0;x<size;x++){const c=190+Math.floor(random()*48), r=62+Math.floor(random()*88); colorCtx.fillStyle=`rgb(${c},${c+2},${c+4})`; colorCtx.fillRect(x,0,1,size); roughCtx.fillStyle=`rgb(${r},${r},${r})`; roughCtx.fillRect(x,0,1,size);}
    for(let i=0;i<90;i++){const x=Math.floor(random()*size),w=1+Math.floor(random()*3);colorCtx.fillStyle=`rgba(255,255,255,${.025+random()*.07})`;colorCtx.fillRect(x,0,w,size);}
    const colorMap=new THREE.CanvasTexture(colorCanvas), roughnessMap=new THREE.CanvasTexture(roughCanvas); colorMap.colorSpace=THREE.SRGBColorSpace;
    for(const texture of [colorMap,roughnessMap]){texture.wrapS=texture.wrapT=THREE.RepeatWrapping;texture.repeat.set(3,18);texture.anisotropy=8;}
    return {colorMap,roughnessMap};
  }
  const brushedMaps=makeBrushedMetalMaps();
  const steel = new THREE.MeshPhysicalMaterial({ color: 0xffffff, map:brushedMaps.colorMap, roughnessMap:brushedMaps.roughnessMap, metalness: 0.78, roughness: 0.42, clearcoat: 0.12, anisotropy:.65, anisotropyRotation:Math.PI/2 });
  const darkSteel = new THREE.MeshStandardMaterial({ color: 0x363e46, metalness: 0.68, roughness: 0.38 });
  const black = new THREE.MeshStandardMaterial({ color: 0x080a0d, metalness: 0.25, roughness: 0.7 });
  const gridMat = new THREE.MeshStandardMaterial({ color: 0x343a40, metalness: 0.8, roughness: 0.45, side: THREE.DoubleSide });
  const axialLengthScale=1.15;
  const root = new THREE.Group(); root.name = 'starshipSuperHeavy'; root.scale.setScalar(scale); root.position.y = 0.82 * scale;

  function mesh(geometry: THREE.BufferGeometry, material: THREE.Material, name: string, parent: THREE.Object3D = root) { const m = new THREE.Mesh(geometry, material); m.name = name; m.castShadow = m.receiveShadow = shadows; parent.add(m); return m; }
  function ring(y: number, radius: number, tube=.035, material: THREE.Material=darkSteel, parent: THREE.Object3D=root) { const m=mesh(new THREE.TorusGeometry(radius,tube,8,96),material,'weldRing',parent); m.rotation.x=Math.PI/2; m.position.y=y; return m; }
  function longitudinalSeams(parent: THREE.Object3D, height: number, yCenter: number, radius: number, count=6){for(let i=0;i<count;i++){const a=i/count*Math.PI*2;const seam=mesh(new THREE.BoxGeometry(.032,height,.055),darkSteel,'longitudinalPanelSeam',parent);seam.position.set(Math.cos(a)*(radius+.02),yCenter,Math.sin(a)*(radius+.02));seam.rotation.y=-a;}}
  function nozzle(parent: THREE.Object3D, x: number, y: number, z: number, nozzleScale=1, vacuum=false) {
    const assembly = new THREE.Group(); assembly.name = vacuum ? 'raptorVacuum' : 'raptorSeaLevel'; assembly.position.set(x,y,z); parent.add(assembly);
    const h = (vacuum ? 1.35 : .72) * nozzleScale, throat = .17 * nozzleScale, exit = (vacuum ? .72 : .34) * nozzleScale;
    const bell = mesh(new THREE.CylinderGeometry(throat,exit,h,24,2,true),darkSteel,'engineBell',assembly); bell.position.y=-h*.42;
    const collar = mesh(new THREE.TorusGeometry(throat*1.15,.045*nozzleScale,8,24),steel,'engineCollar',assembly); collar.rotation.x=Math.PI/2; collar.position.y=.02;
    const interior=mesh(new THREE.CircleGeometry(exit*.9,32),black,'engineBellInterior',assembly);interior.rotation.x=Math.PI/2;interior.position.y=-h*.92;
    const exitRing=mesh(new THREE.TorusGeometry(exit*.94,.045*nozzleScale,8,32),steel,'engineExitRing',assembly);exitRing.rotation.x=Math.PI/2;exitRing.position.y=-h*.915;
    return assembly;
  }

  function createGridFin(name: string, parent: THREE.Object3D, angle: number) {
    const pivot=new THREE.Group(); pivot.name=name+'Pivot'; pivot.position.set(Math.cos(angle)*3.25,35.4,Math.sin(angle)*3.25); pivot.rotation.y=-angle; parent.add(pivot);
    const fin=new THREE.Group(); fin.name=name; fin.position.x=1.82; pivot.add(fin);
    const w=2.5,d=1.7,t=.10;
    for(const z of [-d/2,d/2]){const rail=mesh(new THREE.BoxGeometry(w,t,t),gridMat,'gridFinFrame',fin);rail.position.z=z;}
    for(const x of [-w/2,w/2]){const rail=mesh(new THREE.BoxGeometry(t,t,d),gridMat,'gridFinFrame',fin);rail.position.x=x;}
    const innerW=w-2*t,innerD=d-2*t;
    for(let i=1;i<8;i++){const x=-innerW/2+i*innerW/8;const bar=mesh(new THREE.BoxGeometry(.045,.065,innerD),gridMat,'gridFinLatticeVertical',fin);bar.position.x=x;}
    for(let i=1;i<6;i++){const z=-innerD/2+i*innerD/6;const bar=mesh(new THREE.BoxGeometry(innerW,.065,.045),gridMat,'gridFinLatticeHorizontal',fin);bar.position.z=z;}
    const hinge=mesh(new THREE.CylinderGeometry(.18,.18,.75,20),darkSteel,'gridFinHinge',pivot);hinge.rotation.z=Math.PI/2;hinge.position.x=.18;
    const mount=mesh(new THREE.BoxGeometry(.72,.48,.62),darkSteel,'gridFinMount',pivot);mount.position.x=.08;
    return pivot;
  }

  function createBoosterChine(parent: THREE.Object3D, angle: number, index: number){
    const chineRoot=new THREE.Group();chineRoot.name=`boosterChine${index+1}`;chineRoot.rotation.y=-angle;parent.add(chineRoot);
    const shape=new THREE.Shape();shape.moveTo(0,0);shape.lineTo(.40,0);shape.lineTo(.40,9.45);shape.lineTo(.22,10.05);shape.lineTo(.08,10.38);shape.lineTo(0,10.05);shape.closePath();
    const fairing=mesh(new THREE.ExtrudeGeometry(shape,{depth:.34,bevelEnabled:true,bevelSize:.035,bevelThickness:.035,bevelSegments:2}),steel,'chineFairing',chineRoot);fairing.position.set(3.02,1.0,-.17);
    const spine=mesh(new THREE.BoxGeometry(.07,9.45,.39),darkSteel,'chineSpine',chineRoot);spine.position.set(3.39,5.72,0);
    const foot=mesh(new THREE.BoxGeometry(.48,.36,.48),darkSteel,'chineAftFoot',chineRoot);foot.position.set(3.16,1.08,0);
    return chineRoot;
  }

  const booster = new THREE.Group(); booster.name='superHeavy';booster.scale.y=axialLengthScale; root.add(booster);
  const boosterBody=mesh(new THREE.CylinderGeometry(3.25,3.25,36,96,1,true),steel,'boosterHull',booster); boosterBody.position.y=18.6;
  for(let y=1.2;y<36.5;y+=2.15) ring(y,3.27,.025,darkSteel,booster);
  longitudinalSeams(booster,35.2,18.6,3.25,8);
  const aft=mesh(new THREE.CylinderGeometry(3.25,3.34,1.10,96),steel,'boosterAftSkirt',booster); aft.position.y=.67;
  const engineDeck=mesh(new THREE.CylinderGeometry(3.08,3.08,.16,72),black,'boosterEngineDeck',booster);engineDeck.position.y=.08;
  ring(.18,3.31,.095,steel,booster);ring(1.18,3.27,.075,steel,booster);
  for(let i=0;i<40;i++){const a=i/40*Math.PI*2;const rib=mesh(new THREE.BoxGeometry(.085,.72,.075),darkSteel,'aftSkirtFlute',booster);rib.position.set(Math.cos(a)*3.30,.72,Math.sin(a)*3.30);rib.rotation.y=-a;}
  for(let i=0;i<12;i++){const a=i/12*Math.PI*2;const block=mesh(new THREE.BoxGeometry(.28,.30,.20),darkSteel,'outerHoldDownBlock',booster);block.position.set(Math.cos(a)*3.34,.25,Math.sin(a)*3.34);block.rotation.y=-a;}
  const hotstage=mesh(new THREE.CylinderGeometry(3.25,3.25,1.55,96,1,true),darkSteel,'hotStageRing',booster); hotstage.position.y=37.35;
  for(let i=0;i<44;i++){const a=i/44*Math.PI*2; const slot=mesh(new THREE.BoxGeometry(.16,.95,.13),black,'hotStageVent',hotstage); slot.position.set(Math.cos(a)*3.24,0,Math.sin(a)*3.24); slot.rotation.y=-a;}

  // The forward end of Super Heavy is a shallow tank dome inside the hot-stage
  // ring, not a planar cylinder cap. Its apex remains below the nested ship bells.
  const boosterDomeBaseY=36.55;
  const boosterDomeProfile=[
    new THREE.Vector2(0,.38),new THREE.Vector2(.42,.375),new THREE.Vector2(.92,.35),
    new THREE.Vector2(1.42,.30),new THREE.Vector2(1.92,.23),new THREE.Vector2(2.38,.14),
    new THREE.Vector2(2.78,.06),new THREE.Vector2(3.08,0)
  ];
  const domeSteel=steel.clone();domeSteel.side=THREE.DoubleSide;
  const boosterForwardDome=mesh(new THREE.LatheGeometry(boosterDomeProfile,96),domeSteel,'boosterForwardDome',booster);boosterForwardDome.position.y=boosterDomeBaseY;
  for(const [radius,height] of [[.92,.35],[1.42,.30],[1.92,.23],[2.38,.14],[2.78,.06]])ring(boosterDomeBaseY+height+.012,radius,.018,darkSteel,booster);
  for(let i=0;i<8;i++){
    const angle=i*Math.PI/4,points=boosterDomeProfile.slice(1).map(point=>new THREE.Vector3(Math.cos(angle)*point.x,boosterDomeBaseY+point.y+.014,Math.sin(angle)*point.x));
    mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points),24,.014,6,false),darkSteel,'boosterDomeRadialSeam',booster);
  }
  ring(boosterDomeBaseY+.025,3.08,.065,steel,booster);
  for(let i=0;i<4;i++){
    const angle=i*Math.PI/2,radius=2.34;
    const pad=mesh(new THREE.BoxGeometry(.48,.11,.32),darkSteel,'boosterTopMount',booster);
    pad.position.set(Math.cos(angle)*radius,boosterDomeBaseY+.17,Math.sin(angle)*radius);pad.rotation.y=-angle;pad.rotation.z=-.16;
    const inset=mesh(new THREE.BoxGeometry(.24,.025,.18),steel,'boosterTopMountInset',pad);inset.position.y=.065;
  }

  for(let i=0;i<4;i++) createGridFin(`gridFin${i+1}`,booster,i*Math.PI/2);
  for(let i=0;i<4;i++)createBoosterChine(booster,i*Math.PI/2+Math.PI/4,i);
  const engineGroup=new THREE.Group(); engineGroup.name='boosterEngineArray'; booster.add(engineGroup);
  const boosterEngineScale=.93;
  const referenceEngineCenters: Array<[number, number]>=[
    [451,251],[542,251],[371,283],[623,286],[495,329],[310,342],[684,347],[416,356],[576,359],
    [495,416],[362,419],[271,420],[628,420],[719,424],[436,475],[495,475],[555,475],
    [351,503],[639,504],[266,505],[724,507],[495,545],[385,578],[606,579],[290,589],[700,589],
    [454,623],[538,624],[342,654],[648,655],[413,698],[577,700],[495,714]
  ];
  const referenceLayoutOrigin={x:495,y:482},referenceLayoutScale=2.55/233;
  const boosterEnginePositions=referenceEngineCenters.map(([px,py],index)=>({x:(px-referenceLayoutOrigin.x)*referenceLayoutScale,z:(referenceLayoutOrigin.y-py)*referenceLayoutScale,source:index===15?'inferred-33rd':'visible-reference'}));
  if(boosterEnginePositions.length!==33)throw new Error(`Super Heavy engine layout must contain 33 engines; received ${boosterEnginePositions.length}`);
  boosterEnginePositions.forEach((position,index)=>{const engine=nozzle(engineGroup,position.x,.02,position.z,boosterEngineScale);engine.name=`boosterRaptor${String(index+1).padStart(2,'0')}`;engine.userData={engineIndex:index+1,source:position.source};});

  const ship = new THREE.Group(); ship.name='starship';ship.position.y=38.1*axialLengthScale; root.add(ship);
  const originalShipBodyHeight=18.2,shipNoseBaseY=originalShipBodyHeight*axialLengthScale;
  const shipBody=mesh(new THREE.CylinderGeometry(3.25,3.25,shipNoseBaseY,96),steel,'shipHull',ship); shipBody.position.y=shipNoseBaseY/2;
  for(let y=.65;y<18.0;y+=1.65) ring(y*axialLengthScale,3.27,.025,darkSteel,ship);
  longitudinalSeams(ship,17.65*axialLengthScale,9.1*axialLengthScale,3.25,6);
  const noseProfile=[
    new THREE.Vector2(3.25,0),new THREE.Vector2(3.23,.9),new THREE.Vector2(3.12,2.05),
    new THREE.Vector2(2.88,3.4),new THREE.Vector2(2.48,4.8),new THREE.Vector2(1.92,6.15),
    new THREE.Vector2(1.27,7.25),new THREE.Vector2(.62,8.1),new THREE.Vector2(.16,8.65),new THREE.Vector2(.03,8.8)
  ];
  const nose=mesh(new THREE.LatheGeometry(noseProfile,96),steel,'ogiveNoseCone',ship); nose.position.y=shipNoseBaseY;
  for(const [offset,r] of [[.95,3.22],[2,3.13],[3.2,2.91],[4.55,2.52],[5.9,1.96],[7.15,1.28]]) ring(shipNoseBaseY+offset,r,.02,darkSteel,ship);
  const heatShieldBase=mesh(new THREE.CylinderGeometry(3.275,3.275,17.85*axialLengthScale,96,1,true,0,Math.PI),black,'heatShieldBacking',ship); heatShieldBase.position.y=9.1*axialLengthScale; heatShieldBase.rotation.y=Math.PI/2;
  function shipSurfaceAtY(y: number): { radius: number; slope: number }{
    if(y<=shipNoseBaseY)return {radius:3.29,slope:0};
    const local=y-shipNoseBaseY;
    for(let i=1;i<noseProfile.length;i++){
      if(local<=noseProfile[i].y){
        const a=noseProfile[i-1],b=noseProfile[i],t=(local-a.y)/(b.y-a.y);
        return {radius:THREE.MathUtils.lerp(a.x,b.x,t)+.035,slope:(b.x-a.x)/(b.y-a.y)};
      }
    }
    return {radius:.08,slope:0};
  }
  function createHeatShieldTiles(parent: THREE.Object3D): THREE.InstancedMesh{
    const placements: Array<{ y: number; a: number; radius: number; slope: number }>=[],tileRadius=.205,circumferentialGap=.026,longitudinalGap=0;
    const circumferentialPitch=Math.sqrt(3)*tileRadius+circumferentialGap,longitudinalPitch=1.5*tileRadius+longitudinalGap;
    for(let y=.28,row=0;y<shipNoseBaseY+8.65;y+=longitudinalPitch,row++){const surface=shipSurfaceAtY(y);if(surface.radius<.25)continue;const count=Math.max(4,Math.floor(Math.PI*surface.radius/circumferentialPitch));for(let col=0;col<count;col++){const a=-Math.PI/2+(col+.5+(row%2)*.5)/count*Math.PI;placements.push({y,a,...surface});}}
    const tileMaterial=new THREE.MeshStandardMaterial({color:0x111418,roughness:.88,metalness:.06}); const tileGeometry=new THREE.CylinderGeometry(tileRadius,tileRadius,.042,6,1,false); const tiles=new THREE.InstancedMesh(tileGeometry,tileMaterial,placements.length);tiles.name='hexHeatShieldTiles';tiles.castShadow=shadows;
    const dummy=new THREE.Object3D(),normal=new THREE.Vector3(),circumferential=new THREE.Vector3(),longitudinal=new THREE.Vector3(),basis=new THREE.Matrix4();
    placements.forEach((p,i)=>{
      const ca=Math.cos(p.a),sa=Math.sin(p.a);
      normal.set(ca,-p.slope,sa).normalize();
      circumferential.set(-sa,0,ca).normalize();
      longitudinal.crossVectors(circumferential,normal).normalize();
      dummy.position.set(ca*p.radius,p.y,sa*p.radius).addScaledVector(normal,.035);
      basis.makeBasis(circumferential,normal,longitudinal);
      dummy.quaternion.setFromRotationMatrix(basis);
      dummy.updateMatrix();tiles.setMatrixAt(i,dummy.matrix);
    });
    tiles.instanceMatrix.needsUpdate=true;tiles.userData={tileRadius,circumferentialGap,longitudinalGap,circumferentialPitch,longitudinalPitch};parent.add(tiles);return tiles;
  }
  const heatShieldTiles=createHeatShieldTiles(ship);
  function flap(name: string, y: number, w: number, h: number, angle: number, forward=false){
    const pivot=new THREE.Group(); pivot.name=name+'Pivot'; pivot.position.set(0,y,0); pivot.rotation.y=angle; ship.add(pivot);
    const shape=new THREE.Shape();
    let flapX=3.05,flapY=forward?-h*.18:-h*.04,flapDepth=.26;
    if(forward){
      // Follow the changing ogive radius instead of forcing a vertical root edge
      // through the nose. A small stand-off also accounts for the flap bevel.
      flapX=0;flapDepth=.22;
      const rootBottom=.12*h,rootTop=h,rootClearance=.16;
      const rootRadiusAt=(localY: number)=>shipSurfaceAtY(y+flapY+localY).radius+rootClearance;
      const outerX=rootRadiusAt(rootBottom)+w*.90;
      shape.moveTo(rootRadiusAt(rootBottom),rootBottom);
      shape.lineTo(outerX,0);
      shape.lineTo(outerX,.36*h);
      shape.lineTo(rootRadiusAt(rootTop),rootTop);
      for(let i=1;i<=6;i++){
        const localY=THREE.MathUtils.lerp(rootTop,rootBottom,i/6);
        shape.lineTo(rootRadiusAt(localY),localY);
      }
      shape.closePath();

      const addRootCylinder=(geometry: (length: number) => THREE.BufferGeometry, nameSuffix: string, offset=.04)=>{
        const lowerY=rootBottom+.08,upperY=rootTop-.12;
        const start=new THREE.Vector3(rootRadiusAt(lowerY)+offset,flapY+lowerY,0);
        const end=new THREE.Vector3(rootRadiusAt(upperY)+offset,flapY+upperY,0);
        const axis=end.clone().sub(start),part=mesh(geometry(axis.length()),steel,name+nameSuffix,pivot);
        part.position.copy(start).add(end).multiplyScalar(.5);
        part.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0),axis.normalize());
        return part;
      };
      addRootCylinder(length=>new THREE.CylinderGeometry(.10,.10,length,18),'Hinge',.03);
      addRootCylinder(length=>new THREE.CylinderGeometry(.13,.21,length,20),'RootFairing',.10);
    } else {
      // Reference silhouette: four-point aft trapezoid with horizontal base,
      // vertical outer edge, and one long swept upper edge to the hull.
      shape.moveTo(0,0);
      shape.lineTo(w,0);
      shape.lineTo(w,.48*h);
      shape.lineTo(0,h);
      shape.closePath();
    }
    const f=mesh(new THREE.ExtrudeGeometry(shape,{depth:flapDepth,bevelEnabled:true,bevelSize:forward?.05:.08,bevelThickness:forward?.045:.07,bevelSegments:2}),darkSteel,name,pivot); f.position.set(flapX,flapY,-flapDepth/2);
    if(!forward){
      const hinge=mesh(new THREE.CylinderGeometry(.14,.14,h*.78,18),steel,name+'Hinge',pivot); hinge.position.set(3.12,h*.42,0);
      const fairing=mesh(new THREE.CylinderGeometry(.18,.38,h*.62,20),steel,name+'RootFairing',pivot);fairing.position.set(3.03,h*.42,0);
    }
    return pivot;
  }
  flap('aftFlapA',.35*axialLengthScale,2.15,6.65*axialLengthScale,0); flap('aftFlapB',.35*axialLengthScale,2.15,6.65*axialLengthScale,Math.PI); flap('forwardFlapA',shipNoseBaseY+.9,1.85,4.15,0,true); flap('forwardFlapB',shipNoseBaseY+.9,1.85,4.15,Math.PI,true);
  const shipEngines=new THREE.Group(); shipEngines.name='shipEngineArray'; ship.add(shipEngines);
  const shipEngineBay=mesh(new THREE.CylinderGeometry(3.03,3.03,.16,72),black,'shipEngineBay',shipEngines);shipEngineBay.position.y=-.08;
  const starshipEnginePositions: Array<[number, number]>=[[0,0]];
  for(let i=0;i<6;i++){const a=Math.PI/2+i*Math.PI/3;starshipEnginePositions.push([Math.cos(a)*1.58,Math.sin(a)*1.58]);}
  starshipEnginePositions.forEach(([x,z],i)=>{
    const engine=nozzle(shipEngines,x,-.12,z,.78,true);engine.name=i===0?'centerRaptor':`outerRaptor${i}`;
    const mount=mesh(new THREE.CylinderGeometry(.34,.34,.12,20),darkSteel,i===0?'centerEngineMount':'outerEngineMount',shipEngines);mount.position.set(x,-.11,z);
  });

  const modeledShipHeight=27.9+originalShipBodyHeight*(axialLengthScale-1);
  root.userData.sculptRuntime={nodes:{root,booster,ship,engineGroup,shipEngines,heatShieldTiles},sockets:{stageSeparation:{position:[0,38.1*axialLengthScale,0]},payload:{position:[0,38.1*axialLengthScale+26.7+originalShipBodyHeight*(axialLengthScale-1),0]}},colliders:[{id:'booster',type:'cylinder',radius:3.25,height:38.8*axialLengthScale},{id:'ship',type:'compound',height:modeledShipHeight}],dimensions:{sourceMeters:{starship:52.1,superHeavy:72.3},boosterAxialScale:axialLengthScale,shipBodyAxialScale:axialLengthScale,shipFairingAxialScale:1,modeledUnits:{starship:modeledShipHeight,superHeavy:38.8*axialLengthScale}},repetitionSystems:{heatShieldTiles:{count:heatShieldTiles.count,type:'hex-instanced'},boosterEngines:{count:boosterEnginePositions.length,uniformScale:boosterEngineScale,layout:'reference-fitted',visibleReferenceCenters:32,inferredCenters:1,positions:boosterEnginePositions},shipEngines:{count:7,center:1,outerRing:6,outerRingRadius:1.58,positions:starshipEnginePositions}},destructionGroups:{booster:'superHeavy',upperStage:'starship'}};
  const stackedShipPosition = ship.position.clone();
  const raisedShipPosition = new THREE.Vector3(0, 49.8, 0);
  const acrossShipPosition = new THREE.Vector3(12, 49.8, 0);
  const displayedShipPosition = new THREE.Vector3(12, 0.4, 0);
  const smoothstep = (value: number): number => value * value * (3 - 2 * value);
  const moveShip = (
    from: THREE.Vector3,
    to: THREE.Vector3,
    time: number,
    start: number,
    duration: number,
  ): void => {
    const t = smoothstep(THREE.MathUtils.clamp((time - start) / duration, 0, 1));
    ship.position.lerpVectors(from, to, t);
  };

  root.userData.tick = (dt: number, elapsed: number): void => {
    if (!animate) return;
    const time = elapsed % 22;
    if (time < 2 || time >= 17) root.rotation.y += dt * 0.09;
    if (time < 2) ship.position.copy(stackedShipPosition);
    else if (time < 3.5) moveShip(stackedShipPosition, raisedShipPosition, time, 2, 1.5);
    else if (time < 5.5) moveShip(raisedShipPosition, acrossShipPosition, time, 3.5, 2);
    else if (time < 8.5) moveShip(acrossShipPosition, displayedShipPosition, time, 5.5, 3);
    else if (time < 10.5) ship.position.copy(displayedShipPosition);
    else if (time < 13.5) moveShip(displayedShipPosition, acrossShipPosition, time, 10.5, 3);
    else if (time < 15.5) moveShip(acrossShipPosition, raisedShipPosition, time, 13.5, 2);
    else if (time < 17) moveShip(raisedShipPosition, stackedShipPosition, time, 15.5, 1.5);
    else ship.position.copy(stackedShipPosition);
  };

  return root;
}

export function createStarshipSuperHeavyLookDevLights(): THREE.Group {
  const lights = new THREE.Group();
  lights.name = 'starshipSuperHeavyLookDevLights';
  lights.add(new THREE.AmbientLight(0x91a9c8, 0.65));
  lights.add(new THREE.HemisphereLight(0xd8e8ff, 0x26344a, 1.65));

  const key = new THREE.DirectionalLight(0xffffff, 3.4);
  key.position.set(5, 10, 8);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  lights.add(key);

  const rim = new THREE.DirectionalLight(0x6fa8ff, 1.8);
  rim.position.set(-6, 5, -5);
  lights.add(rim);
  return lights;
}
