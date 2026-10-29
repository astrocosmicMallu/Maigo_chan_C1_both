/* ============================================================================
   main.js — MAIGO-CHAN master state engine
   ----------------------------------------------------------------------------
   Boot → cinematic wall zoom → missing-persons selection → alley exploration
   → sudden manifestation & dialogue → follow / freeze / chase → end.
   Manual WASD polling, mouse look, head-bob gait, camera tweens and all UI.
   ========================================================================== */
import * as THREE from 'three';
import { World, MODEL_URLS } from './world.js?v=b89';
import { Maigo } from './maigo.js?v=b89';
import { AudioEngine } from './audio.js?v=b89';
import { Mechanics, STATE, CLASS } from './mechanics.js?v=b89';
import { TEX } from './assets.js?v=b89';
import { ViewportRig } from './rig.js?v=b89';

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
  batteryChip: $('#battery-chip'),
  candyChip: $('#candy-chip'),
  candyVal: $('#candy-chip .val'),
  blanketChip: $('#blanket-chip'),
  blanketVal: $('#blanket-chip .val'),
  pathTag: $('#path-tag'),
  shadowTrap: $('#shadow-trap'),
  shadowBar: $('#shadow-trap .trap-bar i'),
  victoryWash: $('#victory-wash'),
  loopWash: $('#loop-wash'),
  loopNote: $('#loop-note'),
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
/* what the player is carrying is drawn over the finished frame, in its own
   corner-anchored scene, so it cannot clip through the alley */
const rig = new ViewportRig(world.renderer, world.scene.environment);
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
  difficulty: 'professional', // floor tag chosen on the wall at the board
  battery: 1,                // 0..1 · meaningful on Nightmare and Hell only
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
  setDifficulty(key) {
    if (world.setDifficultyTag) world.setDifficultyTag(key);
    const d = DIFFICULTY_NAMES[key];
    const chip = $('#difficulty-chip');
    if (chip && d) {
      const txt = `難易度 <b>${d.jp}</b> ${d.en}`;
      if (chip.innerHTML !== txt) chip.innerHTML = txt;
    }
    for (const b of document.querySelectorAll('#df-mobile .df-m')) {
      const on = b.dataset.diff === key;
      if (b.classList.contains('on') !== on) {
        b.classList.toggle('on', on);
        b.setAttribute('aria-checked', on ? 'true' : 'false');
      }
    }
  },
  setClass(cls) {
    dom.classChip.textContent = cls === CLASS.STUDENT ? '女子高生 / STUDENT' : '会社員 / SALARYMAN';
    document.body.classList.toggle('adult', cls === CLASS.ADULT);
  },
  setPrompt(p) {
    if (!p) {
      if (!dom.prompt.classList.contains('hidden')) dom.prompt.classList.add('hidden');
      this._promptSig = '';
      return;
    }
    const sig = p.key + '|' + p.text;
    if (sig === this._promptSig) return;      // unchanged: no DOM write at all
    this._promptSig = sig;
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
    const step = Math.round(THREE.MathUtils.clamp(progress, 0, 1) * 20) / 20;
    if (this._freezeSig === on + '|' + step) return;
    this._freezeSig = on + '|' + step;
    dom.freezeAlert.classList.toggle('hidden', !on);
    dom.freezeBar.style.transform = `scaleX(${step})`;
  },
  setBackAlert(on, ratio = 0) {
    const pct = Math.round(THREE.MathUtils.clamp(ratio, 0, 1) * 100);
    if (this._backSig === on + '|' + pct) return;
    this._backSig = on + '|' + pct;
    dom.backAlert.classList.toggle('hidden', !on);
    dom.backAlert.classList.toggle('on', on);
    dom.backBar.style.width = `${pct}%`;
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
    if (!this._chaseEl) {
      this._chaseEl = document.getElementById('chase-hud');
      this._chaseBar = this._chaseEl && this._chaseEl.querySelector('i');
    }
    const el = this._chaseEl;
    if (!el) return;
    if (v < 0) { if (!el.classList.contains('hidden')) el.classList.add('hidden'); return; }
    const pct = Math.round(THREE.MathUtils.clamp(1 - v, 0, 1) * 100);
    if (this._chaseSig === pct) return;
    this._chaseSig = pct;
    el.classList.remove('hidden');
    if (this._chaseBar) this._chaseBar.style.width = `${pct}%`;
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
  /* the loop's only tell: one thin line, two seconds, amateur floor only */
  loopNote(text, ms = 2000) {
    const el = dom.loopNote;
    if (!el) return;
    el.textContent = text;
    el.classList.add('on');
    clearTimeout(this._loopNoteT);
    this._loopNoteT = setTimeout(() => el.classList.remove('on'), ms);
  },
  hideHUD() { dom.hud.classList.add('hidden'); },
  setTorch(on) {
    dom.torchChip.classList.toggle('on', on);
    dom.torchChip.querySelector('.txt').textContent = on ? 'TORCH ON' : 'TORCH OFF';
  },
  /* null = this floor has no battery, so the chip does not exist at all */
  setBattery(v, charging = false) {
    const el = dom.batteryChip;
    if (!el) return;
    if (v === null || v === undefined) {
      if (!el.classList.contains('hidden')) el.classList.add('hidden');
      return;
    }
    if (el.classList.contains('hidden')) el.classList.remove('hidden');
    const pct = Math.round(v * 100);
    if (pct !== this._battPct) {
      this._battPct = pct;
      el.querySelector('.val').textContent = `${pct}%`;
      el.querySelector('.bar i').style.width = `${pct}%`;
      el.classList.toggle('low', pct <= 25);
      el.classList.toggle('dead', pct <= 0);
    }
    if (el.classList.contains('charging') !== charging) {
      el.classList.toggle('charging', charging);
      el.querySelector('.state').textContent = charging ? '充電中 / CHARGE' : '';
    }
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
      /* A corrupt frame now and then. This used to rewrite a full-screen
         filter several times a second, and every rewrite re-rastered the
         whole photograph on the GPU. Twice per scare is enough to sell it. */
      const glitchy = e > 240 && e < 268 || e > 900 && e < 918;
      if (glitchy !== this._glitched) {
        this._glitched = glitchy;
        face.style.filter = glitchy
          ? 'invert(1) contrast(2.1) brightness(1.15)'
          : '';
      }
      requestAnimationFrame(tick);
    };
    tick();
  },
  /* Rasterise every jumpscare layer once, at boot, invisibly. Her arrival
     used to build a dozen full-screen compositing layers in the same frame
     the scare began. */
  prewarmScare() {
    const js = dom.jumpscare;
    if (!js) return;
    try {
      js.classList.add('active');
      js.style.opacity = '0';
      void js.offsetWidth;
      requestAnimationFrame(() => requestAnimationFrame(() => {
        js.classList.remove('active');
        js.style.opacity = '';
        this._glitched = false;
        if (dom.jumpscareImg) dom.jumpscareImg.style.filter = '';
      }));
    } catch (e) { /* cosmetic only */ }
    if (dom.jumpscareImg && dom.jumpscareImg.decode) {
      dom.jumpscareImg.decode().catch(() => { /* decode is best effort */ });
    }
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

/* One authority for the pointer. Before this the cursor was switched by half
   a dozen handlers, so a lost pointer lock could leave the alley showing a
   system cursor over a first-person view, and a menu could inherit the hidden
   one. Whatever the state is, the cursor is decided here. */
let _cursorMode = null;
function syncCursor() {
  const hidden = gameplayState() && !game.isMobile;
  const mode = hidden ? 'none' : 'default';
  if (mode === _cursorMode) return;
  _cursorMode = mode;
  try {
    dom.canvas.style.cursor = mode;
    document.body.style.cursor = mode;
  } catch (e) { /* noop */ }
}

function gameplayState() {
  if (game.inputLocked) return false;
  return [STATE.EXPLORE, STATE.FOLLOW, STATE.FREEZE, STATE.CHASE].includes(game.state);
}

function requestLook() {
  // a phone that is asked for pointer lock can lose its render loop entirely
  game._wantLockAt = performance.now();
  if (game.isMobile) { game.fallbackLook = false; return; }
  if (document.pointerLockElement === dom.canvas) { game.fallbackLook = false; return; }
  /* `pointerlockchange` is the only source of truth here. The old version gave
     up after 700 ms and latched `pointerLockBlocked`, which left the game in
     fallback mode *while the pointer was actually locked* — clientX never
     moves under a lock, so the mouse looked dead and ESC never opened the
     pause card. Retry both call styles, never latch the failure. */
  const plain = () => { try { dom.canvas.requestPointerLock(); } catch (e) { /* denied */ } };
  try {
    const p = dom.canvas.requestPointerLock?.({ unadjustedMovement: true });
    if (p && typeof p.catch === 'function') p.catch(plain);
  } catch (e) { plain(); }
  /* If the lock does not actually arrive, steer on cursor deltas instead of
     going deaf. `pointerlockchange` clears this again the moment it lands. */
  clearTimeout(game._lookFallbackTimer);
  game._lookFallbackTimer = setTimeout(() => {
    if (game.isMobile) return;
    if (document.pointerLockElement === dom.canvas) return;
    if (!gameplayState()) return;
    game.fallbackLook = true;
    dom.canvas.style.cursor = 'none';
  }, 420);
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
  if (game.isMobile) return;
  /* The view never depends on the pointer lock succeeding. A lock can be
     refused (a second request inside Chrome's cooldown, an embedded frame, a
     browser that does not support unadjusted movement) and the game used to
     go deaf in that case — the mouse simply stopped turning the head. Locked
     or not, the pointer drives the look. */
  /* movementX/Y is reported by every desktop browser whether or not the
     pointer is locked. Using it in the unlocked fallback means the view keeps
     turning instead of stalling the moment the cursor touches the edge of the
     window — which is exactly what "the mouse stops working" feels like. */
  let dx = e.movementX || 0, dy = e.movementY || 0;
  if (!dx && !dy && lastMouse) {
    dx = THREE.MathUtils.clamp(e.clientX - lastMouse.x, -70, 70);
    dy = THREE.MathUtils.clamp(e.clientY - lastMouse.y, -70, 70);
  }
  lastMouse = { x: e.clientX, y: e.clientY };
  applyLook(THREE.MathUtils.clamp(dx, -160, 160), THREE.MathUtils.clamp(dy, -160, 160));
});

