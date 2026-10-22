/* ============================================================================
   mechanics.js — the rules of the alley
   ----------------------------------------------------------------------------
   • Manifestation trigger past the first vending machine
   • Lead AI + walk-cycle pacing
   • Micro-movement audio trap (15–20 s FREEZE_STATE, 300 ms grace)
   • Forbidden Action Engine — Box3 broad-phase + raycast against a hidden
     collision volume pinned to Maigo-chan's back
   • Vending machine acquisition loop, candy offer, adult protocol state machine
   • The Rust Shift, the neon escape door and the spatial street loop
   ========================================================================== */
import * as THREE from 'three';

export const STATE = {
  BOOT: 'BOOT',
  INTRO: 'INTRO',
  SELECT: 'SELECT',
  EXPLORE: 'EXPLORE',
  DIALOGUE: 'DIALOGUE',
  FOLLOW: 'FOLLOW',
  FREEZE: 'FREEZE',
  CHASE: 'CHASE',
  LOSE: 'LOSE',
  WIN: 'WIN',
  PAUSED: 'PAUSED',
};


/* the states in which a body can be out of breath — hoisted so the breath
   loop allocates nothing in the frame budget */
const LOCOMOTION_STATES = Object.freeze([STATE.EXPLORE, STATE.FOLLOW, STATE.FREEZE, STATE.CHASE]);

export const CLASS = { STUDENT: 'student', ADULT: 'adult' };

const LEAD_WAIT = 11.0;      // she will not run further ahead than this (fog eats 18 m)
const MACHINE_RANGE = 3.0;   // interaction window: vending machine / blanket
const LEAD_REF = 1.5;        // the reference walk the animation was built for
const CATCH_DIST = 1.18;
const CHASE_TIME = 17.0;
const BACK_TRIGGER = 0.5;
const FREEZE_GRACE = 0.30;
const FREEZE_DURATION = 2.35;      // kept for reference; difficulty owns it now

/* ----------------------------------------------------------------------------
   DIFFICULTY
   Only the *pressure* changes: how often she stops, how long she holds still,
   how quickly the giggle comes back, how hard she presses during a chase.
   The rules the design fixed do not move — 300 ms grace, 1500 ms shadow-tag
   window, 60 m, and three items on every route.
   -------------------------------------------------------------------------- */
export const DIFFICULTY = {
  amateur: {
    key: 'amateur', name: 'AMATEUR', jp: '素人',
    freezeEvery: [24, 30], freezeHold: 1.75,
    laughEvery: [13, 19], chaseSpeed: 1.78, chaseTime: 20.0,
    backTrigger: 0.72, dread: 0.82,
    followSpeed: 1.20, followSlow: 0.84,      // m/s · dampened beside a machine
    lostGrace: 8.0, battery: 0,        // 0 = infinite charge
    blurb: 'a slow, almost kind alley',
  },
  professional: {
    key: 'professional', name: 'PROFESSIONAL', jp: '玄人',
    freezeEvery: [15, 20], freezeHold: 2.35,
    laughEvery: [7, 13], chaseSpeed: 2.025, chaseTime: 17.0,
    backTrigger: 0.5, dread: 1.0,
    followSpeed: 1.50, followSlow: 1.05,
    lostGrace: 6.0, battery: 0,
    blurb: 'the intended alley',
  },
  nightmare: {
    key: 'nightmare', name: 'NIGHTMARE', jp: '悪夢',
    freezeEvery: [9, 13], freezeHold: 3.15,
    laughEvery: [4, 8], chaseSpeed: 2.35, chaseTime: 14.0,
    backTrigger: 0.34, dread: 1.22,
    followSpeed: 1.85, followSlow: 1.30,
    lostGrace: 4.5, battery: 45,       // seconds of light
    blurb: 'she is already behind you',
  },
  hell: {
    key: 'hell', name: 'HELL', jp: '地獄',
    freezeEvery: [5.5, 8], freezeHold: 3.9,
    laughEvery: [2.6, 5.2], chaseSpeed: 2.62, chaseTime: 11.5,
    backTrigger: 0.24, dread: 1.42,
    followSpeed: 2.20, followSlow: 1.54,
    lostGrace: 3.5, battery: 30,
    blurb: 'the alley was never going to let you out',
  },
};

export class Mechanics {
  constructor(game) {
    this.game = game;
    this.reset();
  }

  reset() {
    if (this.audio && this.audio.resetVoices) this.audio.resetVoices();
    this.time = 0;
    this.freezeNext = 0;
    this.freeze = null;
    this.backExposure = 0;
    this.backGrace = 0;
    this.backTick = 0;
    this.chase = null;
    this.leadSpeed = 0;            // her own forward speed, damped — see updateLead
    this.leadTarget = 0;
    this.nearMachine = false;
    this.lostT = 0;                // seconds she has been waiting at the edge
    this._lostWarned = 0;
    this._lostKilling = false;
    this.lookTimer = 6 + Math.random() * 5;
    this._breathing = false;
    this._batteryEmpty = false;
    this.protocols = { 1: false, 2: false, 3: false };
    this.doorShown = false;
    this.doorTimer = 0;
    this.cheatLose = false;
    this.candyTaken = 0;
    this.wrapCount = 0;
    this._wrapping = false;

    // ---- CORE LOOPS -----------------------------------------------------
    // student: three wrapped candies from three vending encounters
    // adult A: three blankets, one per loop cycle, from the far pavement
    // adult B: shadow tag — giggle, 1.5 s to stand still, 60 m to escape
    this.game.candiesCollected = 0;
    this.game.blanketsCollected = 0;
    this.diff = DIFFICULTY[this.game.difficulty] || DIFFICULTY.professional;
    this.freezeHold = this.diff.freezeHold;
    this.lap = 0;
    this.vendingUsed = {};              // a fresh row of machines
    this.game.distanceWalkedSinceLastStop = 0.0;   // exertion, metres
    this._breathTimer = 0;
    this._breathArmed = false;
    this._wasMoving = false;
    this._lastStopPos = null;
    this.path = null;              // 'A' | 'B' for the adult
    this.shadow = null;            // shadow-tag state
    this.offerCooldown = 0;
    this._lapPos = null;
    this.hints = { torch: false, freeze: false, candy: false };
    this._prompt = null;
    this._ray = new THREE.Raycaster();
    this._box = new THREE.Box3();
    this._camDir = new THREE.Vector3();
    this._v = new THREE.Vector3();
    this._v2 = new THREE.Vector3();
    this.interact = null;
    this.interactTimer = 0;
    this.audioStepTimer = 0;
  }

