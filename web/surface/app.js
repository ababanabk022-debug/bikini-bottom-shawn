import * as THREE from './vendor/three.module.js';
import { createOcean, impactRippleArrivalTime, sampleImpactRipple, waveFunctions, waveHeight, waveNormal } from './ocean.js';
import { createProps } from './props.js';
import { createEnvironment, createSky } from './sky.js';
import { createUnderwater } from './underwater.js';
import { createSpray } from './spray.js';
import { createShoreline } from './shoreline.js';
import { createWindWaves } from './wind-waves.js';
import { createFloatGrab } from './float-grab.js';
import { resolveFloatCollisions } from './float-collisions.js';
import { createImpactSpray } from './impact-spray.js';
import { createIsland } from './island.js';
import { createTitlePlaque } from './title-plaque.js';
import { createCarrierGull } from './carrier-gull.js';
import { createTitleFlight } from './title-flight.js';

const canvas = document.querySelector('#ocean');
const viewport = canvas.parentElement;
const motion = matchMedia('(prefers-reduced-motion: reduce)');
const params = new URLSearchParams(location.search);
const requestedPhase = params.get('phase');
const filmMode = params.get('film') === '1';
const initialPhase = requestedPhase !== null && Number.isFinite(Number(requestedPhase)) ? Number(requestedPhase) : 0.015;
const dayLength = 144;
const floatRiseDuration = 0.98;

