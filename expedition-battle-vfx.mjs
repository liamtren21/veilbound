import * as THREE from './node_modules/three/build/three.module.js';

const vertex = `
varying vec2 point;
void main() {
  point = uv * 2.0 - 1.0;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const fragment = `
varying vec2 point;
uniform vec3 tint;
uniform float age, clock, opacity;
uniform int kind;
float ink(float signedDistance, float width) {
  return 1.0 - smoothstep(width, width + 0.016, abs(signedDistance));
}
void main() {
  vec2 p = point;
  float line = 0.0;
  float fog = 0.0;
  if (kind == 0) {
    float side = .68 * smoothstep(-.84, .20, p.y);
    float edge = max(abs(p.x) - side, p.y - (.74 - abs(p.x) * .21));
    edge = max(edge, -.84 - p.y);
    float inside = 1.0 - smoothstep(-.02, .025, edge);
    float ridge = ink(p.x, .018) * inside * .32;
    line = ink(edge, .032) + ink(edge + .10, .018) * .55 + ridge;
    fog = inside * (.54 + .14 * p.y + .20 * age) + exp(-abs(edge) * 24.0) * .16;
  } else if (kind == 1) {
    for (int i = 0; i < 3; i++) {
      float angle = clock * 3.0 + float(i) * 2.094;
      vec2 star = p - vec2(cos(angle) * .62, sin(angle) * .24);
      line += max(0.0, 1.0 - length(star * vec2(1.0, 1.6)) * 7.0)
        * (1.0 - smoothstep(.025, .05, min(abs(star.x), abs(star.y))));
    }
    fog = exp(-abs(length(p * vec2(1.0, 2.4)) - .62) * 21.0) * .4;
  } else if (kind == 2) {
    float turn = atan(p.y, p.x);
    float radius = length(p * vec2(1.18, .94));
    float seam = radius - .65 - .055 * sin(turn * 5.0 + clock * 1.8);
    line = ink(seam, .012) * smoothstep(.0, .8, sin(turn * 6.0 - clock * 2.0));
    fog = exp(-abs(seam) * 10.0) * (.25 + .17 * sin(turn * 4.0 + clock));
  } else {
    float radius = length(p);
    float angle = atan(p.y, p.x);
    float envelope = 1.0 - smoothstep(.15, 1.0, age);
    float front = radius - (.15 + age * .65);
    float bands = smoothstep(.58, .99, cos(angle * 7.0 + 1.1));
    line = ink(front, .02) * bands + ink(p.y + .29 * p.x, .012)
      * max(0.0, 1.0 - radius * 1.3) * (1.0 - smoothstep(.0, .34, age));
    fog = exp(-abs(front) * 12.0) * .48 * bands + exp(-radius * 7.0) * (1.0 - age);
    line *= envelope;
    fog *= envelope;
  }
  float fade = 1.0 - smoothstep(.83, 1.0, max(abs(p.x), abs(p.y)));
  gl_FragColor = vec4(mix(tint, vec3(1.0, .94, .82), clamp(line * .72, 0.0, 1.0)),
    clamp((line * .92 + fog) * opacity * fade, 0.0, 1.0));
}`;

export function createBattleVfx() {
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({alpha:true, antialias:false, premultipliedAlpha:false});
  } catch {
    return null;
  }
  const margin = 160;
  const width = 1200 + margin * 2;
  const height = 560 + margin * 2;
  renderer.setSize(width, height, false);
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-margin, width-margin, height-margin, -margin, .1, 20);
  camera.position.z = 10;
  const geometry = new THREE.PlaneGeometry(2, 2);
  const meshes = [];
  let used = 0;
  return {
    stamp(kind, x, y, width, height, tint, clock, opacity=1, age=0, rotation=0) {
      let mesh = meshes[used];
      if (!mesh) {
        const uniforms = {
          kind:{value:0}, tint:{value:new THREE.Color()}, clock:{value:0},
          opacity:{value:1}, age:{value:0},
        };
        const material = new THREE.ShaderMaterial({
          vertexShader:vertex, fragmentShader:fragment, uniforms,
          transparent:true, depthTest:false, depthWrite:false, side:THREE.DoubleSide,
        });
        mesh = new THREE.Mesh(geometry, material);
        scene.add(mesh);
        meshes.push(mesh);
      }
      mesh.visible = true;
      mesh.renderOrder = used++;
      mesh.position.set(x, 560-y, 0);
      mesh.scale.set(width/2, height/2, 1);
      mesh.rotation.y = kind === 0 ? rotation : 0;
      mesh.rotation.z = kind === 0 ? 0 : rotation;
      const params = mesh.material.uniforms;
      params.kind.value = kind;
      params.tint.value.setStyle(tint, THREE.LinearSRGBColorSpace);
      params.clock.value = clock;
      params.opacity.value = opacity;
      params.age.value = age;
    },
    draw(ctx) {
      for (let index=used; index<meshes.length; index++) meshes[index].visible = false;
      if (used) {
        renderer.render(scene, camera);
        ctx.drawImage(renderer.domElement, -margin, -margin);
      }
      used = 0;
    },
  };
}
