import { useEffect, useRef, useState } from 'react'
import {
  ArrowRight,
  CalendarDays,
  Check,
  ChevronDown,
  Copy,
  FileText,
  LayoutDashboard,
  LockKeyhole,
  LogOut,
  Mail,
  MessageSquareText,
  MicOff,
  Moon,
  MonitorUp,
  Paperclip,
  PenTool,
  Plus,
  Search,
  Settings,
  Sun,
  UsersRound,
  Video,
  X,
} from 'lucide-react'
import './App.css'
import MeetingRoom from './MeetingRoom'

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:5000'

const navigation = [
  { label: 'Dashboard', icon: LayoutDashboard },
  { label: 'Meetings', icon: Video },
  { label: 'Schedule', icon: CalendarDays },
  { label: 'Settings', icon: Settings },
]

const previewTabs = [
  { label: 'Video', icon: Video },
  { label: 'Chat', icon: MessageSquareText },
  { label: 'People', icon: UsersRound },
  { label: 'Files', icon: Paperclip },
  { label: 'Whiteboard', icon: PenTool },
]


function App() {
  const [authUser, setAuthUser] = useState(null)
  const [authLoading, setAuthLoading] = useState(true)
  const [authMode, setAuthMode] = useState('login')
  const [authSubmitting, setAuthSubmitting] = useState(false)
  const [authError, setAuthError] = useState('')
  const [activePage, setActivePage] = useState('Dashboard')
  const [theme, setTheme] = useState(() => {
    if (typeof window === 'undefined') return 'dark'
    return window.matchMedia('(prefers-color-scheme: dark)').matches
      ? 'dark'
      : 'light'
  })
  const [meetings, setMeetings] = useState([])
  const [activeRoom, setActiveRoom] = useState(null)
  const [previewTab, setPreviewTab] = useState('Video')
  const [dialogMode, setDialogMode] = useState(null)
  const [roomName, setRoomName] = useState('')
  const [roomCode, setRoomCode] = useState('')
  const [dialogMessage, setDialogMessage] = useState('')
  const [searchText, setSearchText] = useState('')
  const [notice, setNotice] = useState('')
  const dialogRef = useRef(null)
  const nameInputRef = useRef(null)
  const codeInputRef = useRef(null)

  const [backendStatus, setBackendStatus] = useState(
    'Checking backend...'
  )

  useEffect(() => {
    fetch(`${API_URL}/api/health`)
      .then((response) => {
        if (!response.ok) throw new Error('Backend request failed')
        return response.json()
      })
      .then((data) => setBackendStatus(data.message))
      .catch(() => setBackendStatus('Backend connection failed'))
  }, [])

  useEffect(() => {
    let isCurrent = true

    fetch(`${API_URL}/api/auth/me`, { credentials: 'include' })
      .then(async (response) => {
        if (response.status === 401) return null
        const data = await response.json()
        if (!response.ok) throw new Error(data.error || 'Could not restore your session.')
        return data.user
      })
      .then((user) => {
        if (isCurrent) setAuthUser(user)
      })
      .catch((error) => {
        if (isCurrent) setAuthError(error.message || 'Could not connect to the sign-in service.')
      })
      .finally(() => {
        if (isCurrent) setAuthLoading(false)
      })

    return () => {
      isCurrent = false
    }
  }, [])

  useEffect(() => {
    if (!authUser) return undefined
    let isCurrent = true

    fetch(`${API_URL}/api/rooms`, { credentials: 'include' })
      .then(async (response) => {
        const data = await response.json()
        if (!response.ok) throw new Error(data.error || 'Could not load meeting rooms.')
        return data
      })
      .then((rooms) => {
        if (!isCurrent) return
        setMeetings(rooms.map((room) => ({
          id: room.id,
          name: room.name,
          code: room.code,
          createdAt: room.createdAt ? new Date(room.createdAt) : null,
        })))
      })
      .catch((error) => {
        if (isCurrent) setNotice(error.message || 'Could not load meeting rooms.')
      })

    return () => {
      isCurrent = false
    }
  }, [authUser])

  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return

    if (dialogMode && !dialog.open) {
      dialog.showModal()
      window.requestAnimationFrame(() => {
        if (dialogMode === 'new') nameInputRef.current?.focus()
        if (dialogMode === 'join') codeInputRef.current?.focus()
      })
    } else if (!dialogMode && dialog.open) {
      dialog.close()
    }
  }, [dialogMode])

  useEffect(() => {
    if (!notice) return undefined

    const timeoutId = window.setTimeout(() => setNotice(''), 3200)
    return () => window.clearTimeout(timeoutId)
  }, [notice])

  const openDialog = (mode, code = '') => {
    setDialogMode(mode)
    setRoomName('')
    setRoomCode(code)
    setDialogMessage('')
  }

  const submitAuthentication = async (event) => {
    event.preventDefault()
    setAuthSubmitting(true)
    setAuthError('')

    const form = new FormData(event.currentTarget)
    const payload = {
      email: form.get('email'),
      password: form.get('password'),
    }
    if (authMode === 'register') payload.displayName = form.get('displayName')

    try {
      const response = await fetch(`${API_URL}/api/auth/${authMode}`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'Could not sign in.')
      setAuthUser(data.user)
      setAuthError('')
    } catch (error) {
      setAuthError(error.message || 'Could not connect to the sign-in service.')
    } finally {
      setAuthSubmitting(false)
    }
  }

  const signOut = async () => {
    setAuthError('')
    try {
      const response = await fetch(`${API_URL}/api/auth/logout`, {
        method: 'POST',
        credentials: 'include',
      })
      if (!response.ok) {
        const data = await response.json().catch(() => ({}))
        throw new Error(data.error || 'Could not end the current session.')
      }
      setAuthUser(null)
      setMeetings([])
      setActiveRoom(null)
      setActivePage('Dashboard')
      setAuthMode('login')
    } catch (error) {
      setNotice(error.message || 'Could not connect to the sign-in service.')
    }
  }

  const closeDialog = () => {
    setDialogMode(null)
    setDialogMessage('')
  }

  const createDemoRoom = async (event) => {
    event.preventDefault()

    const name = roomName.trim()

    if (!name) {
      setDialogMessage('Enter a room name to continue.')
      nameInputRef.current?.focus()
      return
    }

    try {
      const response = await fetch(`${API_URL}/api/rooms`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      })

      const data = await response.json()

      if (!response.ok) {
        throw new Error(data.error || 'Could not create meeting room.')
      }

      const meeting = {
        id: data.id,
        name: data.name,
        code: data.code,
        createdAt: new Date(),
      }

      setMeetings((current) => [meeting, ...current])
      setDialogMode(null)
      setNotice(`Meeting room created! Code: ${data.code}`)
    } catch (error) {
      setDialogMessage(
        error.message || 'Could not connect to the backend.'
      )
    }
  }

  const submitJoin = async (event) => {
    event.preventDefault()

    const code = roomCode.trim().toUpperCase()

    if (!code) {
      setDialogMessage('Enter a meeting code to continue.')
      codeInputRef.current?.focus()
      return
    }

    try {
      const response = await fetch(
        `${API_URL}/api/rooms/${encodeURIComponent(code)}`,
        { credentials: 'include' },
      )

      const room = await response.json()

      if (!response.ok) {
        throw new Error(room.error || 'Meeting room not found.')
      }

      setActiveRoom(room)
      setDialogMode(null)
      setDialogMessage('')
      setNotice(`Joining room ${room.code}...`)
    } catch (error) {
      setDialogMessage(
        error.message || 'Could not find this meeting room.'
      )
    }
  }

  const copyRoomCode = async (code) => {
    try {
      await navigator.clipboard.writeText(code)
      setNotice(`Meeting code ${code} copied.`)
    } catch {
      setNotice('Could not copy the meeting code. Select and copy it instead.')
    }
  }

  const filteredMeetings = meetings.filter((meeting) =>
    meeting.name.toLowerCase().includes(searchText.toLowerCase())
  )

  return (
    <div className="workspace-shell">
      {authLoading ? (
        <div className="auth-loading" role="status">
          Restoring your Meet Up session…
        </div>
      ) : !authUser ? (
        <AuthScreen
          mode={authMode}
          onModeChange={(mode) => {
            setAuthMode(mode)
            setAuthError('')
          }}
          onSubmit={submitAuthentication}
          error={authError}
          submitting={authSubmitting}
          theme={theme}
          onThemeChange={setTheme}
        />
      ) : activeRoom ? (
        <div className="meeting-room-shell">
          <MeetingRoom
            roomCode={activeRoom.code}
            displayName={authUser.displayName}
            onLeave={() => setActiveRoom(null)}
          />
        </div>
      ) : (
        <>
          <a className="skip-link" href="#main-content">
            Skip to main content
          </a>

          <aside className="sidebar" aria-label="Main navigation">
            <a
              className="brand"
              href="#"
              onClick={(event) => {
                event.preventDefault()
                setActivePage('Dashboard')
              }}
            >
              <span className="brand-mark" aria-hidden="true">
                <Video size={19} strokeWidth={2} />
              </span>
              <span className="brand-name">Meet Up</span>
            </a>

            <div className="workspace-switcher">
              <span className="workspace-avatar" aria-hidden="true">A</span>
              <span className="workspace-copy">
                <span className="workspace-label">Workspace</span>
                <span className="workspace-name">Juniper Studio</span>
              </span>
              <ChevronDown size={15} aria-hidden="true" />
            </div>

            <p className="nav-heading">Workspace</p>

            <nav className="primary-nav">
              {navigation.map(({ label, icon: Icon }) => (
                <button
                  className={`nav-item${activePage === label ? ' is-active' : ''}`}
                  type="button"
                  key={label}
                  aria-current={activePage === label ? 'page' : undefined}
                  onClick={() => setActivePage(label)}
                >
                  <Icon size={18} strokeWidth={1.8} aria-hidden="true" />
                  <span>{label}</span>
                  {label === 'Meetings' && meetings.length > 0 && (
                    <span className="nav-count">{meetings.length}</span>
                  )}
                </button>
              ))}
            </nav>

            <div className="sidebar-bottom">
              <div className="plan-note">
                <span className="plan-icon">
                  <UsersRound size={16} aria-hidden="true" />
                </span>
                <div>
                  <strong>Built for better teamwork</strong>
                  <p>Your collaboration space</p>
                </div>
              </div>

              <button
                className="profile-button"
                type="button"
                onClick={() => setActivePage('Settings')}
              >
                <span className="profile-avatar" aria-hidden="true">
                  {authUser.displayName.split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase()}
                </span>
                <span className="profile-copy">
                  <strong>{authUser.displayName}</strong>
                  <span>{authUser.email}</span>
                </span>
                <ChevronDown size={15} aria-hidden="true" />
              </button>
            </div>
          </aside>

          <div className="main-column">
            <header className="topbar">
              <div className="breadcrumb">
                <span>Juniper Studio</span>
                <span className="breadcrumb-divider" aria-hidden="true">/</span>
                <strong>{activePage}</strong>
              </div>

              <div className="topbar-actions">
                <span className="demo-label">{backendStatus}</span>
                <button
                  className="icon-button theme-toggle"
                  type="button"
                  onClick={() =>
                    setTheme((current) =>
                      current === 'dark' ? 'light' : 'dark'
                    )
                  }
                  aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
                  title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
                >
                  {theme === 'dark' ? <Sun size={17} /> : <Moon size={17} />}
                </button>
                <button
                  className="icon-button"
                  type="button"
                  onClick={signOut}
                  aria-label={`Sign out ${authUser.displayName}`}
                  title="Sign out"
                >
                  <LogOut size={17} />
                </button>
              </div>
            </header>

            <main id="main-content" className="main-content">
              {activePage === 'Dashboard' && (
                <DashboardPage
                  meetings={filteredMeetings}
                  totalMeetings={meetings.length}
                  displayName={authUser.displayName}
                  searchText={searchText}
                  onSearch={setSearchText}
                  onNewMeeting={() => openDialog('new')}
                  onJoinMeeting={() => openDialog('join')}
                  onJoinRoom={(code) => openDialog('join', code)}
                  onCopyRoom={copyRoomCode}
                  previewTab={previewTab}
                  onPreviewTab={setPreviewTab}
                />
              )}

              {activePage === 'Meetings' && (
                <MeetingsPage
                  meetings={filteredMeetings}
                  totalMeetings={meetings.length}
                  searchText={searchText}
                  onSearch={setSearchText}
                  onNewMeeting={() => openDialog('new')}
                  onJoinRoom={(code) => openDialog('join', code)}
                  onCopyRoom={copyRoomCode}
                />
              )}

              {activePage === 'Schedule' && (
                <SchedulePage
                  onGoToDashboard={() => setActivePage('Dashboard')}
                />
              )}

              {activePage === 'Settings' && (
                <SettingsPage theme={theme} onThemeChange={setTheme} />
              )}
            </main>
          </div>

          <dialog
            ref={dialogRef}
            className="app-dialog"
            aria-labelledby="dialog-title"
            onClose={closeDialog}
            onCancel={(event) => {
              event.preventDefault()
              closeDialog()
            }}
          >
            <div className="dialog-header">
              <div>
                <span className="dialog-eyebrow">
                  {dialogMode === 'new' ? 'New room' : 'Join a room'}
                </span>
                <h2 id="dialog-title">
                  {dialogMode === 'new'
                    ? 'Create a meeting room'
                    : 'Join a meeting'}
                </h2>
              </div>
              <button
                className="icon-button"
                type="button"
                aria-label="Close dialog"
                onClick={closeDialog}
              >
                <X size={18} />
              </button>
            </div>

            {dialogMode === 'new' ? (
              <form className="dialog-form" onSubmit={createDemoRoom}>
                <label htmlFor="room-name">Room name</label>
                <input
                  ref={nameInputRef}
                  id="room-name"
                  value={roomName}
                  onChange={(event) => setRoomName(event.target.value)}
                  placeholder="For example, Product check-in"
                  maxLength={64}
                  aria-describedby="room-name-help"
                />
                <p id="room-name-help" className="field-help">
                  Create a room, then share its code with other participants.
                </p>
                {dialogMessage && (
                  <p className="form-message" role="alert">{dialogMessage}</p>
                )}
                <div className="dialog-actions">
                  <button
                    className="button button-secondary"
                    type="button"
                    onClick={closeDialog}
                  >
                    Cancel
                  </button>
                  <button className="button button-primary" type="submit">
                    <Plus size={16} /> Create room
                  </button>
                </div>
              </form>
            ) : (
              <form className="dialog-form" onSubmit={submitJoin}>
                <label htmlFor="meeting-code">Meeting code</label>
                <input
                  ref={codeInputRef}
                  id="meeting-code"
                  value={roomCode}
                  onChange={(event) => setRoomCode(event.target.value)}
                  placeholder="Enter a room code"
                  autoComplete="off"
                  maxLength={32}
                  autoCapitalize="characters"
                  aria-describedby="meeting-code-help"
                />
                <p id="meeting-code-help" className="field-help">
                  Enter the 32-character code provided by the meeting host.
                </p>
                {dialogMessage && (
                  <p className="form-message" role="alert">{dialogMessage}</p>
                )}
                <div className="dialog-actions">
                  <button
                    className="button button-secondary"
                    type="button"
                    onClick={closeDialog}
                  >
                    Cancel
                  </button>
                  <button className="button button-primary" type="submit">
                    <ArrowRight size={16} /> Join room
                  </button>
                </div>
              </form>
            )}
          </dialog>
        </>
      )}

      {notice && <div className="toast" role="status">{notice}</div>}
    </div>
  )
}


