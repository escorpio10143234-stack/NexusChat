// =====================================================
// app.js — Lógica cliente de NexusChat
// =====================================================

const state = {
  user: null,
  token: null,
  socket: null,
  chats: [],
  activeChat: null,
  messages: [],
  onlineUsers: new Set(),
  notificationsEnabled: false,
  newChat: { mode: '1a1', selected: [] },
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function esc(str = '') {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function initials(name = '?') {
  return name.trim().split(/\s+/).slice(0, 2).map((p) => p[0]).join('').toUpperCase();
}

function formatTime(date) {
  return new Date(date).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
}

function formatDate(date) {
  const d = new Date(date);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (sameDay(d, today)) return 'Hoy';
  if (sameDay(d, yesterday)) return 'Ayer';
  return d.toLocaleDateString('es', { day: '2-digit', month: 'short', year: 'numeric' });
}

function avatarStyle(user) {
  if (user?.avatar) return `background-image:url('${esc(user.avatar)}')`;
  return '';
}

function toast(msg, type = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  $('#toast-container').appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transition = 'opacity 0.3s';
    setTimeout(() => el.remove(), 300);
  }, 3000);
}

async function api(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  const res = await fetch(path, { ...options, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
  return data;
}

// =====================================================
// NOTIFICACIONES
// =====================================================
async function requestNotificationPermission() {
  if (!('Notification' in window)) { toast('Navegador sin soporte', 'error'); return false; }
  if (Notification.permission === 'granted') { state.notificationsEnabled = true; $('#btn-notifications')?.classList.add('active'); return true; }
  if (Notification.permission === 'denied') { toast('Notificaciones bloqueadas', 'error'); return false; }
  const permission = await Notification.requestPermission();
  if (permission === 'granted') { state.notificationsEnabled = true; $('#btn-notifications')?.classList.add('active'); toast('Notificaciones activadas 🔔'); return true; }
  toast('Permiso denegado', 'error'); return false;
}

function showNotification(title, body) {
  if (!state.notificationsEnabled || Notification.permission !== 'granted' || document.visibilityState === 'visible') return;
  try {
    const n = new Notification(title, { body, icon: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>💬</text></svg>", tag: 'nexuschat' });
    n.onclick = () => { window.focus(); n.close(); };
  } catch (err) { console.error(err); }
}

function autoRequestNotifications() {
  if ('Notification' in window && Notification.permission === 'default') setTimeout(requestNotificationPermission, 3000);
  else if ('Notification' in window && Notification.permission === 'granted') { state.notificationsEnabled = true; $('#btn-notifications')?.classList.add('active'); }
}

// =====================================================
// AUTENTICACIÓN
// =====================================================
function saveSession() {
  if (state.token) {
    localStorage.setItem('nexus_token', state.token);
    localStorage.setItem('nexus_user', JSON.stringify(state.user));
  }
}

function clearSession() {
  localStorage.removeItem('nexus_token');
  localStorage.removeItem('nexus_user');
}

function restoreSession() {
  const token = localStorage.getItem('nexus_token');
  const user = localStorage.getItem('nexus_user');
  if (token && user) {
    state.token = token;
    try { state.user = JSON.parse(user); return true; } catch { clearSession(); }
  }
  return false;
}

function setupAuthTabs() {
  $('#tab-login').addEventListener('click', () => {
    $('#tab-login').classList.add('active'); $('#tab-register').classList.remove('active');
    $('#login-form').classList.remove('hidden'); $('#register-form').classList.add('hidden');
  });
  $('#tab-register').addEventListener('click', () => {
    $('#tab-register').classList.add('active'); $('#tab-login').classList.remove('active');
    $('#register-form').classList.remove('hidden'); $('#login-form').classList.add('hidden');
  });
}

function enableEnterNavigation(formSelector) {
  const form = document.querySelector(formSelector);
  if (!form) return;
  const fields = [...form.querySelectorAll('input')];
  fields.forEach((field, index) => {
    field.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const next = fields[index + 1];
      if (next) next.focus(); else form.requestSubmit();
    });
  });
}

$('#login-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  $('#login-error').textContent = '';
  try {
    const data = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: form.username.value.trim(), password: form.password.value }) });
    state.token = data.token; state.user = data.user; saveSession(); enterApp();
  } catch (err) { $('#login-error').textContent = err.message; }
});

