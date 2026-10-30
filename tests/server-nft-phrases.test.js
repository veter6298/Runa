'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const Database = require('better-sqlite3');
const { io: connect } = require('socket.io-client');

async function availablePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

function nextEvent(socket, event, predicate = () => true, timeout = 4000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`Timed out waiting for ${event}`));
    }, timeout);
    function handler(value) {
      if (!predicate(value)) return;
      clearTimeout(timer);
      socket.off(event, handler);
      resolve(value);
    }
    socket.on(event, handler);
  });
}

test('real chat messages award private opportunities and the full market flow persists across restarts', { timeout: 30000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runa-phrases-test-'));
  const dbPath = path.join(dir, 'test.sqlite');
  const port = await availablePort();
  const base = `http://127.0.0.1:${port}`;
  const root = path.join(__dirname, '..');
  let child;
  let database;
  const sockets = [];
  let logs = '';
  async function startServer() {
    child = spawn(process.execPath, ['--require', path.join(__dirname, 'support/deterministic-crypto.js'), 'server.js'], {
      cwd: root,
      env: { ...process.env, PORT: String(port), DATABASE_PATH: dbPath },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    child.stdout.on('data', chunk => { logs += chunk; });
    child.stderr.on('data', chunk => { logs += chunk; });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Server startup timed out: ${logs}`)), 10000);
      function onData(chunk) {
        if (!String(chunk).includes('Running on')) return;
        clearTimeout(timer);
        child.stdout.off('data', onData);
        resolve();
      }
      child.stdout.on('data', onData);
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`Server exited ${code}: ${logs}`)); });
    });
  }
  async function stopServer() {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exiting = new Promise(resolve => child.once('exit', resolve));
    child.kill('SIGTERM');
    await exiting;
  }
  t.after(async () => {
    sockets.forEach(socket => socket.disconnect());
    if (database && database.open) database.close();
    await stopServer();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await startServer();
  database = new Database(dbPath);
  database.pragma('busy_timeout = 5000');
  const request = async (token, method, endpoint, body) => {
    const headers = {};
    if (token) headers.authorization = `Bearer ${token}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const response = await fetch(base + endpoint, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  };
  async function makeSocket(token) {
    const socket = connect(base, { auth: { token }, transports: ['websocket'], reconnection: false });
    sockets.push(socket);
    await new Promise((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('connect_error', reject);
    });
    return socket;
  }
  async function send(socket, data) {
    const received = nextEvent(socket, 'new_message', msg => msg.chat_id === data.chatId);
    socket.emit('send_message', data);
    return received;
  }
  async function waitForActivity(userId, count) {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const row = database.prepare('SELECT message_count FROM nft_phrase_activity WHERE user_id = ?').get(userId);
      if (row && row.message_count === count) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error(`Activity ${count} was not recorded. Server log: ${logs}`);
  }
  const register = async username => {
    const result = await request(null, 'POST', '/api/auth/register', { username, password: 'secure-pass' });
    assert.equal(result.status, 200);
    return result.data;
  };
  const alice = await register('alice_integration');
  const bob = await register('bob_integration');
  let aliceSocket = await makeSocket(alice.token);
  const bobSocket = await makeSocket(bob.token);
  let bobOffers = 0;
  bobSocket.on('nft_phrase_offer', () => { bobOffers++; });

  const saved = await request(alice.token, 'POST', '/api/chats/saved');
  assert.equal(saved.status, 200);
  await send(aliceSocket, { chatId: saved.data.id, text: 'Записка себе' });
  await send(aliceSocket, { chatId: 'chat-general', text: '', fileUrl: '/stickers/tiktok/001.webp', fileType: 'sticker' });
  const solo = await request(alice.token, 'POST', '/api/chats', { type: 'group', title: 'Один участник' });
  await send(aliceSocket, { chatId: solo.data.id, text: 'Сообщение в пустую группу' });
  assert.equal(database.prepare('SELECT COUNT(*) n FROM nft_phrase_activity').get().n, 0);
  const denied = nextEvent(aliceSocket, 'error_message');
  aliceSocket.emit('send_message', { chatId: 'chat-runa-news', text: 'Без прав на публикацию' });
  assert.match(await denied, /администраторы/);
  assert.equal(database.prepare('SELECT COUNT(*) n FROM nft_phrase_activity').get().n, 0);

  const dm = await request(alice.token, 'POST', '/api/chats', { type: 'dm', userId: bob.user.id });
  assert.equal(dm.status, 200);
  await send(aliceSocket, { chatId: 'chat-general', text: 'Первое настоящее сообщение' });
  await waitForActivity(alice.user.id, 1);
  database.prepare('UPDATE nft_phrase_activity SET last_message_at = ? WHERE user_id = ?').run(Date.now() - 6000, alice.user.id);
  await send(aliceSocket, { chatId: dm.data.id, text: 'Сообщение в личном чате' });
  await waitForActivity(alice.user.id, 2);
  database.prepare('UPDATE nft_phrase_activity SET last_message_at = ? WHERE user_id = ?').run(Date.now() - 6000, alice.user.id);
  const offerEvent = nextEvent(aliceSocket, 'nft_phrase_offer');
  await send(aliceSocket, { chatId: 'chat-general', text: 'Третье настоящее сообщение' });
  const offer = await offerEvent;
  assert.ok(offer.id);
  assert.equal(bobOffers, 0);
  assert.equal((await request(bob.token, 'GET', '/api/nft-phrases/offer')).data.offer, null);
  assert.equal((await request(alice.token, 'GET', '/api/nft-phrases/offer')).data.offer.id, offer.id);
  aliceSocket.disconnect();
  aliceSocket = await makeSocket(alice.token);
  assert.equal((await request(alice.token, 'GET', '/api/nft-phrases/offer')).data.offer.id, offer.id, 'pending chance survives reconnect');
  aliceSocket.disconnect();
  bobSocket.disconnect();
  database.close();
  await stopServer();
  await startServer();
  database = new Database(dbPath);
  aliceSocket = await makeSocket(alice.token);
  assert.equal((await request(alice.token, 'GET', '/api/nft-phrases/offer')).data.offer.id, offer.id, 'pending chance survives a server restart');
  assert.equal((await request(bob.token, 'POST', `/api/nft-phrases/offer/${offer.id}/spin`, { text: 'Чужой шанс' })).status, 404);
  const spin = await request(alice.token, 'POST', `/api/nft-phrases/offer/${offer.id}/spin`, { text: 'Проверка интеграции' });
  assert.equal(spin.data.result, 'yes');
  const phraseId = spin.data.phrase.id;
  assert.equal((await request(alice.token, 'GET', `/api/users/${alice.user.id}/nft-phrases`)).data.length, 1);

  // Restarts keep both the collectible and idempotent result in SQLite.
  aliceSocket.disconnect();
  bobSocket.disconnect();
  database.close();
  await stopServer();
  await startServer();
  database = new Database(dbPath);
  const replay = await request(alice.token, 'POST', `/api/nft-phrases/offer/${offer.id}/spin`, { text: 'Не новый бросок' });
  assert.equal(replay.data.replayed, true);
  assert.equal(replay.data.phrase.id, phraseId);
  assert.equal((await request(alice.token, 'POST', `/api/nft-phrases/${phraseId}/sell`, { price: 70 })).status, 200);
  assert.equal((await request(bob.token, 'POST', `/api/nft-phrases/${phraseId}/buy`, { expectedPrice: 70 })).status, 400);
  await request(bob.token, 'POST', '/api/wallet/daily');
  const purchase = await request(bob.token, 'POST', `/api/nft-phrases/${phraseId}/buy`, { expectedPrice: 70 });
  assert.equal(purchase.status, 200);
  assert.equal(purchase.data.user.rubies, 30);
  assert.equal((await request(alice.token, 'GET', '/api/auth/me')).data.rubies, 70);
  assert.equal((await request(bob.token, 'GET', `/api/users/${bob.user.id}/nft-phrases`)).data[0].id, phraseId);
  const ledger = (await request(bob.token, 'GET', '/api/wallet/transactions')).data;
  assert.ok(ledger.some(row => row.amount === -70 && row.note.includes('NFT-фразы')));
});