/* A click in the alley is always a gesture, so it is also the safest moment
   to take the pointer back if it was lost. */
dom.canvas.addEventListener('mousedown', () => {
  if (!gameplayState()) return;
  if (document.pointerLockElement !== dom.canvas) requestLook();
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
let _mobileSig = '';
function syncMobile() {
  if (!game.isMobile) return;
  const sig = `${game.state}|${dom.choices.classList.contains('hidden')}`;
  if (sig === _mobileSig) return;        // this used to write classes 60×/s
  _mobileSig = sig;
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
    if (diffHover) { setDifficulty(diffHover); return; }
    if (boardHover) selectClass(boardHover);
  }, { passive: true });
}

if (IS_MOBILE) {
  installTouchControls();
  installMobileSelection();
}

let _relockTimer = 0;
function relockOrPause() {
  clearTimeout(_relockTimer);
  game.fallbackLook = true;             // playable even if the lock is refused
  try {
    const p = dom.canvas.requestPointerLock?.({ unadjustedMovement: true });
    if (p && typeof p.catch === 'function') p.catch(() => { try { dom.canvas.requestPointerLock(); } catch (e) {} });
  } catch (e) { /* keep going unlocked */ }
  _relockTimer = setTimeout(() => {
    _relockTimer = 0;
    if (document.pointerLockElement === dom.canvas) return;
    game.fallbackLook = true;
    if (gameplayState()) pauseGame();
  }, 420);
}

document.addEventListener('pointerlockchange', () => {
  if (game.isMobile) return;
  const locked = document.pointerLockElement === dom.canvas;
  game.pointerLocked = locked;
  if (locked) {
    /* the pointer is ours again: movementX is live, so fallback look is off.
       Leaving it latched here was the whole "the mouse is broken" report. */
    game.fallbackLook = false;
    game.pointerLockBlocked = false;
    dom.canvas.style.cursor = 'none';
    dom.pause.classList.add('hidden');
    if (game.state === STATE.PAUSED && game.prevState) {
      game.state = game.prevState;
      game.prevState = null;
      game.controlsActive = true;
    }
    lastMouse = null;
    clearTimeout(_relockTimer);
    game._escIntent = false;
    return;
  }
  dom.canvas.style.cursor = '';
  lastMouse = null;
  /* A lock can be lost without the player asking for it — a browser hiccup, a
     focus change, or the game's own scripted beat. Pausing on every unlock
     dropped the resume card mid-cutscene (right when she turns and walks off).
     So: take the pointer back first, and only card the player if that fails
     (which is what a real ESC looks like). */
  if (!gameplayState()) return;
  if (game._escIntent) { game._escIntent = false; pauseGame(); return; }
  /* The game asked for the pointer moments ago — she turns, the follow starts,
     the browser blinks and drops the lock. That is not the player asking to
     stop: take the pointer back and say nothing. Only a lock lost with no
     recent request (i.e. a real ESC) is allowed to card the player. */
  const fresh = performance.now() - (game._wantLockAt || 0) < 4000
    || performance.now() < (game._pauseSuppressUntil || 0);
  if (fresh) {
    try { dom.canvas.requestPointerLock(); } catch (e) { /* refused */ }
    game.fallbackLook = true;
    game._pauseSuppressUntil = Math.max(game._pauseSuppressUntil || 0, performance.now() + 6000);
    return;
  }
  relockOrPause();
});

document.addEventListener('pointerlockerror', () => {
  /* one failed attempt is not a life sentence — keep the lock available and
     just steer with cursor deltas until the next gesture succeeds */
  game.fallbackLook = true;
});

