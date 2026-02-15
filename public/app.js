// ── State ──────────────────────────────────────
/** @type {MediaStream|null} */
let localStream = null;
/** @type {WebSocket|null} */
let ws = null;
/** @type {Map<string, {pc: RTCPeerConnection, dc: RTCDataChannel|null}>} */
const peers = new Map();
/** @type {RTCConfiguration|null} */
let iceConfig = null;
/** @type {string|null} */
let myId = null;
/** @type {string} */
let password = '';
/** @type {string|null} */
let authToken = localStorage.getItem('relay-auth-token');
let micEnabled = true;
let camEnabled = true;
let chatOpen = false;
let unreadCount = 0;

const AUTH_TOKEN_KEY = 'relay-auth-token';

// ── DOM ────────────────────────────────────────
const $ = (s) => document.getElementById(s);
const lobby = $('lobby');
const room = $('room');
const passwordInput = $('password-input');
const joinBtn = $('join-btn');
const btnText = joinBtn.querySelector('.btn-text');
const btnLoader = joinBtn.querySelector('.btn-loader');
const errorMsg = $('error-msg');
const videoGrid = $('video-grid');
const localVideo = $('local-video');
const btnMic = $('btn-mic');
const btnCamera = $('btn-camera');
const btnChat = $('btn-chat');
const btnHangup = $('btn-hangup');
const chatPanel = $('chat-panel');
const chatMessages = $('chat-messages');
const chatInput = $('chat-input');
const btnSend = $('btn-send');
const btnCloseChat = $('btn-close-chat');
const chatBadge = $('chat-badge');
const toastContainer = $('toast-container');

// ── Lobby Events ───────────────────────────────
joinBtn.addEventListener('click', joinRoom);
passwordInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') joinRoom();
});

// ── Auto-join if remembered ────────────────────
if (authToken) {
    // Small delay to let the DOM settle
    setTimeout(() => joinRoom(), 100);
}

// ── Control Events ─────────────────────────────
btnMic.addEventListener('click', toggleMic);
btnCamera.addEventListener('click', toggleCamera);
btnChat.addEventListener('click', toggleChat);
btnHangup.addEventListener('click', leaveRoom);
btnCloseChat.addEventListener('click', toggleChat);
btnSend.addEventListener('click', sendChat);
chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendChat();
});

// ── Join Room ──────────────────────────────────
async function joinRoom() {
    password = passwordInput.value.trim();

    // If no password typed and no saved token, ask for password
    if (!password && !authToken) {
        showError('Please enter the room password');
        return;
    }

    setLoading(true);
    hideError();

    // Build auth query param (prefer token if available)
    const authParam = authToken
        ? `token=${encodeURIComponent(authToken)}`
        : `password=${encodeURIComponent(password)}`;

    // 1. Fetch TURN credentials (also validates auth)
    try {
        const res = await fetch(`/turn-credentials?${authParam}`);
        if (!res.ok) {
            if (res.status === 401) {
                // Token might be stale — clear it and ask for password
                clearSavedToken();
                throw new Error('Wrong password');
            }
            throw new Error('Server error');
        }
        iceConfig = await res.json();
    } catch (e) {
        showError(e.message);
        setLoading(false);
        return;
    }

    // 2. If authed via password, get a persistent token and save it
    if (password && !authToken) {
        try {
            const tokenRes = await fetch('/auth', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ password }),
            });
            if (tokenRes.ok) {
                const data = await tokenRes.json();
                authToken = data.token;
                localStorage.setItem(AUTH_TOKEN_KEY, authToken);
            }
        } catch {
            // Non-critical — they just won't be remembered
        }
    }

    // 3. Get local media
    try {
        localStream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
            audio: { echoCancellation: true, noiseSuppression: true },
        });
        localVideo.srcObject = localStream;
    } catch (e) {
        // Try audio-only if camera fails
        try {
            localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
            localVideo.srcObject = localStream;
            camEnabled = false;
            updateCamButton();
        } catch (e2) {
            showError('Camera and microphone access denied');
            setLoading(false);
            return;
        }
    }

    // 4. Connect WebSocket
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsAuthParam = authToken
        ? `token=${encodeURIComponent(authToken)}`
        : `password=${encodeURIComponent(password)}`;
    ws = new WebSocket(`${proto}//${location.host}/ws?${wsAuthParam}`);

    ws.onopen = () => {
        lobby.classList.add('hidden');
        room.classList.remove('hidden');
        setLoading(false);
        showToast('Connected to room');
        updateLayout();
    };

    ws.onmessage = (e) => handleSignaling(JSON.parse(e.data));

    ws.onclose = (e) => {
        if (e.code === 1006 || e.code === 4001) {
            clearSavedToken();
            showError('Connection rejected — wrong password?');
        }
        leaveRoom();
    };

    ws.onerror = () => {
        showError('Connection failed');
        setLoading(false);
    };
}

