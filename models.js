// models.js
// =====================================================
// Modelos de Mongoose para NexusChat
// Contiene los 3 esquemas: User, Chat, Message
// =====================================================

import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

// -----------------------------------------------------
// USER
// -----------------------------------------------------
const userSchema = new mongoose.Schema(
  {
    username: {
      type: String,
      required: [true, 'El nombre de usuario es obligatorio'],
      unique: true,
      trim: true,
      lowercase: true,
      minlength: 3,
      maxlength: 30,
    },
    displayName: {
      type: String,
      required: [true, 'El nombre para mostrar es obligatorio'],
      trim: true,
      maxlength: 50,
    },
    email: {
      type: String,
      required: [true, 'El email es obligatorio'],
      unique: true,
      trim: true,
      lowercase: true,
      match: [/^\S+@\S+\.\S+$/, 'Email inválido'],
    },
    password: {
      type: String,
      required: [true, 'La contraseña es obligatoria'],
      minlength: 6,
      select: false, // No se devuelve por defecto
    },
    avatar: {
      type: String,
      default: '', // Si está vacío, el frontend genera uno con iniciales
    },
    status: {
      type: String,
      default: '¡Hola! Estoy usando NexusChat 👋',
      maxlength: 120,
    },
    isOnline: {
      type: Boolean,
      default: false,
    },
    lastSeen: {
      type: Date,
      default: Date.now,
    },
  },
  { timestamps: true }
);

// Hash automático de la contraseña antes de guardar
userSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
  next();
});

// Comparar contraseña en login
userSchema.methods.comparePassword = async function (candidatePassword) {
  return bcrypt.compare(candidatePassword, this.password);
};

// Devolver datos públicos (sin password)
userSchema.methods.toPublicJSON = function () {
  return {
    _id: this._id,
    username: this.username,
    displayName: this.displayName,
    email: this.email,
    avatar: this.avatar,
    status: this.status,
    isOnline: this.isOnline,
    lastSeen: this.lastSeen,
  };
};

// -----------------------------------------------------
// CHAT
// -----------------------------------------------------
const chatSchema = new mongoose.Schema(
  {
    isGroup: {
      type: Boolean,
      default: false,
    },
    name: {
      type: String,
      trim: true,
      maxlength: 80,
    },
    avatar: {
      type: String,
      default: '',
    },
    participants: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
      },
    ],
    admins: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
      },
    ],
    lastMessage: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Message',
    },
  },
  { timestamps: true }
);

// Validación: los grupos deben tener nombre
chatSchema.pre('validate', function (next) {
  if (this.isGroup && !this.name) {
    return next(new Error('Los chats grupales deben tener un nombre'));
  }
  next();
});

// Índice para búsquedas rápidas por participantes
chatSchema.index({ participants: 1 });

// -----------------------------------------------------
// MESSAGE
// -----------------------------------------------------
const messageSchema = new mongoose.Schema(
  {
    chat: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Chat',
      required: true,
      index: true,
    },
    sender: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    content: {
      type: String,
      required: true,
      trim: true,
      maxlength: 2000,
    },
    type: {
      type: String,
      enum: ['text', 'image', 'file', 'system'],
      default: 'text',
    },
    readBy: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
      },
    ],
    deliveredTo: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
      },
    ],
  },
  { timestamps: true }
);

// Índice compuesto para cargar historial eficientemente
messageSchema.index({ chat: 1, createdAt: -1 });

// -----------------------------------------------------
// EXPORTS
// -----------------------------------------------------
export const User = mongoose.model('User', userSchema);
export const Chat = mongoose.model('Chat', chatSchema);
export const Message = mongoose.model('Message', messageSchema);