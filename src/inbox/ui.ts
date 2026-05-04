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
    .topbar-nav {
      display: flex;
      gap: 8px;
      margin-top: 12px;
      flex-wrap: wrap;
    }
    .topbar-meta {
      font-family: Arial, sans-serif;
      font-size: 13px;
      color: var(--muted);
    }
    .layout {
      display: grid;
      grid-template-columns: 360px 1fr;
      grid-template-rows: 1fr;
      flex: 1;
      min-height: 0;
      overflow: hidden;
    }
    .sidebar {
      border-right: 1px solid rgba(216,209,196,0.9);
      background: rgba(252,250,245,0.74);
      display: flex;
      flex-direction: column;
      height: 100%;
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
    .ghost.active {
      background: var(--ink);
      border-color: var(--ink);
      color: #fff;
    }
    .list {
      overflow-y: scroll;
      -webkit-overflow-scrolling: touch;
      overscroll-behavior: contain;
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
    .email-row {
      padding: 14px;
      border-radius: 18px;
      border: 1px solid transparent;
      margin-bottom: 8px;
      cursor: pointer;
      transition: 0.18s ease;
    }
    .email-row:hover, .email-row.active {
      background: rgba(15,118,110,0.08);
      border-color: rgba(15,118,110,0.18);
    }
    .email-subject {
      font-size: 16px;
      line-height: 1.4;
      margin-bottom: 6px;
    }
    .email-meta {
      font-family: Arial, sans-serif;
      font-size: 12px;
      color: var(--muted);
      line-height: 1.6;
    }
    .email-detail {
      display: flex;
      flex-direction: column;
      min-height: 0;
      gap: 16px;
    }
    .email-card {
      background: rgba(255,255,255,0.84);
      border: 1px solid rgba(216,209,196,0.9);
      border-radius: 22px;
      padding: 20px 22px;
      box-shadow: 0 10px 28px rgba(23,33,31,0.06);
    }
    .email-card h3 {
      margin: 0 0 10px;
      font-size: 28px;
    }
    .email-body-frame {
      width: 100%;
      min-height: 720px;
      border: 1px solid rgba(216,209,196,0.9);
      border-radius: 18px;
      background: #fff;
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
      overflow: auto;
      padding: 24px;
      display: grid;
      grid-template-columns: minmax(0, 1fr) 300px;
      gap: 22px;
      align-items: start;
    }
    .messages-column {
      min-height: 0;
      height: 100%;
      display: flex;
      flex-direction: column;
      gap: 14px;
    }
    .messages-scroll {
      flex: 1;
      min-height: 0;
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
    .composer {
      border-top: 1px solid rgba(216,209,196,0.9);
      padding-top: 14px;
      display: grid;
      gap: 10px;
      background: rgba(243,241,234,0.88);
      backdrop-filter: blur(8px);
    }
    .composer.locked {
      opacity: 0.8;
    }
    .composer textarea {
      width: 100%;
      min-height: 92px;
      border-radius: 18px;
      border: 1px solid var(--line);
      padding: 14px 16px;
      font-size: 14px;
      font-family: Arial, sans-serif;
      line-height: 1.5;
      resize: vertical;
      background: #fff;
      color: var(--ink);
    }
    .composer-row {
      display: flex;
      justify-content: space-between;
      gap: 10px;
      align-items: center;
      flex-wrap: wrap;
    }
    .composer-row button {
      width: auto;
      margin-top: 0;
      padding: 12px 18px;
      border-radius: 14px;
    }
    .composer-row button:disabled,
    .composer textarea:disabled {
      opacity: 0.55;
      cursor: not-allowed;
    }
    .composer-row label {
      margin: 0;
      display: inline-flex;
      gap: 8px;
      align-items: center;
      font-size: 12px;
      font-family: Arial, sans-serif;
      color: var(--muted);
    }
    .composer-row input[type="checkbox"] {
      width: auto;
      padding: 0;
      margin: 0;
    }
    .workflow-panel {
      background: rgba(255,255,255,0.74);
      border: 1px solid rgba(216,209,196,0.9);
      border-radius: 22px;
      padding: 18px;
      box-shadow: 0 10px 28px rgba(23,33,31,0.06);
      position: sticky;
      top: 0;
      max-height: calc(100vh - 150px);
      overflow: auto;
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
    .workflow-actions {
      margin-top: 18px;
      padding-top: 16px;
      border-top: 1px solid rgba(216,209,196,0.9);
      display: grid;
      gap: 12px;
    }
    .workflow-actions h5 {
      margin: 0;
      font-size: 15px;
      font-family: Arial, sans-serif;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--muted);
    }
    .action-group {
      display: grid;
      gap: 8px;
    }
    .action-group textarea,
    .action-group input[type="text"] {
      width: 100%;
      border-radius: 14px;
      border: 1px solid var(--line);
      padding: 12px 14px;
      font-size: 14px;
      font-family: Arial, sans-serif;
      background: #fff;
      color: var(--ink);
    }
    .action-group textarea {
      min-height: 104px;
      resize: vertical;
    }
    .action-row {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      align-items: center;
    }
    .action-row button {
      width: auto;
      margin-top: 0;
      padding: 10px 14px;
      font-size: 13px;
      border-radius: 12px;
    }
    .action-row label {
      margin: 0;
      display: inline-flex;
      gap: 8px;
      align-items: center;
      font-size: 12px;
    }
    .action-row input[type="checkbox"] {
      width: auto;
      padding: 0;
      margin: 0;
    }
    .action-note {
      font-family: Arial, sans-serif;
      font-size: 12px;
      color: var(--muted);
      line-height: 1.5;
    }
    .action-feedback {
      min-height: 18px;
      font-family: Arial, sans-serif;
      font-size: 12px;
      color: var(--muted);
    }
    .action-feedback.error {
      color: var(--danger);
    }
    .window-warning {
      padding: 12px 14px;
      border-radius: 14px;
      background: #fde7c9;
      color: #8a4b00;
      font-family: Arial, sans-serif;
      font-size: 13px;
      line-height: 1.5;
      border: 1px solid rgba(138,75,0,0.12);
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
        <div class="topbar-nav">
          <button id="view-conversations-btn" class="ghost" style="width:auto;padding:10px 14px;">Conversations</button>
          <button id="view-emails-btn" class="ghost" style="width:auto;padding:10px 14px;">Email inbox</button>
        </div>
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
            <button class="filter-chip active" data-filter="all" data-label="All inbox">All inbox</button>
            <button class="filter-chip" data-filter="unread" data-label="Unread">Unread</button>
            <button class="filter-chip" data-filter="read" data-label="Read">Read</button>
            <button class="filter-chip" data-filter="not_sent" data-label="Not sent yet">Not sent yet</button>
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
    function sizeSidebarList() {
      const sidebar = document.querySelector('.sidebar')
      const tools = document.querySelector('.sidebar-tools')
      const list = document.getElementById('conversation-list')
      if (!sidebar || !tools || !list) return
      list.style.height = (sidebar.clientHeight - tools.clientHeight) + 'px'
    }
    window.addEventListener('resize', sizeSidebarList)

    const state = {
      user: null,
      view: 'conversations',
      conversations: [],
      counts: { all_count: 0, unread_count: 0, read_count: 0, not_sent_count: 0 },
      emails: [],
      activeEmailId: null,
      activeContactId: null,
      activeDetail: null,
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

    function formatCountdown(value) {
      if (!value) return ''
      const diff = new Date(value).getTime() - Date.now()
      if (diff < 0) return 'overdue'
      const mins = Math.floor(diff / 60000)
      if (mins < 60) return mins + 'm'
      const hrs = Math.floor(mins / 60)
      if (hrs < 24) return hrs + 'h ' + (mins % 60) + 'm'
      const days = Math.floor(hrs / 24)
      return days + 'd ' + (hrs % 24) + 'h'
    }

    setInterval(function () {
      document.querySelectorAll('.countdown[data-due]').forEach(function (el) {
        el.textContent = formatCountdown(el.getAttribute('data-due'))
        el.style.color = el.textContent === 'overdue' ? '#9f1239' : '#65706c'
      })
    }, 30000)

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
      requestAnimationFrame(sizeSidebarList)
    }

    function renderConversationList() {
      if (state.view !== 'conversations') return
      const root = document.getElementById('conversation-list')
      Array.from(document.querySelectorAll('.filter-chip')).forEach(function (node) {
        node.classList.toggle('active', node.getAttribute('data-filter') === state.filter)
      })
      const countLabels = {
        all: state.counts.all_count || 0,
        unread: state.counts.unread_count || 0,
        read: state.counts.read_count || 0,
        not_sent: state.counts.not_sent_count || 0
      }
      Array.from(document.querySelectorAll('.filter-chip')).forEach(function (node) {
        const filter = node.getAttribute('data-filter') || 'all'
        const baseLabel = node.getAttribute('data-label') || node.textContent || ''
        node.textContent = baseLabel + ' (' + (countLabels[filter] || 0) + ')'
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
          '<div class="conversation-subtitle" style="margin-top:8px;display:flex;justify-content:space-between;align-items:center;">' +
            '<span>' + escapeHtml(formatDate(item.last_message_at || item.updated_at)) + '</span>' +
            (item.next_action_due
              ? (item.next_action_type === 'first_message'
                ? '<span style="font-family:Arial,sans-serif;font-size:11px;font-weight:700;letter-spacing:0.04em;text-transform:uppercase;color:#65706c;">Queued · First message</span>'
                : '<span style="font-family:Arial,sans-serif;font-size:11px;font-weight:700;letter-spacing:0.04em;text-transform:uppercase;color:' + (new Date(item.next_action_due).getTime() < Date.now() ? '#9f1239' : '#65706c') + ';" class="countdown" data-due="' + escapeHtml(item.next_action_due) + '">' + formatCountdown(item.next_action_due) + ' · ' + escapeHtml(item.next_action_label || '') + '</span>')
              : '<span style="font-family:Arial,sans-serif;font-size:11px;color:#65706c;">idle</span>') +
          '</div>' +
        '</div>'
      }).join('')

      Array.from(root.querySelectorAll('.conversation')).forEach(function (node) {
        node.addEventListener('click', function () {
          const contactId = node.getAttribute('data-contact-id')
          if (contactId) openConversation(contactId)
        })
      })
    }

    function renderEmailList() {
      if (state.view !== 'emails') return
      const root = document.getElementById('conversation-list')
      Array.from(document.querySelectorAll('.filter-chip')).forEach(function (node) {
        node.classList.remove('active')
      })
      if (!state.emails.length) {
        state.activeEmailId = null
        root.innerHTML = '<div class="thread-empty" style="padding:18px;">No project emails found.</div>'
        renderEmailEmpty()
        return
      }
      root.innerHTML = state.emails.map(function (item) {
        const classes = ['email-row']
        if (String(item.id) === String(state.activeEmailId)) classes.push('active')
        return '<div class="' + classes.join(' ') + '" data-email-id="' + escapeHtml(item.id) + '">' +
          '<div class="email-subject">' + escapeHtml(item.subject) + '</div>' +
          '<div class="email-meta">' + escapeHtml(item.category || 'email') + ' • ' + escapeHtml(item.send_status || 'sent') + '</div>' +
          '<div class="email-meta">To: ' + escapeHtml(item.recipient_to || '—') + '</div>' +
          '<div class="email-meta">' + escapeHtml(formatDate(item.created_at)) + '</div>' +
        '</div>'
      }).join('')

      Array.from(root.querySelectorAll('.email-row')).forEach(function (node) {
        node.addEventListener('click', function () {
          const emailId = node.getAttribute('data-email-id')
          if (emailId) openEmail(emailId)
        })
      })
    }

    function renderThread(detail) {
      if (state.view !== 'conversations') return
      state.activeDetail = detail
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

      const automationPaused = detail.contact.automation_state === 'paused'
      const whatsappWindowClosed = detail.contact.channel === 'whatsapp' && !detail.contact.whatsapp_window_open
      const whatsappWindowMessage = whatsappWindowClosed
        ? '<div class="window-warning">WhatsApp freeform replies only work within 24 hours of the lead\\'s last message.' +
          (detail.contact.whatsapp_last_inbound_at ? ' Last inbound: ' + escapeHtml(formatDate(detail.contact.whatsapp_last_inbound_at)) + '.' : ' No inbound WhatsApp message is recorded for this thread.') +
          '</div>'
        : ''
      const pendingAiReply = detail.contact.pending_ai_response_text
        ? '<div class="action-group">' +
            '<h5>Pending AI reply</h5>' +
            '<textarea id="pending-ai-input" placeholder="Edit AI reply before sending...">' + escapeHtml(detail.contact.pending_ai_response_text) + '</textarea>' +
            '<div class="action-row">' +
              '<button id="approve-ai-btn" type="button">Approve and Send</button>' +
            '</div>' +
            '<div class="action-note">This sends the latest pending AI draft after applying any edits above.</div>' +
          '</div>'
        : ''

      const workflowHtml =
        '<aside class="workflow-panel">' +
          '<h4>Workflow</h4>' +
          '<div class="workflow-row"><span class="workflow-label">Client</span><div class="workflow-value">' + escapeHtml(detail.contact.contact_name) + '</div></div>' +
          '<div class="workflow-row"><span class="workflow-label">Company</span><div class="workflow-value">' + escapeHtml(detail.contact.client_name) + '</div></div>' +
          '<div class="workflow-row"><span class="workflow-label">Channel</span><div class="workflow-value">' + escapeHtml(detail.contact.channel || 'unknown') + '</div></div>' +
          '<div class="workflow-row"><span class="workflow-label">Tags</span><div class="workflow-value">' + escapeHtml(tags || 'None') + '</div></div>' +
          '<div class="workflow-row"><span class="workflow-label">Current workflow</span><div class="workflow-value">' + escapeHtml(detail.contact.workflow_status || detail.contact.workflow_stage || 'unknown') + '</div></div>' +
          '<div class="workflow-row"><span class="workflow-label">Current stage</span><div class="workflow-value">' + escapeHtml(detail.contact.workflow_stage || 'unknown') + '</div></div>' +
          '<div class="workflow-row"><span class="workflow-label">Assigned to</span><div class="workflow-value">' + escapeHtml(detail.contact.assigned_to || 'Unassigned') + '</div></div>' +
          '<div class="workflow-row"><span class="workflow-label">Automation</span><div class="workflow-value">' + escapeHtml(detail.contact.automation_state || 'idle') + '</div></div>' +
          '<div class="workflow-row"><span class="workflow-label">Next execution</span><div class="workflow-value">' + escapeHtml(detail.contact.next_action_label || 'No pending execution') + '</div></div>' +
          '<div class="workflow-row"><span class="workflow-label">Next due</span><div class="workflow-value">' + escapeHtml(formatDate(detail.contact.next_action_due) || '—') + '</div></div>' +
          '<div class="workflow-row"><span class="workflow-label">Delivery</span><div class="workflow-value">' + escapeHtml(detail.contact.last_delivery_status || 'n/a') + '</div></div>' +
          (agentState ? '<div class="workflow-row"><span class="workflow-label">Agent status</span><div class="workflow-value">' + escapeHtml(agentState) + '</div></div>' : '') +
          (detail.contact.pending_question ? '<div class="workflow-row"><span class="workflow-label">Pending question</span><div class="workflow-value">' + escapeHtml(detail.contact.pending_question) + '</div></div>' : '') +
          (detail.contact.pending_answer ? '<div class="workflow-row"><span class="workflow-label">Pending answer</span><div class="workflow-value">' + escapeHtml(detail.contact.pending_answer) + '</div></div>' : '') +
          (detail.contact.is_stuck ? '<div class="workflow-alert">This contact has a pending workflow step that is already overdue.</div>' : '') +
          '<div class="workflow-actions">' +
            '<div class="action-group">' +
              '<h5>CRM assigned agent</h5>' +
              '<input id="assigned-to-input" type="text" value="' + escapeHtml(detail.contact.assigned_to || '') + '" placeholder="Syncs with CRM assigned agent" />' +
              '<div class="action-row">' +
                '<button id="save-assignment-btn" type="button" class="ghost">Save Assignment</button>' +
                '<button id="clear-assignment-btn" type="button" class="ghost">Clear</button>' +
              '</div>' +
            '</div>' +
            pendingAiReply +
            '<div class="action-group">' +
              '<h5>Workflow</h5>' +
              '<div class="action-row">' +
                '<button id="toggle-automation-btn" type="button" class="ghost">' + (automationPaused ? 'Resume Automation' : 'Pause Automation') + '</button>' +
                '<button id="resolve-conversation-btn" type="button" class="ghost">Mark Resolved</button>' +
              '</div>' +
            '</div>' +
            '<div class="action-group">' +
              '<h5>Danger zone</h5>' +
              '<button id="delete-contact-btn" type="button" class="ghost" style="border-color:#9f1239;color:#9f1239;">Delete Contact</button>' +
            '</div>' +
          '</div>' +
        '</aside>'

      const composerHtml =
        '<div class="composer' + (whatsappWindowClosed ? ' locked' : '') + '">' +
          whatsappWindowMessage +
          '<textarea id="manual-reply-input" placeholder="Type a WhatsApp-style reply..."' + (whatsappWindowClosed ? ' disabled' : '') + '></textarea>' +
          '<div class="composer-row">' +
            '<label><input id="pause-after-send" type="checkbox" /> Pause automation after send</label>' +
            '<button id="send-reply-btn" type="button"' + (whatsappWindowClosed ? ' disabled' : '') + '>Send Reply</button>' +
          '</div>' +
          '<div id="action-feedback" class="action-feedback"></div>' +
        '</div>'

      body.innerHTML = '<div id="messages-column" class="messages-column"><div id="messages-scroll" class="messages-scroll"><div class="messages-stack">' + (messagesHtml || '<div class="thread-empty">No messages recorded yet.</div>') + '</div></div>' + composerHtml + '</div>' + workflowHtml
      const messagesNode = document.getElementById('messages-scroll')
      messagesNode.scrollTop = messagesNode.scrollHeight
      bindThreadScrollProxy()
      bindThreadActions(detail)
    }

    function renderEmailDetail(detail) {
      const header = document.getElementById('thread-header')
      const body = document.getElementById('thread-body')
      header.innerHTML =
        '<h3>' + escapeHtml(detail.subject || 'Project email') + '</h3>' +
        '<div class="thread-meta">' + escapeHtml(detail.category || 'email') + ' • ' + escapeHtml(formatDate(detail.created_at)) + '</div>'

      body.innerHTML =
        '<div class="email-detail">' +
          '<div class="email-card">' +
            '<div class="workflow-row"><span class="workflow-label">To</span><div class="workflow-value">' + escapeHtml(detail.recipient_to || '—') + '</div></div>' +
            '<div class="workflow-row"><span class="workflow-label">Cc</span><div class="workflow-value">' + escapeHtml(detail.recipient_cc || '—') + '</div></div>' +
            '<div class="workflow-row"><span class="workflow-label">Category</span><div class="workflow-value">' + escapeHtml(detail.category || 'email') + '</div></div>' +
            '<div class="workflow-row"><span class="workflow-label">Status</span><div class="workflow-value">' + escapeHtml(detail.send_status || 'sent') + '</div></div>' +
            '<div class="workflow-row"><span class="workflow-label">Lead</span><div class="workflow-value">' + escapeHtml(detail.contact_name || 'Project-level email') + '</div></div>' +
            '<div class="workflow-row"><span class="workflow-label">Client</span><div class="workflow-value">' + escapeHtml(detail.client_name || '—') + '</div></div>' +
            (detail.error ? '<div class="workflow-alert">Email error: ' + escapeHtml(detail.error) + '</div>' : '') +
          '</div>' +
          '<iframe id="email-body-frame" class="email-body-frame" sandbox=""></iframe>' +
        '</div>'

      const frame = document.getElementById('email-body-frame')
      if (frame) frame.srcdoc = detail.html_body || '<div style="font-family:Arial,sans-serif;padding:20px;">No stored email body.</div>'
    }

    function renderEmailEmpty() {
      const header = document.getElementById('thread-header')
      const body = document.getElementById('thread-body')
      header.innerHTML =
        '<h3>Email Inbox</h3>' +
        '<div class="thread-meta">Project emails sent by the system</div>'
      body.innerHTML = '<div class="thread-empty">No project emails have been logged yet.</div>'
    }

    function updateViewButtons() {
      const convoBtn = document.getElementById('view-conversations-btn')
      const emailBtn = document.getElementById('view-emails-btn')
      if (convoBtn) convoBtn.classList.toggle('active', state.view === 'conversations')
      if (emailBtn) emailBtn.classList.toggle('active', state.view === 'emails')
    }

    function setActionFeedback(message, isError) {
      const node = document.getElementById('action-feedback')
      if (!node) return
      node.textContent = message || ''
      node.classList.toggle('error', Boolean(isError))
    }

    async function refreshActiveConversation() {
      await loadConversations()
      if (state.activeContactId) {
        await openConversation(state.activeContactId)
      }
    }

    async function loadEmails() {
      const params = new URLSearchParams()
      if (state.search) params.set('q', state.search)
      const q = params.toString() ? ('?' + params.toString()) : ''
      renderEmailEmpty()
      const data = await api('/inbox/api/emails' + q)
      state.emails = data.emails || []
      renderEmailList()
      if (!state.activeEmailId && state.emails.length) {
        openEmail(state.emails[0].id)
      }
    }

    function openEmail(emailId) {
      state.activeEmailId = String(emailId)
      renderEmailList()
      const email = state.emails.find(function (item) { return String(item.id) === String(emailId) })
      if (email) renderEmailDetail(email)
    }

    async function switchView(view) {
      state.view = view
      updateViewButtons()
      if (view === 'emails') {
        state.activeContactId = null
        renderEmailEmpty()
        await loadEmails()
      } else {
        state.activeEmailId = null
        await loadConversations()
        if (state.activeContactId) await openConversation(state.activeContactId)
      }
    }

    function bindThreadActions(detail) {
      const replyBtn = document.getElementById('send-reply-btn')
      if (replyBtn) {
        replyBtn.addEventListener('click', async function () {
          const input = document.getElementById('manual-reply-input')
          const pauseCheckbox = document.getElementById('pause-after-send')
          setActionFeedback('')
          try {
            await api('/inbox/api/conversations/' + encodeURIComponent(detail.contact.contact_id) + '/reply', {
              method: 'POST',
              body: JSON.stringify({
                message: input.value,
                pauseAutomationAfterSend: Boolean(pauseCheckbox && pauseCheckbox.checked)
              })
            })
            input.value = ''
            if (pauseCheckbox) pauseCheckbox.checked = false
            setActionFeedback('Manual reply sent.')
            await refreshActiveConversation()
          } catch (err) {
            setActionFeedback(err.message, true)
          }
        })
      }

      const approveBtn = document.getElementById('approve-ai-btn')
      if (approveBtn) {
        approveBtn.addEventListener('click', async function () {
          const input = document.getElementById('pending-ai-input')
          setActionFeedback('')
          try {
            await api('/inbox/api/conversations/' + encodeURIComponent(detail.contact.contact_id) + '/approve-ai', {
              method: 'POST',
              body: JSON.stringify({ message: input.value })
            })
            setActionFeedback('AI reply approved and sent.')
            await refreshActiveConversation()
          } catch (err) {
            setActionFeedback(err.message, true)
          }
        })
      }

      const resolveBtn = document.getElementById('resolve-conversation-btn')
      if (resolveBtn) {
        resolveBtn.addEventListener('click', async function () {
          setActionFeedback('')
          try {
            await api('/inbox/api/conversations/' + encodeURIComponent(detail.contact.contact_id) + '/resolve', {
              method: 'POST',
              body: JSON.stringify({})
            })
            setActionFeedback('Conversation marked resolved.')
            await refreshActiveConversation()
          } catch (err) {
            setActionFeedback(err.message, true)
          }
        })
      }

      const toggleAutomationBtn = document.getElementById('toggle-automation-btn')
      if (toggleAutomationBtn) {
        toggleAutomationBtn.addEventListener('click', async function () {
          setActionFeedback('')
          try {
            await api('/inbox/api/conversations/' + encodeURIComponent(detail.contact.contact_id) + '/automation', {
              method: 'POST',
              body: JSON.stringify({ paused: detail.contact.automation_state !== 'paused' })
            })
            setActionFeedback(detail.contact.automation_state === 'paused' ? 'Automation resumed.' : 'Automation paused.')
            await refreshActiveConversation()
          } catch (err) {
            setActionFeedback(err.message, true)
          }
        })
      }

      const saveAssignmentBtn = document.getElementById('save-assignment-btn')
      if (saveAssignmentBtn) {
        saveAssignmentBtn.addEventListener('click', async function () {
          const input = document.getElementById('assigned-to-input')
          setActionFeedback('')
          try {
            await api('/inbox/api/conversations/' + encodeURIComponent(detail.contact.contact_id) + '/assign', {
              method: 'POST',
              body: JSON.stringify({ assignedTo: input.value })
            })
            setActionFeedback('Assignment updated.')
            await refreshActiveConversation()
          } catch (err) {
            setActionFeedback(err.message, true)
          }
        })
      }

      const clearAssignmentBtn = document.getElementById('clear-assignment-btn')
      if (clearAssignmentBtn) {
        clearAssignmentBtn.addEventListener('click', async function () {
          const input = document.getElementById('assigned-to-input')
          setActionFeedback('')
          try {
            await api('/inbox/api/conversations/' + encodeURIComponent(detail.contact.contact_id) + '/assign', {
              method: 'POST',
              body: JSON.stringify({ assignedTo: '' })
            })
            if (input) input.value = ''
            setActionFeedback('Assignment cleared.')
            await refreshActiveConversation()
          } catch (err) {
            setActionFeedback(err.message, true)
          }
        })
      }

      const deleteContactBtn = document.getElementById('delete-contact-btn')
      if (deleteContactBtn) {
        deleteContactBtn.addEventListener('click', async function () {
          setActionFeedback('Checking for other numbers...')
          let phonesData = { current: '', phones: [] }
          try {
            phonesData = await api('/inbox/api/conversations/' + encodeURIComponent(detail.contact.contact_id) + '/phones', {})
          } catch {}

          if (phonesData.phones && phonesData.phones.length > 0) {
            const options = phonesData.phones.map(function (p, i) { return (i + 1) + '. ' + p }).join('\\n')
            const choice = prompt(
              'Other numbers found for this contact:\\n\\n' + options +
              '\\n\\nEnter a number from the list to retry with it, or leave blank to delete the contact.',
              ''
            )
            setActionFeedback('')
            if (choice === null) return
            const picked = phonesData.phones.find(function (p, i) { return choice.trim() === String(i + 1) || choice.trim() === p })
            if (picked) {
              try {
                await api('/inbox/api/conversations/' + encodeURIComponent(detail.contact.contact_id) + '/use-phone', {
                  method: 'POST',
                  body: JSON.stringify({ phone: picked })
                })
                setActionFeedback('Switched to ' + picked + ' — first message re-queued.')
                await refreshActiveConversation()
                await loadConversations()
              } catch (err) {
                setActionFeedback('Failed: ' + err.message, true)
              }
              return
            }
          } else {
            setActionFeedback('')
            const action = confirm(
              'No other numbers found in the CRM for this contact.\\n\\n' +
              'OK = Mark as no valid number & notify agent\\n' +
              'Cancel = Do nothing'
            )
            if (!action) return
            try {
              await api('/inbox/api/conversations/' + encodeURIComponent(detail.contact.contact_id) + '/mark-no-number', { method: 'POST' })
              setActionFeedback('Marked as no valid number. Agent notified.')
              await refreshActiveConversation()
              await loadConversations()
            } catch (err) {
              setActionFeedback('Failed: ' + err.message, true)
            }
            return
          }

          if (!confirm('Delete this contact permanently? This cannot be undone.')) return
          try {
            await api('/inbox/api/conversations/' + encodeURIComponent(detail.contact.contact_id), { method: 'DELETE' })
            state.activeContactId = null
            state.activeDetail = null
            document.getElementById('thread-header').innerHTML = '<div class="thread-empty">Select a conversation to view the message timeline.</div>'
            document.getElementById('thread-body').innerHTML = '<div class="thread-empty">No conversation selected.</div>'
            await loadConversations()
          } catch (err) {
            setActionFeedback('Failed to delete: ' + err.message, true)
          }
        })
      }
    }

    function bindThreadScrollProxy() {
      if (state.scrollProxyBound) return
      const routeWheel = function (event) {
        const app = document.getElementById('app-shell')
        const auth = document.getElementById('auth-shell')
        if (!app || app.classList.contains('hidden') || !auth || !auth.classList.contains('hidden')) return

        const messagesNode = document.getElementById('messages-scroll')
        if (!messagesNode) return

        const target = event.target
        if (target && target.closest) {
          if (target.closest('#conversation-list') || target.closest('.workflow-panel')) {
            return
          }
          if (target.closest('#thread-header') || target.closest('.thread-body')) {
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
      state.counts = data.counts || state.counts
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
        updateViewButtons()
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
      state.view = 'conversations'
      state.activeContactId = null
      state.activeEmailId = null
      showAuth()
    })

    let searchTimer = null
    document.getElementById('search-input').addEventListener('input', function (event) {
      state.search = event.target.value.trim()
      clearTimeout(searchTimer)
      searchTimer = setTimeout(function () {
        if (state.view === 'emails') return loadEmails()
        return loadConversations()
      }, 180)
    })

    document.getElementById('refresh-btn').addEventListener('click', function () {
      if (state.view === 'emails') {
        loadEmails().then(function () {
          if (state.activeEmailId) openEmail(state.activeEmailId)
        })
        return
      }
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

    document.getElementById('view-conversations-btn').addEventListener('click', function () {
      switchView('conversations')
    })

    document.getElementById('view-emails-btn').addEventListener('click', function () {
      switchView('emails')
    })

    bootstrap()
  </script>
</body>
</html>`
}