function makeEnvironmentMap() {
  const lightProbe = document.createElement('canvas');
  lightProbe.width = 256;
  lightProbe.height = 128;
  const context = lightProbe.getContext('2d');
  const gradient = context.createLinearGradient(0, 0, 0, lightProbe.height);
  gradient.addColorStop(0, '#387bb7');
  gradient.addColorStop(0.40, '#9dcee8');
  gradient.addColorStop(0.49, '#d8eaf0');
  gradient.addColorStop(0.54, '#518993');
  gradient.addColorStop(1, '#103541');
  context.fillStyle = gradient;
  context.fillRect(0, 0, lightProbe.width, lightProbe.height);
  context.save();
  context.translate(151, 43);
  context.scale(1.65, 0.60);
  const sunshine = context.createRadialGradient(0, 0, 1, 0, 0, 28);
  sunshine.addColorStop(0, 'rgba(255,249,229,0.98)');
  sunshine.addColorStop(0.46, 'rgba(255,243,210,0.72)');
  sunshine.addColorStop(1, 'rgba(255,241,218,0)');
  context.fillStyle = sunshine;
  context.fillRect(-28, -28, 56, 56);
  context.restore();
  const texture = new THREE.CanvasTexture(lightProbe);
  texture.mapping = THREE.EquirectangularReflectionMapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function shadeWetSurfaces(object, clock, preparedMaterials, submerged = false, film = null) {
  const kind = object.userData.kind;
  const barrel = kind === 'barrel';
  function prepare(material) {
    if (!material?.isMeshStandardMaterial || preparedMaterials.has(material)) return;
    preparedMaterials.add(material);
    const waterlineProgram = [submerged ? 'submerged-surface' : film ? 'wet-grabbable' : 'wet-waterline',
      kind, material.userData.barrelWood ? 'wood' : ''].join(':');
    material.customProgramCacheKey = () => waterlineProgram;
    material.onBeforeCompile = shader => {
      shader.uniforms.uWetTime = clock;
      shader.vertexShader = `varying vec3 vWetPoint;\n${shader.vertexShader}`.replace(
        '#include <project_vertex>',
        '#include <project_vertex>\nvWetPoint = (modelMatrix * vec4(transformed, 1.0)).xyz;',
      );
      shader.fragmentShader = `uniform float uWetTime;\nvarying vec3 vWetPoint;\n${waveFunctions}\n${shader.fragmentShader}`.replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
         float heightAboveWater = vWetPoint.y - surfaceHeight(vWetPoint.xz, uWetTime);
         ${submerged ? `if (heightAboveWater > 0.006) discard;
         vec2 causticPoint = vWetPoint.xz * 4.8 + vWetPoint.y * vec2(1.4, -0.9);
         float band = sin(causticPoint.x + sin(causticPoint.y * 1.23 + uWetTime * 0.93) * 1.35);
         float crossed = sin(causticPoint.y * 1.1 + causticPoint.x * 0.82 - uWetTime * 0.79);
         float focusedLight = pow(1.0 - min(abs(band), abs(crossed)), 4.0);
         diffuseColor.rgb *= 0.90 + focusedLight * 0.24;` : ''}
         float wet = 1.0 - smoothstep(0.01, 0.13, heightAboveWater);
         diffuseColor.rgb *= mix(vec3(1.0), vec3(0.53, 0.71, 0.73), wet * ${submerged ? '0.57' : '0.79'});
         roughnessFactor = mix(roughnessFactor, 0.29, wet * 0.62);`,
      );
      if (material.userData.barrelWood) {
        // Use the next mip fraction for minified grain while keeping the
        // full-resolution albedo for close views.
        shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>',
          THREE.ShaderChunk.map_fragment.replace('texture2D( map, vMapUv )', 'texture2D( map, vMapUv, 0.50 )'));
      }
      if (film) {
        shader.uniforms.uWetPlane = film.plane;
        shader.uniforms.uWetFilm = film.strength;
        shader.fragmentShader = 'uniform vec4 uWetPlane;\nuniform float uWetFilm;\n' + shader.fragmentShader.replace(
          'float wet = 1.0 - smoothstep(0.01, 0.13, heightAboveWater);',
          `float previouslyWet = 1.0 - smoothstep(-0.022, 0.038, dot(uWetPlane, vec4(vWetPoint, 1.0)));
           float wet = max(1.0 - smoothstep(0.01, 0.13, heightAboveWater), previouslyWet * uWetFilm);`,
        );
      }
      if (!submerged && kind !== 'plaque' && material.bumpMap && (!barrel || material.userData.barrelWood)) {
        // Pin sparse droplets to the wood and paint while the hull rocks.
        shader.vertexShader = 'varying vec3 vHullPoint;\n' + shader.vertexShader.replace(
          '#include <begin_vertex>', '#include <begin_vertex>\nvHullPoint = position;',
        );
        shader.fragmentShader = 'varying vec3 vHullPoint;\n' + shader.fragmentShader.replace(
          '#include <normal_fragment_maps>',
          `#include <normal_fragment_maps>
           vec3 hullFace = normalize(cross(dFdx(vHullPoint), dFdy(vHullPoint)));
           vec2 beadUv = abs(hullFace.x) > 0.82 ? vHullPoint.zy
             : vec2(vHullPoint.x, atan(vHullPoint.z, vHullPoint.y) * length(vHullPoint.yz));
           beadUv *= 35.0;
           vec2 cell = floor(beadUv);
           vec3 seeds = fract(sin(vec3(dot(cell, vec2(13.1, 29.4)),
             dot(cell, vec2(39.6, 57.1)), dot(cell, vec2(27.1, 15.7)))) * 18342.7);
           vec2 offset = (fract(beadUv) - (0.27 + seeds.xy * 0.46)) * vec2(1.0, 0.79);
           ${barrel ? `
           float radius2 = 0.022 + 0.040 * seeds.x;
           vec2 uvDx = dFdx(beadUv);
           vec2 uvDy = dFdy(beadUv);
           float footprint = max(max(length(uvDx), length(uvDy)), 0.001);
           float coverage = smoothstep(0.62, 1.45, sqrt(radius2) / footprint)
             * smoothstep(0.68, 0.86, seeds.z);
           float profile = max(0.0, 1.0 - dot(offset, offset) / radius2);
           // Differentiate the bead in material space. Differencing its
           // screen-filtered height would also differentiate the filter.
           vec2 gradient = -0.0048 * profile * offset * vec2(1.0, 0.79) / radius2;
           vec2 beadSlope = vec2(dot(gradient, uvDx), dot(gradient, uvDy)) * coverage;
           normal = perturbNormalArb(-vViewPosition, normal, beadSlope, faceDirection);
           roughnessFactor = mix(roughnessFactor, max(roughnessFactor * 0.66, 0.30), profile * coverage);` : `
           float bead = max(0.0, 1.0 - dot(offset, offset) / (0.014 + 0.046 * seeds.x));
           bead *= smoothstep(0.65, 0.84, seeds.z)
             * (1.0 - smoothstep(0.26, 0.73, length(fwidth(beadUv))));
           float beadHeight = bead * bead * 0.0021;
           normal = perturbNormalArb(-vViewPosition, normal, vec2(dFdx(beadHeight), dFdy(beadHeight)), faceDirection);
           roughnessFactor = mix(roughnessFactor, 0.10, bead);`}`,
        );
      }
    };
  }
  object.traverse(mesh => {
    if (Array.isArray(mesh.material)) mesh.material.forEach(prepare);
    else prepare(mesh.material);
  });
}

function cloneFloatMaterials(object, materials) {
  function clone(original) {
    if (!materials.has(original)) materials.set(original, original.clone());
    return materials.get(original);
  }
  object.traverse(mesh => {
    if (!mesh.isMesh) return;
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map(clone) : clone(mesh.material);
  });
}

function cloneSubmerged(object, materials) {
  const submerged = object.clone();
  cloneFloatMaterials(submerged, materials);
  return submerged;
}

export function start(sound, { createDiveTransition, shallowModels } = {}) {
  const studioIntro = window.studioIntro;
  const startupTime = performance.now();
  const assetDeadline = startupTime + 12000;
  let texturesSettled = false;
  let textureLoadFailed = false;
  const loadingManager = new THREE.LoadingManager(() => { texturesSettled = true; }, undefined,
    () => { textureLoadFailed = true; });
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  const gl = renderer.getContext();
  const rendererInfo = gl.getExtension('WEBGL_debug_renderer_info');
  const softwareRenderer = Boolean(rendererInfo && /swiftshader|llvmpipe|software rasterizer|basic render/i.test(
    gl.getParameter(rendererInfo.UNMASKED_RENDERER_WEBGL)));
  const startupPixels = filmMode ? 1920 * 1080 : softwareRenderer ? 720 * 405 : 1440 * 810;
  const minimumPixels = softwareRenderer ? 480 * 270 : 800 * 450;
  const qualitySelect = document.getElementById('sea-quality');
  const qualityPreference = 'bikini-surface-quality';
  if (qualitySelect) {
    try {
      const savedQuality = localStorage.getItem(qualityPreference);
      if (savedQuality === 'auto' || savedQuality === 'detail') qualitySelect.value = savedQuality;
    } catch {
      // Keep the setting usable when browser storage is unavailable.
    }
    qualitySelect.hidden = filmMode;
  }
  let detailQuality = !filmMode && qualitySelect?.value === 'detail';
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 1.03;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.shadowMap.autoUpdate = false;

  const scene = new THREE.Scene();
  scene.environment = makeEnvironmentMap();
  const camera = new THREE.PerspectiveCamera(45, 1, 0.055, 6800);
  const reflectedCamera = new THREE.PerspectiveCamera();
  const floatTarget = renderer.extensions.has('EXT_color_buffer_float')
    || renderer.extensions.has('EXT_color_buffer_half_float');
  const reflectionTarget = new THREE.WebGLRenderTarget(2, 2, {
    type: floatTarget ? THREE.HalfFloatType : THREE.UnsignedByteType,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
  });
  const reflectionMatrix = new THREE.Matrix4();
  const reflection = {
    uReflectionMap: { value: reflectionTarget.texture },
    uReflectionMatrix: { value: reflectionMatrix },
  };
  const toTexture = new THREE.Matrix4().set(
    0.5, 0, 0, 0.5,
    0, 0.5, 0, 0.5,
    0, 0, 0.5, 0.5,
    0, 0, 0, 1,
  );
  const waterlineClip = [new THREE.Plane(new THREE.Vector3(0, 1, 0), 0.025)];
  const noClipping = [];

  const environment = createEnvironment();
  const atmosphere = createSky(environment, reflectedCamera, loadingManager);
  const wind = createWindWaves({ strength: 1.08, resolution: softwareRenderer ? 256 : 512 });
  const underwater = createUnderwater(renderer, environment, floatTarget, { fastOptics: softwareRenderer });
  underwater.setSunCaustics(wind.uniforms);
  underwater.scene.environment = scene.environment;
  const ocean = createOcean(environment.uniforms, reflection, underwater.uniforms, wind.uniforms, { softwareRenderer });
  ocean.setFastOptics(softwareRenderer);
  scene.add(atmosphere, ocean.mesh);

  const sun = new THREE.DirectionalLight();
  sun.castShadow = true;
  const shadowSize = softwareRenderer ? 512 : 1024;
  sun.shadow.mapSize.set(shadowSize, shadowSize);
  Object.assign(sun.shadow.camera, { left: -7, right: 7, top: 7, bottom: -7, near: 4, far: 44 });
  sun.shadow.bias = -0.00028;
  sun.shadow.normalBias = 0.004;
  const fill = new THREE.HemisphereLight('#bfdeff', '#3b6976', 1.1);
  const bouncedLight = new THREE.DirectionalLight('#f9dab1', 0.38);
  bouncedLight.position.set(8, 4.5, 6);
  scene.add(sun, fill, bouncedLight);

  const islandView = createIsland(renderer, environment, loadingManager);
  const island = islandView.mesh;
  Object.assign(ocean.mesh.material.uniforms, islandView.shadowUniforms);
  scene.add(island);
  const shoreline = createShoreline(island, environment);
  scene.add(shoreline.mesh);

  // Horizontal placement is screen-relative, while the different distances remain world-space.
  const composition = [
    { anchor: 0.35, distance: 5.55, portraitDistance: 7.35, riseAt: 1.40 },
    { anchor: 0.85, distance: 10.2, riseAt: 0.71 },
    { anchor: 0.52, distance: 23.4, portraitAnchor: 0.40, riseAt: 0.24 },
    { anchor: 0.15, distance: 7.05, portraitAnchor: 0.13, portraitDistance: 10.0, riseAt: 0.92 },
    { anchor: 0.735, distance: 4.28, portraitDistance: 5.98, riseAt: 2.02 },
    { anchor: 0.912, distance: 5.99, riseAt: 1.62 },
  ];
  const masses = { barrel: 7.0, can: 0.42, plaque: 5.4 };
  const waterClock = { value: 0 };
  const preparedMaterials = new Set();
  const submergedMaterials = new Map();
  function makeFloat(item, index, placement) {
    const kind = item.object.userData.kind;
    const film = {
      localUp: new THREE.Vector3(0, 1, 0), level: 0,
      plane: { value: new THREE.Vector4(0, 1, 0, 0) }, strength: { value: 0 },
    };
    // Lifted objects retain independent wet lines, even for shared paint or steel.
    cloneFloatMaterials(item.object, new Map());
    if (placement) {
      item.object.rotation.y = item.yaw;
      item.object.visible = false;
      scene.add(item.object);
    }
    shadeWetSurfaces(item.object, waterClock, preparedMaterials, false, film);
    const submerged = cloneSubmerged(item.object, submergedMaterials);
    shadeWetSurfaces(submerged, waterClock, preparedMaterials, true);
    underwater.scene.add(submerged);
    return {
      ...item,
      ...placement,
      kind, mass: masses[kind], yawVelocity: 0, submerged, film,
      phase: index * 2.23, awaitsImpact: false, lastImpact: -Infinity,
      rollKick: 0, rollVelocity: 0, spin: 0, freeRoll: 0,
      splash: { x: 0, z: 0, radius: item.radius, strength: 0, immersion: 0,
        axisX: 1, axisZ: 0, halfLength: item.length * 0.51, halfWidth: item.radius * 1.01 },
      drift: new THREE.Vector2(),
      momentum: new THREE.Vector2(),
      gripVelocity: new THREE.Vector3(), rippleHeight: 0,
      velocityY: 0,
    };
  }
  const risingFloats = createProps(loadingManager, { compactGeometry: softwareRenderer })
    .map((item, index) => makeFloat(item, index, composition[index]));
  const floats = [];
  const frontBarrel = risingFloats[0];
  const barrelFrameRadius = Math.hypot(frontBarrel.length * 0.5, frontBarrel.radius) + 0.045;
  const viewBounds = new THREE.Frustum();
  const viewProjection = new THREE.Matrix4();
  const spray = createSpray(risingFloats, environment);
  const impacts = createImpactSpray(environment);
  scene.add(spray.points, impacts.object);
  const plaque = createTitlePlaque(loadingManager);
  shadeWetSurfaces(plaque.board, waterClock, preparedMaterials);
  const titleFlight = createTitleFlight(scene, camera, plaque, createCarrierGull(), splashPlaque,
    { firstDelay: filmMode ? 12 : undefined, onAfloat: floatPlaque });
  const detailCanvas = document.querySelector('#flight-detail');
  const detailCamera = new THREE.PerspectiveCamera();
  const detailAnchor = new THREE.Vector3();
  const detailLayer = 1;
  let detailRenderer;
  let detailWidth = 0, detailHeight = 0;
  try {
    detailRenderer = new THREE.WebGLRenderer({
      canvas: detailCanvas, alpha: true, antialias: !softwareRenderer, powerPreference: 'high-performance',
    });
    detailRenderer.outputColorSpace = renderer.outputColorSpace;
    detailRenderer.toneMapping = renderer.toneMapping;
    detailRenderer.toneMappingExposure = renderer.toneMappingExposure;
    for (const light of [sun, fill, bouncedLight]) light.layers.enable(detailLayer);
    titleFlight.setFlightLayer(detailLayer);
    reflectedCamera.layers.enable(detailLayer);
  } catch {
    detailCanvas.hidden = true;
  }
  detailCanvas.addEventListener('webglcontextlost', () => {
    detailRenderer = undefined;
    detailCanvas.hidden = true;
    titleFlight.setFlightLayer(0);
  });
  const contactWakes = [];
  const ripples = [];
  const up = new THREE.Vector3(0, 1, 0);
  const axisX = new THREE.Vector3(1, 0, 0);
  const axisZ = new THREE.Vector3(0, 0, 1);
  const floatAxis = new THREE.Vector3();
  const localUp = new THREE.Vector3();
  const inverseAttitude = new THREE.Quaternion();
  const forward = new THREE.Vector3();
  const aim = new THREE.Vector3();
  const normal = new THREE.Vector3();
  const tilt = new THREE.Quaternion();
  const heading = new THREE.Quaternion();
  const roll = new THREE.Quaternion();
  const risePitch = new THREE.Quaternion();
  const rayPoint = new THREE.Vector3();
  const filmNormal = new THREE.Vector3();
  const localImpact = new THREE.Vector3();
  const packet = new THREE.Vector3();
  let time = 0;
  let openingTime = null;
  const timeSlider = document.querySelector('#time-of-day');
  const soundButton = document.querySelector('#sea-sound');
  const dive = createDiveTransition?.(viewport, motion, {
    softwareRenderer,
    filmMode,
    pauseSurface: () => renderer.setAnimationLoop(null),
    resumeSurface,
    onScene: scene => sound.setSubmerged(scene === 'shallow'),
    onFinished(scene) {
      if (scene !== 'surface') return;
      previous = performance.now();
      renderer.setAnimationLoop(renderFrame);
      canvas.inert = timeSlider.inert = soundButton.inert = false;
      if (!canvas.hasAttribute('tabindex')) canvas.tabIndex = -1;
      canvas.focus({ preventScroll: true });
    },
    playBubbles: () => sound.dive(),
  });
  const mediaReady = dive && Promise.all([dive.warmMedia(), sound.prepareDiveAudio()]);
  let sinkingPlaque;
  let impactX = 0;
  let surfacePresented;
  let openingRequested = false;
  let surfaceOpen = false;
  let floatWarmPass = 0;
  soundButton.hidden = !sound.available;
  let startSoundOnClick = false;
  function rememberSoundState() {
    startSoundOnClick = sound.enabled && !sound.ambientPlaying;
  }
  soundButton.addEventListener('pointerdown', rememberSoundState);
  soundButton.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') rememberSoundState();
  });
  soundButton.addEventListener('click', async () => {
    const pending = sound.setEnabled(startSoundOnClick || !sound.enabled || !sound.ambientPlaying);
    startSoundOnClick = false;
    soundButton.setAttribute('aria-pressed', String(sound.enabled));
    try {
      await pending;
    } finally {
      soundButton.setAttribute('aria-pressed', String(sound.enabled));
      soundButton.hidden = !sound.available;
    }
  });
  const timeSteps = Number(timeSlider.max);
  let dayPhase = THREE.MathUtils.euclideanModulo(initialPhase, 1);
  let scrubPointer = null;
  let scrubKey = false;
  let displayedStep = -1;
  let touchHideTimer;

  function revealTimeline(visible) {
    viewport.classList.toggle('show-timeline', visible);
  }

  function atBottom(event) {
    return innerHeight - event.clientY < 76;
  }

  viewport.addEventListener('pointermove', event => {
    if (event.pointerType !== 'touch') revealTimeline(atBottom(event));
  }, { passive: true });
  viewport.addEventListener('pointerleave', event => {
    if (event.pointerType !== 'touch') revealTimeline(false);
  });
  viewport.addEventListener('pointerdown', event => {
    clearTimeout(touchHideTimer);
    if (event.pointerType === 'touch') revealTimeline(atBottom(event) || event.target === timeSlider);
  }, { passive: true });

  function syncTimeSlider() {
    const step = Math.round(dayPhase * timeSteps);
    if (step === displayedStep) return;
    displayedStep = step;
    timeSlider.valueAsNumber = step;
    timeSlider.style.setProperty('--played', `${step / timeSteps * 100}%`);
    // Sunrise and sunset are the endpoints of the daylight arc in the scene.
    const hour = dayPhase < 0.62 ? 6 + 12 * dayPhase / 0.62 : 18 + 12 * (dayPhase - 0.62) / 0.38;
    const minutes = Math.round(hour * 60) % 1440;
    timeSlider.setAttribute('aria-valuetext', `${Math.floor(minutes / 60)}时${minutes % 60}分`);
  }

  timeSlider.addEventListener('input', () => {
    dayPhase = timeSlider.valueAsNumber / timeSteps;
    syncTimeSlider();
  });
  timeSlider.addEventListener('pointerdown', event => {
    if (event.isPrimary && event.button === 0) {
      scrubPointer = event.pointerId;
      viewport.classList.add('scrubbing');
    }
  });
  function finishPointerScrub(event) {
    if (scrubPointer === event.pointerId) {
      scrubPointer = null;
      viewport.classList.remove('scrubbing');
    }
    if (event.pointerType === 'touch' && viewport.classList.contains('show-timeline')) {
      clearTimeout(touchHideTimer);
      touchHideTimer = setTimeout(() => revealTimeline(false), 1800);
    }
  }
  window.addEventListener('pointerup', finishPointerScrub);
  window.addEventListener('pointercancel', finishPointerScrub);
  timeSlider.addEventListener('keydown', event => {
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) scrubKey = true;
  });
  timeSlider.addEventListener('keyup', () => { scrubKey = false; });
  function finishScrub() {
    scrubKey = false;
    scrubPointer = null;
    viewport.classList.remove('scrubbing');
  }
  timeSlider.addEventListener('blur', finishScrub);
  window.addEventListener('blur', () => {
    finishScrub();
    revealTimeline(false);
  });
  syncTimeSlider();
  let frame = 0;
  let canRender = true;
  let renderScale = null;
  let renderFloor = 0;
  let renderPressure = softwareRenderer;
  let frameTimeTotal = 0;
  let frameTimeSamples = 0;
  let fastSeconds = 0;
  let lastShadowUpdate = -Infinity;
  let layoutWidth = 0, layoutHeight = 0;
  qualitySelect?.addEventListener('change', () => {
    detailQuality = qualitySelect.value === 'detail';
    try {
      localStorage.setItem(qualityPreference, qualitySelect.value);
    } catch {
      // Apply the selection for this visit even without storage.
    }
    renderScale = null;
    renderPressure = softwareRenderer;
    frameTimeTotal = frameTimeSamples = fastSeconds = 0;
    ocean.setFastOptics(renderPressure);
    if (layoutWidth && layoutHeight) {
      resizeCanvas(layoutWidth, layoutHeight);
      resizeAccessoryViews(layoutWidth, layoutHeight);
    }
  });
  const current = new THREE.Vector2();
  const flightRay = new THREE.Raycaster();
  flightRay.layers.enable(detailLayer);
  const flightPointer = new THREE.Vector2();

  function pointingAtCarriedPlaque(event) {
    if (!canRender || !titleFlight.carrying || !event.isPrimary || grab.heldItem) return false;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return false;
    flightPointer.set(2 * (event.clientX - rect.left) / rect.width - 1,
      1 - 2 * (event.clientY - rect.top) / rect.height);
    flightRay.setFromCamera(flightPointer, camera);
    return titleFlight.hitTest(flightRay);
  }

  canvas.addEventListener('pointerdown', event => {
    if (event.button !== 0 || !pointingAtCarriedPlaque(event)) return;
    titleFlight.release(time);
    canvas.style.cursor = '';
    event.preventDefault();
    event.stopImmediatePropagation();
  });
  canvas.addEventListener('pointermove', event => {
    if (event.pointerType !== 'mouse' || !pointingAtCarriedPlaque(event)) return;
    canvas.style.cursor = 'pointer';
    event.stopImmediatePropagation();
  });
  canvas.addEventListener('keydown', event => {
    if (event.key !== 'Enter' || !canRender || !titleFlight.carrying || grab.heldItem) return;
    titleFlight.release(time);
    event.preventDefault();
  });

  function sampleDrift(item) {
    current.set(Math.sin(time * 0.28 + item.phase) * 0.15, Math.cos(time * 0.21 + item.phase) * 0.13);
    current.multiplyScalar(motion.matches ? 0.35 : 1);
  }

  const grab = createFloatGrab({
    canvas, camera, floats, getTime: () => time, enabled: () => canRender && !dive?.active,
    onWater: touchWater,
    onRelease(item, vx, vy, vz) {
      if (item === frontBarrel) keepFrontBarrelInView();
      const position = item.object.position;
      sampleDrift(item);
      item.z = position.z - current.y;
      const depth = camera.position.z - item.z;
      item.placedDepthRatio = depth / item.layoutDepth;
      const frameWidth = 2 * depth * Math.tan(camera.fov * Math.PI / 360) * camera.aspect;
      item.x = position.x - current.x;
      item.placedAnchor = 0.5 + item.x / frameWidth;
      item.drift.set(0, 0);
      item.momentum.set(vx, vz);
      item.velocityY = vy;
      floatAxis.copy(axisX).applyQuaternion(item.object.quaternion);
      const extent = verticalExtent(item);
      const height = position.y - waveHeight(position.x, position.z, time);
      // A partially lifted hull can settle gently without its keel ever
      // clearing the water. Give that displacement a small outgoing ripple.
      if (height > extent) item.awaitsImpact = true;
      else if (!item.awaitsImpact && height > extent * 0.32 && vy <= 0.2 && time - item.lastImpact > 0.6) {
        splashDown(item, Math.max(0.43, -vy));
      }
    },
  });

  if (filmMode) {
    const targets = new Map([
      ['near-barrel', risingFloats[0]], ['can', risingFloats[4]], ['far-barrel', risingFloats[1]],
    ]);
    const boardPoint = new THREE.Vector3();
    const targetNames = [...targets.keys()];
    window.surfaceFilm = {
      getState(targetName) {
        const items = targetName ? [[targetName, targets.get(targetName)]] : targets;
        const bounds = canvas.getBoundingClientRect();
        const ready = surfaceOpen && canRender;
        const interactable = ready && !dive?.active && viewport.dataset.scene !== 'shallow';
        let board = null;
        if (interactable && titleFlight.carrying) {
          titleFlight.getBoardPosition(boardPoint).project(camera);
          board = {
            x: bounds.left + (boardPoint.x + 1) * bounds.width / 2,
            y: bounds.top + (1 - boardPoint.y) * bounds.height / 2,
            progress: titleFlight.progressAt(time),
          };
        }
        return {
          time, ready, interactable, phase: dayPhase, night: environment.uniforms.uNightMix.value,
          scene: viewport.dataset.scene ?? 'surface', crossing: viewport.dataset.crossing ?? null,
          held: targetNames.find(name => targets.get(name) === grab.heldItem) ?? null,
          board,
          targets: Object.fromEntries([...items].filter(([, item]) => item).map(([name, item]) => [name, {
            point: interactable && !grab.heldItem ? grab.pickPoint(item) : null,
            height: item.object.position.y - waveHeight(item.object.position.x, item.object.position.z, time),
            lastImpact: Number.isFinite(item.lastImpact) ? item.lastImpact : null,
          }])),
        };
      },
    };
  }

  function resizeCanvas(width, height) {
    const nativeRatio = Math.min(devicePixelRatio, 2, Math.sqrt(3840 * 2160 / (width * height)));
    renderFloor = Math.min(1, Math.sqrt(minimumPixels / (width * height)) / nativeRatio);
    if (renderScale === null) {
      renderScale = Math.min(1, Math.sqrt(startupPixels / (width * height)) / nativeRatio);
    }
    const ratio = detailQuality ? nativeRatio : nativeRatio * renderScale;
    renderer.setDrawingBufferSize(width, height, ratio);
    spray.resize(height * ratio, camera.fov);
    impacts.resize(height * ratio, camera.fov);
  }

  function resizeAccessoryViews(width, height) {
    // Only the viewport and the selected quality affect these allocations.
    const accessoryRatio = (detailQuality ? 1 : Math.min(1, Math.sqrt(startupPixels / (width * height))))
      * (softwareRenderer ? .58 : 1);
    const reflectionScale = Math.min(0.52, 920 / width, 540 / height) * accessoryRatio;
    reflectionTarget.setSize(Math.max(2, Math.round(width * reflectionScale)), Math.max(2, Math.round(height * reflectionScale)));
    underwater.resize(width, height, accessoryRatio);
    if (!detailRenderer) return;
    detailWidth = Math.min(width, Math.ceil(height * .30));
    detailHeight = Math.min(height, Math.ceil(height * .32));
    const detailRatio = Math.min(devicePixelRatio, 2);
    detailRenderer.setDrawingBufferSize(detailWidth, detailHeight, detailRatio);
    detailCanvas.style.width = `${detailWidth}px`;
    detailCanvas.style.height = `${detailHeight}px`;
  }

  function adaptResolution(elapsed) {
    frameTimeTotal += Math.min(elapsed, 0.12);
    frameTimeSamples++;
    if (frameTimeTotal < 0.35 || frameTimeSamples < 5) return;
    const mean = frameTimeTotal / frameTimeSamples;
    fastSeconds = mean < 0.0176 ? fastSeconds + frameTimeTotal : 0;
    let next = renderScale;
    const previousPressure = renderPressure;
    if (mean > 0.0215) {
      renderPressure = true;
      next = Math.max(Math.min(renderFloor, renderScale), renderScale * THREE.MathUtils.clamp(Math.sqrt(0.017 / mean), 0.68, 0.93));
    } else if (fastSeconds > 6) {
      next = Math.min(1, renderScale + 0.06);
      renderPressure = softwareRenderer;
      fastSeconds = 0;
    }
    if (Math.abs(next - renderScale) > 0.001 || renderPressure !== previousPressure) {
      renderScale = next;
      ocean.setFastOptics(renderPressure);
      resizeCanvas(layoutWidth, layoutHeight);
    }
    frameTimeTotal = 0;
    frameTimeSamples = 0;
  }

  function layout() {
    const width = viewport.clientWidth;
    const height = viewport.clientHeight;
    if (!width || !height) return;
    const changed = width !== layoutWidth || height !== layoutHeight;
    if (changed) grab.cancel();
    layoutWidth = width;
    layoutHeight = height;
    const aspect = width / height;
    const portrait = THREE.MathUtils.clamp((1.45 - aspect) / 0.85, 0, 1);
    const focal = Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5));
    camera.aspect = aspect;
    camera.updateProjectionMatrix();
    if (changed) {
      updateCamera();
      resizeCanvas(width, height);
      resizeAccessoryViews(width, height);
    }

    const islandDistance = 6 - island.position.z;
    const frameWidth = 2 * islandDistance * focal * aspect;
    const islandWidth = Math.min(25.1, frameWidth * THREE.MathUtils.lerp(0.285, 0.57, portrait));
    const islandHeight = islandWidth / islandView.aspect;
    island.scale.set(islandWidth, islandHeight, 1);
    island.position.x = (THREE.MathUtils.lerp(0.705, 0.62, portrait) * 2 - 1) * islandDistance * focal * aspect;
    island.position.y = islandHeight * 0.5 - 0.11;
    environment.setIslandBearing(island.position.x, islandDistance);

    if (!changed) return;
    for (const item of [...risingFloats, ...floats]) {
      item.layoutDepth = THREE.MathUtils.lerp(item.distance, item.portraitDistance ?? item.distance * 1.32, portrait);
      const distance = THREE.MathUtils.clamp(item.layoutDepth * (item.placedDepthRatio ?? 1), 3.25, 42);
      const portraitAnchor = item.portraitAnchor ?? 0.5 + (item.anchor - 0.5) * 0.86;
      const margin = Math.min(0.43, item.radius * 0.95 / (2 * distance * focal * aspect));
      const anchor = item.placedAnchor == null ? THREE.MathUtils.lerp(item.anchor, portraitAnchor, portrait)
        : THREE.MathUtils.clamp(item.placedAnchor, margin, 1 - margin);
      item.x = (anchor * 2 - 1) * distance * focal * aspect;
      item.z = 6 - distance;
      item.velocityY = 0;
      item.awaitsImpact = false;
      item.drift.set(0, 0);
      item.momentum.set(0, 0);
      const position = item.object.position;
      if (item === frontBarrel && risingFloats.includes(item)) {
        // Leave room for a trough before the barrel surfaces, so framing
        // doesn't push it backwards as soon as regular buoyancy takes over.
        position.set(item.x, item.floatOffset - 0.27, item.z);
        item.drift.y = -frontBarrelRetreat(position);
      }
      const z = item.z + item.drift.y;
      position.set(item.x, waveHeight(item.x, z, time) + item.floatOffset, z);
    }
  }

  function updateCamera() {
    const sway = motion.matches ? 0 : Math.sin(time * 0.26);
    const descent = dive?.descent ?? 0;
    const x = sway * 0.033 + impactX * 0.17 * descent;
    const z = 6 - 2.15 * descent;
    const lowPoint = Math.max(0.26, waveHeight(x, z, time) + 0.25);
    camera.position.set(x, THREE.MathUtils.lerp(1.22 + sway * 0.023, lowPoint, descent), z);
    // Keep the surface shader above the waves until the wash hides the cut.
    aim.set(sway * 0.25 + impactX * 1.48 * descent, 3.37 - 7.5 * descent, -24);
    camera.lookAt(aim);
    camera.updateMatrixWorld();
    viewBounds.setFromProjectionMatrix(viewProjection.multiplyMatrices(
      camera.projectionMatrix, camera.matrixWorldInverse));
  }

  function frontBarrelRetreat(position) {
    let retreat = 0;
    for (let edge = 0; edge < 4; edge++) {
      const plane = viewBounds.planes[edge];
      retreat = Math.max(retreat, (barrelFrameRadius - plane.distanceToPoint(position)) / -plane.normal.z);
    }
    return retreat;
  }

  function keepFrontBarrelInView() {
    if (risingFloats.includes(frontBarrel)) return;
    const position = frontBarrel.object.position;
    // Move away from the camera rather than lifting out of the water.
    const retreat = frontBarrelRetreat(position);
    if (retreat <= 0) return;
    position.z -= retreat;
    frontBarrel.drift.y -= retreat;
    frontBarrel.momentum.y = Math.min(0, frontBarrel.momentum.y);
  }

  function addRipple(ripple) {
    ripples.push(ripple);
    if (ripples.length > 8) ripples.shift();
  }

  function verticalExtent(item) {
    if (!item.halfExtents) {
      return Math.abs(floatAxis.y) * item.length * 0.5 + item.radius * Math.hypot(floatAxis.x, floatAxis.z);
    }
    localUp.copy(up).applyQuaternion(inverseAttitude.copy(item.object.quaternion).invert());
    const { x, y, z } = item.halfExtents;
    return x * Math.abs(localUp.x) + y * Math.abs(localUp.y) + z * Math.abs(localUp.z);
  }

  function floatPlaque(object, halfExtents, yaw, floatOffset, landingTime) {
    const depth = camera.position.z - object.position.z;
    const frameWidth = 2 * depth * Math.tan(camera.fov * Math.PI / 360) * camera.aspect;
    const item = makeFloat({
      object, yaw, floatOffset, halfExtents, collisionShape: 'box',
      length: 2 * halfExtents.x, radius: 0.8 * halfExtents.y, response: 0.60,
      restRotation: new THREE.Quaternion().setFromAxisAngle(axisX, -Math.PI / 2),
      distance: depth, portraitDistance: depth, layoutDepth: depth,
      placedDepthRatio: 1, placedAnchor: 0.5 + object.position.x / frameWidth,
    }, floats.length);
    sampleDrift(item);
    item.x = object.position.x - current.x;
    item.z = object.position.z - current.y;
    item.lastImpact = landingTime;
    item.splash.halfWidth = halfExtents.y;
    for (const ripple of ripples) {
      if (ripple.time === landingTime) ripple.reached?.add(item);
    }
    floats.push(item);
    contactWakes.push(item.splash);
    grab.addItem(item);
  }

  function splashPlaque({ board, x, z, speed, axisX, axisZ, scale, time: impactTime }) {
    const strength = THREE.MathUtils.clamp(speed * 0.065, 0.22, 0.58);
    const radius = 0.28;
    const keel = 0.64 * scale;
    const ripple = { x, z, time: impactTime, strength: strength * 0.62,
      impactRadius: radius, keelX: axisX * keel, keelZ: axisZ * keel,
      speed: 1.30 + 0.65 * strength, reached: new Set() };
    addRipple(ripple);
    impacts.emit({ x, z, time: impactTime, axisX, axisZ, radius,
      length: 2 * (radius + keel), strength, ripple });
    sound.impact(strength * 0.78, x - camera.position.x, camera.position.z - z);

    if (!dive?.begin()) return false;
    const submerged = cloneSubmerged(board, submergedMaterials);
    shadeWetSurfaces(submerged, waterClock, preparedMaterials, true);
    underwater.scene.add(submerged);
    sinkingPlaque = { board, submerged };
    impactX = board.position.x;
    grab.cancel();
    finishScrub();
    canvas.inert = timeSlider.inert = soundButton.inert = true;
    return true;
  }

  function splashDown(item, speed) {
    if (time - item.lastImpact < 0.25) return;
    item.lastImpact = time;
    const position = item.object.position;
    const volumeScale = THREE.MathUtils.clamp(Math.sqrt(item.radius / 0.4) * (item.mass / 7) ** 0.13, 0.36, 1);
    const strength = THREE.MathUtils.clamp((speed - 0.16) / 4.65, 0.035, 1) * volumeScale;
    if (item.kind !== 'can') sound.impact(strength, position.x - camera.position.x, camera.position.z - position.z);
    const horizontal = Math.hypot(floatAxis.x, floatAxis.z);
    const axisX = horizontal > 0.0001 ? floatAxis.x / horizontal : 1;
    const axisZ = horizontal > 0.0001 ? floatAxis.z / horizontal : 0;
    // A tilted barrel lands on one end first, whereas its broad side pushes a
    // longer front. Give the spray, water mesh and buoyancy the same footprint.
    const excessLength = Math.max(0, item.length * 0.5 - item.radius);
    const endOffset = THREE.MathUtils.clamp(floatAxis.y * 2.8, -1, 1) * excessLength;
    const x = position.x - floatAxis.x * endOffset;
    const z = position.z - floatAxis.z * endOffset;
    const keel = horizontal * excessLength * (1 - Math.abs(floatAxis.y) * 0.72);
    // Fast entries can throw water high above the lip without sending a large
    // swell across the whole bay. A gentle set-down keeps its small local ring.
    const waveStrength = strength * (1 - 0.5 * THREE.MathUtils.smoothstep(strength, 0.12, 0.65));
    const ripple = { x, z, time, strength: waveStrength, impactRadius: item.radius,
      keelX: axisX * keel, keelZ: axisZ * keel,
      speed: 1.15 + 0.95 * Math.sqrt(strength), reached: new Set([item]) };
    impacts.emit({ x, z, time, axisX, axisZ, radius: item.radius,
      length: 2 * (item.radius + keel), strength, ripple });
    addRipple(ripple);
    item.rollVelocity += strength * (floatAxis.y < 0 ? 1 : -1) * 1.65;
  }

  function receiveWaves(item) {
    for (const ripple of ripples) {
      if (!ripple.reached) continue;
      const { x, z } = item.object.position;
      localImpact.add(sampleImpactRipple(ripple, x, z, time, packet));
      if (ripple.reached.has(item) || time < impactRippleArrivalTime(ripple, x, z)) continue;
      const dx = item.object.position.x - ripple.x, dz = item.object.position.z - ripple.z;
      const distance = Math.hypot(dx, dz);
      ripple.reached.add(item);
      const kick = ripple.strength * Math.exp(-distance * 0.51) * item.response;
      const turn = dx < 0 ? -1 : 1;
      if (item.kind === 'can') item.spin += kick * 7.1 * turn;
      else item.rollVelocity += kick * 4.3 * turn;
      if (distance > 0.01) {
        item.momentum.x += kick * dx / distance * 0.69;
        item.momentum.y += kick * dz / distance * 0.69;
      }
    }
  }

  function floatingAttitude(item) {
    const heavy = item.kind !== 'can';
    const slowDrift = motion.matches ? 0.35 : 1;
    tilt.setFromUnitVectors(up, normal);
    heading.setFromAxisAngle(up, item.yaw + Math.sin(time * 0.31 + item.phase) * 0.12);
    const rollResponse = heavy ? 0.066 : 0.27;
    roll.setFromAxisAngle(axisX, Math.sin(time * (heavy ? 0.84 : 1.65) + item.phase)
      * rollResponse * slowDrift + item.rollKick + item.freeRoll);
    tilt.multiply(heading).multiply(roll);
    if (item.restRotation) tilt.multiply(item.restRotation);
    return tilt;
  }

  function syncFloatSurface(item, surface, extent, clearance) {
    const position = item.object.position;
    item.submerged.visible = clearance < 0.06;
    item.submerged.position.copy(position);
    item.submerged.quaternion.copy(item.object.quaternion);
    const axisLength = Math.hypot(floatAxis.x, floatAxis.z) || 1;
    const immersion = THREE.MathUtils.clamp(-clearance / (extent * 0.62), 0, 1);
    const depthFade = 1 - THREE.MathUtils.smoothstep(surface - position.y, extent * 0.9, extent * 1.4);
    item.splash.x = position.x;
    item.splash.z = position.z;
    item.splash.axisX = floatAxis.x / axisLength;
    item.splash.axisZ = floatAxis.z / axisLength;
    item.splash.immersion = immersion * depthFade;
    item.splash.strength = (item.kind === 'plaque' ? 0.53 : 1) * item.splash.immersion * (0.34
      + Math.min(0.48, Math.abs(item.velocityY) * 1.2 + item.momentum.length() * 0.9));
  }

  function updateRisingFloats() {
    if (openingTime === null) return;
    for (let index = risingFloats.length - 1; index >= 0; index--) {
      const item = risingFloats[index];
      const age = time - openingTime - item.riseAt;
      if (age < 0) continue;
      const progress = Math.min(age / floatRiseDuration, 1);
      // Start below the reef, slow as the hull breaches, then bob gently into its draft.
      const startingDepth = 2.15 + 3.6 * THREE.MathUtils.smoothstep(item.layoutDepth, 7, 24);
      const riseDepth = startingDepth * (1 - progress) ** 3;
      const bob = Math.sin(Math.PI * THREE.MathUtils.smoothstep(progress, 0.45, 1));
      const position = item.object.position;
      sampleDrift(item);
      const x = item.x + current.x;
      const z = item.z + item.drift.y + current.y;
      const surface = waveHeight(x, z, time);
      position.set(x, surface + item.floatOffset - riseDepth + bob * item.radius * 0.36, z);
      waveNormal(x, z, time, normal);
      const noseUp = 0.36 * Math.cos(item.phase) * (1 - progress) ** 2;
      item.object.quaternion.copy(floatingAttitude(item)).multiply(risePitch.setFromAxisAngle(axisZ, noseUp));
      floatAxis.copy(axisX).applyQuaternion(item.object.quaternion);
      const extent = verticalExtent(item);
      item.object.visible = position.y + extent >= surface - 0.22;
      syncFloatSurface(item, surface, extent, position.y - surface - extent);
      if (!item.brokeSurface && position.y + extent >= surface) {
        item.brokeSurface = true;
        contactWakes.push(item.splash);
        addRipple({ x, z, time, strength: item.kind === 'barrel' ? 0.17 : 0.095 });
      }
      if (progress === 1) {
        risingFloats.splice(index, 1);
        floats.push(item);
        grab.addItem(item);
      }
    }
  }

  function updateFloatingObjects(dt) {
    floats.forEach(item => {
      const position = item.object.position;
      const held = grab.follow(item, dt);
      localImpact.set(0, 0, 0);
      floatAxis.copy(axisX).applyQuaternion(item.object.quaternion);
      const extent = verticalExtent(item);
      if (!held) {
        receiveWaves(item);
        const depth = camera.position.z - position.z;
        const side = Math.max(0.1, depth * Math.tan(camera.fov * Math.PI / 360) * camera.aspect - item.length * 0.48);
        item.momentum.x += (THREE.MathUtils.clamp(position.x, -side, side) - position.x) * dt * 8;
        item.momentum.y += (depth - THREE.MathUtils.clamp(depth, 3.25, 42)) * dt * 8;
        item.momentum.multiplyScalar(Math.exp(-dt * 1.75));
        item.drift.addScaledVector(item.momentum, dt);
        sampleDrift(item);
        position.x = item.x + item.drift.x + current.x;
        position.z = item.z + item.drift.y + current.y;
        const surface = waveHeight(position.x, position.z, time) + localImpact.x;
        const floatingY = surface + item.floatOffset;
        const contact = THREE.MathUtils.clamp((surface + extent - position.y) / extent, 0, 1);
        // Above the water this is free fall. Increasing immersion provides both
        // buoyancy and drag, preserving the initial plunge and subsequent rebound.
        const heavy = item.kind !== 'can';
        const stiffness = heavy ? 40 : 80 * item.response;
        const damping = heavy ? 4.4 : 6.1;
        const buoyancy = THREE.MathUtils.clamp((floatingY - position.y) * stiffness, -9.81, 23);
        item.velocityY += (buoyancy - item.velocityY * damping * contact) * dt;
        position.y += item.velocityY * dt;
        item.rollVelocity += (-item.rollKick * 23 - item.rollVelocity * 4.1) * dt;
        item.rollKick += item.rollVelocity * dt;
        waveNormal(position.x, position.z, time, normal);
        normal.set(normal.x / normal.y - localImpact.y, 1, normal.z / normal.y - localImpact.z).normalize();
        // A light cylindrical can can roll through a crest and settle on a new face.
        if (!heavy) {
          const crossSlope = normal.z * floatAxis.x - normal.x * floatAxis.z;
          item.spin = (item.spin + crossSlope * dt * 3.6) * Math.exp(-dt * 1.45);
          item.freeRoll = (item.freeRoll + item.spin * dt) % (Math.PI * 2);
        }
        item.yawVelocity *= Math.exp(-dt * (heavy ? 2.4 : 1.65));
        item.yaw += item.yawVelocity * dt;
        item.object.quaternion.slerp(floatingAttitude(item), 1 - Math.exp(-dt * ((heavy ? 3.0 : 8.8) * contact + 0.24)));
      }
      item.rippleHeight = localImpact.x;
    });

    resolveFloatCollisions(floats, grab.heldItem, dt);
    keepFrontBarrelInView();

    floats.forEach(item => {
      const position = item.object.position;
      floatAxis.copy(axisX).applyQuaternion(item.object.quaternion);
      const extent = verticalExtent(item);
      const surface = waveHeight(position.x, position.z, time) + item.rippleHeight;
      const clearance = position.y - surface - extent;
      if (clearance > 0.025) item.awaitsImpact = true;
      if (item.awaitsImpact && clearance <= 0 && item.velocityY <= 0) {
        item.awaitsImpact = false;
        const surfaceSpeed = (waveHeight(position.x, position.z, time + 0.025)
          - waveHeight(position.x, position.z, time - 0.025)) / 0.05;
        splashDown(item, Math.max(0, surfaceSpeed - item.velocityY));
      }
      if (item.film) {
        filmNormal.copy(item.film.localUp).applyQuaternion(item.object.quaternion);
        item.film.plane.value.set(filmNormal.x, filmNormal.y, filmNormal.z,
          -filmNormal.dot(position) - item.film.level);
        item.film.strength.value *= Math.exp(-dt * 0.12);
      }
      syncFloatSurface(item, surface, extent, clearance);
    });
  }

  function updateLighting() {
    environment.update(dayPhase);
    const { uSunDirection, uSunColor, uSunStrength, uNightMix, uSkyHorizon } = environment.uniforms;
    const night = uNightMix.value;
    sound.setNight(night);
    sun.position.copy(uSunDirection.value).multiplyScalar(25);
    sun.color.copy(uSunColor.value);
    sun.intensity = uSunStrength.value * 2.25;
    fill.color.copy(uSkyHorizon.value).lerp(white, 0.42 * (1 - night));
    fill.intensity = 1.18 - night * 0.70;
    bouncedLight.intensity = 1.64 * uSunStrength.value * (1 - night);
    scene.environmentIntensity = 0.79 - night * 0.67;
    underwater.scene.environmentIntensity = 0.53 - night * 0.46;
    islandView.updateLighting(time);
  }
  const white = new THREE.Color(0xffffff);

  function renderReflection() {
    camera.getWorldDirection(forward);
    reflectedCamera.position.copy(camera.position);
    reflectedCamera.position.y *= -1;
    reflectedCamera.up.set(0, -1, 0);
    aim.copy(forward);
    aim.y *= -1;
    reflectedCamera.lookAt(aim.add(reflectedCamera.position));
    reflectedCamera.near = camera.near;
    reflectedCamera.far = camera.far;
    reflectedCamera.fov = camera.fov + 9;
    reflectedCamera.aspect = camera.aspect;
    reflectedCamera.updateProjectionMatrix();
    reflectedCamera.updateMatrixWorld();
    reflectionMatrix.copy(toTexture).multiply(reflectedCamera.projectionMatrix).multiply(reflectedCamera.matrixWorldInverse);

    const impactVisible = impacts.object.visible;
    const shoreVisible = shoreline.mesh.visible;
    ocean.mesh.visible = false;
    spray.points.visible = false;
    impacts.object.visible = false;
    shoreline.mesh.visible = false;
    renderer.clippingPlanes = waterlineClip;
    renderer.setRenderTarget(reflectionTarget);
    renderer.render(scene, reflectedCamera);
    renderer.setRenderTarget(null);
    renderer.clippingPlanes = noClipping;
    ocean.mesh.visible = true;
    spray.points.visible = true;
    impacts.object.visible = impactVisible;
    shoreline.mesh.visible = shoreVisible;
  }

  function paintFlightDetails(visible, prewarm = false) {
    if (!detailRenderer || !detailHeight) return;
    detailCanvas.hidden = !visible;
    if (!visible && !prewarm) return;
    detailAnchor.copy(titleFlight.position).project(camera);
    const x = Math.round(THREE.MathUtils.clamp(
      (detailAnchor.x + 1) * layoutWidth * .5 - detailWidth * .5, 0, layoutWidth - detailWidth));
    const y = Math.round(THREE.MathUtils.clamp(
      (1 - detailAnchor.y) * layoutHeight * .5 - detailHeight * .5, 0, layoutHeight - detailHeight));
    detailCanvas.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    detailCamera.copy(camera, false);
    detailCamera.layers.set(detailLayer);
    detailCamera.setViewOffset(layoutWidth, layoutHeight, x, y, detailWidth, detailHeight);
    detailRenderer.render(scene, detailCamera);
  }

  function withOpeningFloats(draw) {
    const culledMeshes = [];
    for (const item of risingFloats) {
      item.submerged.position.copy(item.object.position);
      item.submerged.quaternion.copy(item.object.quaternion);
      for (const root of [item.object, item.submerged]) {
        root.visible = true;
        root.traverse(object => {
          if (!object.isMesh || !object.frustumCulled) return;
          culledMeshes.push(object);
          object.frustumCulled = false;
        });
      }
    }
    try {
      draw();
    } finally {
      for (const item of risingFloats) item.object.visible = item.submerged.visible = false;
      for (const mesh of culledMeshes) mesh.frustumCulled = true;
    }
  }

  function touchWater(raycaster) {
    const { origin, direction } = raycaster.ray;
    if (direction.y >= -0.012) return;
    raycaster.ray.at(-origin.y / direction.y, rayPoint);
    const distance = (waveHeight(rayPoint.x, rayPoint.z, time) - origin.y) / direction.y;
    if (distance <= 0 || distance > 140) return;
    raycaster.ray.at(distance, rayPoint);
    addRipple({ x: rayPoint.x, z: rayPoint.z, time, strength: 0.88 });
    for (const item of floats) {
      const dx = item.object.position.x - rayPoint.x;
      const dz = item.object.position.z - rayPoint.z;
      const space = Math.hypot(dx, dz);
      const impulse = Math.max(0, 1 - space / 2.1) * 0.64;
      if (space > 0.001 && impulse > 0) {
        item.momentum.x += dx * impulse / space;
        item.momentum.y += dz * impulse / space;
        item.velocityY += impulse * 0.28;
        if (item.kind !== 'barrel') item.spin += impulse * (dx < 0 ? -3.2 : 3.2);
      }
    }
  }

  islandView.load(layout);

  canvas.addEventListener('webglcontextlost', () => {
    grab.cancel();
    canRender = false;
    viewport.dataset.renderer = 'unavailable';
    revealOpening();
  });
  canvas.addEventListener('webglcontextrestored', () => {
    frame = 0;
    lastShadowUpdate = -Infinity;
    underwater.uniforms.uTransmissionEnabled.value = 0;
    canRender = true;
    viewport.dataset.renderer = 'webgl';
    layout();
  });
  new ResizeObserver(layout).observe(viewport);
  layout();
  updateCamera();
  viewport.dataset.renderer = 'webgl';
  let previous = performance.now();
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) finishScrub();
    previous = performance.now();
    frameTimeTotal = frameTimeSamples = fastSeconds = 0;
  });

  function beginOpening() {
    surfaceOpen = true;
    viewport.inert = false;
    previous = performance.now();
    renderer.setAnimationLoop(renderFrame);
  }

  function waitForOpeningDraw(context) {
    const fence = context.fenceSync(context.SYNC_GPU_COMMANDS_COMPLETE, 0);
    if (!fence) return Promise.resolve(false);
    context.flush();
    const deadline = performance.now() + 8000;
    return new Promise(resolve => {
      function check() {
        const status = context.clientWaitSync(fence, 0, 0);
        if (status !== context.TIMEOUT_EXPIRED || performance.now() >= deadline) {
          context.deleteSync(fence);
          resolve(status === context.ALREADY_SIGNALED || status === context.CONDITION_SATISFIED);
        } else setTimeout(check, 16);
      }
      check();
    });
  }

  async function revealOpening(drawn = false) {
    if (openingRequested) return;
    openingRequested = true;
    renderer.setAnimationLoop(null);
    const openingWidth = layoutWidth;
    const openingHeight = layoutHeight;
    let openingReady = false;
    try {
      const draws = drawn ? [waitForOpeningDraw(gl)] : [];
      if (drawn && detailRenderer) draws.push(waitForOpeningDraw(detailRenderer.getContext()));
      const presented = await Promise.all(draws);
      let seaReady = drawn && texturesSettled && !textureLoadFailed && presented.every(Boolean);
      if (seaReady && canRender) performance.mark('bikini-sea-ready');
      let transitionReady = true;
      if (dive) {
        // On slower connections only fetch the model data initially. Build
        // its WebGL scene once the first dive covers the surface.
        const modelsReady = !shallowModels || (filmMode ? await shallowModels : await Promise.race([
          shallowModels, new Promise(resolve => setTimeout(resolve, 1800, false)),
        ]));
        const shallowsReady = modelsReady && await dive.warmOpening(filmMode ? 60000 : 12000);
        const [videoReady, audioReady] = filmMode ? await mediaReady : [true, true];
        transitionReady = shallowsReady && videoReady && (audioReady || !sound.available);
      }
      if (canRender && (openingWidth !== layoutWidth || openingHeight !== layoutHeight)) {
        renderFrame(performance.now(), true);
        seaReady = seaReady && await waitForOpeningDraw(gl);
      }
      openingReady = seaReady && canRender && (!filmMode || transitionReady);
      performance.mark(openingReady ? 'bikini-opening-ready' : 'bikini-opening-degraded');
    } catch (error) {
      performance.mark('bikini-opening-degraded');
      console.warn('开场预加载失败', error);
    }
    if (studioIntro && !openingReady) {
      void sound.setEnabled(false);
      studioIntro.showRetry();
      return;
    }
    if (studioIntro) {
      if (filmMode) {
        // Keep at least two complete rounds of the actual loading animation.
        const introRemaining = startupTime + 2400 - performance.now();
        if (introRemaining > 0) await new Promise(resolve => setTimeout(resolve, introRemaining));
      }
      await studioIntro.finish();
    } else document.getElementById('studio-intro')?.remove();
    beginOpening();
  }

  function resumeSurface(onPresented) {
    sinkingPlaque?.submerged.removeFromParent();
    sinkingPlaque = undefined;
    titleFlight.reset(time);
    if (filmMode && viewport.dataset.crossing === 'up') {
      dayPhase = 0.80;
      syncTimeSlider();
    }
    impactX = 0;
    previous = performance.now();
    frameTimeTotal = frameTimeSamples = fastSeconds = 0;
    surfacePresented = canRender ? () => {
      renderer.setAnimationLoop(null);
      void waitForOpeningDraw(gl).then(onPresented);
    } : null;
    renderer.setAnimationLoop(renderFrame);
    if (!canRender) onPresented();
  }

  function renderFrame(now, openingRedraw = false) {
    const elapsed = (now - previous) * 0.001;
    previous = now;
    if (!canRender || document.hidden || elapsed <= 0) return;
    const texturesReady = texturesSettled || now >= assetDeadline;
    if (!surfaceOpen && !openingRedraw && (openingRequested || !texturesReady)) return;
    if (!filmMode && !detailQuality && surfaceOpen && frame > 5 && elapsed < 1) adaptResolution(elapsed);
    if (surfaceOpen && island.visible && frame > 0 && !motion.matches && scrubPointer === null && !scrubKey) {
      dayPhase = (dayPhase + Math.min(elapsed, 0.25) / dayLength) % 1;
      syncTimeSlider();
    }
    while (ripples.length && time - ripples[0].time >= 5) ripples.shift();
    updateLighting();
    if (surfaceOpen) {
      if (openingTime === null && (island.visible || texturesReady)) {
        openingTime = time;
        performance.mark('bikini-opening-surface-motion');
      }
      // Substeps keep release and water entry consistent across render rates.
      const physicsDt = Math.min(elapsed, 0.12);
      const steps = Math.ceil(physicsDt / (1 / 60));
      const substep = physicsDt / steps;
      for (let step = 0; step < steps; step++) {
        time += substep * (motion.matches ? 0.45 : 1);
        if (risingFloats.length) updateRisingFloats();
        updateFloatingObjects(substep);
      }
    }
    updateCamera();
    const carriedBefore = titleFlight.carrying;
    titleFlight.update(time, openingTime !== null);
    if (!carriedBefore && titleFlight.carrying) sound.gullEntrance();
    if (sinkingPlaque) {
      const { board, submerged } = sinkingPlaque;
      submerged.position.copy(board.position);
      submerged.quaternion.copy(board.quaternion);
    }
    if (titleFlight.carrying && canvas.tabIndex !== 0) canvas.tabIndex = 0;
    if (!titleFlight.carrying && canvas.tabIndex === 0) canvas.tabIndex = -1;
    waterClock.value = time;
    underwater.update(time);
    spray.update(time);
    impacts.update(time);
    shoreline.update(time);
    ocean.update(time, contactWakes, ripples);
    if (!surfaceOpen && !openingRedraw && floatWarmPass < 3) {
      // Submit the barrel and can shaders to the same three targets that will
      // draw them live. Separate frames give the loader time to animate.
      withOpeningFloats(() => {
        if (floatWarmPass === 0) {
          renderer.shadowMap.needsUpdate = true;
          renderReflection();
        } else if (floatWarmPass === 1) underwater.render(camera);
        else spray.warmupPose(() => renderer.render(scene, camera));
      });
      if (++floatWarmPass === 3) performance.mark('bikini-opening-floats-ready');
      return;
    }
    // Warm both buffers together once. Then spread the two secondary views
    // across frames while the waves, normals and optical lookup animate every frame.
    const refreshBoth = !surfaceOpen || surfacePresented || underwater.uniforms.uTransmissionEnabled.value === 0;
    const accessoryInterval = softwareRenderer ? 8 : renderPressure ? 4 : 2;
    const updateOptics = !dive?.active;
    if (refreshBoth || (updateOptics && frame % accessoryInterval === 0)) {
      if (refreshBoth || now - lastShadowUpdate >= (renderPressure ? 165 : 64)) {
        renderer.shadowMap.needsUpdate = true;
        lastShadowUpdate = now;
      }
      renderReflection();
    }
    if (refreshBoth || (updateOptics && frame % accessoryInterval === accessoryInterval / 2)) underwater.render(camera);
    renderer.render(scene, camera);
    paintFlightDetails(titleFlight.flying);
    frame++;
    if (!surfaceOpen) {
      if (openingRedraw) return;
      if (!softwareRenderer) {
        ocean.setFastOptics(true);
        renderer.compile(ocean.mesh, camera, scene);
        ocean.setFastOptics(false);
      }
      // Compile the main and reflected variants with the same target and clip
      // settings used during flight. Exercise the sharp foreground renderer.
      titleFlight.warmupMaterials(renderer);
      renderer.setRenderTarget(reflectionTarget);
      renderer.clippingPlanes = waterlineClip;
      titleFlight.warmupMaterials(renderer, reflectedCamera);
      renderer.setRenderTarget(null);
      renderer.clippingPlanes = noClipping;
      if (detailRenderer) titleFlight.warmupPose(() => paintFlightDetails(false, true));
      void revealOpening(true);
    }
    if (surfacePresented) {
      surfacePresented();
      surfacePresented = null;
    }
  }
  renderer.setAnimationLoop(now => {
    try {
      renderFrame(now);
    } catch (error) {
      canRender = false;
      viewport.dataset.renderer = 'unavailable';
      void revealOpening();
      console.error('海面首帧绘制失败', error);
    }
  });
}
