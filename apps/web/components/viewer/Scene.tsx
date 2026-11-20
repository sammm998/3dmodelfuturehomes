"use client";
import { CameraControls, Environment, Lightformer, PerformanceMonitor, AdaptiveDpr } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import { Bloom, EffectComposer, N8AO, SMAA, ToneMapping } from "@react-three/postprocessing";
import { createXRStore, useXR, useXRHitTest, XR, XROrigin } from "@react-three/xr";
import { ToneMappingMode } from "postprocessing";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import * as SunCalc from "suncalc";
import {
  collisionSegments,
  moveWithCollisions,
  roomAt,
  polygonCentroid,
  lerp as lerp2,
  type PlanSpec,
  type Vec2,
} from "@pv/shared";
import { track } from "@/lib/analytics";
import { useViewer } from "@/lib/store";
import type { Property } from "@/lib/types";
import { Building, type StackedFloor } from "./Building";
import { LabelProjector, type Anchor } from "./Labels";
import { groundTexture } from "./textures";
import { walkInput } from "./walkInput";

export const xrStore = createXRStore({ hitTest: true, domOverlay: true, emulate: false, offerSession: false });

export interface SceneBounds {
  cx: number;
  cz: number;
  w: number;
  d: number;
  height: number;
  radius: number;
}

export function sceneBounds(floors: StackedFloor[], storeys = 1, unitFloorIndex: number | null = null): SceneBounds {
  let minX = Infinity,
    minZ = Infinity,
    maxX = -Infinity,
    maxZ = -Infinity;
  for (const f of floors)
    for (const w of f.plan.walls)
      for (const p of [w.a, w.b]) {
        minX = Math.min(minX, p[0]);
        maxX = Math.max(maxX, p[0]);
        minZ = Math.min(minZ, p[1]);
        maxZ = Math.max(maxZ, p[1]);
      }
  if (!Number.isFinite(minX)) return { cx: 0, cz: 0, w: 10, d: 10, height: 3, radius: 10 };
  const top = Math.max(...floors.map((f) => f.elevation + f.plan.ceilingHeight + f.plan.slabThickness), storeys * 3.1);
  let w = maxX - minX;
  const d = maxZ - minZ;
  let cx = (minX + maxX) / 2;
  if (unitFloorIndex != null && storeys > floors.length) {
    // apartment: the illustrative building massing is ~2x the unit's width (see ContextFloors)
    const W = (w + 0.6) * 2.1;
    cx = minX - 0.3 + W / 2;
    w = W;
  }
  return { cx, cz: (minZ + maxZ) / 2, w, d, height: top, radius: Math.hypot(w, d, top) / 2 };
}

/** Unit vector (plan x/y) pointing out of the most glazed facade: the "garden/terrace" side. */
export function frontDirection(plan: PlanSpec, b: SceneBounds): Vec2 {
  const wallById = new Map(plan.walls.map((w) => [w.id, w]));
  let ax = 0,
    ay = 0;
  for (const o of plan.openings) {
    const w = wallById.get(o.wallId);
    if (!w?.exterior || (o.type !== "sliding" && o.type !== "window")) continue;
    const mx = (w.a[0] + w.b[0]) / 2 - b.cx,
      my = (w.a[1] + w.b[1]) / 2 - b.cz;
    const horizontal = Math.abs(w.b[0] - w.a[0]) > Math.abs(w.b[1] - w.a[1]);
    const wt = o.width * (o.type === "sliding" ? 2 : 1);
    if (horizontal) ay += Math.sign(my) * wt;
    else ax += Math.sign(mx) * wt;
  }
  const l = Math.hypot(ax, ay);
  return l > 1e-6 ? [ax / l, ay / l] : [0, 1];
}