function AuthScreen({
  mode,
  onModeChange,
  onSubmit,
  error,
  submitting,
  theme,
  onThemeChange,
}) {
  const registering = mode === 'register'

  return (
    <main className="auth-screen" id="main-content">
      <div className="auth-screen-top">
        <a className="brand auth-brand" href="#main-content" aria-label="Meet Up home">
          <span className="brand-mark" aria-hidden="true">
            <Video size={19} strokeWidth={2} />
          </span>
          <span className="brand-name">Meet Up</span>
        </a>
        <button
          className="icon-button theme-toggle"
          type="button"
          onClick={() => onThemeChange(theme === 'dark' ? 'light' : 'dark')}
          aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
        >
          {theme === 'dark' ? <Sun size={17} /> : <Moon size={17} />}
        </button>
      </div>

      <section className="auth-panel" aria-labelledby="auth-heading">
        <p className="auth-eyebrow">Meet Up account</p>
        <h1 id="auth-heading">
          {registering ? 'Create your account' : 'Welcome back'}
        </h1>
        <p className="auth-description">
          {registering
            ? 'Set up your account to create and join meeting rooms.'
            : 'Sign in to continue to your meetings and workspace.'}
        </p>

        <form className="auth-form" onSubmit={onSubmit}>
          {registering && (
            <label className="auth-field">
              <span>Name</span>
              <span className="auth-input-wrap">
                <UsersRound size={16} aria-hidden="true" />
                <input
                  name="displayName"
                  type="text"
                  autoComplete="name"
                  maxLength={40}
                  placeholder="Your name"
                  required
                />
              </span>
            </label>
          )}
          <label className="auth-field">
            <span>Email</span>
            <span className="auth-input-wrap">
              <Mail size={16} aria-hidden="true" />
              <input
                name="email"
                type="email"
                autoComplete="email"
                maxLength={254}
                placeholder="you@example.com"
                required
              />
            </span>
          </label>
          <label className="auth-field">
            <span>Password</span>
            <span className="auth-input-wrap">
              <LockKeyhole size={16} aria-hidden="true" />
              <input
                name="password"
                type="password"
                autoComplete={registering ? 'new-password' : 'current-password'}
                minLength={12}
                maxLength={128}
                placeholder="At least 12 characters"
                required
              />
            </span>
          </label>

          {error && <p className="auth-error" role="alert">{error}</p>}

          <button className="button button-primary auth-submit" type="submit" disabled={submitting}>
            {submitting
              ? 'Please wait…'
              : registering
                ? 'Create account'
                : 'Sign in'}
          </button>
        </form>

        <p className="auth-switch">
          {registering ? 'Already have an account?' : 'New to Meet Up?'}
          <button
            type="button"
            onClick={() => onModeChange(registering ? 'login' : 'register')}
          >
            {registering ? 'Sign in' : 'Create an account'}
          </button>
        </p>
        <p className="auth-note">
          Passwords are verified on the server. Your sign-in session is stored in a protected cookie.
        </p>
      </section>
    </main>
  )
}

