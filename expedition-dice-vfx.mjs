import * as THREE from './node_modules/three/build/three.module.js';

const vertexShader=`
  varying vec2 vUv;
  void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}
`;
const lightShader=`
  varying vec2 vUv;
  uniform vec3 tint;
  uniform float size, strength, clock, mode;
  float halo(float d,float w){return exp(-pow(d/w,2.));}
  float ring(vec2 p){return length(max(abs(p)-vec2(.42),0.))+min(max(abs(p.x)-.42,abs(p.y)-.42),0.)-.08;}
  void main(){
    vec2 p=(vUv-.5)*4.;
    float a=0., core=0.;
    if(mode<.5){
      float d=ring(p);
      float edge=abs(d)*size;
      float sweep=.75+.25*cos(atan(p.y,p.x)-clock*2.);
      a=(.42*halo(edge,4.6)+.19*halo(edge,10.))*sweep;
      core=.84*halo(edge,1.15);
      if(d<0.){a*=.23;core*=.28;}
    }else{
      float t=clock;
      a=.28*exp(-length(p)*3.5)*(1.-t);
      a+=.33*halo(abs(length(p)-(.18+t*1.42)),.11)*pow(1.-t,2.);
      for(int i=0;i<12;i++){
        float n=float(i);
        float theta=n*2.39996;
        vec2 dir=vec2(cos(theta),sin(theta));
        vec2 v=p-dir*(.24+t*(.66+fract(n*.71)*.92))+vec2(0.,t*t*.43);
        vec2 d=vec2(dot(v,dir),dot(v,vec2(-dir.y,dir.x)));
        float spark=exp(-length(d*vec2(9.,32.)))*(1.-t);
        a+=spark*.85; core+=spark*.58;
      }
    }
    gl_FragColor=vec4(mix(tint,vec3(1.,.96,.85),clamp(core,0.,1.)),clamp((a+core)*strength,0.,.94));
  }
`;

const ribbonShader=`
  varying vec2 vUv;
  uniform vec3 tint;
  uniform float strength;
  void main(){
    float edge=abs(vUv.y-.5)*2.;
    float taper=smoothstep(0.,.40,vUv.x)*(1.-smoothstep(.88,1.,vUv.x));
    float core=exp(-edge*edge*24.);
    float mist=exp(-edge*edge*4.5)*(1.-smoothstep(.62,1.,edge));
    gl_FragColor=vec4(mix(tint,vec3(1.,.96,.85),core*.88),
      (core*.85+mist*.48)*taper*strength);
  }
`;

const tones={party:0xf6a45d,foe:0xaaa2ff};
const tileParts=[
  [[0,0],[.38,0],[.32,.33]], [[.38,0],[.78,0],[.61,.34]], [[.78,0],[1,0],[1,.43]],
  [[0,0],[.32,.33],[0,.55]], [[.32,.33],[.38,0],[.61,.34]], [[.61,.34],[.78,0],[1,.43]],
  [[0,.55],[.32,.33],[.43,.69]], [[.32,.33],[.61,.34],[.43,.69]], [[.61,.34],[1,.43],[.75,.72]],
  [[.61,.34],[.75,.72],[.43,.69]], [[0,.55],[.43,.69],[0,1]], [[0,1],[.43,.69],[.38,1]],
  [[.38,1],[.43,.69],[.75,.72]], [[.38,1],[.75,.72],[1,1]], [[.75,.72],[1,.43],[1,1]],
];