/** Pick a natural start point for walking: just inside the entrance door, else the living room. */
export function walkStart(plan: PlanSpec): { pos: Vec2; look: Vec2 } {
  const living = plan.rooms.find((r) => r.type === "living") ?? plan.rooms.find((r) => r.type !== "stairs") ?? plan.rooms[0];
  const lc = living ? polygonCentroid(living.polygon) : ([0, 0] as Vec2);
  const wallById = new Map(plan.walls.map((w) => [w.id, w]));
  const entrance = plan.openings.find((o) => o.type === "door" && wallById.get(o.wallId)?.exterior);
  if (entrance) {
    const w = wallById.get(entrance.wallId)!;
    const c = lerp2(w.a, w.b, entrance.t);
    const L = Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]) || 1;
    let n: Vec2 = [-(w.b[1] - w.a[1]) / L, (w.b[0] - w.a[0]) / L];
    // normal must point inside (towards the living room)
    if ((lc[0] - c[0]) * n[0] + (lc[1] - c[1]) * n[1] < 0) n = [-n[0], -n[1]];
    // look straight into the house through the door (looking at the living room centroid can face a wall)
    return { pos: [c[0] + n[0] * 1.0, c[1] + n[1] * 1.0], look: [c[0] + n[0] * 4, c[1] + n[1] * 4] };
  }
  return { pos: lc, look: [lc[0] + 1, lc[1]] };
}

// ------------------------------------------------------------------------------------------------

export function Scene({ property, floors, bounds, embedded, anchors }: { property: Property; floors: StackedFloor[]; bounds: SceneBounds; embedded?: boolean; anchors: Anchor[] }) {
  const { mode, floorIndex, cutHeight, showFurniture, sunHour, photoreal } = useViewer();
  const building = property.buildings[0];
  const [lowPerf, setLowPerf] = useState(false);
  const xrMode = useXR((s) => s.mode);
  const inAR = xrMode === "immersive-ar";
  const gl = useThree((x) => x.gl);
  const composerOn = !inAR && !lowPerf && !embedded;
  useEffect(() => {
    // the EffectComposer applies tone mapping itself; without it the renderer must
    gl.toneMapping = composerOn ? THREE.NoToneMapping : THREE.ACESFilmicToneMapping;
  }, [gl, composerOn]);
  const hasPool = useMemo(
    () =>
      !!property.buildings[0]?.massing?.facade?.pool ||
      property.features?.some((f) => /pool|piscina/i.test(f)) ||
      property.media.some((m) => m.classification?.amenity === "pool"),
    [property],
  );

  return (
    <>
      <PerformanceMonitor onDecline={() => setLowPerf(true)} onIncline={() => setLowPerf(false)} />
      <AdaptiveDpr pixelated={false} />
      <Lights property={property} bounds={bounds} hour={sunHour} />
      {!inAR && mode !== "pano" && <Ground property={property} bounds={bounds} hasPool={hasPool && mode === "exterior"} floors={floors} />}
      {!inAR && mode !== "pano" && <GradientSky />}
      {!inAR && mode !== "pano" && <fog attach="fog" args={["#e6ecf1", 120, 520]} />}
      <Environment resolution={128} frames={1} environmentIntensity={0.55}>
        <Lightformer intensity={2} position={[0, 6, 0]} rotation-x={Math.PI / 2} scale={[20, 20, 1]} />
        <Lightformer intensity={1} position={[-8, 3, 4]} rotation-y={Math.PI / 2} scale={[10, 4, 1]} />
        <Lightformer intensity={1} position={[8, 3, -4]} rotation-y={-Math.PI / 2} scale={[10, 4, 1]} color="#ffe9d0" />
      </Environment>

      {inAR ? (
        <ARPlacement>
          <group position={[-bounds.cx, 0, -bounds.cz]}>
            <Building building={building} floors={floors} mode="dollhouse" floorIndex={floors.length - 1} cutHeight={10} showFurniture={false} simple />
          </group>
        </ARPlacement>
      ) : (
        mode !== "pano" && (
          <Building building={building} floors={floors} mode={mode} floorIndex={floorIndex} cutHeight={cutHeight} showFurniture={showFurniture} />
        )
      )}

      {!inAR && <LabelProjector anchors={anchors} />}
      {!inAR && mode === "pano" && <PanoView property={property} floors={floors} />}
      {!inAR && photoreal && <SplatLayer property={property} />}
      <CameraRig floors={floors} bounds={bounds} property={property} />
      {xrMode === "immersive-vr" && floors[0] && <VROrigin floor={floors[floorIndex] ?? floors[0]} />}

      {composerOn && (
        <EffectComposer multisampling={0} enableNormalPass={false}>
          <N8AO aoRadius={0.8} intensity={1.6} distanceFalloff={0.6} halfRes />
          <Bloom luminanceThreshold={0.92} intensity={0.25} mipmapBlur />
          <ToneMapping mode={ToneMappingMode.ACES_FILMIC} />
          <SMAA />
        </EffectComposer>
      )}
    </>
  );
}