  get world() { return this.game.world; }
  get maigo() { return this.game.maigo; }
  get audio() { return this.game.audio; }
  get ui() { return this.game.ui; }
  get player() { return this.game.player; }
  get state() { return this.game.state; }
  set state(v) { this.game.state = v; }

  /* ==================================================================
     PHASE ENTRY
     ================================================================== */
  startExplore() {
    this.state = STATE.EXPLORE;
    this.time = 0;
    this.ui.setObjective('路地の奥へ。', 'Walk to the end of the alley.');
    this.ui.setProtocols(null);
  }

  startFollow() {
    this.state = STATE.FOLLOW;
    this.lostT = 0;
    this._lostKilling = false;
    this._lostWarned = 0;
    this.lookTimer = 6 + Math.random() * 5;
    this.leadSpeed = 0;
    this.leadTarget = 0;
    this.freezeNext = 15 + Math.random() * 5;
    this.backGrace = 2.6;
    this.backExposure = 0;
    this.chase = null;
    this.maigo.setMode('walk');
    this.ui.setObjective('彼女の家まで。', 'Follow her. Do not light her back.');
    if (this.game.classType === CLASS.ADULT) this.syncProtocols();
    else this.ui.setProtocols(null);
    // the adult starts on Path A (blanket containment); Path B is an opt-in
    if (this.game.classType === CLASS.ADULT) {
      this.path = 'A';
      this.spawnBlanketForLap();
      this.ui.setPathTag('BLANKET');
      this.ui.toast('毛布を集めろ（0/3）— [1] 毛布 / [2] 影踏み', 6200);
      this.ui.setObjective('毛布を3枚集め、彼女に掛ける。', 'Collect 3 blankets, cover her while she freezes.');
    }
    const candyHint = this.game.classType === CLASS.STUDENT
      ? 'The vending machine still glows behind you.'
      : '';
    this.ui.toast(this.game.classType === CLASS.STUDENT
      ? 'F — 懐中電灯を消して。彼女の背中を照らさないで。 ' + candyHint
      : 'F — torch off. She feels the light on her back.', 6200);
  }

  /* ==================================================================
     SPATIAL LOOP / QUERIES
     ================================================================== */
  /* The alley is built as a 90 m band that repeats. Walking out of one end
     and into the next is a hard 90 m jump in a place that looks the same —
     on its own that reads as the world glitching. The swap now happens in
     the middle of a slow ink wash (main.js owns the overlay), so the eye
     reads a lamp dying and coming back, not a respawn. */
  wrapCheck() {
    if (this._wrapping) return;
    if (this.player.position.z >= -112) return;
    this._wrapping = true;
    const swap = () => { this.wrapWorld(); this._wrapping = false; };
    if (this.game.wrapTransition) this.game.wrapTransition(swap);
    else swap();
  }

  /** the actual 90 m shift — only ever called at the peak of the wash */
  wrapWorld() {
    const p = this.player.position;
    p.z += 90;
    this.maigo.root.position.z += 90;
    if (this.world.neonDoor?.active) {
      this.world.neonDoor.group.position.z += 90;
      this.world.neonDoor.z += 90;
      this.world.neonLight.position.z += 90;
      const doorIt = this.world.interactables.find((i) => i.kind === 'door');
      if (doorIt) doorIt.position.z += 90;
    }
    this.wrapCount++;
    this.lap++;
    this.vendingUsed = {};                  // a fresh row of machines
    if (this.path === 'A' && this.game.blanketsCollected < 3) this.spawnBlanketForLap();
    this.audio.clothRustle(0.32);
    this._loopNotePending = (this.diff && this.diff.key === 'amateur')
      ? 'また、同じ道。 / The same street again.' : null;
  }

  nearest() {
    const cam = this.game.camera;
    cam.getWorldDirection(this._camDir);
    return this.world.nearestInteractable(cam.position, this._camDir, 3.0);
  }

  /* ==================================================================
     MAIN TICK
     ================================================================== */
  update(dt, time) {
    this.time += dt;
    // a loop note queued by wrapWorld() is shown by main.js once the wash has
    // lifted — writing it during the transition would be text behind ink
    if (this._loopNotePending && !this.game.wrapActive) {
      this.ui.loopNote(this._loopNotePending);
      this._loopNotePending = null;
    }
    const s = this.state;
    if (s === STATE.LOSE || s === STATE.WIN || s === STATE.BOOT || s === STATE.INTRO || s === STATE.SELECT) return;

    // Her matrices are refreshed by the renderer every frame; forcing the
    // whole skeleton here as well doubled that cost for nothing.
    if (!this.maigo.root.matrixWorldNeedsUpdate) { /* nothing to do */ }

    if (s === STATE.EXPLORE) {
      this.checkManifestation();
      this.updatePrompt();
      this.updateBreath(dt);          // the alley listens before she even appears
      return;
    }

    if (s === STATE.FOLLOW || s === STATE.FREEZE || s === STATE.CHASE) {
      this.wrapCheck();
      this.updatePrompt();

      if (s === STATE.CHASE) this.updateChase(dt);
      else if (s === STATE.FREEZE) this.updateFreeze(dt);
      else {
        this.updateLead(dt);
        this.updateLost(dt);
        if (this.path === 'B') this.updateShadow(dt);
        else this.updateFreezeSchedule(dt);
        this.updateForbidden(dt);
      }
      this.updateBreath(dt);
      if (this.offerCooldown > 0) this.offerCooldown -= dt;

      this.updateProtocolAvailability();
      this.updateDoor(dt);
      this.updateDread(dt);
      this.updateAudioSteps(dt);
    }
  }

  /** pull the level's tuning again (the player picks on the board) */
  applyDifficulty(key) {
    const d = DIFFICULTY[key] || DIFFICULTY.professional;
    this.game.difficulty = d.key;
    this.diff = d;
    this.freezeHold = d.freezeHold;
    return d;
  }

  /** a random interval from a [min,max] pair on the active table */
  between(pair) {
    return pair[0] + Math.random() * (pair[1] - pair[0]);
  }

  /* ==================================================================
     FLASHLIGHT CHARGE
     Infinite on Amateur and Professional — the torch is a tool there, not a
     resource. On Nightmare it burns out in 45 s of use, on Hell in 30 s.
     Standing at a vending machine tops it back up.
     ================================================================== */
  nearestVending(p) {
    let best = Infinity;
    const list = this.world && this.world.interactables;
    if (!list) return best;
    for (let i = 0; i < list.length; i++) {
      const it = list[i];
      if (it.kind !== 'vending' || !it.position) continue;
      const d = Math.hypot(p.x - it.position.x, p.z - it.position.z);
      if (d < best) best = d;
    }
    return best;
  }