// ── Signaling Handler ──────────────────────────
function handleSignaling(msg) {
    switch (msg.type) {
        case 'welcome':
            myId = msg.id;
            // Create peer connections to everyone already in the room
            for (const userId of msg.users) {
                createPeer(userId, true);
            }
            break;

        case 'user-joined':
            showToast('Someone joined');
            addSystemChat('A user joined the call');
            break;

        case 'offer':
            handleOffer(msg);
            break;

        case 'answer':
            handleAnswer(msg);
            break;

        case 'ice-candidate':
            handleIceCandidate(msg);
            break;

        case 'user-left':
            removePeer(msg.id);
            showToast('Someone left');
            addSystemChat('A user left the call');
            break;
    }
}

// ── Peer Connection Management ─────────────────
function createPeer(peerId, isOfferer) {
    if (peers.has(peerId)) return;

    const pc = new RTCPeerConnection(iceConfig);

    /** @type {RTCDataChannel|null} */
    let dc = null;

    // Add local tracks
    if (localStream) {
        for (const track of localStream.getTracks()) {
            pc.addTrack(track, localStream);
        }
    }

    // ICE candidates → send to remote
    pc.onicecandidate = (e) => {
        if (e.candidate) {
            console.log(`[ICE] candidate for ${peerId.slice(0, 4)}: ${e.candidate.type} ${e.candidate.protocol} ${e.candidate.address}:${e.candidate.port}`);
            send({ type: 'ice-candidate', target: peerId, candidate: e.candidate });
        } else {
            console.log(`[ICE] gathering complete for ${peerId.slice(0, 4)}`);
        }
    };

    // ICE connection state — the actual connectivity check
    pc.oniceconnectionstatechange = () => {
        console.log(`[ICE] ${peerId.slice(0, 4)} ice-connection: ${pc.iceConnectionState}`);
    };

    // ICE gathering state
    pc.onicegatheringstatechange = () => {
        console.log(`[ICE] ${peerId.slice(0, 4)} gathering: ${pc.iceGatheringState}`);
    };

    // Connection state feedback
    pc.onconnectionstatechange = () => {
        const state = pc.connectionState;
        console.log(`[ICE] ${peerId.slice(0, 4)} connection: ${state}`);
        if (state === 'connecting') {
            showToast('Finding secure relay path…');
        } else if (state === 'connected') {
            showToast('Peer connected ✓');
        } else if (state === 'failed') {
            showToast('Connection failed — retrying…');
            // Attempt ICE restart
            if (isOfferer) {
                pc.restartIce();
            }
        } else if (state === 'disconnected') {
            showToast('Peer connection unstable…');
        }
    };

    // Remote tracks → add video element
    pc.ontrack = (e) => {
        console.log(`[ICE] ${peerId.slice(0, 4)} received remote track: ${e.track.kind}`);
        const [remoteStream] = e.streams;
        if (!document.getElementById(`video-${peerId}`)) {
            addVideoElement(peerId, remoteStream);
        }
    };

    // DataChannel for chat
    if (isOfferer) {
        dc = pc.createDataChannel('chat');
        setupDataChannel(dc, peerId);
    } else {
        pc.ondatachannel = (e) => {
            dc = e.channel;
            setupDataChannel(dc, peerId);
            // Update peer reference
            const peerData = peers.get(peerId);
            if (peerData) peerData.dc = dc;
        };
    }

    peers.set(peerId, { pc, dc });

    // If we're the offerer, create and send an offer
    if (isOfferer) {
        pc.createOffer()
            .then((offer) => pc.setLocalDescription(offer))
            .then(() => {
                send({ type: 'offer', target: peerId, sdp: pc.localDescription });
            })
            .catch((err) => console.error('Offer error:', err));
    }
}

async function handleOffer(msg) {
    createPeer(msg.from, false);
    const peer = peers.get(msg.from);
    if (!peer) return;

    try {
        await peer.pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
        const answer = await peer.pc.createAnswer();
        await peer.pc.setLocalDescription(answer);
        send({ type: 'answer', target: msg.from, sdp: peer.pc.localDescription });
    } catch (err) {
        console.error('Answer error:', err);
    }
}

