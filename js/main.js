/* ============================================================================
   main.js — MAIGO-CHAN master state engine
   ----------------------------------------------------------------------------
   Boot → cinematic wall zoom → missing-persons selection → alley exploration
   → sudden manifestation & dialogue → follow / freeze / chase → end.
   Manual WASD polling, mouse look, head-bob gait, camera tweens and all UI.
   ========================================================================== */
import * as THREE from 'three';
import { World, MODEL_URLS } from './world.js?v=b13';
import { Maigo } from './maigo.js?v=b13';
import { AudioEngine } from './audio.js?v=b13';
import { Mechanics, STATE, CLASS } from './mechanics.js?v=b13';
import { TEX } from './assets.js?v=b13';

// ?model=full  → the untouched 10.3 MB VRM (the exact file from earlier builds)
// ?model=lite  → the re-encoded 5.3 MB VRM
{
  const want = new URLSearchParams(location.search).get('model');
  if (want === 'full' && MODEL_URLS.maigoFull) MODEL_URLS.maigo = MODEL_URLS.maigoFull;
  if (want === 'lite') MODEL_URLS.maigo = 'assets/maigo-lite.vrm';
}

/* --------------------------------------------------------------------------
   DOM
   ------------------------------------------------------------------------- */
const $ = (sel) => document.querySelector(sel);
/* --------------------------------------------------------------------------
   DOM RESILIENCE
   A page that is half-cached (old index.html, new js/) used to throw
   "cannot set properties of null" and leave the title screen dead. Every
   lookup now falls back to an inert element, so a missing node is a no-op
   instead of a fatal error.
   -------------------------------------------------------------------------- */
function _inertEl() {
  const stub = {
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    style: {},
    dataset: {},
    children: [],
    textContent: '',
    innerHTML: '',
    value: '',
    src: '',
    disabled: false,
    addEventListener() {}, removeEventListener() {},
    appendChild() {}, remove() {}, setAttribute() {}, focus() {},
    getBoundingClientRect() { return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }; },
  };
  return stub;
}
function _safe(el) {
  if (el) return el;
  const stub = _inertEl();
  return new Proxy(stub, {
    get(t, k) {
      if (k in t) return t[k];
      return undefined;
    },
    set(t, k, v) { t[k] = v; return true; },
  });
}

const dom = new Proxy({
  canvas: $('#scene'),
  ui: $('#ui'),
  hud: $('#hud'),
  crosshair: $('#crosshair'),
  boot: $('#boot'),
  enter: $('#enter-btn'),
  loadStatus: $('#load-status'),
  letterbox: $('#letterbox'),
  subtitle: $('#subtitle'),
  subtitleJp: $('#subtitle-jp'),
  subtitleEn: $('#subtitle-en'),
  choices: $('#dialogue-choices'),
  choiceYes: $('.choice-btn.yes'),
  choiceNo: $('.choice-btn.no'),
  board: $('#board-overlay'),
  lookNameJp: $('#look-name-jp'),
  lookNameEn: $('#look-name-en'),
  lookTraits: $('#look-traits'),
  classChip: $('#class-chip .val'),
  torchChip: $('#torch-chip'),
  candyChip: $('#candy-chip'),
  candyVal: $('#candy-chip .val'),
  blanketChip: $('#blanket-chip'),
  blanketVal: $('#blanket-chip .val'),
  pathTag: $('#path-tag'),
  shadowTrap: $('#shadow-trap'),
  shadowBar: $('#shadow-trap .trap-bar i'),
  victoryWash: $('#victory-wash'),
  objective: $('#objective'),
  prompt: $('#prompt'),
  promptKey: $('#prompt .key'),
  promptText: $('#prompt .txt'),
  backAlert: $('#alert-back'),
  backBar: $('#alert-back .timer i'),
  freezeAlert: $('#freeze-alert'),
  freezeBar: $('#freeze-alert .freeze-bar i'),
  protocolHud: $('#protocol-hud'),
  protocolRows: [...document.querySelectorAll('.proto-row')],
  toast: $('#toast'),
  chapterCard: $('#chapter-card'),
  chapterJp: $('#chapter-card .cc-jp'),
  chapterEn: $('#chapter-card .cc-en'),
  locationTag: $('#location-tag'),
  jumpscare: $('#jumpscare'),
  jumpscareImg: $('#jumpscare-img'),
  gameover: $('#gameover'),
  goReason: $('.go-reason'),
  goTip: $('.go-tip'),
  retry: $('#retry-btn'),
  ending: $('#ending'),
  endKicker: $('.end-kicker'),
  endTitle: $('.end-title'),
  endTitleEn: $('.end-title-en'),
  endBody: $('.end-body'),
  again: $('#again-btn'),
  pause: $('#pause'),
  resume: $('#resume-btn'),
  flash: $('#flash'),
  controlsHint: $('#controls-hint'),
}, {
  get(target, key) {
    if (key in target) return _safe(target[key]);
    return undefined;
  },
});

/* --------------------------------------------------------------------------
   WEBGL / SCENE / ENTITIES
   ------------------------------------------------------------------------- */
const world = new World(dom.canvas);
const maigo = new Maigo(world.scene);
const audio = new AudioEngine();

const player = {
  position: new THREE.Vector3(0, 0, 9.0),
  yaw: Math.PI,
  pitch: -0.04,
  eye: 1.9,
  velocity: new THREE.Vector3(),
  speed: 0,
  bobPhase: 0,
  bobY: 0,
  bobX: 0,
  roll: 0,
};

const game = {
  state: STATE.BOOT,
  prevState: null,
  classType: null,
  candy: 0,
  candiesCollected: 0,      // student route: exactly three, one per vending
  blanketsCollected: 0,     // adult path A: exactly three, one per loop
  flags: { manifested: false, answered: false, ending: false },
  controlsActive: false,
  inputLocked: false,           // true from the instant a lose fires
  pointerLocked: false,
  fallbackLook: false,
  pointerLockBlocked: false,
  shaking: null,
  dialogue: null,
  selected: false,
  player,
  world,
  maigo,
  audio,
  camera: world.camera,
  input: {
    keys: { w: false, a: false, s: false, d: false, shift: false },
    freezeNoise: 0,
    // --- hybrid control state -----------------------------------------
    // joy: the left stick in -1..1 (y is forward), driven by touch on mobile
    joy: { x: 0, y: 0, active: false },
    // look: accumulated look-pad / mouse delta since the last consumer read
    look: 0,
    // true while any control vector is doing something, whatever the device
    moving() {
      const k = this.keys;
      if (k.w || k.a || k.s || k.d) return true;
      const j = this.joy;
      return j.active && (Math.abs(j.x) > 0.06 || Math.abs(j.y) > 0.06);
    },
    // how much the player is turning right now (px of mouse, or of touch drag)
    lookDelta() { return this.look; },
    consumeLook() { const v = this.look; this.look = 0; return v; },
  },
};

/* --------------------------------------------------------------------------
   DEVICE DETECTION — one flag, decided before anything is initialised.
   A coarse pointer is the honest test; ontouchstart alone is true on plenty
   of touchscreen laptops that still have a mouse and a keyboard.
   -------------------------------------------------------------------------- */
const IS_MOBILE = (() => {
  try {
    const coarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
    const noHover = window.matchMedia && window.matchMedia('(hover: none)').matches;
    const touch = ('ontouchstart' in window) || (navigator.maxTouchPoints || 0) > 0;
    const ua = /Android|iPhone|iPad|iPod|Mobile|Windows Phone|IEMobile|Opera Mini|Silk/i.test(navigator.userAgent || '');
    const narrow = Math.min(window.innerWidth, window.innerHeight) <= 820;
    if (ua) return true;
    if (touch && coarse && noHover) return true;
    if (touch && narrow && coarse) return true;
    return false;
  } catch (e) { return false; }
})();

game.isMobile = IS_MOBILE;
window.gameState = game;        // the documented global handle

if (IS_MOBILE) {
  document.documentElement.classList.add('mobile');
  document.body.classList.add('mobile');
}

/* --------------------------------------------------------------------------
   UI CONTROLLER
   ------------------------------------------------------------------------- */
let toastTimer = null;
let chapterTimer = null;