  updateBattery(dt) {
    const g = this.game;
    const drain = this.diff.battery || 0;         // 0 = infinite
    if (!drain) {
      if (g.battery !== 1) {
        g.battery = 1;
        this.ui.setBattery(null);                 // the chip only exists when it matters
      }
      return;
    }
    if (g.battery === undefined) g.battery = 1;

    const on = this.world.flashlightOn;
    const atMachine = this.nearestVending(this.player.position) <= 3.0;

    if (atMachine) {
      g.battery = Math.min(1, g.battery + dt / 6.5);   // ~6.5 s to full
    } else if (on) {
      g.battery = Math.max(0, g.battery - dt / drain);
    }

    // the beam browns out before it dies
    this.world.batteryDim = g.battery < 0.22 ? 0.35 + g.battery * 3 : 1;

    if (g.battery <= 0 && !this._batteryEmpty) {
      this._batteryEmpty = true;
      if (on) {
        this.world.setFlashlight(false);
        this.ui.setTorch(false);
      }
      this.ui.toast('電池が切れた。自販機の灯りで充電しろ。 / The torch is dead. Recharge at a vending machine.', 5200);
      this.audio.tick(0.03);
    } else if (g.battery > 0.06 && this._batteryEmpty) {
      this._batteryEmpty = false;
    }

    this.ui.setBattery(g.battery, atMachine);
    if (this._batteryEmpty && on) {
      // no light left to give
      this.world.setFlashlight(false);
      this.ui.setTorch(false);
    }
  }

  /** is the torch allowed on right now? */
  torchUsable() {
    return !(this.diff.battery) || (this.game.battery || 0) > 0.001;
  }

  /* ==================================================================
     EXERTION MATRIX — heavy breathing, Nightmare and Hell only.

     Standing still is no longer enough. The lungs only object after real
     work: forty metres of pavement since the boots last stopped. The cycle
     is a strict state machine, so every branch below is O(1) and nothing
     allocates in the frame loop.

        walking   → accumulate the ground covered this frame
        stopping  → distance >= 40 m ? breathe for exactly 6 s : stay silent
        still (6s)→ let the loop fade out and breathe normally again
        walking   → cut the track instantly and zero the accumulator

     The accumulator lives on the game state under the name the system
     update asked for, so other systems can read it.
     ================================================================== */
  updateBreath(dt) {
    const g = this.game;
    const gate = this.diff.key === 'nightmare' || this.diff.key === 'hell';
    if (!gate) {
      if (this._breathing) { this.audio.breathLoop('student', false); this._breathing = false; }
      this._breathTimer = 0;
      this._breathArmed = false;
      g.distanceWalkedSinceLastStop = 0.0;
      this._lastStopPos = null;
      return;
    }

    const alive = LOCOMOTION_STATES.includes(this.state);
    const v = this.player.velocity;
    const speed = Math.hypot(v ? v.x : 0, v ? v.z : 0);
    const moving = alive && (speed > 0.02 || g.input.moving());

    /* ---- 1 · distance covered since the last full stop ---- */
    if (g.distanceWalkedSinceLastStop === undefined) g.distanceWalkedSinceLastStop = 0.0;
    const p = this.player.position;
    if (!this._lastStopPos) this._lastStopPos = { x: p.x, z: p.z };
    if (moving) {
      const dx = p.x - this._lastStopPos.x;
      const dz = p.z - this._lastStopPos.z;
      const step = Math.hypot(dx, dz);
      // a teleport or the loop wrap is not exertion; the alley is 230 m long
      if (step < 1.5) g.distanceWalkedSinceLastStop += step;
      this._lastStopPos.x = p.x;
      this._lastStopPos.z = p.z;
    }

    /* ---- 2 · the edge where locomotion reaches zero ---- */
    if (this._wasMoving === undefined) this._wasMoving = moving;

    if (moving && !this._wasMoving) {
      // resumed: the cycle starts over, and anything audible dies at once
      if (this._breathing) {
        this.audio.breathLoop('student', false);       // 50 ms release, no click
        this._breathing = false;
      }
      this._breathTimer = 0;
      g.distanceWalkedSinceLastStop = 0.0;
      this._lastStopPos.x = p.x;
      this._lastStopPos.z = p.z;
    } else if (!moving && this._wasMoving) {
      // stopped: this is the exact frame the accumulator is judged
      if (g.distanceWalkedSinceLastStop >= 40.0) {
        const who = g.classType === CLASS.ADULT ? 'adult' : 'student';
        this._breathing = true;
        this._breathTimer = 6.0;               // exactly six seconds of rest
        this.audio.breathLoop(who, true);      // 0.55 gain = 50–60 %
      } else {
        this._breathing = false;
        this._breathTimer = 0;
      }
    }
    this._wasMoving = moving;

    /* ---- 3 · the six-second natural expiry ---- */
    if (this._breathing && !moving) {
      this._breathTimer -= dt;
      if (this._breathTimer <= 0) {
        this._breathing = false;
        this._breathTimer = 0;
        if (this.audio.fadeBreath) this.audio.fadeBreath(900);   // catching breath
        else this.audio.breathLoop('student', false);
      }
    }

    // she (or the player) left the walkable states: nothing may keep breathing
    if (!alive && (this._breathing || this.audio.breathing)) {
      this._breathing = false;
      this._breathTimer = 0;
      this.audio.breathLoop('student', false);
    }
  }

  /* ==================================================================
     MANIFESTATION TRIGGER
     ================================================================== */
  checkManifestation() {
    if (this.game.flags.manifested) return;
    if (this.player.position.z < -17.5) {
      this.game.flags.manifested = true;
      this.game.triggerManifestation();
    }
  }

  /* ==================================================================
     LEAD AI — she walks the alley on her own clock.

     This used to be bolted to the player: release W and her target speed
     became zero, so she stopped dead a few metres up the road. A lost child
     leading you home does not wait for you to press a key — her forward
     translation is now driven only by delta time and her own target speed:

        maigo.root.position.z += targetSpeed * dt      (forward is -Z)

     Two modifiers, both positional:
       · interaction window — inside 3.0 m of a vending machine or a blanket
         she drops to the dampened speed (0.70 × base, i.e. 30 %) so the
         player has a moment to actually use the thing;
       · tether — once she is LEAD_WAIT metres ahead she stops and turns to
         watch you catch up. Without it she would walk off the end of the
         alley and the follow loop would simply be broken.

     The speed itself is damped, never stepped, so the first frame after a
     freeze, a dialogue or a floor change can never snap her forward.
     ================================================================== */

