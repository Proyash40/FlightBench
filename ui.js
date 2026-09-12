// ============================================================================
// ui.js — all DOM, rendering, and interaction logic. No licensing math lives
// here (see auth.js); no Arduino/physics simulation lives here (see
// simulator.js). This file just wires the two together and draws pixels.
// ============================================================================

import {
  clamp, Runtime, droneState, resetDroneState,
  VEHICLES, simState, setVehicle, FlightPhysics, simulateStepResponse
} from './simulator.js';
import { deviceID, authState, onProChange, tryUnlock } from './auth.js';

/* ---------------- Sample sketch ---------------- */

const SAMPLE_SKETCH = `// FlightBench sample sketch
// Automated sequence: arm -> hover -> pitch forward -> bank right -> land

int throttle = 0;
int pitch = 0;
int roll = 0;
int yaw = 0;

void setup() {
  Serial.begin(9600);
  Serial.println("Booting flight controller...");

  drone.setFlightMode("ANGLE");
  delay(500);

  Serial.println("Arming motors...");
  drone.arm();
  delay(1000);

  Serial.println("Throttle up to hover...");
  for (int t = 0; t <= 55; t += 5) {
    throttle = t;
    drone.setThrottle(throttle);
    delay(150);
  }

  Serial.println("Pitching forward, cruise speed up...");
  pitch = 25;
  drone.setPitch(pitch);
  drone.setSpeed(40);
  delay(2000);

  Serial.println("Leveling pitch...");
  pitch = 0;
  drone.setPitch(pitch);
  delay(500);

  Serial.println("Banking right...");
  roll = 30;
  drone.setRoll(roll);
  delay(1500);

  Serial.println("Leveling roll...");
  roll = 0;
  drone.setRoll(roll);
  drone.setSpeed(0);
  delay(500);

  Serial.println("Initiating landing descent...");
  for (int t = 55; t >= 0; t -= 5) {
    throttle = t;
    drone.setThrottle(throttle);
    delay(150);
  }

  Serial.println("Disarming...");
  drone.disarm();
  Serial.println("Landed. Sequence complete.");
}

void loop() {
  Serial.print("T:"); Serial.print(throttle);
  Serial.print(",Y:"); Serial.print(yaw);
  Serial.print(",P:"); Serial.print(pitch);
  Serial.print(",R:"); Serial.println(roll);
  delay(1000);
}
`;

/* ---------------- Editor ---------------- */

const codeEl = document.getElementById('code');
const gutterEl = document.getElementById('gutter');
const hlCode = document.getElementById('hlCode');
const lineCountEl = document.getElementById('lineCount');

function syncGutter() {
  const lines = codeEl.value.split('\n').length;
  let html = '';
  for (let i = 1; i <= lines; i++) html += '<div>' + i + '</div>';
  gutterEl.innerHTML = html;
  gutterEl.scrollTop = codeEl.scrollTop;
  lineCountEl.textContent = lines + ' lines';
}
function syncHighlight() {
  const text = codeEl.value + '\n';
  if (window.Prism && Prism.languages.clike) {
    hlCode.innerHTML = Prism.highlight(text, Prism.languages.clike, 'clike');
  } else {
    hlCode.textContent = text;
  }
}
codeEl.addEventListener('input', () => { syncGutter(); syncHighlight(); });
codeEl.addEventListener('scroll', () => {
  gutterEl.scrollTop = codeEl.scrollTop;
  document.getElementById('hlLayer').scrollTop = codeEl.scrollTop;
  document.getElementById('hlLayer').scrollLeft = codeEl.scrollLeft;
});
codeEl.addEventListener('keydown', (e) => {
  if (e.key === 'Tab') {
    e.preventDefault();
    const s = codeEl.selectionStart, en = codeEl.selectionEnd;
    codeEl.value = codeEl.value.slice(0, s) + '  ' + codeEl.value.slice(en);
    codeEl.selectionStart = codeEl.selectionEnd = s + 2;
    syncGutter(); syncHighlight();
  }
});
codeEl.value = SAMPLE_SKETCH;
syncGutter(); syncHighlight();

/* ---------------- Terminal ---------------- */