$('#register-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  $('#register-error').textContent = '';
  try {
    const data = await api('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ displayName: form.displayName.value.trim(), username: form.username.value.trim(), email: form.email.value.trim(), password: form.password.value })
    });
    state.token = data.token; state.user = data.user; saveSession(); enterApp();
  } catch (err) { $('#register-error').textContent = err.message; }
});

async function logout() {
  try { await api('/api/auth/logout', { method: 'POST' }); } catch {}
  state.socket?.disconnect();
  state.token = null; state.user = null; state.chats = []; state.activeChat = null; state.messages = [];
  clearSession();
  document.body.classList.remove('app-active');
  $('#app-screen').classList.add('hidden'); $('#auth-screen').classList.remove('hidden');
}

function enterApp() {
  $('#auth-screen').classList.add('hidden'); $('#app-screen').classList.remove('hidden');
  document.body.classList.add('app-active');
  renderMe(); connectSocket(); loadChats(); autoRequestNotifications();
}

function renderMe() {
  const u = state.user;
  if (!u) return;
  const meAvatar = $('#me-avatar');
  meAvatar.textContent = u.avatar ? '' : initials(u.displayName || u.username);
  meAvatar.style.cssText = avatarStyle(u);
  $('#me-name').textContent = u.displayName || u.username;
  $('#me-status').textContent = u.status || '';
}

// =====================================================
// SOCKET.IO (Lógica de chats nuevos en tiempo real)
// =====================================================
function connectSocket() {
  state.socket = io({ auth: { token: state.token }, transports: ['websocket', 'polling'] });
  state.socket.on('connect', () => console.log('🟢 Socket conectado:', state.socket.id));
  state.socket.on('connect_error', (err) => { console.error(err); toast('Error de conexión', 'error'); });

  state.socket.on('user:online', ({ userId }) => { state.onlineUsers.add(userId); updatePresenceInUI(userId, true); });
  state.socket.on('user:offline', ({ userId }) => { state.onlineUsers.delete(userId); updatePresenceInUI(userId, false); });

  // 🔥 NUEVO: Alguien nos envía un mensaje en un chat que NO tenemos abierto
  state.socket.on('chat:new-message', ({ chatId, message }) => {
    // Refrescamos la lista de chats para que aparezca el nuevo chat mágicamente
    refreshChatsSilently();
    
    // Si no tenemos ese chat abierto, mostramos notificación
    if (!state.activeChat || String(state.activeChat._id) !== String(chatId)) {
      if (String(message.sender._id) !== String(state.user._id)) {
        toast(`💬 ${message.sender.displayName}: ${message.content.slice(0, 40)}`);
        showNotification(`Nuevo mensaje de ${message.sender.displayName}`, message.content);
      }
    }
  });

  state.socket.on('message:new', (message) => {
    const msgChatId = message.chat?._id || message.chat;
    const isMine = String(message.sender._id) === String(state.user._id);
    if (state.activeChat && String(state.activeChat._id) === String(msgChatId)) {
      state.messages.push(message); appendMessage(message); scrollToBottom();
      state.socket.emit('message:read', { chatId: msgChatId, messageIds: [message._id] });
    }
    refreshChatsSilently();
  });

  state.socket.on('typing:start', ({ chatId, username }) => {
    if (!state.activeChat || String(state.activeChat._id) !== String(chatId)) return;
    $('#typing-text').textContent = `${username} está escribiendo`;
    $('#typing-indicator').classList.remove('hidden');
  });

  state.socket.on('typing:stop', ({ chatId }) => {
    if (!state.activeChat || String(state.activeChat._id) !== String(chatId)) return;
    $('#typing-indicator').classList.add('hidden');
  });

  state.socket.on('message:read', ({ chatId, messageIds }) => {
    if (!state.activeChat || String(state.activeChat._id) !== String(chatId)) return;
    messageIds.forEach((id) => {
      const el = document.querySelector(`.msg[data-id="${id}"] .msg-meta .check`);
      if (el) { el.textContent = '✓✓'; el.classList.add('read'); }
    });
  });
}