const ui = {
  setObjective(jp, en) {
    dom.objective.innerHTML = `<span class="jp">${jp}</span><span class="en">${en}</span>`;
  },
  setClass(cls) {
    dom.classChip.textContent = cls === CLASS.STUDENT ? '女子高生 / STUDENT' : '会社員 / SALARYMAN';
    document.body.classList.toggle('adult', cls === CLASS.ADULT);
  },
  setPrompt(p) {
    if (!p) { dom.prompt.classList.add('hidden'); return; }
    dom.promptKey.textContent = p.key;
    dom.promptText.textContent = p.text;
    dom.prompt.classList.remove('hidden');
  },
  toast(msg, ms = 2600) {
    dom.toast.textContent = msg;
    dom.toast.classList.remove('hidden');
    dom.toast.style.animation = 'none';
    void dom.toast.offsetWidth;
    dom.toast.style.animation = '';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => dom.toast.classList.add('hidden'), ms);
  },
  setFreeze(on, progress = 0) {
    dom.freezeAlert.classList.toggle('hidden', !on);
    dom.freezeBar.style.transform = `scaleX(${THREE.MathUtils.clamp(progress, 0, 1)})`;
  },
  setBackAlert(on, ratio = 0) {
    dom.backAlert.classList.toggle('hidden', !on);
    dom.backAlert.classList.toggle('on', on);
    dom.backBar.style.width = `${THREE.MathUtils.clamp(ratio, 0, 1) * 100}%`;
    dom.crosshair.classList.toggle('danger', on);
  },
  setProtocols(payload) {
    if (!payload || payload.classType !== CLASS.ADULT) {
      dom.protocolHud.classList.add('hidden');
      return;
    }
    dom.protocolHud.classList.remove('hidden');
    for (const row of dom.protocolRows) {
      const n = Number(row.dataset.proto);
      row.classList.toggle('used', !!payload.used?.[n]);
      row.classList.remove('available');
    }
  },
  setProtocolAvailability(map) {
    if (!map) return;
    for (const row of dom.protocolRows) {
      const n = Number(row.dataset.proto);
      row.classList.toggle('available', !!map[n]);
    }
  },
  setCandy(n, total = 3) {
    dom.candyChip.classList.toggle('hidden', n <= 0);
    dom.candyVal.textContent = total ? `${n}/${total}` : String(n);
  },
  setBlanket(n, total = 3) {
    if (!dom.blanketChip) return;
    dom.blanketChip.classList.toggle('hidden', n <= 0);
    dom.blanketVal.textContent = `${n}/${total}`;
  },
  setPathTag(text) {
    if (!dom.pathTag) return;
    if (!text) { dom.pathTag.classList.add('hidden'); return; }
    dom.pathTag.textContent = text;
    dom.pathTag.classList.remove('hidden');
  },
  showShadowTrap(on, ratio = 1) {
    if (!dom.shadowTrap) return;
    dom.shadowTrap.classList.toggle('hidden', !on);
    if (on && dom.shadowBar) dom.shadowBar.style.width = `${Math.max(0, Math.min(1, ratio)) * 100}%`;
  },
  setChaseMeter(v) {
    let el = document.getElementById('chase-hud');
    if (!el) return;
    if (v < 0) { el.classList.add('hidden'); return; }
    el.classList.remove('hidden');
    el.querySelector('i').style.width = `${THREE.MathUtils.clamp(1 - v, 0, 1) * 100}%`;
  },
  crosshairHot(hot) {
    dom.crosshair.classList.toggle('hot', hot);
  },
  showSubtitle(vocative) {
    const sp = dom.subtitle.querySelector('.speaker');
    if (sp && this._speakerHtml) sp.innerHTML = this._speakerHtml;
    const jp = `あの… <span class="vocative ${vocative === 'ojisan' ? 'lit' : 'dim'}" data-v="adult">おじさん</span> / <span class="vocative ${vocative === 'oneesan' ? 'lit' : 'dim'}" data-v="student">おねえさん</span>… 道に迷っちゃって。<br>お家まで連れて行ってくれませんか？`;
    const en = `Um… Uncle / Aunty… I am lost.<br>Could you please help me reach my home?`;
    dom.subtitleJp.innerHTML = jp;
    dom.subtitleEn.innerHTML = en;
    dom.subtitle.classList.remove('hidden');
    dom.subtitle.style.animation = 'none';
    void dom.subtitle.offsetWidth;
    dom.subtitle.style.animation = '';
  },
  /* the line you just said, in your own voice, labelled as yours */
  showPlayerLine(kind, who) {
    const sp = dom.subtitle.querySelector('.speaker');
    if (sp) {
      if (!this._speakerHtml) this._speakerHtml = sp.innerHTML;
      sp.innerHTML = '<span class="jp">あなた</span><span class="en">YOU</span>';
    }
    const adult = who === 'adult';
    const jp = adult
      ? (kind === 'yes' ? '「ああ。家まで、送ってやるよ。」' : '「いや。関わらないでおく。」')
      : (kind === 'yes' ? '「はい。お家まで、送ります。」' : '「いいえ。関わりません。」');
    const en = kind === 'yes'
      ? (adult ? '“Yeah. I&#39;ll walk you home.”' : '“Yes. I&#39;ll take you home.”')
      : (adult ? '“No. I&#39;ll stay out of this.”' : '“No. I&#39;m not getting involved.”');
    dom.subtitleJp.innerHTML = jp;
    dom.subtitleEn.innerHTML = en;
    dom.subtitle.classList.remove('hidden');
    dom.subtitle.style.animation = 'none';
    void dom.subtitle.offsetWidth;
    dom.subtitle.style.animation = '';
  },
  hideSubtitle() { dom.subtitle.classList.add('hidden'); },
  showChoices(on) {
    dom.choices.classList.toggle('hidden', !on);
    if (on) {
      dom.choices.style.animation = 'none';
      void dom.choices.offsetWidth;
      dom.choices.style.animation = '';
    }
  },
  showHUD() { dom.hud.classList.remove('hidden'); },
  hideHUD() { dom.hud.classList.add('hidden'); },
  setTorch(on) {
    dom.torchChip.classList.toggle('on', on);
    dom.torchChip.querySelector('.txt').textContent = on ? 'TORCH ON' : 'TORCH OFF';
  },
  chapter(jp, en) {
    dom.chapterJp.textContent = jp;
    dom.chapterEn.textContent = en;
    dom.chapterCard.classList.remove('hidden');
    dom.chapterCard.style.animation = 'none';
    void dom.chapterCard.offsetWidth;
    dom.chapterCard.style.animation = '';
    clearTimeout(chapterTimer);
    chapterTimer = setTimeout(() => dom.chapterCard.classList.add('hidden'), 3800);
  },
  flash(ms = 220) {
    dom.flash.classList.add('on');
    setTimeout(() => dom.flash.classList.remove('on'), ms);
  },
  /* ------------------------------------------------------------------
     THE SCARE — the face is nailed to the screen and the hand holding the
     camera is shaking. Driven per frame so the jitter is genuinely violent
     rather than a polite CSS slide.
     ------------------------------------------------------------------ */
  jumpscare() {
    const wrap = dom.jumpscare.querySelector('.js-img-wrap');
    const face = dom.jumpscareImg;
    if (!wrap || !face) return;

    this._scaring = true;
    dom.jumpscare.classList.add('active');
    // restart the strobe/impact animations even on a second use
    dom.jumpscare.querySelectorAll('.js-red,.js-impact').forEach((el) => {
      el.style.animation = 'none';
      void el.offsetWidth;
      el.style.animation = '';
    });

    const t0 = performance.now();
    let lastFlip = 0;
    const tick = () => {
      if (!this._scaring) return;
      const e = performance.now() - t0;
      if (e > 3000) { this._scaring = false; return; }   // never spin forever
      // amplitude decays over ~1.1 s but never settles: the last frames still twitch
      const amp = 34 * Math.exp(-e / 780) + 6;
      const x = (Math.random() * 2 - 1) * amp;
      const y = (Math.random() * 2 - 1) * amp;
      const r = (Math.random() * 2 - 1) * (2.4 + 7 * Math.exp(-e / 520));
      const s = 1.14 + Math.random() * 0.09 + 0.12 * Math.exp(-e / 420);
      const flip = e - lastFlip < 90 && Math.random() < 0.5 ? -1 : 1;
      if (Math.random() < 0.05) lastFlip = e;
      wrap.style.transform =
        `translate3d(${x.toFixed(1)}px,${y.toFixed(1)}px,0) rotate(${r.toFixed(2)}deg) ` +
        `scale(${(s * flip).toFixed(3)},${s.toFixed(3)})`;
      // a corrupt frame now and then: inverted, blown-out, wrong colour
      if (Math.random() < 0.035) {
        face.style.filter = `invert(${Math.random() < 0.5 ? 1 : 0}) contrast(2.1) ` +
          `hue-rotate(${(Math.random() * 40 - 20).toFixed(0)}deg) brightness(1.15)`;
      } else if (face.style.filter) {
        face.style.filter = '';
      }
      requestAnimationFrame(tick);
    };
    tick();
  },
  hideJumpscare() {
    this._scaring = false;
    dom.jumpscare.classList.remove('active');
    const wrap = dom.jumpscare.querySelector('.js-img-wrap');
    if (wrap) wrap.style.transform = '';
    if (dom.jumpscareImg) dom.jumpscareImg.style.filter = '';
  },
  gameOver(reason, tip) {
    dom.goReason.textContent = reason || 'SHE FOUND YOU.';
    dom.goTip.textContent = tip || '';
    dom.gameover.classList.remove('hidden');
  },
  hideGameOver() { dom.gameover.classList.add('hidden'); },
  ending(kind, cls) {
    if (kind === 'safe-return') {
      dom.endKicker.textContent = 'ENDING 03 — 日の光 / DAYLIGHT';
      dom.endTitle.textContent = 'お家に、帰れた。';
      dom.endTitleEn.textContent = 'SAFE RETURN';
      dom.endBody.textContent = 'Three wrapped candies, one in each small hand. The indigo fog lifts and the alley turns the colour of a morning you have not seen yet. She walks into the light between the buildings, and the street stops repeating.';
    } else if (kind === 'escaped-loop') {
      dom.endKicker.textContent = 'ENDING 04 — 毛布 / CONTAINMENT';
      dom.endTitle.textContent = '眠った、ふり。';
      dom.endTitleEn.textContent = 'ESCAPED THE LOOP';
      dom.endBody.textContent = 'You lay the three blankets over her shoulders. She goes still under the weight of them, and the alley exhales. Whatever she is, she is warm now. The loop lets you go without turning around.';
    } else if (kind === 'awakening') {
      dom.endKicker.textContent = 'ENDING 05 — 車内 / THE VEHICLE';
      dom.endTitle.textContent = '「ごめんね」';
      dom.endTitleEn.textContent = 'SORRY…';
      dom.endBody.textContent = 'Sixty metres. A whisper, barely there, and then the alley is gone. You are behind a steering wheel at 23:47 with the rain on the glass and her missing poster under the wiper. The engine is already running.';
    } else if (kind === 'door') {
      dom.endKicker.textContent = 'ENDING 02 — 灯り / THE LIGHT';
      dom.endTitle.textContent = '手を、離した。';
      dom.endTitleEn.textContent = 'YOU BROUGHT HER HOME.';
      dom.endBody.textContent = 'You take her hand. It is cold, and much smaller than it should be. The convenience-store door opens onto a street you do not recognise. She lets go first, bows once, and is gone before the door swings shut.';
    } else {
      dom.endKicker.textContent = 'ENDING 01 — 帰路 / THE WAY HOME';
      dom.endTitle.textContent = 'お家、着いた。';
      dom.endTitleEn.textContent = 'YOU BROUGHT HER HOME.';
      dom.endBody.textContent = 'She takes the wrapped candy in both hands, bows twice, and walks into the light between the buildings. You never see her face again. Behind you, the vending machine stops humming.';
    }
    dom.ending.classList.remove('hidden');
  },
  hideEnding() { dom.ending.classList.add('hidden'); },
};

game.ui = ui;
game.crosshairHot = (hot) => ui.crosshairHot(hot);

const mechanics = new Mechanics(game);
game.mechanics = mechanics;
window.__maigo = game;
window.__world = world;
window.__maigoDebug = { frames: 0, fps: 0 };

/* --------------------------------------------------------------------------
   CHASE METER (injected)
   ------------------------------------------------------------------------- */
(function injectChaseMeter() {
  const el = document.createElement('div');
  el.id = 'chase-hud';
  el.className = 'hidden';
  el.innerHTML = `<span class="jp">距離</span><span class="en">DISTANCE</span><div class="bar"><i></i></div>`;
  dom.hud.appendChild(el);
})();

/* --------------------------------------------------------------------------
   INPUT
   ------------------------------------------------------------------------- */
const KEYMAP = { KeyW: 'w', KeyA: 'a', KeyS: 's', KeyD: 'd', ArrowUp: 'w', ArrowLeft: 'a', ArrowDown: 's', ArrowRight: 'd' };

function gameplayState() {
  if (game.inputLocked) return false;
  return [STATE.EXPLORE, STATE.FOLLOW, STATE.FREEZE, STATE.CHASE].includes(game.state);
}