const terminalEl = document.getElementById('terminal');
function onTerminal(text, newline, kind) {
  const div = document.createElement('div');
  div.className = 'line' + (kind ? ' ' + kind : '');
  div.textContent = text;
  terminalEl.appendChild(div);
  while (terminalEl.children.length > 600) terminalEl.removeChild(terminalEl.firstChild);
  terminalEl.scrollTop = terminalEl.scrollHeight;
}
document.getElementById('btnClearLog').addEventListener('click', () => (terminalEl.innerHTML = ''));

/* ---------------- Runtime lifecycle ---------------- */

const SPEEDS = [0.25, 0.5, 1, 2, 4];
let runtime = null;

const btnRun = document.getElementById('btnRun');
const btnPause = document.getElementById('btnPause');
const btnStep = document.getElementById('btnStep');
const btnReset = document.getElementById('btnReset');
const speedSlider = document.getElementById('speedSlider');
const speedVal = document.getElementById('speedVal');
const engineStateEl = document.getElementById('engineState');
const clockValEl = document.getElementById('clockVal');
const hudMillis = document.getElementById('hudMillis');
const hudLoops = document.getElementById('hudLoops');
const hudPhase = document.getElementById('hudPhase');

function setEngineState(s) { engineStateEl.textContent = s; }

function doRun() {
  if (runtime) runtime.destroy();
  terminalEl.innerHTML = '';
  onTerminal('Compiling sketch…', true, 'sys');
  const speed = SPEEDS[Number(speedSlider.value)];
  try {
    runtime = new Runtime(codeEl.value, speed, onTerminal);
  } catch (e) {
    onTerminal('Compile error — ' + e.message, true, 'err');
    setEngineState('COMPILE ERROR');
    return;
  }
  onTerminal('Compiled OK. Running setup()…', true, 'ok');
  runtime.start();
  setEngineState('RUNNING');
  btnPause.disabled = false; btnPause.textContent = '\u23F8 Pause';
  btnStep.disabled = false;
}
function doPauseToggle() {
  if (!runtime) return;
  runtime.paused = !runtime.paused;
  btnPause.textContent = runtime.paused ? '\u25B6 Resume' : '\u23F8 Pause';
  setEngineState(runtime.paused ? 'PAUSED' : 'RUNNING');
  if (!runtime.paused) { clearTimeout(runtime.timer); runtime.tick(); }
}
function doStep() {
  if (!runtime) return;
  if (!runtime.paused) {
    runtime.paused = true;
    btnPause.textContent = '\u25B6 Resume';
    setEngineState('PAUSED');
  }
  runtime.manualStep();
}
let landTimer = null;
function doReset() {
  if (runtime) runtime.destroy();
  runtime = null;
  clearTimeout(landTimer);
  setEngineState('IDLE');
  btnPause.disabled = true; btnPause.textContent = '\u23F8 Pause';
  btnStep.disabled = true;
  resetDroneState();
  physics.reset();
  scopeBuf.t = []; scopeBuf.y = []; scopeBuf.p = []; scopeBuf.r = [];
  displayState = { throttle: 0, yaw: 0, pitch: 0, roll: 0, armed: false, flightMode: 'ANGLE', cameraTilt: 0, speed: 0 };
  onTerminal('Reset.', true, 'sys');
}
btnRun.addEventListener('click', doRun);
btnPause.addEventListener('click', doPauseToggle);
btnStep.addEventListener('click', doStep);
btnReset.addEventListener('click', doReset);
speedSlider.addEventListener('input', () => {
  const v = SPEEDS[Number(speedSlider.value)];
  speedVal.textContent = v + '\u00D7';
  if (runtime) runtime.speed = v;
});
speedVal.textContent = SPEEDS[Number(speedSlider.value)] + '\u00D7';

/* ---------------- Manual quick controls ---------------- */

