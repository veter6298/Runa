'use strict';

const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');

// A chance is earned from conversation, not from a client request. The activity
// window is shared across chats; saved messages and empty/media-only messages
// do not count. There is no limit on the number of phrases a user can own.
const ACTIVITY_WINDOW_MS = 10 * 60 * 1000;
const MESSAGE_INTERVAL_MS = 5 * 1000;
const MIN_ACTIVE_MESSAGES = 3;
const DROP_ODDS = 100; // 1% per qualifying message once the user is active
const OFFER_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_PHRASE_LENGTH = 120;
const MAX_PRICE = 10000000;

class PhraseError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function installNftPhrases({ app, db, io, requireAuth, emitUserUpdated, getProfileById, randomInt = max => crypto.randomInt(max), now = () => Date.now() }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS nft_phrases (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      creator_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      text TEXT NOT NULL,
      for_sale INTEGER NOT NULL DEFAULT 0,
      price INTEGER NOT NULL DEFAULT 0,
      listed_at TEXT DEFAULT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_nft_phrases_owner ON nft_phrases(owner_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_nft_phrases_sale ON nft_phrases(for_sale, listed_at);
    CREATE TABLE IF NOT EXISTS nft_phrase_offers (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_nft_phrase_offers_expiry ON nft_phrase_offers(expires_at);
    CREATE TABLE IF NOT EXISTS nft_phrase_activity (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      window_started_at INTEGER NOT NULL,
      last_message_at INTEGER NOT NULL,
      message_count INTEGER NOT NULL,
      last_text_hash TEXT NOT NULL,
      recent_messages TEXT NOT NULL DEFAULT '[]'
    );
    -- Keep only the outcome (not a failed draft) briefly for safe retries if
    -- the response is lost. A retry can never reroll or create a second item.
    CREATE TABLE IF NOT EXISTS nft_phrase_spins (
      offer_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      outcome TEXT NOT NULL CHECK(outcome IN ('yes', 'no')),
      phrase_id TEXT REFERENCES nft_phrases(id) ON DELETE SET NULL,
      expires_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_nft_phrase_spins_user ON nft_phrase_spins(user_id, expires_at);
    CREATE INDEX IF NOT EXISTS idx_nft_phrase_spins_expiry ON nft_phrase_spins(expires_at);
  `);

  // Existing installations may already have the earlier activity table.
  if (!db.prepare('PRAGMA table_info(nft_phrase_activity)').all().some(column => column.name === 'recent_messages')) {
    db.exec("ALTER TABLE nft_phrase_activity ADD COLUMN recent_messages TEXT NOT NULL DEFAULT '[]'");
  }

  const selectPhrase = `
    SELECT p.*, owner.username AS owner_username, owner.display_name AS owner_name,
           creator.username AS creator_username
    FROM nft_phrases p
    JOIN users owner ON owner.id = p.owner_id
    LEFT JOIN users creator ON creator.id = p.creator_id`;

  function phrasePayload(row, viewerId) {
    return {
      id: row.id, text: row.text,
      ownerId: row.owner_id, ownerUsername: row.owner_username,
      ownerName: row.owner_name || row.owner_username,
      creatorId: row.creator_id || null, creatorUsername: row.creator_username || null,
      createdAt: row.created_at, forSale: !!row.for_sale,
      price: row.price || 0, listedAt: row.listed_at || null,
      mine: row.owner_id === viewerId
    };
  }

  let lastExpirySweep = 0;
  function getPendingOffer(userId) {
    const time = now();
    const iso = new Date(time).toISOString();
    if (time - lastExpirySweep >= 60 * 60 * 1000) {
      db.prepare('DELETE FROM nft_phrase_offers WHERE expires_at <= ?').run(iso);
      db.prepare('DELETE FROM nft_phrase_spins WHERE expires_at <= ?').run(iso);
      lastExpirySweep = time;
    }
    db.prepare('DELETE FROM nft_phrase_offers WHERE user_id = ? AND expires_at <= ?').run(userId, iso);
    db.prepare('DELETE FROM nft_phrase_spins WHERE user_id = ? AND expires_at <= ?').run(userId, iso);
    const row = db.prepare('SELECT id, expires_at FROM nft_phrase_offers WHERE user_id = ?').get(userId);
    return row ? { id: row.id, expiresAt: row.expires_at } : null;
  }

  function notifyUpdated(ownerIds) {
    io.emit('nft_phrases_updated', { ownerIds });
  }

  // Called only after a real message has passed the chat's membership and
  // sending-permission checks and has been saved successfully.
  function onMessage({ userId, chatType, memberCount, text }) {
    if (!['dm', 'group', 'channel'].includes(chatType) || memberCount < 2 || !text.trim()) return null;
    const user = db.prepare('SELECT banned FROM users WHERE id = ?').get(userId);
    if (!user || user.banned || getPendingOffer(userId)) return null;

    const time = now();
    const hash = crypto.createHash('sha256').update(text.trim().replace(/\s+/g, ' ').toLowerCase()).digest('hex');
    const previous = db.prepare('SELECT * FROM nft_phrase_activity WHERE user_id = ?').get(userId);
    if (previous && (time - previous.last_message_at < MESSAGE_INTERVAL_MS || previous.last_text_hash === hash)) return null;

    let recent = [];
    try { recent = previous ? JSON.parse(previous.recent_messages) : []; } catch (e) { recent = []; }
    if (!Array.isArray(recent)) recent = [];
    recent = recent.filter(sentAt => Number.isFinite(sentAt) && sentAt <= time && time - sentAt < ACTIVITY_WINDOW_MS);
    recent.push(time);
    const count = recent.length;
    db.prepare(`
      INSERT INTO nft_phrase_activity (user_id, window_started_at, last_message_at, message_count, last_text_hash, recent_messages)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET window_started_at = excluded.window_started_at,
        last_message_at = excluded.last_message_at, message_count = excluded.message_count,
        last_text_hash = excluded.last_text_hash, recent_messages = excluded.recent_messages
    `).run(userId, recent[0], time, count, hash, JSON.stringify(recent));

    if (count < MIN_ACTIVE_MESSAGES || randomInt(DROP_ODDS) !== 0) return null;
    const offer = { id: uuidv4(), expiresAt: new Date(time + OFFER_TTL_MS).toISOString() };
    db.prepare('INSERT INTO nft_phrase_offers (id, user_id, expires_at) VALUES (?, ?, ?)')
      .run(offer.id, userId, offer.expiresAt);
    io.to(`user:${userId}`).emit('nft_phrase_offer', offer);
    return offer;
  }

  function route(handler) {
    return (req, res) => {
      try { handler(req, res); }
      catch (error) {
        if (error instanceof PhraseError) return res.status(error.status).json({ error: error.message });
        console.error('NFT phrases:', error);
        res.status(500).json({ error: 'Не удалось выполнить операцию с NFT-фразой' });
      }
    };
  }

  app.get('/api/nft-phrases/offer', requireAuth, route((req, res) => {
    res.json({ offer: getPendingOffer(req.user.id) });
  }));

  app.delete('/api/nft-phrases/offer/:id', requireAuth, route((req, res) => {
    const deleted = db.prepare('DELETE FROM nft_phrase_offers WHERE id = ? AND user_id = ?')
      .run(req.params.id, req.user.id);
    if (!deleted.changes) throw new PhraseError(404, 'Этот шанс уже использован или недоступен');
    io.to(`user:${req.user.id}`).emit('nft_phrase_offer_closed', { id: req.params.id });
    res.json({ ok: true });
  }));

  const spin = db.transaction((userId, offerId, text) => {
    // Consuming the offer, recording the result and creating the asset happen
    // together. Retries return the same result and never reroll.
    const iso = new Date(now()).toISOString();
    const previous = db.prepare('SELECT * FROM nft_phrase_spins WHERE offer_id = ? AND user_id = ? AND expires_at > ?')
      .get(offerId, userId, iso);
    if (previous) {
      const row = previous.phrase_id && db.prepare(`${selectPhrase} WHERE p.id = ?`).get(previous.phrase_id);
      return { result: previous.outcome, phrase: row ? phrasePayload(row, userId) : null, replayed: true };
    }
    const offer = db.prepare('SELECT * FROM nft_phrase_offers WHERE id = ? AND user_id = ? AND expires_at > ?')
      .get(offerId, userId, iso);
    if (!offer) throw new PhraseError(404, 'Этот шанс уже использован или истёк');
    db.prepare('DELETE FROM nft_phrase_offers WHERE id = ?').run(offer.id);
    const won = randomInt(2) === 0;
    let phrase = null;
    if (won) {
      const id = uuidv4();
      db.prepare('INSERT INTO nft_phrases (id, owner_id, creator_id, text) VALUES (?, ?, ?, ?)')
        .run(id, userId, userId, text);
      phrase = phrasePayload(db.prepare(`${selectPhrase} WHERE p.id = ?`).get(id), userId);
    }
    db.prepare('INSERT INTO nft_phrase_spins (offer_id, user_id, outcome, phrase_id, expires_at) VALUES (?, ?, ?, ?, ?)')
      .run(offer.id, userId, won ? 'yes' : 'no', phrase ? phrase.id : null, offer.expires_at);
    return { result: won ? 'yes' : 'no', phrase, replayed: false };
  });

  app.post('/api/nft-phrases/offer/:id/spin', requireAuth, route((req, res) => {
    if (!req.body || typeof req.body.text !== 'string') throw new PhraseError(400, 'Введите фразу');
    const text = req.body.text.trim();
    if (!text || text.length > MAX_PHRASE_LENGTH || /[\u0000-\u001f\u007f]/.test(text)) {
      throw new PhraseError(400, 'Фраза должна содержать от 1 до 120 символов в одной строке');
    }
    const result = spin(req.user.id, req.params.id, text);
    if (!result.replayed) {
      io.to(`user:${req.user.id}`).emit('nft_phrase_offer_closed', { id: req.params.id });
      if (result.result === 'yes') notifyUpdated([req.user.id]);
    }
    res.json(result);
  }));

  app.get('/api/users/:id/nft-phrases', requireAuth, route((req, res) => {
    if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(req.params.id)) {
      throw new PhraseError(404, 'Пользователь не найден');
    }
    const rows = db.prepare(`${selectPhrase} WHERE p.owner_id = ? ORDER BY p.created_at DESC, p.rowid DESC`)
      .all(req.params.id);
    res.json(rows.map(row => phrasePayload(row, req.user.id)));
  }));

  app.get('/api/nft-phrases/market', requireAuth, route((req, res) => {
    const rows = db.prepare(`${selectPhrase}
      WHERE p.for_sale = 1 OR p.owner_id = ?
      ORDER BY p.for_sale DESC, p.listed_at DESC, p.created_at DESC, p.rowid DESC`).all(req.user.id);
    const items = rows.map(row => phrasePayload(row, req.user.id));
    res.json({ forSale: items.filter(item => item.forSale && !item.mine), mine: items.filter(item => item.mine) });
  }));

  app.post('/api/nft-phrases/:id/sell', requireAuth, route((req, res) => {
    const phrase = db.prepare('SELECT * FROM nft_phrases WHERE id = ?').get(req.params.id);
    if (!phrase) throw new PhraseError(404, 'Фраза не найдена');
    if (phrase.owner_id !== req.user.id) throw new PhraseError(403, 'Это не ваша фраза');
    const price = Number(req.body && req.body.price);
    if (!Number.isSafeInteger(price) || price < 1 || price > MAX_PRICE) {
      throw new PhraseError(400, 'Цена должна быть целым числом от 1 до 10 000 000 рубинов');
    }
    const updated = db.prepare('UPDATE nft_phrases SET for_sale = 1, price = ?, listed_at = ? WHERE id = ? AND owner_id = ?')
      .run(price, new Date(now()).toISOString(), phrase.id, req.user.id);
    if (!updated.changes) throw new PhraseError(409, 'Владелец фразы изменился');
    notifyUpdated([req.user.id]);
    res.json({ ok: true });
  }));

  app.post('/api/nft-phrases/:id/unlist', requireAuth, route((req, res) => {
    const phrase = db.prepare('SELECT * FROM nft_phrases WHERE id = ?').get(req.params.id);
    if (!phrase) throw new PhraseError(404, 'Фраза не найдена');
    if (phrase.owner_id !== req.user.id) throw new PhraseError(403, 'Это не ваша фраза');
    const updated = db.prepare('UPDATE nft_phrases SET for_sale = 0, price = 0, listed_at = NULL WHERE id = ? AND owner_id = ?')
      .run(phrase.id, req.user.id);
    if (!updated.changes) throw new PhraseError(409, 'Владелец фразы изменился');
    notifyUpdated([req.user.id]);
    res.json({ ok: true });
  }));

  const buy = db.transaction((buyerId, phraseId, expectedPrice) => {
    const phrase = db.prepare('SELECT * FROM nft_phrases WHERE id = ?').get(phraseId);
    if (!phrase) throw new PhraseError(404, 'Фраза не найдена');
    if (!phrase.for_sale) throw new PhraseError(400, 'Фраза не выставлена на продажу');
    if (phrase.owner_id === buyerId) throw new PhraseError(400, 'Это уже ваша фраза');
    const price = Number(phrase.price);
    if (!Number.isSafeInteger(price) || price < 1 || price > MAX_PRICE) throw new PhraseError(400, 'Некорректная цена лота');
    if (price !== expectedPrice) throw new PhraseError(409, 'Цена изменилась. Обновите лот и подтвердите покупку заново');
    const buyer = db.prepare('SELECT id, rubies FROM users WHERE id = ?').get(buyerId);
    const seller = db.prepare('SELECT id FROM users WHERE id = ?').get(phrase.owner_id);
    if (!buyer || !seller) throw new PhraseError(400, 'Покупатель или владелец не найден');
    if ((buyer.rubies || 0) < price) throw new PhraseError(400, 'Недостаточно рубинов');

    const transferred = db.prepare(`UPDATE nft_phrases SET owner_id = ?, for_sale = 0, price = 0, listed_at = NULL
      WHERE id = ? AND owner_id = ? AND for_sale = 1 AND price = ?`).run(buyerId, phrase.id, seller.id, price);
    if (!transferred.changes) throw new PhraseError(409, 'Лот изменился. Обновите маркет');
    db.prepare('UPDATE users SET rubies = rubies - ? WHERE id = ?').run(price, buyerId);
    db.prepare('UPDATE users SET rubies = rubies + ? WHERE id = ?').run(price, seller.id);
    const tx = db.prepare('INSERT INTO wallet_transactions (id, user_id, kind, amount, currency, note) VALUES (?, ?, ?, ?, ?, ?)');
    tx.run(uuidv4(), buyerId, 'out', -price, 'rubies', `Покупка NFT-фразы «${phrase.text}»`);
    tx.run(uuidv4(), seller.id, 'in', price, 'rubies', `Продажа NFT-фразы «${phrase.text}»`);
    return { sellerId: seller.id, phrase: phrasePayload(db.prepare(`${selectPhrase} WHERE p.id = ?`).get(phrase.id), buyerId) };
  });

  app.post('/api/nft-phrases/:id/buy', requireAuth, route((req, res) => {
    const expectedPrice = Number(req.body && req.body.expectedPrice);
    if (!Number.isSafeInteger(expectedPrice) || expectedPrice < 1 || expectedPrice > MAX_PRICE) {
      throw new PhraseError(400, 'Подтвердите актуальную цену лота');
    }
    const result = buy(req.user.id, req.params.id, expectedPrice);
    emitUserUpdated(req.user.id);
    emitUserUpdated(result.sellerId);
    notifyUpdated([req.user.id, result.sellerId]);
    res.json({ ok: true, phrase: result.phrase, user: getProfileById(req.user.id, true) });
  }));

  return { onMessage, notifyUpdated };
}

module.exports = { installNftPhrases };
