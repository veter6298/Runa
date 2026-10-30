'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const Database = require('better-sqlite3');
const { installNftPhrases } = require('../lib/nft-phrases');

async function fixture(t, rolls = {}) {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT, display_name TEXT, rubies INTEGER DEFAULT 0, banned INTEGER DEFAULT 0);
    CREATE TABLE wallet_transactions (id TEXT PRIMARY KEY, user_id TEXT, kind TEXT, amount REAL, currency TEXT, note TEXT);
    INSERT INTO users (id, username, display_name, rubies) VALUES
      ('alice', 'alice', 'Alice', 0), ('bob', 'bob', 'Bob', 100), ('carol', 'carol', 'Carol', 100);
  `);
  const events = [];
  const io = {
    emit: (name, data) => events.push({ name, data, room: 'all' }),
    to: room => ({ emit: (name, data) => events.push({ name, data, room }) })
  };
  const updates = [];
  const app = express();
  app.use(express.json());
  const requireAuth = (req, res, next) => {
    req.user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.headers['x-test-user'] || '');
    if (!req.user || req.user.banned) return res.status(401).json({ error: 'Unauthorized' });
    next();
  };
  let clock = Date.parse('2026-10-30T12:00:00Z');
  const calls = [];
  const feature = installNftPhrases({
    app, db, io, requireAuth,
    now: () => clock,
    randomInt: max => {
      calls.push(max);
      const queue = max === 100 ? rolls.drop : rolls.spin;
      return queue && queue.length ? queue.shift() : 0;
    },
    emitUserUpdated: id => updates.push(id),
    getProfileById: id => db.prepare('SELECT id, rubies FROM users WHERE id = ?').get(id)
  });
  const server = await new Promise(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    db.close();
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (user, method, path, body) => {
    const headers = { 'x-test-user': user || '' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, data: await res.json() };
  };
  return {
    db, events, updates, calls, request,
    advance: ms => { clock += ms; },
    say: (text, chatType = 'group', memberCount = 2, userId = 'alice') => feature.onMessage({ userId, chatType, memberCount, text })
  };
}

async function earn(f, userId = 'alice', suffix = '') {
  f.say(`Первое ${suffix}`, 'group', 2, userId);
  f.advance(5000);
  f.say(`Второе ${suffix}`, 'dm', 2, userId);
  f.advance(5000);
  return f.say(`Третье ${suffix}`, 'channel', 2, userId);
}

test('offers are private, rare, and earned only through real active conversation across chat types', async t => {
  const f = await fixture(t, { drop: [42, 0] });
  assert.equal((await f.request('', 'GET', '/api/nft-phrases/offer')).status, 401);
  assert.equal(f.say('Личное', 'saved', 1), null);
  assert.equal(f.say('Один участник', 'group', 1), null);
  assert.equal(f.say('   ', 'group', 2), null);
  assert.equal(f.say('Привет', 'group'), null);
  f.advance(1000);
  assert.equal(f.say('Слишком быстро', 'dm'), null);
  f.advance(4000);
  assert.equal(f.say('  привет  ', 'dm'), null, 'repeated text is not activity');
  assert.equal(f.say('Как дела?', 'dm'), null);
  f.advance(5000);
  assert.equal(f.say('Новости канала', 'channel'), null, 'a non-winning 1% roll does not create an offer');
  assert.deepEqual(f.calls, [100]);
  f.advance(5000);
  const offer = f.say('Ещё одно сообщение', 'group');
  assert.ok(offer && offer.id);
  assert.deepEqual(f.calls, [100, 100]);
  assert.equal(f.events.filter(e => e.name === 'nft_phrase_offer').length, 1);
  assert.equal(f.events.find(e => e.name === 'nft_phrase_offer').room, 'user:alice');
  assert.deepEqual((await f.request('alice', 'GET', '/api/nft-phrases/offer')).data.offer, offer);
  assert.equal((await f.request('bob', 'GET', '/api/nft-phrases/offer')).data.offer, null);
  f.advance(5000);
  assert.equal(f.say('Ещё', 'group'), null, 'at most one unresolved offer');
  assert.equal(f.events.filter(e => e.name === 'nft_phrase_offer').length, 1);
  f.db.prepare('UPDATE users SET banned = 1 WHERE id = ?').run('bob');
  f.advance(5000);
  assert.equal(f.say('Заблокирован', 'group', 2, 'bob'), null);
});

test('the activity window rolls forward and retains recent messages', async t => {
  const f = await fixture(t);
  f.say('Старое сообщение');
  f.advance(9 * 60 * 1000);
  f.say('Сообщение в пределах окна');
  f.advance(61 * 1000);
  assert.equal(f.say('Ещё одно в пределах окна'), null);
  f.advance(5000);
  const offer = f.say('Третье за последние десять минут');
  assert.ok(offer);
  assert.equal(f.db.prepare('SELECT message_count FROM nft_phrase_activity WHERE user_id = ?').get('alice').message_count, 3);
});

test('concurrent spin requests consume a chance only once', async t => {
  const f = await fixture(t, { spin: [0, 1] });
  const offer = await earn(f);
  const endpoint = `/api/nft-phrases/offer/${offer.id}/spin`;
  const results = await Promise.all([
    f.request('alice', 'POST', endpoint, { text: 'Одна фраза' }),
    f.request('alice', 'POST', endpoint, { text: 'Одна фраза' })
  ]);
  assert.deepEqual(results.map(result => result.data.result), ['yes', 'yes']);
  assert.equal(results[0].data.phrase.id, results[1].data.phrase.id);
  assert.equal(results.filter(result => result.data.replayed).length, 1);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM nft_phrases').get().n, 1);
  assert.deepEqual(f.calls.filter(max => max === 2), [2]);
});

test('spins are validated, atomic, retryable without rerolls, and can be won repeatedly', async t => {
  const f = await fixture(t, { spin: [0, 1, 0] });
  const offer = await earn(f);
  assert.ok(offer);
  const endpoint = `/api/nft-phrases/offer/${offer.id}/spin`;
  assert.equal((await f.request('bob', 'POST', endpoint, { text: 'Чужая' })).status, 404);
  for (const text of ['', ' '.repeat(3), 'x'.repeat(121), 'первая\nвторая']) {
    assert.equal((await f.request('alice', 'POST', endpoint, { text })).status, 400);
  }
  assert.equal((await f.request('alice', 'POST', endpoint, {})).status, 400);
  assert.equal((await f.request('alice', 'GET', '/api/nft-phrases/offer')).data.offer.id, offer.id);
  const won = await f.request('alice', 'POST', endpoint, { text: '  Всё только начинается  ' });
  assert.equal(won.status, 200);
  assert.equal(won.data.result, 'yes');
  assert.equal(won.data.phrase.text, 'Всё только начинается');
  assert.equal(won.data.phrase.creatorId, 'alice');
  assert.equal((await f.request('alice', 'GET', '/api/nft-phrases/offer')).data.offer, null);
  const replay = await f.request('alice', 'POST', endpoint, { text: 'Попытка изменить результат' });
  assert.equal(replay.data.result, 'yes');
  assert.equal(replay.data.phrase.id, won.data.phrase.id);
  assert.equal(replay.data.phrase.text, 'Всё только начинается');
  assert.equal(replay.data.replayed, true);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM nft_phrases').get().n, 1);

  f.advance(5000);
  const second = f.say('Новый шанс после победы');
  assert.ok(second);
  const lost = await f.request('alice', 'POST', `/api/nft-phrases/offer/${second.id}/spin`, { text: 'Секретный проигранный текст' });
  assert.equal(lost.data.result, 'no');
  assert.equal(lost.data.phrase, null);
  const lostReplay = await f.request('alice', 'POST', `/api/nft-phrases/offer/${second.id}/spin`, { text: 'Попытка выиграть' });
  assert.equal(lostReplay.data.result, 'no');
  assert.equal(lostReplay.data.replayed, true);
  const recordedLoss = f.db.prepare('SELECT * FROM nft_phrase_spins WHERE offer_id = ?').get(second.id);
  assert.equal(recordedLoss.phrase_id, null);
  assert.equal(JSON.stringify(recordedLoss).includes('Секретный'), false, 'a lost draft is not stored');
  assert.equal((await f.request('alice', 'GET', '/api/users/alice/nft-phrases')).data.length, 1);

  f.advance(5000);
  const third = f.say('Новый шанс после проигрыша');
  const another = await f.request('alice', 'POST', `/api/nft-phrases/offer/${third.id}/spin`, { text: 'Вторая фраза' });
  assert.equal(another.data.result, 'yes');
  assert.notEqual(another.data.phrase.id, won.data.phrase.id);
  assert.equal((await f.request('bob', 'GET', '/api/users/alice/nft-phrases')).data.length, 2);
  assert.deepEqual(f.calls.filter(n => n === 2), [2, 2, 2]);
});

test('skipped and expired chances cannot be played, and new chances can still be earned', async t => {
  const f = await fixture(t);
  const first = await earn(f);
  assert.equal((await f.request('bob', 'DELETE', `/api/nft-phrases/offer/${first.id}`)).status, 404);
  assert.equal((await f.request('alice', 'DELETE', `/api/nft-phrases/offer/${first.id}`)).status, 200);
  assert.equal((await f.request('alice', 'POST', `/api/nft-phrases/offer/${first.id}/spin`, { text: 'не получится' })).status, 404);
  f.advance(5000);
  const second = f.say('Другой шанс');
  assert.ok(second);
  f.advance(24 * 60 * 60 * 1000 + 1);
  assert.equal((await f.request('alice', 'GET', '/api/nft-phrases/offer')).data.offer, null);
  assert.equal((await f.request('alice', 'POST', `/api/nft-phrases/offer/${second.id}/spin`, { text: 'слишком поздно' })).status, 404);
  const third = await earn(f, 'alice', 'после срока');
  assert.ok(third);
});

test('market enforces ownership and price, transfers rubies and preserves creator attribution atomically', async t => {
  const f = await fixture(t);
  const offer = await earn(f);
  const won = await f.request('alice', 'POST', `/api/nft-phrases/offer/${offer.id}/spin`, { text: 'Фраза для маркета' });
  const id = won.data.phrase.id;
  const sell = `/api/nft-phrases/${id}/sell`;
  const unlist = `/api/nft-phrases/${id}/unlist`;
  const buy = `/api/nft-phrases/${id}/buy`;
  assert.equal((await f.request('bob', 'POST', sell, { price: 1 })).status, 403);
  assert.equal((await f.request('bob', 'POST', unlist)).status, 403);
  for (const price of [0, -1, 1.5, 10000001, 'abc']) {
    assert.equal((await f.request('alice', 'POST', sell, { price })).status, 400);
  }
  assert.equal((await f.request('alice', 'POST', sell, { price: 75 })).status, 200);
  const buyerMarket = (await f.request('bob', 'GET', '/api/nft-phrases/market')).data;
  assert.equal(buyerMarket.forSale.length, 1);
  assert.equal(buyerMarket.forSale[0].text, 'Фраза для маркета');
  assert.equal((await f.request('alice', 'POST', buy, { expectedPrice: 75 })).status, 400, 'cannot buy your own item');
  assert.equal((await f.request('alice', 'POST', unlist)).status, 200);
  assert.equal((await f.request('bob', 'POST', buy, { expectedPrice: 75 })).status, 400, 'unlisted items cannot be purchased');
  assert.equal((await f.request('alice', 'POST', sell, { price: 101 })).status, 200);
  assert.equal((await f.request('bob', 'POST', buy, { expectedPrice: 75 })).status, 409, 'a stale price requires renewed consent');
  assert.equal((await f.request('bob', 'POST', buy, { expectedPrice: 101 })).status, 400, 'insufficient funds');
  assert.equal(f.db.prepare("SELECT rubies FROM users WHERE id = 'bob'").get().rubies, 100);
  assert.equal((await f.request('alice', 'POST', sell, { price: 75 })).status, 200);
  const purchases = await Promise.all([f.request('bob', 'POST', buy, { expectedPrice: 75 }), f.request('carol', 'POST', buy, { expectedPrice: 75 })]);
  assert.deepEqual(purchases.map(x => x.status).sort(), [200, 400]);
  const winner = purchases[0].status === 200 ? 'bob' : 'carol';
  const loser = winner === 'bob' ? 'carol' : 'bob';
  assert.equal(f.db.prepare('SELECT rubies FROM users WHERE id = ?').get(winner).rubies, 25);
  assert.equal(f.db.prepare('SELECT rubies FROM users WHERE id = ?').get(loser).rubies, 100);
  assert.equal(f.db.prepare("SELECT rubies FROM users WHERE id = 'alice'").get().rubies, 75);
  const phrase = (await f.request(winner, 'GET', `/api/users/${winner}/nft-phrases`)).data[0];
  assert.equal(phrase.ownerId, winner);
  assert.equal(phrase.creatorId, 'alice');
  assert.equal(phrase.creatorUsername, 'alice');
  assert.equal(phrase.forSale, false);
  assert.equal(phrase.price, 0);
  assert.equal((await f.request('bob', 'GET', '/api/users/alice/nft-phrases')).data.length, 0);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM wallet_transactions').get().n, 2);
  assert.deepEqual(f.updates.sort(), ['alice', winner].sort());
  assert.equal((await f.request('alice', 'POST', sell, { price: 10 })).status, 403);
  f.db.prepare('DELETE FROM users WHERE id = ?').run('alice');
  const afterCreatorDeletion = (await f.request(winner, 'GET', `/api/users/${winner}/nft-phrases`)).data[0];
  assert.equal(afterCreatorDeletion.creatorId, null);
  assert.equal(afterCreatorDeletion.text, 'Фраза для маркета');
  f.db.prepare('DELETE FROM users WHERE id = ?').run(winner);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM nft_phrases').get().n, 0);
});

test('collections and the market do not impose a 300-item ownership limit', async t => {
  const f = await fixture(t);
  const insert = f.db.prepare('INSERT INTO nft_phrases (id, owner_id, creator_id, text) VALUES (?, ?, ?, ?)');
  f.db.transaction(() => {
    for (let i = 0; i < 325; i++) insert.run(`item-${i}`, 'alice', 'alice', `Фраза ${i}`);
  })();
  assert.equal((await f.request('alice', 'GET', '/api/users/alice/nft-phrases')).data.length, 325);
  assert.equal((await f.request('alice', 'GET', '/api/nft-phrases/market')).data.mine.length, 325);
});