function updatePresenceInUI(userId, isOnline) {
  $$(`.chat-item[data-user-id="${userId}"] .presence`).forEach((el) => el.classList.toggle('online', isOnline));
  if (state.activeChat) {
    const other = getOtherParticipant(state.activeChat);
    if (other && String(other._id) === String(userId)) {
      const sub = $('#chat-subtitle');
      if (sub) { sub.textContent = isOnline ? 'en línea' : 'desconectado'; sub.classList.toggle('online', isOnline); }
    }
  }
}

// =====================================================
// CHATS
// =====================================================
async function loadChats() {
  try { const { chats } = await api('/api/chats'); state.chats = chats; renderChatList(); }
  catch (err) { console.error(err); toast('Error cargando chats', 'error'); }
}

async function refreshChatsSilently() {
  try { 
    const { chats } = await api('/api/chats'); 
    state.chats = chats; 
    renderChatList(); 
  } catch {}
}

function getOtherParticipant(chat) {
  if (!chat || chat.isGroup) return null;
  return chat.participants.find((p) => String(p._id) !== String(state.user._id));
}

function chatTitle(chat) {
  if (chat.isGroup) return chat.name || 'Grupo sin nombre';
  const other = getOtherParticipant(chat);
  return other?.displayName || other?.username || 'Usuario';
}

function chatAvatarInfo(chat) {
  if (chat.isGroup) return { text: initials(chat.name || 'G'), url: chat.avatar };
  const other = getOtherParticipant(chat);
  return { text: initials(other?.displayName || other?.username || '?'), url: other?.avatar };
}

function renderChatList() {
  const list = $('#chat-list');
  const filter = ($('#search-input').value || '').toLowerCase().trim();
  const chats = state.chats.filter((c) => {
    if (!filter) return true;
    return chatTitle(c).toLowerCase().includes(filter) || (c.lastMessage?.content?.toLowerCase() || '').includes(filter);
  });

  if (chats.length === 0) {
    list.innerHTML = `<p style="text-align:center;padding:32px 20px;color:var(--text-2);font-size:14px">${state.chats.length === 0 ? 'Aún no tienes chats. ¡Crea uno!' : 'Sin resultados'}</p>`;
    return;
  }

  list.innerHTML = chats.map((c) => {
    const title = esc(chatTitle(c));
    const avatar = chatAvatarInfo(c);
    const last = c.lastMessage;
    const preview = last ? `${esc(last.sender?.displayName || '')}: ${esc(last.content).slice(0, 40)}` : 'Sin mensajes';
    const time = last ? formatTime(last.createdAt) : '';
    const other = getOtherParticipant(c);
    const isOnline = other ? state.onlineUsers.has(String(other._id)) : false;
    const isActive = state.activeChat && String(state.activeChat._id) === String(c._id);

    return `
      <div class="chat-item ${isActive ? 'active' : ''}" data-chat-id="${c._id}" ${other ? `data-user-id="${other._id}"` : ''}>
        <div class="avatar" style="${avatarStyle({ avatar: avatar.url })}">${avatar.url ? '' : esc(avatar.text)}</div>
        <div class="chat-item-info">
          <div class="chat-item-top">
            <span class="chat-item-name">${title}${other ? `<span class="presence ${isOnline ? 'online' : ''}"></span>` : ''}</span>
            <span class="chat-item-time">${time}</span>
          </div>
          <div class="chat-item-bottom"><span class="chat-item-preview">${preview}</span></div>
        </div>
      </div>`;
  }).join('');

  $$('.chat-item').forEach((el) => el.addEventListener('click', () => openChat(el.dataset.chatId)));
}