function pauseGame() {
  if (!gameplayState()) return;
  /* Hard gate: while she is turning and walking off, nothing incidental is
     allowed to card the player. A real ESC sets _escIntent first and always
     passes, so the resume screen still works exactly as before. */
  if (!game._escIntent && performance.now() < (game._pauseSuppressUntil || 0)) {
    try { dom.canvas.requestPointerLock?.(); } catch (e) { /* refused */ }
    game.fallbackLook = true;
    clearTimeout(_relockTimer); _relockTimer = 0;
    return;
  }
  game.prevState = game.state;
  game.state = STATE.PAUSED;
  dom.pause.classList.remove('hidden');
  dom.canvas.style.cursor = '';
  document.body.style.cursor = '';
  ui.setPrompt(null);
  for (const k in game.input.keys) game.input.keys[k] = false;
}
function resumeGame() {
  if (game.state !== STATE.PAUSED) return;
  game.state = game.prevState || STATE.FOLLOW;
  game.prevState = null;
  dom.pause.classList.add('hidden');
  game.controlsActive = true;
  requestLook();               // may be refused for a moment after ESC; that is fine
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
    if (e.code === 'ArrowUp') { cycleDifficulty(-1); return; }
    if (e.code === 'ArrowDown') { cycleDifficulty(1); return; }

    if (e.code === 'KeyE' || e.code === 'Enter' || e.code === 'Space') {
      if (diffHover) { setDifficulty(diffHover); return; }
      if (boardHover) selectClass(boardHover);
    }
    if (e.code === 'Digit7') { setDifficulty('amateur'); return; }
    if (e.code === 'Digit8') { setDifficulty('professional'); return; }
    if (e.code === 'Digit9') { setDifficulty('nightmare'); return; }
    if (e.code === 'Digit0') { setDifficulty('hell'); return; }
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
    case 'Escape':
      if (game.state === STATE.PAUSED) { resumeGame(); break; }
      if (gameplayState()) {
        game._escIntent = true;
        pauseGame();
        if (document.pointerLockElement === dom.canvas) document.exitPointerLock();
        setTimeout(() => { game._escIntent = false; }, 1200);
      }
      break;
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
  // a dead battery has nothing to switch on
  if (!world.flashlightOn && !mechanics.torchUsable()) {
    ui.toast('電池がない。自販機で充電しろ。 / No charge. Find a vending machine.', 2400);
    audio.tick(0.02);
    return;
  }
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
   LOOP FOLD — the alley is a 90 m band that repeats. Stepping from the end of
   one into the start of the next is a 90 m jump in a place that looks almost
   the same, and in the old build you saw every metre of it snap. The swap is
   now performed while a slow ink wash has the screen, so what the player
   experiences is the alley going dark for a breath and coming back — not a
   respawn. One composited div, one opacity transition: no repaint cost.
   -------------------------------------------------------------------------- */
game.wrapTransition = (swap) => {
  const el = dom.loopWash;
  if (!el) { swap(); return; }
  game.wrapActive = true;
  el.classList.remove('on');
  void el.offsetWidth;                 // restart the transition cleanly
  el.classList.add('on');
  audio.loopSwell();
  // the world moves only under the darkest frames (the wash is opaque by 420 ms)
  setTimeout(swap, 400);
  setTimeout(() => el.classList.remove('on'), 700);
  // ...and the loop's little note waits for the ink to actually be gone
  const done = (e) => {
    if (e && (e.target !== el || e.propertyName !== 'opacity')) return;
    if (el.classList.contains('on')) return;      // that was the fade IN
    el.removeEventListener('transitionend', done);
    clearTimeout(guard);
    game.wrapActive = false;
  };
  el.addEventListener('transitionend', done);
  const guard = setTimeout(done, 2600);   // a backgrounded tab may not fire it
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
let _herMissing = 0;
function updateMaigoWatchdog(rawDt) {
  const onStage = game.state === STATE.DIALOGUE || game.state === STATE.FOLLOW || game.state === STATE.CHASE;
  if (!onStage || !maigo.ready) { _herMissing = 0; return; }
  if (mechanics._lostKilling || game.wrapActive) { _herMissing = 0; return; }
  const visible = !!(maigo.root && maigo.root.visible);
  const rep = visible ? null : maigoScreenReport();
  const gone = !visible || (rep && !rep.finite);
  _herMissing = gone ? _herMissing + Math.min(rawDt, 0.1) : 0;
  if (_herMissing < 2.0) return;
  _herMissing = 0;
  rescueManifestation(visible ? 'not finite' : 'vanished from the scene');
}

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

const _wish = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();

function updateMovement(dt) {
  const canControl = game.controlsActive && gameplayState() && !camTween;
  const keys = game.input.keys;
  const wish = _wish.set(0, 0, 0);

  if (canControl) {
    const f = _fwd.set(-Math.sin(player.yaw), 0, -Math.cos(player.yaw));
    const r = _right.set(Math.cos(player.yaw), 0, -Math.sin(player.yaw));
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
      const pan = THREE.MathUtils.clamp((Math.random() - 0.5) * 0.25, -0.2, 0.2);
      const vol = Math.min(1, player.speed / 3.2);
      // one squared-distance test per footfall — no per-frame cost
      if (world.inPuddle(player.position.x, player.position.z)) {
        // picture and sound from one statement — the ring cannot lag the splash
        world.splashRipple(player.position.x, player.position.z, 0.55 + vol * 0.65);
        audio.puddleStep(vol, pan);
      } else audio.footstep(vol, pan);
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
    /* Aim at her chest, not her head. The eye line is centred on the aim point,
       so aiming at the head put her face exactly in the middle of the screen —
       which is where the subtitle and the two answer cards sit on anything
       smaller than a desk monitor. Aiming lower lifts her whole body into the
       upper half of the frame, clear of the words, and still keeps her face
       in the upper third where a face belongs. */
    /* How much of the frame the dialogue owns decides where she stands in it.
       On a wide screen the subtitle stays left and the answers stay right, so
       the middle is free and her chest is the right thing to centre. On a
       narrow screen the answers span the width, so aiming at her chest buries
       her behind them; there the aim drops to her waist and the camera sits
       further back, which lifts her whole figure into the clear. */
    const compact = game.dialogue ? game.dialogue.compact : false;
    let target;
    if (compact) {
      target = new THREE.Vector3(maigo.root.position.x, 0.42, maigo.root.position.z);
    } else {
      target = maigo.chestWorldPosition
        ? maigo.chestWorldPosition()
        : maigo.headWorldPosition();
    }
    if (!Number.isFinite(target.x) || !Number.isFinite(target.y) || !Number.isFinite(target.z)) {
      target.set(maigo.root.position.x, (maigo.root.position.y || 0) + 1.0, maigo.root.position.z);
    }
    // slow dolly-in, stopping ~3.15 m from her
    if (game.dialogue?.goal) {
      player.position.x = THREE.MathUtils.damp(player.position.x, game.dialogue.goal.x, 3.2, dt);
      player.position.z = THREE.MathUtils.damp(player.position.z, game.dialogue.goal.z, 3.2, dt);
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
    let desiredYaw = Math.atan2(-_dir.x, -_dir.z);
    let desiredPitch = Math.asin(THREE.MathUtils.clamp(_dir.y, -1, 1));
    /* A NaN anywhere in her transform used to run straight through this maths
       into player.yaw, and a NaN yaw does not tilt the camera — it erases the
       world. Never let that value out of this block. */
    if (!Number.isFinite(desiredYaw) || !Number.isFinite(desiredPitch)) {
      desiredYaw = Math.atan2(-(maigo.root.position.x - player.position.x), -(maigo.root.position.z - player.position.z));
      desiredPitch = -0.12;
    }
    if (!Number.isFinite(player.yaw)) player.yaw = desiredYaw;
    if (!Number.isFinite(player.pitch)) player.pitch = desiredPitch;
    let delta = ((desiredYaw - player.yaw + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
    if (!Number.isFinite(delta)) delta = 0;
    player.yaw += delta * Math.min(1, dt * 4.2);
    player.pitch = THREE.MathUtils.damp(player.pitch, desiredPitch, 4.2, dt);
    world.camera.fov = THREE.MathUtils.damp(world.camera.fov, 46, 1.8, dt);
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
  // the other device's legend must never linger
  const other = $(game.isMobile ? '#key-legend' : '#key-legend-m');
  if (other) other.classList.add('hidden');
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

/* --------------------------------------------------------------------------
   AVATAR WARMUP
   Compiling her MToon materials is the single most expensive thing the page
   does (3 s of shader compile on a software renderer). It used to run while
   the intro card was speaking, which froze the narration for four seconds.
   It now starts behind the title screen, where the player is reading the
   menu and nothing is timed.
   -------------------------------------------------------------------------- */
let _avatarWarm = null;
function startAvatarWarmup() {
  if (_avatarWarm) return _avatarWarm;
  _avatarWarm = loadAvatarAndPrewarm().catch((err) => {
    console.warn('[Maigo] warmup failed:', err && err.message);
    return null;
  });
  return _avatarWarm;
}

async function enterAlley() {
  if (game.state !== STATE.BOOT) return;
  dom.enter.disabled = true;
  _warmAbort = true;                 // no compile may begin from here on

  /* A player who has already decided to skip must not have to click twice
     because the card had not painted yet. The press (or key) that lands in
     the gap between the menu and the card is remembered, and the card then
     never speaks at all. Registered before the first await so the gap really
     is covered — the ENTER activation itself (a click, whose pointerdown and
     keydown are already over) can never trip it. */
  _introSkip = false;
  const latch = () => { _introSkip = true; };
  window.addEventListener('pointerdown', latch, { capture: true, once: true });
  window.addEventListener('keydown', latch, { capture: true, once: true });
  /* and a click on the card element itself, which can land before the card's
     own handler exists */
  try { $('#intro-card').addEventListener('click', latch, { once: true }); } catch (e) { /* noop */ }

  // the menu goes away at once; everything heavy happens behind the card
  dom.boot.classList.add('dissolve');
  setTimeout(() => { dom.boot.classList.add('hidden'); if (dom.boot.remove) dom.boot.remove(); }, 1100);

  // the title theme belongs to the menu — it fades as the card comes up
  audio.stopPianoLoop(1400);

  game.state = STATE.INTRO;

  // The audio context first (this click is the gesture that allows it), then
  // the card, so its first sentence is booked on the audio clock before any
  // of the heavy work — the avatar compile used to land on top of it.
  try { await Promise.race([audio.init(), sleep(600)]); } catch (e) { /* audio optional */ }
  const card = showIntroCard();
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
    fromFov: world.camera.fov, toFov: selectFov(world.camera.aspect),
    dur: 3.2,
    onDone: () => {
      game.state = STATE.SELECT;
      showBoard();
    },
  });

  setTimeout(() => {
    if (game.state === STATE.INTRO) {
      if (camTween) camTween.t = camTween.dur;   // land the move, do not cut mid-turn
      game.state = STATE.SELECT;
      showBoard();
    }
  }, 9000);   // safety net only: the tween's own onDone opens the board
}

/* --------------------------------------------------------------------------
   INTRO CARD
   Each paragraph appears and is spoken in Japanese; the next one waits for the
   voice to finish. Clicking anywhere abandons both the text and the narration
   immediately, so the card can never hold the player hostage.
   -------------------------------------------------------------------------- */
let _introSkip = false;

function showIntroCard() {
  const el = $('#intro-card');
  const lines = [...el.querySelectorAll('.ic-line')];
  el.classList.remove('hidden', 'dissolve');
  if (_introSkip) {
    /* the press happened while the card was still painting: honour it */
    el.classList.add('hidden');
    return Promise.resolve();
  }

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
      window.removeEventListener('keydown', onSkipKey);
      // SKIP must actually silence her: the other two sentences are already
      // booked seconds ahead on the audio clock, so cancelling has to reach
      // the sequencer, not just the card.
      audio.stopNarration();
      audio.stopIntroBed(1600);       // the card is where the music ends
      audio.stopPianoLoop(1400);
      resolve();
    };
    const onSkipKey = (e) => {
      if (e.code === 'Escape' || e.code === 'Space' || e.code === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        finish();
      }
    };
    el.addEventListener('click', finish);
    window.addEventListener('keydown', onSkipKey);

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

      // the clips were fetched during the title screen. The first sentence
      // starts as soon as it decodes (~15 ms), and the other two are booked
      // on the audio clock so nothing on the main thread can delay them.
      const seq = await audio.playIntroSequence(beats.map((b) => b.speak), 0.26, 3.0);
      // no shader work here any more: her warm-up already ran behind the
      // title screen, and prewarm() refuses to compile over a timed card
      if (done) return;

      if (!seq.ok) {
        // no context / no audio at all: walk the card on timers instead
        await wait(3000);
        for (const beat of beats) {
          if (done) return;
          for (const i of beat.span) {
            if (lines[i]) lines[i].classList.add('on');
            await wait(140);
            if (done) return;
          }
          await wait(2600);
        }
        if (!done) finish();
        return;
      }

      // the written lines rise with the spoken ones
      let cursor = 0;
      for (let b = 0; b < beats.length; b++) {
        let at = seq.at[b];
        if (at === undefined) at = cursor + 2600;      // buffer still arriving
        await wait(Math.max(0, at - cursor));
        cursor = at;
        if (done) return;
        for (const i of beats[b].span) {
          if (lines[i]) lines[i].classList.add('on');
        }
      }
      await wait(Math.max(600, (seq.total || (cursor + 2600)) - cursor + 260));
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
      /* Her own materials, and her texture uploads: warmed on their own.
         Compiling the whole alley again for the sake of a dozen skinned
         meshes was paying seconds for nothing — and paying it while the
         player was already standing in the alley. */
      if (maigo.ready) {
        queueAvatarTextureUpload();
        try { await warmAvatarOnly(); } catch (err) { /* best effort */ }
      }
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
let diffHover = null;      // 'amateur' | 'professional' | 'nightmare' | 'hell'
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
  _ray.setFromCamera(_ndc, world.camera);

  // the difficulty plates are the smaller target, so they are tested first
  const tag = world.difficultyAt ? world.difficultyAt(_ray) : null;
  if (tag) {
    if (diffHover !== tag) { diffHover = tag; world.setDifficultyHover(tag); audio.tick(0.03); }
    setBoardHover(null);
    return;
  }
  if (diffHover) { diffHover = null; world.setDifficultyHover(null); }

  if (!world.boardMesh) return;
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
  dom.controlsHint && dom.controlsHint.classList.add('hidden');   // the board speaks for itself
  game.flashTarget = 38;          // torch lowered: the board is the only light
  world.flashlightIntensity = 38;  // snap, so the board is readable at once
  setBoardHover(CLASS.STUDENT);
  if (world.setDifficultyTag) world.setDifficultyTag(game.difficulty);
}

/* --------------------------------------------------------------------------
   DIFFICULTY — four enamelled tags on the wall beside the board.
   Picked by looking at one and pressing E (or tapping it), exactly like the
   posters. Changing one costs a couple of material writes: no filters, no
   backdrop blur, no toast — that is what used to stutter.
   -------------------------------------------------------------------------- */
const DIFF_ORDER = ['amateur', 'professional', 'nightmare', 'hell'];
const DIFFICULTY_NAMES = {
  amateur: { jp: '素人', en: 'AMATEUR', blurb: 'a slow, almost kind alley' },
  professional: { jp: '玄人', en: 'PROFESSIONAL', blurb: 'the intended alley' },
  nightmare: { jp: '悪夢', en: 'NIGHTMARE', blurb: 'she is already behind you' },
  hell: { jp: '地獄', en: 'HELL', blurb: 'the alley was never going to let you out' },
};

function setDifficulty(key, { announce = true, quiet = false } = {}) {
  if (!DIFF_ORDER.includes(key)) key = 'professional';
  if (game.difficulty === key && !announce) return;
  game.difficulty = key;
  mechanics.applyDifficulty(key);
  ui.setDifficulty(key);

  if (quiet) return;
  // a dry mechanical clack, and a little more of it the deeper you go
  const idx = DIFF_ORDER.indexOf(key);
  audio.tick(0.05 + idx * 0.012);
  if (key === 'hell') audio.gravelScrape();   // the only level that answers back
  // nothing else on screen is touched: the look-card has a backdrop blur and
  // repainting its text mid-selection is exactly the hitch we are removing
}

function cycleDifficulty(dir) {
  const i = DIFF_ORDER.indexOf(game.difficulty);
  const next = DIFF_ORDER[Math.max(0, Math.min(DIFF_ORDER.length - 1, i + dir))];
  setDifficulty(next);
}

/* The board moment frames two metres of wall. On a 16:9 screen the stock
   fov of 46 covers it; on squarer screens it has to widen or the tags bolted
   either side of the board fall out of frame. */
function selectFov(aspect) {
  const halfTan = 1.58 / 2.6;                       // half the wall, at 2.6 m
  const needed = 2 * Math.atan(halfTan / Math.max(0.4, aspect)) * 180 / Math.PI;
  return Math.max(46, Math.min(64, Math.round(needed * 10) / 10));
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
  const tweenFromState = game.state;
  tweenCamera({
    fromPos: new THREE.Vector3(0, 1.72, 9.62),
    toPos: new THREE.Vector3(0, 1.68, 9.0),
    fromYaw: Math.PI, toYaw: 0,
    fromPitch: -0.01, toPitch: 0.0,
    fromFov: 46, toFov: 62,
    dur: 2.6,
    onDone: () => {
      /* a stalled tween must not resurrect this setup over a scene that has
         already moved on (the conversation, a chase, a loss) */
      if (game.state !== tweenFromState && game.state !== STATE.SELECT) return;
      player.position.set(0, 0, 9.0);
      player.eye = 1.68;
      dom.letterbox.classList.remove('active');
      ui.showHUD();
      game.controlsActive = true;
      game.flashTarget = 720;
      world.flashlightIntensity = 720;
      mechanics.startExplore();
      mechanics.updateBattery(0);
      ui.setTorch(world.flashlightOn);
      ui.chapter('第一章　夜の路地', 'CHAPTER ONE — THE NIGHT ALLEY');
      audio.setDread(0.15);
    },
  });
}

/* --------------------------------------------------------------------------
   MANIFESTATION + DIALOGUE
   ------------------------------------------------------------------------- */
/* The manifestation is not allowed to be the thing that waits for her model.
   Boot holds ENTER until she is parsed; if a retry ever finishes late, this is
   what closes the gap without a stopped frame. */
let _pendingManifest = false;
function schedulePendingManifest() {
  if (_pendingManifest) return;
  _pendingManifest = true;
  const t0 = performance.now();
  const retry = () => {
    if (!_pendingManifest) return;
    if (game.state !== STATE.EXPLORE) { _pendingManifest = false; return; }
    if (maigo.ready) { _pendingManifest = false; game.triggerManifestation(); return; }
    /* She is not coming in a reasonable time. The sculpted stand-in is a real
       model, not a box — the scene plays with her rather than skipping the
       meeting entirely. The VRM still arrives and replaces her next time she
       is staged. */
    if (performance.now() - t0 > 22000) {
      try { maigo.useFallback(); } catch (err) { console.warn('[Maigo] no avatar at all:', err); }
      if (maigo.ready) { _pendingManifest = false; game.triggerManifestation(); return; }
    }
    setTimeout(retry, 300);
  };
  setTimeout(retry, 300);
}

/* --------------------------------------------------------------------------
   SHE MUST BE THERE
   A girl who is spawned, visible, and still not drawn is the worst failure
   this game can have: nothing throws, the alley looks perfect, and the one
   thing the scene exists for is missing. These two functions make that
   failure observable and self-healing rather than silent.
   -------------------------------------------------------------------------- */
function maigoScreenReport() {
  const cam = world.camera;
  const root = maigo.root;
  const out = { visible: !!(root && root.visible), finite: false, ndc: null, dist: null, reason: '' };
  if (!root) { out.reason = 'no root'; return out; }
  root.updateMatrixWorld(true);
  cam.updateMatrixWorld(true);
  const head = maigo.headWorldPosition();
  const rp = root.position;
  out.finite = Number.isFinite(head.x) && Number.isFinite(head.y) && Number.isFinite(head.z)
    && Number.isFinite(rp.x) && Number.isFinite(rp.y) && Number.isFinite(rp.z)
    && Number.isFinite(root.scale.x) && Number.isFinite(root.rotation.y);
  if (!out.finite) { out.reason = 'non-finite transform (skeleton or root)'; return out; }
  const p = head.clone().project(cam);
  out.ndc = [+p.x.toFixed(2), +p.y.toFixed(2), +p.z.toFixed(2)];
  out.dist = +cam.position.distanceTo(rp).toFixed(2);
  const inFront = p.z > -1 && p.z < 1;
  if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) { out.reason = 'non-finite projection'; return out; }
  if (!inFront) out.reason = 'behind or beyond the camera';
  else if (Math.abs(p.x) > 0.92) out.reason = 'outside the frame horizontally';
  else if (Math.abs(p.y) > 0.96) out.reason = 'outside the frame vertically';
  return out;
}

/* Put her back in front of the camera, whole and finite. Every bone to its
   authored rest pose, the root at unit scale, six metres up the alley. */
function rescueManifestation(why) {
  try { maigo.restoreRestPose(); } catch (err) { /* sculpt has no bones */ }
  const fwd = new THREE.Vector3(-Math.sin(player.yaw), 0, -Math.cos(player.yaw));
  if (fwd.z > -0.2) fwd.set(0, 0, -1);
  const pos = player.position.clone().addScaledVector(fwd, 6);
  pos.y = 0;
  pos.x = THREE.MathUtils.clamp(pos.x, -1.55, 1.55);
  pos.z = THREE.MathUtils.clamp(pos.z, -205, 10.4);
  const root = maigo.root;
  root.scale.set(1, 1, 1);
  root.position.copy(pos);
  root.rotation.set(0, maigo.yawToward(new THREE.Vector3(player.position.x, 1.2, player.position.z)), 0);
  root.visible = true;
  root.updateMatrixWorld(true);
  if (game.dialogue) {
    game.dialogue.goal = pos.clone().addScaledVector(fwd, -3.15);
    game.dialogue.goal.y = 0;
  }
  console.warn('[Maigo] rescued after the beat — ' + why);
  try { ui.toast('⚠ Maigo-chan was repaired (' + why + ') — 直しました', 6000); } catch (e) { /* no ui */ }
}

function verifyManifestation(stage) {
  const rep = maigoScreenReport();
  const ok = rep.visible && rep.finite && !rep.reason;
  if (!ok) {
    console.warn('[Maigo] NOT ON SCREEN (' + stage + '):', JSON.stringify(rep));
    if (maigo.ready) rescueManifestation(rep.reason || 'not visible');
    return false;
  }
  return true;
}

game.triggerManifestation = async function triggerManifestation() {
  if (game.state !== STATE.EXPLORE) return;
  try {
    // She has to exist before the lights go out. If the avatar is still
    // downloading, wait for it (a slow beat in the dark reads as tension);
    // if it cannot arrive, put the sculpted stand-in on stage rather than
    // playing the whole scene at an empty patch of alley.
    if (!maigo.ready) {
      /* She is still downloading or being parsed, and parsing a 10.7 MB VRM is
         synchronous main-thread work (vertex merge, skeleton combine, bounds,
         retexture). Awaiting it here does not make her arrive sooner — it just
         puts the bill inside the frame the walk trigger fired on. Leave the
         player in a live alley and come back for the beat the moment she
         exists. */
      schedulePendingManifest();
      return;
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
  /* One second after she is staged the camera has arrived and the pose is
     settled — the moment to prove she is actually drawn. */
  setTimeout(() => { if (game.state === STATE.DIALOGUE) verifyManifestation('manifest'); }, 1200);
  setTimeout(() => { if (game.state === STATE.DIALOGUE) verifyManifestation('manifest+3s'); }, 3400);
  /* NOTHING is compiled here. `renderer.compileAsync()` walks every material
     in the scene and calls getProgram on each one; without the KHR_parallel_
     shader_compile extension — which is most browsers — that walk is a single
     four-second script. Started here, it lands in the middle of the answer,
     exactly as she finishes turning and starts to walk. Everything on this
     stage is already linked (zero new programs measured at the board and at
     this moment), so the walk is pure cost. */

  // 3. the camera is drawn toward her while the torch lifts to her face
  player.eye = 1.68;
  /* Narrow frame = the answers span the full width = she has to stand high.
     Wide frame = the answers sit in the right-hand column = centre her. */
  game.dialogueCompact = window.innerWidth <= 760 || (window.innerHeight / Math.max(1, window.innerWidth)) > 1.05;
  const goal = spawn.clone().addScaledVector(fwd, game.dialogueCompact ? -3.0 : -3.15);
  goal.x = THREE.MathUtils.clamp(goal.x, -1.4, 1.4);
  goal.y = 0;
  game.dialogue = {
    startedAt: performance.now(), target: 'chest', goal, base: player.position.clone(),
    compact: game.dialogueCompact,
  };
  world.flashlightScale = 0.115; // the beam reaches her from 3.15 m, not 2.3
  world.camera.fov = 48;

  // 4. let the pink fog crawl, then speak
  await sleep(900);
  if (game.state !== STATE.DIALOGUE) return;
  const vocative = game.classType === CLASS.ADULT ? 'ojisan' : 'oneesan';
  // a fresh question owns the choice pair again
  domChoices.answered = false;
  cancelChoiceReveals();
  ui.showChoices(false);
  ui.showSubtitle(vocative);
  const duration = audio.speakQuestion(vocative);
  if (maigo.speak) maigo.speak(duration || 4);
  audio.setDread(0.5);
  // 5. choices fade in while she is still asking — booked through the one
  //    owner below, so an answer cancels them instead of racing them
  /* The pair is the only way to answer, so it appears as soon as she starts
     asking — a slow phone queues timers behind long frames and used to leave
     the player with nothing to press for several seconds. */
  revealChoices(650);
  revealChoices(Math.max(1200, Math.min(5200, duration * 700)));
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

/* One owner for the YES / NO pair.
   The reveal used to be plain setTimeout calls: answer "yes" at two seconds
   and the second timer (up to 5.2 s later) still fired, so the pair faded
   back in while she was already walking and stayed there for the rest of
   the run. Everything is registered here and dropped the instant the
   question is answered. */
const choiceTimers = [];
function revealChoices(ms) {
  const id = setTimeout(() => {
    if (domChoices.answered || game.state !== STATE.DIALOGUE) return;
    ui.showChoices(true);
  }, ms);
  choiceTimers.push(id);
}
function cancelChoiceReveals() {
  while (choiceTimers.length) clearTimeout(choiceTimers.pop());
  ui.showChoices(false);
}

function answer(choice) {
  if (game.state !== STATE.DIALOGUE || domChoices.answered) return;
  domChoices.answered = true;
  cancelChoiceReveals();          // nothing may put the pair back on screen
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
  cancelChoiceReveals();
  // the same guarantee as the manifestation: never walk an empty alley
  if (!maigo.ready) {
    await Promise.race([loadAvatarAndPrewarm(), sleep(2500)]);
    if (!maigo.ready) { try { maigo.useFallback(); } catch (e) { /* nothing left */ } }
    if (game.state !== STATE.DIALOGUE) return;
  }
  requestLook();
  /* the cutscene that follows is not a moment to card the player: if the
     browser blinks and drops the pointer lock while she turns and walks off,
     take it back and say nothing */
  game._pauseSuppressUntil = performance.now() + 20000;
  audio.clothRustle(1.0);
  ui.toast('彼女は、先を行く。 / She walks ahead.', 2600);
  /* She turns on the wall clock and the beat is capped: whatever the machine
     does, the walk starts. A promise that never settles is a stuck game. */
  await Promise.race([maigo.turnAround(1.25), sleep(1900)]);
  if (game.state !== STATE.DIALOGUE) return;
  if (maigo.cancelTurn) { try { maigo.cancelTurn(); } catch (err) { /* noop */ } }

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
function lose(title, reason, tip, opts) {
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
    maigo.root.visible = true;
    maigo.attackPose();
    maigo.face(new THREE.Vector3(player.position.x, 1.2, player.position.z));
    if (opts && opts.behind) {
      // she came back where you cannot see her: at your shoulder, facing you
      maigo.root.position.set(
        player.position.x + Math.sin(player.yaw) * 1.05,
        0,
        player.position.z + Math.cos(player.yaw) * 1.05
      );
    } else {
      maigo.root.position.set(
        player.position.x - Math.sin(player.yaw) * 0.9,
        0,
        player.position.z - Math.cos(player.yaw) * 0.9
      );
    }
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

game.lose = (title, reason, tip, opts) => lose(title, reason, tip, opts);

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
/* --------------------------------------------------------------------------
   PREWARM — compile every program before the player needs it.

   This used to put her in front of the camera, move the camera onto her and
   call composer.render() twice. On a desktop that is one invisible frame; on a
   phone the compile takes long enough that the *live* render loop drew her
   standing still at five metres, mid-alley — the frozen Maigo that shows up
   when a run starts.

   Three rules now:
     · nothing is presented while warming: the composer is told not to write to
       the canvas, and the frame loop holds its last frame (world.prewarming);
     · her visibility and position are only touched while a menu is up
       (BOOT / INTRO / SELECT). In a live alley the warm-up compiles what is
       already on stage and leaves her exactly where the game put her;
     · if she is staged *during* a warm-up (a slow download landing in the
       middle of the dialogue), the restore leaves her visible and in place.
   -------------------------------------------------------------------------- */
let _prewarmInFlight = null;
/* Every warm pass goes through one queue. Two of them running at once used to
   fight over the same three things — the held frame, the off-screen composer
   and the visibility of the whole alley — and the loser's pass was the one
   that would have linked her materials. */
let _warmChain = Promise.resolve();

/* Every warm pass is a `renderer.compile*` walk of the whole scene. Without
   parallel shader compile that is one multi-second script, so it may only run
   while the title screen is up. Started any later it is a hang in the middle
   of the alley. */
function warmAllowed() { return !_warmAbort && game.state === STATE.BOOT; }

/* True for the duration of one `compile*` walk. The title screen's ENTER gate
   waits for this to clear: a compile that is already inside the driver cannot
   be cancelled, so the only way to guarantee the player never sees one is to
   not hand them the alley until it has finished. */
let _warmBusy = false;
let _warmAbort = false;
function warmIdle(cb) {
  if (!_warmBusy) { cb(); return; }
  setTimeout(() => warmIdle(cb), 100);
}
function scheduleWarm(job) {
  const run = () => job().catch((err) => { console.warn('[warm]', err && err.message); });
  const p = _warmChain.then(run, run);
  _warmChain = p;
  return p;
}
function prewarm() {
  /* Queue, never de-duplicate. A second caller used to be handed the promise
     of the pass already running — which had started before her model existed,
     so it compiled the alley and skipped her. Her materials were then linked
     on stage, in the middle of the manifestation, as a multi-second freeze. */
  return scheduleWarm(runPrewarm);
}

function runPrewarm() {
  return (async () => {
    if (!warmAllowed()) return;               // title screen only
    const r = world.renderer;
    const cam = world.camera;
    const menuUp = [STATE.BOOT, STATE.INTRO, STATE.SELECT, STATE.WIN, STATE.LOSE].includes(game.state);

    const saved = {
      pos: cam.position.clone(), quat: cam.quaternion.clone(), fov: cam.fov,
      vis: maigo.root.visible, px: maigo.root.position.clone(),
      toScreen: world.composer.renderToScreen,
    };
    const restore = () => {
      cam.position.copy(saved.pos); cam.quaternion.copy(saved.quat);
      cam.fov = saved.fov; cam.updateProjectionMatrix();
      // she may have been staged for real while the compile was in flight
      const staged = !!(maigo.active && maigo.mode !== 'hidden');
      maigo.root.visible = staged ? true : saved.vis;
      if (!staged) maigo.root.position.copy(saved.px);
      world.composer.renderToScreen = saved.toScreen;
      world.prewarming = false;
    };

    /* A timed card (the narration, the walk-off) is a performance: never
       freeze it to link shaders. If we are called while one is running, wait
       out here first — with the frame loop still running, so the card keeps
       animating — and compile once the board is up. */
    if (game.state === STATE.INTRO) {
      for (let i = 0; i < 200 && game.state === STATE.INTRO; i++) {
        await new Promise((res) => setTimeout(res, 100));
      }
      if (!warmAllowed()) return;             // the player is already walking
    }

    world.prewarming = true;                 // frame() holds its last frame
    world.composer.renderToScreen = false;   // the compiler runs, nothing shows
    try {
      const compile = async () => {
        if (!warmAllowed()) return;           // the player has left the menu
        _warmBusy = true;
        try {
          if (typeof r.compileAsync === 'function') {
            try { await r.compileAsync(world.scene, cam); return; } catch (err) { /* fall through */ }
          }
          r.compile(world.scene, cam);
        } finally { _warmBusy = false; }
      };

      if (menuUp) {
        /* Park her in front of a throwaway camera so her programs compile too. */
        maigo.root.position.set(0, 0, 4.0);
        maigo.root.visible = true;
        cam.position.set(0, 1.68, 10.2);
        cam.lookAt(0, 1.15, 4.0);
        cam.updateMatrixWorld(true);
        await compile();
        forceShadowWarm();
        world.composer.render();      // warms the post chain, into a target only
        await new Promise((res) => setTimeout(res, 0));

        maigo.root.visible = false;   // and the frame without her light count
        await compile();
        forceShadowWarm();
        world.composer.render();
        await new Promise((res) => setTimeout(res, 0));

        /* A compile alone is not enough: three builds a program per material
           *and* per lighting/shadow configuration, and some of those only
           appear once the camera is actually inside the alley. So walk the
           camera down it here, behind the loading screen, and render one
           frame from each stop. Everything the run can ever need is linked
           before the player is allowed in, which is why ENTER no longer
           costs a two-second freeze on the way to the board. */
        const STOPS = [
          { p: [0, 1.68, 9.6], l: [0, 1.55, 12.4] },     // the poster board
          { p: [0, 1.68, 8.6], l: [0, 1.45, -6.0] },     // down the alley
          { p: [0.2, 1.68, -22], l: [0, 1.4, -42] },     // the first vending row
          { p: [-0.2, 1.68, -58], l: [0, 1.4, -80] },    // the second
          { p: [0, 1.68, -100], l: [0, 1.4, -118] },     // the far end
        ];
        for (const stop of STOPS) {
          if (!warmAllowed()) { restore(); return; }
          cam.position.set(stop.p[0], stop.p[1], stop.p[2]);
          cam.lookAt(stop.l[0], stop.l[1], stop.l[2]);
          cam.updateMatrixWorld(true);
          await compile();
          forceShadowWarm();
          world.composer.render();
          await new Promise((res) => setTimeout(res, 0));
        }

        /* One last pass with culling switched off, and this one matters more
           than the five above.
           The composer draws the alley into a half-float target, and three
           keys its programs on the output colour space — so every material
           needs a second program for "drawing into the composer" that a
           plain compile never makes. The stops above only build that variant
           for what happened to be inside the frustum: the rest of the alley
           built them on the first live frames of the run, which is the
           stutter right after a lap begins. With culling off for one frame,
           the whole scene links both variants before the player is let in. */
        if (!warmAllowed()) { restore(); return; }
        const unculled = [];
        world.scene.traverse((o) => {
          if (o.isMesh && o.frustumCulled) { unculled.push(o); o.frustumCulled = false; }
        });
        cam.position.set(0, 1.68, 8.6);
        cam.lookAt(0, 1.45, -6.0);
        cam.updateMatrixWorld(true);
        forceShadowWarm();
        world.composer.render();
        await new Promise((res) => requestAnimationFrame(res));
        forceShadowWarm();
        world.composer.render();
        for (let i = 0; i < unculled.length; i++) unculled[i].frustumCulled = true;
      } else {
        // live alley: compile the scene exactly as it stands, she stays put
        await compile();
        await new Promise((res) => setTimeout(res, 0));
        /* If her model landed after the menu was gone she has never been
           drawn, which means her textures were never uploaded — and the first
           frame of the manifestation pays for all of them at once. Draw her
           once here, into a target nobody can see (world.prewarming is up and
           the composer is off-screen), and put her straight back. */
        if (maigo.ready && !saved.vis) {
          maigo.root.position.set(0, 0, cam.position.z - 3.4);
          maigo.root.visible = true;
          cam.lookAt(maigo.root.position.x, 1.05, maigo.root.position.z);
          cam.updateMatrixWorld(true);
          forceShadowWarm();
          world.composer.render();
          await new Promise((res) => setTimeout(res, 0));
        }
      }
      _prewarmReport = { programs: r.info.programs.length };
    } catch (err) {
      console.warn('[Prewarm] skipped:', err);
    } finally {
      restore();
    }
  })();
}

/* --------------------------------------------------------------------------
   WARM HER ALONE
   She is 13 skinned meshes with her own textures and her own program set. The
   first time she is drawn the renderer has to link those programs and upload
   those maps, which is seconds of work — and it used to happen in the middle
   of her manifestation, in a live frame, which is exactly the freeze the
   player saw. Here the alley is hidden, she is drawn alone into a target
   nobody is looking at, and everything is put back exactly as it was.
   -------------------------------------------------------------------------- */
function _isInside(root, node) {
  let p = node;
  while (p) { if (p === root) return true; p = p.parent; }
  return false;
}
/* One full shadow pass. `renderer.compile()` only links the surface programs;
   the depth programs a shadow-casting mesh needs are created the first time a
   shadow map is actually rendered — which, before this, was always the first
   live frame of the run. */
function flushGPU() {
  try {
    const gl = world.renderer && world.renderer.getContext && world.renderer.getContext();
    if (gl && typeof gl.finish === 'function') gl.finish();
  } catch (e) { /* a driver that refuses finish simply skips the wait */ }
}

function forceShadowWarm() {
  const r = world.renderer;
  try {
    r.shadowMap.needsUpdate = true;
    const seen = new Set();
    world.scene.traverse((o) => {
      if (!o.isLight || !o.shadow) return;
      if (seen.has(o.shadow)) return;
      seen.add(o.shadow);
      o.shadow.needsUpdate = true;
    });
  } catch (e) { /* cosmetic */ }
}

/* Her model carries a dozen or so maps at 1–2k. Uploaded in one go they are a
   visible stall on the frame she first appears; uploaded a couple at a time
   while the title screen is still up they cost nothing at all. */
let _texUploadQueue = null;
function queueAvatarTextureUpload() {
  if (_texUploadQueue) return;
  _texUploadQueue = [];
  const seen = new Set();
  const grab = (t) => {
    if (!t || !t.isTexture || seen.has(t.uuid)) return;
    seen.add(t.uuid);
    _texUploadQueue.push(t);
  };
  try {
    maigo.root.traverse((o) => {
      if (!o.isMesh && !o.isSkinnedMesh) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) {
        if (!m) continue;
        grab(m.map); grab(m.normalMap); grab(m.emissiveMap); grab(m.alphaMap);
        grab(m.roughnessMap); grab(m.metalnessMap); grab(m.aoMap);
        grab(m.gradientMap); grab(m.sheenColorMap); grab(m.specularMap);
        grab(m.matcap);
      }
    });
  } catch (e) { /* cosmetic */ }
  const step = () => {
    const list = _texUploadQueue;
    if (!list || !list.length) { _texUploadQueue = null; return; }
    const t = list.shift();
    try { if (world.renderer && world.renderer.initTexture) world.renderer.initTexture(t); } catch (e) { /* skip */ }
    setTimeout(step, 45);
  };
  setTimeout(step, 60);
}
window.__queueAvatarTextures = queueAvatarTextureUpload;

window.__warmAvatar = () => warmAvatarOnly();

function warmAvatarOnly() {
  return scheduleWarm(warmAvatarJob);
}

async function warmAvatarJob() {
  const r = world.renderer, cam = world.camera;
  if (!r || !maigo.root || !maigo.ready) return;
  if (!warmAllowed()) return;                 // title screen only
  const root = maigo.root;
  const hidden = [];
  const saved = {
    vis: root.visible, pos: root.position.clone(), rotY: root.rotation.y,
    camPos: cam.position.clone(), camQuat: cam.quaternion.clone(),
    prewarm: world.prewarming, toScreen: world.composer.renderToScreen,
  };
  /* Deliberately NOT re-enabling the shader error check here: on a software
     rasteriser that check alone is several seconds of driver round-trips, and
     her model can land while the intro card is still speaking. The check did
     its job during the boot build. */
  try {
    world.scene.traverse((o) => {
      if (!o.isMesh || !o.visible) return;
      if (_isInside(root, o)) return;
      hidden.push(o);
      o.visible = false;
    });
    world.prewarming = true;                 // the live frame is held
    world.composer.renderToScreen = false;   // nothing is presented
    root.visible = true;
    root.position.set(cam.position.x, 0, cam.position.z - 3.2);
    cam.lookAt(root.position.x, 1.05, root.position.z);
    cam.updateMatrixWorld(true);
    /* One draw of her, nothing else. This used to be preceded by a
       `compile()` walk of the whole scene: that walk is a single multi-second
       script on any browser without parallel shader compile, and it is the
       last thing in here that could be felt by a player. Her maps upload and
       her own programs link from this draw alone. */
    forceShadowWarm();
    world.composer.render();
    /* gl.finish() is a deliberate, blocking round-trip with the driver: it
       returns only when every draw queued above — including any shader the
       driver had not finished translating — is done. Called here, on the
       title screen, it costs a loading spinner. Not called, that same work
       lands on the first live frame she appears in, which is exactly the
       multi-second stop players report. */
    flushGPU();
    await new Promise((res) => requestAnimationFrame(res));
  } catch (err) {
    /* cosmetic only: a failed warm-up just means the first live frame pays */
  } finally {
    for (let i = 0; i < hidden.length; i++) hidden[i].visible = true;
    root.visible = saved.vis;
    root.position.copy(saved.pos);
    root.rotation.y = saved.rotY;
    cam.position.copy(saved.camPos); cam.quaternion.copy(saved.camQuat);
    cam.updateProjectionMatrix();
    world.composer.renderToScreen = saved.toScreen;
    world.prewarming = saved.prewarm;
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
  setTimeout(() => ui.prewarmScare(), 60);
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

  /* three re-reads every new program's link log on first use, which forces a
     synchronous driver round-trip per program. It is invaluable while the
     alley is being built and pure cost afterwards, so it is switched off here
     and switched back on only for the two deliberate compile passes below —
     where a real shader error still gets counted in window.__shaderErrs. */
  try { world.renderer.debug.checkShaderErrors = false; } catch (e) { /* always on */ }
  window.__maigoReady = true;
  // Warm her up behind the menu. The model download, the material compile and
  // the voice decode all live here now, because doing any of it during the
  // intro card froze the narration.
  // only while the menu is still up: if the player has already pressed ENTER
  // the card schedules this itself, right after its first sentence starts
  /* Her download and her shader compile now start the instant the alley is
     finished, while the title screen is still up. They used to begin half a
     second into the intro card, which is exactly what froze it. ENTER stays
     dark for as long as that takes — but never longer than 2.6 s, so a slow
     line can still walk straight in. */
  /* ENTER waits for her, not just for the alley. Parsing a 5 MB VRM is
     main-thread work — if it lands after the click it is a multi-second
     freeze in the middle of the intro card, which is exactly what the player
     was seeing. The cap keeps a slow connection moving. */
  const _warm = startAvatarWarmup();
  if (dom.loadStatus) dom.loadStatus.textContent = 'WAKING HER UP… 少女を呼んでいます';
  /* Twenty seconds was a guess at "long enough". On a slow line it was not,
     and the cost of being wrong was not a slow load — it was the VRM being
     parsed in the middle of the alley, which is a multi-second stop at the
     exact moment she is supposed to appear. The gate now holds until she is
     actually in the scene, and says so while it waits. */
  const _herReady = new Promise((done) => {
    let waited = 0;
    const tick = () => {
      if (maigo.ready || waited >= 58000) return done();
      waited += 500;
      const p = window.__avatarProgress || 0;
      if (dom.loadStatus) {
        dom.loadStatus.textContent = 'WAKING HER UP…　少女を呼んでいます'
          + (p > 0.02 ? '  ' + Math.round(p * 100) + '%' : '');
      }
      setTimeout(tick, 500);
    };
    setTimeout(tick, 400);
  });
  Promise.race([Promise.all([_warm, _herReady]), sleep(60000)]).then(() => {
    /* Whatever the warm-up still had planned, it does not start now — and the
       one compile that may be inside the driver is allowed to finish first,
       because it cannot be cancelled and starting the walk on top of it is
       the freeze this gate exists to prevent. */
    _warmAbort = true;
    warmIdle(() => {
      flushGPU();      // nothing of hers is still compiling when the door opens
      dom.enter.disabled = false;
      if (dom.loadStatus) {
        dom.loadStatus.innerHTML = world.software
          ? 'READY — HEADPHONES ON · CLICK TO BEGIN<br><span style="color:#ff9a3c">⚠ hardware acceleration is off — it will stutter (設定で有効に)</span>'
          : 'READY — HEADPHONES ON · CLICK TO BEGIN';
      }
    });
  });
  /* The software-rasteriser warning is the amber line inside #load-status,
     written when ENTER is enabled — it sits under the button and never covers
     anything. It used to be a floating toast as well, and that toast landed
     squarely on top of the ENTER button: the one message meant to help the
     player was hiding the only thing to click. */

  /* --------------------------------------------------------------
     DRESS REHEARSAL FOR THE OVERLAYS.
     The subtitle, the answer pair, the prompt, the protocol HUD and the
     toast are all created for the first time at one of two moments: her
     manifestation, or her turn-and-walk. The first time a layer like
     that appears, the compositor has to build it, rasterise its text
     (Japanese glyphs included) and promote it to its own layer — work
     the player feels as a stutter precisely when she arrives. Doing it
     once here, invisible, on the title screen makes every later
     appearance a repeat of a frame the browser has already costed.
     Nothing changes on screen: the layers are laid out and painted at
     opacity 0 for two frames, then put back exactly as they were.
     -------------------------------------------------------------- */
  prewarmOverlays();
  installStallWatch();
  /* The compact layout stacks the answers above the subtitle instead of over
     her. It needs to know how tall the subtitle just became. */
  try {
    const sub = document.getElementById('subtitle');
    if (sub && typeof ResizeObserver === 'function') {
      const ro = new ResizeObserver(() => {
        document.documentElement.style.setProperty('--sub-h', Math.round(sub.getBoundingClientRect().height) + 'px');
      });
      ro.observe(sub);
    }
  } catch (e) { /* no observer: the css fallback height holds */ }
  // the narration is ~150 KB of mp3 — fetch it while nobody is listening
  audio.primeNarration && audio.primeNarration();
  if (!dom.enter.disabled && dom.loadStatus) dom.loadStatus.textContent = 'READY — HEADPHONES ON · CLICK TO BEGIN';
  window.addEventListener('resize', () => { world.resize(); rig.resize(); }, { passive: true });
  world.resize();

  // phones get a touch-sized copy of the wall plates (the wall itself is
  // two metres wide and a portrait phone can only frame the middle of it)
  for (const b of document.querySelectorAll('#df-mobile .df-m')) {
    b.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (game.state !== STATE.SELECT) return;
      setDifficulty(b.dataset.diff);
    });
  }

  // the tags live in the world; this only paints the chip and lights one
  ui.setDifficulty(game.difficulty);

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
      world.camera.fov = selectFov(world.camera.aspect);
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

  /* A stall recorder that names its own culprit. When a frame holds the main
   thread for more than a second, the browser hands us the long-animation-frame
   entry: how long, and which functions were on the stack. That line is the
   difference between guessing and knowing, so it is printed to the console and
   summed up in a badge nobody has to look for twice. */
function prewarmOverlays() {
  if (game.state !== STATE.BOOT) return;
  const ids = ['subtitle', 'dialogue-choices', 'prompt', 'protocol-hud', 'toast', 'chase-hud'];
  const touched = [];
  for (const id of ids) {
    const el = document.getElementById(id);
    if (!el) continue;
    touched.push([el, el.getAttribute('class'), el.getAttribute('style')]);
    el.classList.remove('hidden');
    el.style.animation = 'none';
    el.style.opacity = '0';
    el.style.visibility = 'hidden';
    el.style.transition = 'none';
    el.style.pointerEvents = 'none';
  }
  /* Warm the Japanese glyphs on a throwaway node. NEVER write into the real
     overlay elements: dom.subtitleJp / subtitleEn are cached node references,
     and replacing the subtree would leave every later subtitle writing into
     detached nodes — the dialogue would go silent and blank. */
  const warm = document.createElement('div');
  warm.setAttribute('aria-hidden', 'true');
  warm.style.cssText = 'position:fixed;left:-9999px;top:0;font-family:var(--jp-serif);'
    + 'font-size:23px;letter-spacing:.06em;white-space:pre';
  warm.textContent = '迷子ちゃん あの… おじさん / おねえさん… 道に迷っちゃって。お家まで連れて行ってくれませんか？'
    + ' はい いいえ あなた 彼女の家まで。';
  document.body.appendChild(warm);
  void document.body.offsetWidth;          // force layout + paint
  requestAnimationFrame(() => requestAnimationFrame(() => {
    for (const [el, cls, style] of touched) {
      if (cls === null) el.removeAttribute('class'); else el.setAttribute('class', cls);
      if (style === null) el.removeAttribute('style'); else el.setAttribute('style', style);
    }
    if (warm.parentNode) warm.parentNode.removeChild(warm);
  }));
}

function installStallWatch() {
  window.__stalls = [];
  const note = (dur, fns, kind) => {
    const rec = { ms: Math.round(dur), fns: fns.slice(0, 4), kind, at: (window.__dev && window.__dev.game && window.__dev.game.state) || '?' };
    window.__stalls.push(rec);
    if (window.__stalls.length > 40) window.__stalls.shift();
    try { console.warn('[stall] ' + rec.ms + ' ms in ' + rec.at + ' — ' + (rec.fns.join(', ') || kind)); } catch (e) { /* noop */ }
    let b = document.getElementById('stall-badge');
    if (!b) {
      b = document.createElement('div');
      b.id = 'stall-badge';
      b.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);top:8px;z-index:99999;padding:6px 9px;border-radius:6px;text-align:center;'
        + 'background:rgba(8,6,12,.82);border:1px solid rgba(255,120,140,.55);color:#ffd9df;'
        + 'font:11px/1.45 ui-monospace,Menlo,Consolas,monospace;letter-spacing:.02em;pointer-events:none;'
        + 'max-width:min(72vw,520px);white-space:pre-wrap;opacity:0;transition:opacity .25s ease';
      document.body.appendChild(b);
    }
    b.textContent = 'stall ' + (rec.ms / 1000).toFixed(1) + ' s · ' + rec.at
      + (rec.fns.length ? '\n' + rec.fns.join('  ') : '');
    b.style.opacity = '1';
    clearTimeout(b._t);
    b._t = setTimeout(() => { b.style.opacity = '0'; }, 12000);
  };
  try {
    const po = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        /* The title screen deliberately pays for the shader warm-up; that is
           not a stall a player will ever feel, and reporting it would make a
           working build look broken. Only the alley counts. */
        const where = (window.__dev && window.__dev.game && window.__dev.game.state) || 'BOOT';
        if (e.duration < 1200 || where === 'BOOT' || where === 'INTRO' || where === 'SELECT') continue;
        const fns = (e.scripts || []).map((s) => (s.sourceFunctionName || 'anonymous') + ' ' + Math.round(s.duration) + 'ms');
        note(e.duration, fns, 'long-animation-frame');
      }
    });
    po.observe({ entryTypes: ['long-animation-frame'] });
    window.__stallWatch = po;
  } catch (e) { /* older engine: the badge simply never appears */ }
}

window.__dev = { game, world, rig, maigo, mechanics, ui, audio, enterAlley, selectClass, acceptMaigo, answer, lose, win: game.win };

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
    if (diffHover) { setDifficulty(diffHover); return; }   // a plate, not a person
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
const perf = { ring: [], scale: world.renderer.getPixelRatio(), low: 0, timer: 0 };
function governPerformance(rawDt) {
  if (world.minQuality) return;
  if (document.visibilityState === 'hidden') { perf.ring.length = 0; return; }

  const ring = perf.ring;
  ring.push(rawDt > 1.5 ? 1.5 : rawDt);
  if (ring.length > 24) ring.shift();
  perf.timer += rawDt;
  if (ring.length < 8 || perf.timer < 1.0) return;
  const sorted = ring.slice().sort((a, b) => a - b);
  const med = sorted[sorted.length >> 1];
  const fps = med > 0 ? 1 / med : 120;
  perf.timer = 0;

  /* ----------------------------------------------------------------
     THE ONLY LEVER THAT CHANGES THE FRAME IS A RESIZE, AND A RESIZE IS
     NOT FREE. `renderer.setSize` + `composer.setSize` discard and
     recreate every render target — MSAA buffers included — and resize
     the canvas. That is a guaranteed visible hitch, and it also clears
     the drawing buffer. The old governor pulled that lever every 1.8 s
     on any machine running under 46 fps, which on a real GPU means a
     stutter every couple of seconds, worst of all right after a beat
     when the frame budget is already thin — exactly "she turns, starts
     to walk, and it freezes".

     So: never touch the frame while she is on stage, never within a
     few seconds of a state change, and then at most every eight
     seconds. A machine that is genuinely too slow still gets relief;
     a machine at 40 fps gets to keep a stable picture instead of a
     resolution that pumps itself up and down all game.
     ---------------------------------------------------------------- */
  const calm = game.state === STATE.EXPLORE;
  perf.slow = (fps < 22) ? (perf.slow || 0) + 1 : 0;
  if (!calm) return;

  const nowPerf = performance.now();
  if (nowPerf - (perf.stateAt || 0) < 6000) return;        // just changed state
  if (nowPerf - (perf.lastChange || 0) < 8000) return;     // be patient

  if (perf.slow >= 3) {                                    // ~3 s of proof
    perf.lastChange = nowPerf;
    perf.slow = 0;
    world.degradeToMin();
    return;
  }
  if (fps > 52 && world._softDegraded) { perf.lastChange = nowPerf; world.restoreQuality(); return; }
  if (fps < 34 && perf.scale > 0.72) {
    perf.lastChange = nowPerf;
    perf.scale = Math.max(0.72, perf.scale - 0.12);
    world.setRenderScale(perf.scale);
  } else if (fps > 58 && perf.scale < Math.min(window.devicePixelRatio || 1, 1.6)) {
    perf.lastChange = nowPerf;
    perf.scale = Math.min(perf.scale + 0.06, Math.min(window.devicePixelRatio || 1, 1.6));
    world.setRenderScale(perf.scale);
  }
}


let _frameErrors = 0;
let _lastState = '';
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

  /* Camera tweens advance with the frames the player actually sees. They used
     to run on wall-clock time, so any stall longer than the tween simply ate
     the move: you skipped the intro card and arrived at the board without ever
     seeing the alley turn. A cap of 50 ms means a stall pauses the move
     instead of finishing it out of sight. */
  if (game.state !== _lastState) { _lastState = game.state; perf.stateAt = performance.now(); }
  if (camTween) updateCamTween(Math.min(rawDt, 0.2));
  else if (game.state !== STATE.LOSE && game.state !== STATE.WIN) updateMovement(dt);

  updateCameraLook(dt, time);

  /* A throw inside the avatar or the rules must never take the frame loop
     down with it — that is the difference between a glitch and a dead game.
     Report once, keep running. */
  try {
    maigo.update(dt, time);
  } catch (err) {
    if (!game._maigoErr) {
      game._maigoErr = (err && err.message) || String(err);
      console.warn('[maigo] update failed:', game._maigoErr);
    }
  }
  try {
    mechanics.update(dt, time);
  } catch (err) {
    if (!game._mechErr) {
      game._mechErr = (err && err.message) || String(err);
      console.warn('[mechanics] update failed:', game._mechErr);
    }
  }
  /* ------------------------------------------------------------------
     SHE HAS TO BE ON STAGE
     In the three states where she belongs on screen, "invisible" is never
     correct for more than a moment: the lost-her kill hides her for 620 ms
     on purpose, and nothing else does. So if she has been missing for two
     seconds while the game expects her, put her back in front of the player.
     This is the net under every other fix: whatever the cause — a lap wash, a
     late download, a poisoned bone, a camera that never turned — the player
     still meets her.
     ------------------------------------------------------------------ */
  updateMaigoWatchdog(rawDt);
  updateHeart(dt);
  updateFlashDim(dt);

  // charge, brown-out, the dead-torch lock (no-op on the two soft floors)
  mechanics.updateBattery(dt);

  // echo-location: the alley widens at the cross-streets. setEcho() itself
  // ignores sub-3% moves, so this is a couple of subtractions per frame and
  // an audio ramp only when the space actually changes.
  if (audio.ready) audio.setEcho(world.echoAt(player.position.z));
  if (game.state === STATE.SELECT && _boardAim === 'mouse') updateBoardAim();
  /* Before syncMobile, so a phone flips its answer row this same frame. */
  if (game.state === STATE.DIALOGUE && !domChoices.answered && game.dialogue) {
    if (performance.now() - game.dialogue.startedAt > 900 && dom.choices.classList.contains('hidden')) {
      ui.showChoices(true);
    }
  }
  syncCursor();
  syncMobile();
  audio.update(dt);
  world.update(dt, time, game);

  // free ambient dread floor in exploration
  if (game.state === STATE.EXPLORE) audio.setDread(0.12);

  // while a full-screen DOM panel is up the alley is just a backdrop:
  // render it at ~12 fps instead of burning the GPU behind the board
  const boardUp = game.state === STATE.INTRO || game.state === STATE.SELECT
    || game.state === STATE.LOSE || game.state === STATE.WIN || game.state === STATE.PAUSED;
  const inTransition = game.state === STATE.BOOT || game.state === STATE.INTRO || game.state === STATE.SELECT;
  const nowMs = performance.now();
  /* While the warm-up owns the renderer we draw nothing at all: presenting a
     prewarm frame is what used to flash a motionless Maigo in a live alley. */
  if (world.prewarming) {
    /* The warm-up owns the renderer for a moment. Held frames are fine on the
       title screen and behind a full-screen panel, but a held frame during the
       intro dissolve is the black out the player sees between the card and the
       board — so during a transition the live frame is allowed through. */
    if (!inTransition) _lastRender = nowMs;
    else if (!boardUp || nowMs - _lastRender > 84) { world.render(); rig.render(); _lastRender = nowMs; }
  } else if (!boardUp || nowMs - _lastRender > 84) {
    world.render();
    rig.render();
    _lastRender = nowMs;
  }

  // the counters are the single source of truth for what is in the corners
  if (rig.clothPieces !== game.blanketsCollected) rig.setCloth(game.blanketsCollected);
  if (rig.candyPieces !== game.candiesCollected) rig.setCandy(game.candiesCollected);
  rig.update(dt, player.speed);
}

boot();