const armTrack = document.getElementById('armTrack');
function doLiftoff() { droneState.armed = true; droneState.throttle = 55; onTerminal('[manual] Liftoff commanded', true, 'sys'); }
function doLand() {
  clearTimeout(landTimer);
  droneState.throttle = 0;
  onTerminal('[manual] Landing…', true, 'sys');
  landTimer = setTimeout(() => { droneState.armed = false; onTerminal('[manual] Touchdown, disarmed', true, 'sys'); }, 1200);
}
document.getElementById('btnLiftoff').addEventListener('click', doLiftoff);
document.getElementById('btnLand').addEventListener('click', doLand);
armTrack.addEventListener('click', () => { droneState.armed = !droneState.armed; });
['ANGLE', 'ACRO', 'RTL'].forEach((m) => {
  document.getElementById('mode-' + m).addEventListener('click', () => { droneState.flightMode = m; });
});
document.getElementById('btnCamUp').addEventListener('click', () => { droneState.cameraTilt = clamp(droneState.cameraTilt + 10, -90, 90); });
document.getElementById('btnCamDown').addEventListener('click', () => { droneState.cameraTilt = clamp(droneState.cameraTilt - 10, -90, 90); });
document.getElementById('btnSpeedUp').addEventListener('click', () => { droneState.speed = clamp(droneState.speed + 10, 0, 100); });
document.getElementById('btnSpeedDown').addEventListener('click', () => { droneState.speed = clamp(droneState.speed - 10, 0, 100); });

/* ---------------- Dial tick marks (machined-gauge look) ---------------- */

function buildDialTicks(svg, labels) {
  const cx = 80, cy = 80, rOuter = 78, rInner = 70, rLabel = 58;
  let html = '';
  for (let deg = 0; deg < 360; deg += 15) {
    const rad = (deg * Math.PI) / 180;
    const major = deg % 45 === 0;
    const r1 = major ? rInner - 6 : rInner;
    const x1 = cx + r1 * Math.cos(rad), y1 = cy + r1 * Math.sin(rad);
    const x2 = cx + rOuter * Math.cos(rad), y2 = cy + rOuter * Math.sin(rad);
    html += `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="var(--line-soft)" stroke-width="${major ? 1.4 : 1}"/>`;
  }
  const pos = { top: [cx, cy - rLabel], right: [cx + rLabel, cy], bottom: [cx, cy + rLabel], left: [cx - rLabel, cy] };
  Object.keys(labels).forEach((k) => {
    const [x, y] = pos[k];
    html += `<text x="${x}" y="${y + 3}" text-anchor="middle" font-family="JetBrains Mono, monospace" font-size="8.5" fill="var(--ink-faint)">${labels[k]}</text>`;
  });
  svg.innerHTML = html;
}
buildDialTicks(document.querySelector('#stickLeft .dial-ticks'), { top: '100', bottom: '0', left: 'L', right: 'R' });
buildDialTicks(document.querySelector('#stickRight .dial-ticks'), { top: 'FWD', bottom: 'AFT', left: 'L', right: 'R' });

/* ---------------- Tabs ---------------- */

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach((c) => c.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById('tab-' + tab.dataset.tab).classList.add('active');
    if (tab.dataset.tab === 'pid') redrawPid();
  });
});

/* ---------------- Vehicle + Pro-gated controls ---------------- */

const vehQuad = document.getElementById('veh-QUAD');
const vehHex = document.getElementById('veh-HEX');
const chkAero = document.getElementById('chkAero');
const chkHud = document.getElementById('chkHud');

function selectVehicle(id) {
  if (id === 'HEX' && !authState.isPro) { flashLocked(vehHex); return; }
  setVehicle(id);
  vehQuad.classList.toggle('active', id === 'QUAD');
  vehHex.classList.toggle('active', id === 'HEX');
}
vehQuad.addEventListener('click', () => selectVehicle('QUAD'));
vehHex.addEventListener('click', () => selectVehicle('HEX'));

function flashLocked(el) {
  openLicense();
}

function applyProGating() {
  const pro = authState.isPro;
  document.getElementById('proPill').hidden = !pro;
  document.getElementById('lockBadgePid').style.display = pro ? 'none' : '';
  document.getElementById('lockBadgeVehicle').style.display = pro ? 'none' : '';
  vehHex.classList.toggle('locked', !pro);
  chkAero.disabled = !pro;
  chkHud.disabled = !pro;
  if (pro) { chkAero.checked = true; chkHud.checked = true; }
  else { chkAero.checked = false; chkHud.checked = false; setVehicle('QUAD'); vehQuad.classList.add('active'); vehHex.classList.remove('active'); }
  document.getElementById('pidLocked').hidden = pro;
  document.getElementById('pidUnlocked').hidden = !pro;
  if (pro) redrawPid();
}
onProChange(applyProGating);
applyProGating();

/* ---------------- License modal ---------------- */

const licenseModal = document.getElementById('licenseModal');
const donateModal = document.getElementById('donateModal');