function requestLook() {
  // a phone that is asked for pointer lock can lose its render loop entirely
  if (game.isMobile) { game.fallbackLook = false; return; }
  if (document.pointerLockElement === dom.canvas) return;
  if (game.pointerLockBlocked) { game.fallbackLook = true; return; }
  try {
    const p = dom.canvas.requestPointerLock?.({ unadjustedMovement: true });
    if (p && typeof p.catch === 'function') {
      p.catch(() => {
        try { dom.canvas.requestPointerLock(); }
        catch (e) { game.pointerLockBlocked = true; game.fallbackLook = true; }
      });
    }
  } catch (e) {
    game.pointerLockBlocked = true;
    game.fallbackLook = true;
  }
  setTimeout(() => {
    if (!document.pointerLockElement && !game.pointerLockBlocked) game.fallbackLook = true;
  }, 700);
}

let lastMouse = null;
document.addEventListener('mousemove', (e) => {
  // during the board moment the cursor is a pointing device, not a look axis
  if (game.state === STATE.SELECT) {
    _boardAim = 'mouse';
    const r = dom.canvas.getBoundingClientRect();
    _ndc.x = ((e.clientX - r.left) / r.width) * 2 - 1;
    _ndc.y = -((e.clientY - r.top) / r.height) * 2 + 1;
    updateBoardAim();
    return;
  }
  if (!gameplayState()) { lastMouse = { x: e.clientX, y: e.clientY }; return; }
  const locked = document.pointerLockElement === dom.canvas;
  let dx = 0, dy = 0;
  if (locked) {
    dx = e.movementX || 0;
    dy = e.movementY || 0;
  } else if (game.fallbackLook) {
    if (lastMouse) {
      dx = THREE.MathUtils.clamp(e.clientX - lastMouse.x, -90, 90);
      dy = THREE.MathUtils.clamp(e.clientY - lastMouse.y, -90, 90);
    }
    lastMouse = { x: e.clientX, y: e.clientY };
  } else {
    return;
  }
  applyLook(dx, dy);
});

/* --------------------------------------------------------------------------
   MOBILE — left stick, right look pad, action buttons.
   Installed only when the device was detected as touch-first; on a desktop
   none of these listeners exist and none of the markup is visible.
   -------------------------------------------------------------------------- */
function installTouchControls() {
  const joyZone = $('#joy-zone');
  const joyBase = $('#joy-base');
  const knob = $('#joy-knob');
  const pad = $('#look-pad');
  if (!joyZone || !joyBase || !knob || !pad) return;

  /* ---------------- left stick ---------------------------------------- */
  let joyId = null;
  let center = { x: 0, y: 0 };
  let radius = 1;

  const resetStick = () => {
    joyId = null;
    game.input.joy.x = 0;
    game.input.joy.y = 0;
    game.input.joy.active = false;
    joyBase.classList.remove('active');
    knob.style.transform = 'translate(-50%,-50%)';
  };

  const setStick = (t) => {
    const dx = t.clientX - center.x;
    const dy = t.clientY - center.y;          // screen y grows downward
    const len = Math.hypot(dx, dy);
    const dead = radius * 0.12;
    let nx = 0, ny = 0;
    if (len > dead) {
      const k = Math.min(1, (len - dead) / (radius - dead)) / (len || 1);
      nx = dx * k;
      ny = dy * k;
    }
    game.input.joy.x = Math.max(-1, Math.min(1, nx));
    game.input.joy.y = Math.max(-1, Math.min(1, -ny));   // up the screen = forward
    game.input.joy.active = len > dead;
    const travel = radius * 0.62;
    const tx = nx * travel, ty = ny * travel;
    knob.style.transform = `translate(calc(-50% + ${tx.toFixed(1)}px), calc(-50% + ${ty.toFixed(1)}px))`;
  };

  const beginStick = (t) => {
    const r = joyBase.getBoundingClientRect();
    center = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    radius = r.width * 0.5;
    joyId = t.identifier;
    game.input.joy.active = true;
    joyBase.classList.add('active');
    setStick(t);
  };

  joyZone.addEventListener('touchstart', (e) => {
    if (joyId !== null) return;
    const t = e.changedTouches[0];
    if (!t) return;
    e.preventDefault();
    beginStick(t);
  }, { passive: false });

  joyZone.addEventListener('touchmove', (e) => {
    if (joyId === null) return;
    for (const t of e.changedTouches) {
      if (t.identifier === joyId) { e.preventDefault(); setStick(t); return; }
    }
  }, { passive: false });

  const endStick = (e) => {
    for (const t of e.changedTouches) if (t.identifier === joyId) { resetStick(); return; }
  };
  joyZone.addEventListener('touchend', endStick);
  joyZone.addEventListener('touchcancel', endStick);

  // a thumb that slides past the zone keeps steering until it lifts
  document.addEventListener('touchmove', (e) => {
    if (joyId === null) return;
    for (const t of e.changedTouches) {
      if (t.identifier === joyId) { setStick(t); return; }
    }
  }, { passive: true });
  document.addEventListener('touchend', (e) => {
    if (joyId === null) return;
    for (const t of e.changedTouches) if (t.identifier === joyId) resetStick();
  }, { passive: true });

  /* ---------------- right half: look ---------------------------------- */
  let lookId = null;
  let last = { x: 0, y: 0 };
  const SENS = 0.0021;                 // identical to the mouse

  pad.addEventListener('touchstart', (e) => {
    const t = e.changedTouches[0];
    if (lookId !== null || !t) return;
    e.preventDefault();
    lookId = t.identifier;
    last = { x: t.clientX, y: t.clientY };
  }, { passive: false });

  pad.addEventListener('touchmove', (e) => {
    if (lookId === null) return;
    for (const t of e.changedTouches) {
      if (t.identifier !== lookId) continue;
      e.preventDefault();
      const dx = THREE.MathUtils.clamp(t.clientX - last.x, -90, 90);
      const dy = THREE.MathUtils.clamp(t.clientY - last.y, -90, 90);
      last = { x: t.clientX, y: t.clientY };
      if (!gameplayState()) return;
      applyLook(dx, dy);
      return;
    }
  }, { passive: false });

  const endLook = (e) => {
    for (const t of e.changedTouches) if (t.identifier === lookId) { lookId = null; return; }
  };
  pad.addEventListener('touchend', endLook);
  pad.addEventListener('touchcancel', endLook);

  document.addEventListener('touchmove', (e) => {
    if (lookId === null) return;
    for (const t of e.changedTouches) {
      if (t.identifier !== lookId) continue;
      const dx = THREE.MathUtils.clamp(t.clientX - last.x, -90, 90);
      const dy = THREE.MathUtils.clamp(t.clientY - last.y, -90, 90);
      last = { x: t.clientX, y: t.clientY };
      if (gameplayState()) applyLook(dx, dy);
      return;
    }
  }, { passive: true });
  document.addEventListener('touchend', (e) => {
    if (lookId === null) return;
    for (const t of e.changedTouches) if (t.identifier === lookId) lookId = null;
  }, { passive: true });

  /* ---------------- buttons ------------------------------------------- */
  const tap = (el, fn) => {
    if (!el) return;
    const fire = (e) => {
      e.preventDefault();
      e.stopPropagation();
      el.classList.add('hit');
      setTimeout(() => el.classList.remove('hit'), 140);
      if (navigator.vibrate) { try { navigator.vibrate(12); } catch (err) { /* noop */ } }
      fn();
    };
    el.addEventListener('touchstart', fire, { passive: false });
    el.addEventListener('click', (e) => { e.preventDefault(); fn(); });  // desktop preview
  };

  tap($('#m-interact'), () => {
    if (game.state === STATE.DIALOGUE) { answer('yes'); return; }
    mechanics.tryInteract();
  });
  tap($('#m-torch'), () => toggleTorch());
  tap($('#m-proto1'), () => mechanics.useProtocol(1));
  tap($('#m-proto2'), () => mechanics.useProtocol(2));
  tap($('#m-yes'), () => answer('yes'));
  tap($('#m-no'), () => answer('no'));

  game.mobile = { resetStick, endLook };
}

/* shared by the mouse and the touch pad, so the trap audits read one counter */
function applyLook(dx, dy) {
  if (!dx && !dy) return;
  game.input.look += Math.abs(dx) + Math.abs(dy);
  if (game.state === STATE.FREEZE) game.input.freezeNoise += Math.abs(dx) + Math.abs(dy);
  player.yaw -= dx * 0.0021;
  player.pitch = THREE.MathUtils.clamp(player.pitch - dy * 0.0021, -1.28, 1.28);
}

/* --------------------------------------------------------------------------
   MOBILE UI SYNC — what the thumbs are allowed to see and touch right now.
   -------------------------------------------------------------------------- */
function syncMobile() {
  if (!game.isMobile) return;
  const selecting = game.state === STATE.SELECT;
  const playable = [STATE.EXPLORE, STATE.FOLLOW, STATE.FREEZE, STATE.CHASE].includes(game.state);
  const asking = !dom.choices.classList.contains('hidden');

  document.body.classList.toggle('in-select', selecting);
  const pad = $('#look-pad');
  if (pad) pad.style.pointerEvents = (selecting || asking) ? 'none' : 'auto';
  const zone = $('#joy-zone');
  if (zone) zone.style.display = playable || asking ? '' : 'none';
  const acts = $('#m-actions');
  if (acts) acts.style.display = playable ? '' : 'none';
  const mc = $('#m-choices');
  if (mc) mc.classList.toggle('show', asking);
}

/* in the board moment a tap is a pointing device: aim, then confirm */
function installMobileSelection() {
  let down = null;
  document.addEventListener('touchstart', (e) => {
    if (game.state !== STATE.SELECT) { down = null; return; }
    const t = e.changedTouches[0];
    if (!t) return;
    down = { x: t.clientX, y: t.clientY, t: performance.now() };
    const r = dom.canvas.getBoundingClientRect();
    _ndc.x = ((t.clientX - r.left) / r.width) * 2 - 1;
    _ndc.y = -((t.clientY - r.top) / r.height) * 2 + 1;
    updateBoardAim();
  }, { passive: true });

  document.addEventListener('touchend', (e) => {
    if (game.state !== STATE.SELECT || !down) return;
    const t = e.changedTouches[0];
    if (!t) return;
    const moved = Math.hypot(t.clientX - down.x, t.clientY - down.y);
    const held = performance.now() - down.t;
    down = null;
    if (moved > 24 || held > 700) return;      // a drag, not a tap
    if (boardHover) selectClass(boardHover);
  }, { passive: true });
}

if (IS_MOBILE) {
  installTouchControls();
  installMobileSelection();
}

document.addEventListener('pointerlockchange', () => {
  if (game.isMobile) return;
  const locked = document.pointerLockElement === dom.canvas;
  game.pointerLocked = locked;
  if (locked) {
    dom.pause.classList.add('hidden');
    if (game.state === STATE.PAUSED && game.prevState) {
      game.state = game.prevState;
      game.prevState = null;
      game.controlsActive = true;
    }
    return;
  }
  // user released the pointer during play → pause. Never pause cutscenes / menus.
  if (gameplayState() && !game.fallbackLook) {
    pauseGame();
  }
});
document.addEventListener('pointerlockerror', () => {
  game.pointerLockBlocked = true;
  game.fallbackLook = true;
});

