
import { useCallback, useEffect, useRef, useState } from 'react'
import { io } from 'socket.io-client'
import {
  ArrowLeft,
  Mic,
  MicOff,
  Video,
  VideoOff,
  Wifi,
  WifiOff,
  MessageSquareText,
  Send,
  Pencil,
  Eraser,
  Trash2,
  MonitorUp,
  FileUp,
  FileText,
  Download,
  LoaderCircle,
} from 'lucide-react'
import './App.css'

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:5000'
const SOCKET_URL = API_URL

const ICE_SERVERS = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
}

const WHITEBOARD_COLORS = [
  { value: '#1d2938', label: 'Graphite' },
  { value: '#2c5fbe', label: 'Blue' },
  { value: '#be4b3c', label: 'Red' },
  { value: '#2c8c6b', label: 'Green' },
  { value: '#d18a21', label: 'Amber' },
]
const MAX_WHITEBOARD_STROKE_POINTS = 96
const MAX_WHITEBOARD_HISTORY_STROKES = 1500
const MAX_WHITEBOARD_HISTORY_POINTS = 50000

function isValidWhiteboardStroke(stroke) {
  return Boolean(
    stroke &&
    typeof stroke.id === 'string' &&
    typeof stroke.color === 'string' &&
    WHITEBOARD_COLORS.some((color) => color.value === stroke.color) &&
    Number.isInteger(stroke.size) &&
    stroke.size >= 1 &&
    stroke.size <= 24 &&
    typeof stroke.eraser === 'boolean' &&
    Array.isArray(stroke.points) &&
    stroke.points.length > 0 &&
    stroke.points.length <= MAX_WHITEBOARD_STROKE_POINTS &&
    stroke.points.every((point) => (
      point &&
      Number.isFinite(point.x) &&
      Number.isFinite(point.y) &&
      point.x >= 0 &&
      point.x <= 1 &&
      point.y >= 0 &&
      point.y <= 1
    )),
  )
}

function paintWhiteboardCanvas(canvas, strokes) {
  if (!canvas) return

  const rect = canvas.getBoundingClientRect()
  if (!rect.width || !rect.height) return

  const ratio = window.devicePixelRatio || 1
  const width = Math.round(rect.width * ratio)
  const height = Math.round(rect.height * ratio)
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width
    canvas.height = height
  }

  const context = canvas.getContext('2d')
  context.setTransform(ratio, 0, 0, ratio, 0, 0)
  context.clearRect(0, 0, rect.width, rect.height)

  for (const stroke of strokes) {
    if (!isValidWhiteboardStroke(stroke)) continue

    context.save()
    context.globalCompositeOperation = stroke.eraser
      ? 'destination-out'
      : 'source-over'
    context.strokeStyle = stroke.color
    context.fillStyle = stroke.color
    context.lineWidth = stroke.size
    context.lineCap = 'round'
    context.lineJoin = 'round'

    if (stroke.points.length === 1) {
      const [point] = stroke.points
      context.beginPath()
      context.arc(
        point.x * rect.width,
        point.y * rect.height,
        stroke.size / 2,
        0,
        Math.PI * 2,
      )
      context.fill()
    } else {
      context.beginPath()
      context.moveTo(
        stroke.points[0].x * rect.width,
        stroke.points[0].y * rect.height,
      )
      for (const point of stroke.points.slice(1)) {
        context.lineTo(point.x * rect.width, point.y * rect.height)
      }
      context.stroke()
    }
    context.restore()
  }
}