async function handleAnswer(msg) {
    const peer = peers.get(msg.from);
    if (!peer) return;

    try {
        await peer.pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
    } catch (err) {
        console.error('Remote desc error:', err);
    }
}

async function handleIceCandidate(msg) {
    const peer = peers.get(msg.from);
    if (!peer) return;

    try {
        await peer.pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
    } catch (err) {
        // Non-critical: some candidates arrive before remote description
    }
}

function removePeer(peerId) {
    const peer = peers.get(peerId);
    if (peer) {
        peer.pc.close();
        peers.delete(peerId);
    }
    const wrapper = document.getElementById(`wrapper-${peerId}`);
    if (wrapper) wrapper.remove();
    updateLayout();
}

// ── DataChannel (Chat) ─────────────────────────
function setupDataChannel(dc, peerId) {
    dc.onmessage = (e) => {
        try {
            const msg = JSON.parse(e.data);
            if (msg.type === 'chat') {
                addChatMessage(msg.text, peerId.slice(0, 6), false);
            }
        } catch (err) {
            // ignore malformed messages
        }
    };
}

function sendChat() {
    const text = chatInput.value.trim();
    if (!text) return;

    // Send to all peers via DataChannel
    for (const [, peer] of peers) {
        if (peer.dc && peer.dc.readyState === 'open') {
            peer.dc.send(JSON.stringify({ type: 'chat', text }));
        }
    }

    addChatMessage(text, 'You', true);
    chatInput.value = '';
}

function addChatMessage(text, sender, isMine) {
    const div = document.createElement('div');
    div.className = `chat-msg ${isMine ? 'mine' : ''}`;
    div.innerHTML = `<span class="chat-sender">${escapeHtml(sender)}</span>${escapeHtml(text)}`;
    chatMessages.appendChild(div);
    chatMessages.scrollTop = chatMessages.scrollHeight;

    // Update unread badge if chat is closed
    if (!chatOpen && !isMine) {
        unreadCount++;
        chatBadge.textContent = unreadCount;
        chatBadge.classList.remove('hidden');
    }
}