function pauseGame() {
  if (!gameplayState()) return;
  game.prevState = game.state;
  game.state = STATE.PAUSED;
  dom.pause.classList.remove('hidden');
  ui.setPrompt(null);
  for (const k in game.input.keys) game.input.keys[k] = false;
}
function resumeGame() {
  if (game.state !== STATE.PAUSED) return;
  game.state = game.prevState || STATE.FOLLOW;
  game.prevState = null;
  dom.pause.classList.add('hidden');
  if (!game.fallbackLook) requestLook();
  else game.fallbackLook = true;
}
dom.resume.addEventListener('click', resumeGame);
dom.pause.addEventListener('click', (e) => { if (e.target === dom.pause) resumeGame(); });

window.addEventListener('keydown', (e) => {
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
  const mapped = KEYMAP[e.code];
  if (mapped) game.input.keys[mapped] = true;
  if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') game.input.keys.shift = true;
  if (e.repeat) return;

  if (game.state === STATE.SELECT) {
    if (e.code === 'Digit1') { _boardAim = 'key'; setBoardHover(CLASS.STUDENT); selectClass(CLASS.STUDENT); }
    if (e.code === 'Digit2') { _boardAim = 'key'; setBoardHover(CLASS.ADULT); selectClass(CLASS.ADULT); }
    if (e.code === 'KeyA' || e.code === 'ArrowLeft') { _boardAim = 'key'; setBoardHover(CLASS.STUDENT); }
    if (e.code === 'KeyD' || e.code === 'ArrowRight') { _boardAim = 'key'; setBoardHover(CLASS.ADULT); }
    if (e.code === 'KeyE' || e.code === 'Enter' || e.code === 'Space') {
      if (boardHover) selectClass(boardHover);
    }
    return;
  }

  switch (e.code) {
    case 'KeyF': toggleTorch(); break;
    case 'KeyR': if (!maigo.isVRM) retryAvatar(); break;
    case 'KeyE': mechanics.tryInteract(); break;
    case 'KeyQ': mechanics.offerCandy(); break;
    case 'Digit1': if (game.classType === CLASS.ADULT) mechanics.useProtocol(1); break;
    case 'Digit2': if (game.classType === CLASS.ADULT) mechanics.useProtocol(2); break;
    case 'Digit3': if (game.classType === CLASS.ADULT) mechanics.useProtocol(3); break;
    case 'KeyY': if (!dom.choices.classList.contains('hidden')) answer('yes'); break;
    case 'KeyN': if (!dom.choices.classList.contains('hidden')) answer('no'); break;
    case 'Escape': if (game.state === STATE.PAUSED) resumeGame(); break;
  }
});

window.addEventListener('keyup', (e) => {
  const mapped = KEYMAP[e.code];
  if (mapped) game.input.keys[mapped] = false;
  if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') game.input.keys.shift = false;
});
window.addEventListener('blur', () => {
  for (const k in game.input.keys) game.input.keys[k] = false;
});

function toggleTorch() {
  if (![STATE.EXPLORE, STATE.FOLLOW, STATE.FREEZE, STATE.CHASE].includes(game.state)) return;
  const on = world.toggleFlashlight();
  ui.setTorch(on);
  audio.tick(on ? 0.045 : 0.025);
  game.world.setDread(world.dread);
}

/* --------------------------------------------------------------------------
   CAMERA TWEENS / SHAKE
   ------------------------------------------------------------------------- */
let camTween = null;

function tweenCamera(opts) {
  camTween = {
    t: 0,
    dur: opts.dur,
    fromPos: opts.fromPos.clone(),
    toPos: opts.toPos.clone(),
    fromYaw: opts.fromYaw,
    toYaw: opts.toYaw,
    fromPitch: opts.fromPitch,
    toPitch: opts.toPitch,
    fromFov: opts.fromFov,
    toFov: opts.toFov,
    onDone: opts.onDone,
  };
  game.controlsActive = false;
}

function updateCamTween(dt) {
  const tw = camTween;
  tw.t += dt;
  const k = THREE.MathUtils.clamp(tw.t / tw.dur, 0, 1);
  const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
  player.position.x = THREE.MathUtils.lerp(tw.fromPos.x, tw.toPos.x, e);
  player.position.z = THREE.MathUtils.lerp(tw.fromPos.z, tw.toPos.z, e);
  player.eye = THREE.MathUtils.lerp(tw.fromPos.y, tw.toPos.y, e);
  player.yaw = THREE.MathUtils.lerp(tw.fromYaw, tw.toYaw, e);
  player.pitch = THREE.MathUtils.lerp(tw.fromPitch, tw.toPitch, e);
  world.camera.fov = THREE.MathUtils.lerp(tw.fromFov, tw.toFov, e);
  world.camera.updateProjectionMatrix();
  placeCamera(0, dt, true);
  if (k >= 1) {
    camTween = null;
    tw.onDone && tw.onDone();
  }
}

game.shakeCamera = (amp, dur) => {
  game.shaking = { t: 0, dur, amp };
};

/* --------------------------------------------------------------------------
   HEART — the further she is, the harder it beats
   ------------------------------------------------------------------------- */
let _heartSmooth = 0;

/* the torch drops to a polite glow whenever you are reading paper up close */
if (!game.flashTarget) game.flashTarget = 720;
function updateFlashDim(dt) {
  const t = game.flashTarget ?? 720;
  const cur = world.flashlightIntensity ?? 720;
  if (Math.abs(cur - t) > 0.5) {
    world.flashlightIntensity = cur + (t - cur) * Math.min(1, dt * 3.2);
  }
}

/* --------------------------------------------------------------------------
   HEART — driven by how far she is from you, and by how bad things are
   Being *left behind* is as frightening as being crowded: if she pulls away
   down the alley your pulse climbs; if she is breathing on your neck it
   climbs too. Only an empty, quiet alley lets it settle.
   -------------------------------------------------------------------------- */
function updateHeart(dt) {
  if (!audio.ready) return;
  const active = game.state === STATE.EXPLORE || game.state === STATE.FOLLOW
    || game.state === STATE.FREEZE || game.state === STATE.CHASE
    || game.state === STATE.DIALOGUE;
  if (!active) { audio.setHeart(0, 0); return; }

  let target = 62;                       // calm, resting
  let force = 0.12;

  if (maigo.root.visible) {
    const d = player.position.distanceTo(maigo.root.position);
    if (d > 4) {
      // she is getting away from you — the alley opens up behind her
      const k = THREE.MathUtils.clamp((d - 4) / 9, 0, 1);
      target = 76 + k * 58;              // 4 m → 76 bpm, 13 m → 134 bpm
      force = 0.25 + k * 0.55;
    } else {
      // she is inside arm's reach
      const k = THREE.MathUtils.clamp((4 - d) / 3, 0, 1);
      target = 76 + k * 52;              // 4 m → 76 bpm, 1 m → 128 bpm
      force = 0.25 + k * 0.6;
    }
  } else {
    // alone in the dark: a slow pulse that lifts with the dread
    target = 66 + world.dread * 30;
    force = 0.18 + world.dread * 0.28;
  }

  if (game.state === STATE.CHASE) { target = Math.max(target, 152); force = Math.max(force, 0.9); }
  if (game.state === STATE.FREEZE) { target = Math.max(target, 140); force = Math.max(force, 0.8); }
  if (game.state === STATE.DIALOGUE) { target = Math.max(target, 96); force = Math.max(force, 0.5); }

  _heartSmooth += (target - _heartSmooth) * Math.min(1, dt * 1.6);
  audio.setHeart(_heartSmooth, force);
}

/* --------------------------------------------------------------------------
   HANDHELD — a few millimetres of human tremor on top of the walk
   -------------------------------------------------------------------------- */
let _swayT = 0;
function handheldOffset(dt, walking) {
  _swayT += dt * (walking ? 1.35 : 0.55);
  const amp = walking ? 1 : 0.42;
  return {
    x: (Math.sin(_swayT * 1.13) * 0.011 + Math.sin(_swayT * 2.71) * 0.004) * amp,
    y: (Math.sin(_swayT * 1.77) * 0.009 + Math.sin(_swayT * 3.13) * 0.003) * amp,
    roll: (Math.sin(_swayT * 0.83) * 0.0035 + Math.sin(_swayT * 2.29) * 0.0012) * amp,
  };
}

function placeCamera(time, dt, tweening = false) {
  const cam = world.camera;
  const bobAmp = game.state === STATE.CHASE ? 0.045 : 0.026;
  const targetBob = player.speed > 0.2 ? Math.sin(player.bobPhase * 2) * bobAmp * Math.min(1, player.speed / 2.4) : 0;
  const targetSway = player.speed > 0.2 ? Math.cos(player.bobPhase) * bobAmp * 0.55 : 0;
  player.bobY = THREE.MathUtils.damp(player.bobY, targetBob, 10, dt);
  player.bobX = THREE.MathUtils.damp(player.bobX, targetSway, 10, dt);
  player.roll = THREE.MathUtils.damp(player.roll, targetSway * 0.14, 8, dt);

  let sx = 0, sy = 0, sr = 0;
  if (game.shaking) {
    game.shaking.t += dt;
    const k = 1 - game.shaking.t / game.shaking.dur;
    if (k <= 0) game.shaking = null;
    else {
      sx = (Math.random() - 0.5) * game.shaking.amp * k;
      sy = (Math.random() - 0.5) * game.shaking.amp * k;
      sr = (Math.random() - 0.5) * game.shaking.amp * k * 0.25;
    }
  }

  // a body, not a tripod: idle tremor and a slow breathing rise
  const walking = player.speed > 0.2;
  const hh = tweening ? { x: 0, y: 0, roll: 0 } : handheldOffset(dt, walking);
  const breath = tweening ? 0 : Math.sin(time * 1.15) * 0.0035;

  cam.position.set(
    player.position.x + player.bobX + hh.x,
    player.eye + player.bobY + hh.y + breath,
    player.position.z,
  );
  cam.rotation.set(player.pitch + sy, player.yaw + sx, player.roll + sr + hh.roll, 'YXZ');
  if (!tweening) {
    cam.rotation.z += Math.sin(time * 0.4) * 0.0006;
  }
}

/* --------------------------------------------------------------------------
   MOVEMENT / COLLISION  (manual input polling each frame)
   ------------------------------------------------------------------------- */