export function SceneRoot(props: { property: Property; floors: StackedFloor[]; bounds: SceneBounds; embedded?: boolean; anchors: Anchor[] }) {
  return (
    <XR store={xrStore}>
      <Suspense fallback={null}>
        <Scene {...props} />
      </Suspense>
    </XR>
  );
}

// ---------------- sky ----------------

/** Soft vertical gradient dome: calm, premium backdrop that tone-maps predictably. */
function GradientSky() {
  const mat = useMemo(
    () =>
      new THREE.ShaderMaterial({
        side: THREE.BackSide,
        depthWrite: false,
        fog: false,
        uniforms: { top: { value: new THREE.Color("#7fa7d1") }, horizon: { value: new THREE.Color("#e8eef3") }, ground: { value: new THREE.Color("#c9cfc6") } },
        vertexShader: "varying vec3 vP; void main(){ vP = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }",
        fragmentShader:
          "uniform vec3 top; uniform vec3 horizon; uniform vec3 ground; varying vec3 vP; void main(){ float h = vP.y; vec3 c = h > 0.0 ? mix(horizon, top, pow(h, 0.55)) : mix(horizon, ground, min(1.0, -h * 4.0)); gl_FragColor = vec4(c, 1.0); }",
      }),
    [],
  );
  const { camera } = useThree();
  const ref = useRef<THREE.Mesh>(null);
  useFrame(() => ref.current?.position.copy(camera.position));
  return (
    <mesh ref={ref} material={mat} renderOrder={-1} frustumCulled={false}>
      <sphereGeometry args={[1500, 32, 16]} />
    </mesh>
  );
}

// ---------------- lighting / sun ----------------

function sunVector(property: Property, hour: number) {
  const lat = property.lat ?? 36.5,
    lng = property.lng ?? -4.9;
  const d = new Date();
  // local solar-ish time: hour in the property's longitude timezone
  d.setUTCHours(Math.floor(hour - lng / 15), ((hour - lng / 15) % 1) * 60, 0, 0);
  const p = SunCalc.getPosition(d, lat, lng);
  const alt = Math.max(0.05, p.altitude);
  // suncalc azimuth: 0 = south, positive towards west. World: north = -z, east = +x.
  return new THREE.Vector3(-Math.sin(p.azimuth) * Math.cos(alt), Math.sin(alt), Math.cos(p.azimuth) * Math.cos(alt)).normalize();
}

function Lights({ property, bounds, hour }: { property: Property; bounds: SceneBounds; hour: number }) {
  const sun = useMemo(() => sunVector(property, hour), [property, hour]);
  const r = Math.max(bounds.radius * 2.2, 18);
  return (
    <>
      <hemisphereLight args={["#dfe9f5", "#8a8170", 0.35]} />
      <directionalLight
        castShadow
        position={[bounds.cx + sun.x * 60, sun.y * 60, bounds.cz + sun.z * 60]}
        intensity={3.2}
        color="#fff1dc"
        shadow-mapSize={[2048, 2048]}
        shadow-bias={-0.0004}
        shadow-normalBias={0.03}
        shadow-camera-left={-r}
        shadow-camera-right={r}
        shadow-camera-top={r}
        shadow-camera-bottom={-r}
        shadow-camera-near={1}
        shadow-camera-far={200}
      >
        <object3D attach="target" position={[bounds.cx, 0, bounds.cz]} />
      </directionalLight>
    </>
  );
}

// ---------------- ground / map ----------------

