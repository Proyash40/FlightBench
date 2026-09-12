// ============================================================================
// auth.js — FlightBench offline "honor system" license gate
// ----------------------------------------------------------------------------
// ENGINEERING NOTE (read this before shipping):
// This is a lightweight, purely client-side gate. Because everything here
// runs in the user's browser, anyone can open DevTools, read this file, and
// compute their own key — or simply run `localStorage.setItem('flightbench_isPro','true')`
// and skip the math entirely. That is fine for a small indie project running
// on GitHub Pages with no backend, but it is NOT real DRM and should not be
// described to users as tamper-proof. If you ever need actual protection,
// the key has to be issued and checked by a server you control, not by code
// you ship to the client. Ship this as an honest "please pay if this is
// useful to you" convenience gate, not a security boundary.
// ============================================================================

const DEVICE_ID_KEY = 'flightbench_deviceID';
const PRO_KEY = 'flightbench_isPro';

function ensureDeviceId() {
  let id = localStorage.getItem(DEVICE_ID_KEY);
  if (!id) {
    // random 5-digit integer, 10000–99999
    id = String(Math.floor(10000 + Math.random() * 90000));
    localStorage.setItem(DEVICE_ID_KEY, id);
  }
  return id;
}

export const deviceID = ensureDeviceId();

function readPro() {
  return localStorage.getItem(PRO_KEY) === 'true';
}

export const authState = {
  isPro: readPro()
};

const listeners = [];
export function onProChange(fn) {
  listeners.push(fn);
}
function notify() {
  listeners.forEach((fn) => fn(authState.isPro));
}

// --- The exact validation formula requested, kept isolated and unmodified ---
function computeExpectedKey(id) {
  const numericDeviceId = Number(id);
  const expectedKey = Math.floor((numericDeviceId * 95) / 2.6) + '-PRO';
  return expectedKey;
}

/**
 * Attempt to unlock Pro with a user-supplied activation key.
 * Returns true/false and flips + persists isPro + notifies listeners on success.
 */
export function tryUnlock(inputKey) {
  const expected = computeExpectedKey(deviceID);
  const clean = String(inputKey || '').trim().toUpperCase();
  if (clean === expected.toUpperCase()) {
    authState.isPro = true;
    localStorage.setItem(PRO_KEY, 'true');
    notify();
    return true;
  }
  return false;
}

/** Manual override, e.g. for a future "restore purchase" flow. */
export function setPro(value) {
  authState.isPro = value;
  localStorage.setItem(PRO_KEY, value ? 'true' : 'false');
  notify();
}
