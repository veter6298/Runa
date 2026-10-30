const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { installNftPhrases } = require('./lib/nft-phrases');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 50 * 1024 * 1024 });

const uploadDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const ext = (path.extname(file.originalname) || '').toLowerCase().slice(0, 10);
    cb(null, `${uuidv4()}${ext}`);
  }
});
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } });
const imageUpload = multer({
  storage,
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /^image\//.test(file.mimetype))
});

app.use(express.json({ limit: '2mb' }));
const publicDir = path.join(__dirname, 'public');
app.use(express.static(publicDir, {
  setHeaders(res, filePath) {
    const rel = filePath.replace(publicDir, '').replace(/\\/g, '/');
    if (rel.startsWith('/uploads/') || rel.startsWith('/stickers/') || rel.startsWith('/icons/')) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    } else {
      res.setHeader('Cache-Control', 'no-cache');
    }
  }
}));

const db = new Database(process.env.DATABASE_PATH || path.join(__dirname, 'database.sqlite'));
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('busy_timeout = 5000');
db.pragma('cache_size = -20000');
db.pragma('foreign_keys = ON');

/* ------------------------------------------------------------------ */
/*  СХЕМА И МИГРАЦИИ                                                   */
/* ------------------------------------------------------------------ */
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE,
    password TEXT,
    display_name TEXT,
    bio TEXT DEFAULT '',
    city TEXT DEFAULT '',
    avatar TEXT DEFAULT '',
    phone_number TEXT DEFAULT NULL,
    rubies INTEGER DEFAULT 0,
    mops_balance REAL DEFAULT 0.0,
    show_balance_in_profile INTEGER DEFAULT 1,
    is_premium INTEGER DEFAULT 0,
    is_admin INTEGER DEFAULT 0,
    level INTEGER DEFAULT 1,
    profile_style TEXT DEFAULT 'telegram',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS nft_usernames (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    username TEXT UNIQUE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS badges (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    icon TEXT,
    title TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS chats (
    id TEXT PRIMARY KEY,
    type TEXT,
    title TEXT,
    about TEXT DEFAULT '',
    avatar TEXT DEFAULT '',
    owner_id TEXT,
    pinned INTEGER DEFAULT 0,
    badge_type TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS chat_members (
    chat_id TEXT,
    user_id TEXT,
    role TEXT DEFAULT 'member',
    last_read_at TEXT DEFAULT NULL,
    PRIMARY KEY (chat_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    chat_id TEXT,
    sender_id TEXT,
    text TEXT,
    file_url TEXT DEFAULT NULL,
    file_name TEXT DEFAULT NULL,
    file_type TEXT DEFAULT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS clans (
    id TEXT PRIMARY KEY,
    name TEXT UNIQUE,
    tag TEXT,
    leader_id TEXT,
    members_count INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS clan_members (
    clan_id TEXT,
    user_id TEXT,
    role TEXT DEFAULT 'member',
    PRIMARY KEY (clan_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS wallet_transactions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    amount REAL NOT NULL,
    currency TEXT NOT NULL,
    note TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS message_reactions (
    message_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    emoji TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (message_id, user_id)
  );
`);

const ensureColumn = (table, column, definition) => {
  try {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all();
    if (!cols.some(c => c.name === column)) {
      db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run();
    }
  } catch (e) { console.error(`migration ${table}.${column}:`, e.message); }
};

ensureColumn('users', 'rubies', 'INTEGER DEFAULT 0');
ensureColumn('users', 'profile_track', "TEXT DEFAULT ''");
ensureColumn('users', 'mops_balance', 'REAL DEFAULT 0.0');
ensureColumn('users', 'show_balance_in_profile', 'INTEGER DEFAULT 1');
ensureColumn('users', 'is_premium', 'INTEGER DEFAULT 0');
ensureColumn('users', 'level', 'INTEGER DEFAULT 1');
ensureColumn('users', 'profile_style', "TEXT DEFAULT 'telegram'");
ensureColumn('users', 'city', "TEXT DEFAULT ''");
ensureColumn('users', 'banned', 'INTEGER DEFAULT 0');
ensureColumn('users', 'banner', "TEXT DEFAULT ''");
ensureColumn('users', 'avatar_frame', "TEXT DEFAULT ''");
ensureColumn('users', 'profile_bg', "TEXT DEFAULT ''");
ensureColumn('users', 'username_color', "TEXT DEFAULT ''");
ensureColumn('users', 'accent_color', "TEXT DEFAULT ''");
ensureColumn('users', 'theme', "TEXT DEFAULT 'dark'");
ensureColumn('users', 'notifications', 'INTEGER DEFAULT 1');
ensureColumn('users', 'language', "TEXT DEFAULT 'ru'");
ensureColumn('users', 'font_size', 'INTEGER DEFAULT 100');
ensureColumn('users', 'ui_scale', 'INTEGER DEFAULT 100');
ensureColumn('users', 'sounds', 'INTEGER DEFAULT 1');
ensureColumn('users', 'mic', 'INTEGER DEFAULT 1');
ensureColumn('users', 'card_style', "TEXT DEFAULT 'classic'");
ensureColumn('users', 'font_family', "TEXT DEFAULT 'rubik'");
ensureColumn('users', 'bold_text', 'INTEGER DEFAULT 0');
ensureColumn('users', 'chat_wallpaper', "TEXT DEFAULT 'runa'");
ensureColumn('users', 'cursor_style', "TEXT DEFAULT 'default'");
ensureColumn('users', 'chat_pattern', "TEXT DEFAULT 'doodle'");
ensureColumn('users', 'last_daily', "TEXT DEFAULT NULL");
ensureColumn('users', 'last_seen', 'DATETIME DEFAULT NULL');
ensureColumn('chats', 'pinned', 'INTEGER DEFAULT 0');
ensureColumn('chats', 'badge_type', "TEXT DEFAULT ''");
ensureColumn('chats', 'username', "TEXT DEFAULT ''");
ensureColumn('chats', 'permissions', "TEXT DEFAULT ''");
ensureColumn('chats', 'is_public', 'INTEGER DEFAULT 0');
ensureColumn('chats', 'invite_code', "TEXT DEFAULT ''");
ensureColumn('chat_members', 'last_read_at', 'TEXT DEFAULT NULL');
ensureColumn('chat_members', 'muted', 'INTEGER DEFAULT 0');
ensureColumn('messages', 'reply_to', 'TEXT DEFAULT NULL');
ensureColumn('messages', 'deleted', 'INTEGER DEFAULT 0');

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_messages_chat_created ON messages(chat_id, deleted, created_at);
  CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender_id);
  CREATE INDEX IF NOT EXISTS idx_chat_members_user ON chat_members(user_id, chat_id);
  CREATE INDEX IF NOT EXISTS idx_reactions_message ON message_reactions(message_id);
  CREATE INDEX IF NOT EXISTS idx_chats_username ON chats(username);
  CREATE INDEX IF NOT EXISTS idx_chats_invite ON chats(invite_code);
`);
ensureColumn('messages', 'edited_at', 'DATETIME DEFAULT NULL');
ensureColumn('badges', 'color', "TEXT DEFAULT ''");
ensureColumn('nft_usernames', 'for_sale', 'INTEGER DEFAULT 0');
ensureColumn('nft_usernames', 'price', 'INTEGER DEFAULT 0');
ensureColumn('nft_usernames', 'listed_at', 'DATETIME DEFAULT NULL');
ensureColumn('badges', 'created_at', "TEXT DEFAULT ''");
ensureColumn('users', 'anon_number', "TEXT DEFAULT ''");
ensureColumn('chats', 'gift_shelf', "TEXT DEFAULT ''");
ensureColumn('gifts', 'file_url', "TEXT DEFAULT ''");
ensureColumn('gifts', 'file_type', "TEXT DEFAULT ''");
ensureColumn('gifts', 'description', "TEXT DEFAULT ''");

db.exec(`
  CREATE TABLE IF NOT EXISTS gifts (
    id TEXT PRIMARY KEY,
    slug TEXT UNIQUE,
    title TEXT,
    emoji TEXT,
    price INTEGER DEFAULT 0,
    rarity TEXT DEFAULT 'common',
    active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS user_gifts (
    id TEXT PRIMARY KEY,
    gift_id TEXT,
    from_user_id TEXT,
    to_user_id TEXT,
    message TEXT DEFAULT '',
    anonymous INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS stories (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    media_url TEXT NOT NULL,
    media_type TEXT DEFAULT 'image',
    caption TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    expires_at TEXT NOT NULL,
    views INTEGER DEFAULT 0,
    deleted INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS story_views (
    story_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    viewed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (story_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS giveaways (
    id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL,
    creator_id TEXT NOT NULL,
    title TEXT DEFAULT '',
    prize_type TEXT DEFAULT 'rubies',
    prize_value TEXT DEFAULT '',
    winners_count INTEGER DEFAULT 1,
    participants_count INTEGER DEFAULT 0,
    ends_at TEXT NOT NULL,
    status TEXT DEFAULT 'active',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    finished_at TEXT DEFAULT NULL
  );
  CREATE TABLE IF NOT EXISTS giveaway_participants (
    giveaway_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    winner INTEGER DEFAULT 0,
    PRIMARY KEY (giveaway_id, user_id)
  );
`);

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_stories_active ON stories(deleted, expires_at);
  CREATE INDEX IF NOT EXISTS idx_story_views_user ON story_views(user_id);
  CREATE INDEX IF NOT EXISTS idx_giveaways_chat ON giveaways(chat_id, status, ends_at);
  CREATE INDEX IF NOT EXISTS idx_giveaway_participants ON giveaway_participants(giveaway_id);
`);

/* ------------------------------------------------------------------ */
/*  ХЕЛПЕРЫ                                                            */
/* ------------------------------------------------------------------ */
const nowIso = () => new Date().toISOString();
const cleanUsername = (u) => String(u || '').trim().toLowerCase().replace(/^@/, '');
const validUsername = (u) => /^[a-z0-9_]{3,32}$/.test(u);
const hashPassword = (p) => bcrypt.hashSync(String(p), 10);
const checkPassword = (plain, stored) => {
  if (!stored) return false;
  if (String(stored).startsWith('$2')) return bcrypt.compareSync(String(plain), stored);
  return String(plain) === String(stored);
};

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const created = nowIso();
  const expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  db.prepare('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(token, userId, created, expires);
  return token;
}

function userByToken(token) {
  if (!token) return null;
  const row = db.prepare(`
    SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token = ? AND s.expires_at > ?
  `).get(token, nowIso());
  return row || null;
}

function tokenFromReq(req) {
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7);
  return req.headers['x-token'] || req.query.token || null;
}

function requireAuth(req, res, next) {
  const user = userByToken(tokenFromReq(req));
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  if (user.banned) return res.status(403).json({ error: 'Аккаунт заблокирован' });
  req.user = user;
  next();
}

function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (!req.user.is_admin) return res.status(403).json({ error: 'Forbidden' });
    next();
  });
}

const publicUser = (u) => u ? {
  id: u.id, username: u.username, displayName: u.display_name || u.username,
  avatar: u.avatar || '', isAdmin: !!u.is_admin, isPremium: !!u.is_premium,
  level: u.level || 1, banned: !!u.banned, online: isOnline(u.id), lastSeen: u.last_seen || null
} : null;

const isOnline = (id) => onlineSockets.has(id);

function badgesFor(userId) {
  return db.prepare('SELECT id, icon, title, color FROM badges WHERE user_id = ? ORDER BY created_at ASC').all(userId)
    .map(b => ({ ...b, color: b.color || '' }));
}

function nftFor(userId) {
  return db.prepare(`SELECT id, username, for_sale, price, listed_at
    FROM nft_usernames WHERE user_id = ? ORDER BY created_at ASC`).all(userId)
    .map(n => ({ id: n.id, username: n.username, forSale: !!n.for_sale, price: n.price || 0, listedAt: n.listed_at || null }));
}

/* Юзернейм занят, если он есть у пользователя, в NFT-коллекции или у чата */
function usernameTaken(username, excludeUserId = null) {
  const user = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (user && user.id !== excludeUserId) return true;
  const nft = db.prepare('SELECT user_id FROM nft_usernames WHERE username = ?').get(username);
  if (nft) return true;
  const chat = db.prepare('SELECT id FROM chats WHERE username = ?').get(username);
  return !!chat;
}

/* Найти пользователя по обычному или NFT-юзернейму */
function findUserByUsername(username) {
  let user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user) {
    const nft = db.prepare('SELECT user_id FROM nft_usernames WHERE username = ?').get(username);
    if (nft) user = db.prepare('SELECT * FROM users WHERE id = ?').get(nft.user_id);
  }
  return user || null;
}

function clanFor(userId) {
  return db.prepare(`
    SELECT c.* FROM clans c JOIN clan_members m ON m.clan_id = c.id WHERE m.user_id = ? LIMIT 1
  `).get(userId) || null;
}

function fullProfile(row, includePrivate = false) {
  if (!row) return null;
  const profile = {
    id: row.id, username: row.username, displayName: row.display_name || row.username,
    bio: row.bio || '', city: row.city || '', avatar: row.avatar || '',
    banner: row.banner || '', avatarFrame: row.avatar_frame || '',
    profileBg: row.profile_bg || '', usernameColor: row.username_color || '',
    accentColor: row.accent_color || '',
    rubies: row.rubies || 0, mopsBalance: row.mops_balance || 0,
    showBalance: !!row.show_balance_in_profile, isPremium: !!row.is_premium,
    isAdmin: !!row.is_admin, level: row.level || 1,
    profileStyle: row.profile_style || 'telegram',
    createdAt: row.created_at, badges: badgesFor(row.id),
    nftUsernames: nftFor(row.id), clan: clanFor(row.id),
    online: isOnline(row.id), lastSeen: row.last_seen || null,
    banned: !!row.banned,
    anonymousNumber: row.anon_number || '',
    giftsCount: db.prepare('SELECT COUNT(*) c FROM user_gifts WHERE to_user_id = ?').get(row.id).c || 0
  };
  if (includePrivate) {
    profile.phoneNumber = row.phone_number || null;
    profile.theme = row.theme || 'dark';
    profile.notifications = !!row.notifications;
    profile.language = row.language || 'ru';
    profile.fontSize = row.font_size || 100;
    profile.uiScale = row.ui_scale || 100;
    profile.sounds = !!row.sounds;
    profile.mic = !!row.mic;
    profile.cardStyle = row.card_style || 'classic';
    profile.fontFamily = row.font_family || 'rubik';
    profile.boldText = !!row.bold_text;
    profile.chatWallpaper = row.chat_wallpaper || 'runa';
    profile.cursorStyle = row.cursor_style || 'default';
    profile.chatPattern = row.chat_pattern || 'doodle';
  }
  return profile;
}

function getProfileById(id, includePrivate = false) {
  return fullProfile(db.prepare('SELECT * FROM users WHERE id = ?').get(id), includePrivate);
}

/* Публичный профиль — всем, приватный (телефон, настройки) — только владельцу */
function emitUserUpdated(userId) {
  const pub = getProfileById(userId, false);
  if (pub) io.emit('user_updated', pub);
  const priv = getProfileById(userId, true);
  if (priv) io.to(`user:${userId}`).emit('user_updated', priv);
}

function chatMembers(chatId) {
  return db.prepare('SELECT user_id, role FROM chat_members WHERE chat_id = ?').all(chatId);
}

function isMember(chatId, userId) {
  return !!db.prepare('SELECT 1 FROM chat_members WHERE chat_id = ? AND user_id = ?').get(chatId, userId);
}

function chatRole(chatId, userId) {
  const row = db.prepare('SELECT role FROM chat_members WHERE chat_id = ? AND user_id = ?').get(chatId, userId);
  return row ? row.role : null;
}

function canManageChat(chat, user) {
  if (!user) return false;
  if (user.is_admin) return true;
  if (!chat) return false;
  if (chat.owner_id === user.id) return true;
  const role = chatRole(chat.id, user.id);
  return role === 'owner' || role === 'admin';
}

const CHAT_PERMISSIONS = {
  send_messages: 'all',
  add_members: 'admins',
  edit_info: 'admins'
};

function chatPermissions(chat) {
  let saved = {};
  try { saved = JSON.parse((chat && chat.permissions) || '{}') || {}; } catch (e) { saved = {}; }
  return { ...CHAT_PERMISSIONS, ...saved };
}

function canSendToChat(chat, user) {
  if (!chat || !user) return false;
  if (chat.type === 'channel') return canManageChat(chat, user);
  if (!isMember(chat.id, user.id)) return false;
  if (chatPermissions(chat).send_messages === 'admins') return canManageChat(chat, user);
  return true;
}

function canEditChatInfo(chat, user) {
  if (!chat || !user) return false;
  if (chatPermissions(chat).edit_info === 'all' && isMember(chat.id, user.id)) return true;
  return canManageChat(chat, user);
}

function canAddChatMembers(chat, user) {
  if (!chat || !user) return false;
  if (chatPermissions(chat).add_members === 'all' && isMember(chat.id, user.id)) return true;
  return canManageChat(chat, user);
}

function ensureInviteCode(chat) {
  if (!chat) return '';
  if (chat.invite_code) return chat.invite_code;
  const code = uuidv4().replace(/-/g, '').slice(0, 18);
  db.prepare('UPDATE chats SET invite_code = ? WHERE id = ?').run(code, chat.id);
  chat.invite_code = code;
  return code;
}

function chatMemberList(chatId) {
  return db.prepare(`
    SELECT cm.user_id, cm.role, cm.muted, cm.last_read_at,
      u.username, u.display_name, u.avatar, u.is_admin, u.is_premium, u.level, u.last_seen
    FROM chat_members cm JOIN users u ON u.id = cm.user_id
    WHERE cm.chat_id = ?
    ORDER BY CASE cm.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END,
      lower(coalesce(u.display_name, u.username)) ASC
  `).all(chatId).map(m => ({
    id: m.user_id, username: m.username, displayName: m.display_name || m.username,
    avatar: m.avatar || '', isAdmin: !!m.is_admin, isPremium: !!m.is_premium,
    level: m.level || 1, online: isOnline(m.user_id), lastSeen: m.last_seen || null,
    role: m.role || 'member', muted: !!m.muted, lastReadAt: m.last_read_at || null
  }));
}

function chatInfoPayload(chat, userId) {
  const members = chatMemberList(chat.id);
  const mine = members.find(m => m.id === userId) || null;
  const code = ensureInviteCode(chat);
  const publicUrl = process.env.PUBLIC_URL || 'https://runachat.duckdns.org';
  const dbUser = db.prepare('SELECT id, is_admin FROM users WHERE id = ?').get(userId);
  const actor = { id: userId, is_admin: !!(dbUser && dbUser.is_admin) };
  return {
    id: chat.id, type: chat.type, title: chat.title || '', about: chat.about || '',
    avatar: chat.avatar || '', username: chat.username || '', isPublic: !!chat.is_public,
    ownerId: chat.owner_id, pinned: !!chat.pinned, permissions: chatPermissions(chat),
    badgeType: chat.badge_type || '',
    inviteCode: code, inviteLink: `${publicUrl}/?join=${code}`,
    memberCount: members.length, members,
    canManage: canManageChat(chat, actor),
    canEditInfo: canEditChatInfo(chat, actor),
    canAddMembers: canAddChatMembers(chat, actor),
    canSend: canSendToChat(chat, actor),
    myRole: mine ? mine.role : null,
    muted: !!(mine && mine.muted)
  };
}

function lastMessageRow(chatId) {
  return db.prepare(`
    SELECT m.*, u.display_name, u.username, u.avatar
    FROM messages m JOIN users u ON u.id = m.sender_id
    WHERE m.chat_id = ? AND m.deleted = 0
    ORDER BY m.created_at DESC, m.rowid DESC LIMIT 1
  `).get(chatId) || null;
}

function listChats(userId) {
  const chats = db.prepare(`
    SELECT c.*, cm.role, cm.last_read_at, cm.muted,
      (SELECT text FROM messages WHERE chat_id = c.id AND deleted = 0 ORDER BY created_at DESC, rowid DESC LIMIT 1) AS last_message,
      (SELECT created_at FROM messages WHERE chat_id = c.id AND deleted = 0 ORDER BY created_at DESC, rowid DESC LIMIT 1) AS last_message_date,
      (SELECT file_type FROM messages WHERE chat_id = c.id AND deleted = 0 ORDER BY created_at DESC, rowid DESC LIMIT 1) AS last_message_file_type,
      (SELECT COUNT(*) FROM messages m WHERE m.chat_id = c.id AND m.deleted = 0 AND m.sender_id != ?
        AND (cm.last_read_at IS NULL OR m.created_at > cm.last_read_at)) AS unread,
      (SELECT COUNT(*) FROM chat_members cm2 WHERE cm2.chat_id = c.id) AS member_count
    FROM chats c JOIN chat_members cm ON c.id = cm.chat_id
    WHERE cm.user_id = ?
    ORDER BY c.pinned DESC, last_message_date DESC, c.created_at DESC
  `).all(userId, userId);

  const dmIds = chats.filter(c => c.type === 'dm').map(c => c.id);
  const otherUsers = new Map();
  if (dmIds.length) {
    const placeholders = dmIds.map(() => '?').join(',');
    const rows = db.prepare(`
      SELECT cm.chat_id, u.* FROM chat_members cm JOIN users u ON u.id = cm.user_id
      WHERE cm.chat_id IN (${placeholders}) AND cm.user_id != ?
    `).all(...dmIds, userId);
    rows.forEach(r => { if (!otherUsers.has(r.chat_id)) otherUsers.set(r.chat_id, publicUser(r)); });
  }

  return chats.map(c => {
    const otherUser = c.type === 'dm' ? (otherUsers.get(c.id) || null) : null;
    return {
      id: c.id, type: c.type, title: c.title, about: c.about || '',
      avatar: c.avatar || '', ownerId: c.owner_id, pinned: !!c.pinned,
      badgeType: c.badge_type || '', role: c.role, createdAt: c.created_at,
      username: c.username || '', isPublic: !!c.is_public,
      permissions: chatPermissions(c), muted: !!c.muted,
      lastMessage: c.last_message || '', lastMessageDate: c.last_message_date || null,
      lastMessageType: c.last_message_file_type || '',
      unread: c.unread || 0, memberCount: c.member_count || 0, otherUser
    };
  });
}

function emitChats(userId) {
  io.to(`user:${userId}`).emit('chats_list', listChats(userId));
}

function emitChatsForChat(chatId) {
  chatMembers(chatId).forEach(m => emitChats(m.user_id));
}

const MESSAGE_SELECT = `
  SELECT m.*, m.rowid AS seq, u.display_name, u.username, u.avatar, u.is_admin, u.is_premium,
    u.anon_number AS sender_anon,
    (SELECT GROUP_CONCAT(n.username, ',') FROM nft_usernames n WHERE n.user_id = u.id) AS sender_nfts,
    r.text AS reply_text, r.deleted AS reply_deleted, r.file_type AS reply_file_type,
    ru.display_name AS reply_author, ru.username AS reply_username
  FROM messages m
  JOIN users u ON u.id = m.sender_id
  LEFT JOIN messages r ON r.id = m.reply_to
  LEFT JOIN users ru ON ru.id = r.sender_id
`;

function reactionsForMessage(messageId, userId) {
  return db.prepare(`
    SELECT emoji, COUNT(*) AS count,
      MAX(CASE WHEN user_id = ? THEN 1 ELSE 0 END) AS me
    FROM message_reactions WHERE message_id = ?
    GROUP BY emoji ORDER BY MIN(created_at), emoji
  `).all(userId || '', messageId).map(r => ({ emoji: r.emoji, count: r.count, me: !!r.me }));
}

function attachReactions(rows, userId) {
  if (!rows || !rows.length) return rows || [];
  const ids = rows.map(r => r.id);
  const placeholders = ids.map(() => '?').join(',');
  const all = db.prepare(`
    SELECT message_id, emoji, COUNT(*) AS count,
      MAX(CASE WHEN user_id = ? THEN 1 ELSE 0 END) AS me
    FROM message_reactions WHERE message_id IN (${placeholders})
    GROUP BY message_id, emoji ORDER BY MIN(created_at), emoji
  `).all(userId || '', ...ids);
  const byMessage = new Map();
  all.forEach(r => {
    if (!byMessage.has(r.message_id)) byMessage.set(r.message_id, []);
    byMessage.get(r.message_id).push({ emoji: r.emoji, count: r.count, me: !!r.me });
  });
  return rows.map(m => ({ ...m, reactions: byMessage.get(m.id) || [] }));
}

function messageById(id, userId) {
  const msg = db.prepare(`${MESSAGE_SELECT} WHERE m.id = ?`).get(id) || null;
  if (!msg) return null;
  msg.reactions = reactionsForMessage(msg.id, userId);
  return msg;
}

function clearMessageReactions(messageId) {
  db.prepare('DELETE FROM message_reactions WHERE message_id = ?').run(messageId);
}

const nftPhrases = installNftPhrases({ app, db, io, requireAuth, emitUserUpdated, getProfileById });

/* ------------------------------------------------------------------ */
/*  СИДЫ                                                               */
/* ------------------------------------------------------------------ */
function initSystemDefaults() {
  let admin = db.prepare('SELECT * FROM users WHERE is_admin = 1 LIMIT 1').get();
  if (!admin) {
    const adminId = 'admin-id';
    db.prepare(`
      INSERT INTO users (id, username, password, display_name, bio, city, is_admin, phone_number, rubies, mops_balance, is_premium)
      VALUES (?, ?, ?, ?, ?, ?, 1, '+777 8888 9999', 2500, 150.0, 1)
    `).run(adminId, 'dfsadsa', hashPassword('admin123'), 'test', 'Разработчик экосистемы', 'Москва');
    db.prepare('INSERT INTO badges (id, user_id, icon, title, color) VALUES (?, ?, ?, ?, ?)').run(uuidv4(), adminId, '🛡️', 'Verified', '#0A84FF');
    db.prepare('INSERT INTO badges (id, user_id, icon, title, color) VALUES (?, ?, ?, ?, ?)').run(uuidv4(), adminId, '🔥', 'Halloween', '#FF9F0A');
    db.prepare('INSERT INTO badges (id, user_id, icon, title, color) VALUES (?, ?, ?, ?, ?)').run(uuidv4(), adminId, '⭐', 'Level 2', '#FFD60A');
    admin = db.prepare('SELECT * FROM users WHERE id = ?').get(adminId);
  }

  const seedChats = [
    { id: 'chat-runa-news', type: 'channel', title: 'Runa News', about: 'Официальный новостной ресурс', lastMsg: 'В ближайшее время выйдет гл...', pinned: 1 },
    { id: 'chat-general', type: 'group', title: 'чат общения', about: 'Главное сообщество участников', lastMsg: 'четко', pinned: 0 },
    { id: 'chat-runa-chats', type: 'channel', title: 'Runa Chats', about: 'Каталог открытых групп', lastMsg: '@runachat', pinned: 0 }
  ];
  seedChats.forEach(c => {
    if (!db.prepare('SELECT id FROM chats WHERE id = ?').get(c.id)) {
      db.prepare('INSERT INTO chats (id, type, title, about, owner_id, pinned) VALUES (?, ?, ?, ?, ?, ?)')
        .run(c.id, c.type, c.title, c.about, admin.id, c.pinned);
      db.prepare("INSERT OR IGNORE INTO chat_members (chat_id, user_id, role) VALUES (?, ?, 'owner')").run(c.id, admin.id);
      db.prepare('INSERT INTO messages (id, chat_id, sender_id, text) VALUES (?, ?, ?, ?)')
        .run(uuidv4(), c.id, admin.id, c.lastMsg);
    }
  });
}
initSystemDefaults();
db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(nowIso());

/* ------------------------------------------------------------------ */
/*  AUTH API                                                           */
/* ------------------------------------------------------------------ */
app.post('/api/auth/register', (req, res) => {
  const username = cleanUsername(req.body.username);
  const password = String(req.body.password || '');
  const displayName = String(req.body.display_name || req.body.displayName || username).trim().slice(0, 40);
  if (!validUsername(username)) return res.status(400).json({ error: 'Логин: 3–32 символа, латиница, цифры и _' });
  if (password.length < 4) return res.status(400).json({ error: 'Пароль должен быть не короче 4 символов' });
  if (usernameTaken(username)) return res.status(400).json({ error: 'Этот юзернейм уже занят' });
  try {
    const id = uuidv4();
    db.prepare('INSERT INTO users (id, username, password, display_name) VALUES (?, ?, ?, ?)')
      .run(id, username, hashPassword(password), displayName || username);
    const addMember = db.prepare("INSERT OR IGNORE INTO chat_members (chat_id, user_id, role) VALUES (?, ?, 'member')");
    db.prepare("SELECT id FROM chats WHERE type != 'dm'").all().forEach(c => addMember.run(c.id, id));
    const token = createSession(id);
    res.json({ token, user: getProfileById(id, true) });
  } catch (e) {
    res.status(400).json({ error: 'Имя пользователя уже занято' });
  }
});

app.post('/api/auth/login', (req, res) => {
  const username = cleanUsername(req.body.username);
  const password = String(req.body.password || '');
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || !checkPassword(password, user.password)) {
    return res.status(401).json({ error: 'Неверные данные учётной записи' });
  }
  if (user.banned) return res.status(403).json({ error: 'Аккаунт заблокирован' });
  if (!String(user.password).startsWith('$2')) {
    db.prepare('UPDATE users SET password = ? WHERE id = ?').run(hashPassword(password), user.id);
  }
  const token = createSession(user.id);
  res.json({ token, user: getProfileById(user.id, true) });
});

app.post('/api/auth/logout', (req, res) => {
  const token = tokenFromReq(req);
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  res.json({ ok: true });
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json(getProfileById(req.user.id, true));
});

/* ------------------------------------------------------------------ */
/*  USERS                                                              */
/* ------------------------------------------------------------------ */
app.post('/api/user/profile-track', requireAuth, (req, res) => {
  const url = String(req.body.url || '').trim();
  if (url && !/^\/uploads\/[a-zA-Z0-9._-]+$/.test(url)) {
    return res.status(400).json({ error: 'Некорректная ссылка' });
  }
  db.prepare('UPDATE users SET profile_track = ? WHERE id = ?').run(url, req.user.id);
  emitUserUpdated(req.user.id);
  res.json({ ok: true, profileTrack: url });
});
app.get('/api/username/check', requireAuth, (req, res) => {
  const username = cleanUsername(req.query.username);
  if (!validUsername(username)) {
    return res.json({ available: false, reason: '3–32 символа: латиница, цифры и _' });
  }
  if (username === req.user.username) {
    return res.json({ available: true, current: true, username });
  }
  if (usernameTaken(username, req.user.id)) {
    return res.json({ available: false, reason: 'Этот юзернейм уже занят' });
  }
  res.json({ available: true, username });
});

app.get('/api/users', requireAuth, (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  const like = `%${q}%`;
  const rows = q
    ? db.prepare(`SELECT * FROM users WHERE lower(username) LIKE ? OR lower(display_name) LIKE ?
        OR id IN (SELECT user_id FROM nft_usernames WHERE lower(username) LIKE ?)
        ORDER BY is_admin DESC, username ASC LIMIT 30`).all(like, like, like)
    : db.prepare('SELECT * FROM users ORDER BY is_admin DESC, username ASC LIMIT 30').all();
  res.json(rows.map(r => ({
    ...publicUser(r), online: isOnline(r.id), bio: r.bio || '', city: r.city || '',
    nftUsernames: nftFor(r.id).map(n => n.username)
  })));
});

app.get('/api/users/:identifier', requireAuth, (req, res) => {
  const identifier = req.params.identifier;
  const clean = cleanUsername(identifier);
  let row = db.prepare('SELECT * FROM users WHERE id = ? OR username = ?').get(identifier, clean);
  if (!row) {
    const nft = db.prepare('SELECT user_id FROM nft_usernames WHERE username = ?').get(clean);
    if (nft) row = db.prepare('SELECT * FROM users WHERE id = ?').get(nft.user_id);
  }
  if (!row) return res.status(404).json({ error: 'Пользователь не найден' });
  res.json(fullProfile(row, row.id === req.user.id));
});

const SELF_FIELDS = {
  display_name: 'display_name', bio: 'bio', city: 'city', profile_style: 'profile_style',
  banner: 'banner', avatar_frame: 'avatar_frame', profile_bg: 'profile_bg',
  username_color: 'username_color', accent_color: 'accent_color', theme: 'theme',
  language: 'language', font_size: 'font_size', ui_scale: 'ui_scale',
  card_style: 'card_style', font_family: 'font_family',
  chat_wallpaper: 'chat_wallpaper', cursor_style: 'cursor_style', chat_pattern: 'chat_pattern'
};
const SELF_BOOLS = {
  show_balance: 'show_balance_in_profile', notifications: 'notifications', sounds: 'sounds', mic: 'mic',
  bold_text: 'bold_text'
};

app.post('/api/user/update', requireAuth, (req, res) => {
  const sets = [];
  const vals = [];
  for (const [key, col] of Object.entries(SELF_FIELDS)) {
    if (req.body[key] !== undefined) { sets.push(`${col} = ?`); vals.push(req.body[key]); }
  }
  for (const [key, col] of Object.entries(SELF_BOOLS)) {
    if (req.body[key] !== undefined) { sets.push(`${col} = ?`); vals.push(req.body[key] ? 1 : 0); }
  }
  if (req.body.username !== undefined) {
    const username = cleanUsername(req.body.username);
    if (!validUsername(username)) return res.status(400).json({ error: 'Логин: 3–32 символа, латиница, цифры и _' });
    if (username !== req.user.username && usernameTaken(username, req.user.id)) {
      return res.status(400).json({ error: 'Этот юзернейм уже занят' });
    }
    sets.push('username = ?'); vals.push(username);
  }
  if (req.body.avatar !== undefined) { sets.push('avatar = ?'); vals.push(String(req.body.avatar)); }
  if (sets.length) {
    vals.push(req.user.id);
    db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }
  const profile = getProfileById(req.user.id, true);
  emitUserUpdated(req.user.id);
  res.json(profile);
});

app.post('/api/user/avatar', requireAuth, imageUpload.single('avatar'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Выберите изображение' });
  const url = `/uploads/${req.file.filename}`;
  db.prepare('UPDATE users SET avatar = ? WHERE id = ?').run(url, req.user.id);
  const profile = getProfileById(req.user.id, true);
  emitUserUpdated(req.user.id);
  res.json(profile);
});

app.post('/api/user/password', requireAuth, (req, res) => {
  const { current, next } = req.body;
  if (!checkPassword(String(current || ''), req.user.password)) {
    return res.status(400).json({ error: 'Текущий пароль неверный' });
  }
  if (String(next || '').length < 4) return res.status(400).json({ error: 'Новый пароль слишком короткий' });
  db.prepare('UPDATE users SET password = ? WHERE id = ?').run(hashPassword(next), req.user.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND token != ?').run(req.user.id, tokenFromReq(req));
  res.json({ ok: true });
});

app.delete('/api/user/me', requireAuth, (req, res) => {
  const id = req.user.id;
  if (req.user.is_admin && db.prepare('SELECT COUNT(*) c FROM users WHERE is_admin = 1').get().c <= 1) {
    return res.status(400).json({ error: 'Нельзя удалить последнего администратора' });
  }
  db.prepare('DELETE FROM messages WHERE sender_id = ?').run(id);
  db.prepare('DELETE FROM chat_members WHERE user_id = ?').run(id);
  db.prepare('DELETE FROM badges WHERE user_id = ?').run(id);
  db.prepare('DELETE FROM nft_usernames WHERE user_id = ?').run(id);
  db.prepare('DELETE FROM clan_members WHERE user_id = ?').run(id);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  nftPhrases.notifyUpdated([id]);
  res.json({ ok: true });
});

/* ------------------------------------------------------------------ */
/*  CHATS                                                              */
/* ------------------------------------------------------------------ */
app.get('/api/chats', requireAuth, (req, res) => {
  res.json(listChats(req.user.id));
});

app.post('/api/chats', requireAuth, (req, res) => {
  const type = ['group', 'channel', 'dm'].includes(req.body.type) ? req.body.type : 'group';
  if (type === 'dm') {
    const otherId = String(req.body.userId || '');
    const other = db.prepare('SELECT * FROM users WHERE id = ?').get(otherId);
    if (!other) return res.status(404).json({ error: 'Пользователь не найден' });
    if (other.id === req.user.id) return res.status(400).json({ error: 'Нельзя создать чат с самим собой' });
    const existing = db.prepare(`
      SELECT c.id FROM chats c
      JOIN chat_members a ON a.chat_id = c.id AND a.user_id = ?
      JOIN chat_members b ON b.chat_id = c.id AND b.user_id = ?
      WHERE c.type = 'dm' LIMIT 1
    `).get(req.user.id, other.id);
    if (existing) return res.json({ id: existing.id });
    const id = `dm-${uuidv4()}`;
    db.prepare("INSERT INTO chats (id, type, title, owner_id) VALUES (?, 'dm', ?, ?)")
      .run(id, other.display_name || other.username, req.user.id);
    db.prepare("INSERT INTO chat_members (chat_id, user_id, role) VALUES (?, ?, 'owner')").run(id, req.user.id);
    db.prepare("INSERT INTO chat_members (chat_id, user_id, role) VALUES (?, ?, 'member')").run(id, other.id);
    emitChats(req.user.id); emitChats(other.id);
    return res.json({ id });
  }

  const title = String(req.body.title || '').trim().slice(0, 80);
  if (!title) return res.status(400).json({ error: 'Введите название' });

  // Публичный @username чата — общий namespace с людьми и NFT-именами.
  let chatUsername = '';
  if (req.body.username !== undefined && String(req.body.username).trim()) {
    chatUsername = cleanUsername(req.body.username);
    if (!validUsername(chatUsername)) {
      return res.status(400).json({ error: 'Ссылка: 3–32 символа, латиница, цифры и _' });
    }
    if (usernameTaken(chatUsername)) {
      return res.status(400).json({ error: 'Эта ссылка уже занята' });
    }
  }

  const about = String(req.body.about || '').slice(0, 300);
  const avatar = String(req.body.avatar || '').slice(0, 500);
  const isPublic = chatUsername ? 1 : 0;
  const id = uuidv4();
  const inviteCode = uuidv4().replace(/-/g, '').slice(0, 18);
  db.prepare(`INSERT INTO chats (id, type, title, about, avatar, owner_id, invite_code, username, is_public)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, type, title, about, avatar, req.user.id, inviteCode, chatUsername, isPublic);
  db.prepare("INSERT INTO chat_members (chat_id, user_id, role) VALUES (?, ?, 'owner')").run(id, req.user.id);
  const memberIds = Array.isArray(req.body.memberIds) ? req.body.memberIds : [];
  const addMember = db.prepare("INSERT OR IGNORE INTO chat_members (chat_id, user_id, role) VALUES (?, ?, 'member')");
  memberIds.forEach(uid => { if (uid !== req.user.id && db.prepare('SELECT id FROM users WHERE id = ?').get(uid)) addMember.run(id, uid); });

  // Системное сообщение о создании — как в Telegram.
  const sysText = type === 'channel'
    ? `Канал «${title}» создан. Здесь можно публиковать посты для подписчиков.`
    : `Группа «${title}» создана. Пригласите участников по ссылке.`;
  db.prepare('INSERT INTO messages (id, chat_id, sender_id, text) VALUES (?, ?, ?, ?)')
    .run(uuidv4(), id, req.user.id, sysText);

  emitChatsForChat(id);
  res.json({ id, username: chatUsername, inviteCode, type, title });
});

/* Избранное: личный чат с самим собой, как Saved Messages в Telegram */
app.post('/api/chats/saved', requireAuth, (req, res) => {
  const existing = db.prepare(`
    SELECT c.id FROM chats c JOIN chat_members cm ON cm.chat_id = c.id
    WHERE c.type = 'saved' AND cm.user_id = ? LIMIT 1
  `).get(req.user.id);
  if (existing) return res.json({ id: existing.id, type: 'saved' });
  const id = `saved-${uuidv4()}`;
  db.prepare("INSERT INTO chats (id, type, title, owner_id) VALUES (?, 'saved', 'Избранное', ?)")
    .run(id, req.user.id);
  db.prepare("INSERT INTO chat_members (chat_id, user_id, role) VALUES (?, ?, 'owner')").run(id, req.user.id);
  emitChats(req.user.id);
  res.json({ id, type: 'saved' });
});

/* Проверка свободной ссылки чата */
app.get('/api/chats/username/check', requireAuth, (req, res) => {
  const username = cleanUsername(req.query.username);
  if (!validUsername(username)) {
    return res.json({ available: false, reason: '3–32 символа: латиница, цифры и _' });
  }
  if (usernameTaken(username)) {
    return res.json({ available: false, reason: 'Эта ссылка уже занята' });
  }
  res.json({ available: true, username });
});

/* Публичный чат по ссылке: предпросмотр перед входом */
app.get('/api/chats/public/:username', requireAuth, (req, res) => {
  const username = cleanUsername(req.params.username);
  const chat = db.prepare("SELECT * FROM chats WHERE is_public = 1 AND username = ? AND type != 'dm'").get(username);
  if (!chat) return res.status(404).json({ error: 'Чат не найден' });
  const members = db.prepare('SELECT COUNT(*) c FROM chat_members WHERE chat_id = ?').get(chat.id).c;
  res.json({
    id: chat.id, type: chat.type, title: chat.title, about: chat.about || '',
    avatar: chat.avatar || '', username: chat.username, memberCount: members,
    isMember: isMember(chat.id, req.user.id)
  });
});

app.patch('/api/chats/:id', requireAuth, (req, res) => {
  const chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(req.params.id);
  if (!chat) return res.status(404).json({ error: 'Чат не найден' });
  if (req.body.pinned !== undefined && !isMember(chat.id, req.user.id)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const wantsInfo = ['title', 'about', 'username', 'isPublic', 'permissions'].some(k => req.body[k] !== undefined);
  if (wantsInfo && !canEditChatInfo(chat, req.user)) return res.status(403).json({ error: 'Forbidden' });
  const sets = []; const vals = [];
  if (req.body.title !== undefined) {
    const title = String(req.body.title || '').trim().slice(0, 80);
    if (!title) return res.status(400).json({ error: 'Введите название' });
    sets.push('title = ?'); vals.push(title);
  }
  if (req.body.about !== undefined) { sets.push('about = ?'); vals.push(String(req.body.about || '').slice(0, 300)); }
  if (req.body.pinned !== undefined) { sets.push('pinned = ?'); vals.push(req.body.pinned ? 1 : 0); }
  if (req.body.username !== undefined) {
    const username = cleanUsername(req.body.username);
    if (username && !validUsername(username)) return res.status(400).json({ error: 'Ссылка: 3–32 символа, латиница, цифры и _' });
    if (username) {
      const taken = db.prepare('SELECT id FROM chats WHERE username = ? AND id != ?').get(username, chat.id);
      if (taken) return res.status(409).json({ error: 'Эта ссылка уже занята' });
      const userTaken = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
      if (userTaken) return res.status(409).json({ error: 'Эта ссылка уже занята пользователем' });
    }
    sets.push('username = ?'); vals.push(username);
  }
  if (req.body.isPublic !== undefined) { sets.push('is_public = ?'); vals.push(req.body.isPublic ? 1 : 0); }
  if (req.body.permissions !== undefined) {
    const allowed = { send_messages: ['all', 'admins'], add_members: ['all', 'admins'], edit_info: ['all', 'admins'] };
    const clean = {};
    for (const [key, values] of Object.entries(allowed)) {
      const value = req.body.permissions && req.body.permissions[key];
      clean[key] = values.includes(value) ? value : CHAT_PERMISSIONS[key];
    }
    sets.push('permissions = ?'); vals.push(JSON.stringify(clean));
  }
  if (sets.length) {
    vals.push(chat.id);
    db.prepare(`UPDATE chats SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }
  const updated = db.prepare('SELECT * FROM chats WHERE id = ?').get(chat.id);
  const basic = {
    id: updated.id, title: updated.title, about: updated.about || '', avatar: updated.avatar || '',
    username: updated.username || '', isPublic: !!updated.is_public, permissions: chatPermissions(updated)
  };
  io.to(chat.id).emit('chat_updated', basic);
  emitChatsForChat(chat.id);
  res.json({ ok: true, chat: basic });
});

app.get('/api/chats/:id/info', requireAuth, (req, res) => {
  const chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(req.params.id);
  if (!chat) return res.status(404).json({ error: 'Чат не найден' });
  if (!isMember(chat.id, req.user.id)) return res.status(403).json({ error: 'Forbidden' });
  res.json(chatInfoPayload(chat, req.user.id));
});

app.get('/api/chats/:id/members', requireAuth, (req, res) => {
  const chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(req.params.id);
  if (!chat) return res.status(404).json({ error: 'Чат не найден' });
  if (!isMember(chat.id, req.user.id)) return res.status(403).json({ error: 'Forbidden' });
  const q = String(req.query.q || '').trim().toLowerCase();
  let members = chatMemberList(chat.id);
  if (q) members = members.filter(m => String(m.displayName || '').toLowerCase().includes(q) || String(m.username || '').toLowerCase().includes(q));
  res.json({ members, total: chatMemberList(chat.id).length });
});

app.post('/api/chats/:id/mute', requireAuth, (req, res) => {
  if (!isMember(req.params.id, req.user.id)) return res.status(403).json({ error: 'Forbidden' });
  const muted = req.body.muted ? 1 : 0;
  db.prepare('UPDATE chat_members SET muted = ? WHERE chat_id = ? AND user_id = ?').run(muted, req.params.id, req.user.id);
  emitChats(req.user.id);
  res.json({ ok: true, muted: !!muted });
});

app.post('/api/chats/:id/invite/reset', requireAuth, (req, res) => {
  const chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(req.params.id);
  if (!chat) return res.status(404).json({ error: 'Чат не найден' });
  if (!canManageChat(chat, req.user)) return res.status(403).json({ error: 'Forbidden' });
  const code = uuidv4().replace(/-/g, '').slice(0, 18);
  db.prepare('UPDATE chats SET invite_code = ? WHERE id = ?').run(code, chat.id);
  res.json({ ok: true, inviteCode: code, inviteLink: `${process.env.PUBLIC_URL || 'https://runachat.duckdns.org'}/?join=${code}` });
});

app.post('/api/chats/join', requireAuth, (req, res) => {
  const value = String(req.body.code || req.body.username || '').trim().replace(/^@/, '');
  if (!value) return res.status(400).json({ error: 'Ссылка недействительна' });
  const chat = db.prepare('SELECT * FROM chats WHERE invite_code = ? OR (is_public = 1 AND username = ?)').get(value, value.toLowerCase());
  if (!chat || chat.type === 'dm') return res.status(404).json({ error: 'Чат не найден или ссылка устарела' });
  db.prepare("INSERT OR IGNORE INTO chat_members (chat_id, user_id, role) VALUES (?, ?, 'member')").run(chat.id, req.user.id);
  emitChats(req.user.id);
  emitChatsForChat(chat.id);
  res.json({ ok: true, id: chat.id });
});

app.post('/api/chats/:id/avatar', requireAuth, imageUpload.single('avatar'), (req, res) => {
  const chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(req.params.id);
  if (!chat) return res.status(404).json({ error: 'Чат не найден' });
  if (!canManageChat(chat, req.user)) return res.status(403).json({ error: 'Forbidden' });
  if (!req.file) return res.status(400).json({ error: 'Выберите изображение' });
  db.prepare('UPDATE chats SET avatar = ? WHERE id = ?').run(`/uploads/${req.file.filename}`, chat.id);
  emitChatsForChat(chat.id);
  res.json({ ok: true, avatar: `/uploads/${req.file.filename}` });
});

app.delete('/api/chats/:id', requireAuth, (req, res) => {
  const chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(req.params.id);
  if (!chat) return res.status(404).json({ error: 'Чат не найден' });
  if (!canManageChat(chat, req.user)) return res.status(403).json({ error: 'Forbidden' });
  const members = chatMembers(chat.id).map(m => m.user_id);
  db.prepare('DELETE FROM message_reactions WHERE message_id IN (SELECT id FROM messages WHERE chat_id = ?)').run(chat.id);
  db.prepare('DELETE FROM messages WHERE chat_id = ?').run(chat.id);
  db.prepare('DELETE FROM chat_members WHERE chat_id = ?').run(chat.id);
  db.prepare('DELETE FROM chats WHERE id = ?').run(chat.id);
  members.forEach(emitChats);
  res.json({ ok: true });
});

app.post('/api/chats/:id/members', requireAuth, (req, res) => {
  const chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(req.params.id);
  if (!chat) return res.status(404).json({ error: 'Чат не найден' });
  if (chat.type === 'dm') return res.status(400).json({ error: 'Нельзя добавить участника в личный чат' });
  if (!canAddChatMembers(chat, req.user)) return res.status(403).json({ error: 'Недостаточно прав' });
  let user = null;
  if (req.body.userId) user = db.prepare('SELECT * FROM users WHERE id = ?').get(String(req.body.userId));
  if (!user && req.body.username) {
    const uname = cleanUsername(req.body.username);
    user = db.prepare('SELECT * FROM users WHERE username = ?').get(uname);
    if (!user) {
      const nft = db.prepare('SELECT user_id FROM nft_usernames WHERE username = ?').get(uname);
      if (nft) user = db.prepare('SELECT * FROM users WHERE id = ?').get(nft.user_id);
    }
  }
  if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
  db.prepare("INSERT OR IGNORE INTO chat_members (chat_id, user_id, role) VALUES (?, ?, 'member')").run(chat.id, user.id);
  emitChats(user.id); emitChatsForChat(chat.id);
  io.to(chat.id).emit('chat_members_updated', { chatId: chat.id });
  res.json({ ok: true, member: publicUser(user) });
});

app.patch('/api/chats/:id/members/:userId', requireAuth, (req, res) => {
  const chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(req.params.id);
  if (!chat) return res.status(404).json({ error: 'Чат не найден' });
  if (!canManageChat(chat, req.user)) return res.status(403).json({ error: 'Недостаточно прав' });
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.userId);
  if (!target || !isMember(chat.id, target.id)) return res.status(404).json({ error: 'Участник не найден' });
  if (target.id === chat.owner_id) return res.status(400).json({ error: 'Нельзя изменить владельца чата' });
  if (target.id === req.user.id) return res.status(400).json({ error: 'Нельзя изменить свою роль' });
  const role = req.body.role === 'admin' ? 'admin' : 'member';
  db.prepare('UPDATE chat_members SET role = ? WHERE chat_id = ? AND user_id = ?').run(role, chat.id, target.id);
  emitChats(target.id); emitChatsForChat(chat.id);
  io.to(chat.id).emit('chat_members_updated', { chatId: chat.id });
  res.json({ ok: true, role });
});

app.delete('/api/chats/:id/members/:userId', requireAuth, (req, res) => {
  const chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(req.params.id);
  if (!chat) return res.status(404).json({ error: 'Чат не найден' });
  const targetId = req.params.userId;
  const selfLeave = targetId === req.user.id;
  if (!canManageChat(chat, req.user) && !selfLeave) return res.status(403).json({ error: 'Недостаточно прав' });
  if (!isMember(chat.id, targetId)) return res.status(404).json({ error: 'Участник не найден' });

  if (chat.type === 'dm') {
    db.prepare('DELETE FROM chat_members WHERE chat_id = ? AND user_id = ?').run(chat.id, targetId);
    emitChats(targetId); emitChatsForChat(chat.id);
    return res.json({ ok: true });
  }

  if (targetId === chat.owner_id) {
    if (!selfLeave) return res.status(400).json({ error: 'Сначала передайте владение чатом' });
    const next = db.prepare(`
      SELECT user_id FROM chat_members WHERE chat_id = ? AND user_id != ?
      ORDER BY CASE role WHEN 'admin' THEN 0 ELSE 1 END, last_read_at DESC LIMIT 1
    `).get(chat.id, targetId);
    if (!next) {
      const members = chatMembers(chat.id).map(m => m.user_id);
      db.prepare('DELETE FROM message_reactions WHERE message_id IN (SELECT id FROM messages WHERE chat_id = ?)').run(chat.id);
      db.prepare('DELETE FROM messages WHERE chat_id = ?').run(chat.id);
      db.prepare('DELETE FROM chat_members WHERE chat_id = ?').run(chat.id);
      db.prepare('DELETE FROM chats WHERE id = ?').run(chat.id);
      members.forEach(emitChats);
      return res.json({ ok: true, deleted: true });
    }
    db.prepare('UPDATE chats SET owner_id = ? WHERE id = ?').run(next.user_id, chat.id);
    db.prepare("UPDATE chat_members SET role = 'owner' WHERE chat_id = ? AND user_id = ?").run(chat.id, next.user_id);
  }

  db.prepare('DELETE FROM chat_members WHERE chat_id = ? AND user_id = ?').run(chat.id, targetId);
  emitChats(targetId); emitChatsForChat(chat.id);
  io.to(chat.id).emit('chat_members_updated', { chatId: chat.id });
  res.json({ ok: true });
});

app.get('/api/chats/:id/messages', requireAuth, (req, res) => {
  if (!isMember(req.params.id, req.user.id)) return res.status(403).json({ error: 'Forbidden' });
  const limit = Math.min(Number(req.query.limit) || 100, 200);
  const before = String(req.query.before || '');
  const beforeId = String(req.query.beforeId || '');
  const beforeSeq = Number(req.query.beforeSeq) || 0;
  let rows;
  if (before && beforeSeq) {
    rows = db.prepare(`
      ${MESSAGE_SELECT}
      WHERE m.chat_id = ? AND m.deleted = 0
        AND (m.created_at < ? OR (m.created_at = ? AND m.rowid < ?))
      ORDER BY m.created_at DESC, m.rowid DESC LIMIT ?
    `).all(req.params.id, before, before, beforeSeq, limit).reverse();
  } else if (before) {
    rows = db.prepare(`
      ${MESSAGE_SELECT}
      WHERE m.chat_id = ? AND m.deleted = 0
        AND (m.created_at < ? OR (m.created_at = ? AND m.id < ?))
      ORDER BY m.created_at DESC, m.id DESC LIMIT ?
    `).all(req.params.id, before, before, beforeId || '', limit).reverse();
  } else {
    rows = db.prepare(`
      ${MESSAGE_SELECT}
      WHERE m.chat_id = ? AND m.deleted = 0
      ORDER BY m.created_at DESC, m.rowid DESC LIMIT ?
    `).all(req.params.id, limit).reverse();
  }
  res.json(attachReactions(rows, req.user.id));
});

app.post('/api/chats/:id/read', requireAuth, (req, res) => {
  db.prepare('UPDATE chat_members SET last_read_at = ? WHERE chat_id = ? AND user_id = ?')
    .run(nowIso(), req.params.id, req.user.id);
  emitChats(req.user.id);
  res.json({ ok: true });
});

/* ------------------------------------------------------------------ */
/*  UPLOAD                                                             */
/* ------------------------------------------------------------------ */
app.post('/api/upload', requireAuth, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Файл не загружен' });
  const m = req.file.mimetype || '';
  const type = m.startsWith('image/') ? 'image'
             : m.startsWith('audio/') ? 'audio'
             : m.startsWith('video/') ? 'video'
             : 'file';
  res.json({
    url: `/uploads/${req.file.filename}`,
    name: req.file.originalname,
    type
  });
});

/* ------------------------------------------------------------------ */
/*  CLANS / WALLET / SEARCH                                            */
/* ------------------------------------------------------------------ */
/* ------------------------------------------------------------------ */
/*  АНОНИМНЫЙ НОМЕР                                                    */
/* ------------------------------------------------------------------ */
app.post('/api/user/anonymous-number', requireAuth, (req, res) => {
  const me = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (me.anon_number) return res.status(400).json({ error: 'У вас уже есть анонимный номер' });
  const gen = () => {
    let digits = '';
    for (let i = 0; i < 7; i++) digits += Math.floor(Math.random() * 10);
    return `+888 ${digits.slice(0, 3)} ${digits.slice(3)}`;
  };
  let number = gen();
  for (let i = 0; i < 12 && db.prepare('SELECT id FROM users WHERE anon_number = ?').get(number); i++) number = gen();
  db.prepare('UPDATE users SET anon_number = ? WHERE id = ?').run(number, req.user.id);
  emitUserUpdated(req.user.id);
  res.json({ ok: true, anonymousNumber: number, user: getProfileById(req.user.id, true) });
});

app.delete('/api/user/anonymous-number', requireAuth, (req, res) => {
  db.prepare("UPDATE users SET anon_number = '' WHERE id = ?").run(req.user.id);
  emitUserUpdated(req.user.id);
  res.json({ ok: true, user: getProfileById(req.user.id, true) });
});

/* ------------------------------------------------------------------ */
/*  ИСТОРИИ                                                            */
/* ------------------------------------------------------------------ */
const STORY_TTL_MS = 24 * 60 * 60 * 1000;

function storyPayload(row, viewerId) {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(row.user_id) || {};
  return {
    id: row.id,
    userId: row.user_id,
    mediaUrl: row.media_url,
    mediaType: row.media_type || 'image',
    caption: row.caption || '',
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    views: row.views || 0,
    own: row.user_id === viewerId,
    viewed: row.user_id === viewerId ? true : !!db.prepare('SELECT 1 FROM story_views WHERE story_id = ? AND user_id = ?').get(row.id, viewerId),
    user: {
      id: u.id, username: u.username, displayName: u.display_name || u.username,
      avatar: u.avatar || '', isPremium: !!u.is_premium, isAdmin: !!u.is_admin
    }
  };
}

function activeStories(viewerId, userId = null) {
  const now = nowIso();
  const rows = userId
    ? db.prepare('SELECT * FROM stories WHERE user_id = ? AND deleted = 0 AND expires_at > ? ORDER BY created_at ASC').all(userId, now)
    : db.prepare('SELECT * FROM stories WHERE deleted = 0 AND expires_at > ? ORDER BY created_at ASC').all(now);
  return rows.map(r => storyPayload(r, viewerId));
}

function storyGroups(viewerId) {
  const map = new Map();
  activeStories(viewerId).forEach(story => {
    if (!map.has(story.userId)) map.set(story.userId, { user: story.user, stories: [], latest: story.createdAt });
    const group = map.get(story.userId);
    group.stories.push(story);
    group.latest = story.createdAt;
  });
  return [...map.values()].sort((a, b) => {
    if (a.user.id === viewerId) return -1;
    if (b.user.id === viewerId) return 1;
    return String(b.latest).localeCompare(String(a.latest));
  });
}

/* ------------------------------------------------------------------ */
/*  РОЗЫГРЫШИ                                                          */
/* ------------------------------------------------------------------ */
function giveawayPrizeLabel(g) {
  if (g.prize_type === 'gift') {
    const gift = db.prepare('SELECT title FROM gifts WHERE id = ?').get(g.prize_value);
    return gift ? `Подарок «${gift.title}»` : 'Подарок';
  }
  if (g.prize_type === 'rubies') return `${Number(g.prize_value || 0).toLocaleString('ru-RU')} 💎`;
  return String(g.prize_value || 'Приз');
}

function giveawayPayload(g, viewerId) {
  const chat = db.prepare('SELECT id, title, type, owner_id FROM chats WHERE id = ?').get(g.chat_id) || {};
  const creator = db.prepare('SELECT id, username, display_name, avatar FROM users WHERE id = ?').get(g.creator_id) || {};
  const dbUser = db.prepare('SELECT id, is_admin FROM users WHERE id = ?').get(viewerId);
  const participants = db.prepare('SELECT COUNT(*) c FROM giveaway_participants WHERE giveaway_id = ?').get(g.id).c || 0;
  const joined = !!db.prepare('SELECT 1 FROM giveaway_participants WHERE giveaway_id = ? AND user_id = ?').get(g.id, viewerId);
  const winners = db.prepare(`
    SELECT gp.user_id, u.username, u.display_name, u.avatar
    FROM giveaway_participants gp JOIN users u ON u.id = gp.user_id
    WHERE gp.giveaway_id = ? AND gp.winner = 1
  `).all(g.id).map(w => ({
    id: w.user_id, username: w.username, displayName: w.display_name || w.username, avatar: w.avatar || ''
  }));
  return {
    id: g.id, chatId: g.chat_id, chatTitle: chat.title || '', creatorId: g.creator_id,
    creator: { id: creator.id, username: creator.username, displayName: creator.display_name || creator.username, avatar: creator.avatar || '' },
    title: g.title || 'Розыгрыш', prizeType: g.prize_type, prizeValue: g.prize_value,
    prizeLabel: giveawayPrizeLabel(g), winnersCount: g.winners_count || 1,
    participantsCount: participants, joined, winners,
    endsAt: g.ends_at, createdAt: g.created_at, finishedAt: g.finished_at || null,
    status: g.status || 'active',
    canManage: canManageChat(chat, dbUser),
    ended: g.status !== 'active' || String(g.ends_at) <= nowIso()
  };
}

function createChatMessage(chatId, senderId, text) {
  const id = uuidv4();
  db.prepare(`
    INSERT INTO messages (id, chat_id, sender_id, text, file_url, file_name, file_type, reply_to)
    VALUES (?, ?, ?, ?, NULL, NULL, NULL, NULL)
  `).run(id, chatId, senderId, String(text).slice(0, 4000));
  const msg = messageById(id, senderId);
  if (!msg) return null;
  msg.reactions = [];
  chatMembers(chatId).forEach(m => {
    io.to(`user:${m.user_id}`).emit('new_message', msg);
    if (m.user_id !== senderId) io.to(`user:${m.user_id}`).emit('notify_message', { chatId, message: msg });
  });
  emitChatsForChat(chatId);
  return msg;
}

function finishGiveaway(giveaway, actorId = null) {
  const g = db.prepare('SELECT * FROM giveaways WHERE id = ?').get(giveaway.id);
  if (!g || g.status !== 'active') return null;
  const participants = db.prepare('SELECT user_id FROM giveaway_participants WHERE giveaway_id = ?').all(g.id);
  const shuffled = participants.slice();
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const winners = shuffled.slice(0, Math.min(Math.max(1, g.winners_count || 1), shuffled.length));
  const winnerNames = [];
  const actor = actorId || g.creator_id;
  const prizeLabel = giveawayPrizeLabel(g);
  const gift = g.prize_type === 'gift' ? db.prepare('SELECT * FROM gifts WHERE id = ?').get(g.prize_value) : null;
  winners.forEach(w => {
    db.prepare('UPDATE giveaway_participants SET winner = 1 WHERE giveaway_id = ? AND user_id = ?').run(g.id, w.user_id);
    const target = db.prepare('SELECT * FROM users WHERE id = ?').get(w.user_id);
    if (!target) return;
    winnerNames.push(`@${target.username}`);
    if (g.prize_type === 'rubies') {
      const amount = Math.max(0, Math.floor(Number(g.prize_value) || 0));
      if (amount > 0) {
        db.prepare('UPDATE users SET rubies = rubies + ? WHERE id = ?').run(amount, target.id);
        db.prepare('INSERT INTO wallet_transactions (id, user_id, kind, amount, currency, note) VALUES (?, ?, ?, ?, ?, ?)')
          .run(uuidv4(), target.id, 'in', amount, 'rubies', `Победа в розыгрыше «${g.title}»`);
      }
    } else if (g.prize_type === 'gift' && gift) {
      db.prepare('INSERT INTO user_gifts (id, gift_id, from_user_id, to_user_id, message, anonymous) VALUES (?, ?, ?, ?, ?, 0)')
        .run(uuidv4(), gift.id, actor, target.id, `Розыгрыш «${g.title}»`);
    }
    emitUserUpdated(target.id);
  });
  db.prepare("UPDATE giveaways SET status = 'finished', finished_at = ?, participants_count = ? WHERE id = ?")
    .run(nowIso(), participants.length, g.id);
  const text = winnerNames.length
    ? `🎉 Розыгрыш «${g.title}» завершён! Приз: ${prizeLabel}. Победители: ${winnerNames.join(', ')}.`
    : `🎉 Розыгрыш «${g.title}» завершён без участников.`;
  createChatMessage(g.chat_id, actor, text);
  const fresh = db.prepare('SELECT * FROM giveaways WHERE id = ?').get(g.id);
  io.to(g.chat_id).emit('giveaway_updated', { chatId: g.chat_id, giveawayId: g.id });
  emitChatsForChat(g.chat_id);
  return giveawayPayload(fresh, actor);
}

function processExpiredGiveaways() {
  const rows = db.prepare("SELECT * FROM giveaways WHERE status = 'active' AND ends_at <= ?").all(nowIso());
  rows.forEach(g => {
    try { finishGiveaway(g, g.creator_id); }
    catch (e) { console.error('giveaway finish:', e.message); }
  });
}
setInterval(processExpiredGiveaways, 30000).unref();

/* ------------------------------------------------------------------ */
/*  ПОДАРКИ (каталог пуст — наполним позже)                            */
/* ------------------------------------------------------------------ */
app.get('/api/gifts', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM gifts WHERE active = 1 ORDER BY price ASC, created_at ASC').all();
  res.json(rows.map(g => ({ id: g.id, slug: g.slug, title: g.title, emoji: g.emoji, price: g.price || 0, rarity: g.rarity, description: g.description || '', fileUrl: g.file_url || '', fileType: g.file_type || '' })));
});

app.get('/api/gifts/received', requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT g.*, ug.id AS received_id, ug.message, ug.anonymous, ug.created_at AS received_at,
           u.username AS from_username, u.display_name AS from_name, u.avatar AS from_avatar
    FROM user_gifts ug JOIN gifts g ON g.id = ug.gift_id
    LEFT JOIN users u ON u.id = ug.from_user_id
    WHERE ug.to_user_id = ? ORDER BY ug.created_at DESC LIMIT 200
  `).all(req.user.id);
  res.json(rows.map(r => ({
    id: r.received_id, giftId: r.id, slug: r.slug, title: r.title, emoji: r.emoji,
    price: r.price || 0, rarity: r.rarity, message: r.message || '',
    fileUrl: r.file_url || '', fileType: r.file_type || '', description: r.description || '',
    anonymous: !!r.anonymous, receivedAt: r.received_at,
    from: r.anonymous ? null : { username: r.from_username, name: r.from_name, avatar: r.from_avatar }
  })));
});

app.get('/api/gifts/sent', requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT g.*, ug.id AS sent_id, ug.message, ug.anonymous, ug.created_at AS sent_at,
           u.username AS to_username, u.display_name AS to_name, u.avatar AS to_avatar
    FROM user_gifts ug JOIN gifts g ON g.id = ug.gift_id
    LEFT JOIN users u ON u.id = ug.to_user_id
    WHERE ug.from_user_id = ? ORDER BY ug.created_at DESC LIMIT 200
  `).all(req.user.id);
  res.json(rows.map(r => ({
    id: r.sent_id, giftId: r.id, slug: r.slug, title: r.title, emoji: r.emoji,
    price: r.price || 0, rarity: r.rarity, message: r.message || '',
    fileUrl: r.file_url || '', fileType: r.file_type || '', description: r.description || '',
    anonymous: !!r.anonymous, sentAt: r.sent_at,
    to: { username: r.to_username, name: r.to_name, avatar: r.to_avatar }
  })));
});

app.post('/api/gifts/send', requireAuth, (req, res) => {
  const gift = db.prepare('SELECT * FROM gifts WHERE id = ? AND active = 1').get(String(req.body.giftId || ''));
  if (!gift) return res.status(404).json({ error: 'Подарок не найден' });
  const target = findUserByUsername(cleanUsername(req.body.username));
  if (!target) return res.status(404).json({ error: 'Получатель не найден' });
  const isSelf = target.id === req.user.id;
  const price = gift.price || 0;
  const me = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if ((me.rubies || 0) < price) return res.status(400).json({ error: 'Недостаточно рубинов' });
  db.transaction(() => {
    db.prepare('UPDATE users SET rubies = rubies - ? WHERE id = ?').run(price, req.user.id);
    db.prepare('INSERT INTO user_gifts (id, gift_id, from_user_id, to_user_id, message, anonymous) VALUES (?, ?, ?, ?, ?, ?)')
      .run(uuidv4(), gift.id, req.user.id, target.id, String(req.body.message || '').slice(0, 200), req.body.anonymous ? 1 : 0);
    db.prepare('INSERT INTO wallet_transactions (id, user_id, kind, amount, currency, note) VALUES (?, ?, ?, ?, ?, ?)')
      .run(uuidv4(), req.user.id, 'out', -price, 'rubies', isSelf ? `Подарок «${gift.title}» себе` : `Подарок «${gift.title}» для @${target.username}`);
  })();
  emitUserUpdated(target.id);
  res.json({ ok: true, self: isSelf });
});

app.get('/api/users/:id/gifts', requireAuth, (req, res) => {
  const user = db.prepare('SELECT id FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
  const rows = db.prepare(`
    SELECT g.*, ug.id AS received_id, ug.message, ug.anonymous, ug.created_at AS received_at,
           u.username AS from_username, u.display_name AS from_name, u.avatar AS from_avatar
    FROM user_gifts ug JOIN gifts g ON g.id = ug.gift_id
    LEFT JOIN users u ON u.id = ug.from_user_id
    WHERE ug.to_user_id = ? ORDER BY ug.created_at DESC LIMIT 100
  `).all(user.id);
  res.json(rows.map(r => ({
    id: r.received_id, giftId: r.id, slug: r.slug, title: r.title, emoji: r.emoji,
    price: r.price || 0, rarity: r.rarity, message: r.message || '',
    fileUrl: r.file_url || '', fileType: r.file_type || '', description: r.description || '',
    anonymous: !!r.anonymous, receivedAt: r.received_at,
    from: r.anonymous ? null : { username: r.from_username, name: r.from_name, avatar: r.from_avatar }
  })));
});

/* ------------------------------------------------------------------ */
/*  ИСТОРИИ — API                                                      */
/* ------------------------------------------------------------------ */
app.get('/api/stories', requireAuth, (req, res) => {
  res.json(storyGroups(req.user.id));
});

app.get('/api/stories/user/:id', requireAuth, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
  res.json({
    user: { id: user.id, username: user.username, displayName: user.display_name || user.username, avatar: user.avatar || '' },
    stories: activeStories(req.user.id, user.id)
  });
});

app.post('/api/stories', requireAuth, (req, res) => {
  const mediaUrl = String(req.body.mediaUrl || '');
  if (!/^\/uploads\/[a-zA-Z0-9._-]+$/.test(mediaUrl)) {
    return res.status(400).json({ error: 'Загрузите фото или видео для истории' });
  }
  const mediaType = req.body.mediaType === 'video' ? 'video' : 'image';
  const caption = String(req.body.caption || '').trim().slice(0, 300);
  const active = db.prepare('SELECT COUNT(*) c FROM stories WHERE user_id = ? AND deleted = 0 AND expires_at > ?').get(req.user.id, nowIso()).c;
  if (active >= 20) return res.status(400).json({ error: 'Слишком много активных историй' });
  const id = uuidv4();
  const expires = new Date(Date.now() + STORY_TTL_MS).toISOString();
  db.prepare('INSERT INTO stories (id, user_id, media_url, media_type, caption, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, req.user.id, mediaUrl, mediaType, caption, expires);
  io.emit('stories_updated', { userId: req.user.id });
  res.json({ ok: true, story: storyPayload(db.prepare('SELECT * FROM stories WHERE id = ?').get(id), req.user.id) });
});

app.delete('/api/stories/:id', requireAuth, (req, res) => {
  const story = db.prepare('SELECT * FROM stories WHERE id = ? AND deleted = 0').get(req.params.id);
  if (!story) return res.status(404).json({ error: 'История не найдена' });
  if (story.user_id !== req.user.id && !req.user.is_admin) return res.status(403).json({ error: 'Нет доступа' });
  db.prepare('UPDATE stories SET deleted = 1 WHERE id = ?').run(story.id);
  db.prepare('DELETE FROM story_views WHERE story_id = ?').run(story.id);
  io.emit('stories_updated', { userId: story.user_id });
  res.json({ ok: true });
});

app.post('/api/stories/:id/view', requireAuth, (req, res) => {
  const story = db.prepare('SELECT * FROM stories WHERE id = ? AND deleted = 0').get(req.params.id);
  if (!story) return res.status(404).json({ error: 'История не найдена' });
  if (story.user_id !== req.user.id) {
    const inserted = db.prepare('INSERT OR IGNORE INTO story_views (story_id, user_id) VALUES (?, ?)').run(story.id, req.user.id);
    if (inserted.changes) {
      db.prepare('UPDATE stories SET views = views + 1 WHERE id = ?').run(story.id);
      const views = db.prepare('SELECT views FROM stories WHERE id = ?').get(story.id).views;
      io.to(`user:${story.user_id}`).emit('story_views', { storyId: story.id, views });
    }
  }
  res.json({ ok: true });
});

/* ------------------------------------------------------------------ */
/*  РОЗЫГРЫШИ — API                                                    */
/* ------------------------------------------------------------------ */
app.get('/api/chats/:id/giveaways', requireAuth, (req, res) => {
  if (!isMember(req.params.id, req.user.id)) return res.status(403).json({ error: 'Нет доступа' });
  const rows = db.prepare(`
    SELECT * FROM giveaways WHERE chat_id = ?
    ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, created_at DESC LIMIT 50
  `).all(req.params.id);
  res.json(rows.map(g => giveawayPayload(g, req.user.id)));
});

app.post('/api/chats/:id/giveaways', requireAuth, (req, res) => {
  const chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(req.params.id);
  if (!chat) return res.status(404).json({ error: 'Чат не найден' });
  if (chat.type !== 'channel') return res.status(400).json({ error: 'Розыгрыши доступны только в каналах' });
  if (!canManageChat(chat, req.user)) return res.status(403).json({ error: 'Недостаточно прав' });
  const title = String(req.body.title || '').trim().slice(0, 80) || 'Розыгрыш';
  const prizeType = ['rubies', 'gift', 'custom'].includes(req.body.prizeType) ? req.body.prizeType : 'rubies';
  let prizeValue = String(req.body.prizeValue || '').trim().slice(0, 120);
  if (prizeType === 'rubies') {
    const amount = Math.max(1, Math.floor(Number(prizeValue) || 0));
    if (!amount) return res.status(400).json({ error: 'Укажите сумму приза' });
    prizeValue = String(amount);
  } else if (prizeType === 'gift') {
    const gift = db.prepare('SELECT id FROM gifts WHERE id = ? AND active = 1').get(prizeValue);
    if (!gift) return res.status(400).json({ error: 'Выберите подарок из маркета' });
  } else if (!prizeValue) {
    return res.status(400).json({ error: 'Опишите приз' });
  }
  const winnersCount = Math.max(1, Math.min(100, Math.floor(Number(req.body.winnersCount) || 1)));
  const duration = Math.max(1, Math.min(10080, Math.floor(Number(req.body.durationMinutes) || 60)));
  const endsAt = new Date(Date.now() + duration * 60 * 1000).toISOString();
  const id = uuidv4();
  db.prepare('INSERT INTO giveaways (id, chat_id, creator_id, title, prize_type, prize_value, winners_count, ends_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, chat.id, req.user.id, title, prizeType, prizeValue, winnersCount, endsAt);
  const g = db.prepare('SELECT * FROM giveaways WHERE id = ?').get(id);
  io.to(chat.id).emit('giveaway_updated', { chatId: chat.id, giveawayId: id });
  emitChatsForChat(chat.id);
  res.json({ ok: true, giveaway: giveawayPayload(g, req.user.id) });
});

app.post('/api/giveaways/:id/join', requireAuth, (req, res) => {
  const g = db.prepare('SELECT * FROM giveaways WHERE id = ?').get(req.params.id);
  if (!g) return res.status(404).json({ error: 'Розыгрыш не найден' });
  if (!isMember(g.chat_id, req.user.id)) return res.status(403).json({ error: 'Сначала подпишитесь на канал' });
  if (g.status !== 'active' || String(g.ends_at) <= nowIso()) return res.status(400).json({ error: 'Розыгрыш уже завершён' });
  const inserted = db.prepare('INSERT OR IGNORE INTO giveaway_participants (giveaway_id, user_id) VALUES (?, ?)').run(g.id, req.user.id);
  if (inserted.changes) {
    db.prepare('UPDATE giveaways SET participants_count = (SELECT COUNT(*) FROM giveaway_participants WHERE giveaway_id = ?) WHERE id = ?').run(g.id, g.id);
  }
  io.to(g.chat_id).emit('giveaway_updated', { chatId: g.chat_id, giveawayId: g.id });
  const fresh = db.prepare('SELECT * FROM giveaways WHERE id = ?').get(g.id);
  res.json({ ok: true, giveaway: giveawayPayload(fresh, req.user.id) });
});

app.post('/api/giveaways/:id/draw', requireAuth, (req, res) => {
  const g = db.prepare('SELECT * FROM giveaways WHERE id = ?').get(req.params.id);
  if (!g) return res.status(404).json({ error: 'Розыгрыш не найден' });
  const chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(g.chat_id);
  if (!canManageChat(chat, req.user)) return res.status(403).json({ error: 'Недостаточно прав' });
  if (g.status !== 'active') return res.status(400).json({ error: 'Розыгрыш уже завершён' });
  const result = finishGiveaway(g, req.user.id);
  res.json({ ok: true, giveaway: result });
});

app.post('/api/giveaways/:id/cancel', requireAuth, (req, res) => {
  const g = db.prepare('SELECT * FROM giveaways WHERE id = ?').get(req.params.id);
  if (!g) return res.status(404).json({ error: 'Розыгрыш не найден' });
  const chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(g.chat_id);
  if (!canManageChat(chat, req.user)) return res.status(403).json({ error: 'Недостаточно прав' });
  if (g.status !== 'active') return res.status(400).json({ error: 'Розыгрыш уже завершён' });
  db.prepare("UPDATE giveaways SET status = 'canceled', finished_at = ? WHERE id = ?").run(nowIso(), g.id);
  createChatMessage(g.chat_id, req.user.id, `Розыгрыш «${g.title}» отменён.`);
  io.to(g.chat_id).emit('giveaway_updated', { chatId: g.chat_id, giveawayId: g.id });
  res.json({ ok: true });
});

app.get('/api/clans', requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT c.*, u.display_name AS leader_name, u.username AS leader_username,
      (SELECT COUNT(*) FROM clan_members m WHERE m.clan_id = c.id) AS real_members
    FROM clans c LEFT JOIN users u ON u.id = c.leader_id
    ORDER BY real_members DESC, c.created_at ASC
  `).all();
  res.json(rows.map(r => ({
    id: r.id, name: r.name, tag: r.tag, leaderId: r.leader_id,
    leaderName: r.leader_name, membersCount: Math.max(r.real_members || 0, r.members_count || 1),
    createdAt: r.created_at, joined: !!db.prepare('SELECT 1 FROM clan_members WHERE clan_id = ? AND user_id = ?').get(r.id, req.user.id)
  })));
});

app.post('/api/clans/create', requireAuth, (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 32);
  const tag = String(req.body.tag || '').trim().replace(/[^a-zA-Zа-яА-Я0-9]/g, '').slice(0, 4).toUpperCase();
  if (name.length < 2 || !tag) return res.status(400).json({ error: 'Укажите название и тег (2–4 символа)' });
  if (clanFor(req.user.id)) return res.status(400).json({ error: 'Вы уже состоите в клане' });
  if ((req.user.rubies || 0) < 2000) return res.status(400).json({ error: 'Недостаточно рубинов (нужно 2 000 💎)' });
  try {
    const clanId = uuidv4();
    db.prepare('UPDATE users SET rubies = rubies - 2000 WHERE id = ?').run(req.user.id);
    db.prepare('INSERT INTO clans (id, name, tag, leader_id) VALUES (?, ?, ?, ?)').run(clanId, name, tag, req.user.id);
    db.prepare("INSERT INTO clan_members (clan_id, user_id, role) VALUES (?, ?, 'leader')").run(clanId, req.user.id);
    db.prepare('INSERT INTO wallet_transactions (id, user_id, kind, amount, currency, note) VALUES (?, ?, ?, ?, ?, ?)')
      .run(uuidv4(), req.user.id, 'out', -2000, 'rubies', `Создание клана [${tag}]`);
    res.json({ success: true, clanId });
  } catch (e) {
    res.status(400).json({ error: 'Клан с таким именем уже существует' });
  }
});

app.post('/api/clans/:id/join', requireAuth, (req, res) => {
  const clan = db.prepare('SELECT * FROM clans WHERE id = ?').get(req.params.id);
  if (!clan) return res.status(404).json({ error: 'Клан не найден' });
  if (clanFor(req.user.id)) return res.status(400).json({ error: 'Вы уже состоите в клане' });
  db.prepare("INSERT OR IGNORE INTO clan_members (clan_id, user_id, role) VALUES (?, ?, 'member')").run(clan.id, req.user.id);
  db.prepare('UPDATE clans SET members_count = (SELECT COUNT(*) FROM clan_members WHERE clan_id = ?) WHERE id = ?').run(clan.id, clan.id);
  res.json({ ok: true });
});

app.get('/api/wallet/transactions', requireAuth, (req, res) => {
  res.json(db.prepare('SELECT * FROM wallet_transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT 50').all(req.user.id));
});

app.post('/api/wallet/exchange', requireAuth, (req, res) => {
  const rubies = Math.floor(Number(req.body.rubies) || 0);
  if (rubies < 10) return res.status(400).json({ error: 'Минимум 10 рубинов' });
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if ((user.rubies || 0) < rubies) return res.status(400).json({ error: 'Недостаточно рубинов' });
  const mops = +(rubies / 10).toFixed(2);
  db.prepare('UPDATE users SET rubies = rubies - ?, mops_balance = mops_balance + ? WHERE id = ?').run(rubies, mops, user.id);
  db.prepare('INSERT INTO wallet_transactions (id, user_id, kind, amount, currency, note) VALUES (?, ?, ?, ?, ?, ?)')
    .run(uuidv4(), user.id, 'exchange', mops, 'mops', `Обмен ${rubies} 💎 → ${mops} MOPS`);
  res.json({ ok: true, mops, user: getProfileById(user.id, true) });
});

app.post('/api/wallet/daily', requireAuth, (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (user.last_daily === today) return res.status(400).json({ error: 'Бонус уже получен сегодня' });
  db.prepare('UPDATE users SET rubies = rubies + 100, last_daily = ? WHERE id = ?').run(today, user.id);
  db.prepare('INSERT INTO wallet_transactions (id, user_id, kind, amount, currency, note) VALUES (?, ?, ?, ?, ?, ?)')
    .run(uuidv4(), user.id, 'in', 100, 'rubies', 'Ежедневный бонус');
  res.json({ ok: true, user: getProfileById(user.id, true) });
});

app.get('/api/search', requireAuth, (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json({ users: [], chats: [], messages: [] });
  const like = `%${q}%`;
  const users = db.prepare(`SELECT * FROM users WHERE username LIKE ? OR display_name LIKE ?
    OR id IN (SELECT user_id FROM nft_usernames WHERE username LIKE ?)
    LIMIT 10`).all(like, like, like)
    .map(u => ({ ...publicUser(u), nftUsernames: nftFor(u.id).map(n => n.username) }));
  const chats = db.prepare(`
    SELECT c.* FROM chats c JOIN chat_members cm ON cm.chat_id = c.id
    WHERE cm.user_id = ? AND c.title LIKE ? LIMIT 10
  `).all(req.user.id, like).map(c => ({ id: c.id, title: c.title, type: c.type, avatar: c.avatar }));
  const messages = db.prepare(`
    SELECT m.id, m.chat_id, m.text, m.created_at, u.display_name FROM messages m
    JOIN users u ON u.id = m.sender_id
    JOIN chat_members cm ON cm.chat_id = m.chat_id AND cm.user_id = ?
    WHERE m.deleted = 0 AND m.text LIKE ? ORDER BY m.created_at DESC LIMIT 15
  `).all(req.user.id, like);
  res.json({ users, chats, messages });
});

app.post('/api/wallet/send', requireAuth, (req, res) => {
  const amount = Math.floor(Number(req.body.amount) || 0);
  const username = cleanUsername(req.body.username);
  if (amount <= 0) return res.status(400).json({ error: 'Сумма должна быть больше нуля' });
  const target = findUserByUsername(username);
  if (!target) return res.status(404).json({ error: 'Получатель не найден' });
  if (target.id === req.user.id) return res.status(400).json({ error: 'Нельзя отправить самому себе' });
  if ((req.user.rubies || 0) < amount) return res.status(400).json({ error: 'Недостаточно рубинов' });
  db.prepare('UPDATE users SET rubies = rubies - ? WHERE id = ?').run(amount, req.user.id);
  db.prepare('UPDATE users SET rubies = rubies + ? WHERE id = ?').run(amount, target.id);
  const tx = db.prepare('INSERT INTO wallet_transactions (id, user_id, kind, amount, currency, note) VALUES (?, ?, ?, ?, ?, ?)');
  tx.run(uuidv4(), req.user.id, 'out', -amount, 'rubies', `Перевод @${target.username}`);
  tx.run(uuidv4(), target.id, 'in', amount, 'rubies', `Перевод от @${req.user.username}`);
  res.json({ ok: true, user: getProfileById(req.user.id, true) });
});

app.post('/api/store/badge', requireAuth, (req, res) => {
  const price = 300;
  if ((req.user.rubies || 0) < price) return res.status(400).json({ error: `Нужно ${price} 💎` });
  const icon = String(req.body.icon || '⭐').slice(0, 8);
  const title = String(req.body.title || 'Значок').slice(0, 30);
  db.prepare('UPDATE users SET rubies = rubies - ? WHERE id = ?').run(price, req.user.id);
  db.prepare('INSERT INTO badges (id, user_id, icon, title, color) VALUES (?, ?, ?, ?, ?)')
    .run(uuidv4(), req.user.id, icon, title, '#BF5AF2');
  db.prepare('INSERT INTO wallet_transactions (id, user_id, kind, amount, currency, note) VALUES (?, ?, ?, ?, ?, ?)')
    .run(uuidv4(), req.user.id, 'out', -price, 'rubies', `Покупка значка «${title}»`);
  res.json({ ok: true, user: getProfileById(req.user.id, true) });
});

app.post('/api/store/color', requireAuth, (req, res) => {
  const price = 200;
  if ((req.user.rubies || 0) < price) return res.status(400).json({ error: `Нужно ${price} 💎` });
  const color = String(req.body.color || '');
  if (!/^#[0-9a-fA-F]{6}$/.test(color)) return res.status(400).json({ error: 'Некорректный цвет' });
  db.prepare('UPDATE users SET rubies = rubies - ?, username_color = ? WHERE id = ?').run(price, color, req.user.id);
  res.json({ ok: true, user: getProfileById(req.user.id, true) });
});

app.post('/api/premium/buy', requireAuth, (req, res) => {
  const price = 1000;
  if (req.user.is_premium) return res.status(400).json({ error: 'Premium уже активен' });
  if ((req.user.rubies || 0) < price) return res.status(400).json({ error: `Нужно ${price} 💎` });
  db.prepare('UPDATE users SET rubies = rubies - ?, is_premium = 1 WHERE id = ?').run(price, req.user.id);
  res.json({ ok: true, user: getProfileById(req.user.id, true) });
});

function nftById(id) {
  return db.prepare('SELECT * FROM nft_usernames WHERE id = ?').get(String(id || ''));
}

function nftMarketItem(r) {
  return {
    id: r.id, username: r.username, ownerId: r.user_id,
    ownerUsername: r.owner_username, ownerName: r.owner_name, ownerAvatar: r.owner_avatar || '',
    forSale: !!r.for_sale, price: r.price || 0, listedAt: r.listed_at || null,
    mine: r.user_id === r.viewer_id
  };
}

app.get('/api/nft-market', requireAuth, (req, res) => {
  const all = req.query.all === '1';
  const rows = db.prepare(`
    SELECT n.*, u.username AS owner_username, u.display_name AS owner_name, u.avatar AS owner_avatar
    FROM nft_usernames n JOIN users u ON u.id = n.user_id
    ${all ? '' : 'WHERE n.for_sale = 1'}
    ORDER BY n.for_sale DESC, n.listed_at DESC, n.created_at DESC LIMIT 300
  `).all();
  res.json(rows.map(r => nftMarketItem({ ...r, viewer_id: req.user.id })));
});

app.post('/api/nft/:id/sell', requireAuth, (req, res) => {
  const nft = nftById(req.params.id);
  if (!nft) return res.status(404).json({ error: 'Юзернейм не найден' });
  if (nft.user_id !== req.user.id) return res.status(403).json({ error: 'Это не ваш юзернейм' });
  if (nft.username === req.user.username) {
    return res.status(400).json({ error: 'Сначала смените обычный юзернейм — он совпадает с этим NFT' });
  }
  const price = Math.floor(Number(req.body.price));
  if (!Number.isFinite(price) || price < 1 || price > 10000000) {
    return res.status(400).json({ error: 'Цена должна быть от 1 до 10 000 000 рубинов' });
  }
  db.prepare('UPDATE nft_usernames SET for_sale = 1, price = ?, listed_at = CURRENT_TIMESTAMP WHERE id = ?')
    .run(price, nft.id);
  io.emit('nft_market_updated');
  const fresh = db.prepare(`SELECT n.*, u.username AS owner_username, u.display_name AS owner_name, u.avatar AS owner_avatar
    FROM nft_usernames n JOIN users u ON u.id = n.user_id WHERE n.id = ?`).get(nft.id);
  res.json({ ok: true, nft: nftMarketItem({ ...fresh, viewer_id: req.user.id }), user: getProfileById(req.user.id, true) });
});

app.post('/api/nft/:id/unlist', requireAuth, (req, res) => {
  const nft = nftById(req.params.id);
  if (!nft) return res.status(404).json({ error: 'Юзернейм не найден' });
  if (nft.user_id !== req.user.id) return res.status(403).json({ error: 'Это не ваш юзернейм' });
  db.prepare('UPDATE nft_usernames SET for_sale = 0, price = 0, listed_at = NULL WHERE id = ?').run(nft.id);
  io.emit('nft_market_updated');
  res.json({ ok: true, user: getProfileById(req.user.id, true) });
});

app.post('/api/nft/:id/buy', requireAuth, (req, res) => {
  const nft = nftById(req.params.id);
  if (!nft) return res.status(404).json({ error: 'Юзернейм не найден' });
  if (!nft.for_sale) return res.status(400).json({ error: 'Юзернейм не выставлен на продажу' });
  if (nft.user_id === req.user.id) return res.status(400).json({ error: 'Это уже ваш юзернейм' });
  const price = Math.floor(Number(nft.price) || 0);
  if (price <= 0) return res.status(400).json({ error: 'Некорректная цена лота' });
  const buyer = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  const seller = db.prepare('SELECT * FROM users WHERE id = ?').get(nft.user_id);
  if (!seller) return res.status(400).json({ error: 'Владелец лота не найден' });
  if ((buyer.rubies || 0) < price) return res.status(400).json({ error: 'Недостаточно рубинов' });

  const tx = db.prepare('INSERT INTO wallet_transactions (id, user_id, kind, amount, currency, note) VALUES (?, ?, ?, ?, ?, ?)');
  db.transaction(() => {
    db.prepare('UPDATE users SET rubies = rubies - ? WHERE id = ?').run(price, buyer.id);
    db.prepare('UPDATE users SET rubies = rubies + ? WHERE id = ?').run(price, seller.id);
    db.prepare('UPDATE nft_usernames SET user_id = ?, for_sale = 0, price = 0, listed_at = NULL WHERE id = ?')
      .run(buyer.id, nft.id);
    tx.run(uuidv4(), buyer.id, 'out', -price, 'rubies', `Покупка юзернейма @${nft.username}`);
    tx.run(uuidv4(), seller.id, 'in', price, 'rubies', `Продажа юзернейма @${nft.username}`);
  })();

  const buyerProfile = getProfileById(buyer.id, true);
  emitUserUpdated(buyer.id);
  emitUserUpdated(seller.id);
  io.emit('nft_market_updated');
  res.json({ ok: true, user: buyerProfile, nft: { id: nft.id, username: nft.username } });
});

/* ------------------------------------------------------------------ */
/*  ADMIN API                                                          */
/* ------------------------------------------------------------------ */
function adminUser(u) {
  return {
    id: u.id, username: u.username, displayName: u.display_name || u.username,
    avatar: u.avatar || '', bio: u.bio || '', city: u.city || '',
    phoneNumber: u.phone_number || '', rubies: u.rubies || 0, mopsBalance: u.mops_balance || 0,
    isAdmin: !!u.is_admin, isPremium: !!u.is_premium, level: u.level || 1,
    banned: !!u.banned, online: isOnline(u.id), createdAt: u.created_at,
    lastSeen: u.last_seen || null, badges: badgesFor(u.id), nftUsernames: nftFor(u.id)
  };
}

app.get('/api/admin/stats', requireAdmin, (req, res) => {
  res.json({
    users: db.prepare('SELECT COUNT(*) c FROM users').get().c,
    rooms: db.prepare('SELECT COUNT(*) c FROM chats').get().c,
    messages: db.prepare('SELECT COUNT(*) c FROM messages WHERE deleted = 0').get().c,
    online: onlineSockets.size,
    banned: db.prepare('SELECT COUNT(*) c FROM users WHERE banned = 1').get().c,
    premium: db.prepare('SELECT COUNT(*) c FROM users WHERE is_premium = 1').get().c,
    today: db.prepare("SELECT COUNT(*) c FROM users WHERE date(created_at) = date('now')").get().c,
    gifts: db.prepare('SELECT COUNT(*) c FROM gifts').get().c,
    giftsActive: db.prepare('SELECT COUNT(*) c FROM gifts WHERE active = 1').get().c,
    giveawaysActive: db.prepare("SELECT COUNT(*) c FROM giveaways WHERE status = 'active'").get().c,
    storiesActive: db.prepare('SELECT COUNT(*) c FROM stories WHERE deleted = 0 AND expires_at > ?').get(nowIso()).c,
    verifiedChats: db.prepare("SELECT COUNT(*) c FROM chats WHERE badge_type != ''").get().c
  });
});

app.get('/api/admin/users', requireAdmin, (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  const rows = q
    ? db.prepare('SELECT * FROM users WHERE lower(username) LIKE ? OR lower(display_name) LIKE ? ORDER BY created_at DESC').all(`%${q}%`, `%${q}%`)
    : db.prepare('SELECT * FROM users ORDER BY created_at DESC').all();
  res.json(rows.map(adminUser));
});

app.patch('/api/admin/users/:id', requireAdmin, (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!target) return res.status(404).json({ error: 'Пользователь не найден' });
  const sets = []; const vals = [];
  const map = {
    display_name: 'display_name', bio: 'bio', city: 'city', phone_number: 'phone_number',
    level: 'level', profile_style: 'profile_style'
  };
  for (const [k, col] of Object.entries(map)) {
    if (req.body[k] !== undefined) { sets.push(`${col} = ?`); vals.push(req.body[k]); }
  }
  if (req.body.rubies !== undefined) { sets.push('rubies = ?'); vals.push(Number(req.body.rubies) || 0); }
  if (req.body.mops_balance !== undefined) { sets.push('mops_balance = ?'); vals.push(Number(req.body.mops_balance) || 0); }
  if (req.body.is_admin !== undefined) {
    if (!req.body.is_admin && target.is_admin && db.prepare('SELECT COUNT(*) c FROM users WHERE is_admin = 1').get().c <= 1) {
      return res.status(400).json({ error: 'Нельзя снять последнего администратора' });
    }
    sets.push('is_admin = ?'); vals.push(req.body.is_admin ? 1 : 0);
  }
  if (req.body.is_premium !== undefined) { sets.push('is_premium = ?'); vals.push(req.body.is_premium ? 1 : 0); }
  if (req.body.banned !== undefined) { sets.push('banned = ?'); vals.push(req.body.banned ? 1 : 0); }
  if (req.body.username !== undefined) {
    const username = cleanUsername(req.body.username);
    if (!validUsername(username)) return res.status(400).json({ error: 'Некорректный логин' });
    if (db.prepare('SELECT id FROM users WHERE username = ? AND id != ?').get(username, target.id)) {
      return res.status(400).json({ error: 'Логин занят' });
    }
    sets.push('username = ?'); vals.push(username);
  }
  if (req.body.avatar !== undefined) { sets.push('avatar = ?'); vals.push(String(req.body.avatar || '')); }
  if (req.body.banner !== undefined) { sets.push('banner = ?'); vals.push(String(req.body.banner || '')); }
  if (req.body.avatar_frame !== undefined) { sets.push('avatar_frame = ?'); vals.push(String(req.body.avatar_frame || '')); }
  if (req.body.username_color !== undefined) { sets.push('username_color = ?'); vals.push(String(req.body.username_color || '')); }
  if (req.body.password) {
    if (String(req.body.password).length < 4) return res.status(400).json({ error: 'Пароль слишком короткий' });
    sets.push('password = ?'); vals.push(hashPassword(req.body.password));
  }
  if (sets.length) { vals.push(target.id); db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...vals); }
  res.json(adminUser(db.prepare('SELECT * FROM users WHERE id = ?').get(target.id)));
});

app.post('/api/admin/users/:id/ban', requireAdmin, (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!target) return res.status(404).json({ error: 'Пользователь не найден' });
  if (target.is_admin) return res.status(400).json({ error: 'Нельзя забанить администратора' });
  db.prepare('UPDATE users SET banned = 1 WHERE id = ?').run(target.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(target.id);
  io.to(`user:${target.id}`).emit('force_logout', { reason: 'Аккаунт заблокирован' });
  res.json({ ok: true });
});

app.post('/api/admin/users/:id/unban', requireAdmin, (req, res) => {
  db.prepare('UPDATE users SET banned = 0 WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.delete('/api/admin/users/:id', requireAdmin, (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!target) return res.status(404).json({ error: 'Пользователь не найден' });
  if (target.id === req.user.id) return res.status(400).json({ error: 'Нельзя удалить самого себя' });
  if (target.is_admin && db.prepare('SELECT COUNT(*) c FROM users WHERE is_admin = 1').get().c <= 1) {
    return res.status(400).json({ error: 'Нельзя удалить последнего администратора' });
  }
  db.prepare('DELETE FROM message_reactions WHERE user_id = ? OR message_id IN (SELECT id FROM messages WHERE sender_id = ?)').run(target.id, target.id);
  db.prepare('DELETE FROM messages WHERE sender_id = ?').run(target.id);
  db.prepare('DELETE FROM chat_members WHERE user_id = ?').run(target.id);
  db.prepare('DELETE FROM badges WHERE user_id = ?').run(target.id);
  db.prepare('DELETE FROM nft_usernames WHERE user_id = ?').run(target.id);
  db.prepare('DELETE FROM clan_members WHERE user_id = ?').run(target.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(target.id);
  db.prepare('DELETE FROM users WHERE id = ?').run(target.id);
  nftPhrases.notifyUpdated([target.id]);
  io.to(`user:${target.id}`).emit('force_logout', { reason: 'Аккаунт удалён' });
  res.json({ ok: true });
});

app.post('/api/admin/give-currency', requireAdmin, (req, res) => {
  const { userId, rubies = 0, mops = 0 } = req.body;
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!target) return res.status(404).json({ error: 'Пользователь не найден' });
  db.prepare('UPDATE users SET rubies = rubies + ?, mops_balance = mops_balance + ? WHERE id = ?')
    .run(Number(rubies) || 0, Number(mops) || 0, userId);
  if (rubies) db.prepare('INSERT INTO wallet_transactions (id, user_id, kind, amount, currency, note) VALUES (?, ?, ?, ?, ?, ?)')
    .run(uuidv4(), userId, 'in', Number(rubies), 'rubies', 'Начисление администратором');
  if (mops) db.prepare('INSERT INTO wallet_transactions (id, user_id, kind, amount, currency, note) VALUES (?, ?, ?, ?, ?, ?)')
    .run(uuidv4(), userId, 'in', Number(mops), 'mops', 'Начисление администратором');
  res.json({ ok: true, user: adminUser(db.prepare('SELECT * FROM users WHERE id = ?').get(userId)) });
});

app.post('/api/admin/assign-phone', requireAdmin, (req, res) => {
  db.prepare('UPDATE users SET phone_number = ? WHERE id = ?').run(String(req.body.phone || ''), req.body.userId);
  res.json({ ok: true });
});

app.post('/api/admin/assign-nft', requireAdmin, (req, res) => {
  const clean = cleanUsername(req.body.nftUsername);
  if (!validUsername(clean)) return res.status(400).json({ error: 'Некорректный юзернейм' });
  if (usernameTaken(clean, req.body.userId)) return res.status(400).json({ error: 'Этот юзернейм уже занят' });
  const owner = db.prepare('SELECT username FROM users WHERE id = ?').get(req.body.userId);
  if (owner && owner.username === clean) return res.status(400).json({ error: 'Юзернейм совпадает с обычным именем пользователя' });
  try {
    db.prepare('INSERT INTO nft_usernames (id, user_id, username) VALUES (?, ?, ?)').run(uuidv4(), req.body.userId, clean);
    emitUserUpdated(req.body.userId);
    io.emit('nft_market_updated');
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: 'NFT юзернейм уже существует' }); }
});

app.delete('/api/admin/nft/:id', requireAdmin, (req, res) => {
  const nft = db.prepare('SELECT * FROM nft_usernames WHERE id = ?').get(req.params.id);
  db.prepare('DELETE FROM nft_usernames WHERE id = ?').run(req.params.id);
  if (nft && nft.user_id) emitUserUpdated(nft.user_id);
  io.emit('nft_market_updated');
  res.json({ ok: true });
});

app.post('/api/admin/users/:id/badges', requireAdmin, (req, res) => {
  const icon = String(req.body.icon || '').trim().slice(0, 32) || '⭐';
  const title = String(req.body.title || '').trim().slice(0, 40) || 'Значок';
  const color = String(req.body.color || '').trim().slice(0, 20);
  const id = uuidv4();
  db.prepare('INSERT INTO badges (id, user_id, icon, title, color) VALUES (?, ?, ?, ?, ?)')
    .run(id, req.params.id, icon, title, color);
  res.json({ ok: true, badge: { id, icon, title, color } });
});

app.delete('/api/admin/badges/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM badges WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.get('/api/admin/chats', requireAdmin, (req, res) => {
  const rows = db.prepare(`
    SELECT c.*, u.display_name AS owner_name,
      (SELECT COUNT(*) FROM chat_members m WHERE m.chat_id = c.id) AS members,
      (SELECT COUNT(*) FROM messages msg WHERE msg.chat_id = c.id AND msg.deleted = 0) AS messages
    FROM chats c LEFT JOIN users u ON u.id = c.owner_id
    ORDER BY c.created_at DESC
  `).all();
  res.json(rows.map(r => ({
    id: r.id, type: r.type, title: r.title, about: r.about || '', avatar: r.avatar || '',
    ownerId: r.owner_id, ownerName: r.owner_name, pinned: !!r.pinned,
    badgeType: r.badge_type || '', badge_type: r.badge_type || '',
    members: r.members || 0, messages: r.messages || 0, createdAt: r.created_at
  })));
});