/** Illustrative pool in front of the main glazed facade. */
export function poolPosition(floors: StackedFloor[], b: SceneBounds): [number, number, number] {
  const f = frontDirection(floors[0].plan, b);
  const ext = Math.abs(f[0]) > Math.abs(f[1]) ? b.w / 2 : b.d / 2;
  const dist = ext + 3 + 2.6;
  return [b.cx + f[0] * dist, -0.25, b.cz + f[1] * dist];
}

function Ground({ property, bounds, hasPool, floors }: { property: Property; bounds: SceneBounds; hasPool: boolean; floors: StackedFloor[] }) {
  const google = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
  const mapbox = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;
  const hasGeo = property.lat != null && property.lng != null;
  const [sat, setSat] = useState<THREE.Texture | null>(null);
  const zoom = 18;
  const size = useMemo(() => (hasGeo ? (1280 * 156543.03392 * Math.cos(((property.lat ?? 0) * Math.PI) / 180)) / 2 ** zoom : 0), [hasGeo, property.lat]);
  useEffect(() => {
    if (!mapbox || !hasGeo || google) return;
    const url = `https://api.mapbox.com/styles/v1/mapbox/satellite-v9/static/${property.lng},${property.lat},${zoom},0/1280x1280@2x?access_token=${mapbox}&attribution=false&logo=false`;
    new THREE.TextureLoader().load(url, (t) => {
      t.colorSpace = THREE.SRGBColorSpace;
      setSat(t);
    });
  }, [mapbox, hasGeo, google, property.lat, property.lng]);
  const pad = 3;
  return (
    <group>
      {google && hasGeo ? (
        <Suspense fallback={null}>
          <GoogleTiles lat={property.lat!} lng={property.lng!} apiKey={google} center={[bounds.cx, bounds.cz]} />
        </Suspense>
      ) : sat ? (
        <mesh rotation-x={-Math.PI / 2} position={[bounds.cx, -0.27, bounds.cz]} receiveShadow>
          <planeGeometry args={[size, size]} />
          <meshStandardMaterial map={sat} roughness={1} />
        </mesh>
      ) : (
        <mesh rotation-x={-Math.PI / 2} position={[bounds.cx, -0.27, bounds.cz]} receiveShadow>
          <circleGeometry args={[220, 64]} />
          <meshStandardMaterial map={groundTexture()} roughness={1} />
        </mesh>
      )}
      {/* paved plinth around the building (illustrative) */}
      <mesh rotation-x={-Math.PI / 2} position={[bounds.cx, -0.255, bounds.cz]} receiveShadow>
        <planeGeometry args={[bounds.w + pad * 2, bounds.d + pad * 2]} />
        <meshStandardMaterial color="#d8d0c2" roughness={0.9} />
      </mesh>
      {hasPool && (
        <group position={poolPosition(floors, bounds)} rotation-y={Math.abs(frontDirection(floors[0].plan, bounds)[0]) > 0.7 ? Math.PI / 2 : 0}>
          <mesh rotation-x={-Math.PI / 2} position={[0, 0.005, 0]} receiveShadow>
            <planeGeometry args={[9.6, 4.6]} />
            <meshStandardMaterial color="#e9e3d8" roughness={0.8} />
          </mesh>
          <mesh rotation-x={-Math.PI / 2} position={[0, 0.02, 0]}>
            <planeGeometry args={[8.5, 3.6]} />
            <meshPhysicalMaterial color="#3fa6c9" roughness={0.05} metalness={0.1} clearcoat={1} transparent opacity={0.92} />
          </mesh>
        </group>
      )}
    </group>
  );
}

