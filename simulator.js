// ============================================================================
// simulator.js — Arduino-subset transpiler + coroutine driver + flight physics
// ----------------------------------------------------------------------------
// This module owns all *simulation* concerns: turning the user's sketch into
// runnable JS, driving it as a set of coroutines so blocking-style delay()
// calls never freeze the tab, and a small physics integrator that turns
// stick/telemetry values into altitude, heading, and drift. Rendering and DOM
// concerns live entirely in ui.js.
// ============================================================================

/* ---------------- Shared math helpers ---------------- */

export function clamp(v, a, b) {
  return Math.max(Math.min(v, Math.max(a, b)), Math.min(a, b));
}
export function mapRange(x, inMin, inMax, outMin, outMax) {
  return ((x - inMin) * (outMax - outMin)) / (inMax - inMin) + outMin;
}
export function normalizeStick(v, lo, hi) {
  v = Number(v) || 0;
  if (Math.abs(v) > 200) {
    // looks like a microsecond PWM value (1000-2000)
    if (lo === 0) return clamp(mapRange(v, 1000, 2000, 0, 100), lo, hi);
    return clamp(mapRange(v, 1000, 2000, -100, 100), lo, hi);
  }
  return clamp(v, lo, hi);
}

/* ---------------- Shared vehicle + drone state ---------------- */

export const VEHICLES = {
  QUAD: { id: 'QUAD', label: 'Quadcopter', arms: 4 },
  HEX: { id: 'HEX', label: 'Hexacopter', arms: 6 }
};

export const simState = {
  vehicle: 'QUAD'
};
export function setVehicle(id) {
  if (VEHICLES[id]) simState.vehicle = id;
}

// Single shared source of truth for the aircraft's commanded state. Both the
// transpiled sketch (via drone.* calls / Serial telemetry) and manual
// quick-control buttons in ui.js read and write this same object — whichever
// writes last wins, exactly like a real transmitter with a stick override.
export const droneState = {
  throttle: 0, yaw: 0, pitch: 0, roll: 0,
  armed: false, flightMode: 'ANGLE',
  cameraTilt: 0, speed: 0
};
export function resetDroneState() {
  Object.assign(droneState, {
    throttle: 0, yaw: 0, pitch: 0, roll: 0,
    armed: false, flightMode: 'ANGLE', cameraTilt: 0, speed: 0
  });
}

/* ---------------- Transpiler ---------------- */

const TYPE_RE =
  '(?:unsigned\\s+long|unsigned\\s+int|unsigned\\s+char|long\\s+long|int|long|float|double|byte|bool|boolean|char|String|void|uint8_t|uint16_t|uint32_t|int8_t|int16_t|int32_t|size_t)';