function openModal(el) { el.classList.add('open'); }
function closeModal(el) { el.classList.remove('open'); }

document.getElementById('btnOpenLicense').addEventListener('click', () => openLicense());
document.getElementById('btnUnlockFromPid').addEventListener('click', () => openLicense());
document.getElementById('btnOpenDonate').addEventListener('click', () => openModal(donateModal));
document.querySelectorAll('[data-close]').forEach((btn) => {
  btn.addEventListener('click', () => closeModal(document.getElementById(btn.dataset.close)));
});
[licenseModal, donateModal].forEach((backdrop) => {
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) closeModal(backdrop); });
});

function openLicense() {
  document.getElementById('deviceIdVal').textContent = deviceID;
  document.getElementById('unlockMsg').textContent = '';
  document.getElementById('unlockMsg').className = 'unlock-msg';
  openModal(licenseModal);
}

document.getElementById('btnUnlock').addEventListener('click', () => {
  const input = document.getElementById('activationInput').value;
  const msg = document.getElementById('unlockMsg');
  if (tryUnlock(input)) {
    msg.textContent = 'Pro unlocked. Thank you for supporting FlightBench!';
    msg.className = 'unlock-msg ok';
    setTimeout(() => closeModal(licenseModal), 1200);
  } else {
    msg.textContent = 'That key does not match this Device ID. Double-check and try again.';
    msg.className = 'unlock-msg err';
  }
});

/* ---------------- Render loop ---------------- */

let displayState = { throttle: 0, yaw: 0, pitch: 0, roll: 0, armed: false, flightMode: 'ANGLE', cameraTilt: 0, speed: 0 };
const physics = new FlightPhysics();
let propAngle = 0;

const leftKnob = document.getElementById('leftKnob');
const rightKnob = document.getElementById('rightKnob');
const roThrottle = document.getElementById('roThrottle');
const roYaw = document.getElementById('roYaw');
const roPitch = document.getElementById('roPitch');
const roRoll = document.getElementById('roRoll');
const armBadge = document.getElementById('armBadge');
const camVal = document.getElementById('camVal');
const speedManVal = document.getElementById('speedManVal');

function updateDashboard(s) {
  const R = 39;
  const yawX = (s.yaw / 100) * R;
  const throttleY = R - (s.throttle / 100) * (2 * R);
  leftKnob.style.transform = `translate(${yawX.toFixed(1)}px, ${throttleY.toFixed(1)}px)`;
  const rollX = (s.roll / 100) * R;
  const pitchY = -(s.pitch / 100) * R;
  rightKnob.style.transform = `translate(${rollX.toFixed(1)}px, ${pitchY.toFixed(1)}px)`;

  roThrottle.textContent = Math.round(s.throttle) + '%';
  roYaw.textContent = Math.round(s.yaw);
  roPitch.textContent = Math.round(s.pitch);
  roRoll.textContent = Math.round(s.roll);
  camVal.textContent = Math.round(s.cameraTilt) + '\u00B0';
  speedManVal.textContent = Math.round(s.speed);

  armTrack.classList.toggle('on', s.armed);
  armBadge.textContent = s.armed ? 'ARMED' : 'DISARMED';
  armBadge.className = 'arm-badge ' + (s.armed ? 'armed' : 'disarmed');
  ['ANGLE', 'ACRO', 'RTL'].forEach((m) => {
    document.getElementById('mode-' + m).classList.toggle('active', m === s.flightMode);
  });
}

/* ---- Chase cam ---- */
const chaseCanvas = document.getElementById('chaseCanvas');
const chaseCtx = chaseCanvas.getContext('2d');
const capAlt = document.getElementById('capAlt'), capHdg = document.getElementById('capHdg');
const capSpd = document.getElementById('capSpd'), capBank = document.getElementById('capBank'), capCam = document.getElementById('capCam');