function PageHeading({ title, description, actions }) {
  return (
    <div className="page-heading">
      <div>
        <p className="greeting">Your workspace</p>
        <h1>{title}</h1>
        <p className="page-description">{description}</p>
      </div>
      {actions && <div className="heading-actions">{actions}</div>}
    </div>
  )
}

function DashboardPage({
  meetings,
  totalMeetings,
  displayName,
  searchText,
  onSearch,
  onNewMeeting,
  onJoinMeeting,
  onJoinRoom,
  onCopyRoom,
  previewTab,
  onPreviewTab,
}) {
  return (
    <>
      <PageHeading
        title={`Welcome back, ${displayName.split(/\s+/)[0]}`}
        description="A clear space for the conversations that move work forward."
        actions={(
          <>
            <button className="button button-secondary" type="button" onClick={onJoinMeeting}>
              <ArrowRight size={16} /> Join meeting
            </button>
            <button className="button button-primary" type="button" onClick={onNewMeeting}>
              <Plus size={17} /> New meeting
            </button>
          </>
        )}
      />

      <section className="quick-start" aria-labelledby="quick-start-title">
        <div className="quick-start-copy">
          <span className="quick-icon"><Video size={19} aria-hidden="true" /></span>
          <div>
            <h2 id="quick-start-title">Start with a conversation</h2>
            <p>Create a meeting room or join with an invite code to start a live call.</p>
          </div>
        </div>
        <span className="local-demo-label">Live rooms</span>
      </section>

      <section className="section-block recent-section" aria-labelledby="recent-heading">
        <div className="section-heading">
          <div>
            <h2 id="recent-heading">Recent rooms</h2>
            <p>{totalMeetings === 0 ? 'Rooms you create will be collected here.' : `${totalMeetings} available ${totalMeetings === 1 ? 'room' : 'rooms'}`}</p>
          </div>
          {totalMeetings > 0 && (
            <label className="search-field">
              <Search size={16} aria-hidden="true" />
              <span className="sr-only">Search rooms</span>
              <input value={searchText} onChange={(event) => onSearch(event.target.value)} placeholder="Search rooms" />
            </label>
          )}
        </div>

        {meetings.length > 0 ? (
          <MeetingList meetings={meetings} onJoinRoom={onJoinRoom} onCopyRoom={onCopyRoom} />
        ) : totalMeetings > 0 ? (
          <div className="empty-state compact-empty">
            <span className="empty-icon"><Search size={20} aria-hidden="true" /></span>
            <div>
              <h3>No rooms match your search</h3>
              <p>Try a different room name.</p>
            </div>
          </div>
        ) : (
          <div className="empty-state">
            <span className="empty-icon"><Video size={21} aria-hidden="true" /></span>
            <div className="empty-copy">
              <h3>No recent rooms</h3>
              <p>Create a room with <strong>New meeting</strong>, then invite others with its meeting code.</p>
            </div>
            <span className="empty-hint">Your rooms will appear here</span>
          </div>
        )}
      </section>

      <section className="section-block preview-section" aria-labelledby="preview-heading">
        <div className="section-heading preview-heading">
          <div>
            <h2 id="preview-heading">Meeting room preview</h2>
            <p>A preview of the collaboration tools planned for a room.</p>
          </div>
          <span className="preview-status"><span className="status-square" /> Interface preview</span>
        </div>
        <MeetingPreview activeTab={previewTab} onTabChange={onPreviewTab} />
      </section>
    </>
  )
}

