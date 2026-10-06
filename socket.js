// socket.js
// =====================================================
// Lógica completa de Socket.io para NexusChat
// Maneja: presencia, mensajes, typing, lectura
// =====================================================

import jwt from 'jsonwebtoken';
import { User, Chat, Message } from './models.js';

// Mapa en memoria: userId -> Set de socketIds
// (un usuario puede tener varias pestañas/dispositivos abiertos)
const onlineUsers = new Map();

// Helper: emitir a todos los sockets de un usuario
function emitToUser(io, userId, event, payload) {
  const set = onlineUsers.get(userId.toString());
  if (!set) return;
  set.forEach((socketId) => io.to(socketId).emit(event, payload));
}

export function setupSocket(io) {
  // ---------------------------------------------
  // Middleware de autenticación para Socket.io
  // Verifica el JWT en el handshake
  // ---------------------------------------------
  io.use((socket, next) => {
    try {
      const token =
        socket.handshake.auth?.token ||
        socket.handshake.headers?.authorization?.split(' ')[1];

      if (!token) return next(new Error('Token ausente'));

      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      socket.userId = decoded.id;
      socket.username = decoded.username;
      next();
    } catch (err) {
      next(new Error('Autenticación de socket fallida'));
    }
  });

  // ---------------------------------------------
  // Conexión de un cliente
  // ---------------------------------------------
  io.on('connection', async (socket) => {
    console.log(`🔌 Conectado: ${socket.username} (${socket.id})`);

    // Registrar socket en el mapa
    if (!onlineUsers.has(socket.userId)) {
      onlineUsers.set(socket.userId, new Set());
    }
    onlineUsers.get(socket.userId).add(socket.id);

    // Marcar usuario online en DB
    await User.findByIdAndUpdate(socket.userId, {
      isOnline: true,
      lastSeen: Date.now(),
    });

    // Unir el socket a las salas de todos sus chats
    const userChats = await Chat.find({ participants: socket.userId }).select('_id');
    userChats.forEach((c) => socket.join(`chat:${c._id}`));

    // Notificar a los demás que este usuario está online
    socket.broadcast.emit('user:online', { userId: socket.userId });

    // ---------------------------------------------
    // EVENTO: unirse a un chat nuevo (creado en caliente)
    // ---------------------------------------------
    socket.on('chat:join', ({ chatId }) => {
      if (chatId) socket.join(`chat:${chatId}`);
    });

    // ---------------------------------------------
    // EVENTO: enviar mensaje
    // ---------------------------------------------
    socket.on('message:send', async ({ chatId, content }, ack) => {
      try {
        if (!content?.trim()) {
          return ack?.({ error: 'Mensaje vacío' });
        }

        const chat = await Chat.findById(chatId);
        if (!chat) {
          return ack?.({ error: 'Chat no encontrado' });
        }
        if (!chat.participants.some((p) => p.toString() === socket.userId)) {
          return ack?.({ error: 'No autorizado para este chat' });
        }

        // Crear el mensaje en DB
        const message = await Message.create({
          chat: chatId,
          sender: socket.userId,
          content: content.trim(),
          deliveredTo: [socket.userId],
        });

        // Poblar el sender para enviarlo al frontend
        await message.populate('sender', 'username displayName avatar');

        // Actualizar el lastMessage del chat
        chat.lastMessage = message._id;
        await chat.save();

        // Emitir el mensaje a todos los participantes de la sala
        io.to(`chat:${chatId}`).emit('message:new', message);

        // Ack al emisor con el id del mensaje creado
        ack?.({ ok: true, messageId: message._id });
      } catch (err) {
        console.error('Error enviando mensaje:', err);
        ack?.({ error: 'Error del servidor al enviar' });
      }
    });

    // ---------------------------------------------
    // EVENTO: indicador "escribiendo..."
    // ---------------------------------------------
    socket.on('typing:start', ({ chatId }) => {
      if (!chatId) return;
      socket.to(`chat:${chatId}`).emit('typing:start', {
        chatId,
        userId: socket.userId,
        username: socket.username,
      });
    });

    socket.on('typing:stop', ({ chatId }) => {
      if (!chatId) return;
      socket.to(`chat:${chatId}`).emit('typing:stop', {
        chatId,
        userId: socket.userId,
      });
    });

    // ---------------------------------------------
    // EVENTO: confirmación de lectura
    // ---------------------------------------------
    socket.on('message:read', async ({ chatId, messageIds = [] }) => {
      try {
        if (!chatId || messageIds.length === 0) return;

        await Message.updateMany(
          {
            _id: { $in: messageIds },
            chat: chatId,
            readBy: { $ne: socket.userId },
          },
          { $addToSet: { readBy: socket.userId } }
        );

        socket.to(`chat:${chatId}`).emit('message:read', {
          chatId,
          userId: socket.userId,
          messageIds,
        });
      } catch (err) {
        console.error('Error marcando como leído:', err);
      }
    });

    // ---------------------------------------------
    // EVENTO: desconexión
    // ---------------------------------------------
    socket.on('disconnect', async () => {
      console.log(`❌ Desconectado: ${socket.username}`);

      const set = onlineUsers.get(socket.userId);
      if (set) {
        set.delete(socket.id);

        // Si no le quedan sockets abiertos, marcar como offline
        if (set.size === 0) {
          onlineUsers.delete(socket.userId);
          await User.findByIdAndUpdate(socket.userId, {
            isOnline: false,
            lastSeen: Date.now(),
          });
          io.emit('user:offline', {
            userId: socket.userId,
            lastSeen: Date.now(),
          });
        }
      }
    });
  });
}