  /** metres to the nearest vending machine / blanket (Infinity if none) */
  nearestMachine(p) {
    let best = Infinity;
    const list = this.world && this.world.interactables;
    if (!list) return best;
    for (let i = 0; i < list.length; i++) {
      const it = list[i];
      if (it.kind !== 'vending' && it.kind !== 'blanket') continue;
      const q = it.position;
      if (!q) continue;
      const dx = p.x - q.x, dz = p.z - q.z;
      const d = Math.sqrt(dx * dx + dz * dz);
      if (d < best) best = d;
    }
    return best;
  }

  updateLead(dt) {
    const m = this.maigo;
    if (!m.root.visible) return;
    if (m._turning) return;                        // a turn gesture owns her pose

    const p = this.player.position;
    const gap = p.z - m.root.position.z;           // > 0 while she is ahead

    // ---- 1. base speed, straight from the floor tag ---------------
    const d = this.diff;
    let target = d.followSpeed;
    let targetNear = d.followSlow;

    // ---- 2. the interaction window --------------------------------
    const machineDist = this.nearestMachine(p);
    this.nearMachine = machineDist <= MACHINE_RANGE;
    if (this.nearMachine) target = targetNear;

    // ---- 3. governors (positions only — never the player's velocity)
    if (gap > LEAD_WAIT) target = 0;               // far enough ahead: wait
    else if (gap < 0.8) target *= 1.6;             // walked through her: recover

    this.leadTarget = target;

    // ---- 4. damped, framerate independent -------------------------
    const rate = target > this.leadSpeed ? 3.0 : 7.0;
    this.leadSpeed = THREE.MathUtils.damp(this.leadSpeed, target, rate, dt);
    if (this.leadSpeed < 0.004) this.leadSpeed = 0;

    if (this.leadSpeed > 0) {
      m.root.position.z = Math.max(-215, m.root.position.z - this.leadSpeed * dt);
    }

    // x drift, clamped inside the alley
    const targetX = Math.sin(this.time * 0.23) * 0.5;
    const dx = targetX - m.root.position.x;
    m.root.position.x += Math.max(-0.7 * dt, Math.min(0.7 * dt, dx));

    // ---- 5. pose ---------------------------------------------------
    const walking = this.leadSpeed > 0.06;
    if (walking) {
      const targetYaw = Math.PI;                   // -Z
      const cur = m.root.rotation.y;
      const delta = ((targetYaw - cur + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
      m.root.rotation.y = cur + delta * Math.min(1, dt * 4.5);
    } else if (gap > LEAD_WAIT - 2.0) {
      // waiting for you: she turns round and watches you catch up
      const yaw = Math.atan2(p.x - m.root.position.x, p.z - m.root.position.z);
      const cur = m.root.rotation.y;
      const delta = ((yaw - cur + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
      m.root.rotation.y = cur + delta * Math.min(1, dt * 2.2);
    }
    m.setMode(walking ? 'walk' : 'idle');
    // cadence follows the ground speed; 1.5 m/s is the walk the rig was built for
    if (m.setPace) m.setPace(Math.max(0.55, Math.min(1.55, this.leadSpeed / LEAD_REF)));

    /* ---- she keeps her eyes on you -------------------------------------
       A lost child does not stop watching the person she is following just
       because she has turned her back on them. The head solves the angle to
       the player every frame; while walking it is held to a shoulder glance,
       while she is waiting she is allowed the whole neck. */
    if (m.setLookAt) {
      this._lookAt = this._lookAt || new THREE.Vector3();
      this._lookAt.set(p.x, p.y + 1.55, p.z);
      m.setLookAt(this._lookAt, walking ? 0.62 : 1.15);
    }

    /* ---- the look-back twitch (Nightmare / Hell) -----------------------
       Randomly, mid-stride, her neck snaps 45° over her shoulder while her
       body keeps walking. It is a 55 ms attack on a rig that is otherwise
       smoothed over 200 ms, which is why it reads as wrong. */
    const twitchy = this.diff.key === 'nightmare' || this.diff.key === 'hell';
    if (twitchy && walking) {
      this.lookTimer -= dt;
      if (this.lookTimer <= 0) {
        this.lookTimer = (this.diff.key === 'hell' ? 3.2 : 5.0) + Math.random() * 3.6;
        if (m.jerkLook) m.jerkLook();
        this.audio.tick(0.02);
      }
    }

    if (walking && !this.hints.torch) {
      this.hints.torch = true;
      this.game.audio.setDread(0.35);
    }
  }

  /* ==================================================================
     "DON'T LEAVE ME" — she is a lost child. Lose sight of her and she
     does not simply wait: she stops, decides you are not coming, and
     arrives behind you instead.
     ================================================================== */
  updateLost(dt) {
    if (this._lostKilling) return;
    const m = this.maigo;
    if (!m.root.visible) { this.lostT = 0; return; }
    const gap = this.player.position.z - m.root.position.z;

    // she only starts counting when she has actually reached the tether
    if (gap < LEAD_WAIT - 1.2) {
      this.lostT = 0;
      this._lostWarned = 0;
      return;
    }
    this.lostT += dt;
    const grace = this.diff.lostGrace || 6;

    if (this.lostT > 0.4 && this._lostWarned === 0) {
      this._lostWarned = 1;
      this.ui.toast('彼女は、待っている。 / She is waiting for you.', 3600);
      this.audio.setDread(0.55);
    } else if (this.lostT > grace * 0.62 && this._lostWarned === 1) {
      this._lostWarned = 2;
      this.audio.whisperSorry();
      this.audio.setDread(0.8);
    }
    if (this.lostT >= grace) this.beginLostKill();
  }

  /** she vanishes where she stands and is behind you when she comes back */
  beginLostKill() {
    if (this._lostKilling) return;
    this._lostKilling = true;
    const m = this.maigo;

    this.audio.vanish();
    this.audio.clothRustle(0.5);
    this.game.shakeCamera(0.03, 0.7);
    this.ui.setPrompt(null);
    m.root.visible = false;

    // the alley notices: the light drops, the fog thickens for a breath
    this.world.setDread(1.0);

    setTimeout(() => {
      const p = this.player.position;
      const yaw = this.game.player.yaw;
      // directly behind the camera
      const bx = p.x + Math.sin(yaw) * 1.15;
      const bz = p.z + Math.cos(yaw) * 1.15;
      m.root.position.set(bx, 0, bz);
      m.root.visible = true;
      if (m.face) m.face(new THREE.Vector3(p.x, 1.2, p.z));
      if (m.attackPose) m.attackPose();
      this.audio.whisperSorry();
      this.audio.clothRustle(1.3);
    }, 620);

    setTimeout(() => {
      this.game.lose(
        'YOU LEFT HER.',
        'She waited at the edge of the light, and you did not come.',
        'Never let her walk out of reach. Keep her inside the lamp.',
        { behind: true }
      );
    }, 1180);
  }

  /* ==================================================================
     FREEZE TRAP
     ================================================================== */
  updateFreezeSchedule(dt) {
    if (this.freeze) return;
    this.freezeNext -= dt;

    /* The warning is a courtesy, so only the courtesy floor gets it. On
       Amateur the torch stutters for the last fifth of a second before she
       halts; on the three harder floors the halt simply happens. */
    if (this.diff.key === 'amateur' && !this._freezeWarned && this.freezeNext <= 0.2 && this.freezeNext > -0.5) {
      this._freezeWarned = true;
      this.world.flashFlicker(0.2);
      this.audio.tick(0.035);
    }

    if (!this.hints.freeze && this.freezeNext < 6) {
      this.hints.freeze = true;
      this.ui.toast('彼女が止まったら、完全に動かないで。 / If she stops, stop moving.', 4200);
    }
    if (this.freezeNext <= 0) this.beginFreeze();
  }

  beginFreeze() {
    this.state = STATE.FREEZE;
    this._freezeWarned = false;
    this.freeze = { t: 0, mouse: 0, grace: FREEZE_GRACE };
    this.maigo.setMode('freeze');
    this.audio.clothRustle(0.8);
    this.audio.tick(0.05);
    this.game.input.freezeNoise = 0;
    this.ui.setFreeze(true, 0);
    this.ui.setBackAlert(false, 0);
    this.backExposure = 0;
    this.game.world.setDread(0.45);
  }

  updateFreeze(dt) {
    const f = this.freeze;
    if (!f) return;
    f.t += dt;

    // consume the look delta accumulated by main.js — mouse on a PC, the
    // right-hand touch pad on a phone. One counter, both devices.
    const noise = this.game.input.freezeNoise || 0;
    this.game.input.freezeNoise = 0;
    const mobile = this.game.isMobile;

    if (f.t > FREEZE_GRACE) {
      if (!f.graceCleared) {
        f.graceCleared = true;
        this.game.input.freezeNoise = 0;
      }
      if (this.game.input.moving()) {
        this.failFreeze('You moved while she was listening.',
          mobile ? 'Let go of the joystick within 300 ms of her halt.'
                 : 'WASD movement must stop within 300 ms of her halt.');
        return;
      }
      if (noise > 7) {
        this.audio.gravelScrape();
        this.failFreeze('The gravel betrayed you.',
          mobile ? 'Do not touch the look pad while she is frozen.'
                 : 'Do not touch the mouse or trackpad while she is frozen.');
        return;
      }
    }

    const progress = Math.min(1, f.t / this.freezeHold);
    this.ui.setFreeze(true, progress);
    this.game.world.setDread(0.5 + Math.sin(f.t * 5) * 0.08);

    if (f.t >= this.freezeHold) {
      this.ui.setFreeze(false, 1);
      this.maigo.setMode('walk');
      this.freeze = null;
      this.state = STATE.FOLLOW;
      const base = this.between(this.diff.freezeEvery);
      this.freezeNext = this.protocols[2] ? Math.max(5, base * 0.55) : base;
      this._freezeWarned = false;
      this.backGrace = 1.2;
      this.audio.clothRustle(0.35);
      this.game.world.setDread(0.35);
    }
  }

  failFreeze(reason, tip) {
    this.ui.setFreeze(false, 1);
    this.freeze = null;
    this.audio.gravelScrape();
    this.game.lose('SHE HEARD YOU.', reason, tip);
  }

  /* ==================================================================
     FORBIDDEN ACTION ENGINE
     ================================================================== */
  updateForbidden(dt) {
    if (this.backGrace > 0) {
      this.backGrace -= dt;
      this.burnBack(dt, false);
      return;
    }
    const m = this.maigo;
    const cam = this.game.camera;

    // her back must be turned toward the player
    const info = m.backZoneInfo();
    const toMaigo = this._v.copy(m.root.position).sub(this.player.position);
    toMaigo.y = 0;
    const facingAway = info.forward.dot(toMaigo.normalize()) > 0.25;
    const on = this.world.flashlightOn;

    if (!on || !facingAway) {
      this.burnBack(dt, false);
      return;
    }

    // broad-phase Box3, then exact ray intersection against the hidden volume
    this._box.setFromObject(info.mesh);
    this._box.expandByScalar(0.06);
    cam.getWorldDirection(this._camDir);
    const dist = cam.position.distanceTo(info.position);
    if (dist > 13) { this.burnBack(dt, false); return; }

    const ray = new THREE.Ray(cam.position.clone(), this._camDir.clone());
    if (!ray.intersectsBox(this._box)) {
      this.burnBack(dt, false);
      return;
    }

    this._ray.set(cam.position, this._camDir);
    this._ray.far = 14;
    const hits = this._ray.intersectObject(info.mesh, false);
    if (hits.length) {
      this.burnBack(dt, true);
    } else {
      this.burnBack(dt, false);
    }
  }

  burnBack(dt, exposed) {
    if (exposed) {
      this.backExposure += dt;
      this.backTick -= dt;
      if (this.backTick <= 0) {
        this.audio.tick(0.035 + this.backExposure * 0.12);
        this.backTick = 0.085;
      }
      const ratio = Math.min(1, this.backExposure / this.diff.backTrigger);
      this.ui.setBackAlert(true, ratio);
      this.game.world.setDread(0.55 + ratio * 0.4);
      this.game.world.flashRed(ratio * 0.14);
      if (this.backExposure >= this.diff.backTrigger) {
        this.ui.setBackAlert(false, 0);
        this.game.lose(
          'SHE FELT THE LIGHT.',
          'You kept the torch on her bare back for longer than half a second.',
          'Turn the torch off (F) or look away the instant the ticking starts.'
        );
      }
    } else {
      this.backExposure = Math.max(0, this.backExposure - dt * 2.4);
      if (this.backExposure <= 0.001) this.ui.setBackAlert(false, 0);
      else this.ui.setBackAlert(true, this.backExposure / this.diff.backTrigger);
    }
  }

  /* ==================================================================
     CHASE PROTOCOL
     ================================================================== */
  beginChase() {
    const m = this.maigo;
    const p = this.player.position;
    // she slips behind you — through the fog
    m.root.position.set(
      THREE.MathUtils.clamp(p.x + (Math.random() - 0.5) * 1.4, -1.4, 1.4),
      0,
      Math.min(p.z + 5.2, 10.5)
    );
    m.root.rotation.y = Math.atan2(p.x - m.root.position.x, p.z - m.root.position.z);
    m.setMode('chase');
    this.state = STATE.CHASE;
    this.chase = { t: 0 };
    this.ui.setFreeze(false, 1);
    this.ui.setBackAlert(false, 0);
    this.ui.setObjective('走れ。振り返るな。', 'RUN. Do not let her reach you.');
    this.ui.toast('「家に子供がいるの」 — She knows you lied.', 4200);
    this.audio.stinger();
    this.game.world.setDread(0.9);
    this.game.shakeCamera(0.16, 1.4);
  }

  updateChase(dt) {
    const c = this.chase;
    if (!c) return;
    c.t += dt;
    const m = this.maigo;
    const p = this.player.position;
    const dx = p.x - m.root.position.x;
    const dz = p.z - m.root.position.z;
    const dist = Math.hypot(dx, dz);

    // face + charge
    const yaw = Math.atan2(dx, dz);
    m.root.rotation.y = yaw;
    m.setMode('chase');

    const speed = this.diff.chaseSpeed; // scales with the chosen level
    if (dist > 0.02) {
      const step = Math.min(speed * dt, Math.max(0, dist - 0.4));
      m.root.position.x += (dx / dist) * step;
      m.root.position.z += (dz / dist) * step;
    }
    m.root.position.x = THREE.MathUtils.clamp(m.root.position.x, -1.45, 1.45);

    this.ui.setFreeze(false, 1);
    this.ui.setBackAlert(false, 0);
    this.backExposure = 0;
    this.game.ui.setChaseMeter(c.t / this.diff.chaseTime);
    this.game.world.setDread(0.9);

    if (dist < CATCH_DIST) {
      this.game.lose(
        'SHE CAUGHT YOU.',
        'You told her you had a child at home. She wanted to meet them.',
        'Keep sprinting down the alley — never let the gap close.'
      );
      return;
    }

    if (c.t >= this.diff.chaseTime) {
      this.endChase();
    }
  }

  endChase() {
    this.chase = null;
    this.game.ui.setChaseMeter(-1);
    const p = this.player.position;
    // she vanishes in the fog, then is ahead again, walking
    this.maigo.root.position.set(THREE.MathUtils.clamp(Math.sin(this.time) * 0.5, -1.1, 1.1), 0, p.z - 5.4);
    this.maigo.root.rotation.y = Math.PI;
    this.maigo.setMode('walk');
    this.state = STATE.FOLLOW;
    this.freezeNext = 9 + Math.random() * 4;
    this.backGrace = 2.0;
    this.backExposure = 0;
    this.ui.setObjective('彼女の家まで。', 'Follow her. Do not light her back.');
    this.ui.toast('彼女は止まった。また歩き出す。 / She stopped. Then she walked on.', 3600);
    this.audio.clothRustle(0.9);
    this.game.world.setDread(0.5);
  }

  /* ==================================================================
     ADULT PROTOCOLS
     ================================================================== */
  syncProtocols() {
    this.ui.setProtocols({
      used: this.protocols,
      door: this.doorShown,
      classType: this.game.classType,
    });
  }

  updateProtocolAvailability() {
    if (this.game.classType !== CLASS.ADULT) return;
    const avail = {
      1: this.state === STATE.FOLLOW,
      2: this.state === STATE.FOLLOW && this.path !== 'B',
      3: this.doorShown,
    };
    this.ui.setProtocolAvailability(avail);
  }

  showProtocolHUD() {
    if (this.game.classType !== CLASS.ADULT) { this.ui.setProtocols(null); return; }
    this.syncProtocols();
  }

  useProtocol(n) {
    if (this.state === STATE.LOSE || this.state === STATE.WIN) return;
    if (this.game.classType !== CLASS.ADULT) {
      this.ui.toast('大人の事情は、大人にしか分からない。 / Only an adult can try that.', 2800);
      return;
    }
    if (this.state !== STATE.FOLLOW) {
      this.ui.toast('今ではない。 / Not now.', 2200);
      return;
    }
    if (n === 1) {
      // PATH A — the blanket route
      this.protocols[1] = true;
      this.syncProtocols();
      if (this.path === 'B') {
        this.path = 'A';
        this.shadow = null;
        this.ui.showShadowTrap(false, 0);
        this.spawnBlanketForLap();
        this.ui.setPathTag('BLANKET');
        this.ui.setObjective('毛布を3枚集め、彼女に掛ける。', 'Collect 3 blankets, cover her while she freezes.');
        this.ui.toast('毛布に戻る。 / Back to the blankets.', 2600);
      } else {
        this.ui.toast(`毛布 ${this.game.blanketsCollected}/3 ・ 彼女が止まったら [E] / ${this.game.blanketsCollected}/3 — press E while she freezes.`, 3600);
      }
      return;
    }
    if (n === 2) {
      // PATH B — shadow tag replaces the freeze rule entirely
      this.protocols[2] = true;
      this.syncProtocols();
      this.startPathB();
      return;
    }
    if (n === 3) {
      if (!this.doorShown) {
        this.game.lose(
          'TOO EARLY.',
          'You reached for her hand before the convenience-store light appeared.',
          'The hand-grab only works when the neon escape door is visible down the road.'
        );
        return;
      }
      const door = this.world.neonDoor;
      const d = Math.hypot(this.player.position.x - door.group.position.x, this.player.position.z - door.z);
      if (d > 4.0) {
        this.ui.toast('まだ灯りが遠い。 / The door is still far.', 2400);
        return;
      }
      this.grabHand();
    }
  }

  beginRustShift() {
    this.world.setRustShift(true);
    this.audio.rustShift();
    this.game.shakeCamera(0.24, 2.2);
    this.ui.toast('RUST SHIFT — 壁が錆びていく。', 4200);
    this.doorTimer = 2.8;
    this.freezeNext = Math.min(this.freezeNext, 7);
    this.game.world.flashRed(0.22);
    this.ui.setObjective('灯りを探せ。', 'Find the convenience-store light.');
    this.syncProtocols();
  }

  updateDoor(dt) {
    if (this.doorTimer > 0) {
      this.doorTimer -= dt;
      if (this.doorTimer <= 0 && !this.doorShown) {
        this.doorShown = true;
        this.world.setDoorAhead(this.player.position.z);
        this.audio.doorChime();
        this.ui.toast('コンビニの灯りが見える。 / A convenience store light ahead.', 4400);
        this.syncProtocols();
      }
    }
    if (this.doorShown) {
      // the door is the win switch for the adult class
      const door = this.world.neonDoor;
      if (door) this.world.neonLight.intensity = 7 + Math.sin(this.time * 3) * 1.5;
    }
  }

  grabHand() {
    this.audio.clothRustle(1.0);
    this.game.win('door');
  }

  /* ==================================================================
     VENDING LOOP + CANDY
     ================================================================== */
  updatePrompt() {
    this.interactTimer -= 1 / 60;
    if (this.interactTimer > 0) return;
    this.interactTimer = 0.08;

    if (this.state === STATE.CHASE) { this.ui.setPrompt(null); return; }

    const it = this.nearest();
    let prompt = null;
    if (it) {
      if (it.kind === 'vending') {
        if (this.game.classType === CLASS.STUDENT) {
          const taken = this.vendingUsed[String(it.data.z)] === this.lap;
          prompt = this.game.candiesCollected >= 3
            ? { key: 'E', text: 'ポケットは一杯 / Pockets full' }
            : taken
              ? { key: 'E', text: '空だ / Empty' }
              : { key: 'E', text: `キャンディを取る ${this.game.candiesCollected}/3` };
        } else {
          prompt = { key: 'E', text: 'ボタンを押す / Press the button' };
        }
      } else if (it.kind === 'blanket') {
        prompt = { key: 'E', text: `毛布を拾う ${this.game.blanketsCollected}/3 / Take the blanket` };
      } else if (it.kind === 'door' && this.game.classType === CLASS.ADULT && this.doorShown) {
        prompt = { key: '3', text: '手を握る / Take her hand' };
      }
    }
    if (JSON.stringify(prompt) !== JSON.stringify(this._prompt)) {
      this._prompt = prompt;
      this.ui.setPrompt(prompt);
      this.game.crosshairHot(!!prompt);
    }
  }

  tryInteract() {
    if (this.state !== STATE.FOLLOW && this.state !== STATE.FREEZE) return;
    // during the freeze the interaction key is the offering, not a pickup
    if (this.state === STATE.FREEZE) { this.attemptOffer(); return; }
    const it = this.nearest();
    if (!it) return;
    if (it.kind === 'vending') {
      if (this.game.classType === CLASS.ADULT) {
        /* Both identities can take a sweet out of the machine — the adult just
           pays for it instantly: the poster on the board says no candy allowed,
           and trap detection is the whole point of that line. The wrapper shows
           in the corner for the half second before the screen goes red. */
        if (this.game.candiesCollected < 3) {
          this.game.candiesCollected++;
          this.world.takeVendingCandy(it.data.z);
          this.ui.setCandy(this.game.candiesCollected, 3);
        }
        this.vendingCheat();
        return;
      }
      const key = String(it.data.z);
      if (this.vendingUsed[key] === this.lap) {
        this.ui.toast('もう空だ。 / This machine is empty.', 1800);
        return;
      }
      if (this.game.candiesCollected >= 3) {
        this.ui.toast('ポケットはもう一杯だ。 / Your pockets are full.', 1800);
        return;
      }
      this.vendingUsed[key] = this.lap;
      this.audio.vendingBuy();
      this.world.takeVendingCandy(it.data.z);      // the window empties in step
      this.game.candiesCollected++;
      this.ui.setCandy(this.game.candiesCollected, 3);
      this.ui.toast(`包まれたキャンディ ${this.game.candiesCollected}/3 ・ [E] 差し出す / Candy ${this.game.candiesCollected}/3 — offer it while she freezes.`, 4200);
      this.game.world.flashRed(0.0);
      this.hints.candy = true;
      this.updatePrompt();
      return;
    }
    if (it.kind === 'blanket') {
      this.audio.clothRustle(0.9);
      this.game.blanketsCollected++;
      this.world.hideBlanket();
      this.ui.setBlanket(this.game.blanketsCollected, 3);
      this.ui.toast(`毛布 ${this.game.blanketsCollected}/3 ・ 彼女が止まったら [E] / Blanket ${this.game.blanketsCollected}/3 — cover her while she freezes.`, 4200);
      this.updatePrompt();
      return;
    }
    if (it.kind === 'door' && this.game.classType === CLASS.ADULT) {
      if (this.doorShown) this.useProtocol(3);
    }
  }

  offerCandy() {
    if (this.state === STATE.FREEZE) { this.attemptOffer(); return; }
    if (this.game.classType === CLASS.ADULT) {
      this.ui.toast('彼女が止まった時にしか、渡せない。 / Only while she is still.', 2400);
      return;
    }
    if (this.game.candiesCollected <= 0) {
      this.ui.toast('何も持っていない。 / You have nothing to offer.', 2200);
      return;
    }
    this.ui.toast('彼女が止まった時に。 / Wait until she stops.', 2400);
  }

  /* ------------------------------------------------------------------
     THE OFFERING — only legal inside FREEZE_STATE
     ------------------------------------------------------------------ */
  attemptOffer() {
    if (this.state !== STATE.FREEZE) return;
    if (this.offerCooldown > 0) return;
    this.offerCooldown = 1.2;

    const student = this.game.classType !== CLASS.ADULT;
    const have = student ? this.game.candiesCollected : this.game.blanketsCollected;
    const total = 3;

    if (have < total) {
      this.audio.tick(0.05);
      this.ui.toast(student
        ? `まだ足りない。 ${have}/3 / Not enough candy yet.`
        : `まだ足りない。 ${have}/3 / Not enough blankets yet.`, 2400);
      return;
    }
    this.game.flags.offered = true;
    if (student) this.game.win('safe-return');
    else this.game.win('escaped-loop');
  }

  /* ------------------------------------------------------------------
     PATH A — a blanket on the far pavement, one per loop cycle
     ------------------------------------------------------------------ */
  spawnBlanketForLap() {
    if (!this.world.showBlanket) return;
    /* The cloth lies on the ground directly opposite a machine — across the
       alley from it, never beside it — so a lap alternates between the two
       vending fronts and the player always crosses the road to reach it. */
    const z = ((this.lap || 0) % 2 === 0) ? -15.5 : -62;
    this.world.showBlanket(z);
    this.ui.setBlanket(this.game.blanketsCollected, 3);
  }

  /* ------------------------------------------------------------------
     PATH B — SHADOW TAG
     giggle at random → 1.5 s to be completely still → 60 m to escape
     ------------------------------------------------------------------ */
  startPathB() {
    if (this.game.classType !== CLASS.ADULT || this.path === 'B') return;
    this.path = 'B';
    this.world.hideBlanket();
    this.freeze = null;
    this.ui.setFreeze(false, 0);
    this.shadow = {
      next: this.between(this.diff.laughEvery) * 0.6,
      open: false, t: 0, meters: 0, still: 0,
      last: this.player.position.clone(), speed: 0,
    };
    this.audio.heartbeat(0.6);
    this.ui.setObjective('影踏み — 笑い声がしたら止まれ。', 'SHADOW TAG — when the giggle comes, freeze.');
    this.ui.toast('影踏み。笑い声がしたら、1.5秒で止まれ。60mで終わる。', 6200);
    this.ui.setPathTag('SHADOW TAG');
  }

  updateShadow(dt) {
    const sh = this.shadow;
    if (!sh) return;
    const p = this.player.position;

    // distance walked, horizontally
    const dx = p.x - sh.last.x, dz = p.z - sh.last.z;
    const step = Math.hypot(dx, dz);
    if (step < 2.5) sh.meters += step;         // ignore the loop teleport
    sh.last.copy(p);
    sh.speed = step / Math.max(dt, 1e-4);

    if (sh.meters >= 60 && !this._shadowWon) {
      this._shadowWon = true;
      this.audio.whisperSorry();
      this.ui.setObjective('…', '…');
      setTimeout(() => this.game.win('awakening'), 2400);
      return;
    }

    // what counts as "moving" depends on which hands the player is using
    const mobile = this.game.isMobile;
    const look = this.game.input.consumeLook();
    sh.lookNoise = (sh.lookNoise || 0) + look;
    const controlsLive = this.game.input.moving() || sh.speed > 0.12 ||
      (mobile ? sh.lookNoise > 2 : sh.lookNoise > 2);

    if (!sh.open) {
      sh.next -= dt;
      if (sh.next <= 0) {
        sh.open = true;
        sh.t = 0;
        sh.still = 0;
        sh.lookNoise = 0;
        this.game.input.freezeNoise = 0;
        // spatialise: which side of the player is she on right now?
        let pan = 0;
        try {
          const cam = this.game.camera;
          const to = new THREE.Vector3().subVectors(this.maigo.root.position, cam.position);
          const right = new THREE.Vector3(1, 0, 0).applyQuaternion(cam.quaternion);
          const flat = Math.hypot(to.x, to.z) || 1;
          pan = THREE.MathUtils.clamp(right.dot(to) / flat, -1, 1) * 0.85;
        } catch (e) { pan = 0; }
        this.audio.childLaugh(pan);
        this.ui.showShadowTrap(true, 1);
        void d;
      }
      return;
    }

    sh.t += dt;
    this.ui.showShadowTrap(true, Math.max(0, 1 - sh.t / 1.5));

    if (sh.t > 1.5 && controlsLive) {
      sh.open = false;
      this.ui.showShadowTrap(false, 0);
      // lose() owns the scare now: one slam, not two on top of each other
      this.game.lose('SHE HEARD YOUR STEPS.', 'You moved while the giggle was still in the air.',
        mobile ? 'SHADOW TAG: 1.5 s after the laugh, the stick and the look pad must both be still.'
               : 'SHADOW TAG: 1.5 s after the laugh, keys and mouse must both be still.');
      return;
    }

    if (sh.t > 3.4) {
      sh.open = false;
      this.ui.showShadowTrap(false, 0);
      sh.next = this.between(this.diff.laughEvery);
      this.ui.toast(`生き延びた。 ${Math.max(0, Math.round(60 - sh.meters))}m / Survived.`, 1800);
    }
  }

  vendingCheat() {
    if (this.cheatLose) return;
    this.cheatLose = true;
    this.audio.candyWrapper();
    this.audio.clothRustle(1.2);
    this.game.lose(
      'SHE SAW THE CANDY.',
      'An adult cannot bribe a lost child with sweets. She recognised the trick instantly.',
      'The candy loop belongs to the Student. An adult has to survive her protocols.'
    );
  }

  /* ==================================================================
     ATMOSPHERE / AUDIO DRIVERS
     ================================================================== */
  updateDread(dt) {
    if (!this.maigo.root.visible) return;
    const d = this.player.position.distanceTo(this.maigo.root.position);
    let dread = THREE.MathUtils.clamp(1 - (d - 2.2) / 11, 0, 0.75);
    if (this.state === STATE.FREEZE) dread = Math.max(dread, 0.6);
    if (this.state === STATE.CHASE) dread = 0.95;
    this.audio.setDread(dread);
    this.world.setDread(this.state === STATE.CHASE ? 0.95 : dread * 0.8);
  }

  updateAudioSteps(dt) {
    // her footsteps, timed to the walk-cycle, panned to her position
    const speed = this.maigo.mode === 'chase' ? 4.4 : this.maigo.mode === 'walk' ? 2.6 : 0;
    if (!speed) { this.audioStepTimer = 0; return; }
    this.audioStepTimer -= dt;
    if (this.audioStepTimer <= 0) {
      this.audioStepTimer = speed === 4.4 ? 0.20 : 0.34;
      const pan = THREE.MathUtils.clamp(
        (this.maigo.root.position.x - this.player.position.x) / 3, -1, 1
      );
      const mp = this.maigo.root.position;
      if (this.world.inPuddle && this.world.inPuddle(mp.x, mp.z)) {
        this.world.splashRipple(mp.x, mp.z, 0.5);
        this.audio.puddleStep(0.3, pan * 0.7);
      } else {
        this.audio.footstep(0.25, pan * 0.7);
      }
    }
  }

  /* ==================================================================
     CAMERA TARGET HELPERS
     ================================================================== */
  freezeCameraTarget() {
    const head = this.maigo.headWorldPosition();
    return head.clone().add(new THREE.Vector3(0, -0.02, 0));
  }
}