async function openChat(chatId) {
  const chat = state.chats.find((c) => String(c._id) === String(chatId));
  if (!chat) return;
  state.activeChat = chat; renderChatList(); renderChatView(chat);
  state.socket.emit('chat:join', { chatId });

  try {
    const { messages } = await api(`/api/chats/${chatId}/messages`);
    state.messages = messages; renderMessages();
    const unreadIds = messages.filter((m) => !m.readBy?.includes(state.user._id)).map((m) => m._id);
    if (unreadIds.length) state.socket.emit('message:read', { chatId, messageIds: unreadIds });
    $('#chat-panel').classList.add('open');
  } catch (err) { toast('Error cargando mensajes', 'error'); }
}

function renderChatView(chat) {
  $('#empty-state').classList.add('hidden'); $('#chat-view').classList.remove('hidden');
  $('#chat-title').textContent = chatTitle(chat);
  const avatarEl = $('#chat-avatar');
  const avatar = chatAvatarInfo(chat);
  avatarEl.textContent = avatar.url ? '' : avatar.text;
  avatarEl.style.cssText = avatarStyle({ avatar: avatar.url });

  const sub = $('#chat-subtitle');
  if (chat.isGroup) { sub.textContent = `${chat.participants.length} participantes`; sub.classList.remove('online'); }
  else {
    const other = getOtherParticipant(chat);
    const isOnline = state.onlineUsers.has(String(other?._id));
    sub.textContent = isOnline ? 'en línea' : 'desconectado';
    sub.classList.toggle('online', isOnline);
  }
}

// =====================================================
// MENSAJES
// =====================================================
function renderMessages() {
  const container = $('#messages');
  container.innerHTML = '';
  let lastDate = '';
  state.messages.forEach((msg) => {
    const dateLabel = formatDate(msg.createdAt);
    if (dateLabel !== lastDate) {
      const sep = document.createElement('div'); sep.className = 'date-sep'; sep.textContent = dateLabel;
      container.appendChild(sep); lastDate = dateLabel;
    }
    container.appendChild(buildMessageEl(msg));
  });
  scrollToBottom();
}

function buildMessageEl(msg) {
  const isMe = String(msg.sender._id) === String(state.user._id);
  const div = document.createElement('div');
  div.className = `msg ${isMe ? 'me' : 'them'}`;
  div.dataset.id = msg._id;
  const senderName = !isMe && state.activeChat?.isGroup ? `<div class="sender-name">${esc(msg.sender.displayName)}</div>` : '';
  const isRead = msg.readBy?.length > 1;
  const check = isMe ? `<span class="check ${isRead ? 'read' : ''}">${isRead ? '✓✓' : '✓'}</span>` : '';
  div.innerHTML = `${senderName}<span>${esc(msg.content)}</span><span class="msg-meta">${formatTime(msg.createdAt)}${check}</span>`;
  return div;
}

function appendMessage(msg) {
  const container = $('#messages');
  const lastSep = container.querySelector('.date-sep:last-of-type');
  const dateLabel = formatDate(msg.createdAt);
  if (!lastSep || lastSep.textContent !== dateLabel) {
    const sep = document.createElement('div'); sep.className = 'date-sep'; sep.textContent = dateLabel;
    container.appendChild(sep);
  }
  container.appendChild(buildMessageEl(msg));
}

function scrollToBottom() { const c = $('#messages'); c.scrollTop = c.scrollHeight; }

$('#message-form')?.addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('#message-input');
  const content = input.value.trim();
  if (!content || !state.activeChat) return;
  state.socket.emit('message:send', { chatId: state.activeChat._id, content }, (ack) => { if (ack?.error) toast(ack.error, 'error'); });
  input.value = ''; input.focus(); state.socket.emit('typing:stop', { chatId: state.activeChat._id });
});

