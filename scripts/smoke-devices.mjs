import assert from 'node:assert/strict';
import { _electron as electron } from '@playwright/test';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const require = createRequire(import.meta.url);
const realNoMic = process.argv.includes('--real-no-mic');
const packaged = process.argv.includes('--packaged');
await mkdir('.cache', { recursive: true });
const data = await mkdtemp(resolve('.cache/device-check-'));
const executablePath = packaged
  ? resolve(process.platform === 'win32'
      ? 'release/win-unpacked/Automanager.exe'
      : 'release/linux-unpacked/automanager')
  : require('electron');
const args = process.platform === 'linux' ? ['--no-sandbox'] : [];
args.push('--disable-gpu', '--disable-background-networking');
if (!realNoMic) args.push('--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream');
if (!packaged) args.push(resolve('.'));
const app = await electron.launch({ executablePath, args, env: {
  ...process.env, DISPLAY: process.env.DISPLAY || ':99',
  AUTOMANAGER_DATA_DIR: data,
}, timeout: 30000 });
try {
  const page = await app.firstWindow();
  await page.waitForFunction(() => !!window.automanager);
  await page.evaluate(() => window.automanager.snapshot());
  if (!realNoMic) {
    await page.evaluate(() => window.automanager.updateSettings({ micDeviceId: 'disconnected-hotfix-microphone' }));
    const recorded = await page.evaluate(() => window.automanager.startSession({ title: '사라진 마이크 대체', audio: true, screen: false }));
    await delay(1500);
    await page.evaluate(() => window.automanager.pauseSession());
    await page.evaluate(() => window.automanager.resumeSession());
    await delay(700);
    await page.evaluate(() => window.automanager.stopSession());
    const detail = await page.evaluate(id => window.automanager.getSession(id), recorded.id);
    assert.equal(detail.session.audio, true);
    assert.ok(detail.chunks.reduce((sum, chunk) => sum + chunk.sampleCount, 0) > 16000, 'default microphone produced no audio');
    assert.equal((await page.evaluate(() => window.automanager.snapshot())).settings.micDeviceId, '');
    const capture = app.windows().find(window => window.url().includes('capture.html'));
    assert.ok(capture, 'capture window missing');
    // Simulate the OS microphone failure at Chromium's media boundary; keep the display request path untouched.
    await capture.evaluate(() => {
      const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = constraints => {
        if (constraints.audio && constraints.video === false)
          return Promise.reject(new DOMException('Requested device not found', 'NotFoundError'));
        return original(constraints);
      };
    });
  } else {
    const inputs = await page.evaluate(async () => (await navigator.mediaDevices.enumerateDevices()).filter(device => device.kind === 'audioinput').length);
    assert.equal(inputs, 0, '--real-no-mic needs an environment without audio input');
  }
  const session = await page.evaluate(() => window.automanager.startSession({ title: '마이크 없는 화면 기록', audio: true, screen: true }));
  assert.equal(session.audio, false, 'unavailable microphone must not be advertised as recording');
  assert.equal(session.screen, true);
  assert.equal((await page.evaluate(() => window.automanager.snapshot())).settings.audioEnabled, true, 'retain the preference for the next recording');
  await page.evaluate(() => window.automanager.pauseSession());
  await page.evaluate(() => window.automanager.resumeSession());
  await page.evaluate(id => window.automanager.addComment(id, '마이크 없이 화면과 작업 단계 기록'), session.id);
  await page.evaluate(() => window.automanager.stopSession());
  const detail = await page.evaluate(id => window.automanager.getSession(id), session.id);
  assert.equal(detail.session.audio, false);
  assert.equal(detail.chunks.length, 0);
  assert.ok(detail.steps.some(step => step.warning?.includes('마이크')));
  const screenshot = detail.steps.find(step => step.kind === 'comment' && step.screenshot);
  assert.ok(screenshot, 'screen capture must continue without a microphone');
  const bytes = await readFile(join(data, 'tracker', 'sessions', session.id, screenshot.screenshot));
  assert.ok(bytes.length > 1000, 'screen capture was empty');
  await assert.rejects(page.evaluate(() => window.automanager.startSession({ audio: true, screen: false })), /마이크/);
  assert.equal((await page.evaluate(() => window.automanager.snapshot())).activeSession, null);
  const retry = await page.evaluate(() => window.automanager.startSession({ audio: false, screen: true }));
  await page.evaluate(() => window.automanager.stopSession());
  assert.equal(retry.screen, true);
  if (!realNoMic) {
    const capture = app.windows().find(window => window.url().includes('capture.html'));
    await capture.evaluate(() => {
      navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('Permission denied', 'NotAllowedError'));
    });
    await assert.rejects(page.evaluate(() => window.automanager.startSession({ audio: true, screen: true })), /권한/);
    assert.equal((await page.evaluate(() => window.automanager.snapshot())).activeSession, null);
  }
  console.log('DEVICE_HOTFIX_PASS', JSON.stringify({ packaged, realNoMic, syntheticMedia: !realNoMic, screenshotBytes: bytes.length, data }));
} finally {
  await app.close();
}