function MeetingList({ meetings, onJoinRoom, onCopyRoom }) {
  return (
    <ul className="meeting-list">
      {meetings.map((meeting) => (
        <li className="meeting-row" key={meeting.id}>
          <span className="meeting-icon"><Video size={18} aria-hidden="true" /></span>
          <div className="meeting-info">
            <strong>{meeting.name}</strong>
            <span>
              {meeting.createdAt ? `Created ${meeting.createdAt.toLocaleString()}` : 'Available meeting room'}
              <span className="inline-separator">·</span> Room code
            </span>
          </div>
          <code className="meeting-code">{meeting.code}</code>
          <button className="icon-button row-action" type="button" onClick={() => onCopyRoom(meeting.code)} aria-label={`Copy code for ${meeting.name}`}>
            <Copy size={16} />
          </button>
          <button className="button button-small button-secondary" type="button" onClick={() => onJoinRoom(meeting.code)}>Join</button>
        </li>
      ))}
    </ul>
  )
}

function MeetingPreview({ activeTab, onTabChange }) {
  return (
    <div className="preview-frame">
      <div className="preview-topline">
        <div className="preview-room-title">
          <span className="preview-room-icon"><Video size={15} aria-hidden="true" /></span>
          <strong>Product check-in</strong>
          <span className="preview-tag">Preview</span>
        </div>
        <span className="preview-room-note">Sample layout only</span>
      </div>
      <div className="preview-body">
        <div className="preview-main">
          <div className="preview-tabs" role="tablist" aria-label="Meeting room feature previews">
            {previewTabs.map(({ label, icon: Icon }, index) => (
              <button
                className={`preview-tab${activeTab === label ? ' is-selected' : ''}`}
                type="button"
                role="tab"
                tabIndex={activeTab === label ? 0 : -1}
                aria-selected={activeTab === label}
                aria-controls="preview-panel"
                id={`preview-tab-${label.toLowerCase()}`}
                key={label}
                onClick={() => onTabChange(label)}
                onKeyDown={(event) => {
                  const keyToDelta = { ArrowRight: 1, ArrowLeft: -1 }
                  let nextIndex
                  if (event.key === 'Home') nextIndex = 0
                  else if (event.key === 'End') nextIndex = previewTabs.length - 1
                  else if (keyToDelta[event.key]) {
                    nextIndex = (index + keyToDelta[event.key] + previewTabs.length) % previewTabs.length
                  }
                  if (nextIndex === undefined) return
                  event.preventDefault()
                  onTabChange(previewTabs[nextIndex].label)
                  const tabs = event.currentTarget.parentElement.querySelectorAll('[role="tab"]')
                  tabs[nextIndex]?.focus()
                }}
              >
                <Icon size={15} aria-hidden="true" />
                <span>{label}</span>
              </button>
            ))}
          </div>
          <div
            className="preview-panel"
            id="preview-panel"
            role="tabpanel"
            aria-labelledby={`preview-tab-${activeTab.toLowerCase()}`}
          >
            {activeTab === 'Video' && <VideoPreview />}
            {activeTab === 'Chat' && <ChatPreview />}
            {activeTab === 'People' && <PeoplePreview />}
            {activeTab === 'Files' && <FilesPreview />}
            {activeTab === 'Whiteboard' && <WhiteboardPreview />}
          </div>
          <div className="preview-controls" aria-label="Planned meeting controls preview">
            <span className="control-chip"><MicOff size={14} /> Mic</span>
            <span className="control-chip"><Video size={14} /> Camera</span>
            <span className="control-chip control-chip-muted"><MonitorUp size={14} /> Share</span>
            <span className="control-chip control-chip-muted"><UsersRound size={14} /> People</span>
          </div>
        </div>
        <aside className="preview-chat" aria-label="Chat panel preview">
          <div className="preview-chat-header">
            <strong>Room chat</strong>
            <span>Preview</span>
          </div>
          <div className="preview-chat-messages">
            <div className="sample-message">
              <span className="sample-avatar avatar-blue">JL</span>
              <p><strong>Jordan Lee</strong><span>Sharing the latest agenda here.</span></p>
            </div>
            <div className="sample-message">
              <span className="sample-avatar avatar-lilac">MC</span>
              <p><strong>Morgan Chen</strong><span>Thanks, I have it open.</span></p>
            </div>
          </div>
          <div className="preview-composer">
            <span>Messages are a preview</span>
            <MessageSquareText size={15} aria-hidden="true" />
          </div>
        </aside>
      </div>
      <p className="preview-disclaimer">Live video, screen sharing, and room file sharing are connected. Chat and whiteboard remain previews.</p>
    </div>
  )
}

