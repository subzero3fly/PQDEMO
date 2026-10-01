/**
 * chat-widget.js — VectorProb Support Chat
 *
 * Floating chat button + panel, injected entirely by this script (pages just
 * need one <script src="chat-widget.js"> tag). Replaces Smartsupp.
 *
 * chatId is always the participant's Firebase Auth uid:
 *   - signed-in users  → their real uid
 *   - guests           → an anonymous uid from auth.signInAnonymously()
 * This gives every visitor exactly one conversation thread at chats/{chatId},
 * readable/writable only by themselves or an admin (see firestore.rules).
 *
 * Requires firebase-config.js (db, auth) loaded first.
 */

(function () {

  var QUICK_REPLIES = {
    "How do I deposit?": "You can deposit via crypto from the Portfolio page. Go to Portfolio → Deposit → choose your coin, send funds, then submit the transaction reference for review.",
    "How long does KYC take?": "KYC is usually reviewed within 24 hours. You'll see your status update in the Account menu once it's done.",
    "I need help with my account": "Sure — please describe your issue and our team will get back to you shortly."
  };
  var GENERIC_AUTO_REPLY = "Thanks for reaching out. Our team will respond shortly.";

  var chatId       = null;
  var chatRef      = null;
  var msgsRef      = null;
  var chatCreated  = false;
  var msgsUnsub    = null;
  var chatUnsub    = null;
  var isOpen       = false;
  var hasMessages  = false;

  // ── Inject styles ────────────────────────────────────────────────────────
  var style = document.createElement('style');
  style.textContent = [
    '#vpChatBtn{position:fixed;bottom:84px;right:18px;width:56px;height:56px;border-radius:50%;background:#7c5cff;color:#fff;border:none;cursor:pointer;box-shadow:0 6px 20px rgba(124,92,255,.4);z-index:150;display:flex;align-items:center;justify-content:center;font-family:inherit;}',
    '@media(min-width:769px){#vpChatBtn{bottom:24px;}}',
    '#vpChatBtn svg{width:26px;height:26px;}',
    '#vpChatDot{position:absolute;top:4px;right:4px;width:12px;height:12px;border-radius:50%;background:#f2496b;border:2px solid #0a0b0f;display:none;}',
    '#vpChatPanel{position:fixed;bottom:0;right:0;left:0;max-width:380px;margin-left:auto;height:min(560px,80vh);background:#15171e;border:1px solid #262a35;border-radius:20px 20px 0 0;z-index:155;display:none;flex-direction:column;box-shadow:0 -8px 30px rgba(0,0,0,.45);font-family:"Inter","Segoe UI",system-ui,sans-serif;}',
    '@media(min-width:769px){#vpChatPanel{bottom:24px;right:24px;left:auto;border-radius:20px;}}',
    '#vpChatPanel.open{display:flex;}',
    '.vpc-head{display:flex;align-items:center;justify-content:space-between;padding:16px 18px;border-bottom:1px solid #262a35;flex-shrink:0;}',
    '.vpc-head-title{font-size:15px;font-weight:800;color:#fff;}',
    '.vpc-head-sub{font-size:11.5px;color:#9498a4;margin-top:2px;}',
    '.vpc-close{background:none;border:none;cursor:pointer;color:#9498a4;padding:4px;line-height:0;}',
    '.vpc-close svg{width:20px;height:20px;}',
    '.vpc-body{flex:1;overflow-y:auto;padding:16px 18px;display:flex;flex-direction:column;gap:10px;}',
    '.vpc-chips{display:flex;flex-direction:column;gap:8px;margin-top:6px;}',
    '.vpc-chip{text-align:left;padding:10px 14px;border-radius:12px;border:1px solid #262a35;background:#1b1e27;color:#e7e9ee;font-size:13px;cursor:pointer;font-family:inherit;}',
    '.vpc-chip:hover{border-color:#7c5cff;}',
    '.vpc-msg{max-width:80%;padding:9px 13px;border-radius:14px;font-size:13.5px;line-height:1.45;word-wrap:break-word;}',
    '.vpc-msg.user{align-self:flex-end;background:#7c5cff;color:#fff;border-bottom-right-radius:4px;}',
    '.vpc-msg.other{align-self:flex-start;background:#1b1e27;color:#e7e9ee;border-bottom-left-radius:4px;}',
    '.vpc-msg-label{font-size:10px;font-weight:700;color:#9498a4;margin-bottom:3px;display:block;}',
    '.vpc-foot{border-top:1px solid #262a35;padding:12px;display:flex;gap:8px;flex-shrink:0;}',
    '.vpc-input{flex:1;height:40px;padding:0 14px;border-radius:99px;background:#0a0b0f;border:1px solid #262a35;color:#fff;font-size:13.5px;font-family:inherit;outline:none;}',
    '.vpc-input:focus{border-color:#7c5cff;}',
    '.vpc-send{width:40px;height:40px;border-radius:50%;background:#7c5cff;border:none;color:#fff;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;}',
    '.vpc-send svg{width:18px;height:18px;}'
  ].join('');
  document.head.appendChild(style);

  // ── Inject DOM ───────────────────────────────────────────────────────────
  var btn = document.createElement('button');
  btn.id = 'vpChatBtn';
  btn.setAttribute('aria-label', 'Open support chat');
  btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg><span id="vpChatDot"></span>';
  document.body.appendChild(btn);

  var panel = document.createElement('div');
  panel.id = 'vpChatPanel';
  panel.innerHTML =
    '<div class="vpc-head">' +
      '<div><div class="vpc-head-title">VectorProb Support</div><div class="vpc-head-sub">We usually reply within a few hours</div></div>' +
      '<button class="vpc-close" id="vpChatCloseBtn" aria-label="Close chat"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg></button>' +
    '</div>' +
    '<div class="vpc-body" id="vpChatBody"></div>' +
    '<div class="vpc-foot">' +
      '<input type="text" class="vpc-input" id="vpChatInput" placeholder="Type a message…" />' +
      '<button class="vpc-send" id="vpChatSendBtn" aria-label="Send"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg></button>' +
    '</div>';
  document.body.appendChild(panel);

  function escapeHtml(s) {
    var d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  function renderChips() {
    var body = document.getElementById('vpChatBody');
    var wrap = document.createElement('div');
    wrap.className = 'vpc-chips';
    wrap.id = 'vpChatChips';
    Object.keys(QUICK_REPLIES).forEach(function(q) {
      var chip = document.createElement('button');
      chip.className = 'vpc-chip';
      chip.textContent = q;
      chip.onclick = function() { sendMessage(q, true); };
      wrap.appendChild(chip);
    });
    body.appendChild(wrap);
  }

  function removeChips() {
    var chips = document.getElementById('vpChatChips');
    if (chips) chips.remove();
  }

  function appendMessageEl(m) {
    var body = document.getElementById('vpChatBody');
    var el = document.createElement('div');
    var isUser = m.sender === 'user';
    el.className = 'vpc-msg ' + (isUser ? 'user' : 'other');
    var label = m.sender === 'admin' ? '<span class="vpc-msg-label">Support</span>' : m.sender === 'bot' ? '<span class="vpc-msg-label">VectorProb Bot</span>' : '';
    el.innerHTML = label + escapeHtml(m.text || '');
    body.appendChild(el);
    body.scrollTop = body.scrollHeight;
  }

  // ── Firestore wiring ─────────────────────────────────────────────────────
  // The chat doc listener (unread dot) is cheap and always on once we know who
  // the visitor is. The messages listener only attaches the first time the
  // panel is opened, so browsing pages never reads a whole thread.
  function detachAll() {
    if (msgsUnsub) { msgsUnsub(); msgsUnsub = null; }
    if (chatUnsub) { chatUnsub(); chatUnsub = null; }
    chatCreated = false;
    hasMessages = false;
  }

  function setIdentity(user) {
    if (!user) {
      detachAll();
      chatId = null; chatRef = null; msgsRef = null;
      var dot0 = document.getElementById('vpChatDot');
      if (dot0) dot0.style.display = 'none';
      document.getElementById('vpChatBody').innerHTML = '';
      return;
    }
    if (chatId === user.uid) return;
    detachAll();
    chatId  = user.uid;
    chatRef = db.collection('chats').doc(chatId);
    msgsRef = chatRef.collection('messages');
    if (user.isAnonymous) sessionStorage.setItem('vp_chat_guest_uid', user.uid);
    document.getElementById('vpChatBody').innerHTML = '';

    chatUnsub = chatRef.onSnapshot(function(snap) {
      var dot = document.getElementById('vpChatDot');
      var d = snap.exists ? snap.data() : null;
      if (d && d.unreadByUser) {
        if (isOpen) { chatRef.update({ unreadByUser: false }).catch(function(){}); dot.style.display = 'none'; }
        else dot.style.display = 'block';
      } else {
        dot.style.display = 'none';
      }
    }, function(e) { console.warn('[chat] chat doc listener error:', e.message); });

    if (isOpen) attachMessagesListener();
  }

  function attachMessagesListener() {
    if (msgsUnsub || !msgsRef) return;
    var body = document.getElementById('vpChatBody');
    msgsUnsub = msgsRef.orderBy('timestamp', 'desc').limit(60).onSnapshot(function(snap) {
      body.innerHTML = '';
      hasMessages = snap.docs.length > 0;
      snap.docs.slice().reverse().forEach(function(d) { appendMessageEl(d.data()); });
      renderChips(); // always available, not just before the first message
    }, function(e) { console.warn('[chat] messages listener error:', e.message); });
  }

  async function ensureChatDoc() {
    if (chatCreated || !chatRef) return;
    try {
      var snap = await chatRef.get();
      if (!snap.exists) {
        var user = auth.currentUser;
        var isAnon = !!(user && user.isAnonymous);
        var userName = 'Guest visitor', userEmail = '', accountId = '';
        if (user && !isAnon) {
          userName = user.displayName || user.email || 'User';
          userEmail = user.email || '';
          try {
            var uSnap = await db.collection('users').doc(user.uid).get();
            if (uSnap.exists) {
              userName  = uSnap.data().fullName  || userName;
              userEmail = uSnap.data().email     || userEmail;
              accountId = uSnap.data().accountId || '';
            }
          } catch(e) {}
        }
        await chatRef.set({
          userId:        user ? user.uid : null,
          userEmail:     userEmail,
          userName:      userName,
          accountId:     accountId,
          isGuest:       isAnon,
          originUrl:     window.location.href,
          status:        'open',
          createdAt:     firebase.firestore.FieldValue.serverTimestamp(),
          lastMessage:   '',
          lastMessageAt: firebase.firestore.FieldValue.serverTimestamp(),
          unreadByAdmin: false,
          unreadByUser:  false,
          unreadCount:   0
        });
      }
      chatCreated = true;
    } catch(e) { console.warn('[chat] ensureChatDoc failed:', e.message); }
  }

  async function sendMessage(text, isChip) {
    text = (text || '').trim();
    if (!text || !chatRef) return;
    var isFirstMessage = !hasMessages;
    document.getElementById('vpChatInput').value = '';
    removeChips();

    try {
      await ensureChatDoc();
      await msgsRef.add({ text: text, sender: 'user', timestamp: firebase.firestore.FieldValue.serverTimestamp(), read: false });
      await chatRef.update({
        lastMessage:   text,
        lastMessageAt: firebase.firestore.FieldValue.serverTimestamp(),
        unreadByAdmin: true,
        unreadCount:   firebase.firestore.FieldValue.increment(1),
        status:        'open'
      });

      // Bot answers a tapped chip, or acknowledges a custom FIRST message.
      // Later typed messages get no bot reply — a human is in the loop by then.
      var reply = null;
      if (isChip) reply = QUICK_REPLIES[text] || null;
      else if (isFirstMessage) reply = GENERIC_AUTO_REPLY;
      if (!reply) return;

      setTimeout(async function() {
        try {
          await msgsRef.add({ text: reply, sender: 'bot', timestamp: firebase.firestore.FieldValue.serverTimestamp(), read: false });
          await chatRef.update({
            lastMessage:   reply,
            lastMessageAt: firebase.firestore.FieldValue.serverTimestamp(),
            unreadByAdmin: true,
            unreadCount:   firebase.firestore.FieldValue.increment(1)
          });
        } catch(e) { console.warn('[chat] bot reply failed:', e.message); }
      }, isChip ? 1500 : 1800);
    } catch(e) { console.warn('[chat] sendMessage failed:', e.message); }
  }

  // ── Init ────────────────────────────────────────────────────────────────
  function init() {
    // Use the raw listener: firebase-config.js hides anonymous sessions from the
    // normal auth.onAuthStateChanged so page logic never mistakes a chatting
    // guest for a real account. The widget is the one thing that needs to see them.
    var onAuth = auth.onAuthStateChangedRaw || auth.onAuthStateChanged.bind(auth);
    onAuth(function(user) { setIdentity(user); });

    // Shared by the floating button and window.vpChat.open()/send()
    async function openPanel() {
      isOpen = true;
      panel.classList.add('open');
      document.getElementById('vpChatDot').style.display = 'none';

      if (!chatId) {
        try {
          var cred = await auth.signInAnonymously();
          setIdentity(cred.user);
        } catch(e) {
          console.warn('[chat] signInAnonymously failed:', e.message);
          document.getElementById('vpChatBody').innerHTML = '<p style="color:#9498a4;font-size:13px;">Chat is temporarily unavailable. Please try again shortly.</p>';
          return false;
        }
      }
      attachMessagesListener();
      chatRef.update({ unreadByUser: false }).catch(function(){});
      setTimeout(function(){ document.getElementById('vpChatInput').focus(); }, 50);
      return true;
    }
    btn.addEventListener('click', openPanel);

    // Small public API so other page features (footer "Support" link, the
    // bank-transfer deposit flow) can open the chat, optionally with a message.
    window.vpChat = {
      open: openPanel,
      send: async function(text) {
        var ok = await openPanel();
        if (!ok) return;
        await ensureChatDoc();
        try { hasMessages = !(await msgsRef.limit(1).get()).empty; } catch(e) {}
        await sendMessage(text, false);
      }
    };

    document.getElementById('vpChatCloseBtn').addEventListener('click', function() {
      isOpen = false;
      panel.classList.remove('open');
    });
    document.getElementById('vpChatSendBtn').addEventListener('click', function() {
      sendMessage(document.getElementById('vpChatInput').value, false);
    });
    document.getElementById('vpChatInput').addEventListener('keydown', function(e) {
      if (e.key === 'Enter') sendMessage(this.value, false);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