function drawChase(s, phys) {
  const w = chaseCanvas.width, h = chaseCanvas.height;
  const horizonY = h * 0.4, groundBaseY = h * 0.88, cx = w / 2;
  const proAero = chkAero.checked && authState.isPro;
  const proHud = chkHud.checked && authState.isPro;
  const arms = VEHICLES[simState.vehicle].arms;

  const sky = chaseCtx.createLinearGradient(0, 0, 0, horizonY);
  sky.addColorStop(0, '#14161a'); sky.addColorStop(1, '#1e2126');
  chaseCtx.fillStyle = sky; chaseCtx.fillRect(0, 0, w, horizonY);
  const ground = chaseCtx.createLinearGradient(0, horizonY, 0, h);
  ground.addColorStop(0, '#1c2018'); ground.addColorStop(1, '#0e0f0c');
  chaseCtx.fillStyle = ground; chaseCtx.fillRect(0, horizonY, w, h - horizonY);

  chaseCtx.strokeStyle = 'rgba(91,143,176,0.3)'; chaseCtx.lineWidth = 1;
  chaseCtx.beginPath(); chaseCtx.moveTo(0, horizonY); chaseCtx.lineTo(w, horizonY); chaseCtx.stroke();

  const N = 9;
  for (let i = 0; i < N; i++) {
    const t = (i / N + phys.groundOffset) % 1;
    const te = t * t;
    const y = horizonY + te * (h - horizonY);
    chaseCtx.strokeStyle = `rgba(154,157,164,${(0.05 + 0.28 * t).toFixed(2)})`;
    chaseCtx.beginPath(); chaseCtx.moveTo(0, y); chaseCtx.lineTo(w, y); chaseCtx.stroke();
  }
  chaseCtx.strokeStyle = 'rgba(154,157,164,0.18)';
  for (let i = -4; i <= 4; i++) {
    chaseCtx.beginPath(); chaseCtx.moveTo(cx + i * 12, horizonY); chaseCtx.lineTo(cx + i * 90, h); chaseCtx.stroke();
  }

  if (proAero) {
    chaseCtx.save();
    chaseCtx.strokeStyle = 'rgba(217,154,60,0.55)'; chaseCtx.fillStyle = 'rgba(217,154,60,0.55)';
    chaseCtx.font = '10px JetBrains Mono, monospace';
    for (let i = 0; i < 3; i++) {
      const bx = 60 + i * (w - 120) / 2, by = 40 + i * 14;
      const rad = (phys.wind.angle * Math.PI) / 180;
      const len = 18 + phys.wind.speed * 4;
      chaseCtx.beginPath(); chaseCtx.moveTo(bx, by); chaseCtx.lineTo(bx + Math.cos(rad) * len, by + Math.sin(rad) * len * 0.3); chaseCtx.stroke();
    }
    chaseCtx.fillText(`WIND ${phys.wind.speed.toFixed(1)} m/s`, 12, 20);
    chaseCtx.restore();
  }

  capAlt.textContent = (phys.altitude / 12).toFixed(1);
  capHdg.textContent = String(Math.round(phys.heading)).padStart(3, '0');
  capSpd.textContent = Math.round(phys.speedFactor * 50);
  capBank.textContent = Math.round(s.roll);
  capCam.textContent = Math.round(s.cameraTilt);

  const droneX = clamp(cx + s.roll * 0.5, cx - 80, cx + 80);
  const droneY = groundBaseY - phys.altitude;
  const bankRad = (clamp(s.roll, -45, 45) * Math.PI) / 180;
  propAngle += 0.4 + (s.armed ? phys.speedFactor * 0.6 + 0.5 : 0);

  chaseCtx.save();
  chaseCtx.translate(droneX, groundBaseY); chaseCtx.scale(1, 0.28);
  chaseCtx.beginPath();
  const shadowR = Math.max(4, 26 - phys.altitude * 0.12);
  chaseCtx.arc(0, 0, shadowR, 0, Math.PI * 2);
  chaseCtx.fillStyle = `rgba(0,0,0,${clamp(0.5 - phys.altitude * 0.003, 0.08, 0.5)})`;
  chaseCtx.fill();
  chaseCtx.restore();

  chaseCtx.save();
  chaseCtx.translate(droneX, droneY); chaseCtx.rotate(bankRad);
  const pitchSquash = 1 - Math.min(0.22, Math.abs(s.pitch) / 100 * 0.22);
  chaseCtx.scale(1, pitchSquash);

  const armSpan = 34;
  chaseCtx.strokeStyle = '#4a4d54'; chaseCtx.lineWidth = 3;
  const tips = [];
  for (let i = 0; i < arms; i++) {
    const a = (i / arms) * Math.PI * 2 + Math.PI / arms;
    const dx = Math.cos(a), dy = Math.sin(a) * 0.4;
    tips.push([dx * armSpan, dy * 14]);
  }
  tips.forEach(([px, py]) => { chaseCtx.beginPath(); chaseCtx.moveTo(0, 0); chaseCtx.lineTo(px, py); chaseCtx.stroke(); });
  tips.forEach(([px, py]) => {
    chaseCtx.beginPath();
    chaseCtx.arc(px, py, s.armed ? 12 : 7, 0, Math.PI * 2);
    chaseCtx.strokeStyle = s.armed ? 'rgba(91,143,176,0.6)' : 'rgba(120,122,128,0.6)';
    chaseCtx.lineWidth = s.armed ? 2 : 4;
    chaseCtx.stroke();
    if (s.armed) {
      chaseCtx.beginPath();
      chaseCtx.moveTo(px + Math.cos(propAngle) * 12, py + Math.sin(propAngle) * 3);
      chaseCtx.lineTo(px - Math.cos(propAngle) * 12, py - Math.sin(propAngle) * 3);
      chaseCtx.strokeStyle = '#b9bec7'; chaseCtx.lineWidth = 2; chaseCtx.stroke();
    }
  });

  const bodyGrad = chaseCtx.createLinearGradient(-16, -9, 16, 12);
  bodyGrad.addColorStop(0, '#d99a3c'); bodyGrad.addColorStop(1, '#6b4f22');
  chaseCtx.fillStyle = bodyGrad;
  chaseCtx.beginPath();
  if (chaseCtx.roundRect) chaseCtx.roundRect(-14, -8, 28, 16, 4); else chaseCtx.rect(-14, -8, 28, 16);
  chaseCtx.fill();
  chaseCtx.strokeStyle = 'rgba(0,0,0,0.35)'; chaseCtx.lineWidth = 1; chaseCtx.stroke();

  chaseCtx.save();
  chaseCtx.translate(0, 8); chaseCtx.rotate((s.cameraTilt * Math.PI) / 180 * 0.6);
  chaseCtx.fillStyle = '#5b8fb0';
  chaseCtx.beginPath(); chaseCtx.arc(0, 0, 3.5, 0, Math.PI * 2); chaseCtx.fill();
  chaseCtx.fillRect(-2, 0, 4, 6);
  chaseCtx.restore();

  chaseCtx.fillStyle = s.armed ? '#7fae7f' : '#b95c5c';
  chaseCtx.beginPath(); chaseCtx.arc(0, -12, 2, 0, Math.PI * 2); chaseCtx.fill();
  chaseCtx.restore();

  if (proHud) drawPfdOverlay(s, phys, w, h);
}