function MeetingRoom({ roomCode, displayName, onLeave }) {
  const [participants, setParticipants] = useState([])
  const [localParticipantId, setLocalParticipantId] = useState(null)
  const [connected, setConnected] = useState(false)
  const [joining, setJoining] = useState(false)
  const [joined, setJoined] = useState(false)
  const [meetingSocket, setMeetingSocket] = useState(null)
  const [error, setError] = useState('')
  const [localStream, setLocalStream] = useState(null)
  const [remoteStreams, setRemoteStreams] = useState({})
  const [audioPlaybackBlocked, setAudioPlaybackBlocked] = useState(false)
  const [micEnabled, setMicEnabled] = useState(true)
  const [cameraEnabled, setCameraEnabled] = useState(true)
  const [isScreenSharing, setIsScreenSharing] = useState(false)
  const [fileAccessToken, setFileAccessToken] = useState('')
  const [sharedFiles, setSharedFiles] = useState([])
  const [filesLoading, setFilesLoading] = useState(false)
  const [fileUpload, setFileUpload] = useState(null)
  const [fileProgress, setFileProgress] = useState(0)
  const [fileError, setFileError] = useState('')
  const [isDraggingFile, setIsDraggingFile] = useState(false)
  const [chatMessages, setChatMessages] = useState([])
  const [chatDraft, setChatDraft] = useState('')
  const [chatSending, setChatSending] = useState(false)
  const [chatError, setChatError] = useState('')
  const [whiteboardStrokes, setWhiteboardStrokes] = useState([])
  const [whiteboardRevision, setWhiteboardRevision] = useState(0)
  const [whiteboardError, setWhiteboardError] = useState('')

  const socketRef = useRef(null)
  const localVideoRef = useRef(null)
  const chatInputRef = useRef(null)
  const chatMessagesEndRef = useRef(null)
  const chatMessageListenerRef = useRef(null)
  const chatSendPendingRef = useRef(false)
  const whiteboardListenersRef = useRef(null)
  const whiteboardStrokesRef = useRef([])
  const whiteboardRevisionRef = useRef(0)
  const fileInputRef = useRef(null)
  const fileAccessTokenRef = useRef('')
  const fileUploadRequestRef = useRef(null)
  const peerConnections = useRef(new Map())
  const pendingCandidates = useRef(new Map())
  const localStreamRef = useRef(null)
  const joinedRef = useRef(false)
  const remoteStreamsRef = useRef(new Map())
  const remoteVideoElements = useRef(new Map())
  const screenStreamRef = useRef(null)
  const cameraTrackRef = useRef(null)
  const screenTrackRef = useRef(null)

  const registerRemoteVideo = useCallback((participantId, element) => {
    if (element) {
      remoteVideoElements.current.set(participantId, element)
    } else {
      remoteVideoElements.current.delete(participantId)
    }
  }, [])

  const handleAutoplayBlocked = useCallback(() => {
    setAudioPlaybackBlocked(true)
  }, [])

  const handleChatSubmit = (event) => {
    event.preventDefault()
    const message = chatDraft.trim()
    const socket = socketRef.current

    if (!message) {
      setChatError('Enter a message before sending.')
      chatInputRef.current?.focus()
      return
    }
    if (!socket?.connected || !joinedRef.current) {
      setChatError('Reconnect to the meeting before sending a message.')
      return
    }
    if (chatSendPendingRef.current) return

    chatSendPendingRef.current = true
    setChatSending(true)
    setChatError('')
    socket.timeout(5000).emit(
      'chat:send',
      { code: roomCode, message },
      (timeoutError, response) => {
        chatSendPendingRef.current = false
        setChatSending(false)
        if (timeoutError) {
          setChatError('The message could not be sent. Check your connection and try again.')
          return
        }
        if (!response?.ok) {
          setChatError(response?.error || 'The message could not be sent.')
          return
        }
        setChatDraft((current) => current.trim() === message ? '' : current)
      },
    )
  }

  const handleChatKeyDown = (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      event.currentTarget.form?.requestSubmit()
    }
  }

  useEffect(() => {
    chatMessagesEndRef.current?.scrollIntoView({ block: 'end' })
  }, [chatMessages])

  const loadSharedFiles = async (token) => {
    if (!token) return

    setFilesLoading(true)
    try {
      const response = await fetch(
        `${API_URL}/api/rooms/${encodeURIComponent(roomCode)}/files`,
        {
          credentials: 'include',
          headers: { Authorization: `Bearer ${token}` },
        },
      )
      const data = await response.json()

      if (!response.ok) throw new Error(data.error || 'Could not load shared files.')
      if (!joinedRef.current || fileAccessTokenRef.current !== token) return
      setSharedFiles(data.files || [])
      setFileError('')
    } catch (err) {
      if (!joinedRef.current || fileAccessTokenRef.current !== token) return
      console.error('Could not load shared files:', err)
      setFileError(err.message || 'Could not load shared files.')
    } finally {
      if (joinedRef.current && fileAccessTokenRef.current === token) {
        setFilesLoading(false)
      }
    }
  }

  const formatFileSize = (bytes) => {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  }

  const uploadSharedFile = (file) => {
    const token = fileAccessTokenRef.current
    if (!file || !token || fileUploadRequestRef.current) return

    setFileError('')
    setFileUpload(file)
    setFileProgress(0)

    const body = new FormData()
    body.append('file', file)
    const request = new XMLHttpRequest()
    request.open(
      'POST',
      `${API_URL}/api/rooms/${encodeURIComponent(roomCode)}/files`,
    )
    request.withCredentials = true
    request.setRequestHeader('Authorization', `Bearer ${token}`)
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        setFileProgress(Math.round((event.loaded / event.total) * 100))
      }
    }
    request.onload = () => {
      if (fileUploadRequestRef.current === request) fileUploadRequestRef.current = null
      if (fileAccessTokenRef.current !== token) return

      let data
      try {
        data = JSON.parse(request.responseText)
      } catch {
        data = {}
      }

      if (request.status < 200 || request.status >= 300) {
        setFileError(data.error || 'Upload failed. Please try again.')
      } else if (data.file) {
        setSharedFiles((current) => [
          data.file,
          ...current.filter((item) => item.id !== data.file.id),
        ])
      }

      setFileUpload(null)
      setFileProgress(0)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
    request.onerror = () => {
      if (fileUploadRequestRef.current === request) fileUploadRequestRef.current = null
      if (fileAccessTokenRef.current !== token) return
      setFileError('Upload failed because the server could not be reached.')
      setFileUpload(null)
      setFileProgress(0)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
    request.onabort = () => {
      if (fileUploadRequestRef.current === request) fileUploadRequestRef.current = null
    }
    fileUploadRequestRef.current = request
    request.send(body)
  }

  const downloadSharedFile = async (file) => {
    setFileError('')

    try {
      const response = await fetch(
        `${API_URL}/api/rooms/${encodeURIComponent(roomCode)}/files/${encodeURIComponent(file.id)}/download`,
        { credentials: 'include', headers: { Authorization: `Bearer ${fileAccessToken}` } },
      )

      if (!response.ok) {
        let data = {}
        try {
          data = await response.json()
        } catch {
          data = {}
        }
        throw new Error(data.error || 'Download failed. Please try again.')
      }

      const blob = await response.blob()
      const objectUrl = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = objectUrl
      link.download = file.name
      document.body.appendChild(link)
      link.click()
      link.remove()
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000)
    } catch (err) {
      console.error('Could not download shared file:', err)
      setFileError(err.message || 'Download failed. Please try again.')
    }
  }

  const handleFileDrop = (event) => {
    event.preventDefault()
    setIsDraggingFile(false)
    const file = event.dataTransfer.files?.[0]
    if (event.dataTransfer.files?.length > 1) {
      setFileError('Upload one file at a time.')
      return
    }
    if (file) uploadSharedFile(file)
  }

  const enableRemoteAudio = async () => {
    const videos = [...remoteVideoElements.current.values()]

    try {
      await Promise.all(videos.map(async (video) => {
        video.muted = false
        await video.play()
      }))
      setAudioPlaybackBlocked(false)
      setError('')
    } catch (err) {
      console.error('Could not enable remote audio playback:', err)
      setAudioPlaybackBlocked(true)
      setError('Remote audio is still blocked. Check this tab’s sound permissions.')
    }
  }

  useEffect(() => {
    if (localVideoRef.current) {
      localVideoRef.current.srcObject =
        isScreenSharing && screenStreamRef.current
          ? screenStreamRef.current
          : localStream
    }
  }, [localStream, isScreenSharing])

  useEffect(() => {
    const connections = peerConnections.current
    const candidates = pendingCandidates.current
    const remoteStreams = remoteStreamsRef.current
    const remoteVideos = remoteVideoElements.current

    return () => {
      joinedRef.current = false

      connections.forEach((pc) => pc.close())
      connections.clear()
      candidates.clear()
      remoteStreams.clear()
      remoteVideos.clear()

      if (socketRef.current) {
        if (chatMessageListenerRef.current) {
          socketRef.current.off('chat:message', chatMessageListenerRef.current)
          chatMessageListenerRef.current = null
        }
        if (whiteboardListenersRef.current) {
          Object.entries(whiteboardListenersRef.current).forEach(
            ([event, listener]) => socketRef.current.off(event, listener),
          )
          whiteboardListenersRef.current = null
        }
        socketRef.current.emit('room:leave', { code: roomCode })
        socketRef.current.disconnect()
        socketRef.current = null
      }

      if (screenStreamRef.current) {
        screenStreamRef.current.getTracks().forEach((track) => {
          track.onended = null
          track.stop()
        })
        screenStreamRef.current = null
      }

      localStreamRef.current?.getTracks().forEach((track) => track.stop())
      localStreamRef.current = null
      cameraTrackRef.current = null
      screenTrackRef.current = null
      fileAccessTokenRef.current = ''
      fileUploadRequestRef.current?.abort()
      fileUploadRequestRef.current = null
      chatSendPendingRef.current = false
    }
  }, [roomCode])

  const negotiatePeer = async (remoteId, pc = peerConnections.current.get(remoteId)) => {
    if (!pc || pc.__relayMakingOffer || pc.signalingState !== 'stable') return

    try {
      pc.__relayMakingOffer = true
      const offer = await pc.createOffer()

      if (pc.signalingState !== 'stable') return

      await pc.setLocalDescription(offer)
      socketRef.current?.emit('webrtc:offer', {
        targetId: remoteId,
        offer: pc.localDescription,
      })
    } catch (err) {
      console.error('Could not create WebRTC offer:', err)
      setError('Could not negotiate media with another participant.')
    } finally {
      pc.__relayMakingOffer = false
    }
  }

  const createPeerConnection = (remoteId) => {
    const existing = peerConnections.current.get(remoteId)
    if (existing) return existing

    const pc = new RTCPeerConnection(ICE_SERVERS)
    const stream = localStreamRef.current
    const tracks = stream?.getTracks() || []
    const screenTrack = screenTrackRef.current

    pc.__relayPolite = String(socketRef.current?.id || '').localeCompare(remoteId) > 0
    pc.__relayMakingOffer = false
    pc.__relayIgnoreOffer = false
    pc.__relayIsSettingRemoteAnswerPending = false

    tracks.forEach((track) => {
      const outgoingTrack =
        track.kind === 'video' && screenTrack ? screenTrack : track
      const outgoingStream =
        track.kind === 'video' && screenTrack
          ? screenStreamRef.current
          : stream
      const sender = pc.addTrack(outgoingTrack, outgoingStream)

      if (track.kind === 'video') {
        pc.__relayVideoSender = sender
      }
    })

    // Keep media negotiation possible if a local track is unavailable.
    if (!tracks.some((track) => track.kind === 'audio')) {
      pc.addTransceiver('audio', { direction: 'recvonly' })
    }

    if (!tracks.some((track) => track.kind === 'video') && screenTrack) {
      pc.__relayVideoSender = pc.addTrack(
        screenTrack,
        screenStreamRef.current,
      )
    } else if (!tracks.some((track) => track.kind === 'video')) {
      pc.__relayVideoSender = pc.addTransceiver('video', {
        direction: 'recvonly',
      }).sender
    }

    pc.onnegotiationneeded = () => {
      void negotiatePeer(remoteId, pc)
    }

    pc.onicecandidate = (event) => {
      if (event.candidate && socketRef.current) {
        socketRef.current.emit('webrtc:ice-candidate', {
          targetId: remoteId,
          candidate: event.candidate,
        })
      }
    }

    pc.ontrack = (event) => {
      const stream =
        remoteStreamsRef.current.get(remoteId) ||
        event.streams[0] ||
        new MediaStream()

      if (!remoteStreamsRef.current.has(remoteId)) {
        remoteStreamsRef.current.set(remoteId, stream)
      }

      if (!stream.getTracks().some((track) => track.id === event.track.id)) {
        stream.addTrack(event.track)
      }

      setRemoteStreams((current) => ({
        ...current,
        [remoteId]: stream,
      }))
    }

    pc.onconnectionstatechange = () => {
      console.log(
        `WebRTC connection with ${remoteId}:`,
        pc.connectionState,
      )

      if (['failed', 'closed'].includes(pc.connectionState)) {
        setRemoteStreams((current) => {
          const updated = { ...current }
          delete updated[remoteId]
          return updated
        })
      }
    }

    pc.oniceconnectionstatechange = () => {
      console.log(
        `ICE connection with ${remoteId}:`,
        pc.iceConnectionState,
      )
    }

    peerConnections.current.set(remoteId, pc)
    return pc
  }

  const joinRoom = async (event) => {
    event.preventDefault()

    if (joining || joinedRef.current) return

    setJoining(true)
    setError('')
    whiteboardStrokesRef.current = []
    whiteboardRevisionRef.current = 0
    setWhiteboardStrokes([])
    setWhiteboardRevision(0)
    setWhiteboardError('')

    let stream

    try {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: true,
          video: true,
        })
      } catch (videoError) {
        console.warn(
          'Camera/microphone request failed; trying audio only:',
          videoError,
        )

        try {
          stream = await navigator.mediaDevices.getUserMedia({
            audio: true,
            video: false,
          })
        } catch (audioError) {
          console.warn(
            'Audio-only request failed; joining without local media:',
            audioError,
          )

          stream = new MediaStream()
        }
      }

      localStreamRef.current = stream
      cameraTrackRef.current = stream.getVideoTracks()[0] || null
      setLocalStream(stream)

      setMicEnabled(stream.getAudioTracks().some((track) => track.enabled))
      setCameraEnabled(stream.getVideoTracks().some((track) => track.enabled))

      const socket = io(SOCKET_URL, { withCredentials: true })
      socketRef.current = socket
      setMeetingSocket(socket)

      const whiteboardListeners = {
        state: (data) => {
          if (
            data?.code !== roomCode ||
            !Number.isSafeInteger(data.revision) ||
            data.revision < whiteboardRevisionRef.current ||
            !Array.isArray(data.strokes) ||
            data.strokes.length > MAX_WHITEBOARD_HISTORY_STROKES ||
            !data.strokes.every(isValidWhiteboardStroke) ||
            data.strokes.reduce((total, stroke) => total + stroke.points.length, 0) >
              MAX_WHITEBOARD_HISTORY_POINTS
          ) {
            setWhiteboardError('The shared whiteboard data could not be loaded.')
            return
          }

          const uniqueStrokes = [
            ...new Map(data.strokes.map((stroke) => [stroke.id, stroke])).values(),
          ]
          whiteboardStrokesRef.current = uniqueStrokes
          whiteboardRevisionRef.current = data.revision
          setWhiteboardStrokes(uniqueStrokes)
          setWhiteboardRevision(data.revision)
          setWhiteboardError('')
        },
        stroke: (data) => {
          if (
            data?.code !== roomCode ||
            !Number.isSafeInteger(data.revision) ||
            data.revision <= whiteboardRevisionRef.current ||
            !isValidWhiteboardStroke(data.stroke)
          ) {
            return
          }

          if (whiteboardStrokesRef.current.some((stroke) => stroke.id === data.stroke.id)) {
            whiteboardRevisionRef.current = data.revision
            setWhiteboardRevision(data.revision)
            return
          }

          const nextStrokes = [...whiteboardStrokesRef.current, data.stroke]
          whiteboardStrokesRef.current = nextStrokes
          whiteboardRevisionRef.current = data.revision
          setWhiteboardStrokes(nextStrokes)
          setWhiteboardRevision(data.revision)
          setWhiteboardError('')
        },
        clear: (data) => {
          if (
            data?.code !== roomCode ||
            !Number.isSafeInteger(data.revision) ||
            data.revision <= whiteboardRevisionRef.current
          ) {
            return
          }

          whiteboardStrokesRef.current = []
          whiteboardRevisionRef.current = data.revision
          setWhiteboardStrokes([])
          setWhiteboardRevision(data.revision)
          setWhiteboardError('')
        },
      }
      whiteboardListenersRef.current = whiteboardListeners
      socket.on('whiteboard:state', whiteboardListeners.state)
      socket.on('whiteboard:stroke', whiteboardListeners.stroke)
      socket.on('whiteboard:clear', whiteboardListeners.clear)

      socket.on('connect', () => {
        setConnected(true)
        setChatError('')
        setLocalParticipantId(socket.id)
        socket.emit('room:join', { code: roomCode })
      })

      socket.on('room:joined', async (data) => {
        joinedRef.current = true
        setJoined(true)
        setJoining(false)
        setLocalParticipantId(socket.id)
        fileAccessTokenRef.current = data.fileAccessToken || ''
        setFileAccessToken(fileAccessTokenRef.current)
        if (data.fileAccessToken) void loadSharedFiles(data.fileAccessToken)
        setParticipants(data.participants || [])

        for (const participant of data.participants || []) {
          if (participant.id !== socket.id) {
            const pc = createPeerConnection(participant.id)
            await negotiatePeer(participant.id, pc)
          }
        }
      })

      socket.on('room:participants', (data) => {
        if (data.code === roomCode) {
          setParticipants(data.participants || [])
        }
      })

      socket.on('room:participant-left', ({ code, participantId }) => {
        if (code !== roomCode) return

        const pc = peerConnections.current.get(participantId)

        if (pc) {
          pc.close()
          peerConnections.current.delete(participantId)
        }

        pendingCandidates.current.delete(participantId)
        remoteStreamsRef.current.delete(participantId)
        remoteVideoElements.current.delete(participantId)

        setRemoteStreams((current) => {
          const updated = { ...current }
          delete updated[participantId]
          return updated
        })
      })

      socket.on('room:file-shared', ({ code, file }) => {
        if (code !== roomCode || !file?.id) return
        setSharedFiles((current) => [
          file,
          ...current.filter((item) => item.id !== file.id),
        ])
      })

      const handleChatMessage = (message) => {
        if (
          message?.code !== roomCode ||
          typeof message.id !== 'string' ||
          typeof message.senderName !== 'string' ||
          typeof message.message !== 'string' ||
          typeof message.createdAt !== 'string'
        ) {
          return
        }

        setChatMessages((current) => (
          current.some((item) => item.id === message.id)
            ? current
            : [...current, message]
        ))
      }
      chatMessageListenerRef.current = handleChatMessage
      socket.on('chat:message', handleChatMessage)

      socket.on('room:error', (message) => {
        setError(
          typeof message === 'string' ? message : 'Unable to join room.',
        )
        setJoining(false)
        joinedRef.current = false
        setJoined(false)
      })

      socket.on('webrtc:offer', async ({ fromId, offer }) => {
        try {
          const pc = createPeerConnection(fromId)
          const offerCollision =
            pc.__relayMakingOffer ||
            (pc.signalingState !== 'stable' &&
              !pc.__relayIsSettingRemoteAnswerPending)

          pc.__relayIgnoreOffer = !pc.__relayPolite && offerCollision
          if (pc.__relayIgnoreOffer) {
            pendingCandidates.current.delete(fromId)
            return
          }

          if (offerCollision && pc.__relayPolite) {
            await pc.setLocalDescription({ type: 'rollback' })
          }

          await pc.setRemoteDescription(new RTCSessionDescription(offer))
          pc.__relayIgnoreOffer = false

          const queued = pendingCandidates.current.get(fromId) || []
          for (const candidate of queued) {
            await pc.addIceCandidate(new RTCIceCandidate(candidate))
          }
          pendingCandidates.current.delete(fromId)

          const answer = await pc.createAnswer()
          await pc.setLocalDescription(answer)

          socket.emit('webrtc:answer', {
            targetId: fromId,
            answer: pc.localDescription,
          })
        } catch (err) {
          console.error('Could not process WebRTC offer:', err)
          setError('Could not connect to another participant.')
        }
      })

      socket.on('webrtc:answer', async ({ fromId, answer }) => {
        try {
          const pc = peerConnections.current.get(fromId)
          if (!pc || pc.signalingState !== 'have-local-offer') return

          pc.__relayIsSettingRemoteAnswerPending = true
          await pc.setRemoteDescription(new RTCSessionDescription(answer))
          pc.__relayIsSettingRemoteAnswerPending = false
          pc.__relayIgnoreOffer = false

          const queued = pendingCandidates.current.get(fromId) || []
          for (const candidate of queued) {
            await pc.addIceCandidate(new RTCIceCandidate(candidate))
          }
          pendingCandidates.current.delete(fromId)
        } catch (err) {
          const pc = peerConnections.current.get(fromId)
          if (pc) pc.__relayIsSettingRemoteAnswerPending = false
          console.error('Could not process WebRTC answer:', err)
        }
      })

      socket.on('webrtc:ice-candidate', async ({ fromId, candidate }) => {
        try {
          const pc = peerConnections.current.get(fromId)
          if (pc?.__relayIgnoreOffer) return

          if (pc?.remoteDescription) {
            await pc.addIceCandidate(new RTCIceCandidate(candidate))
          } else {
            const queued = pendingCandidates.current.get(fromId) || []
            queued.push(candidate)
            pendingCandidates.current.set(fromId, queued)
          }
        } catch (err) {
          console.error('Could not add ICE candidate:', err)
        }
      })

      socket.on('disconnect', () => {
        setConnected(false)
        setChatError('Connection lost. Chat will resume when you reconnect.')
        fileAccessTokenRef.current = ''
        setFileAccessToken('')
        setFilesLoading(false)
        fileUploadRequestRef.current?.abort()
        fileUploadRequestRef.current = null
        setFileUpload(null)
        setFileProgress(0)
      })

      socket.on('connect_error', (err) => {
        console.error('Socket connection error:', err)
        setError('Could not connect to the meeting server.')
        setJoining(false)
      })
    } catch (err) {
      stream?.getTracks().forEach((track) => track.stop())
      localStreamRef.current = null
      setLocalStream(null)
      setJoining(false)

      if (
        err.name === 'NotAllowedError' ||
        err.name === 'PermissionDeniedError'
      ) {
        setError('Camera or microphone permission was denied.')
      } else if (err.name === 'NotFoundError') {
        setError('No camera or microphone was found.')
      } else {
        setError(err.message || 'Could not join the meeting.')
      }
    }
  }

  const startScreenSharing = async () => {
    if (screenStreamRef.current) return

    let screenStream
    let replacements = []

    try {
      screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: false,
      })

      const screenTrack = screenStream.getVideoTracks()[0]
      if (!screenTrack) {
        screenStream.getTracks().forEach((track) => track.stop())
        setError('Could not get a screen-sharing video track.')
        return
      }

      screenStreamRef.current = screenStream
      screenTrackRef.current = screenTrack
      screenTrack.onended = () => {
        void stopScreenSharing()
      }

      for (const [remoteId, pc] of peerConnections.current) {
        if (pc.connectionState === 'closed') continue

        let transceiver = pc.getTransceivers().find(
          (item) => item.receiver.track.kind === 'video',
        )
        if (!transceiver) {
          transceiver = pc.addTransceiver('video', { direction: 'recvonly' })
        }

        const sender = transceiver.sender
        const previousTrack = sender.track
        const previousDirection = transceiver.direction
        replacements.push({ remoteId, sender, previousTrack, transceiver, previousDirection })

        if (transceiver.direction === 'recvonly' || transceiver.direction === 'inactive') {
          transceiver.direction = 'sendrecv'
        }

        await sender.replaceTrack(screenTrack)
      }

      setIsScreenSharing(true)
      setAudioPlaybackBlocked(false)
      setError('')

      for (const replacement of replacements) {
        if (replacement.previousDirection !== replacement.transceiver.direction) {
          void negotiatePeer(replacement.remoteId)
        }
      }
    } catch (err) {
      await Promise.allSettled(
        replacements.map(async ({ sender, previousTrack, transceiver, previousDirection }) => {
          await sender.replaceTrack(previousTrack || null)
          transceiver.direction = previousDirection
        }),
      )

      screenStreamRef.current = null
      screenTrackRef.current = null
      screenStream?.getTracks().forEach((track) => {
        track.onended = null
        track.stop()
      })

      console.error('Could not start screen sharing:', err)
      if (err.name !== 'NotAllowedError') {
        setError('Could not start screen sharing. Please try again.')
      }
    }
  }

  const stopScreenSharing = async () => {
    const screenStream = screenStreamRef.current
    if (!screenStream) return

    const screenTrack = screenTrackRef.current
    if (screenTrack) screenTrack.onended = null
    screenStreamRef.current = null
    screenTrackRef.current = null

    const cameraTrack = cameraTrackRef.current

    try {
      const restorations = []

      for (const [remoteId, pc] of peerConnections.current) {
        if (pc.connectionState === 'closed') continue

        const transceiver = pc.getTransceivers().find(
          (item) => item.receiver.track.kind === 'video',
        )
        if (!transceiver) continue

        const sender = transceiver.sender
        const previousDirection = transceiver.direction
        restorations.push((async () => {
          await sender.replaceTrack(cameraTrack || null)

          if (!cameraTrack && transceiver.direction === 'sendrecv') {
            transceiver.direction = 'recvonly'
          } else if (cameraTrack && transceiver.direction !== 'sendrecv') {
            transceiver.direction = 'sendrecv'
          }

          if (previousDirection !== transceiver.direction) {
            await negotiatePeer(remoteId)
          }
        })())
      }

      const outcomes = await Promise.allSettled(restorations)
      if (outcomes.some((outcome) => outcome.status === 'rejected')) {
        setError('Sharing stopped, but the camera could not be restored on every connection.')
      } else {
        setError('')
      }
    } catch (err) {
      console.error('Could not restore camera video:', err)
      setError('Sharing stopped, but the camera could not be restored on every connection.')
    } finally {
      screenStream.getTracks().forEach((track) => {
        track.onended = null
        track.stop()
      })
      setIsScreenSharing(false)
    }
  }


  const toggleMicrophone = () => {
    const tracks = localStreamRef.current?.getAudioTracks() || []

    if (!tracks.length) {
      setError('No microphone track is available in this browser.')
      return
    }

    const enabled = !tracks[0].enabled
    tracks.forEach((track) => {
      track.enabled = enabled
    })
    setMicEnabled(enabled)
    setError('')
  }

  const toggleCamera = () => {
    const tracks = localStreamRef.current?.getVideoTracks() || []

    if (!tracks.length) {
      setError('No camera track is available in this browser.')
      return
    }

    const enabled = !tracks[0].enabled
    tracks.forEach((track) => {
      track.enabled = enabled
    })
    setCameraEnabled(enabled)
    setError('')
  }

  const leaveRoom = () => {
    joinedRef.current = false
    setJoined(false)
    chatSendPendingRef.current = false
    fileAccessTokenRef.current = ''
    fileUploadRequestRef.current?.abort()
    fileUploadRequestRef.current = null

    if (screenStreamRef.current) {
      screenStreamRef.current.getTracks().forEach((track) => {
        track.onended = null
        track.stop()
      })
      screenStreamRef.current = null
      screenTrackRef.current = null
    }

    if (socketRef.current && chatMessageListenerRef.current) {
      socketRef.current.off('chat:message', chatMessageListenerRef.current)
      chatMessageListenerRef.current = null
    }
    if (socketRef.current && whiteboardListenersRef.current) {
      Object.entries(whiteboardListenersRef.current).forEach(
        ([event, listener]) => socketRef.current.off(event, listener),
      )
      whiteboardListenersRef.current = null
    }
    socketRef.current?.emit('room:leave', { code: roomCode })
    socketRef.current?.disconnect()
    socketRef.current = null
    setMeetingSocket(null)

    peerConnections.current.forEach((pc) => pc.close())
    peerConnections.current.clear()
    pendingCandidates.current.clear()
    remoteStreamsRef.current.clear()
    remoteVideoElements.current.clear()

    localStreamRef.current?.getTracks().forEach((track) => track.stop())
    localStreamRef.current = null
    cameraTrackRef.current = null

    setLocalStream(null)
    setRemoteStreams({})
    setParticipants([])
    setSharedFiles([])
    whiteboardStrokesRef.current = []
    whiteboardRevisionRef.current = 0
    setWhiteboardStrokes([])
    setWhiteboardRevision(0)
    setWhiteboardError('')
    setFilesLoading(false)
    setFileAccessToken('')
    setFileUpload(null)
    setFileProgress(0)
    setFileError('')
    setChatMessages([])
    setChatDraft('')
    setChatSending(false)
    setChatError('')
    setLocalParticipantId(null)
    setConnected(false)
    setIsScreenSharing(false)
    setAudioPlaybackBlocked(false)
    setError('')
    setJoining(false)

    onLeave()
  }

  return (
    <main className="main-content">
      <div className="page-heading">
        <div>
          <p className="greeting">Meet Up · Live meeting</p>
          <h1>Room {roomCode}</h1>
          <p className="page-description">
            Share the room code to invite other participants.
          </p>
        </div>

        <span className="account-status">
          {connected ? (
            <><Wifi size={16} /> Connected</>
          ) : (
            <><WifiOff size={16} /> Disconnected</>
          )}
        </span>
      </div>

      {!joined && (
        <form className="dialog-form section-block" onSubmit={joinRoom}>
          <p className="meeting-identity">
            Joining as <strong>{displayName}</strong> from your verified account.
          </p>

          {error && <p className="form-message" role="alert">{error}</p>}

          <button
            className="button button-primary"
            type="submit"
            disabled={joining}
          >
            {joining ? 'Connecting...' : 'Join meeting'}
          </button>
        </form>
      )}

      {error && <p className="form-message" role="alert">{error}</p>}

      <section className="section-block">
        <div className="section-heading">
          <div>
            <h2>Participants ({participants.length})</h2>
            <p>Camera feeds appear here when participants connect.</p>
          </div>
        </div>

        {audioPlaybackBlocked && (
          <div className="audio-unlock-notice" role="status">
            <span>Remote audio is waiting for permission to play.</span>
            <button className="button button-secondary" type="button" onClick={enableRemoteAudio}>
              Enable audio
            </button>
          </div>
        )}

        <div className="video-preview-grid">
          {localStream && (
            <div className="participant-tile">
              {isScreenSharing || localStream.getVideoTracks().length > 0 ? (
                <video
                  ref={localVideoRef}
                  autoPlay
                  muted
                  playsInline
                  className="meeting-video"
                />
              ) : (
                <div className="participant-initials">
                  {displayName.slice(0, 2).toUpperCase()}
                </div>
              )}

              <span className="participant-name">
                {displayName || 'You'} (You)
              </span>
            </div>
          )}

          {participants
            .filter((participant) => participant.id !== localParticipantId)
            .map((participant) => (
              <div className="participant-tile" key={participant.id}>
                {remoteStreams[participant.id] ? (
                  <>
                    <RemoteVideo
                      participantId={participant.id}
                      stream={remoteStreams[participant.id]}
                      onVideoElement={registerRemoteVideo}
                      onAutoplayBlocked={handleAutoplayBlocked}
                      hasVideo={remoteStreams[participant.id].getVideoTracks().some(
                        (track) => track.readyState === 'live',
                      )}
                    />
                    {!remoteStreams[participant.id].getVideoTracks().some(
                      (track) => track.readyState === 'live',
                    ) && (
                      <div className="participant-initials">
                        {participant.name.slice(0, 2).toUpperCase()}
                      </div>
                    )}
                  </>
                ) : (
                  <div className="participant-initials">
                    {participant.name.slice(0, 2).toUpperCase()}
                  </div>
                )}

                <span className="participant-name">{participant.name}</span>
              </div>
            ))}
        </div>
      </section>

      {localStream && (
        <div className="dialog-actions">
          <button
            className="button button-secondary"
            onClick={isScreenSharing ? stopScreenSharing : startScreenSharing}
            type="button"
          >
            <MonitorUp size={17} />
            {isScreenSharing ? 'Stop sharing' : 'Share screen'}
          </button>

          <button
            className="button button-secondary"
            onClick={toggleMicrophone}
            type="button"
            aria-pressed={!micEnabled}
            aria-label={micEnabled ? 'Mute your microphone' : 'Unmute your microphone'}
          >
            {micEnabled ? <Mic size={17} /> : <MicOff size={17} />}
            {micEnabled ? 'Mute microphone' : 'Unmute microphone'}
          </button>

          <button
            className="button button-secondary"
            onClick={toggleCamera}
            type="button"
          >
            {cameraEnabled ? <Video size={17} /> : <VideoOff size={17} />}
            {cameraEnabled ? 'Turn camera off' : 'Turn camera on'}
          </button>

          <button
            className="button button-secondary"
            onClick={leaveRoom}
            type="button"
          >
            <ArrowLeft size={17} /> Leave meeting
          </button>
        </div>
      )}

      {(joined || joining) && (
        <section className="meeting-chat-room" aria-labelledby="meeting-chat-title">
          <div className="meeting-chat-room-heading">
            <div className="meeting-chat-room-title">
              <span className="meeting-chat-room-icon" aria-hidden="true">
                <MessageSquareText size={18} />
              </span>
              <div>
                <h2 id="meeting-chat-title">Meeting chat</h2>
                <p>Messages are visible to participants in this room while they are connected.</p>
              </div>
            </div>
            <span className={`chat-connection-status${connected && joined ? ' is-connected' : ''}`} role="status">
              <span aria-hidden="true" />
              {connected && joined
                ? 'Connected'
                : connected
                  ? 'Joining room'
                  : joining
                    ? 'Connecting'
                    : 'Reconnecting'}
            </span>
          </div>

          <div className="meeting-chat-history" aria-label="Meeting messages">
            {chatMessages.length === 0 ? (
              <div className="meeting-chat-empty" role="status">
                <span className="meeting-chat-empty-icon" aria-hidden="true">
                  <MessageSquareText size={20} />
                </span>
                <strong>{joined ? 'No messages yet' : 'Joining the meeting'}</strong>
                <p>
                  {joined
                    ? 'Send a message to start the conversation.'
                    : 'Chat will be ready as soon as you connect.'}
                </p>
              </div>
            ) : (
              <ol className="meeting-chat-message-list" aria-live="polite" aria-relevant="additions">
                {chatMessages.map((message) => (
                  <li
                    className={`meeting-chat-item${message.senderId === localParticipantId ? ' is-own-message' : ''}`}
                    key={message.id}
                  >
                    <div className="meeting-chat-message-meta">
                      <strong>{message.senderName}</strong>
                      <time dateTime={message.createdAt}>
                        {new Date(message.createdAt).toLocaleTimeString([], {
                          hour: 'numeric',
                          minute: '2-digit',
                        })}
                      </time>
                    </div>
                    <p>{message.message}</p>
                  </li>
                ))}
                <li className="meeting-chat-scroll-anchor" ref={chatMessagesEndRef} aria-hidden="true" />
              </ol>
            )}
          </div>

          {chatError && <p className="meeting-chat-error" role="alert">{chatError}</p>}

          <form className="meeting-chat-composer" onSubmit={handleChatSubmit}>
            <label className="sr-only" htmlFor="meeting-chat-input">Write a message</label>
            <textarea
              ref={chatInputRef}
              id="meeting-chat-input"
              value={chatDraft}
              onChange={(event) => {
                setChatDraft(event.target.value)
                if (chatError) setChatError('')
              }}
              onKeyDown={handleChatKeyDown}
              placeholder={joined && connected ? 'Write a message…' : 'Waiting for connection…'}
              maxLength={2000}
              rows={2}
              disabled={!joined || !connected || chatSending}
            />
            <button
              className="meeting-chat-send"
              type="submit"
              disabled={!joined || !connected || chatSending || !chatDraft.trim()}
              aria-label="Send message"
              title="Send message"
            >
              <Send size={17} aria-hidden="true" />
            </button>
            <span className="meeting-chat-shortcut">
              Enter to send · Shift+Enter for a new line
            </span>
          </form>
        </section>
      )}

      {(joined || joining) && (
        <CollaborativeWhiteboard
          roomCode={roomCode}
          socket={meetingSocket}
          connected={connected}
          joined={joined}
          strokes={whiteboardStrokes}
          revision={whiteboardRevision}
          error={whiteboardError}
          onError={setWhiteboardError}
        />
      )}

      {joined && (
        <section className="shared-files-panel" aria-labelledby="shared-files-title">
          <div className="shared-files-heading">
            <div>
              <h2 id="shared-files-title">Shared files</h2>
              <p>Files are available to participants who are currently in this meeting.</p>
            </div>
            <button
              className="button button-secondary"
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={!fileAccessToken || Boolean(fileUpload)}
            >
              <FileUp size={17} />
              Choose file
            </button>
          </div>

          <input
            ref={fileInputRef}
            className="shared-file-input"
            type="file"
            aria-label="Choose a file to share"
            onChange={(event) => {
              const file = event.target.files?.[0]
              if (file) uploadSharedFile(file)
            }}
            disabled={!fileAccessToken || Boolean(fileUpload)}
          />

          <div
            className={`file-dropzone${isDraggingFile ? ' is-dragging' : ''}`}
            role="button"
            tabIndex={fileAccessToken && !fileUpload ? 0 : -1}
            aria-label="Choose a file or drop one here to share it"
            aria-disabled={!fileAccessToken || Boolean(fileUpload)}
            onClick={() => {
              if (fileAccessToken && !fileUpload) fileInputRef.current?.click()
            }}
            onKeyDown={(event) => {
              if (['Enter', ' '].includes(event.key)) {
                event.preventDefault()
                if (fileAccessToken && !fileUpload) fileInputRef.current?.click()
              }
            }}
            onDragOver={(event) => {
              event.preventDefault()
              if (fileAccessToken && !fileUpload) setIsDraggingFile(true)
            }}
            onDragLeave={() => setIsDraggingFile(false)}
            onDrop={handleFileDrop}
          >
            <span className="file-drop-icon"><FileUp size={20} /></span>
            <span className="file-drop-copy">
              <strong>{isDraggingFile ? 'Drop the file to share it' : 'Drop a file here'}</strong>
              <span>or choose a file from your device · up to 25 MB</span>
            </span>
          </div>

          {fileUpload && (
            <div className="file-upload-progress" role="status">
              <LoaderCircle size={17} className="file-upload-spinner" />
              <div className="file-upload-progress-copy">
                <strong>Uploading {fileUpload.name}</strong>
                <progress value={fileProgress} max="100" aria-label={`Upload progress ${fileProgress}%`} />
              </div>
              <span>{fileProgress}%</span>
            </div>
          )}

          {fileError && <p className="file-sharing-error" role="alert">{fileError}</p>}

          {filesLoading ? (
            <div className="shared-files-loading" role="status">
              <LoaderCircle size={17} className="file-upload-spinner" />
              Loading shared files...
            </div>
          ) : sharedFiles.length ? (
            <ul className="shared-file-list" aria-label="Files shared in this meeting">
              {sharedFiles.map((file) => (
                <li className="shared-file-row" key={file.id}>
                  <span className="shared-file-icon"><FileText size={18} /></span>
                  <span className="shared-file-details">
                    <strong title={file.name}>{file.name}</strong>
                    <span>{formatFileSize(file.size)} <span aria-hidden="true">·</span> Shared by {file.uploaderName}</span>
                  </span>
                  <button
                    className="shared-file-download"
                    type="button"
                    onClick={() => void downloadSharedFile(file)}
                    aria-label={`Download ${file.name}`}
                    title={`Download ${file.name}`}
                  >
                    <Download size={17} />
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <div className="shared-files-empty" role="status">
              <FileText size={18} />
              <span>No files shared yet. Share notes or reference material with the room.</span>
            </div>
          )}
        </section>
      )}

      {!localStream && (
        <button
          className="button button-secondary"
          onClick={leaveRoom}
          type="button"
        >
          <ArrowLeft size={17} /> Leave meeting
        </button>
      )}
    </main>
  )
}

function CollaborativeWhiteboard({
  roomCode,
  socket,
  connected,
  joined,
  strokes,
  revision,
  error,
  onError,
}) {
  const [color, setColor] = useState('#2c5fbe')
  const [brushSize, setBrushSize] = useState(4)
  const [eraserEnabled, setEraserEnabled] = useState(false)
  const [clearPending, setClearPending] = useState(false)
  const surfaceRef = useRef(null)
  const boardCanvasRef = useRef(null)
  const previewCanvasRef = useRef(null)
  const activeStrokeRef = useRef(null)
  const strokesRef = useRef(strokes)

  const redrawCanvases = () => {
    paintWhiteboardCanvas(boardCanvasRef.current, strokesRef.current)
    paintWhiteboardCanvas(
      previewCanvasRef.current,
      activeStrokeRef.current ? [activeStrokeRef.current] : [],
    )
  }

  useEffect(() => {
    const surface = surfaceRef.current
    if (!surface) return undefined

    const observer = new ResizeObserver(redrawCanvases)
    observer.observe(surface)
    window.addEventListener('resize', redrawCanvases)
    redrawCanvases()
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', redrawCanvases)
    }
  }, [])

  useEffect(() => {
    strokesRef.current = strokes
    paintWhiteboardCanvas(boardCanvasRef.current, strokes)
  }, [strokes, revision])

  const sendStroke = (active, points) => {
    if (!socket?.connected || !joined) {
      onError('Reconnect to the meeting before drawing.')
      return
    }

    const stroke = {
      id: crypto.randomUUID(),
      color: active.color,
      size: active.size,
      eraser: active.eraser,
      points,
    }

    socket.timeout(5000).emit(
      'whiteboard:stroke',
      { code: roomCode, stroke },
      (timeoutError, response) => {
        if (timeoutError) {
          onError('The drawing could not be synchronized. Check your connection and try again.')
        } else if (!response?.ok) {
          onError(response?.error || 'The drawing could not be synchronized.')
        }
      },
    )
  }

  const flushStroke = (active, final = false) => {
    let startIndex = active.lastSentPointIndex ?? 0
    let remaining = active.points.length - startIndex
    while (
      remaining >= (final ? 2 : 32) ||
      (final && remaining === 1 && active.lastSentPointIndex === null)
    ) {
      const points = active.points.slice(
        startIndex,
        Math.min(startIndex + MAX_WHITEBOARD_STROKE_POINTS, active.points.length),
      )
      sendStroke(active, points)
      active.lastSentPointIndex = startIndex + points.length - 1
      startIndex = active.lastSentPointIndex
      remaining = active.points.length - startIndex
    }
  }

  const getNormalizedPoint = (event) => {
    const rect = surfaceRef.current?.getBoundingClientRect()
    if (!rect?.width || !rect.height) return null

    return {
      x: Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)),
    }
  }

  const handlePointerDown = (event) => {
    if (!connected || !joined || !surfaceRef.current) return
    event.preventDefault()
    const point = getNormalizedPoint(event)
    if (!point) return

    surfaceRef.current.setPointerCapture(event.pointerId)
    activeStrokeRef.current = {
      id: crypto.randomUUID(),
      pointerId: event.pointerId,
      color,
      size: brushSize,
      eraser: eraserEnabled,
      points: [point],
      lastSentPointIndex: null,
    }
    paintWhiteboardCanvas(previewCanvasRef.current, [activeStrokeRef.current])
    onError('')
  }

  const handlePointerMove = (event) => {
    const active = activeStrokeRef.current
    if (!active || active.pointerId !== event.pointerId) return
    event.preventDefault()

    const pointerEvents = event.nativeEvent.getCoalescedEvents?.() || [event.nativeEvent]
    for (const pointerEvent of pointerEvents) {
      const point = getNormalizedPoint(pointerEvent)
      if (!point) continue
      if (active.points.length >= 4096) {
        onError('This drawing stroke reached its local point limit.')
        break
      }
      active.points.push(point)
    }

    paintWhiteboardCanvas(previewCanvasRef.current, [active])
    flushStroke(active)
  }

  const finishPointer = (event) => {
    const active = activeStrokeRef.current
    if (!active || active.pointerId !== event.pointerId) return

    flushStroke(active, true)
    activeStrokeRef.current = null
    if (surfaceRef.current?.hasPointerCapture(event.pointerId)) {
      surfaceRef.current.releasePointerCapture(event.pointerId)
    }
    paintWhiteboardCanvas(previewCanvasRef.current, [])
  }

  const handleClear = () => {
    if (!socket?.connected || !joined || clearPending) return

    const active = activeStrokeRef.current
    if (active && surfaceRef.current?.hasPointerCapture(active.pointerId)) {
      surfaceRef.current.releasePointerCapture(active.pointerId)
    }
    activeStrokeRef.current = null
    paintWhiteboardCanvas(previewCanvasRef.current, [])
    setClearPending(true)
    onError('')
    socket.timeout(5000).emit(
      'whiteboard:clear',
      { code: roomCode },
      (timeoutError, response) => {
        setClearPending(false)
        if (timeoutError) {
          onError('The board could not be cleared. Check your connection and try again.')
        } else if (!response?.ok) {
          onError(response?.error || 'The board could not be cleared.')
        }
      },
    )
  }

  const isReady = connected && joined

  return (
    <section className="meeting-whiteboard" aria-labelledby="meeting-whiteboard-title">
      <div className="meeting-whiteboard-heading">
        <div>
          <h2 id="meeting-whiteboard-title">Collaborative whiteboard</h2>
          <p>Draw together. Changes are visible to everyone in this meeting.</p>
        </div>
        <span className={`whiteboard-connection-status${isReady ? ' is-connected' : ''}`} role="status">
          <span aria-hidden="true" />
          {isReady ? 'Live' : connected ? 'Joining room' : 'Reconnecting'}
        </span>
      </div>

      <div className="whiteboard-toolbar" aria-label="Whiteboard tools">
        <div className="whiteboard-color-options" role="group" aria-label="Pen color">
          {WHITEBOARD_COLORS.map((penColor) => (
            <button
              className={`whiteboard-color${color === penColor.value && !eraserEnabled ? ' is-selected' : ''}`}
              key={penColor.value}
              type="button"
              aria-label={`${penColor.label} pen`}
              aria-pressed={color === penColor.value && !eraserEnabled}
              title={`${penColor.label} pen`}
              style={{ '--whiteboard-swatch': penColor.value }}
              onClick={() => {
                setColor(penColor.value)
                setEraserEnabled(false)
              }}
              disabled={!isReady}
            />
          ))}
        </div>
        <label className="whiteboard-brush-control">
          <span>Brush size</span>
          <input
            type="range"
            min="1"
            max="24"
            value={brushSize}
            onChange={(event) => setBrushSize(Number(event.target.value))}
            aria-valuetext={`${brushSize} pixels`}
            disabled={!isReady}
          />
          <output>{brushSize}px</output>
        </label>
        <button
          className={`whiteboard-tool-button${eraserEnabled ? ' is-selected' : ''}`}
          type="button"
          onClick={() => setEraserEnabled((enabled) => !enabled)}
          aria-pressed={eraserEnabled}
          disabled={!isReady}
        >
          {eraserEnabled ? <Pencil size={16} /> : <Eraser size={16} />}
          {eraserEnabled ? 'Pen' : 'Eraser'}
        </button>
        <button
          className="whiteboard-tool-button whiteboard-clear-button"
          type="button"
          onClick={handleClear}
          disabled={!isReady || clearPending || strokes.length === 0}
        >
          <Trash2 size={16} />
          {clearPending ? 'Clearing' : 'Clear board'}
        </button>
      </div>

      <div
        ref={surfaceRef}
        className={`whiteboard-surface${isReady ? ' is-drawable' : ''}`}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={finishPointer}
        onPointerCancel={finishPointer}
        onLostPointerCapture={finishPointer}
        aria-label="Shared drawing canvas"
        data-revision={revision}
      >
        <canvas ref={boardCanvasRef} className="whiteboard-layer" aria-hidden="true" />
        <canvas ref={previewCanvasRef} className="whiteboard-layer whiteboard-preview-layer" aria-hidden="true" />
        {!isReady && (
          <div className="whiteboard-waiting" role="status">
            {connected ? 'Joining the meeting to load the board…' : 'Reconnect to view and draw on the shared board.'}
          </div>
        )}
        {isReady && strokes.length === 0 && (
          <div className="whiteboard-empty" aria-hidden="true">Start drawing on the board</div>
        )}
      </div>

      {error && <p className="whiteboard-error" role="alert">{error}</p>}
      <p className="whiteboard-shortcut">Use your mouse or touch to draw. The board is shared with this room.</p>
    </section>
  )
}

function RemoteVideo({
  participantId,
  stream,
  onVideoElement,
  onAutoplayBlocked,
  hasVideo,
}) {
  const videoRef = useRef(null)

  useEffect(() => {
    const video = videoRef.current
    if (!video) return undefined

    video.srcObject = stream
    video.muted = false

    video.play().catch((err) => {
      if (err.name === 'NotAllowedError') {
        onAutoplayBlocked()
      } else if (err.name !== 'AbortError') {
        console.error('Could not play remote media:', err)
      }
    })

    return () => {
      video.srcObject = null
    }
  }, [stream, onAutoplayBlocked])

  useEffect(() => {
    onVideoElement(participantId, videoRef.current)
    return () => onVideoElement(participantId, null)
  }, [participantId, onVideoElement])

  return (
    <video
      ref={videoRef}
      autoPlay
      muted={false}
      playsInline
      className={`meeting-video${hasVideo ? '' : ' audio-only-video'}`}
      aria-label="Remote participant audio and video"
    />
  )
}

export default MeetingRoom