const DEF_RE = new RegExp('\\b(' + TYPE_RE + ')\\s+(\\w+)\\s*\\(([^)]*)\\)\\s*\\{', 'g');

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}
function stripPreprocessor(src) {
  src = src.replace(/^\s*#include.*$/gm, '');
  src = src.replace(/^\s*#define\s+(\w+)\s+(.+)$/gm, 'const $1 = $2;');
  return src;
}
function stripParamTypes(params) {
  if (!params.trim()) return '';
  return params
    .split(',')
    .map((p) => {
      p = p.trim();
      p = p.replace(new RegExp('^' + TYPE_RE + '\\s*[\\*&]?\\s*'), '');
      p = p.replace(/\[\]$/, '');
      return p.trim();
    })
    .filter(Boolean)
    .join(', ');
}
function findFunctionNames(src) {
  const names = new Set();
  let m;
  DEF_RE.lastIndex = 0;
  while ((m = DEF_RE.exec(src))) names.add(m[2]);
  return names;
}
function transformDefinitions(src) {
  return src.replace(DEF_RE, (full, type, name, params) => `function* ${name}(${stripParamTypes(params)}){`);
}
function injectYields(src, names) {
  names.forEach((name) => {
    const re = new RegExp('(?<!function\\*\\s)\\b' + name + '\\s*\\(', 'g');
    src = src.replace(re, `yield* ${name}(`);
  });
  return src;
}
function stripVarDeclTypes(src) {
  const re = new RegExp('(^|[{};\\n])(\\s*)(' + TYPE_RE + ')\\s+(?!\\()', 'gm');
  return src.replace(re, (full, boundary, ws, type) => `${boundary}${ws}let `);
}
function stripForHeaderTypes(src) {
  return src.replace(new RegExp('for\\s*\\(\\s*(' + TYPE_RE + ')\\s+', 'g'), 'for(let ');
}
function instrumentLoops(src) {
  const re = /\b(for|while)\s*\(/g;
  let out = '';
  let lastIndex = 0;
  let m;
  while ((m = re.exec(src))) {
    let depth = 1,
      j = re.lastIndex;
    while (j < src.length && depth > 0) {
      if (src[j] === '(') depth++;
      else if (src[j] === ')') depth--;
      j++;
    }
    let k = j;
    while (k < src.length && /\s/.test(src[k])) k++;
    if (src[k] === '{') {
      out += src.slice(lastIndex, k + 1) + '__step();';
      lastIndex = k + 1;
      re.lastIndex = k + 1;
    }
  }
  out += src.slice(lastIndex);
  return out;
}

export function transpile(src) {
  src = stripComments(src);
  src = stripPreprocessor(src);
  if (!/\bvoid\s+setup\s*\(\s*\)/.test(src)) throw new Error('Missing required "void setup()" function.');
  if (!/\bvoid\s+loop\s*\(\s*\)/.test(src)) throw new Error('Missing required "void loop()" function.');
  const names = findFunctionNames(src);
  src = transformDefinitions(src);
  src = injectYields(src, names);
  src = src.replace(/\bdelay\s*\(/g, 'yield __delay(');
  src = stripForHeaderTypes(src);
  src = stripVarDeclTypes(src);
  src = instrumentLoops(src);
  return src;
}

/* ---------------- Runtime (coroutine driver) ---------------- */

export class Runtime {
  constructor(sourceCode, speed, onTerminal) {
    this.speed = speed;
    this.onTerminal = onTerminal || (() => {});
    this.virtualMillis = 0;
    this.stepCount = 0;
    this.paused = false;
    this.stopped = false;
    this.timer = null;
    this.phase = 'setup';
    this.iterations = 0;
    this.serialBuf = '';
    this.state = droneState; // shared, not per-instance
    this.build(sourceCode);
  }

  makeEnv() {
    const self = this;
    return {
      millis: () => self.virtualMillis,
      micros: () => self.virtualMillis * 1000,
      __delay: (ms) => {
        const n = Number(ms) || 0;
        self.virtualMillis += n;
        return n;
      },
      delayMicroseconds: (us) => {
        self.virtualMillis += (Number(us) || 0) / 1000;
        return 0;
      },
      __step: () => {
        self.stepCount++;
        if (self.stepCount > 300000) {
          throw new Error('Possible infinite loop detected (no delay() reached) — execution halted to protect the browser tab.');
        }
      },
      F: (x) => x,
      Serial: {
        begin: () => {},
        print: (v) => {
          const t = v === undefined ? '' : String(v);
          self.serialBuf += t;
          self.onTerminal(t, false);
        },
        println: (v) => {
          const t = v === undefined ? '' : String(v);
          self.serialBuf += t;
          self.onTerminal(t, true);
          self.parseTelemetry(self.serialBuf);
          self.serialBuf = '';
        }
      },
      drone: {
        arm: () => {
          self.state.armed = true;
          self.onTerminal('[drone] ARMED', true, 'sys');
        },
        disarm: () => {
          self.state.armed = false;
          self.onTerminal('[drone] DISARMED', true, 'sys');
        },
        setThrottle: (v) => { self.state.throttle = normalizeStick(v, 0, 100); },
        setYaw: (v) => { self.state.yaw = normalizeStick(v, -100, 100); },
        setPitch: (v) => { self.state.pitch = normalizeStick(v, -100, 100); },
        setRoll: (v) => { self.state.roll = normalizeStick(v, -100, 100); },
        setFlightMode: (m) => { self.state.flightMode = String(m).toUpperCase(); },
        setCameraTilt: (v) => { self.state.cameraTilt = clamp(Number(v) || 0, -90, 90); },
        setSpeed: (v) => { self.state.speed = clamp(Number(v) || 0, 0, 100); }
      },
      map: mapRange,
      constrain: (x, a, b) => clamp(x, a, b),
      min: (a, b) => Math.min(a, b),
      max: (a, b) => Math.max(a, b),
      abs: (a) => Math.abs(a),
      random: (a, b) => {
        if (b === undefined) { b = a; a = 0; }
        return Math.floor(Math.random() * (b - a)) + a;
      },
      pinMode: () => {}, digitalWrite: () => {}, digitalRead: () => 0,
      analogWrite: () => {}, analogRead: () => 0,
      HIGH: 1, LOW: 0, INPUT: 0, OUTPUT: 1, INPUT_PULLUP: 2
    };
  }

  parseTelemetry(line) {
    const t = line.match(/T:(-?\d+(?:\.\d+)?)/);
    const y = line.match(/Y:(-?\d+(?:\.\d+)?)/);
    const p = line.match(/P:(-?\d+(?:\.\d+)?)/);
    const r = line.match(/R:(-?\d+(?:\.\d+)?)/);
    const a = line.match(/A:(-?\d+)/);
    const md = line.match(/M:([A-Za-z]+)/);
    const c = line.match(/C:(-?\d+(?:\.\d+)?)/);
    const sp = line.match(/S:(-?\d+(?:\.\d+)?)/);
    if (t) this.state.throttle = normalizeStick(parseFloat(t[1]), 0, 100);
    if (y) this.state.yaw = normalizeStick(parseFloat(y[1]), -100, 100);
    if (p) this.state.pitch = normalizeStick(parseFloat(p[1]), -100, 100);
    if (r) this.state.roll = normalizeStick(parseFloat(r[1]), -100, 100);
    if (a) this.state.armed = a[1] === '1';
    if (md) this.state.flightMode = md[1].toUpperCase();
    if (c) this.state.cameraTilt = clamp(parseFloat(c[1]), -90, 90);
    if (sp) this.state.speed = clamp(parseFloat(sp[1]), 0, 100);
  }

  build(sourceCode) {
    let code;
    try {
      code = transpile(sourceCode);
    } catch (e) {
      throw new Error(e.message);
    }
    const env = this.makeEnv();
    const paramNames = [
      'millis', '__delay', 'delayMicroseconds', '__step', 'F', 'Serial', 'drone',
      'map', 'constrain', 'min', 'max', 'abs', 'random',
      'pinMode', 'digitalWrite', 'digitalRead', 'analogWrite', 'analogRead',
      'HIGH', 'LOW', 'INPUT', 'OUTPUT', 'INPUT_PULLUP'
    ];
    let factory;
    try {
      factory = new Function(
        ...paramNames,
        code + '\nreturn {setup: typeof setup==="function"?setup:null, loop: typeof loop==="function"?loop:null};'
      );
    } catch (e) {
      throw new Error('Compile error — ' + e.message);
    }
    let out;
    try {
      out = factory(...paramNames.map((n) => env[n]));
    } catch (e) {
      throw new Error('Compile error — ' + e.message);
    }
    if (!out.setup || !out.loop) throw new Error('Sketch must define both void setup() and void loop().');
    this.setupFn = out.setup;
    this.loopFn = out.loop;
  }

  start() {
    this.gen = this.setupFn();
    this.phase = 'setup';
    this.tick();
  }

  tick() {
    if (this.stopped) return;
    clearTimeout(this.timer);
    if (this.paused) {
      this.timer = setTimeout(() => this.tick(), 120);
      return;
    }
    this.stepCount = 0;
    let result;
    try {
      result = this.gen.next();
    } catch (e) {
      this.reportError(e);
      return;
    }
    if (result.done) {
      if (this.phase === 'setup') {
        this.phase = 'loop';
        this.gen = this.loopFn();
      } else {
        this.gen = this.loopFn();
        this.iterations++;
      }
      this.timer = setTimeout(() => this.tick(), 0);
      return;
    }
    const ms = Number(result.value) || 0;
    const real = Math.max(0, ms / this.speed);
    this.timer = setTimeout(() => this.tick(), real);
  }

  manualStep() {
    if (this.stopped) return;
    this.stepCount = 0;
    let result;
    try {
      result = this.gen.next();
    } catch (e) {
      this.reportError(e);
      return;
    }
    if (result.done) {
      if (this.phase === 'setup') { this.phase = 'loop'; this.gen = this.loopFn(); }
      else { this.gen = this.loopFn(); this.iterations++; }
    }
  }

  reportError(e) {
    this.onTerminal('Runtime error: ' + e.message, true, 'err');
    this.stopped = true;
  }

  destroy() {
    this.stopped = true;
    clearTimeout(this.timer);
  }
}

/* ---------------- Flight physics ---------------- */
// A deliberately simplified integrator — enough to make stick/telemetry
// inputs feel like a real aircraft (altitude hold around a hover point,
// heading integration, basic drag/ground-effect), not a rigorous 6-DOF
// aerodynamics model. Pro mode adds wind, drag, and ground effect terms.

export class FlightPhysics {
  constructor() {
    this.reset();
  }
  reset() {
    this.altitude = 0;
    this.heading = 0;
    this.groundOffset = 0;
    this.windPhase = Math.random() * Math.PI * 2;
    this.x = 0; // ground-plane Cartesian position, meters (GPS radar / Pro)
    this.y = 0; // positive Y = south, so heading 0 (north) decreases Y
  }
  step(dtFrames, state, proAero) {
    const hover = 50;
    let climb = (state.throttle - hover) * 0.045;

    let wind = { angle: 0, speed: 0 };
    if (proAero) {
      this.windPhase += 0.004;
      wind.speed = 2 + Math.sin(this.windPhase) * 1.6;
      wind.angle = Math.sin(this.windPhase * 0.6) * 40;
      // ground effect: cushions descent close to the ground
      if (this.altitude < 20 && climb < 0) climb *= 0.45;
      // simple drag: bleeds a little climb rate at high forward speed
      climb -= Math.abs(state.pitch) * 0.0015;
    }

    this.altitude = clamp(this.altitude + climb, 0, 120);
    this.heading = (this.heading + state.yaw * 0.15) % 360;
    if (this.heading < 0) this.heading += 360;

    const speedFactor = clamp((state.speed + Math.max(0, state.pitch)) / 100, 0, 2.2);
    this.groundOffset = (this.groundOffset + 0.006 + speedFactor * 0.018) % 1;

    // Ground-plane dead-reckoning: integrate X/Y from heading + forward speed.
    // Only armed flight covers ground, mirroring a real GPS log.
    if (state.armed) {
      const headingRad = (this.heading * Math.PI) / 180;
      const forwardSpeed = speedFactor * 0.12; // meters per frame at speedFactor=1
      this.x += Math.sin(headingRad) * forwardSpeed;
      this.y -= Math.cos(headingRad) * forwardSpeed;
    }

    return {
      altitude: this.altitude, heading: this.heading, speedFactor, wind,
      groundOffset: this.groundOffset, x: this.x, y: this.y
    };
  }
}

/* ---------------- PID step-response simulator ---------------- */
// Simplified 2nd-order plant (mass + damping) closed over a discrete PID
// controller. Useful for showing *qualitative* gain behavior (overshoot,
// rise time, steady-state error) — not a certified attitude-control model.

export function simulateStepResponse(kp, ki, kd, steps = 260, dt = 0.02) {
  let output = 0, velocity = 0, integral = 0, prevError = 0;
  const setpoint = 1;
  const mass = 1, damping = 1.4;
  const trace = [];
  for (let i = 0; i < steps; i++) {
    const error = setpoint - output;
    integral += error * dt;
    const derivative = (error - prevError) / dt;
    prevError = error;
    const u = kp * error + ki * integral + kd * derivative;
    const accel = (u - damping * velocity) / mass;
    velocity += accel * dt;
    output += velocity * dt;
    trace.push(output);
  }
  return trace;
}