function drawPfdOverlay(s, phys, w, h) {
  const cx = w / 2, cy = h * 0.4;
  const rad = 70;
  chaseCtx.save();
  chaseCtx.beginPath(); chaseCtx.arc(cx, cy, rad, 0, Math.PI * 2); chaseCtx.clip();

  chaseCtx.translate(cx, cy);
  chaseCtx.rotate((-clamp(s.roll, -60, 60) * Math.PI) / 180);
  const pitchOffset = clamp(s.pitch, -60, 60) * 1.1;
  const sky2 = chaseCtx.createLinearGradient(0, -rad * 2, 0, rad * 2);
  sky2.addColorStop(0, '#3a5f78'); sky2.addColorStop(1, '#294a5e');
  chaseCtx.fillStyle = sky2; chaseCtx.fillRect(-rad * 2, -rad * 2 + pitchOffset, rad * 4, rad * 2);
  const ground2 = chaseCtx.createLinearGradient(0, 0, 0, rad * 2);
  ground2.addColorStop(0, '#7a5a34'); ground2.addColorStop(1, '#4a3a22');
  chaseCtx.fillStyle = ground2; chaseCtx.fillRect(-rad * 2, pitchOffset, rad * 4, rad * 2);
  chaseCtx.strokeStyle = '#e8e8e8'; chaseCtx.lineWidth = 1.5;
  chaseCtx.beginPath(); chaseCtx.moveTo(-rad * 2, pitchOffset); chaseCtx.lineTo(rad * 2, pitchOffset); chaseCtx.stroke();
  chaseCtx.strokeStyle = 'rgba(232,232,232,0.5)';
  for (let d = -30; d <= 30; d += 10) {
    if (d === 0) continue;
    const y = pitchOffset - d * 1.1;
    const lw = d % 20 === 0 ? 22 : 12;
    chaseCtx.beginPath(); chaseCtx.moveTo(-lw / 2, y); chaseCtx.lineTo(lw / 2, y); chaseCtx.stroke();
  }
  chaseCtx.restore();

  chaseCtx.strokeStyle = '#e8b23c'; chaseCtx.lineWidth = 2;
  chaseCtx.beginPath(); chaseCtx.moveTo(cx - 26, cy); chaseCtx.lineTo(cx - 8, cy); chaseCtx.stroke();
  chaseCtx.beginPath(); chaseCtx.moveTo(cx + 8, cy); chaseCtx.lineTo(cx + 26, cy); chaseCtx.stroke();
  chaseCtx.beginPath(); chaseCtx.arc(cx, cy, 2.5, 0, Math.PI * 2); chaseCtx.fillStyle = '#e8b23c'; chaseCtx.fill();
  chaseCtx.strokeStyle = 'rgba(154,157,164,0.6)'; chaseCtx.beginPath(); chaseCtx.arc(cx, cy, rad, 0, Math.PI * 2); chaseCtx.stroke();

  // heading tape
  const tapeY = cy - rad - 16, tapeW = 150;
  chaseCtx.fillStyle = 'rgba(14,16,19,0.85)';
  chaseCtx.fillRect(cx - tapeW / 2, tapeY - 9, tapeW, 18);
  chaseCtx.font = '9px JetBrains Mono, monospace'; chaseCtx.fillStyle = '#f2f3f5'; chaseCtx.textAlign = 'center';
  for (let d = -60; d <= 60; d += 15) {
    const heading = ((phys.heading + d) % 360 + 360) % 360;
    const x = cx + (d / 60) * (tapeW / 2);
    chaseCtx.fillText(String(Math.round(heading)).padStart(3, '0'), x, tapeY + 4);
  }
  chaseCtx.beginPath(); chaseCtx.moveTo(cx, tapeY + 9); chaseCtx.lineTo(cx - 4, tapeY + 14); chaseCtx.lineTo(cx + 4, tapeY + 14); chaseCtx.closePath();
  chaseCtx.fillStyle = '#e8b23c'; chaseCtx.fill();

  // altitude ladder
  const ladderX = cx + rad + 20;
  chaseCtx.fillStyle = 'rgba(14,16,19,0.85)';
  chaseCtx.fillRect(ladderX - 4, cy - 40, 46, 80);
  chaseCtx.fillStyle = '#f2f3f5'; chaseCtx.textAlign = 'left';
  const altM = phys.altitude / 12;
  for (let i = -2; i <= 2; i++) {
    chaseCtx.fillText((Math.max(0, altM + i)).toFixed(1), ladderX - 2, cy + i * 15 + 3);
  }
  chaseCtx.strokeStyle = '#e8b23c'; chaseCtx.beginPath(); chaseCtx.moveTo(ladderX - 8, cy); chaseCtx.lineTo(ladderX - 2, cy); chaseCtx.stroke();
  chaseCtx.textAlign = 'left';
}