const colliders = [
  // vending machines (match world.buildVending z values)
  { minX: 1.62, maxX: 2.6, minZ: -16.12, maxZ: -14.88 },
  { minX: 1.62, maxX: 2.6, minZ: -62.62, maxZ: -61.38 },
  // crates
  { minX: 1.55, maxX: 2.35, minZ: -59.2, maxZ: -58.2 },
];
const poleCollider = { x: 2.22, z: -5.2, r: 0.42 };

function blocked(x, z) {
  if (x < -2.17 || x > 2.17) return true;
  if (z > 11.25 || z < -214) return true;
  for (const c of colliders) {
    if (x > c.minX - 0.26 && x < c.maxX + 0.26 && z > c.minZ - 0.26 && z < c.maxZ + 0.26) return true;
  }
  if (Math.hypot(x - poleCollider.x, z - poleCollider.z) < poleCollider.r) return true;
  return false;
}

function updateMovement(dt) {
  const canControl = game.controlsActive && gameplayState() && !camTween;
  const keys = game.input.keys;
  const wish = new THREE.Vector3();

  if (canControl) {
    const f = new THREE.Vector3(-Math.sin(player.yaw), 0, -Math.cos(player.yaw));
    const r = new THREE.Vector3(Math.cos(player.yaw), 0, -Math.sin(player.yaw));
    if (game.isMobile) {
      // analog: the stick's own vector, magnitude and all
      const j = game.input.joy;
      if (j.active) {
        wish.addScaledVector(f, j.y);
        wish.addScaledVector(r, j.x);
        if (wish.lengthSq() > 1) wish.normalize();
      }
    } else {
      if (keys.w) wish.add(f);
      if (keys.s) wish.sub(f);
      if (keys.d) wish.add(r);
      if (keys.a) wish.sub(r);
      if (wish.lengthSq() > 0) wish.normalize();
    }
  }

  const targetSpeed = (keys.shift ? 3.45 : 2.55) * (game.state === STATE.FREEZE ? 0.55 : 1);
  const desired = wish.multiplyScalar(targetSpeed);
  player.velocity.x = THREE.MathUtils.damp(player.velocity.x, desired.x, canControl ? 11 : 18, dt);
  player.velocity.z = THREE.MathUtils.damp(player.velocity.z, desired.z, canControl ? 11 : 18, dt);

  const dx = player.velocity.x * dt;
  const dz = player.velocity.z * dt;
  let moved = 0;

  // axis-separated validation against the world
  if (!blocked(player.position.x + dx, player.position.z)) { player.position.x += dx; moved += Math.abs(dx); }
  else player.velocity.x *= 0.2;
  if (!blocked(player.position.x, player.position.z + dz)) { player.position.z += dz; moved += Math.abs(dz); }
  else player.velocity.z *= 0.2;

  player.speed = dt > 0 ? moved / dt : 0;

  // head-bob phase only advances with actual ground movement
  if (player.speed > 0.1) {
    const prevPhase = player.bobPhase;
    player.bobPhase += dt * (4.2 + player.speed * 1.55);
    if (Math.floor(prevPhase / Math.PI) !== Math.floor(player.bobPhase / Math.PI)) {
      audio.footstep(Math.min(1, player.speed / 3.2), THREE.MathUtils.clamp((Math.random() - 0.5) * 0.25, -0.2, 0.2));
    }
  }
}

/* --------------------------------------------------------------------------
   CAMERA LOOK / DIALOGUE LOCK
   ------------------------------------------------------------------------- */
