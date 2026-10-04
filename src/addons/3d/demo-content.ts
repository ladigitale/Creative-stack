import * as THREE from "three";

/** Cube + sol de démo quand aucun asset n’est fourni. */
function create(): THREE.Object3D {
  const group = new THREE.Group();
  group.name = "sonic-3d-demo";

  const geo = new THREE.BoxGeometry(1, 1, 1);
  const mat = new THREE.MeshStandardMaterial({
    color: 0x3b82f6,
    metalness: 0.25,
    roughness: 0.4,
  });
  const box = new THREE.Mesh(geo, mat);
  box.name = "demo-box";
  box.position.y = 0.5;
  group.add(box);

  const ground = new THREE.Mesh(
    new THREE.CircleGeometry(2.2, 48),
    new THREE.MeshStandardMaterial({
      color: 0x1a1a1a,
      metalness: 0,
      roughness: 0.9,
    }),
  );
  ground.name = "demo-ground";
  ground.rotation.x = -Math.PI / 2;
  group.add(ground);

  return group;
}

function setupLights(scene: THREE.Scene): THREE.Light[] {
  const amb = new THREE.AmbientLight(0xffffff, 0.55);
  const key = new THREE.DirectionalLight(0xffffff, 1.1);
  key.position.set(4, 6, 3);
  const fill = new THREE.DirectionalLight(0xb0c4ff, 0.35);
  fill.position.set(-3, 1, -2);
  const lights = [amb, key, fill];
  for (const l of lights) scene.add(l);
  return lights;
}

export const demoContent = { create, setupLights } as const;