app.post('/api/admin/chats', requireAdmin, (req, res) => {
  const title = String(req.body.title || '').trim().slice(0, 80);
  const type = ['group', 'channel'].includes(req.body.type) ? req.body.type : 'channel';
  if (!title) return res.status(400).json({ error: 'Введите название' });
  const id = uuidv4();
  const inviteCode = uuidv4().replace(/-/g, '').slice(0, 18);
  db.prepare('INSERT INTO chats (id, type, title, about, owner_id, invite_code) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, type, title, String(req.body.about || '').slice(0, 300), req.user.id, inviteCode);
  db.prepare("INSERT INTO chat_members (chat_id, user_id, role) VALUES (?, ?, 'owner')").run(id, req.user.id);
  res.json({ ok: true, id });
});

app.patch('/api/admin/chats/:id', requireAdmin, (req, res) => {
  const chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(req.params.id);
  if (!chat) return res.status(404).json({ error: 'Чат не найден' });
  const sets = []; const vals = [];
  if (req.body.title !== undefined) { sets.push('title = ?'); vals.push(String(req.body.title).slice(0, 80)); }
  if (req.body.about !== undefined) { sets.push('about = ?'); vals.push(String(req.body.about).slice(0, 300)); }
  if (req.body.type !== undefined && ['group', 'channel'].includes(req.body.type)) { sets.push('type = ?'); vals.push(req.body.type); }
  if (req.body.pinned !== undefined) { sets.push('pinned = ?'); vals.push(req.body.pinned ? 1 : 0); }
  if (req.body.avatar !== undefined) { sets.push('avatar = ?'); vals.push(String(req.body.avatar || '')); }
  if (req.body.badge_type !== undefined) {
    const badge = ['', 'verified', 'premium', 'crown'].includes(req.body.badge_type) ? req.body.badge_type : '';
    sets.push('badge_type = ?'); vals.push(badge);
  }
  if (sets.length) { vals.push(chat.id); db.prepare(`UPDATE chats SET ${sets.join(', ')} WHERE id = ?`).run(...vals); }
  emitChatsForChat(chat.id);
  res.json({ ok: true });
});

app.delete('/api/admin/chats/:id', requireAdmin, (req, res) => {
  const chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(req.params.id);
  if (!chat) return res.status(404).json({ error: 'Чат не найден' });
  const members = chatMembers(chat.id).map(m => m.user_id);
  db.prepare('DELETE FROM message_reactions WHERE message_id IN (SELECT id FROM messages WHERE chat_id = ?)').run(chat.id);
  db.prepare('DELETE FROM messages WHERE chat_id = ?').run(chat.id);
  db.prepare('DELETE FROM chat_members WHERE chat_id = ?').run(chat.id);
  db.prepare('DELETE FROM chats WHERE id = ?').run(chat.id);
  members.forEach(emitChats);
  res.json({ ok: true });
});

app.get('/api/admin/messages', requireAdmin, (req, res) => {
  const chatId = String(req.query.chatId || '');
  const q = String(req.query.q || '').trim();
  let rows;
  if (chatId) {
    rows = db.prepare(`
      SELECT m.*, u.display_name, u.username, c.title AS chat_title
      FROM messages m JOIN users u ON u.id = m.sender_id JOIN chats c ON c.id = m.chat_id
      WHERE m.chat_id = ? AND m.deleted = 0 ORDER BY m.created_at DESC LIMIT 200
    `).all(chatId);
  } else if (q) {
    rows = db.prepare(`
      SELECT m.*, u.display_name, u.username, c.title AS chat_title
      FROM messages m JOIN users u ON u.id = m.sender_id JOIN chats c ON c.id = m.chat_id
      WHERE m.deleted = 0 AND m.text LIKE ? ORDER BY m.created_at DESC LIMIT 200
    `).all(`%${q}%`);
  } else {
    rows = db.prepare(`
      SELECT m.*, u.display_name, u.username, c.title AS chat_title
      FROM messages m JOIN users u ON u.id = m.sender_id JOIN chats c ON c.id = m.chat_id
      WHERE m.deleted = 0 ORDER BY m.created_at DESC LIMIT 100
    `).all();
  }
  res.json(rows);
});

app.delete('/api/admin/messages/:id', requireAdmin, (req, res) => {
  const msg = db.prepare('SELECT * FROM messages WHERE id = ?').get(req.params.id);
  if (!msg) return res.status(404).json({ error: 'Сообщение не найдено' });
  db.prepare("UPDATE messages SET deleted = 1, text = '', file_url = NULL, file_name = NULL WHERE id = ?").run(msg.id);
  clearMessageReactions(msg.id);
  io.to(msg.chat_id).emit('message_deleted', { messageId: msg.id, chatId: msg.chat_id });
  emitChatsForChat(msg.chat_id);
  res.json({ ok: true });
});

/* ------------------------------------------------------------------ */
/*  ПОДАРКИ: АДМИН-ПАНЕЛЬ                                             */
/* ------------------------------------------------------------------ */
function giftPayload(row) {
  return {
    id: row.id, slug: row.slug, title: row.title, emoji: row.emoji || '🎁',
    price: row.price || 0, rarity: row.rarity || 'common',
    description: row.description || '', fileUrl: row.file_url || '',
    fileType: row.file_type || '', active: !!row.active,
    createdAt: row.created_at, receivedCount: row.received_count || 0
  };
}

app.get('/api/admin/gifts', requireAdmin, (req, res) => {
  const rows = db.prepare(`
    SELECT g.*, (SELECT COUNT(*) FROM user_gifts ug WHERE ug.gift_id = g.id) AS received_count
    FROM gifts g ORDER BY g.created_at DESC
  `).all();
  res.json(rows.map(giftPayload));
});

app.post('/api/admin/gifts', requireAdmin, (req, res) => {
  const title = String(req.body.title || '').trim().slice(0, 80);
  if (!title) return res.status(400).json({ error: 'Введите название подарка' });
  const id = uuidv4();
  const slugBase = String(req.body.slug || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 40);
  const slug = slugBase || `gift-${id.slice(0, 8)}`;
  const price = Math.max(0, Math.floor(Number(req.body.price) || 0));
  const rarity = ['common', 'rare', 'epic', 'legendary'].includes(req.body.rarity) ? req.body.rarity : 'common';
  db.prepare(`INSERT INTO gifts (id, slug, title, emoji, price, rarity, active, description, file_url, file_type)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    id, slug, title, String(req.body.emoji || '🎁').slice(0, 8), price, rarity,
    req.body.active ? 1 : 0, String(req.body.description || '').slice(0, 300),
    String(req.body.fileUrl || req.body.file_url || '').slice(0, 500),
    String(req.body.fileType || req.body.file_type || '').slice(0, 30)
  );
  const row = db.prepare('SELECT * FROM gifts WHERE id = ?').get(id);
  res.json(giftPayload(row));
});

app.patch('/api/admin/gifts/:id', requireAdmin, (req, res) => {
  const row = db.prepare('SELECT * FROM gifts WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Подарок не найден' });
  if (req.body.fileUrl !== undefined && req.body.file_url === undefined) req.body.file_url = req.body.fileUrl;
  if (req.body.fileType !== undefined && req.body.file_type === undefined) req.body.file_type = req.body.fileType;
  const fields = [];
  const values = [];
  const map = {
    title: (v) => String(v || '').trim().slice(0, 80),
    emoji: (v) => String(v || '🎁').slice(0, 8),
    price: (v) => Math.max(0, Math.floor(Number(v) || 0)),
    rarity: (v) => ['common', 'rare', 'epic', 'legendary'].includes(v) ? v : 'common',
    description: (v) => String(v || '').slice(0, 300),
    file_url: (v) => String(v || '').slice(0, 500),
    file_type: (v) => String(v || '').slice(0, 30),
    active: (v) => (v ? 1 : 0)
  };
  Object.entries(map).forEach(([key, clean]) => {
    if (req.body[key] !== undefined) { fields.push(`${key} = ?`); values.push(clean(req.body[key])); }
  });
  if (!fields.length) return res.status(400).json({ error: 'Нет изменений' });
  values.push(req.params.id);
  db.prepare(`UPDATE gifts SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  res.json(giftPayload(db.prepare('SELECT * FROM gifts WHERE id = ?').get(req.params.id)));
});

app.delete('/api/admin/gifts/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM gifts WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.get('/api/admin/giveaways', requireAdmin, (req, res) => {
  const rows = db.prepare(`
    SELECT g.*, c.title AS chat_title, c.type AS chat_type,
      u.username AS creator_username, u.display_name AS creator_name,
      (SELECT COUNT(*) FROM giveaway_participants p WHERE p.giveaway_id = g.id) AS participants,
      (SELECT COUNT(*) FROM giveaway_participants p WHERE p.giveaway_id = g.id AND p.winner = 1) AS winners
    FROM giveaways g
    LEFT JOIN chats c ON c.id = g.chat_id
    LEFT JOIN users u ON u.id = g.creator_id
    ORDER BY CASE g.status WHEN 'active' THEN 0 ELSE 1 END, g.created_at DESC
  `).all();
  res.json(rows.map(g => ({
    id: g.id, chatId: g.chat_id, chatTitle: g.chat_title || 'Канал', chatType: g.chat_type,
    creatorId: g.creator_id, creatorUsername: g.creator_username, creatorName: g.creator_name || g.creator_username,
    title: g.title, prizeType: g.prize_type, prizeValue: g.prize_value, prizeLabel: giveawayPrizeLabel(g),
    winnersCount: g.winners_count || 1, participants: g.participants || 0, winners: g.winners || 0,
    endsAt: g.ends_at, createdAt: g.created_at, finishedAt: g.finished_at, status: g.status
  })));
});

app.post('/api/admin/giveaways', requireAdmin, (req, res) => {
  const chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(String(req.body.chatId || ''));
  if (!chat || chat.type !== 'channel') return res.status(400).json({ error: 'Выберите канал' });
  const title = String(req.body.title || '').trim().slice(0, 80) || 'Розыгрыш';
  const prizeType = ['rubies', 'gift', 'custom'].includes(req.body.prizeType) ? req.body.prizeType : 'rubies';
  let prizeValue = String(req.body.prizeValue || '').trim().slice(0, 120);
  if (prizeType === 'rubies') {
    const amount = Math.max(1, Math.floor(Number(prizeValue) || 0));
    if (!amount) return res.status(400).json({ error: 'Укажите сумму приза' });
    prizeValue = String(amount);
  } else if (prizeType === 'gift') {
    const gift = db.prepare('SELECT id FROM gifts WHERE id = ? AND active = 1').get(prizeValue);
    if (!gift) return res.status(400).json({ error: 'Выберите подарок из маркета' });
  } else if (!prizeValue) {
    return res.status(400).json({ error: 'Опишите приз' });
  }
  const winnersCount = Math.max(1, Math.min(100, Math.floor(Number(req.body.winnersCount) || 1)));
  const duration = Math.max(1, Math.min(10080, Math.floor(Number(req.body.durationMinutes) || 1440)));
  const endsAt = new Date(Date.now() + duration * 60 * 1000).toISOString();
  const id = uuidv4();
  db.prepare('INSERT INTO giveaways (id, chat_id, creator_id, title, prize_type, prize_value, winners_count, ends_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, chat.id, req.user.id, title, prizeType, prizeValue, winnersCount, endsAt);
  io.to(chat.id).emit('giveaway_updated', { chatId: chat.id, giveawayId: id });
  emitChatsForChat(chat.id);
  res.json({ ok: true, id });
});

app.post('/api/admin/giveaways/:id/draw', requireAdmin, (req, res) => {
  const g = db.prepare('SELECT * FROM giveaways WHERE id = ?').get(req.params.id);
  if (!g) return res.status(404).json({ error: 'Розыгрыш не найден' });
  if (g.status !== 'active') return res.status(400).json({ error: 'Розыгрыш уже завершён' });
  res.json({ ok: true, giveaway: finishGiveaway(g, req.user.id) });
});

app.delete('/api/admin/giveaways/:id', requireAdmin, (req, res) => {
  const g = db.prepare('SELECT * FROM giveaways WHERE id = ?').get(req.params.id);
  if (!g) return res.status(404).json({ error: 'Розыгрыш не найден' });
  db.prepare('DELETE FROM giveaway_participants WHERE giveaway_id = ?').run(g.id);
  db.prepare('DELETE FROM giveaways WHERE id = ?').run(g.id);
  io.to(g.chat_id).emit('giveaway_updated', { chatId: g.chat_id, giveawayId: g.id });
  res.json({ ok: true });
});

app.get('/api/admin/stories', requireAdmin, (req, res) => {
  const rows = db.prepare(`
    SELECT s.*, u.username, u.display_name, u.avatar
    FROM stories s LEFT JOIN users u ON u.id = s.user_id
    ORDER BY s.created_at DESC LIMIT 300
  `).all();
  res.json(rows.map(s => ({
    id: s.id, userId: s.user_id, username: s.username, displayName: s.display_name || s.username,
    avatar: s.avatar || '', mediaUrl: s.media_url, mediaType: s.media_type, caption: s.caption || '',
    views: s.views || 0, createdAt: s.created_at, expiresAt: s.expires_at, deleted: !!s.deleted,
    active: !s.deleted && String(s.expires_at) > nowIso()
  })));
});

app.delete('/api/admin/stories/:id', requireAdmin, (req, res) => {
  const story = db.prepare('SELECT * FROM stories WHERE id = ?').get(req.params.id);
  if (!story) return res.status(404).json({ error: 'История не найдена' });
  db.prepare('UPDATE stories SET deleted = 1 WHERE id = ?').run(story.id);
  db.prepare('DELETE FROM story_views WHERE story_id = ?').run(story.id);
  io.emit('stories_updated', { userId: story.user_id });
  res.json({ ok: true });
});

app.get('/api/admin/badges', requireAdmin, (req, res) => {
  const rows = db.prepare(`
    SELECT b.*, u.username, u.display_name, u.avatar
    FROM badges b LEFT JOIN users u ON u.id = b.user_id
    ORDER BY b.created_at DESC LIMIT 500
  `).all();
  res.json(rows.map(b => ({
    id: b.id, userId: b.user_id, username: b.username, displayName: b.display_name || b.username,
    avatar: b.avatar || '', icon: b.icon, title: b.title, color: b.color || '', createdAt: b.created_at
  })));
});

app.post('/api/admin/broadcast', requireAdmin, (req, res) => {
  const text = String(req.body.text || '').trim().slice(0, 2000);
  if (!text) return res.status(400).json({ error: 'Введите текст' });
  const chats = db.prepare("SELECT id FROM chats WHERE type != 'dm'").all();
  const insert = db.prepare('INSERT INTO messages (id, chat_id, sender_id, text) VALUES (?, ?, ?, ?)');
  chats.forEach(c => {
    const id = uuidv4();
    insert.run(id, c.id, req.user.id, text);
    io.to(c.id).emit('new_message', messageById(id));
    emitChatsForChat(c.id);
  });
  res.json({ ok: true, sent: chats.length });
});

app.get('/api/admin/clans', requireAdmin, (req, res) => {
  res.json(db.prepare(`
    SELECT c.*, u.display_name AS leader_name,
      (SELECT COUNT(*) FROM clan_members m WHERE m.clan_id = c.id) AS members
    FROM clans c LEFT JOIN users u ON u.id = c.leader_id ORDER BY c.created_at DESC
  `).all());
});

app.delete('/api/admin/clans/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM clan_members WHERE clan_id = ?').run(req.params.id);
  db.prepare('DELETE FROM clans WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

/* ------------------------------------------------------------------ */
/*  SOCKET.IO                                                          */
/* ------------------------------------------------------------------ */
const onlineSockets = new Map(); // userId -> Set(socket.id)

io.use((socket, next) => {
  const token = socket.handshake.auth?.token || socket.handshake.query?.token;
  const user = userByToken(token);
  if (!user) return next(new Error('Unauthorized'));
  if (user.banned) return next(new Error('Banned'));
  socket.user = user;
  next();
});

io.on('connection', (socket) => {
  const user = socket.user;
  const uid = user.id;
  if (!onlineSockets.has(uid)) onlineSockets.set(uid, new Set());
  onlineSockets.get(uid).add(socket.id);
  socket.join(`user:${uid}`);
  db.prepare('SELECT chat_id FROM chat_members WHERE user_id = ?').all(uid)
    .forEach(m => socket.join(m.chat_id));
  db.prepare('UPDATE users SET last_seen = ? WHERE id = ?').run(nowIso(), uid);
  io.emit('presence', { userId: uid, online: true, lastSeen: nowIso() });
  socket.emit('chats_list', listChats(uid));

  socket.on('fetch_chats', () => socket.emit('chats_list', listChats(uid)));

  socket.on('join_chat', (payload) => {
    const chatId = typeof payload === 'string' ? payload : payload?.chatId;
    if (!chatId || !isMember(chatId, uid)) return;
    socket.join(chatId);
    const messages = db.prepare(`
      ${MESSAGE_SELECT}
      WHERE m.chat_id = ? AND m.deleted = 0
      ORDER BY m.created_at DESC, m.rowid DESC LIMIT 100
    `).all(chatId).reverse();
    socket.emit('chat_history', { chatId, messages: attachReactions(messages, uid) });
    db.prepare('UPDATE chat_members SET last_read_at = ? WHERE chat_id = ? AND user_id = ?').run(nowIso(), chatId, uid);
    emitChats(uid);
  });

  socket.on('leave_chat', (chatId) => { if (chatId) socket.leave(chatId); });

  socket.on('mark_read', (chatId) => {
    if (!chatId || !isMember(chatId, uid)) return;
    db.prepare('UPDATE chat_members SET last_read_at = ? WHERE chat_id = ? AND user_id = ?').run(nowIso(), chatId, uid);
    emitChats(uid);
  });

  socket.on('send_message', (data = {}) => {
    const chatId = data.chatId;
    if (!chatId || !isMember(chatId, uid)) return;
    const chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(chatId);
    if (!chat) return;
    if (!canSendToChat(chat, user)) {
      return socket.emit('error_message', chat.type === 'channel'
        ? 'Только администраторы могут писать в канал'
        : 'В этой группе писать могут только администраторы');
    }
    const text = String(data.text || '').slice(0, 4000);
    let fileUrl = data.fileUrl ? String(data.fileUrl) : null;
    let fileType = data.fileType ? String(data.fileType) : null;
    let fileName = data.fileName ? String(data.fileName).slice(0, 200) : null;
    if (fileType === 'sticker') {
      // Стикеры — только из локальной библиотеки, без внешних ссылок.
      if (!fileUrl || !/^\/stickers\/[a-z0-9_\-./]+\.(webp|png|gif)$/i.test(fileUrl) || fileUrl.includes('..')) return;
      fileName = fileName || 'sticker.webp';
    }
    if (!text && !fileUrl) return;
    let replyTo = data.replyTo ? String(data.replyTo) : null;
    if (replyTo) {
      const original = db.prepare('SELECT id FROM messages WHERE id = ? AND chat_id = ? AND deleted = 0').get(replyTo, chatId);
      if (!original) replyTo = null;
    }
    const id = uuidv4();
    db.prepare(`
      INSERT INTO messages (id, chat_id, sender_id, text, file_url, file_name, file_type, reply_to)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, chatId, uid, text, fileUrl, fileName, fileType, replyTo);
    const members = chatMembers(chatId);
    const msg = messageById(id);
    msg.reactions = [];
    members.forEach(m => {
      io.to(`user:${m.user_id}`).emit('new_message', msg);
      if (m.user_id !== uid) io.to(`user:${m.user_id}`).emit('notify_message', { chatId, message: msg });
    });
    emitChatsForChat(chatId);
    try {
      nftPhrases.onMessage({ userId: uid, chatType: chat.type, memberCount: members.length, text });
    } catch (error) {
      // A failure in the optional reward must not interrupt message delivery.
      console.error('NFT phrase offer:', error);
    }
  });

  socket.on('delete_message', ({ messageId } = {}) => {
    const msg = db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId);
    if (!msg) return;
    const chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(msg.chat_id);
    if (msg.sender_id !== uid && !canManageChat(chat, user)) return;
    db.prepare("UPDATE messages SET deleted = 1, text = '', file_url = NULL, file_name = NULL WHERE id = ?").run(msg.id);
    clearMessageReactions(msg.id);
    io.to(msg.chat_id).emit('message_deleted', { messageId: msg.id, chatId: msg.chat_id });
    emitChatsForChat(msg.chat_id);
  });

  socket.on('toggle_reaction', ({ messageId, emoji } = {}) => {
    const msg = db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId);
    if (!msg || msg.deleted || !isMember(msg.chat_id, uid)) return;
    const value = String(emoji || '').trim().slice(0, 12);
    if (!value) return;
    const existing = db.prepare('SELECT emoji FROM message_reactions WHERE message_id = ? AND user_id = ?').get(msg.id, uid);
    if (existing && existing.emoji === value) {
      db.prepare('DELETE FROM message_reactions WHERE message_id = ? AND user_id = ?').run(msg.id, uid);
    } else {
      db.prepare(`
        INSERT INTO message_reactions (message_id, user_id, emoji) VALUES (?, ?, ?)
        ON CONFLICT(message_id, user_id) DO UPDATE SET emoji = excluded.emoji, created_at = CURRENT_TIMESTAMP
      `).run(msg.id, uid, value);
    }
    chatMembers(msg.chat_id).forEach(m => {
      io.to(`user:${m.user_id}`).emit('message_reactions', {
        messageId: msg.id,
        chatId: msg.chat_id,
        reactions: reactionsForMessage(msg.id, m.user_id)
      });
    });
  });

  socket.on('edit_message', ({ messageId, text } = {}) => {
    const msg = db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId);
    if (!msg || msg.sender_id !== uid || msg.deleted) return;
    const value = String(text || '').slice(0, 4000);
    if (!value) return;
    db.prepare('UPDATE messages SET text = ?, edited_at = ? WHERE id = ?').run(value, nowIso(), msg.id);
    io.to(msg.chat_id).emit('message_edited', messageById(msg.id));
    emitChatsForChat(msg.chat_id);
  });

  socket.on('typing', ({ chatId } = {}) => {
    if (chatId && isMember(chatId, uid)) {
      socket.to(chatId).emit('user_typing', { chatId, userId: uid, displayName: user.display_name || user.username });
    }
  });

  socket.on('stop_typing', ({ chatId } = {}) => {
    if (chatId) socket.to(chatId).emit('user_stop_typing', { chatId, userId: uid });
  });

  socket.on('disconnect', () => {
    const set = onlineSockets.get(uid);
    if (set) {
      set.delete(socket.id);
      if (!set.size) {
        onlineSockets.delete(uid);
        const seen = nowIso();
        db.prepare('UPDATE users SET last_seen = ? WHERE id = ?').run(seen, uid);
        io.emit('presence', { userId: uid, online: false, lastSeen: seen });
      }
    }
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`[CookieChat Server] Running on http://localhost:${PORT}`);
});