let typingTimeout = null;
$('#message-input')?.addEventListener('input', () => {
  if (!state.activeChat) return;
  state.socket.emit('typing:start', { chatId: state.activeChat._id });
  clearTimeout(typingTimeout);
  typingTimeout = setTimeout(() => state.socket.emit('typing:stop', { chatId: state.activeChat._id }), 1500);
});

// =====================================================
// MODALES
// =====================================================
function openNewChatModal() {
  state.newChat = { mode: '1a1', selected: [] };
  $('#user-search').value = ''; $('#user-results').innerHTML = '<p class="hint">Escribe para buscar usuarios registrados.</p>';
  $('#selected-users').innerHTML = ''; $('#group-name-box').classList.add('hidden'); $('#group-name').value = '';
  $('#newtab-1a1').classList.add('active'); $('#newtab-group').classList.remove('active');
  updateCreateButton(); $('#modal-new-chat').classList.remove('hidden');
}

function closeModal(id) { $(`#${id}`).classList.add('hidden'); }

document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-close-modal]');
  if (btn) closeModal(btn.dataset.closeModal);
  if (e.target.classList.contains('modal')) closeModal(e.target.id);
});

$('#newtab-1a1')?.addEventListener('click', () => {
  state.newChat.mode = '1a1'; state.newChat.selected = []; renderSelectedUsers();
  $('#newtab-1a1').classList.add('active'); $('#newtab-group').classList.remove('active');
  $('#group-name-box').classList.add('hidden'); updateCreateButton();
});

$('#newtab-group')?.addEventListener('click', () => {
  state.newChat.mode = 'group'; state.newChat.selected = []; renderSelectedUsers();
  $('#newtab-group').classList.add('active'); $('#newtab-1a1').classList.remove('active');
  $('#group-name-box').classList.remove('hidden'); updateCreateButton();
});

let searchTimeout = null;
$('#user-search')?.addEventListener('input', (e) => {
  const q = e.target.value.trim();
  clearTimeout(searchTimeout);
  if (!q) { $('#user-results').innerHTML = '<p class="hint">Escribe para buscar usuarios.</p>'; return; }
  searchTimeout = setTimeout(async () => {
    try { const { users } = await api(`/api/users/search?q=${encodeURIComponent(q)}`); renderUserResults(users); }
    catch { toast('Error buscando usuarios', 'error'); }
  }, 300);
});

function renderUserResults(users) {
  const container = $('#user-results');
  if (users.length === 0) { container.innerHTML = '<p class="hint">No hay usuarios.</p>'; return; }
  container.innerHTML = users.map((u) => {
    const isSelected = state.newChat.selected.some((s) => s._id === u._id);
    return `<div class="user-result ${isSelected ? 'selected' : ''}" data-user-id="${u._id}">
        <div class="avatar small" style="${avatarStyle(u)}">${u.avatar ? '' : esc(initials(u.displayName || u.username))}</div>
        <div class="user-result-info"><strong>${esc(u.displayName || u.username)}</strong><small>@${esc(u.username)}</small></div>
        ${isSelected ? '<span class="check">✓</span>' : ''}</div>`;
  }).join('');
  $$('.user-result').forEach((el) => el.addEventListener('click', () => toggleUserSelection(el.dataset.userId, users)));
}

function toggleUserSelection(userId, users) {
  const user = users.find((u) => u._id === userId);
  if (!user) return;
  const mode = state.newChat.mode;
  const isSelected = state.newChat.selected.some((s) => s._id === userId);
  if (isSelected) state.newChat.selected = state.newChat.selected.filter((s) => s._id !== userId);
  else { if (mode === '1a1') state.newChat.selected = [user]; else state.newChat.selected.push(user); }

  $$('.user-result').forEach((el) => {
    const uId = el.dataset.userId;
    const sel = state.newChat.selected.some((s) => s._id === uId);
    el.classList.toggle('selected', sel);
    const check = el.querySelector('.check');
    if (sel && !check) { const span = document.createElement('span'); span.className = 'check'; span.textContent = '✓'; el.appendChild(span); }
    else if (!sel && check) { check.remove(); }
  });
  renderSelectedUsers(); updateCreateButton();
}