function VideoPreview() {
  return (
    <div className="video-preview-grid">
      <div className="participant-tile participant-tile-featured">
        <span className="participant-initials">JL</span>
        <span className="participant-name">Jordan Lee <span>(sample)</span></span>
        <span className="speaking-indicator" aria-label="Sample active speaker"><span /><span /><span /></span>
      </div>
      <div className="participant-tile participant-tile-secondary">
        <span className="participant-initials">MC</span>
        <span className="participant-name">Morgan Chen <span>(sample)</span></span>
        <span className="muted-indicator"><MicOff size={13} /> Muted</span>
      </div>
    </div>
  )
}

function ChatPreview() {
  return (
    <div className="tab-content chat-tab-content">
      <span className="tab-content-icon"><MessageSquareText size={19} /></span>
      <h3>Room chat</h3>
      <p>Chat messages will appear alongside the call, with file attachments in context.</p>
      <span className="content-preview-line">This feature is a visual preview only.</span>
    </div>
  )
}

function PeoplePreview() {
  return (
    <div className="tab-content people-tab-content">
      <div className="people-preview-heading">
        <span className="tab-content-icon"><UsersRound size={18} /></span>
        <div><h3>People in this room</h3><p>Sample participants</p></div>
      </div>
      <div className="people-preview-row"><span className="sample-avatar avatar-blue">JL</span><strong>Jordan Lee</strong><span>Host preview</span></div>
      <div className="people-preview-row"><span className="sample-avatar avatar-lilac">MC</span><strong>Morgan Chen</strong><span><MicOff size={13} /> Muted</span></div>
    </div>
  )
}