function addSystemChat(text) {
    const div = document.createElement('div');
    div.className = 'chat-msg system';
    div.textContent = text;
    chatMessages.appendChild(div);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

// ── Media Controls ─────────────────────────────
function toggleMic() {
    if (!localStream) return;
    micEnabled = !micEnabled;
    for (const track of localStream.getAudioTracks()) {
        track.enabled = micEnabled;
    }
    btnMic.classList.toggle('active', !micEnabled);
    btnMic.querySelector('.icon-mic').classList.toggle('hidden', !micEnabled);
    btnMic.querySelector('.icon-mic-off').classList.toggle('hidden', micEnabled);
}

function toggleCamera() {
    if (!localStream) return;
    camEnabled = !camEnabled;
    for (const track of localStream.getVideoTracks()) {
        track.enabled = camEnabled;
    }
    updateCamButton();
}

function updateCamButton() {
    btnCamera.classList.toggle('active', !camEnabled);
    btnCamera.querySelector('.icon-cam').classList.toggle('hidden', !camEnabled);
    btnCamera.querySelector('.icon-cam-off').classList.toggle('hidden', camEnabled);
}

function toggleChat() {
    chatOpen = !chatOpen;
    chatPanel.classList.toggle('hidden', !chatOpen);
    btnChat.classList.toggle('active', chatOpen);

    if (chatOpen) {
        unreadCount = 0;
        chatBadge.classList.add('hidden');
        chatInput.focus();
    }
}

// ── Leave Room ─────────────────────────────────
function leaveRoom() {
    // Close all peer connections
    for (const [id] of peers) {
        removePeer(id);
    }

    // Close WebSocket
    if (ws) {
        ws.onclose = null; // prevent re-entry
        ws.close();
        ws = null;
    }

    // Stop local media
    if (localStream) {
        for (const track of localStream.getTracks()) {
            track.stop();
        }
        localStream = null;
    }

    // Reset UI
    localVideo.srcObject = null;
    room.classList.add('hidden');
    lobby.classList.remove('hidden');
    chatMessages.innerHTML = '';
    chatPanel.classList.add('hidden');
    chatOpen = false;
    unreadCount = 0;
    chatBadge.classList.add('hidden');
    micEnabled = true;
    camEnabled = true;
    btnMic.classList.remove('active');
    btnCamera.classList.remove('active');
    btnMic.querySelector('.icon-mic').classList.remove('hidden');
    btnMic.querySelector('.icon-mic-off').classList.add('hidden');
    btnCamera.querySelector('.icon-cam').classList.remove('hidden');
    btnCamera.querySelector('.icon-cam-off').classList.add('hidden');
    videoGrid.classList.remove('layout-solo', 'layout-pip', 'layout-grid');
    pipDragSetup = false;
    const localWrapper = document.getElementById('local-wrapper');
    if (localWrapper) {
        localWrapper.style.right = '';
        localWrapper.style.bottom = '';
    }
    passwordInput.value = '';
    if (!authToken) {
        passwordInput.focus();
    }
}

// ── Video Grid ─────────────────────────────────
function addVideoElement(peerId, stream) {
    const wrapper = document.createElement('div');
    wrapper.className = 'video-wrapper';
    wrapper.id = `wrapper-${peerId}`;

    const video = document.createElement('video');
    video.id = `video-${peerId}`;
    video.srcObject = stream;
    video.autoplay = true;
    video.playsInline = true;
    // Remote videos should not be muted
    video.muted = false;

    const label = document.createElement('span');
    label.className = 'video-label';
    label.textContent = `Peer ${peerId.slice(0, 4)}`;

    wrapper.appendChild(video);
    wrapper.appendChild(label);
    videoGrid.appendChild(wrapper);

    // Force play (autoplay policy)
    video.play().catch(() => { });

    updateLayout();
}

// ── Layout Switching ───────────────────────────
// Dynamically switch layout based on participant count:
//   1 person  → solo   (centered self-view)
//   2 people  → pip    (FaceTime: remote fullscreen, local small corner)
//   3+ people → grid   (Zoom/Teams grid)
function updateLayout() {
    const totalParticipants = peers.size + 1; // +1 for self

    videoGrid.classList.remove('layout-solo', 'layout-pip', 'layout-grid');

    if (totalParticipants === 1) {
        videoGrid.classList.add('layout-solo');
    } else if (totalParticipants === 2) {
        videoGrid.classList.add('layout-pip');
        // Ensure local wrapper is last (so it overlays on top)
        const localWrapper = document.getElementById('local-wrapper');
        if (localWrapper && localWrapper !== videoGrid.lastElementChild) {
            videoGrid.appendChild(localWrapper);
        }
        setupPipDrag();
    } else {
        videoGrid.classList.add('layout-grid');
    }
}

// ── PiP Drag Support ───────────────────────────
let pipDragSetup = false;
function setupPipDrag() {
    const localWrapper = document.getElementById('local-wrapper');
    if (!localWrapper || pipDragSetup) return;
    pipDragSetup = true;

    let isDragging = false;
    let startX = 0, startY = 0;
    let origRight = 0, origBottom = 0;

    const onPointerDown = (e) => {
        if (!videoGrid.classList.contains('layout-pip')) return;
        isDragging = true;
        startX = e.clientX;
        startY = e.clientY;
        const rect = localWrapper.getBoundingClientRect();
        const parentRect = videoGrid.getBoundingClientRect();
        origRight = parentRect.right - rect.right;
        origBottom = parentRect.bottom - rect.bottom;
        localWrapper.setPointerCapture(e.pointerId);
        e.preventDefault();
    };

    const onPointerMove = (e) => {
        if (!isDragging) return;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        localWrapper.style.right = `${origRight - dx}px`;
        localWrapper.style.bottom = `${origBottom - dy}px`;
    };

    const onPointerUp = () => {
        isDragging = false;
    };

    localWrapper.addEventListener('pointerdown', onPointerDown);
    localWrapper.addEventListener('pointermove', onPointerMove);
    localWrapper.addEventListener('pointerup', onPointerUp);
}

// ── Helpers ────────────────────────────────────
function send(msg) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(msg));
    }
}

function setLoading(loading) {
    joinBtn.disabled = loading;
    btnText.classList.toggle('hidden', loading);
    btnLoader.classList.toggle('hidden', !loading);
}

function showError(text) {
    errorMsg.textContent = text;
    errorMsg.classList.remove('hidden');
}

function hideError() {
    errorMsg.classList.add('hidden');
}

function showToast(text, duration = 3000) {
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = text;
    toastContainer.appendChild(toast);

    setTimeout(() => {
        toast.classList.add('toast-out');
        toast.addEventListener('animationend', () => toast.remove());
    }, duration);
}

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

function clearSavedToken() {
    authToken = null;
    localStorage.removeItem(AUTH_TOKEN_KEY);
}
