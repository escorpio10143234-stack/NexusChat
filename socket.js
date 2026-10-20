// socket.js
// =====================================================
// Lógica completa de Socket.io para NexusChat
// =====================================================

import jwt from 'jsonwebtoken';
import { User, Chat, Message } from './models.js';

const onlineUsers = new Map();

export function setupSocket(io) {
  // Middleware de autenticación
  io.use((socket, next) => {
    try {
      const token = socket.handshake.auth?.token || socket.handshake.headers?.authorization?.split(' ')[1];
      if (!token) return next(new Error('Token ausente'));
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      socket.userId = decoded.id;
      socket.username = decoded.username;
      next();
    } catch (err) {
      next(new Error('Autenticación fallida'));
    }
  });

  io.on('connection', async (socket) => {
    console.log(`🔌 Conectado: ${socket.username}`);

    // Sala personal para notificaciones directas (Fuera de la sala del chat)
    socket.join(socket.userId);

    if (!onlineUsers.has(socket.userId)) onlineUsers.set(socket.userId, new Set());
    onlineUsers.get(socket.userId).add(socket.id);

    await User.findByIdAndUpdate(socket.userId, { isOnline: true, lastSeen: Date.now() });

    const userChats = await Chat.find({ participants: socket.userId }).select('_id');
    userChats.forEach((c) => socket.join(`chat:${c._id}`));

    socket.broadcast.emit('user:online', { userId: socket.userId });

    // ---------------------------------------------
    // EVENTO: unirse a un chat nuevo
    // ---------------------------------------------
    socket.on('chat:join', ({ chatId }) => {
      if (chatId) socket.join(`chat:${chatId}`);
    });

    // ---------------------------------------------
    // EVENTO: enviar mensaje
    // ---------------------------------------------
    socket.on('message:send', async ({ chatId, content }, ack) => {
      try {
        if (!content?.trim()) return ack?.({ error: 'Mensaje vacío' });

        const chat = await Chat.findById(chatId);
        if (!chat) return ack?.({ error: 'Chat no encontrado' });
        if (!chat.participants.some((p) => p.toString() === socket.userId)) {
          return ack?.({ error: 'No autorizado' });
        }

        const message = await Message.create({
          chat: chatId,
          sender: socket.userId,
          content: content.trim(),
          deliveredTo: [socket.userId],
        });

        await message.populate('sender', 'username displayName avatar');
        
        chat.lastMessage = message._id;
        await chat.save();

        // Emitir a los que ya tienen el chat abierto
        io.to(`chat:${chatId}`).emit('message:new', message);

        // 🔥 Emitir a los demás participantes para que actualicen su lista de chats
        chat.participants.forEach((participantId) => {
          if (participantId.toString() !== socket.userId) {
            io.to(participantId.toString()).emit('chat:new-message', { chatId, message });
          }
        });

        ack?.({ ok: true, messageId: message._id });
      } catch (err) {
        console.error('Error enviando mensaje:', err);
        ack?.({ error: 'Error del servidor' });
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
          { _id: { $in: messageIds }, chat: chatId, readBy: { $ne: socket.userId } },
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
        if (set.size === 0) {
          onlineUsers.delete(socket.userId);
          await User.findByIdAndUpdate(socket.userId, { isOnline: false, lastSeen: Date.now() });
          io.emit('user:offline', { userId: socket.userId, lastSeen: Date.now() });
        }
      }
    });
  });
}