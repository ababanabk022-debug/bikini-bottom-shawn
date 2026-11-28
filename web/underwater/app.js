import { bindFullscreen } from './fullscreen.js';

(() => {
  'use strict';

  const canvas = document.getElementById('world');
  const status = document.getElementById('status');
  const hud = document.querySelector('.hud');
  const origin = window.location.origin;
  const entry = new URLSearchParams(window.location.search);
  const boot = entry.get('boot');
  const recording = entry.get('capture') === '1';
  const surfaceHost = origin !== 'null' && window.parent !== window
    && entry.get('from') === 'surface' ? window.parent : null;
  const returnDepth = 50;
  if (surfaceHost) {
    hud.style.visibility = 'hidden';
    hud.inert = true;
  }
  const depth = document.getElementById('depth');
  const depthFill = document.getElementById('depth-fill');
  const heading = document.getElementById('heading');
  const cruise = document.getElementById('cruise');
  const reset = document.getElementById('reset');
  const fullscreen = document.getElementById('fullscreen');
  const waypoints = Array.from(document.querySelectorAll('[data-view]'));
  const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const directions = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  const help = document.querySelector('.help');
  const viewSettings = document.getElementById('view-settings');
  const districtMenu = document.querySelector('.district-menu');
  const viewInputs = {
    horizontal: document.getElementById('view-horizontal'),
    vertical: document.getElementById('view-vertical')
  };
  const viewOutputs = {
    horizontal: document.getElementById('view-horizontal-value'),
    vertical: document.getElementById('view-vertical-value')
  };
  const viewPreference = 'underwater-standalone-view-angles';
  const viewOverrides = { horizontal: null, vertical: null };
  const fieldOfView = { horizontal: 98, vertical: 80 };
  let previousDepth = '';
  let previousHeading = '';

  function syncViewAngles() {
    const aspect = canvas.clientWidth / Math.max(1, canvas.clientHeight);
    const portrait = aspect < 1;
    const vertical = portrait ? 76 : 58;
    const defaults = {
      horizontal: Math.round(2 * Math.atan(aspect * Math.tan(vertical * Math.PI / 360)) * 180 / Math.PI),
      vertical
    };
    for (const [axis, input] of Object.entries(viewInputs)) {
      const angle = viewOverrides[axis] ?? defaults[axis];
      const degrees = Math.max(Number(input.min), Math.min(Number(input.max), angle));
      fieldOfView[axis] = degrees;
      input.value = degrees;
      input.setAttribute('aria-valuetext', `${degrees} 度`);
      viewOutputs[axis].value = `${degrees}°`;
    }
  }

  function saveViewAngles() {
    try {
      localStorage.setItem(viewPreference, JSON.stringify(viewOverrides));
    } catch {
      // The sliders still work when browser storage is unavailable.
    }
  }

  try {
    const saved = JSON.parse(localStorage.getItem(viewPreference));
    for (const axis of Object.keys(viewInputs)) {
      if (Number.isFinite(saved?.[axis])) viewOverrides[axis] = Math.round(saved[axis]);
    }
  } catch {
    // Use viewport defaults if browser storage is unavailable or invalid.
  }
  syncViewAngles();
  window.addEventListener('resize', syncViewAngles);
  for (const [axis, input] of Object.entries(viewInputs)) {
    input.addEventListener('input', () => {
      viewOverrides[axis] = input.valueAsNumber;
      syncViewAngles();
    });
    input.addEventListener('change', saveViewAngles);
  }
  document.getElementById('view-reset').addEventListener('click', () => {
    viewOverrides.horizontal = null;
    viewOverrides.vertical = null;
    syncViewAngles();
    saveViewAngles();
  });

  function showStatus(message) {
    status.textContent = message;
    status.hidden = !message;
  }

  function notifySurface(type, details) {
    surfaceHost?.postMessage({ type, boot, ...details }, origin);
  }

  function showStartupError(error, message = '无法启动海底场景。请使用支持 WebGL 2 的浏览器，并开启图形加速。') {
    console.error(error);
    showStatus(message);
    hud.hidden = true;
    notifySurface('bikini-dive-error');
  }

  function selectWaypoint(view) {
    for (const button of waypoints) {
      button.setAttribute('aria-pressed', String(button.dataset.view === view));
    }
  }

  function updateInstruments(camera, surfaceY) {
    const meters = surfaceY - camera.y;
    const reading = `${meters.toFixed(1).padStart(4, '0')} m`;
    if (reading !== previousDepth) {
      previousDepth = reading;
      depth.textContent = reading;
      depthFill.style.height = `${Math.min(100, meters / (surfaceY + 8) * 100)}%`;
    }
    const degrees = ((Math.round(camera.yaw * 180 / Math.PI) % 360) + 360) % 360;
    const bearing = `${directions[Math.round(degrees / 45) % 8]} · ${String(degrees).padStart(3, '0')}°`;
    if (bearing !== previousHeading) {
      previousHeading = bearing;
      heading.textContent = bearing;
    }
  }

  let world;
  const roadProfiles=Array.from(document.querySelectorAll('input[name="road"]'));
  const qualityProfiles=Array.from(document.querySelectorAll('input[name="quality"]'));
  const qualityPreference='underwater-standalone-quality';
  try {
    const saved=qualityProfiles.find(input=>input.value===localStorage.getItem(qualityPreference));
    if (saved) saved.checked=true;
  } catch {
    // File URLs can restrict storage. The setting still applies for this visit.
  }
  function syncRoadProfile() {
    world.setRoadProfile(roadProfiles.find(input=>input.checked).value);
  }
  function syncQuality() {
    world.setRenderQuality(recording ? 'capture' : qualityProfiles.find(input=>input.checked).value);
  }
  try {
    performance.mark('bikini-dive-build-start');
    world = window.createDiveWorld(canvas);
    performance.mark('bikini-dive-world-ready');
    syncRoadProfile();
    syncQuality();
  } catch (error) {
    showStartupError(error);
    return;
  }
  for(const input of roadProfiles) input.addEventListener('change',syncRoadProfile);
  for(const input of qualityProfiles) input.addEventListener('change',()=>{
    syncQuality();
    try {
      localStorage.setItem(qualityPreference,input.value);
    } catch {
      // Keep the current setting when storage is unavailable.
    }
  });

  const controls = window.createDiveControls(canvas, {
    horizontalFov: () => fieldOfView.horizontal,
    floor: (x,z) => world.floor(x,z),
    collision: () => world.collision,
    surfaceY: world.surfaceY,
    onCruise(active) {
      cruise.setAttribute('aria-pressed', String(active));
      cruise.querySelector('span').textContent = active ? '结束巡游' : '海湾巡游';
      if (active) selectWaypoint(null);
    },
    onBlocked() {
      const message = '当前无法安全前往该视角，请先游到开阔处。';
      showStatus(message);
      setTimeout(() => { if (status.textContent === message) showStatus(''); }, 2800);
    },
    onManual: () => selectWaypoint(null)
  });

  const openingCamera = { ...controls.camera };

  for (const button of waypoints) {
    button.addEventListener('click', () => {
      if (controls.goto(button.dataset.view)) selectWaypoint(button.dataset.view);
      if(districtMenu.open){districtMenu.open=false;canvas.focus({preventScroll:true});}
    });
  }
  cruise.addEventListener('click', () => controls.setCruise(!controls.getCruise()));
  reset.addEventListener('click', () => {
    if (controls.reset()) selectWaypoint('shallows');
  });

  const releaseTouchInputs = [];
  for (const button of document.querySelectorAll('[data-input]')) {
    let pointer = null;
    const action = button.dataset.input;
    const clear = () => {
      pointer = null;
      controls.setInput(action, false);
      button.classList.remove('is-held');
    };
    const release = event => {
      if (event.pointerId === pointer) clear();
    };
    button.addEventListener('pointerdown', (event) => {
      if (pointer !== null || event.button !== 0) return;
      event.preventDefault();
      pointer = event.pointerId;
      button.setPointerCapture(pointer);
      controls.setInput(action, true);
      button.classList.add('is-held');
    });
    button.addEventListener('pointerup', release);
    button.addEventListener('pointercancel', release);
    button.addEventListener('lostpointercapture', release);
    window.addEventListener('blur', clear);
    releaseTouchInputs.push(clear);
  }

  bindFullscreen(fullscreen, surfaceHost?.document ?? document);
  help.addEventListener('toggle', () => { if (help.open) viewSettings.open = false; });
  viewSettings.addEventListener('toggle', () => { if (viewSettings.open) help.open = false; });
  canvas.addEventListener('pointerdown', () => {
    districtMenu.open = false;
    help.open = false;
    viewSettings.open = false;
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (districtMenu.open && districtMenu.contains(document.activeElement)) districtMenu.querySelector('summary').focus();
    districtMenu.open = false;
    if (viewSettings.open && viewSettings.contains(document.activeElement)) {
      viewSettings.querySelector('summary').focus();
    }
    help.open = false;
    viewSettings.open = false;
  });

  let frameId;
  let cancelPresentation;
  let restoringContext = false;
  let restoreOnEntry = false;
  let openingStill;
  let previousTime;
  let sceneTime = 0;
  let recordingStart;
  let recordingSceneBase;
  let recordingTime = 0;
  let recordingCamera;
  let reachedRecordingDepth = false;
  let visit = surfaceHost ? (entry.get('enter') === '1' ? 'entering' : 'warming') : 'standalone';
  let readySent = false;
  let plaquePress = null;
  const tapSlop = 7;

  function createRecordingRoute() {
    return window.createRecordingCamera(world.floor, openingCamera, world.surfaceY - returnDepth);
  }

  function startRecording() {
    recordingCamera = createRecordingRoute();
    recordingStart = undefined;
    recordingSceneBase = sceneTime;
    recordingTime = 0;
    reachedRecordingDepth = false;
  }

  if (recording) {
    qualityProfiles.find(input => input.value === 'detail').checked = true;
    window.bikiniDiveCapture = {
      state: () => ({
        visit, elapsed: recordingTime, duration: (recordingCamera ?? createRecordingRoute()).duration,
        camera: { ...controls.camera }, marker: recordingCamera?.markerAt(recordingTime),
        reachedReturnDepth: reachedRecordingDepth
      }),
      sample: time => (recordingCamera ?? createRecordingRoute()).poseAt(time),
      check() {
        const route = recordingCamera ?? createRecordingRoute();
        const blocked = [];
        let previous = route.poseAt(0);
        for (let i = 1; i <= Math.ceil(route.duration * 30); i++) {
          const time = i / 30;
          const camera = route.poseAt(time);
          if (!world.collision.clearLine(previous, camera)) {
            blocked.push({ time: Number(time.toFixed(2)), ...camera });
          }
          previous = camera;
        }
        return blocked;
      }
    };
  }

  function queueFrame() {
    if (!restoringContext && visit !== 'returning' && frameId === undefined) frameId = requestAnimationFrame(frame);
  }

  function stopFrame() {
    cancelAnimationFrame(frameId);
    frameId = undefined;
    cancelPresentation?.();
  }

  function openingViewport() {
    return [canvas.clientWidth, canvas.clientHeight, window.devicePixelRatio, fieldOfView.horizontal, fieldOfView.vertical].join('/');
  }

  function releaseOpeningStill() {
    openingStill?.image.remove();
    openingStill = undefined;
  }

  function captureOpeningStill() {
    if (canvas.clientWidth < 2 || canvas.clientHeight < 2) return;
    const image = document.createElement('canvas');
    image.width = canvas.width;
    image.height = canvas.height;
    const pixels = image.getContext('2d', { alpha: false });
    if (!pixels) return;
    try {
      // Copy in the same render task, before the WebGL drawing buffer can clear.
      pixels.drawImage(canvas, 0, 0);
      image.setAttribute('aria-hidden', 'true');
      Object.assign(image.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', pointerEvents: 'none' });
      openingStill = { image, viewport: openingViewport() };
    } catch {
      // The drawn WebGL scene is still prepared. Redraw on entry if a copy was unavailable.
    }
  }

  function announceOpeningFrame() {
    visit = 'revealing';
    hud.style.visibility = '';
    performance.mark('bikini-dive-opening-frame');
    notifySurface('bikini-dive-presented');
  }

  function presentOpeningFrame(warming) {
    if (warming) captureOpeningStill();
    else visit = 'presenting';
    const gl = canvas.getContext('webgl2');
    const completion = gl?.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    let poll;
    cancelPresentation = () => {
      cancelAnimationFrame(poll);
      if (completion) gl.deleteSync(completion);
      cancelPresentation = undefined;
    };
    if (completion) gl.flush();

    function check() {
      if (gl?.isContextLost()) {
        cancelPresentation();
        releaseOpeningStill();
        if (!warming) visit = 'entering';
        return;
      }
      if (completion) {
        const state = gl.clientWaitSync(completion, 0, 0);
        if (state === gl.TIMEOUT_EXPIRED) {
          poll = requestAnimationFrame(check);
          return;
        }
        if (state === gl.WAIT_FAILED) {
          cancelPresentation();
          showStartupError(new Error('海底首帧无法呈现。'));
          return;
        }
      }
      cancelPresentation();
      if (!readySent) {
        readySent = true;
        notifySurface('bikini-dive-ready');
      }
      if (warming) {
        visit = 'waiting';
        performance.mark('bikini-dive-warm-frame');
      } else {
        announceOpeningFrame();
      }
    }
    poll = requestAnimationFrame(check);
  }

  async function requestReturn(reason) {
    if (visit !== 'active') return;
    visit = 'returning';
    stopFrame();
    plaquePress = null;
    canvas.style.cursor = '';
    canvas.inert = true;
    hud.inert = true;
    if (document.fullscreenElement) {
      try {
        await document.exitFullscreen();
      } catch (error) {
        if (visit !== 'returning') return;
        if (document.fullscreenElement) {
          console.warn(error);
          visit = 'active';
          canvas.inert = false;
          hud.inert = false;
          queueFrame();
          const message = '请先退出全屏，再返回海面。';
          showStatus(message);
          setTimeout(() => { if (status.textContent === message) showStatus(''); }, 2800);
          return;
        }
      }
    }
    if (visit === 'returning') notifySurface('bikini-dive-return', { reason });
  }

  function updateSwimming(elapsed) {
    const steps = Math.max(1, Math.ceil(elapsed / .05));
    const limit = world.surfaceY - returnDepth;
    for (let i = 0; i < steps; i++) {
      const previousY = controls.camera.y;
      const swimming = controls.update(elapsed / steps);
      if (visit === 'active' && swimming && previousY < limit && controls.camera.y >= limit) {
        controls.camera.y = limit;
        void requestReturn('depth');
        break;
      }
    }
  }

  function frame(now) {
    frameId = undefined;
    const elapsed = previousTime === undefined ? 0 : Math.min(.24, (now - previousTime) / 1000);
    previousTime = now;
    sceneTime += elapsed * (motion.matches ? .30 : 1);
    let lens = fieldOfView;
    if (recordingCamera && visit === 'active') {
      recordingStart ??= now;
      recordingTime = Math.min(recordingCamera.duration, (now - recordingStart) / 1000);
      sceneTime = recordingSceneBase + recordingTime;
      Object.assign(controls.camera, recordingCamera.poseAt(recordingTime));
      lens = recordingCamera.lensAt(recordingTime, fieldOfView);
      window.bikiniLayout?.setRecordingTime?.(recordingTime);
      reachedRecordingDepth = controls.camera.y >= world.surfaceY - returnDepth;
    } else if (visit === 'standalone' || visit === 'active') updateSwimming(elapsed);
    try {
      world.render(controls.camera, sceneTime, now / 1000, lens);
    } catch (error) {
      if (visit !== 'warming' && visit !== 'entering') throw error;
      showStartupError(error);
      return;
    }
    updateInstruments(controls.camera, world.surfaceY);
    if (reachedRecordingDepth && visit === 'active') {
      void requestReturn('depth');
      return;
    }
    if (visit === 'warming' || visit === 'entering') {
      presentOpeningFrame(visit === 'warming');
      return;
    }
    if (visit === 'active' && openingStill?.image.isConnected) {
      const shown = openingStill.image;
      openingStill = undefined;
      requestAnimationFrame(() => shown.remove());
    }
    queueFrame();
  }

  if (surfaceHost) {
    const initialControlsTime = 4000;
    const edgeControlsTime = 3000;
    const controlPanels = [help, viewSettings, districtMenu];
    const heldHudPointers = new Set();
    let hudHideTimer;
    let hudVisibleUntil = 0;
    let hoveringControls = false;
    hud.classList.add('is-foldable');

    function foldIdleControls() {
      hudHideTimer = undefined;
      if (visit !== 'active' || recording) return;
      const remaining = hudVisibleUntil - performance.now();
      if (remaining > 0) {
        hudHideTimer = setTimeout(foldIdleControls, remaining);
        return;
      }
      const focused = document.activeElement;
      const keyboardFocus = document.hasFocus() && hud.contains(focused) && focused.matches(':focus-visible');
      if (!hoveringControls && !heldHudPointers.size && !keyboardFocus && !controlPanels.some(panel => panel.open)) {
        hud.classList.add('is-folded');
      }
    }

    function showControls(duration = edgeControlsTime) {
      if (visit !== 'active') return;
      hud.classList.remove('is-folded');
      const now = performance.now();
      hudVisibleUntil = Math.max(hudVisibleUntil, now + duration);
      if (hudHideTimer === undefined) hudHideTimer = setTimeout(foldIdleControls, hudVisibleUntil - now);
    }

    function extendVisibleControls() {
      if (!hud.classList.contains('is-folded')) showControls();
    }

    function resetControlsVisibility() {
      clearTimeout(hudHideTimer);
      hudHideTimer = undefined;
      hudVisibleUntil = 0;
      hoveringControls = false;
      heldHudPointers.clear();
      hud.classList.remove('is-folded');
    }

    function showControlsAtEdge(event) {
      const band = event.pointerType === 'touch' ? 56 : 48;
      const { clientX: x, clientY: y } = event;
      if (x <= band || x >= window.innerWidth - band || y <= band || y >= window.innerHeight - band) showControls();
    }

    function releaseHudPointer(event) {
      if (heldHudPointers.delete(event.pointerId)) extendVisibleControls();
    }

    window.addEventListener('pointermove', showControlsAtEdge, { passive: true });
    window.addEventListener('pointerdown', showControlsAtEdge, { passive: true });
    window.addEventListener('pointerup', releaseHudPointer);
    window.addEventListener('pointercancel', releaseHudPointer);
    hud.addEventListener('lostpointercapture', releaseHudPointer);
    hud.addEventListener('pointerdown', event => {
      heldHudPointers.add(event.pointerId);
      showControls();
    });
    hud.addEventListener('pointerenter', event => {
      if (event.pointerType !== 'mouse') return;
      hoveringControls = true;
      showControls();
    });
    hud.addEventListener('pointerleave', event => {
      if (event.pointerType !== 'mouse') return;
      hoveringControls = false;
      extendVisibleControls();
    });
    window.addEventListener('blur', () => {
      hoveringControls = false;
      heldHudPointers.clear();
      extendVisibleControls();
    });
    window.addEventListener('keydown', event => {
      if (event.key === 'Tab') showControls();
    }, true);
    hud.addEventListener('focusout', extendVisibleControls);
    for (const panel of controlPanels) panel.addEventListener('toggle', extendVisibleControls);

    const description = document.getElementById('controls-description');
    description.textContent += `轻点木牌，或上浮至 ${returnDepth} 米深度，可返回海面。`;
    description.textContent += '移到或轻触画面边缘，或按 Tab 键，可显示操作面板。';
    for (const guide of help.querySelectorAll('dl')) {
      guide.insertAdjacentHTML('beforeend', `<div><dt>返回海面</dt><dd>点木牌或上浮至 ${returnDepth} 米</dd></div>`);
    }

    function pointsAtPlaque(event) {
      const rect = canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return false;
      const x = (event.clientX - rect.left) / rect.width;
      const y = (event.clientY - rect.top) / rect.height;
      return x >= 0 && x <= 1 && y >= 0 && y <= 1
        && world.hitReturnPlaque(controls.camera, fieldOfView, x, y);
    }

    function movedPastSlop(event) {
      return Math.hypot(event.clientX - plaquePress.x, event.clientY - plaquePress.y) > tapSlop;
    }

    function cancelPlaquePress(event) {
      if (event.pointerId === plaquePress?.id) plaquePress = null;
    }

    canvas.addEventListener('pointerdown', event => {
      if (visit !== 'active' || !event.isPrimary || event.button !== 0 || !pointsAtPlaque(event)) return;
      plaquePress = { id: event.pointerId, x: event.clientX, y: event.clientY };
    });
    canvas.addEventListener('pointermove', event => {
      if (event.pointerId === plaquePress?.id && movedPastSlop(event)) plaquePress = null;
      if (event.pointerType === 'mouse') {
        canvas.style.cursor = visit === 'active' && !event.buttons && pointsAtPlaque(event) ? 'pointer' : '';
      }
    });
    canvas.addEventListener('pointerup', event => {
      if (event.pointerId !== plaquePress?.id) return;
      const activated = !movedPastSlop(event) && pointsAtPlaque(event);
      plaquePress = null;
      if (activated) void requestReturn('plaque');
    });
    canvas.addEventListener('pointercancel', cancelPlaquePress);
    canvas.addEventListener('lostpointercapture', cancelPlaquePress);
    canvas.addEventListener('pointerleave', () => { canvas.style.cursor = ''; });

    window.addEventListener('message', event => {
      if (event.source !== surfaceHost || event.origin !== origin || (boot !== null && event.data?.boot !== boot)) return;
      const type = event.data?.type;
      if (type === 'bikini-dive-enter' && visit === 'waiting' && readySent) {
        visit = 'entering';
        controls.resetImmediately();
        selectWaypoint('shallows');
        previousTime = undefined;
        if (openingStill?.viewport === openingViewport() && !restoringContext) {
          canvas.after(openingStill.image);
          announceOpeningFrame();
        } else {
          releaseOpeningStill();
          if (restoreOnEntry) restoreWorld();
          else queueFrame();
        }
      } else if (type === 'bikini-dive-controls' && visit === 'revealing') {
        visit = 'active';
        canvas.inert = false;
        hud.inert = false;
        hud.style.visibility = '';
        canvas.focus({ preventScroll: true });
        world.startReturnPlaque(sceneTime, !recording && motion.matches);
        if (recording) {
          startRecording();
          selectWaypoint(null);
        }
        showControls(initialControlsTime);
        previousTime = undefined;
        queueFrame();
      } else if (type === 'bikini-dive-leave' && visit !== 'waiting') {
        visit = 'waiting';
        plaquePress = null;
        canvas.style.cursor = '';
        canvas.inert = true;
        hud.inert = true;
        hud.style.visibility = 'hidden';
        resetControlsVisibility();
        help.open = false;
        viewSettings.open = false;
        districtMenu.open = false;
        for (const release of releaseTouchInputs) release();
        showStatus('');
        world.hideReturnPlaque();
        if (recording) window.bikiniLayout?.setRecordingTime?.(null);
        releaseOpeningStill();
        stopFrame();
      }
    });
  }

  canvas.addEventListener('webglcontextlost', (event) => {
    event.preventDefault();
    restoringContext = true;
    if (visit === 'warming' || visit === 'waiting' || visit === 'entering' || visit === 'presenting') releaseOpeningStill();
    if (visit === 'presenting') visit = 'entering';
    stopFrame();
    showStatus('图形连接中断，正在恢复海底场景…');
  });
  function activateWorldFrame() {
    previousTime = undefined;
    showStatus('');
    restoringContext = false;
    if (visit !== 'revealing') queueFrame();
  }

  function startAfterOpeningArt() {
    if (!surfaceHost) {
      activateWorldFrame();
      return;
    }
    const loadingWorld = world;
    restoringContext = true;
    void loadingWorld.openingArt.then(loaded => {
      if (loadingWorld !== world || canvas.getContext('webgl2')?.isContextLost()) return;
      if (!loaded && (visit === 'warming' || visit === 'waiting' || visit === 'entering')) {
        showStartupError(new Error('海底纹理未能完整加载。'), '海底纹理未能加载，可以返回海面后重试。');
        return;
      }
      if (loaded) performance.mark('bikini-dive-art-ready');
      activateWorldFrame();
    });
  }

  function restoreWorld() {
    restoreOnEntry = false;
    try {
      world = window.createDiveWorld(canvas);
      syncRoadProfile();
      syncQuality();
      if (visit === 'active' || visit === 'returning') world.startReturnPlaque(sceneTime, true);
      startAfterOpeningArt();
    } catch (error) {
      console.error(error);
      showStatus('海底场景恢复失败。请重新加载此页面。');
      if (visit === 'warming' || visit === 'waiting' || visit === 'entering') notifySurface('bikini-dive-error');
    }
  }
  canvas.addEventListener('webglcontextrestored', () => {
    if (visit === 'waiting') restoreOnEntry = true;
    else restoreWorld();
  });

  startAfterOpeningArt();
})();
