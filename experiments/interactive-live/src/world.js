import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

const fit = {
  temple: [15, 11, 8], statue: [3, 5, 3], monk: [1.5, 2.3, 1.5],
  "tree-left": [6, 9, 6], "tree-right": [6, 9, 6],
  pond: [8, 1, 5], "lantern-left": [1.5, 5, 1.5],
  "lantern-right": [1.5, 5, 1.5]
};
export function createWorldLayer({ scene, proceduralTemple, monks, pond, lanterns, assetStatus }) {
  const grid = new THREE.GridHelper(30, 30, 0xc9aa7b, 0x577074);
  grid.position.y = 0.02;
  grid.visible = false;
  scene.add(grid);
  const loaded = new Map();
  let version = 0, config = null;
  const loader = new GLTFLoader();

  function dispose(id) {
    const current = loaded.get(id);
    if (!current) return;
    scene.remove(current.root);
    current.root.traverse((node) => {
      if (!node.isMesh) return;
      node.geometry?.dispose?.();
      const mats = Array.isArray(node.material) ? node.material : [node.material];
      for (const m of mats) {
        if (!m) continue;
        for (const value of Object.values(m)) if (value?.isTexture) value.dispose();
        m.dispose?.();
      }
    });
    loaded.delete(id);
  }

  function apply() {
    if (!config) return;
    grid.visible = config.showGrid;
    const slots = new Map(config.slots.map((s) => [s.id, s]));
    for (const [id, obj] of loaded) {
      const slot = slots.get(id);
      if (!slot) continue;
      obj.root.visible = slot.enabled;
      obj.root.position.set(...slot.position);
      obj.root.rotation.y = slot.rotationY;
      obj.root.scale.setScalar(slot.scale);
    }
    const temple = slots.get("temple");
    for (const mesh of proceduralTemple) mesh.visible = temple?.enabled !== false && !loaded.has("temple");
    const monkSlot = slots.get("monk");
    for (const monk of monks) monk.visible = monkSlot?.enabled !== false && !loaded.has("monk");
    const pondSlot = slots.get("pond");
    pond.visible = pondSlot?.enabled !== false && !loaded.has("pond");
    for (const [index, name] of ["lantern-left", "lantern-right"].entries()) {
      const slot = slots.get(name);
      const l = lanterns[index];
      if (!l) continue;
      l.pole.visible = slot?.enabled !== false && !loaded.has(name);
      l.mesh.visible = slot?.enabled !== false && !loaded.has(name);
    }
    document.querySelector(".scene-heading h1").textContent = config.title;
  }

  function setWorld(next) {
    if (!next || !Array.isArray(next.slots)) return;
    config = next;
    apply();
  }

  async function load(id, url, generation) {
    try {
      const response = await fetch(url, { cache: "no-store" });
      if (!response.ok) throw Error("HTTP " + response.status);
      const buffer = await response.arrayBuffer();
      const gltf = await new Promise((resolve, reject) => loader.parse(buffer, "", resolve, reject));
      if (generation !== version) return;
      const model = gltf.scene;
      const bounds = new THREE.Box3().setFromObject(model);
      const dimensions = bounds.getSize(new THREE.Vector3());
      const size = fit[id] || [4, 5, 4];
      if (Math.max(dimensions.x, dimensions.y, dimensions.z) < 0.000001) throw Error("Empty model");
      const ratios = size.map((v, i) => {
        const d = [dimensions.x, dimensions.y, dimensions.z][i];
        return d > 0.000001 ? v / d : Infinity;
      });
      const scalar = Math.min(...ratios);
      const center = bounds.getCenter(new THREE.Vector3());
      model.scale.setScalar(scalar);
      model.position.set(-center.x * scalar, -bounds.min.y * scalar, -center.z * scalar);
      model.traverse((node) => {
        if (node.isMesh) { node.castShadow = true; node.receiveShadow = true; }
      });
      const root = new THREE.Group();
      root.add(model);
      scene.add(root);
      dispose(id);
      const mixer = gltf.animations?.length ? new THREE.AnimationMixer(model) : null;
      if (mixer) gltf.animations.forEach((clip) => mixer.clipAction(clip).play());
      loaded.set(id, { root, mixer });
      apply();
      if (assetStatus) assetStatus.textContent = id + ".glb loaded";
    } catch (error) {
      if (generation === version && assetStatus) assetStatus.textContent = "Asset " + id + ": " + error.message;
    }
  }
  async function refreshAssets() {
    const generation = ++version;
    try {
      const response = await fetch("/api/assets", { cache: "no-store" });
      if (!response.ok) throw Error("Asset inventory unavailable");
      const inventory = await response.json();
      const promises = [];
      for (const item of inventory) {
        if (!item.present) { dispose(item.id); continue; }
        promises.push(load(item.id, "/assets/" + item.id + ".glb?v=" + generation, generation));
      }
      if (!inventory.some((v) => v.id === "temple" && v.present) &&
          new URLSearchParams(location.search).get("asset") === "temple") {
        promises.push(load("temple", "/models/temple.glb", generation));
      }
      apply();
      await Promise.all(promises);
    } catch (error) {
      if (assetStatus) assetStatus.textContent = error.message;
    }
  }
  function tick(dt) {
    for (const { mixer } of loaded.values()) mixer?.update(dt);
  }
  return { setWorld, refreshAssets, tick };
}
