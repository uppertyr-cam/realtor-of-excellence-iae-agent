export function buildInboxHtml(): string {
  return `<!DOCTYPE html>
<html lang="en" style="height:100%;overflow:hidden;">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>IAE Inbox</title>
  <style>
    :root {
      --bg: #f3f1ea;
      --panel: #fcfaf5;
      --ink: #17211f;
      --muted: #65706c;
      --line: #d8d1c4;
      --accent: #0f766e;
      --accent-soft: #d7efe9;
      --danger: #9f1239;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: Georgia, "Times New Roman", serif;
      color: var(--ink);
      background:
        radial-gradient(circle at top left, rgba(15,118,110,0.11), transparent 28%),
        linear-gradient(180deg, #f7f5ef 0%, #ece7db 100%);
      height: 100vh;
      overflow: hidden;
    }
    .hidden { display: none !important; }
    .auth-shell, .app-shell {
      min-height: 100vh;
      display: flex;
      align-items: stretch;
    }
    .auth-shell {
      justify-content: center;
      align-items: center;
      padding: 32px;
    }
    .auth-card {
      width: min(440px, 100%);
      background: rgba(252,250,245,0.92);
      border: 1px solid rgba(216,209,196,0.8);
      box-shadow: 0 20px 50px rgba(23,33,31,0.12);
      border-radius: 24px;
      padding: 28px;
      backdrop-filter: blur(14px);
    }
    .eyebrow {
      font-family: Arial, sans-serif;
      letter-spacing: 0.22em;
      text-transform: uppercase;
      font-size: 11px;
      color: var(--accent);
      margin-bottom: 12px;
    }
    h1 {
      margin: 0 0 12px;
      font-size: 38px;
      line-height: 1;
      font-weight: 700;
    }
    p {
      margin: 0 0 18px;
      color: var(--muted);
      font-family: Arial, sans-serif;
      line-height: 1.6;
    }
    label {
      display: block;
      margin: 16px 0 8px;
      font-family: Arial, sans-serif;
      font-size: 13px;
      color: var(--muted);
    }
    input, button {
      width: 100%;
      border-radius: 14px;
      border: 1px solid var(--line);
      padding: 14px 16px;
      font-size: 15px;
    }
    input {
      background: #fff;
      color: var(--ink);
    }
    button {
      cursor: pointer;
      background: var(--accent);
      color: #fff;
      border: 0;
      font-weight: 700;
      margin-top: 18px;
    }
    .auth-error {
      color: var(--danger);
      font-family: Arial, sans-serif;
      font-size: 13px;
      min-height: 18px;
      margin-top: 10px;
    }
    .app-shell {
      flex-direction: column;
      height: 100vh;
      overflow: hidden;
      position: fixed;
      inset: 0;
    }
    .topbar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 18px 22px;
      border-bottom: 1px solid rgba(216,209,196,0.9);
      background: rgba(252,250,245,0.82);
      backdrop-filter: blur(12px);
    }
    .topbar h2 {
      margin: 0;
      font-size: 26px;
    }
    .topbar-meta {
      font-family: Arial, sans-serif;
      font-size: 13px;
      color: var(--muted);
    }
    .layout {
      display: grid;
      grid-template-columns: 360px 1fr;
      height: calc(100vh - 77px);
      overflow: hidden;
    }
    .sidebar {
      border-right: 1px solid rgba(216,209,196,0.9);
      background: rgba(252,250,245,0.74);
      display: flex;
      flex-direction: column;
      min-height: 0;
      overflow: hidden;
    }
    .sidebar-tools {
      padding: 18px;
      border-bottom: 1px solid rgba(216,209,196,0.9);
    }
    .sidebar-tools input {
      margin-bottom: 10px;
    }
    .filter-row {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      margin-top: 10px;
    }
    .filter-chip {
      width: auto;
      margin-top: 0;
      padding: 9px 12px;
      border-radius: 999px;
      background: transparent;
      color: var(--ink);
      border: 1px solid var(--line);
      font-family: Arial, sans-serif;
      font-size: 12px;
      font-weight: 700;
    }
    .filter-chip.active {
      background: var(--ink);
      border-color: var(--ink);
      color: #fff;
    }
    .ghost {
      background: transparent;
      color: var(--ink);
      border: 1px solid var(--line);
      margin-top: 0;
    }
    .list {
      overflow: auto;
      padding: 8px;
    }
    .conversation {
      padding: 14px;
      border-radius: 18px;
      border: 1px solid transparent;
      margin-bottom: 8px;
      cursor: pointer;
      background: transparent;
      transition: 0.18s ease;
    }
    .conversation:hover, .conversation.active {
      background: rgba(15,118,110,0.08);
      border-color: rgba(15,118,110,0.18);
    }
    .conversation-title {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 6px;
      font-size: 18px;
    }
    .pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      border-radius: 999px;
      padding: 4px 9px;
      background: var(--accent-soft);
      color: var(--accent);
      font-family: Arial, sans-serif;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.04em;
      text-transform: uppercase;
    }
    .conversation-subtitle, .conversation-preview {
      font-family: Arial, sans-serif;
      font-size: 13px;
      color: var(--muted);
      line-height: 1.5;
    }
    .conversation-preview {
      margin-top: 8px;
      color: #36413d;
    }
    .conversation.needs-attention .pill {
      background: #fde7c9;
      color: #8a4b00;
    }
    .thread-panel {
      display: flex;
      flex-direction: column;
      min-height: 0;
      overflow: hidden;
    }
    .thread-header {
      padding: 20px 24px 16px;
      border-bottom: 1px solid rgba(216,209,196,0.9);
      background: rgba(252,250,245,0.68);
    }
    .thread-header h3 {
      margin: 0 0 8px;
      font-size: 30px;
    }
    .thread-meta, .thread-empty {
      font-family: Arial, sans-serif;
      color: var(--muted);
      line-height: 1.6;
    }
    .thread-body {
      flex: 1;
      overflow: hidden;
      padding: 24px;
      display: grid;
      grid-template-columns: minmax(0, 1fr) 300px;
      gap: 22px;
      align-items: start;
    }
    .messages-column {
      min-height: 0;
      height: 100%;
      overflow: auto;
      padding-right: 4px;
      overscroll-behavior: contain;
    }
    .messages-stack {
      min-height: 100%;
      display: flex;
      flex-direction: column;
      justify-content: flex-end;
      gap: 16px;
      padding-bottom: 8px;
    }
    .workflow-panel {
      background: rgba(255,255,255,0.74);
      border: 1px solid rgba(216,209,196,0.9);
      border-radius: 22px;
      padding: 18px;
      box-shadow: 0 10px 28px rgba(23,33,31,0.06);
      position: sticky;
      top: 0;
    }
    .workflow-panel h4 {
      margin: 0 0 14px;
      font-size: 22px;
    }
    .workflow-row {
      margin-bottom: 14px;
      font-family: Arial, sans-serif;
    }
    .workflow-label {
      display: block;
      font-size: 11px;
      letter-spacing: 0.14em;
      text-transform: uppercase;
      color: var(--muted);
      margin-bottom: 5px;
    }
    .workflow-value {
      color: var(--ink);
      line-height: 1.5;
      font-size: 14px;
    }
    .workflow-alert {
      margin: 14px 0;
      padding: 11px 12px;
      border-radius: 14px;
      background: #fde7c9;
      color: #8a4b00;
      font-family: Arial, sans-serif;
      font-size: 13px;
      line-height: 1.5;
    }
    .message {
      max-width: 72%;
      border-radius: 20px;
      padding: 14px 16px;
      box-shadow: 0 10px 28px rgba(23,33,31,0.08);
    }
    .message.outbound {
      align-self: flex-end;
      background: #0f766e;
      color: #fff;
      border-bottom-right-radius: 6px;
    }
    .message.inbound {
      align-self: flex-start;
      background: rgba(255,255,255,0.9);
      border: 1px solid rgba(216,209,196,0.9);
      border-bottom-left-radius: 6px;
    }
    .message-meta {
      font-family: Arial, sans-serif;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      opacity: 0.82;
      margin-bottom: 8px;
    }
    .message-body {
      white-space: pre-wrap;
      word-break: break-word;
      font-family: Arial, sans-serif;
      line-height: 1.55;
      font-size: 14px;
    }
    .status-bar {
      padding: 10px 24px 16px;
      font-family: Arial, sans-serif;
      font-size: 12px;
      color: var(--muted);
    }
    @media (max-width: 920px) {
      .layout { grid-template-columns: 1fr; }
      .sidebar { min-height: 280px; max-height: 38vh; }
      .thread-body { grid-template-columns: 1fr; }
      .workflow-panel { position: static; order: -1; }
      .message { max-width: 92%; }
    }
  </style>
</head>
<body style="height:100%;overflow:hidden;">
  <div id="auth-shell" class="auth-shell hidden">
    <div class="auth-card">
      <div class="eyebrow">Internal Inbox</div>
      <h1>IAE Conversations</h1>
      <p>Sign in to view live lead conversations, AI replies, and delivery status updates.</p>
      <form id="login-form">
        <label for="email">Email</label>
        <input id="email" type="email" autocomplete="username" required />
        <label for="password">Password</label>
        <input id="password" type="password" autocomplete="current-password" required />
        <button type="submit">Sign In</button>
        <div id="auth-error" class="auth-error"></div>
      </form>
    </div>
  </div>

  <div id="app-shell" class="app-shell hidden">
    <div class="topbar">
      <div>
        <div class="eyebrow">Live View</div>
        <h2>Conversation Inbox</h2>
      </div>
      <div style="display:flex;align-items:center;gap:12px;">
        <div id="me" class="topbar-meta"></div>
        <button id="logout-btn" class="ghost" style="width:auto;padding:10px 16px;">Log Out</button>
      </div>
    </div>
    <div class="layout">
      <aside class="sidebar">
        <div class="sidebar-tools">
          <input id="search-input" type="search" placeholder="Search name, phone, client" />
          <button id="refresh-btn" class="ghost">Refresh</button>
          <div class="filter-row">
            <button class="filter-chip active" data-filter="all">All inbox</button>
            <button class="filter-chip" data-filter="unread">Unread</button>
            <button class="filter-chip" data-filter="read">Read</button>
          </div>
        </div>
        <div id="conversation-list" class="list"></div>
      </aside>
      <section class="thread-panel">
        <div id="thread-header" class="thread-header">
          <div class="thread-empty">Select a conversation to view the message timeline.</div>
        </div>
        <div id="thread-body" class="thread-body">
          <div class="thread-empty">No conversation selected.</div>
        </div>
        <div id="status-bar" class="status-bar">Disconnected</div>
      </section>
    </div>
  </div>

  <script>
    const state = {
      user: null,
      conversations: [],
      activeContactId: null,
      eventSource: null,
      search: '',
      filter: 'all',
      loadingThread: false,
      scrollProxyBound: false
    }

    function escapeHtml(value) {
      return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
    }

    function formatDate(value) {
      if (!value) return ''
      const date = new Date(value)
      return date.toLocaleString()
    }

    async function api(url, options) {
      const response = await fetch(url, Object.assign({
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' }
      }, options || {}))
      if (response.status === 401) throw new Error('unauthorised')
      if (!response.ok) {
        let message = 'Request failed'
        try {
          const body = await response.json()
          message = body.error || message
        } catch {}
        throw new Error(message)
      }
      const contentType = response.headers.get('content-type') || ''
      return contentType.includes('application/json') ? response.json() : response.text()
    }

    function showAuth() {
      document.getElementById('auth-shell').classList.remove('hidden')
      document.getElementById('app-shell').classList.add('hidden')
    }

    function showApp() {
      document.getElementById('auth-shell').classList.add('hidden')
      document.getElementById('app-shell').classList.remove('hidden')
      document.getElementById('me').textContent = state.user
        ? (state.user.display_name || state.user.email)
        : ''
    }

    function renderConversationList() {
      const root = document.getElementById('conversation-list')
      Array.from(document.querySelectorAll('.filter-chip')).forEach(function (node) {
        node.classList.toggle('active', node.getAttribute('data-filter') === state.filter)
      })
      if (!state.conversations.length) {
        root.innerHTML = '<div class="thread-empty" style="padding:18px;">No conversations found.</div>'
        return
      }
      root.innerHTML = state.conversations.map((item) => {
        const classes = ['conversation']
        if (item.contact_id === state.activeContactId) classes.push('active')
        if (item.needs_attention) classes.push('needs-attention')
        const agentStatus = item.agent_question_status === 'awaiting_agent_reply'
          ? '<div class="pill" style="background:#fde7c9;color:#8a4b00;">Waiting on agent</div>'
          : item.agent_question_status === 'agent_replied'
            ? '<div class="pill" style="background:#ddeefc;color:#0f4f8a;">Agent replied</div>'
            : ''
        return '<div class="' + classes.join(' ') + '" data-contact-id="' + escapeHtml(item.contact_id) + '">' +
          '<div class="conversation-title">' +
            '<div>' + escapeHtml(item.contact_name) + '</div>' +
            '<div style="display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end;">' +
              '<div class="pill">' + escapeHtml(item.channel || 'unknown') + '</div>' +
              agentStatus +
            '</div>' +
          '</div>' +
          '<div class="conversation-subtitle">' + escapeHtml(item.client_name) + ' • ' + escapeHtml(item.workflow_stage || 'unknown') + '</div>' +
          '<div class="conversation-preview">' + escapeHtml(item.last_message || 'No messages yet') + '</div>' +
          '<div class="conversation-subtitle" style="margin-top:8px;">' + escapeHtml(formatDate(item.last_message_at || item.updated_at)) + '</div>' +
        '</div>'
      }).join('')

      Array.from(root.querySelectorAll('.conversation')).forEach(function (node) {
        node.addEventListener('click', function () {
          const contactId = node.getAttribute('data-contact-id')
          if (contactId) openConversation(contactId)
        })
      })
    }

    function renderThread(detail) {
      const header = document.getElementById('thread-header')
      const body = document.getElementById('thread-body')
      const tags = (detail.contact.tags || []).join(', ')
      const agentState = (detail.contact.tags || []).includes('awaiting_agent_answer')
        ? 'Waiting on agent reply'
        : (detail.contact.tags || []).includes('awaiting_faq_approval')
          ? 'Agent replied, waiting on FAQ approval'
          : ''
      header.innerHTML =
        '<h3>' + escapeHtml(detail.contact.contact_name) + '</h3>' +
        '<div class="thread-meta">Conversation timeline</div>'

      if (!detail.messages.length) {
        body.innerHTML = '<div class="thread-empty">No messages recorded yet.</div>'
        return
      }

      const messagesHtml = detail.messages.map(function (message) {
        return '<div class="message ' + escapeHtml(message.direction) + '">' +
          '<div class="message-meta">' +
            escapeHtml(message.direction) + ' • ' +
            escapeHtml(message.channel || 'unknown') +
            (message.message_type ? ' • ' + escapeHtml(message.message_type) : '') +
            ' • ' + escapeHtml(formatDate(message.created_at)) +
          '</div>' +
          '<div class="message-body">' + escapeHtml(message.content) + '</div>' +
        '</div>'
      }).join('')

      const workflowHtml =
        '<aside class="workflow-panel">' +
          '<h4>Workflow</h4>' +
          '<div class="workflow-row"><span class="workflow-label">Client</span><div class="workflow-value">' + escapeHtml(detail.contact.contact_name) + '</div></div>' +
          '<div class="workflow-row"><span class="workflow-label">Company</span><div class="workflow-value">' + escapeHtml(detail.contact.client_name) + '</div></div>' +
          '<div class="workflow-row"><span class="workflow-label">Channel</span><div class="workflow-value">' + escapeHtml(detail.contact.channel || 'unknown') + '</div></div>' +
          '<div class="workflow-row"><span class="workflow-label">Tags</span><div class="workflow-value">' + escapeHtml(tags || 'None') + '</div></div>' +
          '<div class="workflow-row"><span class="workflow-label">Current workflow</span><div class="workflow-value">' + escapeHtml(detail.contact.workflow_status || detail.contact.workflow_stage || 'unknown') + '</div></div>' +
          '<div class="workflow-row"><span class="workflow-label">Current stage</span><div class="workflow-value">' + escapeHtml(detail.contact.workflow_stage || 'unknown') + '</div></div>' +
          '<div class="workflow-row"><span class="workflow-label">Next execution</span><div class="workflow-value">' + escapeHtml(detail.contact.next_action_label || 'No pending execution') + '</div></div>' +
          '<div class="workflow-row"><span class="workflow-label">Next due</span><div class="workflow-value">' + escapeHtml(formatDate(detail.contact.next_action_due) || '—') + '</div></div>' +
          '<div class="workflow-row"><span class="workflow-label">Delivery</span><div class="workflow-value">' + escapeHtml(detail.contact.last_delivery_status || 'n/a') + '</div></div>' +
          (agentState ? '<div class="workflow-row"><span class="workflow-label">Agent status</span><div class="workflow-value">' + escapeHtml(agentState) + '</div></div>' : '') +
          (detail.contact.pending_question ? '<div class="workflow-row"><span class="workflow-label">Pending question</span><div class="workflow-value">' + escapeHtml(detail.contact.pending_question) + '</div></div>' : '') +
          (detail.contact.pending_answer ? '<div class="workflow-row"><span class="workflow-label">Pending answer</span><div class="workflow-value">' + escapeHtml(detail.contact.pending_answer) + '</div></div>' : '') +
          (detail.contact.is_stuck ? '<div class="workflow-alert">This contact has a pending workflow step that is already overdue.</div>' : '') +
        '</aside>'

      body.innerHTML = '<div id="messages-column" class="messages-column"><div class="messages-stack">' + messagesHtml + '</div></div>' + workflowHtml
      const messagesNode = document.getElementById('messages-column')
      messagesNode.scrollTop = messagesNode.scrollHeight
      bindThreadScrollProxy()
    }

    function bindThreadScrollProxy() {
      if (state.scrollProxyBound) return
      const routeWheel = function (event) {
        const app = document.getElementById('app-shell')
        const auth = document.getElementById('auth-shell')
        if (!app || app.classList.contains('hidden') || !auth || !auth.classList.contains('hidden')) return

        const messagesNode = document.getElementById('messages-column')
        if (!messagesNode) return

        const target = event.target
        if (target && target.closest) {
          if (target.closest('#conversation-list')) {
            messagesNode.scrollTop += event.deltaY
            event.preventDefault()
            return
          }
          if (target.closest('#thread-header') || target.closest('.workflow-panel') || target.closest('.thread-body')) {
            messagesNode.scrollTop += event.deltaY
            event.preventDefault()
            return
          }
        }
      }

      document.addEventListener('wheel', routeWheel, { passive: false })
      state.scrollProxyBound = true
    }

    async function loadConversations() {
      const params = new URLSearchParams()
      if (state.search) params.set('q', state.search)
      if (state.filter && state.filter !== 'all') params.set('filter', state.filter)
      const q = params.toString() ? ('?' + params.toString()) : ''
      const data = await api('/inbox/api/conversations' + q)
      state.conversations = data.conversations || []
      renderConversationList()
      if (!state.activeContactId && state.conversations.length) {
        openConversation(state.conversations[0].contact_id)
      }
    }

    async function openConversation(contactId) {
      if (state.loadingThread) return
      state.loadingThread = true
      state.activeContactId = contactId
      renderConversationList()
      try {
        const detail = await api('/inbox/api/conversations/' + encodeURIComponent(contactId))
        renderThread(detail)
      } finally {
        state.loadingThread = false
      }
    }

    function connectEvents() {
      if (state.eventSource) state.eventSource.close()
      const status = document.getElementById('status-bar')
      const source = new EventSource('/inbox/api/events', { withCredentials: true })
      state.eventSource = source
      status.textContent = 'Live updates connected'

      source.onmessage = async function (event) {
        try {
          const payload = JSON.parse(event.data)
          if (!payload || payload.type === 'connected') return
          await loadConversations()
          if (state.activeContactId && (!payload.contactId || payload.contactId === state.activeContactId)) {
            await openConversation(state.activeContactId)
          }
        } catch (err) {
          console.error(err)
        }
      }

      source.onerror = function () {
        status.textContent = 'Live updates reconnecting...'
      }
      source.onopen = function () {
        status.textContent = 'Live updates connected'
      }
    }

    async function bootstrap() {
      bindThreadScrollProxy()
      try {
        const data = await api('/inbox/api/me')
        state.user = data.user
        showApp()
        await loadConversations()
        connectEvents()
      } catch (err) {
        showAuth()
      }
    }

    document.getElementById('login-form').addEventListener('submit', async function (event) {
      event.preventDefault()
      const errorNode = document.getElementById('auth-error')
      errorNode.textContent = ''
      try {
        const email = document.getElementById('email').value
        const password = document.getElementById('password').value
        const data = await api('/inbox/api/login', {
          method: 'POST',
          body: JSON.stringify({ email: email, password: password })
        })
        state.user = data.user
        showApp()
        await loadConversations()
        connectEvents()
      } catch (err) {
        errorNode.textContent = err.message === 'unauthorised' ? 'Invalid credentials.' : err.message
      }
    })

    document.getElementById('logout-btn').addEventListener('click', async function () {
      await api('/inbox/api/logout', { method: 'POST' })
      if (state.eventSource) state.eventSource.close()
      state.eventSource = null
      state.user = null
      state.activeContactId = null
      showAuth()
    })

    let searchTimer = null
    document.getElementById('search-input').addEventListener('input', function (event) {
      state.search = event.target.value.trim()
      clearTimeout(searchTimer)
      searchTimer = setTimeout(loadConversations, 180)
    })

    document.getElementById('refresh-btn').addEventListener('click', function () {
      loadConversations().then(function () {
        if (state.activeContactId) openConversation(state.activeContactId)
      })
    })

    Array.from(document.querySelectorAll('.filter-chip')).forEach(function (node) {
      node.addEventListener('click', function () {
        state.filter = node.getAttribute('data-filter') || 'all'
        loadConversations().then(function () {
          if (state.activeContactId) openConversation(state.activeContactId)
        })
      })
    })

    bootstrap()
  </script>
</body>
</html>`
}