function GoogleTiles({ lat, lng, apiKey, center }: { lat: number; lng: number; apiKey: string; center: [number, number] }) {
  const [mods, setMods] = useState<any>(null);
  useEffect(() => {
    Promise.all([import("3d-tiles-renderer/r3f"), import("3d-tiles-renderer/plugins")]).then(([r3f, plugins]) => setMods({ r3f, plugins }));
  }, []);
  const group = useRef<THREE.Group>(null);
  const settled = useRef(0);
  const ray = useMemo(() => new THREE.Raycaster(), []);
  // drop the tiles so the terrain at the property sits at y = 0
  useFrame(() => {
    if (!group.current || settled.current > 40) return;
    ray.set(new THREE.Vector3(center[0], 3000, center[1]), new THREE.Vector3(0, -1, 0));
    const hit = ray.intersectObject(group.current, true)[0];
    if (hit) {
      group.current.position.y -= hit.point.y + 0.3;
      settled.current++;
    }
  });
  if (!mods) return null;
  const { TilesRenderer, TilesPlugin } = mods.r3f;
  const { GoogleCloudAuthPlugin, ReorientationPlugin, TileCompressionPlugin, UpdateOnChangePlugin } = mods.plugins;
  const D = Math.PI / 180;
  return (
    <group ref={group} position={[center[0], 0, center[1]]}>
      <TilesRenderer>
        <TilesPlugin plugin={GoogleCloudAuthPlugin} args={{ apiToken: apiKey, autoRefreshToken: true }} />
        <TilesPlugin plugin={ReorientationPlugin} args={{ lat: lat * D, lon: lng * D, height: 0, up: "+y", recenter: true }} />
        <TilesPlugin plugin={TileCompressionPlugin} />
        <TilesPlugin plugin={UpdateOnChangePlugin} />
      </TilesRenderer>
    </group>
  );
}

// ---------------- camera rig & walk ----------------

function CameraRig({ floors, bounds, property }: { floors: StackedFloor[]; bounds: SceneBounds; property: Property }) {
  const ref = useRef<CameraControls>(null);
  const { mode, floorIndex, panoRoomId, booth, tourPaused, set } = useViewer();
  const [walkReady, setWalkReady] = useState(false);
  const { camera } = useThree();
  const floor = floors[floorIndex] ?? floors[0];
  const D = Math.max(bounds.w, bounds.d, 8);
  const E = Math.max(D, bounds.height * 1.1); // exterior framing includes tall buildings
  // interior views frame the unit itself, not the whole (illustrative) building
  const ub = useMemo(() => sceneBounds(floors), [floors]);
  const Du = Math.max(ub.w, ub.d, 8);

  useEffect(() => {
    const c = ref.current;
    if (!c || !floor) return;
    setWalkReady(false);
    c.enabled = true;
    c.minPolarAngle = 0;
    c.maxPolarAngle = Math.PI / 2 - 0.05;
    c.minDistance = 1;
    c.maxDistance = 400;
    c.dollySpeed = 1;
    c.truckSpeed = 1;
    c.azimuthRotateSpeed = 1;
    c.polarRotateSpeed = 1;
    (camera as THREE.PerspectiveCamera).fov = 45;
    camera.updateProjectionMatrix();
    const el = floor.elevation;
    if (mode === "exterior") {
      // three-quarter view onto the most glazed facade
      const f = frontDirection(floors[0].plan, bounds);
      const a = Math.PI / 5;
      const dx = f[0] * Math.cos(a) - f[1] * Math.sin(a),
        dz = f[0] * Math.sin(a) + f[1] * Math.cos(a);
      c.setLookAt(bounds.cx + dx * E * 1.75, bounds.height * 0.6 + E * 0.5, bounds.cz + dz * E * 1.75, bounds.cx, bounds.height * 0.4, bounds.cz, true);
    } else if (mode === "dollhouse") {
      c.setLookAt(ub.cx + Du * 0.75, el + Du * 1.05, ub.cz + Du * 0.95, ub.cx, el + 0.8, ub.cz, true);
    } else if (mode === "plan") {
      c.maxPolarAngle = 0.0001;
      c.setLookAt(ub.cx, el + Du * 1.9, ub.cz + 0.001, ub.cx, el, ub.cz, true);
    } else if (mode === "walk") {
      const s = walkStart(floor.plan);
      c.setLookAt(s.pos[0], el + 1.6, s.pos[1], s.look[0], el + 1.5, s.look[1], true).then(() => {
        c.enabled = false;
        setWalkReady(true);
      });
    } else if (mode === "pano") {
      const eye = panoEye(property, floors, panoRoomId);
      if (eye) {
        c.minDistance = c.maxDistance = 0.01;
        c.dollySpeed = 0;
        c.truckSpeed = 0;
        c.maxPolarAngle = Math.PI;
        c.azimuthRotateSpeed = -0.35;
        c.polarRotateSpeed = -0.35;
        c.setLookAt(eye[0], eye[1], eye[2], eye[0] + 0.01, eye[1], eye[2] + 0.001, false);
        (camera as THREE.PerspectiveCamera).fov = 70;
        camera.updateProjectionMatrix();
      }
    }
    track(property.slug, "mode_change", { mode });
  }, [mode, floorIndex, panoRoomId, bounds, ub, Du, E, floor, camera, property, floors]);

  // ---- exhibition booth: scripted, looping camera tour ----
  useEffect(() => {
    if (!booth || tourPaused) return;
    const shots: (() => void)[] = [];
    const c = () => ref.current!;
    shots.push(() => set({ mode: "exterior" }));
    shots.push(() => {
      c().rotate(Math.PI * 0.6, 0, true);
    });
    floors.forEach((_, i) => shots.push(() => set({ mode: "dollhouse", floorIndex: i })));
    shots.push(() => set({ mode: "plan", floorIndex: 0 }));
    // interior glide through the main rooms
    floors.forEach((f, i) =>
      f.plan.rooms
        .filter((r) => ["living", "kitchen", "bedroom", "dining"].includes(r.type))
        .slice(0, 3)
        .forEach((r) =>
          shots.push(() => {
            set({ mode: "dollhouse", floorIndex: i });
            const [x, z] = polygonCentroid(r.polygon);
            setTimeout(() => ref.current?.setLookAt(x + 2.4, f.elevation + 1.7, z + 2.4, x, f.elevation + 1.0, z, true), 50);
          }),
        ),
    );
    let k = 0;
    shots[0]();
    const id = setInterval(() => {
      k = (k + 1) % shots.length;
      shots[k]();
    }, 7000);
    return () => clearInterval(id);
  }, [booth, tourPaused, floors, set]);

  useFrame((_, dt) => {
    if (booth && !tourPaused && ref.current && mode === "exterior") ref.current.rotate(dt * 0.08, 0, false);
  });

  return (
    <>
      <CameraControls ref={ref} makeDefault smoothTime={0.6} />
      {mode === "walk" && walkReady && floor && <WalkController floor={floor} />}
    </>
  );
}