const _dir = new THREE.Vector3();
function updateCameraLook(dt, time) {
  if (camTween) return;

  if (game.state === STATE.DIALOGUE) {
    maigo.root.updateMatrixWorld(true);
    const target = maigo.headWorldPosition();
    // slow dolly-in, stopping 3.25 m from her
    if (game.dialogue?.goal) {
      player.position.x = THREE.MathUtils.damp(player.position.x, game.dialogue.goal.x, 2.0, dt);
      player.position.z = THREE.MathUtils.damp(player.position.z, game.dialogue.goal.z, 2.0, dt);
    }
    // lift the flashlight to her face (diegetic)
    if (world.flashlight && world.flashlightOn) {
      const local = new THREE.Vector3().copy(target);
      world.camera.updateMatrixWorld();
      local.y -= 0.02;
      local.applyMatrix4(new THREE.Matrix4().copy(world.camera.matrixWorld).invert());
      world.flashlight.target.position.copy(local);
    }
    _dir.copy(target).sub(world.camera.position).normalize();
    const desiredYaw = Math.atan2(-_dir.x, -_dir.z);
    const desiredPitch = Math.asin(THREE.MathUtils.clamp(_dir.y, -1, 1));
    let delta = ((desiredYaw - player.yaw + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
    player.yaw += delta * Math.min(1, dt * 4.2);
    player.pitch = THREE.MathUtils.damp(player.pitch, desiredPitch, 4.2, dt);
    world.camera.fov = THREE.MathUtils.damp(world.camera.fov, 42, 1.8, dt);
    world.camera.updateProjectionMatrix();
  } else if (game.state !== STATE.BOOT && game.state !== STATE.SELECT && game.state !== STATE.WIN && game.state !== STATE.LOSE) {
    world.camera.fov = THREE.MathUtils.damp(world.camera.fov, game.state === STATE.CHASE ? 68 : 62, 3.2, dt);
    world.camera.updateProjectionMatrix();
  }

  if (game.state === STATE.DIALOGUE) {
    // queasy handheld drift during the conversation
    world.camera.position.set(
      player.position.x + Math.sin(time * 0.7) * 0.006,
      player.eye + Math.sin(time * 1.1) * 0.008,
      player.position.z
    );
    world.camera.rotation.set(player.pitch, player.yaw, Math.sin(time * 0.55) * 0.003, 'YXZ');
  } else {
    placeCamera(time, dt);
  }
}

/* --------------------------------------------------------------------------
   FLOW: INTRO → BOARD → EXPLORE
   ------------------------------------------------------------------------- */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* --------------------------------------------------------------------------
   KEY LEGEND — the controls, held on screen for five seconds
   -------------------------------------------------------------------------- */
let _legendTimer = null;
let _legendSeq = 0;
function showKeyLegend(ms = 5000) {
  // a phone should be taught the stick, not the WASD keys
  const el = $(game.isMobile ? '#key-legend-m' : '#key-legend');
  if (!el) return;
  const seq = ++_legendSeq;
  if (_legendTimer) { clearTimeout(_legendTimer); _legendTimer = null; }
  el.classList.remove('hidden');
  // The display change must land before the fade, or the transition is skipped.
  // Arm on whichever comes first: a frame (normal) or a short timer (rAF can be
  // throttled to ~1 fps on software renderers, which would eat the 5 seconds).
  let armed = false;
  const arm = () => {
    if (armed || seq !== _legendSeq) return;
    armed = true;
    el.classList.add('show');
    // Start counting only once the fade has actually landed. On a software
    // renderer a frame can be three seconds away, and a legend that fades out
    // before it fades in is the same as no legend at all.
    let waited = 0;
    const startCountdown = () => {
      if (seq !== _legendSeq) return;
      _legendTimer = setTimeout(() => {
        el.classList.remove('show');
        setTimeout(() => { if (seq === _legendSeq) el.classList.add('hidden'); }, 1200);
      }, ms);
    };
    const waitVisible = () => {
      if (seq !== _legendSeq) return;
      const op = parseFloat(getComputedStyle(el).opacity) || 0;
      if (op >= 0.85 || waited >= 1400) { startCountdown(); return; }
      waited += 60;
      setTimeout(waitVisible, 60);
    };
    waitVisible();
  };
  requestAnimationFrame(() => requestAnimationFrame(arm));
  setTimeout(arm, 140);
}

async function enterAlley() {
  if (game.state !== STATE.BOOT) return;
  dom.enter.disabled = true;

  // the menu goes away at once; everything heavy happens behind the card
  dom.boot.classList.add('dissolve');
  setTimeout(() => { dom.boot.classList.add('hidden'); if (dom.boot.remove) dom.boot.remove(); }, 1100);

  // the title theme belongs to the menu — it fades as the card comes up
  audio.stopPianoLoop(1400);

  game.state = STATE.INTRO;
  // the avatar and its shaders load in the background; the card does NOT
  // wait for them, so a slow connection cannot stall the start
  loadAvatarAndPrewarm().catch(() => {});
  const card = showIntroCard();

  try { await Promise.race([audio.init(), sleep(2000)]); } catch (e) { /* audio optional */ }
  await card;

  $('#intro-card').classList.add('dissolve');
  setTimeout(() => $('#intro-card').classList.add('hidden'), 1200);

  dom.letterbox.classList.add('active');
  audio.clothRustle(0.4);
  audio.setDread(0.12);
  game.state = STATE.INTRO;

  tweenCamera({
    fromPos: world.camera.position.clone(),
    toPos: new THREE.Vector3(0, 1.72, 9.62),
    fromYaw: player.yaw, toYaw: Math.PI,
    fromPitch: player.pitch, toPitch: -0.01,
    fromFov: world.camera.fov, toFov: 46,
    dur: 3.2,
    onDone: () => {
      game.state = STATE.SELECT;
      showBoard();
    },
  });

  setTimeout(() => {
    if (game.state === STATE.INTRO) {
      game.state = STATE.SELECT;
      showBoard();
    }
  }, 4200);
}

/* --------------------------------------------------------------------------
   INTRO CARD
   Each paragraph appears and is spoken in Japanese; the next one waits for the
   voice to finish. Clicking anywhere abandons both the text and the narration
   immediately, so the card can never hold the player hostage.
   -------------------------------------------------------------------------- */
function showIntroCard() {
  const el = $('#intro-card');
  const lines = [...el.querySelectorAll('.ic-line')];
  el.classList.remove('hidden', 'dissolve');

  return new Promise((resolve) => {
    let done = false;
    let current = null;
    const timers = [];
    const wait = (ms) => new Promise((r) => {
      const id = setTimeout(r, ms);
      timers.push(id);
    });

    const finish = () => {
      if (done) return;
      done = true;
      timers.forEach(clearTimeout);
      el.removeEventListener('click', finish);
      audio.stopNarration();
      audio.stopIntroBed(1600);       // the card is where the music ends
      audio.stopPianoLoop(1400);
      resolve();
    };
    el.addEventListener('click', finish);

    // The bed for this card: the CC0 piano from archive.org/details/piano_tune,
    // far under the narration. (The Pixabay track is behind Cloudflare — 403.)
    audio.stopPianoLoop(700);        // the menu theme belongs to the menu
    audio.startIntroBed(0.17, 3200);

    (async () => {
      // the three spoken paragraphs and how many lines follow each
      const beats = [
        { speak: 'intro_1', span: [1, 2] },
        { speak: 'intro_2', span: [3, 4] },
        { speak: 'intro_3', span: [5, 6] },
      ];

      lines[0].classList.add('on');            // the kicker
      await wait(700);
      if (done) return;

      for (const beat of beats) {
        if (done) return;
        for (const i of beat.span) {
          if (lines[i]) lines[i].classList.add('on');
          await wait(240);
          if (done) return;
        }
        // speech is fetched on demand; if it is missing we just hold the beat
        const dur = await audio.loadVoiceLine(beat.speak);
        if (done) return;
        if (dur > 0) {
          current = audio.playNarration(beat.speak);
          await wait((dur + 0.30) * 1000);
        } else {
          await wait(2600);
        }
      }
      void current;
      if (!done) finish();
    })();
  });
}

/* --------------------------------------------------------------------------
   AVATAR + PREWARM — all of the cost, none of it visible
   -------------------------------------------------------------------------- */
let _assetsPromise = null;
let _avatarRetrying = false;
async function retryAvatar() {
  if (_avatarRetrying) return;
  _avatarRetrying = true;
  window.__avatarError = null;
  try { ui.toast('… 再試行中 / retrying avatar', 2600); } catch (e) { /* no ui */ }
  _assetsPromise = null;
  try { await loadAvatarAndPrewarm(); } catch (e) { /* reported below */ }
  _avatarRetrying = false;
  try {
    ui.toast(maigo.isVRM ? '✓ アバター復帰 / avatar restored' : '⚠ まだ失敗 / still failing — check the connection',
             maigo.isVRM ? 2600 : 6000);
  } catch (e) { /* no ui */ }
}
window.__retryAvatar = retryAvatar;

function loadAvatarAndPrewarm() {
  if (_assetsPromise) return _assetsPromise;
  _assetsPromise = (async () => {
    // The alley is warmed immediately, in parallel with the download. Waiting
    // for 10.8 MB before compiling shaders meant a slow connection stalled the
    // board -> alley transition completely.
    const alley = (async () => {
      try { await Promise.race([prewarm(), sleep(8000)]); } catch (err) { /* best effort */ }
    })();
    const avatar = (async () => {
      const tries = [MODEL_URLS.maigo, MODEL_URLS.maigoFull].filter(Boolean);
      let ok = false;
      const stale = !!window.__avatarError;      // a previous attempt already failed
      for (const url of tries) {
        try { ok = await maigo.load(url, stale); } catch (err) { console.warn('[Maigo] avatar load failed:', err); }
        if (ok) break;
      }
      // the real model is what the player came to see: do not give up on one
      // bad packet. Two spaced retries before the stand-in is even considered.
      for (let i = 0; i < 2 && !ok; i++) {
        await sleep(2200 * (i + 1));
        try { ok = await maigo.load(tries[0], true); } catch (err) { /* try again */ }
      }
      if (!ok) {
        window.__avatarError = window.__avatarError || 'avatar could not be downloaded';
        try { maigo.useFallback(); } catch (e) { console.warn('[Maigo] fallback failed:', e); }
        try { ui.toast('⚠ アバターを読み込めません / avatar failed to load', 9000); } catch (e) { /* no ui yet */ }
        _assetsPromise = null;          // let a later attempt try again
      }
      // second pass: her own materials, which the first pass could not see
      try { await Promise.race([prewarm(), sleep(8000)]); } catch (err) { /* best effort */ }
    })();
    try {
      // decode her lines (and the four replies) up front: a reply that loses a
      // race with its own fetch would fall back to the synth voice
      await Promise.race([audio.preloadVoice(), sleep(6000)]);
    } catch (err) { /* best effort */ }
    await Promise.all([alley, avatar]);
    return true;
  })();
  return _assetsPromise;
}

const POSTER_INFO = {
  [CLASS.STUDENT]: {
    jp: '高橋 美咲',
    en: '(17) · High School Student',
    traits: 'Last seen: <b>22:40</b> near 2-chome alley · 女子高生 · <em>Ability: Candy pacifies Maigo.</em>',
  },
  [CLASS.ADULT]: {
    jp: '佐藤 健二',
    en: '(34) · Adult Office Worker',
    traits: 'Last seen: <b>23:15</b> · 会社員 · <em>No candy allowed — trap detection.</em> Must use psychological protocols.',
  },
};

/** the identity you are standing in front of — read from the world, not a menu */
let boardHover = null;
let _boardAim = 'mouse';   // a keyboard choice must not be overridden by a stale cursor
const _ray = new THREE.Raycaster();
const _ndc = new THREE.Vector2(0, 0);

function setBoardHover(cls) {
  if (cls === boardHover) return;
  boardHover = cls;
  world.setPosterHover(cls === CLASS.STUDENT ? 'student' : cls === CLASS.ADULT ? 'adult' : null);
  if (!cls) return;
  const info = POSTER_INFO[cls];
  dom.lookNameJp.textContent = info.jp;
  dom.lookNameEn.textContent = info.en;
  dom.lookTraits.innerHTML = info.traits;
  if (audio.tick) audio.tick(0.05);
}

/** cast from the pointer (or the centre of the screen) into the board */
function updateBoardAim() {
  if (game.state !== STATE.SELECT) return;
  if (!world.boardMesh) return;
  _ray.setFromCamera(_ndc, world.camera);
  const hit = _ray.intersectObject(world.boardMesh, false)[0];
  if (!hit || !hit.uv) { setBoardHover(null); return; }
  // either half of the board belongs to one of the two posters
  setBoardHover(hit.uv.x < 0.5 ? CLASS.STUDENT : CLASS.ADULT);
}

function showBoard() {
  // release the mouse: you are pointing at posters, not steering
  if (document.pointerLockElement) document.exitPointerLock();
  dom.chapterCard && dom.chapterCard.classList.add('hidden');
  dom.board.classList.remove('hidden');
  dom.board.style.animation = 'fadeIn .7s ease both';
  ui.hideSubtitle();
  ui.showChoices(false);
  ui.setPrompt(null);
  ui.showHUD && ui.hideHUD();
  dom.letterbox.classList.add('active');
  game.flashTarget = 38;          // torch lowered: the board is the only light
  world.flashlightIntensity = 38;  // snap, so the board is readable at once
  setBoardHover(CLASS.STUDENT);
}

function selectClass(cls) {
  if (game.state !== STATE.SELECT || game.selected) return;
  game.selected = true;
  game.classType = cls;
  ui.setClass(cls);
  audio.clothRustle(0.55);
  requestLook();
  // hold the glow on the chosen poster for a beat, then release the world
  world.setPosterHover(cls === CLASS.STUDENT ? 'student' : 'adult');
  dom.board.classList.add('hidden');
  if (audio.stopIntroBed) audio.stopIntroBed(600);
  showKeyLegend(5000);          // the controls, exactly five seconds from the choice
  audio.stopPianoLoop(3200);
  audio.pianoStop();

  // the camera drops back to human eye-level and turns down the alley
  tweenCamera({
    fromPos: new THREE.Vector3(0, 1.72, 9.62),
    toPos: new THREE.Vector3(0, 1.68, 9.0),
    fromYaw: Math.PI, toYaw: 0,
    fromPitch: -0.01, toPitch: 0.0,
    fromFov: 46, toFov: 62,
    dur: 2.6,
    onDone: () => {
      player.position.set(0, 0, 9.0);
      player.eye = 1.68;
      dom.letterbox.classList.remove('active');
      ui.showHUD();
      game.controlsActive = true;
      game.flashTarget = 720;
      world.flashlightIntensity = 720;
      mechanics.startExplore();
      ui.setTorch(world.flashlightOn);
      ui.chapter('第一章　夜の路地', 'CHAPTER ONE — THE NIGHT ALLEY');
      audio.setDread(0.15);
    },
  });
}

/* --------------------------------------------------------------------------
   MANIFESTATION + DIALOGUE
   ------------------------------------------------------------------------- */
game.triggerManifestation = async function triggerManifestation() {
  if (game.state !== STATE.EXPLORE) return;
  try {
    // She has to exist before the lights go out. If the avatar is still
    // downloading, wait for it (a slow beat in the dark reads as tension);
    // if it cannot arrive, put the sculpted stand-in on stage rather than
    // playing the whole scene at an empty patch of alley.
    if (!maigo.ready) {
      // Hold the beat for the avatar rather than swapping in the stand-in:
      // a player who waited twenty seconds for her is not served by a
      // placeholder. Only a genuine failure earns the fallback.
      await Promise.race([loadAvatarAndPrewarm(), sleep(20000)]);
      if (!maigo.ready) {
        try { maigo.useFallback(); } catch (err) { console.warn('[Maigo] no avatar at all:', err); }
      }
      if (game.state !== STATE.EXPLORE) return;
    }
  game.state = STATE.DIALOGUE;
  game.controlsActive = false;
  ui.setPrompt(null);
  ui.hideHUD();
  dom.letterbox.classList.add('active');
  ui.setBackAlert(false, 0);
  ui.setFreeze(false, 0);

  // 1. kill the city instantly
  audio.setAmbientMute(true, true);
  audio.stinger();
  world.setPinkFog(true);
  world.setDread(0.72);
  world.setMaigoLight(34);
  world.maigo = maigo;

  // 2. spawn her exactly 8 m ahead, facing the player
  const fwd = new THREE.Vector3(-Math.sin(player.yaw), 0, -Math.cos(player.yaw));
  if (fwd.z > -0.2) fwd.set(0, 0, -1);   // never spawn behind the player
  const spawn = player.position.clone().addScaledVector(fwd, 8);
  spawn.y = 0;
  spawn.x = THREE.MathUtils.clamp(spawn.x, -1.55, 1.55);
  spawn.z = THREE.MathUtils.clamp(spawn.z, -205, 10.4);
  // face the player squarely
  maigo.show(spawn, new THREE.Vector3(player.position.x, 1.2, player.position.z));
  maigo.root.rotation.y = maigo.yawToward(new THREE.Vector3(player.position.x, 1.2, player.position.z));
  maigo.setMode('idle');

  // 3. the camera is drawn toward her while the torch lifts to her face
  player.eye = 1.68;
  const goal = spawn.clone().addScaledVector(fwd, -2.35);
  goal.x = THREE.MathUtils.clamp(goal.x, -1.4, 1.4);
  goal.y = 0;
  game.dialogue = { startedAt: performance.now(), target: 'head', goal, base: player.position.clone() };
  world.flashlightScale = 0.085; // the beam is 2.3 m from her face
  world.camera.fov = 48;

  // 4. let the pink fog crawl, then speak
  await sleep(900);
  if (game.state !== STATE.DIALOGUE) return;
  const vocative = game.classType === CLASS.ADULT ? 'ojisan' : 'oneesan';
  ui.showSubtitle(vocative);
  const duration = audio.speakQuestion(vocative);
  if (maigo.speak) maigo.speak(duration || 4);
  audio.setDread(0.5);
  // 5. choices fade in while she is still asking
  setTimeout(() => {
    if (game.state === STATE.DIALOGUE) ui.showChoices(true);
  }, 1500);
  setTimeout(() => {
    if (game.state === STATE.DIALOGUE) ui.showChoices(true);
  }, Math.max(2200, Math.min(5200, duration * 700)));
  } catch (err) {
    // A cutscene that throws must never leave the player without controls:
    // that reads as a hard freeze, which is exactly what this guard is for.
    console.error('[manifestation]', err);
    if (game.state === STATE.DIALOGUE) {
      game.state = STATE.EXPLORE;
      game.controlsActive = true;
      dom.letterbox.classList.remove('active');
      ui.showChoices(false);
      ui.hideSubtitle();
      ui.showHUD();
    }
  }
};

const domChoices = { answered: false };
function answer(choice) {
  if (game.state !== STATE.DIALOGUE || domChoices.answered) return;
  domChoices.answered = true;
  game.flags.answered = true;
  ui.showChoices(false);
  // she stops talking the instant you answer. Her question is seven seconds
  // long and the choices appear after 1.5 s, so without this cut your own
  // reply played underneath her voice and was never heard.
  audio.cutVoice(0.14);
  const who = game.classType === CLASS.ADULT ? 'adult' : 'student';
  setTimeout(() => ui.showPlayerLine(choice === 'yes' ? 'yes' : 'no', who), 90);
  setTimeout(() => audio.speakReply(choice === 'yes' ? 'yes' : 'no', who), 260);
  setTimeout(() => { if (game.state === STATE.DIALOGUE) ui.hideSubtitle(); }, 3600);
  if (choice === 'no') {
    maigo.attackPose();
    maigo.face(new THREE.Vector3(player.position.x, 1.2, player.position.z));
    game.shakeCamera(0.19, 0.5);
    audio.clothRustle(1.2);
    setTimeout(() => {
      lose('SHE WAS SO CLOSE.', 'You said no. She had already decided you would help.', 'Say yes. The alley does not let you leave.');
    }, 240);
    return;
  }
  acceptMaigo();
}

async function acceptMaigo() {
  if (game.state !== STATE.DIALOGUE) return;
  // the same guarantee as the manifestation: never walk an empty alley
  if (!maigo.ready) {
    await Promise.race([loadAvatarAndPrewarm(), sleep(2500)]);
    if (!maigo.ready) { try { maigo.useFallback(); } catch (e) { /* nothing left */ } }
    if (game.state !== STATE.DIALOGUE) return;
  }
  requestLook();
  audio.clothRustle(1.0);
  ui.toast('彼女は、先を行く。 / She walks ahead.', 2600);
  await maigo.turnAround(1.25);
  if (game.state !== STATE.DIALOGUE) return;

  // the torch cuts out the moment she turns her back
  if (world.flashlight) world.flashlight.target.position.set(0.02, -1.15, -5.6);
  world.flashlightScale = 1;
  world.setFlashlight(false);
  ui.setTorch(false);
  audio.tick(0.05);

  maigo.setMode('walk');
  player.eye = 1.68;
  game.state = STATE.FOLLOW;
  game.controlsActive = true;
  dom.letterbox.classList.remove('active');
  ui.showHUD();
  ui.setObjective('彼女の家まで。', 'Follow her. Do not light her back.');
  game.mechanics.startFollow();
  audio.setAmbientMute(false, false);
  audio.setDread(0.35);
  world.setPinkFog(false);
  domChoices.answered = false;
}

/* --------------------------------------------------------------------------
   LOSE / WIN
   -------------------------------------------------------------------------- */
let lost = false;
function lose(title, reason, tip) {
  if (lost || game.state === STATE.WIN) return;
  lost = true;
  game.state = STATE.LOSE;
  game.controlsActive = false;
  game.dialogue = null;
  domChoices.answered = false;
  if (document.pointerLockElement) document.exitPointerLock();
  ui.hideSubtitle();
  ui.showChoices(false);
  ui.hideHUD();
  ui.setPrompt(null);
  ui.setFreeze(false, 0);
  ui.setBackAlert(false, 0);
  dom.pause.classList.add('hidden');
  dom.letterbox.classList.remove('active');

  if (world.flashlight) world.flashlight.target.position.set(0.02, -1.15, -5.6);
  world.flashlightScale = 1;
  // her model lunges in the same frame
  try {
    maigo.attackPose();
    maigo.face(new THREE.Vector3(player.position.x, 1.2, player.position.z));
    maigo.root.position.set(
      player.position.x - Math.sin(player.yaw) * 0.9,
      0,
      player.position.z - Math.cos(player.yaw) * 0.9
    );
  } catch (e) { /* noop */ }

  // exact millisecond chain: face + blood + scream + sub drop
  game.inputLocked = true;          // no look, no walk, no escape
  if (game.input && game.input.keys) {
    for (const k in game.input.keys) game.input.keys[k] = false;
  }
  audio.slam();
  ui.jumpscare();
  if (dom.goKicker) dom.goKicker.textContent = title || '';
  game.shakeCamera(0.3, 0.6);

  setTimeout(() => {
    ui.hideJumpscare();
    ui.gameOver(reason || 'SHE FOUND YOU.', tip || '');
  }, 1750);
  setTimeout(() => {
    dom.goReason && (dom.goReason.textContent = reason || 'SHE FOUND YOU.');
  }, 1800);
  ui.setObjective(title, '');
}

game.lose = (title, reason, tip) => lose(title, reason, tip);

let won = false;
game.win = function win(kind) {
  if (won || game.state === STATE.LOSE) return;
  won = true;
  game.state = STATE.WIN;
  game.controlsActive = false;
  if (document.pointerLockElement) document.exitPointerLock();
  ui.hideSubtitle();
  ui.showChoices(false);
  ui.hideHUD();
  ui.setPrompt(null);
  ui.setFreeze(false, 0);
  ui.setBackAlert(false, 0);
  dom.letterbox.classList.remove('active');
  game.mechanics.setChaseMeter?.(-1);
  ui.setChaseMeter(-1);
  audio.fadeOut(3.2);
  world.setDread(0);
  if (kind === 'safe-return') world.setPinkFog(false);     // the fog lets go
  maigo.face(new THREE.Vector3(player.position.x, 1.2, player.position.z));
  maigo.setMode('idle');

  // a scripted wash in front of the ending card: dawn for the candy route,
  // a hard blackout for the vehicle. DOM only — the renderer is untouched.
  const wash = kind === 'safe-return' ? 'dawn' : (kind === 'awakening' ? 'black' : null);
  if (wash && dom.victoryWash) {
    dom.victoryWash.className = wash;
    void dom.victoryWash.offsetWidth;
    dom.victoryWash.classList.add('on');
  }
  setTimeout(() => ui.ending(kind, game.classType), wash ? 2500 : 700);
};

/* --------------------------------------------------------------------------
   PREWARM — compile every program (with and without her in the scene)
   -------------------------------------------------------------------------- */
let _prewarmReport = null;
async function prewarm() {
  const r = world.renderer;
  const cam = world.camera;
  const saved = {
    pos: cam.position.clone(), quat: cam.quaternion.clone(), fov: cam.fov,
    vis: maigo.root.visible, px: maigo.root.position.clone(),
  };
  const restore = () => {
    cam.position.copy(saved.pos); cam.quaternion.copy(saved.quat);
    cam.fov = saved.fov; cam.updateProjectionMatrix();
    maigo.root.visible = saved.vis;
    maigo.root.position.copy(saved.px);
  };

  try {
    // put her in frame, in front of the camera, and draw one frame
    maigo.root.position.set(0, 0, 4.0);
    maigo.root.visible = true;
    cam.position.set(0, 1.68, 10.2);
    cam.lookAt(0, 1.15, 4.0);
    cam.updateMatrixWorld(true);
    r.compile(world.scene, cam);
    world.composer.render();          // warms the post chain too
    await new Promise((res) => setTimeout(res, 0));

    // and one without her, because that light count is a different program
    maigo.root.visible = false;
    r.compile(world.scene, cam);
    world.composer.render();
    await new Promise((res) => setTimeout(res, 0));

    _prewarmReport = { programs: r.info.programs.length };
  } catch (err) {
    console.warn('[Prewarm] skipped:', err);
  } finally {
    restore();
  }
}

/* --------------------------------------------------------------------------
   BOOT
   -------------------------------------------------------------------------- */
async function boot() {
  try {
    await bootInner();
  } catch (err) {
    console.error('[Boot]', err);
    if (window.__maigoFail) window.__maigoFail(err && err.message ? err.message : String(err));
  }
}

async function bootInner() {
  dom.loadStatus.textContent = 'GENERATING WET ASPHALT…';
  audio.preparePianoLoop && audio.preparePianoLoop();
  audio.prepareIntroBed && audio.prepareIntroBed();
  audio.preloadSlam && audio.preloadSlam();      // decode the scream before it is needed
  dom.jumpscareImg.decoding = 'sync';
  dom.jumpscareImg.onerror = () => {
    dom.jumpscareImg.onerror = null;
    dom.jumpscareImg.src = TEX.horrorFace;   // the wide original, if the file is missing
  };
  dom.jumpscareImg.src = './assets/scare_face.jpg';
  ui.setTorch(true);
  ui.setCandy(0);

  try {
    const _t0 = performance.now();
    await world.build((p, label) => {
      dom.loadStatus.textContent = `${label} — ${Math.round(p * 100)}%`;
    });
    window.__maigoDebug.buildMs = Math.round(performance.now() - _t0);
  } catch (err) {
    console.error(err);
    if (window.__maigoFail) window.__maigoFail('WebGL initialisation failed — ' + (err.message || err));
    return;
  }

  // ---- prewarm -----------------------------------------------------------
  // Her two point lights change the scene's light count, which forces every
  // material in the alley to recompile. Doing that behind the title screen
  // is the difference between a smooth cut and a two-second freeze.
  // The avatar and the shader prewarm now happen behind the intro card, so
  // the title screen is ready as soon as the alley itself exists.
  dom.loadStatus.textContent = 'PREPARING THE ALLEY…';
  await new Promise((res) => setTimeout(res, 0));

  dom.enter.disabled = false;
  window.__maigoReady = true;
  // start the 10.8 MB avatar while the menu is still on screen: every second
  // it gets here is a second it does not spend missing from the alley
  if (MODEL_URLS.maigo) maigo.load(MODEL_URLS.maigo).catch(() => {});
  dom.loadStatus.textContent = 'READY — HEADPHONES ON · CLICK TO BEGIN';
  window.addEventListener('resize', () => world.resize(), { passive: true });
  world.resize();

  dom.enter.addEventListener('click', enterAlley);
  dom.choiceYes.addEventListener('click', () => answer('yes'));
  dom.choiceNo.addEventListener('click', () => answer('no'));
  dom.retry.addEventListener('click', () => location.reload());
  dom.again.addEventListener('click', () => location.reload());

  // development shortcuts (?stage=board|explore|dialogue|follow|chase)
  const stage = new URLSearchParams(location.search).get('stage');
  if (stage) {
    await loadAvatarAndPrewarm();     // dev shortcuts skip the intro card
    dom.boot.classList.add('hidden');
    dom.letterbox.classList.remove('active');
    ui.showHUD();
    ui.setTorch(true);
    player.eye = 1.68;
    player.position.set(0, 0, 6);
    player.yaw = 0;
    player.pitch = 0;
    game.state = STATE.EXPLORE;
    game.controlsActive = true;
    ui.chapter('第一章　夜の路地', 'CHAPTER ONE — THE NIGHT ALLEY');
    if (stage === 'board') {
      ui.hideHUD();
      game.state = STATE.SELECT;
      game.classType = CLASS.STUDENT;
      player.position.set(0, 0, 9.62);
      player.eye = 1.72;
      player.yaw = Math.PI;
      player.pitch = -0.01;
      world.camera.fov = 46;
      world.camera.updateProjectionMatrix();
      showBoard();
    } else if (stage === 'dialogue') {
      game.classType = CLASS.STUDENT;
      player.position.set(0, 0, 6);
      player.eye = 1.68;
      game.state = STATE.EXPLORE;
      game.triggerManifestation();
    } else if (stage === 'follow' || stage === 'chase') {
      game.classType = stage === 'chase' ? CLASS.ADULT : CLASS.STUDENT;
      ui.setClass(game.classType);
      const mz = player.position.z - 4.3;
      maigo.show(new THREE.Vector3(0, 0, mz), new THREE.Vector3(0, 1.2, player.position.z));
      maigo.root.rotation.y = Math.PI;
      maigo.setMode('walk');
      world.setFlashlight(false);
      ui.setTorch(false);
      game.state = STATE.FOLLOW;
      mechanics.startFollow();
      if (stage === 'chase') {
        mechanics.protocols[1] = true;
        ui.setProtocols({ used: mechanics.protocols, door: false, classType: CLASS.ADULT });
        mechanics.beginChase();
      }
    }
  }

  window.__dev = { game, world, maigo, mechanics, ui, audio, enterAlley, selectClass, acceptMaigo, answer, lose, win: game.win };

  // ?debug=1 — a readout for when the screen is dark and nothing is thrown
  if (new URLSearchParams(location.search).has('debug')) {
    const box = document.createElement('div');
    box.style.cssText = 'position:fixed;left:10px;bottom:10px;z-index:9999;padding:8px 10px;' +
      'background:rgba(0,0,0,.72);border:1px solid rgba(255,255,255,.16);color:#9fe8b0;' +
      'font:10px/1.5 ui-monospace,monospace;white-space:pre;pointer-events:none';
    document.body.appendChild(box);
    setInterval(() => {
      const r = world.renderer;
      const c = world.camera;
      box.textContent =
        `state ${game.state}  fps ${(window.__maigoDebug.fps || 0).toFixed(0)}\n` +
        `cam ${c.position.x.toFixed(1)},${c.position.y.toFixed(1)},${c.position.z.toFixed(1)} fov ${c.fov.toFixed(0)}\n` +
        `calls ${r.info.render.calls} tris ${r.info.render.triangles} prog ${r.info.programs.length}\n` +
        `lost ${r.getContext().isContextLost()}  torch ${Math.round(world.flashlightIntensity)}\n` +
        `avatar ${maigo.isVRM ? 'vrm' : (maigo.ready ? 'sculpt' : 'loading')}  vis ${maigo.root.visible ? 1 : 0}\n` +
        `err ${(window.__bootError || '—').slice(0, 42)}`;
    }, 500);
  }

  // a lost WebGL context is a black screen with no explanation — say so
  dom.canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    window.__maigoFail('the GPU dropped the WebGL context — click to reload');
    document.body.addEventListener('click', () => location.reload(), { once: true });
  }, false);
  dom.canvas.addEventListener('webglcontextrestored', () => location.reload(), false);

  // any later gesture can resume a suspended context
  window.addEventListener('pointerdown', () => {
    if (audio.ctx && audio.ctx.state === 'suspended') audio.ctx.resume();
  });

  /* ------------------------------------------------------------------
     Title music. Browsers refuse to make sound before a gesture, so the
     first click / key press anywhere on the screen starts the rain and the
     piano — the menu is scored from that moment on, not only after ENTER.
     ------------------------------------------------------------------ */
  let _titleMusicArmed = false;
  const startTitleMusic = async () => {
    if (_titleMusicArmed) return;
    if (game.state !== STATE.BOOT) return;   // the theme is the menu's, nothing else
    _titleMusicArmed = true;
    try { audio.startPianoLoop(0.40); } catch (err) { /* the file may still be fetching */ }
    try { await Promise.race([audio.init(), new Promise((r) => setTimeout(r, 2500))]); } catch (err) { return; }
    if (audio.ctx && audio.ctx.state === 'suspended') {
      try { await audio.ctx.resume(); } catch (err) { /* still locked */ }
    }
    if (audio.ctx && audio.ctx.state === 'running') {
      audio.setDread(0.08);
      audio.startPianoLoop(0.42);
    } else {
      _titleMusicArmed = false;      // try again on the next gesture
    }
  };
  const retryTitleMusic = () => {
    const el = audio._pianoEl;
    if (!el || !el.paused) return;
    if (game.state !== STATE.BOOT) return;
    audio._pianoNeedsGesture = false;
    audio.startPianoLoop(0.40);
  };
  window.addEventListener('pointerdown', retryTitleMusic, { passive: true });
  window.addEventListener('pointerdown', startTitleMusic, { passive: true });
  window.addEventListener('keydown', startTitleMusic);
  window.addEventListener('touchstart', startTitleMusic, { passive: true });

  // clicking the poster you are standing in front of selects that identity
  dom.canvas.addEventListener('pointerdown', (e) => {
    if (game.state !== STATE.SELECT) return;
    _boardAim = 'mouse';
    const r = dom.canvas.getBoundingClientRect();
    _ndc.x = ((e.clientX - r.left) / r.width) * 2 - 1;
    _ndc.y = -((e.clientY - r.top) / r.height) * 2 + 1;
    updateBoardAim();
    if (boardHover) selectClass(boardHover);
  });

  requestAnimationFrame(animate);

  // the vending machine hum follows the player every frame
  setInterval(() => {
    if (!audio.ready || !world.vending.length) return;
    let d = Infinity;
    for (const v of world.vending) {
      const dist = Math.hypot(player.position.x - 2.1, player.position.z - v.z);
      d = Math.min(d, dist);
    }
    audio.setVendingProximity(d);
  }, 300);
}

