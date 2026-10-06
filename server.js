// server.js
// =====================================================
// NexusChat - Servidor principal
// Express + Socket.io + MongoDB + Rutas API
// =====================================================

import 'dotenv/config';
import express from 'express';
import http from 'http';
import { Server as SocketServer } from 'socket.io';
import mongoose from 'mongoose';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import path from 'path';
import { fileURLToPath } from 'url';

import { User, Chat, Message } from './models.js';
import { setupSocket } from './socket.js';

// ---------------------------------------------
// Configuración básica
// ---------------------------------------------
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const server = http.createServer(app);
const io = new SocketServer(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
});

// ---------------------------------------------
// Middlewares globales
// ---------------------------------------------
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Servir archivos estáticos desde /public
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------
// Helpers de autenticación
// ---------------------------------------------
const signToken = (user) =>
  jwt.sign(
    { id: user._id, username: user.username },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );

const cookieOptions = {
  httpOnly: true,
  sameSite: 'lax',
  secure: process.env.NODE_ENV === 'production',
  maxAge: 7 * 24 * 60 * 60 * 1000, // 7 días
};

// Middleware: exige token válido (header Bearer o cookie)
function auth(req, res, next) {
  try {
    let token = null;
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith('Bearer ')) token = authHeader.split(' ')[1];
    if (!token && req.cookies?.token) token = req.cookies.token;

    if (!token) return res.status(401).json({ error: 'No autenticado' });

    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Token inválido o expirado' });
  }
}

// =====================================================
// RUTAS API
// =====================================================

// -------- AUTH --------

// POST /api/auth/register
app.post('/api/auth/register', async (req, res) => {
  try {
    const { username, displayName, email, password } = req.body;

    if (!username || !displayName || !email || !password) {
      return res.status(400).json({ error: 'Todos los campos son obligatorios' });
    }
    if (password.length < 6) {
      return res
        .status(400)
        .json({ error: 'La contraseña debe tener al menos 6 caracteres' });
    }

    const exists = await User.findOne({
      $or: [{ username: username.toLowerCase() }, { email: email.toLowerCase() }],
    });
    if (exists) {
      return res.status(409).json({ error: 'Usuario o email ya registrado' });
    }

    const user = await User.create({
      username: username.toLowerCase(),
      displayName,
      email: email.toLowerCase(),
      password,
    });

    const token = signToken(user);
    res.cookie('token', token, cookieOptions);
    res.status(201).json({ token, user: user.toPublicJSON() });
  } catch (err) {
    console.error('Error en registro:', err);
    res.status(500).json({ error: 'Error del servidor al registrar' });
  }
});

// POST /api/auth/login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Usuario y contraseña requeridos' });
    }

    const user = await User.findOne({ username: username.toLowerCase() }).select(
      '+password'
    );
    if (!user) return res.status(401).json({ error: 'Credenciales inválidas' });

    const match = await user.comparePassword(password);
    if (!match) return res.status(401).json({ error: 'Credenciales inválidas' });

    const token = signToken(user);
    res.cookie('token', token, cookieOptions);
    res.json({ token, user: user.toPublicJSON() });
  } catch (err) {
    console.error('Error en login:', err);
    res.status(500).json({ error: 'Error del servidor al iniciar sesión' });
  }
});

// GET /api/auth/me
app.get('/api/auth/me', auth, async (req, res) => {
  const user = await User.findById(req.user.id);
  if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
  res.json({ user: user.toPublicJSON() });
});

// POST /api/auth/logout
app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ ok: true });
});

// -------- USERS --------

// GET /api/users/search?q=texto
app.get('/api/users/search', auth, async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json({ users: [] });

  const regex = new RegExp(q, 'i');
  const users = await User.find({
    _id: { $ne: req.user.id },
    $or: [{ username: regex }, { displayName: regex }],
  })
    .limit(20)
    .select('username displayName avatar status isOnline lastSeen');

  res.json({ users });
});