function panoEye(property: Property, floors: StackedFloor[], roomId: string | null): [number, number, number] | null {
  const b = property.buildings[0];
  for (const f of b?.floors ?? []) {
    const r = f.rooms.find((x) => x.id === roomId);
    if (!r) continue;
    const sf = floors.find((x) => x.id === f.id);
    const pr = sf?.plan.rooms.find((x) => x.id === r.planRoomId);
    if (!sf || !pr) return null;
    const [x, z] = polygonCentroid(pr.polygon);
    return [x, sf.elevation + 1.6, z];
  }
  return null;
}

function WalkController({ floor }: { floor: StackedFloor }) {
  const { camera, gl, scene } = useThree();
  const segs = useMemo(() => collisionSegments(floor.plan), [floor.plan]);
  const keys = useRef(new Set<string>());
  const yaw = useRef(0);
  const pitch = useRef(0);
  const target = useRef<Vec2 | null>(null);
  const lastRoomCheck = useRef(1);
  const walkTarget = useViewer((s) => s.walkTarget);

  useEffect(() => {
    const e = new THREE.Euler().setFromQuaternion(camera.quaternion, "YXZ");
    yaw.current = e.y;
    pitch.current = e.x;
    const el = gl.domElement;
    let drag: { x: number; y: number; moved: boolean } | null = null;
    const down = (ev: PointerEvent) => {
      drag = { x: ev.clientX, y: ev.clientY, moved: false };
    };
    const move = (ev: PointerEvent) => {
      if (document.pointerLockElement === el) {
        yaw.current -= ev.movementX * 0.0025;
        pitch.current = THREE.MathUtils.clamp(pitch.current - ev.movementY * 0.0025, -1.2, 1.2);
        return;
      }
      if (!drag) return;
      const dx = ev.clientX - drag.x,
        dy = ev.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
      yaw.current += dx * 0.004;
      pitch.current = THREE.MathUtils.clamp(pitch.current + dy * 0.004, -1.2, 1.2);
      drag.x = ev.clientX;
      drag.y = ev.clientY;
    };
    const up = (ev: PointerEvent) => {
      if (drag && !drag.moved) {
        // click-to-move: raycast the walkable floor of this storey
        const rect = el.getBoundingClientRect();
        const ndc = new THREE.Vector2(((ev.clientX - rect.left) / rect.width) * 2 - 1, -((ev.clientY - rect.top) / rect.height) * 2 + 1);
        const rc = new THREE.Raycaster();
        rc.setFromCamera(ndc, camera);
        const floorGroup = scene.getObjectByName(`floor-${floor.level}`);
        const hits = floorGroup ? rc.intersectObjects(floorGroup.children.filter((o) => o.name === "walkable"), false) : [];
        if (hits[0]) target.current = [hits[0].point.x, hits[0].point.z];
      }
      drag = null;
    };
    const kd = (ev: KeyboardEvent) => {
      keys.current.add(ev.code);
      if (ev.code === "KeyL") el.requestPointerLock?.();
    };
    const ku = (ev: KeyboardEvent) => keys.current.delete(ev.code);
    el.addEventListener("pointerdown", down);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("keydown", kd);
    window.addEventListener("keyup", ku);
    return () => {
      el.removeEventListener("pointerdown", down);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("keydown", kd);
      window.removeEventListener("keyup", ku);
      if (document.pointerLockElement === el) document.exitPointerLock();
    };
  }, [camera, gl, scene, floor.level]);

  useEffect(() => {
    if (walkTarget) target.current = walkTarget;
  }, [walkTarget]);

  useFrame((_, dtRaw) => {
    const dt = Math.min(dtRaw, 0.05);
    const k = keys.current;
    let fwd = walkInput.moveY + (k.has("KeyW") || k.has("ArrowUp") ? 1 : 0) - (k.has("KeyS") || k.has("ArrowDown") ? 1 : 0);
    let str = walkInput.moveX + (k.has("KeyD") ? 1 : 0) - (k.has("KeyA") ? 1 : 0);
    yaw.current -= ((k.has("ArrowRight") ? 1 : 0) - (k.has("ArrowLeft") ? 1 : 0)) * dt * 1.6 + walkInput.lookX * dt * 1.8;
    pitch.current = THREE.MathUtils.clamp(pitch.current - walkInput.lookY * dt * 1.2, -1.2, 1.2);
    const speed = (k.has("ShiftLeft") ? 2.6 : 1.4) * dt;
    const p: Vec2 = [camera.position.x, camera.position.z];
    let delta: Vec2 = [0, 0];
    if (fwd || str) {
      target.current = null;
      const l = Math.hypot(fwd, str);
      if (l > 1) {
        fwd /= l;
        str /= l;
      }
      const sy = Math.sin(yaw.current),
        cy = Math.cos(yaw.current);
      delta = [(-sy * fwd + cy * str) * speed, (-cy * fwd - sy * str) * speed];
    } else if (target.current) {
      const dx = target.current[0] - p[0],
        dz = target.current[1] - p[1];
      const d = Math.hypot(dx, dz);
      if (d < 0.05) target.current = null;
      else {
        const s = Math.min(d, speed * 1.4);
        delta = [(dx / d) * s, (dz / d) * s];
        // turn towards the destination
        const want = Math.atan2(-dx, -dz);
        yaw.current += Math.atan2(Math.sin(want - yaw.current), Math.cos(want - yaw.current)) * Math.min(1, dt * 3);
      }
    }
    const np = moveWithCollisions(p, delta, segs, 0.25);
    // publish the current room (for the real-photo strip) when it changes
    lastRoomCheck.current += dt;
    if (lastRoomCheck.current > 0.3) {
      lastRoomCheck.current = 0;
      const r = roomAt(floor.plan, np);
      const cur = useViewer.getState().walkRoom;
      if ((r?.id ?? null) !== (cur?.planRoomId ?? null) || cur?.floorId !== floor.id)
        useViewer.setState({ walkRoom: r ? { floorId: floor.id, planRoomId: r.id } : null });
    }
    camera.position.set(np[0], floor.elevation + 1.6, np[1]);
    camera.quaternion.setFromEuler(new THREE.Euler(pitch.current, yaw.current, 0, "YXZ"));
  });
  return null;
}