function renderSelectedUsers() {
  const container = $('#selected-users');
  container.innerHTML = state.newChat.selected.map((u) => `<span class="chip">${esc(u.displayName || u.username)}<button data-remove-user="${u._id}" type="button">✕</button></span>`).join('');
  $$('[data-remove-user]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.removeUser;
      state.newChat.selected = state.newChat.selected.filter((s) => s._id !== id);
      renderSelectedUsers(); updateCreateButton();
      $$('.user-result').forEach((el) => {
        if (el.dataset.userId === id) { el.classList.remove('selected'); el.querySelector('.check')?.remove(); }
      });
    });
  });
}

function updateCreateButton() {
  const { mode, selected } = state.newChat;
  const groupName = $('#group-name')?.value.trim();
  $('#btn-create-chat').disabled = !((mode === '1a1' && selected.length === 1) || (mode === 'group' && selected.length >= 1 && groupName));
}

$('#group-name')?.addEventListener('input', updateCreateButton);

$('#btn-create-chat')?.addEventListener('click', async () => {
  const { mode, selected } = state.newChat;
  if (selected.length === 0) return;
  try {
    const body = { participantIds: selected.map((u) => u._id), isGroup: mode === 'group', name: mode === 'group' ? $('#group-name').value.trim() : undefined };
    const { chat, existed } = await api('/api/chats', { method: 'POST', body: JSON.stringify(body) });
    closeModal('modal-new-chat');
    if (!existed) { state.chats.unshift(chat); renderChatList(); }
    state.socket.emit('chat:join', { chatId: chat._id }); await openChat(chat._id);
    toast(existed ? 'Chat abierto' : 'Chat creado ✅');
  } catch (err) { toast(err.message, 'error'); }
});

function openProfileModal() {
  $('#profile-displayName').value = state.user.displayName || '';
  $('#profile-status').value = state.user.status || '';
  $('#profile-avatar').value = state.user.avatar || '';
  $('#modal-profile').classList.remove('hidden');
}

$('#profile-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const body = { displayName: $('#profile-displayName').value.trim(), status: $('#profile-status').value.trim(), avatar: $('#profile-avatar').value.trim() };
    const { user } = await api('/api/users/me', { method: 'PUT', body: JSON.stringify(body) });
    state.user = user; saveSession(); renderMe(); closeModal('modal-profile'); toast('Perfil actualizado ✅');
  } catch (err) { toast(err.message, 'error'); }
});

// =====================================================
// EVENTOS GLOBALES
// =====================================================
$('#btn-logout')?.addEventListener('click', logout);
$('#btn-new-chat')?.addEventListener('click', openNewChatModal);
$('#btn-profile')?.addEventListener('click', openProfileModal);
$('#btn-notifications')?.addEventListener('click', requestNotificationPermission);
$('#search-input')?.addEventListener('input', renderChatList);

$('#btn-back')?.addEventListener('click', () => {
  $('#chat-panel').classList.remove('open'); state.activeChat = null; renderChatList();
  $('#chat-view').classList.add('hidden'); $('#empty-state').classList.remove('hidden');
});

$('#btn-chat-info')?.addEventListener('click', () => {
  if (!state.activeChat) return;
  const c = state.activeChat;
  alert(c.isGroup ? `Grupo: ${c.name}\nParticipantes: ${c.participants.map((p) => p.displayName || p.username).join(', ')}` : `Usuario: ${chatTitle(c)}`);
});

$('#btn-emoji')?.addEventListener('click', () => { const input = $('#message-input'); input.value += '😊'; input.focus(); });

// =====================================================
// INICIO
// =====================================================
(async function init() {
  setupAuthTabs();
  enableEnterNavigation('#login-form');
  enableEnterNavigation('#register-form');

  if (restoreSession()) {
    try { const { user } = await api('/api/auth/me'); state.user = user; saveSession(); enterApp(); }
    catch { clearSession(); }
  }
})();