// PUT /api/users/me
app.put('/api/users/me', auth, async (req, res) => {
  const { displayName, status, avatar } = req.body;
  const update = {};
  if (displayName) update.displayName = displayName;
  if (status !== undefined) update.status = status;
  if (avatar !== undefined) update.avatar = avatar;

  const user = await User.findByIdAndUpdate(req.user.id, update, { new: true });
  res.json({ user: user.toPublicJSON() });
});

// -------- CHATS --------

// GET /api/chats — lista de chats del usuario
app.get('/api/chats', auth, async (req, res) => {
  const chats = await Chat.find({ participants: req.user.id })
    .populate('participants', 'username displayName avatar isOnline lastSeen status')
    .populate({
      path: 'lastMessage',
      populate: { path: 'sender', select: 'username displayName' },
    })
    .sort({ updatedAt: -1 });

  res.json({ chats });
});

// POST /api/chats — crear chat (1-a-1 o grupal)
app.post('/api/chats', auth, async (req, res) => {
  try {
    const { participantIds = [], isGroup = false, name = '' } = req.body;

    if (!Array.isArray(participantIds) || participantIds.length === 0) {
      return res
        .status(400)
        .json({ error: 'Debes indicar al menos un participante' });
    }

    const allParticipants = [...new Set([req.user.id, ...participantIds])];

    // Verificar que todos existan
    const found = await User.countDocuments({ _id: { $in: allParticipants } });
    if (found !== allParticipants.length) {
      return res.status(400).json({ error: 'Uno o más usuarios no existen' });
    }

    // Chat 1-a-1: reutilizar si ya existe
    if (!isGroup) {
      if (allParticipants.length !== 2) {
        return res
          .status(400)
          .json({ error: 'Un chat 1-a-1 debe tener exactamente 2 participantes' });
      }
      const existing = await Chat.findOne({
        isGroup: false,
        participants: { $all: allParticipants, $size: 2 },
      })
        .populate(
          'participants',
          'username displayName avatar isOnline lastSeen status'
        )
        .populate('lastMessage');

      if (existing) return res.json({ chat: existing, existed: true });
    }

    const chat = await Chat.create({
      isGroup,
      name: isGroup ? name : undefined,
      participants: allParticipants,
      admins: isGroup ? [req.user.id] : [],
    });

    const populated = await chat.populate(
      'participants',
      'username displayName avatar isOnline lastSeen status'
    );

    res.status(201).json({ chat: populated });
  } catch (err) {
    console.error('Error creando chat:', err);
    res.status(500).json({ error: 'Error al crear el chat' });
  }
});

// GET /api/chats/:id/messages — historial
app.get('/api/chats/:id/messages', auth, async (req, res) => {
  const chat = await Chat.findById(req.params.id);
  if (!chat) return res.status(404).json({ error: 'Chat no encontrado' });
  if (!chat.participants.some((p) => p.toString() === req.user.id)) {
    return res.status(403).json({ error: 'No perteneces a este chat' });
  }

  const messages = await Message.find({ chat: req.params.id })
    .populate('sender', 'username displayName avatar')
    .sort({ createdAt: 1 })
    .limit(200);

  res.json({ messages });
});

// -------- HEALTH CHECK --------
app.get('/api/health', (_req, res) =>
  res.json({ ok: true, uptime: process.uptime() })
);

// -------- SPA FALLBACK --------
// Cualquier ruta que no sea /api devuelve index.html (para SPA)
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api')) return next();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// -------- Manejo de errores --------
app.use((err, _req, res, _next) => {
  console.error('💥 Error no manejado:', err);
  res.status(500).json({ error: 'Error interno del servidor' });
});

// =====================================================
// Socket.io
// =====================================================
setupSocket(io);

// =====================================================
// Arranque: MongoDB + servidor HTTP
// =====================================================
const PORT = process.env.PORT || 3000;

async function start() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ MongoDB conectado');

    server.listen(PORT, () => {
      console.log(`🚀 NexusChat corriendo en http://localhost:${PORT}`);
    });
  } catch (err) {
    console.error('❌ Error iniciando el servidor:', err);
    process.exit(1);
  }
}

start();