/* --------------------------------------------------------------------------
   FRAME LOOP
   -------------------------------------------------------------------------- */
const clock = new THREE.Clock();
let elapsed = 0;

let _fpsAccum = 0, _fpsFrames = 0;
let _lastRender = 0;
/* frame-rate governor: keeps the 60 fps target on weaker GPUs by trading resolution,
   then shadow resolution. Never fires on a healthy machine. */
const perf = { acc: 0, frames: 0, scale: world.renderer.getPixelRatio(), low: 0, timer: 0 };
function governPerformance(rawDt) {
  if (world.minQuality) return;
  perf.acc += rawDt; perf.frames++; perf.timer += rawDt;
  if (perf.timer < 2.4) return;
  const fps = perf.frames / perf.acc;
  perf.acc = 0; perf.frames = 0; perf.timer = 0;
  if (fps < 13 && !world.minQuality) {
    world.degradeToMin();
    return;
  }
  if (fps < 46 && perf.scale > 0.7) {
    perf.scale = Math.max(0.7, perf.scale - 0.12);
    world.setRenderScale(perf.scale);
    perf.low++;
  } else if (fps < 34) {
    perf.low++;
  } else if (fps > 57) {
    perf.low = 0;
    if (perf.scale < Math.min(window.devicePixelRatio || 1, 1.6)) {
      perf.scale = Math.min(perf.scale + 0.06, Math.min(window.devicePixelRatio || 1, 1.6));
      world.setRenderScale(perf.scale);
    }
  }
  if (perf.low >= 2 && world.flashlight && world.flashlight.castShadow) {
    world.flashlight.castShadow = false;
    world.renderer.shadowMap.needsUpdate = true;
  }
}

