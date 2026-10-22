// Headless Chrome on its DevTools pipe, without Playwright, for the render workers and stills. Chrome opens the runtime
// page from its command line, so the page boots while we attach (Playwright: 160 ms to import, then 170 ms of newPage
// before the page even starts loading), and nothing reports each frame image fetch back to node (Playwright enables the
// Network domain and relays every request through its in-process server). The switches are Playwright 1.63's own
// (chromiumSwitches + headless), so pixels and color handling stay the same.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const FEATURES_OFF = ['AvoidUnnecessaryBeforeUnloadCheckSync', 'DestroyProfileOnBrowserClose', 'DialMediaRouteProvider', 'GlobalMediaControls', 'HttpsUpgrades',
  'LensOverlay', 'MediaRouter', 'PaintHolding', 'ThirdPartyStoragePartitioning', 'Translate', 'AutoDeElevate', 'OptimizationHints'];
const SWITCHES = ['--disable-field-trial-config', '--disable-background-networking', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
  '--disable-back-forward-cache', '--disable-breakpad', '--disable-client-side-phishing-detection', '--disable-component-extensions-with-background-pages',
  '--disable-component-update', '--no-default-browser-check', '--disable-default-apps', '--disable-dev-shm-usage', '--disable-extensions',
  `--disable-features=${FEATURES_OFF.join(',')}`, '--allow-pre-commit-input', '--disable-hang-monitor', '--disable-ipc-flooding-protection',
  '--disable-popup-blocking', '--disable-prompt-on-repost', '--disable-renderer-backgrounding', '--force-color-profile=srgb', '--metrics-recording-only',
  '--no-first-run', '--password-store=basic', '--use-mock-keychain', '--no-service-autorun', '--disable-search-engine-choice-screen', '--disable-infobars',
  '--disable-sync', '--enable-unsafe-swiftshader', '--headless', '--hide-scrollbars', '--mute-audio',
  '--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4', '--no-sandbox', '--remote-debugging-pipe'];

// -> { evaluate(fn, arg), close() } once window.READY (throws window.READY_ERROR). evaluate runs fn(arg) in the page
// (arg JSON) and resolves with its JSON result, like Playwright's page.evaluate. onLog: console errors, [rt] lines, page errors.
export async function openChrome(exe, url, { width, height, args = [], onLog = console.log, timeout = 60000 }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'short-chrome-'));
  const p = spawn(exe, [...SWITCHES, `--user-data-dir=${dir}`, `--window-size=${width},${height}`, ...args, url], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
  let err = '', id = 0, rest = Buffer.alloc(0), dead = null;
  const pend = new Map(), fail = e => { dead ||= e; for (const q of pend.values()) q.rej(e); pend.clear(); };
  const exited = new Promise(r => { p.once('exit', r); p.once('error', e => { err += e.message; r(); }); }).then(() => fail(new Error(`chrome exited: ${err.slice(-600)}`)));
  p.stderr.on('data', d => { err = (err + d).slice(-4000); });
  p.stdio[3].on('error', () => {});
  p.stdio[4].on('data', d => {   // messages end with a NUL byte
    let buf = Buffer.concat([rest, d]), i;
    while ((i = buf.indexOf(0)) >= 0) { msg(JSON.parse(buf.subarray(0, i).toString('utf8'))); buf = buf.subarray(i + 1); }
    rest = buf;
  });
  const send = (method, params = {}, sessionId) => dead ? Promise.reject(dead) : new Promise((res, rej) => {
    pend.set(++id, { res, rej }); p.stdio[3].write(JSON.stringify({ id, method, params, sessionId }) + '\0');
  });
  const msg = m => {
    if (m.id) { const q = pend.get(m.id); pend.delete(m.id); return q && (m.error ? q.rej(new Error(m.error.message)) : q.res(m.result)); }
    if (m.method === 'Runtime.consoleAPICalled') {
      const text = m.params.args.map(a => a.value ?? a.description ?? '').join(' ');
      if (m.params.type === 'error' || text.startsWith('[rt]')) onLog('  page: ' + text);
    } else if (m.method === 'Runtime.exceptionThrown') onLog('  pageerror: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
  };
  const close = () => { p.kill('SIGKILL'); return exited.then(() => fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {})); };
  try {
    const t0 = Date.now(), sleep = ms => new Promise(r => setTimeout(r, ms));
    let target;
    while (!(target = (await send('Target.getTargets')).targetInfos.find(t => t.type === 'page'))) { if (Date.now() - t0 > timeout) throw new Error('chrome: no page'); await sleep(5); }
    const { sessionId } = await send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
    await send('Runtime.enable', {}, sessionId);
    const evaluate = async (fn, arg) => {
      const r = await send('Runtime.evaluate', { expression: `(${fn})(${arg === undefined ? '' : JSON.stringify(arg)})`, awaitPromise: true, returnByValue: true }, sessionId);
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return r.result.value;
    };
    // the page may still be on about:blank or mid-navigation (its context then dies under us): poll until the runtime is up
    for (;;) {
      const s = await evaluate(() => window.READY === true ? 'ok' : window.READY_ERROR ? String(window.READY_ERROR) : '').catch(e => { if (dead) throw e; return ''; });
      if (s === 'ok') break;
      if (s) throw Object.assign(new Error(s), { page: true });   // the page's own error: no fallback would fix it
      if (Date.now() - t0 > timeout) throw new Error('chrome: the runtime did not boot');
      await sleep(10);
    }
    return { evaluate, close };
  } catch (e) { await close(); throw e; }
}