function FilesPreview() {
  return (
    <div className="tab-content files-tab-content">
      <span className="tab-content-icon"><FileText size={19} /></span>
      <h3>Shared files</h3>
      <p>Files shared in a room will be collected in one place.</p>
      <div className="file-preview-row"><FileText size={16} /><span>Project notes</span><span className="file-preview-label">Sample</span></div>
    </div>
  )
}

function WhiteboardPreview() {
  return (
    <div className="whiteboard-preview">
      <div className="whiteboard-tools" aria-label="Whiteboard tool preview">
        <span className="tool-selected"><PenTool size={15} /></span>
        <span><ArrowRight size={15} /></span>
        <span><FileText size={15} /></span>
      </div>
      <div className="whiteboard-canvas">
        <div className="board-note note-one">Plan</div>
        <div className="board-note note-two">Discuss</div>
        <div className="board-note note-three">Next steps</div>
        <span className="board-connector" aria-hidden="true" />
      </div>
    </div>
  )
}

function MeetingsPage({ meetings, totalMeetings, searchText, onSearch, onNewMeeting, onJoinRoom, onCopyRoom }) {
  return (
    <>
      <PageHeading
        title="Meetings"
        description="Rooms created in this demo appear here."
        actions={<button className="button button-primary" type="button" onClick={onNewMeeting}><Plus size={17} /> New meeting</button>}
      />
      <section className="section-block standalone-section" aria-labelledby="all-rooms-heading">
        <div className="section-heading">
          <div><h2 id="all-rooms-heading">All rooms</h2><p>{totalMeetings} local demo {totalMeetings === 1 ? 'room' : 'rooms'}</p></div>
          {totalMeetings > 0 && (
            <label className="search-field">
              <Search size={16} aria-hidden="true" />
              <span className="sr-only">Search rooms</span>
              <input value={searchText} onChange={(event) => onSearch(event.target.value)} placeholder="Search rooms" />
            </label>
          )}
        </div>
        {meetings.length > 0 ? (
          <MeetingList meetings={meetings} onJoinRoom={onJoinRoom} onCopyRoom={onCopyRoom} />
        ) : totalMeetings > 0 ? (
          <div className="empty-state compact-empty"><span className="empty-icon"><Search size={20} /></span><div><h3>No rooms match your search</h3><p>Try a different room name.</p></div></div>
        ) : (
          <div className="empty-state standalone-empty">
            <span className="empty-icon"><Video size={21} aria-hidden="true" /></span>
            <div className="empty-copy"><h3>No rooms yet</h3><p>Create a local demo room to see how meeting history will look. Calls and room history are not connected.</p></div>
            <button className="button button-primary" type="button" onClick={onNewMeeting}><Plus size={16} /> Create demo room</button>
          </div>
        )}
      </section>
    </>
  )
}