function VROrigin({ floor }: { floor: StackedFloor }) {
  const s = walkStart(floor.plan);
  return <XROrigin position={[s.pos[0], floor.elevation, s.pos[1]]} />;
}

// ---------------- AR (tabletop placement) ----------------

function ARPlacement({ children }: { children: React.ReactNode }) {
  const reticle = useRef<THREE.Mesh>(null);
  const placed = useRef<THREE.Group>(null);
  const [isPlaced, setPlaced] = useState(false);
  const session = useXR((s) => s.session);
  const m = useMemo(() => new THREE.Matrix4(), []);
  useXRHitTest((results, getWorldMatrix) => {
    if (!results.length || !reticle.current) return;
    getWorldMatrix(m, results[0]);
    reticle.current.visible = !isPlaced;
    reticle.current.position.setFromMatrixPosition(m);
  }, "viewer");
  useEffect(() => {
    if (!session) return;
    const onSelect = () => {
      if (reticle.current && placed.current) {
        placed.current.position.copy(reticle.current.position);
        setPlaced(true);
      }
    };
    session.addEventListener("select", onSelect);
    return () => session.removeEventListener("select", onSelect);
  }, [session]);
  return (
    <>
      <mesh ref={reticle} rotation-x={-Math.PI / 2} visible={false}>
        <ringGeometry args={[0.08, 0.1, 32]} />
        <meshBasicMaterial color="#ffffff" />
      </mesh>
      {/* 1:50 table-top model */}
      <group ref={placed} visible={isPlaced} scale={0.02}>
        {children}
      </group>
    </>
  );
}