export function createDiceVfx(host,reduced){
  let renderer, camera, width=0, height=0, frame=0, failed=false;
  const scene=new THREE.Scene();
  const plane=new THREE.PlaneGeometry(1,1);
  const events=new Set();
  const atlas={};
  let hover=null;
  const sideOf=die=>die.classList.contains('foe')?'foe':'party';
  const visible=die=>die?.isConnected&&!die.disabled&&!host.hidden&&!host.inert;
  function resize(){
    if(!renderer)return;
    width=window.innerWidth; height=window.innerHeight;
    renderer.setPixelRatio(Math.min(devicePixelRatio||1,1.5));
    renderer.setSize(width,height,false);
    camera.left=0;camera.right=width;camera.top=0;camera.bottom=height;
    camera.updateProjectionMatrix();
    if(hover&&visible(hover.die))hover.rect=hover.die.getBoundingClientRect();
  }
  function start(){
    if(renderer)return true;
    if(failed)return false;
    try{
      const canvas=document.createElement('canvas');
      const context=canvas.getContext('webgl2',{alpha:true,antialias:true});
      if(!context){failed=true;return false;}
      renderer=new THREE.WebGLRenderer({canvas,context,alpha:true,antialias:true});
    }catch{failed=true;return false;}
    renderer.setClearColor(0,0);
    renderer.domElement.className='dice-vfx-layer';
    renderer.domElement.setAttribute('aria-hidden','true');
    host.append(renderer.domElement);
    camera=new THREE.OrthographicCamera(0,1,0,1,.01,1000);
    camera.position.z=100;
    resize();
    window.addEventListener('resize',resize);
    for(const faction of ['party','foe']){
      const image=new Image();
      image.src='./combat-assets/dice-ink-'+faction+'-v3.png';
      atlas[faction]=image;
    }
    return true;
  }
  function light(rect,side,mode){
    const size=rect.width;
    const mesh=new THREE.Mesh(plane,new THREE.ShaderMaterial({
      vertexShader,fragmentShader:lightShader,side:THREE.DoubleSide,transparent:true,depthTest:false,depthWrite:false,
      uniforms:{tint:{value:new THREE.Color(tones[side]).convertLinearToSRGB()},size:{value:size},
        strength:{value:0},clock:{value:0},mode:{value:mode}},
    }));
    mesh.scale.set(size*4,size*4,1);
    mesh.position.set(rect.left+size/2,rect.top+rect.height/2,0);
    mesh.frustumCulled=false;
    scene.add(mesh);
    return mesh;
  }
  function removeLight(mesh){scene.remove(mesh);mesh.material.dispose();}
  function request(){if(!frame)frame=requestAnimationFrame(draw);}
  function draw(now){
    frame=0;
    if(hover){
      if(!visible(hover.die)&&!hover.leave)hover.leave=now;
      const fade=hover.leave?1-Math.min(1,(now-hover.leave)/165):Math.min(1,(now-hover.start)/145);
      if(fade<=0&&hover.leave){removeLight(hover.mesh);hover=null;}
      else{
        hover.mesh.position.set(hover.rect.left+hover.rect.width/2,hover.rect.top+hover.rect.height/2,0);
        hover.mesh.material.uniforms.strength.value=Math.max(0,fade);
        hover.mesh.material.uniforms.clock.value=reduced()?0:now/1000;
      }
    }
    for(const event of events){
      if(now<event.start)continue;
      const t=(now-event.start)/event.duration;
      if(t>=1||event.ended?.()){event.dispose();events.delete(event);continue;}
      event.step(t);
    }
    renderer.render(scene,camera);
    if(events.size||hover&&(!reduced()||hover.leave||now-hover.start<170))request();
  }
  function highlight(die,on){
    if(!on){
      if(hover?.die===die){hover.leave=performance.now();request();}
      return;
    }
    if(!visible(die)||!start())return;
    if(hover?.die===die){hover.leave=0;request();return;}
    if(hover)removeLight(hover.mesh);
    const rect=die.getBoundingClientRect();
    hover={die,rect,mesh:light(rect,sideOf(die),0),start:performance.now(),leave:0};
    request();
  }
  function roll(die,space,cube,animation,duration){
    if(reduced()||!start())return;
    const rect=die.getBoundingClientRect();
    const perspective=parseFloat(getComputedStyle(space).perspective)||230;
    const side=sideOf(die);
    const size=rect.width;
    const centerX=rect.left+size/2,centerY=rect.top+rect.height/2;
    // The HTML cube remains the art. Its projected twin only writes depth.
    const blocker=new THREE.Mesh(new THREE.BoxGeometry(size*.985,rect.height*.985,size*.985),
      new THREE.MeshBasicMaterial({colorWrite:false,side:THREE.DoubleSide}));
    const originalBox=blocker.geometry.attributes.position.array.slice();
    blocker.frustumCulled=false;
    scene.add(blocker);
    const steps=42;
    const ribbons=[0,1].map(index=>{
      const geometry=new THREE.BufferGeometry();
      geometry.setAttribute('position',new THREE.BufferAttribute(new Float32Array((steps+1)*6),3).setUsage(THREE.DynamicDrawUsage));
      const uv=[],indices=[];
      for(let i=0;i<=steps;i++){
        uv.push(i/steps,0,i/steps,1);
        if(i<steps){const a=i*2;indices.push(a,a+1,a+2,a+1,a+3,a+2);}
      }
      geometry.setAttribute('uv',new THREE.Float32BufferAttribute(uv,2));
      geometry.setIndex(indices);
      const material=new THREE.ShaderMaterial({
        vertexShader,fragmentShader:ribbonShader,transparent:true,side:THREE.DoubleSide,depthWrite:false,
        uniforms:{tint:{value:new THREE.Color(tones[side]).convertLinearToSRGB()},strength:{value:0}},
      });
      const mesh=new THREE.Mesh(geometry,material);
      mesh.frustumCulled=false;
      mesh.renderOrder=2+index;
      scene.add(mesh);
      return mesh;
    });
    const project=(buffer,offset,x,y,z,m,s)=>{
      const nx=m.m11*x+m.m21*y+m.m31*z;
      const ny=m.m12*x+m.m22*y+m.m32*z;
      const nz=m.m13*x+m.m23*y+m.m33*z;
      const factor=perspective/(perspective-nz);
      buffer[offset]=centerX+s.m41+nx*factor*s.m11;
      buffer[offset+1]=centerY+s.m42+ny*factor*s.m22;
      buffer[offset+2]=nz;
    };
    const matrix=node=>{
      const value=getComputedStyle(node).transform;
      return new DOMMatrixReadOnly(value==='none'?undefined:value);
    };
    events.add({
      start:performance.now(),duration:Infinity,
      ended:()=>animation.playState==='finished'||!cube.isConnected,
      step(){
        const progress=animation.effect.getComputedTiming().progress??0;
        const show=Number(animation.currentTime)>=animation.effect.getTiming().delay;
        blocker.visible=show;
        for(const mesh of ribbons)mesh.visible=show;
        if(!show)return;
        // Sample both animated transforms after WAAPI has applied easing for this frame.
        const turn=matrix(cube), motion=matrix(space);
        const box=blocker.geometry.attributes.position;
        for(let i=0;i<originalBox.length;i+=3)
          project(box.array,i,originalBox[i],originalBox[i+1],originalBox[i+2],turn,motion);
        box.needsUpdate=true;
        for(const [index,mesh] of ribbons.entries()){
          const points=mesh.geometry.attributes.position;
          const strength=Math.min(progress*12,1)*(1-Math.pow(progress,4));
          mesh.material.uniforms.strength.value=strength*(index===0?.94:.64);
          const head=progress*duration*.010*(index===0?1:-1)+index*2.8;
          for(let i=0;i<=steps;i++){
            const angle=head-(1-i/steps)*(index===0?3.4:2.8);
            const tilt=index===0?.64:-.81;
            for(let edge=0;edge<2;edge++){
              const radius=size*(.80+index*.07+(edge-.5)*(index===0?.27:.22));
              const y=Math.sin(angle)*radius;
              project(points.array,i*6+edge*3,Math.cos(angle)*radius,y*Math.sin(tilt),y*Math.cos(tilt),turn,motion);
            }
          }
          points.needsUpdate=true;
        }
      },
      dispose(){
        scene.remove(blocker,...ribbons);
        for(const mesh of [blocker,...ribbons]){mesh.geometry.dispose();mesh.material.dispose();}
      },
    });
    request();
  }
  function tileTexture(die,side){
    const icon=die.querySelector('.face-0 .dice-painted-icon');
    const canvas=document.createElement('canvas');
    canvas.width=canvas.height=128;
    const ctx=canvas.getContext('2d');
    const gradient=ctx.createRadialGradient(63,54,4,64,64,83);
    gradient.addColorStop(0,side==='foe'?'#353537':'#943c37');
    gradient.addColorStop(1,side==='foe'?'#191919':'#55231f');
    ctx.fillStyle=gradient;ctx.fillRect(0,0,128,128);
    ctx.strokeStyle=side==='foe'?'#918477':'#b1835c';
    ctx.lineWidth=3;ctx.strokeRect(2,2,124,124);
    const image=icon?.querySelector('img')??atlas[icon?.dataset.atlas];
    if(image?.complete&&image.naturalWidth){
      if(icon.classList.contains('dice-icon-flip')){ctx.translate(128,0);ctx.scale(-1,1);}
      if(icon.dataset.atlas){
        const [x,y]=icon.style.backgroundPosition.split(' ').map(value=>Math.round(parseFloat(value)*3/100));
        const w=image.naturalWidth/4,h=image.naturalHeight/4;
        ctx.drawImage(image,x*w,y*h,w,h,4,4,120,120);
      }else{
        const margin=icon.classList.contains('dice-skill-crop')?.075:0;
        const w=image.naturalWidth,h=image.naturalHeight;
        ctx.drawImage(image,w*margin,h*margin,w*(1-2*margin),h*(1-2*margin),6,6,116,116);
      }
    }
    const texture=new THREE.CanvasTexture(canvas);texture.colorSpace=THREE.SRGBColorSpace;
    return texture;
  }
  function shatter(die){
    if(!die||reduced()||!start())return;
    const rect=die.getBoundingClientRect();
    const side=sideOf(die);
    const flash=light(rect,side,2);
    const texture=tileTexture(die,side);
    const fragments=tileParts.map((part,index)=>{
      const x=part.reduce((total,point)=>total+point[0],0)/3;
      const y=part.reduce((total,point)=>total+point[1],0)/3;
      const geometry=new THREE.BufferGeometry();
      geometry.setAttribute('position',new THREE.Float32BufferAttribute(part.flatMap(([u,v])=>[(u-x)*rect.width,(v-y)*rect.height,0]),3));
      geometry.setAttribute('uv',new THREE.Float32BufferAttribute(part.flatMap(([u,v])=>[u,1-v]),2));
      const mesh=new THREE.Mesh(geometry,new THREE.MeshBasicMaterial({map:texture,side:THREE.DoubleSide,transparent:true,depthWrite:false,depthTest:false}));
      mesh.renderOrder=1;
      mesh.position.set(rect.left+x*rect.width,rect.top+y*rect.height,0);
      scene.add(mesh);
      return {mesh,x,y,spin:(index%2?-1:1)*(.7+index*.18),pitch:(index%3-1)*1.7};
    });
    die.classList.add('die-fracturing');
    const duration=490;
    events.add({
      start:performance.now(),duration,
      step(t){
        flash.material.uniforms.clock.value=t;
        flash.material.uniforms.strength.value=Math.min(1,t*19)*.96;
        for(const {mesh,x,y,spin,pitch} of fragments){
          const spread=rect.width*(2.5*t-1.1*t*t);
          mesh.position.x=rect.left+x*rect.width+(x-.5)*spread;
          mesh.position.y=rect.top+y*rect.height+(y-.5)*spread+rect.height*(1.4*t*t-.6*t);
          mesh.rotation.set(t*pitch,t*spin*.52,t*spin);
          mesh.material.opacity=1-Math.max(0,(t-.30)/.70);
        }
      },
      dispose(){
        removeLight(flash);
        for(const {mesh} of fragments){scene.remove(mesh);mesh.geometry.dispose();mesh.material.dispose();}
        texture.dispose();
      },
    });
    request();
  }
  return {highlight,roll,shatter};
}