function SchedulePage({ onGoToDashboard }) {
  return (
    <>
      <PageHeading title="Schedule" description="Plan time for the conversations ahead." />
      <section className="section-block standalone-section schedule-empty">
        <span className="empty-icon"><CalendarDays size={21} aria-hidden="true" /></span>
        <h2>No upcoming meetings</h2>
        <p>Meeting scheduling is not connected yet. You can explore the dashboard preview or create a local demo room.</p>
        <button className="button button-secondary" type="button" onClick={onGoToDashboard}>Back to dashboard <ArrowRight size={16} /></button>
      </section>
    </>
  )
}

function SettingsPage({ theme, onThemeChange }) {
  return (
    <>
      <PageHeading title="Settings" description="Set up your workspace preferences." />
      <section className="section-block standalone-section settings-section" aria-labelledby="appearance-heading">
        <div className="section-heading"><div><h2 id="appearance-heading">Appearance</h2><p>Choose a comfortable workspace theme.</p></div></div>
        <div className="theme-options" role="group" aria-label="Color theme">
          <button className={`theme-option${theme === 'light' ? ' is-selected' : ''}`} type="button" aria-pressed={theme === 'light'} onClick={() => onThemeChange('light')}>
            <Sun size={18} /><span><strong>Light</strong><small>Bright surfaces and dark text</small></span>{theme === 'light' && <Check size={17} />}
          </button>
          <button className={`theme-option${theme === 'dark' ? ' is-selected' : ''}`} type="button" aria-pressed={theme === 'dark'} onClick={() => onThemeChange('dark')}>
            <Moon size={18} /><span><strong>Dark</strong><small>Graphite surfaces and soft text</small></span>{theme === 'dark' && <Check size={17} />}
          </button>
        </div>
        <p className="settings-note">Theme selection applies for this session. Account settings are not connected.</p>
      </section>
      <section className="section-block settings-section" aria-labelledby="account-heading">
        <div className="section-heading"><div><h2 id="account-heading">Account</h2><p>Profile and authentication controls will be available when account services are implemented.</p></div></div>
        <div className="account-placeholder"><span className="profile-avatar">AC</span><div><strong>Avery Chen</strong><span>Demo profile</span></div><span className="account-status">Not connected</span></div>
      </section>
    </>
  )
}

export default App