// ---------------- 360° panoramas ----------------

function PanoView({ property, floors }: { property: Property; floors: StackedFloor[] }) {
  const panoRoomId = useViewer((x) => x.panoRoomId);
  const rooms = property.buildings[0].floors.flatMap((f) => f.rooms);
  const room = rooms.find((r) => r.id === panoRoomId);
  const art = room?.artifacts.find((a) => a.kind === "panorama");
  const [tex, setTex] = useState<THREE.Texture | null>(null);
  useEffect(() => {
    if (!art) return;
    new THREE.TextureLoader().load(art.url, (t) => {
      t.colorSpace = THREE.SRGBColorSpace;
      t.mapping = THREE.EquirectangularReflectionMapping;
      setTex(t);
    });
  }, [art]);
  const eye = panoEye(property, floors, panoRoomId);
  if (!eye || !tex) return null;
  return (
    <group position={eye}>
      <mesh scale={[-1, 1, 1]}>
        <sphereGeometry args={[40, 64, 32]} />
        <meshBasicMaterial map={tex} side={THREE.BackSide} toneMapped={false} />
      </mesh>
    </group>
  );
}

// ---------------- photoreal (Gaussian splats) ----------------

function SplatLayer({ property }: { property: Property }) {
  const splat = property.artifacts.find((a) => a.kind === "splat");
  const { scene } = useThree();
  useEffect(() => {
    if (!splat) return;
    let viewer: any;
    let disposed = false;
    import("@mkkellogg/gaussian-splats-3d").then((G: any) => {
      if (disposed) return;
      viewer = new G.DropInViewer({ gpuAcceleratedSort: false, sharedMemoryForWorkers: false });
      const t = splat.meta?.transform ?? {};
      viewer
        .addSplatScene(splat.url, {
          format: /\.ply/i.test(splat.url) ? G.SceneFormat.Ply : undefined,
          position: t.position ?? [0, 0, 0],
          rotation: t.rotation ?? [0, 0, 0, 1],
          scale: t.scale ?? [1, 1, 1],
          showLoadingUI: false,
        })
        .catch((e: unknown) => console.warn("splat load failed", e));
      scene.add(viewer);
    });
    return () => {
      disposed = true;
      if (viewer) {
        scene.remove(viewer);
        viewer.dispose?.();
      }
    };
  }, [splat, scene]);
  return null;
}