let _frameErrors = 0;
function animate() {
  requestAnimationFrame(animate);
  try {
    frame();
  } catch (err) {
    // a single bad frame must never kill the game: report it once, keep going
    _frameErrors++;
    if (_frameErrors === 1) {
      window.__maigoFatal = (err && err.stack) || String(err);
      console.error('[frame]', err);
      if (window.__maigoFail) {
        window.__maigoFail('render error — ' + (err && err.message ? err.message : err), 'CLICK TO RELOAD');
        document.body.addEventListener('click', () => location.reload(), { once: true });
      }
    }
  }
}

function frame() {
  const rawDt = clock.getDelta();
  const dt = Math.min(rawDt, 0.1);
  governPerformance(rawDt);
  _fpsAccum += dt; _fpsFrames++;
  if (_fpsAccum > 1) { window.__maigoDebug.fps = _fpsFrames / _fpsAccum; _fpsAccum = 0; _fpsFrames = 0; }
  window.__maigoDebug.frames++;
  elapsed += dt;
  const time = elapsed;

  // the title screen is a slow drift down the alley, not a still image
  if (game.state === STATE.BOOT) {
    player.position.z = 7.4 + Math.sin(time * 0.055) * 0.55;
    player.eye = 1.62;
    player.yaw = -0.10 + Math.sin(time * 0.041) * 0.075;
    player.pitch = -0.045 + Math.sin(time * 0.031) * 0.018;
  }

  // camera tweens follow wall-clock time so a hitch cannot stall the cinematic
  if (camTween) updateCamTween(Math.min(rawDt, 0.5));
  else if (game.state !== STATE.LOSE && game.state !== STATE.WIN) updateMovement(dt);

  updateCameraLook(dt, time);

  maigo.update(dt, time);
  mechanics.update(dt, time);
  updateHeart(dt);
  updateFlashDim(dt);
  if (game.state === STATE.SELECT && _boardAim === 'mouse') updateBoardAim();
  syncMobile();
  audio.update(dt);
  world.update(dt, time, game);

  // free ambient dread floor in exploration
  if (game.state === STATE.EXPLORE) audio.setDread(0.12);

  // while a full-screen DOM panel is up the alley is just a backdrop:
  // render it at ~12 fps instead of burning the GPU behind the board
  const boardUp = game.state === STATE.INTRO || game.state === STATE.SELECT
    || game.state === STATE.LOSE || game.state === STATE.WIN || game.state === STATE.PAUSED;
  const nowMs = performance.now();
  if (!boardUp || nowMs - _lastRender > 84) {
    world.render();
    _lastRender = nowMs;
  }
}

boot();
