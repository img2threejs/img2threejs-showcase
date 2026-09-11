import * as THREE from 'three';
import { Reflector } from 'three/examples/jsm/objects/Reflector.js';

/** One bounded, throttled planar pass. This camera helper is never added to the scene. */
export class GrootWaterReflection {
  readonly matrix={value:new THREE.Matrix4()};
  readonly texture:{value:THREE.Texture};
  readonly ready={value:0};
  frames=0;
  lastDrawCalls=0;
  totalMs=0;
  disposed=false;
  size=384;
  maxHz=12;
  setPerformance(enabled:boolean):void{
    if(this.disposed)return;const size=enabled?192:384;this.maxHz=enabled?8:12;
    if(size===this.size)return;this.size=size;this.reflector.getRenderTarget().setSize(size,size);this.ready.value=0;this.invalidate();
  }
  private last=-Infinity;
  private readonly reflector:Reflector;
  private readonly inverse=new THREE.Matrix4();
  private readonly viewport=new THREE.Vector4();
  private readonly scissor=new THREE.Vector4();
  constructor(level:number){
    this.reflector=new Reflector(new THREE.PlaneGeometry(1,1),{textureWidth:384,textureHeight:384,clipBias:.002,multisample:0});
    this.reflector.rotation.x=-Math.PI/2;this.reflector.position.y=level;this.reflector.updateMatrixWorld(true);
    this.inverse.copy(this.reflector.matrixWorld).invert();
    const target=this.reflector.getRenderTarget();target.texture.generateMipmaps=true;target.texture.minFilter=THREE.LinearMipmapLinearFilter;
    this.texture={value:target.texture};
  }
  invalidate():void {this.last=-Infinity;}
  render(renderer:THREE.WebGLRenderer,scene:THREE.Scene,camera:THREE.Camera,water:THREE.Object3D):void{
    const now=performance.now();if(this.disposed||now-this.last<1000/this.maxHz||camera.position.y<=this.reflector.position.y)return;
    this.last=now;
    const target=renderer.getRenderTarget(),xr=renderer.xr.enabled,shadow=renderer.shadowMap.autoUpdate,visible=water.visible;
    const autoReset=renderer.info.autoReset,before=renderer.info.render.calls,scissorTest=renderer.getScissorTest();
    renderer.getViewport(this.viewport);renderer.getScissor(this.scissor);
    try{
      water.visible=false;renderer.info.autoReset=false;
      const material=this.reflector.material as THREE.ShaderMaterial;
      this.reflector.onBeforeRender(renderer,scene,camera,this.reflector.geometry,material,null!);
      this.matrix.value.copy(material.uniforms.textureMatrix.value).multiply(this.inverse);
      this.lastDrawCalls=renderer.info.render.calls-before;this.ready.value=1;this.frames++;
    }finally{
      water.visible=visible;renderer.xr.enabled=xr;renderer.shadowMap.autoUpdate=shadow;renderer.info.autoReset=autoReset;
      renderer.setRenderTarget(target);renderer.setViewport(this.viewport);renderer.setScissor(this.scissor);renderer.setScissorTest(scissorTest);
      this.last=performance.now();this.totalMs+=this.last-now;
    }
  }
  dispose():void {if(this.disposed)return;this.disposed=true;this.reflector.geometry.dispose();this.reflector.dispose();}
}