/* ---- PID tab ---- */
const pidCanvas = document.getElementById('pidCanvas');
const pidCtx = pidCanvas.getContext('2d');
const kpEl = document.getElementById('kp'), kiEl = document.getElementById('ki'), kdEl = document.getElementById('kd');
const kpVal = document.getElementById('kpVal'), kiVal = document.getElementById('kiVal'), kdVal = document.getElementById('kdVal');
function redrawPid() {
  if (!authState.isPro) return;
  const kp = parseFloat(kpEl.value), ki = parseFloat(kiEl.value), kd = parseFloat(kdEl.value);
  kpVal.textContent = kp.toFixed(2); kiVal.textContent = ki.toFixed(2); kdVal.textContent = kd.toFixed(2);
  const trace = simulateStepResponse(kp, ki, kd);
  const w = pidCanvas.width, h = pidCanvas.height;
  pidCtx.clearRect(0, 0, w, h);
  pidCtx.fillStyle = '#0e1013'; pidCtx.fillRect(0, 0, w, h);
  const yMax = 1.6, pad = 20;
  const toY = (v) => h - pad - (v / yMax) * (h - pad * 2);
  pidCtx.strokeStyle = 'rgba(154,157,164,0.2)';
  for (let g = 0; g <= yMax; g += 0.4) { pidCtx.beginPath(); pidCtx.moveTo(pad, toY(g)); pidCtx.lineTo(w - pad, toY(g)); pidCtx.stroke(); }
  pidCtx.strokeStyle = 'rgba(91,143,176,0.5)'; pidCtx.setLineDash([4, 3]);
  pidCtx.beginPath(); pidCtx.moveTo(pad, toY(1)); pidCtx.lineTo(w - pad, toY(1)); pidCtx.stroke(); pidCtx.setLineDash([]);
  pidCtx.strokeStyle = '#d99a3c'; pidCtx.lineWidth = 2; pidCtx.beginPath();
  trace.forEach((v, i) => {
    const x = pad + (i / trace.length) * (w - pad * 2);
    const y = toY(clamp(v, -0.5, yMax));
    i === 0 ? pidCtx.moveTo(x, y) : pidCtx.lineTo(x, y);
  });
  pidCtx.stroke();
}
[kpEl, kiEl, kdEl].forEach((el) => el.addEventListener('input', redrawPid));

/* ---- Oscilloscope tab ---- */
const scopeCanvas = document.getElementById('scopeCanvas');
const scopeCtx = scopeCanvas.getContext('2d');
const scopeBuf = { t: [], y: [], p: [], r: [] };
const SCOPE_LEN = 240;
function pushScope(s) {
  scopeBuf.t.push(s.throttle); scopeBuf.y.push(s.yaw); scopeBuf.p.push(s.pitch); scopeBuf.r.push(s.roll);
  Object.values(scopeBuf).forEach((arr) => { while (arr.length > SCOPE_LEN) arr.shift(); });
}
function drawScope() {
  const w = scopeCanvas.width, h = scopeCanvas.height;
  scopeCtx.fillStyle = '#0e1013'; scopeCtx.fillRect(0, 0, w, h);
  scopeCtx.strokeStyle = 'rgba(154,157,164,0.15)';
  for (let i = 0; i <= 4; i++) { const y = (h / 4) * i; scopeCtx.beginPath(); scopeCtx.moveTo(0, y); scopeCtx.lineTo(w, y); scopeCtx.stroke(); }
  const series = [
    { data: scopeBuf.t, lo: 0, hi: 100, color: '#d99a3c' },
    { data: scopeBuf.y, lo: -100, hi: 100, color: '#5b8fb0' },
    { data: scopeBuf.p, lo: -100, hi: 100, color: '#8fae7f' },
    { data: scopeBuf.r, lo: -100, hi: 100, color: '#b95c5c' }
  ];
  series.forEach(({ data, lo, hi, color }) => {
    scopeCtx.strokeStyle = color; scopeCtx.lineWidth = 1.6; scopeCtx.beginPath();
    data.forEach((v, i) => {
      const x = (i / SCOPE_LEN) * w;
      const norm = (v - lo) / (hi - lo);
      const y = h - norm * h;
      i === 0 ? scopeCtx.moveTo(x, y) : scopeCtx.lineTo(x, y);
    });
    scopeCtx.stroke();
  });
}

/* ---- Main frame loop ---- */

function frame() {
  const target = droneState;
  const f = 0.2;
  displayState.throttle += (target.throttle - displayState.throttle) * f;
  displayState.yaw += (target.yaw - displayState.yaw) * f;
  displayState.pitch += (target.pitch - displayState.pitch) * f;
  displayState.roll += (target.roll - displayState.roll) * f;
  displayState.cameraTilt += (target.cameraTilt - displayState.cameraTilt) * f;
  displayState.speed += (target.speed - displayState.speed) * f;
  displayState.armed = target.armed;
  displayState.flightMode = target.flightMode;

  if (runtime) {
    clockValEl.textContent = (runtime.virtualMillis / 1000).toFixed(3) + 's';
    hudMillis.textContent = runtime.virtualMillis;
    hudLoops.textContent = runtime.iterations;
    hudPhase.textContent = runtime.phase.toUpperCase();
    if (runtime.stopped && engineStateEl.textContent === 'RUNNING') setEngineState('STOPPED');
  }

  const proAero = chkAero.checked && authState.isPro;
  const phys = physics.step(1, displayState, proAero);

  updateDashboard(displayState);
  drawChase(displayState, phys);
  pushScope(displayState);
  if (document.getElementById('tab-scope').classList.contains('active')) drawScope();

  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
