/**
 * Sahayak — Nova Sonic Frontend
 *
 * Real-time bidirectional audio streaming via Socket.IO, wrapped in the
 * Nova Sonic reference UI's theme system, intro animation, streaming
 * chat bubbles, tool-call chips, and data cards — adapted to Sahayak's
 * actual Socket.IO protocol and banking tools (verifyAadhaarTool,
 * verifyOtpTool, checkBalanceTool, getFdQuoteTool, bookFdTool,
 * withdrawCashTool).
 *
 * Architecture:
 *   Browser Mic → PCM 16kHz mono → base64 → Socket.IO → Server → Nova Sonic
 *   Nova Sonic → Server → Socket.IO → base64 PCM 24kHz → AudioContext → Speaker
 */

// ─── State ──────────────────────────────────────────────────────────────────
let socket = null;
let socketConnected = false;   // Socket.IO transport connected
let isStreaming = false;       // Nova Sonic session active (audioReady received)
let isConnecting = false;
let isAuthenticated = false;

// Audio capture
let audioContext = null;
let mediaStream = null;
let scriptProcessor = null;
let sourceNode = null;

// Audio playback
let playbackContext = null;
let isPlaying = false;
let scheduledSources = new Set(); // every AudioBufferSourceNode currently scheduled/playing
let nextPlayTime = 0;
let pendingAgentGap = false;
const AGENT_TURN_GAP = 0.3; // seconds — natural pause before the agent starts speaking

// Barge-in tuning — keep the agent's own voice (echo) from self-interrupting
let bargeInFrames = 0;
const BARGE_IN_THRESHOLD = 0.08;
const BARGE_IN_MIN_FRAMES = 2;

const INPUT_SAMPLE_RATE = 16000;
const OUTPUT_SAMPLE_RATE = 24000;

// Call timer
let callStartTime = null;
let callTimerInterval = null;

// The backend fires BOTH 'streamComplete' (when the underlying Bedrock response
// stream loop ends) and 'sessionClosed' (after cleanup) for every call teardown —
// not just the 8-minute timeout. Guard so we only surface one "session ended"
// system message per call, no matter which event(s) fire.
let sessionEndedAnnounced = false;

// Chat streaming state
const typingBubbles = { user: null, agent: null };
const streamBubbles = { user: null, agent: null };
let currentToolChip = null;
let pendingToolResult = null;
let pendingCardTarget = null;

// Text chat: message typed before a Nova Sonic session is active is queued
// here and flushed to the backend once 'audioReady' arrives.
let pendingTextMessage = null;

const TOOL_LABELS = {
    verifyAadhaarTool: 'Verifying identity',
    verifyOtpTool: 'Verifying OTP',
    checkBalanceTool: 'Checking balance',
    getFdQuoteTool: 'Getting FD quote',
    bookFdTool: 'Booking Fixed Deposit',
    withdrawCashTool: 'Processing withdrawal',
};

// ─── Theme toggle ───────────────────────────────────────────────────────────
function initTheme() {
    const toggleBtn = document.getElementById('theme-toggle');
    if (!toggleBtn) return;

    toggleBtn.addEventListener('click', () => {
        const current = document.documentElement.getAttribute('data-theme') || 'dark';
        const next = current === 'dark' ? 'light' : 'dark';
        document.documentElement.setAttribute('data-theme', next);
        try { localStorage.setItem('sahayakTheme', next); } catch (e) { /* ignore */ }
    });
    toggleBtn.setAttribute('aria-label', 'Toggle light/dark theme');
}

// ─── Socket.IO Connection ───────────────────────────────────────────────────
function initSocket() {
    socket = io({
        transports: ['websocket'],
        reconnection: true,
        reconnectionAttempts: 10,
        reconnectionDelay: 1000
    });

    socket.on('connect', () => {
        console.log('[Socket] Connected:', socket.id);
        socketConnected = true;
        const micBtn = document.getElementById('mic-btn');
        if (micBtn) micBtn.disabled = false;
        setChatEnabled(true);
        setConnectionState(false);
        setStatus('Tap microphone to start conversation', '');
    });

    socket.on('disconnect', (reason) => {
        console.log('[Socket] Disconnected:', reason);
        const wasStreaming = isStreaming;
        socketConnected = false;
        isStreaming = false;
        stopAudioCapture();
        stopAudioPlayback();
        const micBtn = document.getElementById('mic-btn');
        if (micBtn) micBtn.disabled = true;
        setChatEnabled(false);
        setConnectionState(false);
        setStatus('Disconnected — reconnecting...', '');
        if (wasStreaming) {
            finalizeAllStreams();
            removeTyping('user');
            removeTyping('agent');
            announceSessionEnded();
        }
    });

    socket.on('reconnect', () => {
        console.log('[Socket] Reconnected');
        socketConnected = true;
        const micBtn = document.getElementById('mic-btn');
        if (micBtn) micBtn.disabled = false;
        setChatEnabled(true);
        setStatus('Reconnected — tap microphone to start conversation', '');
    });

    // ── Nova Sonic Events ───────────────────────────────────────────────────

    socket.on('audioReady', () => {
        console.log('[Socket] Audio ready — session fully initialized');
        isConnecting = false;
        isStreaming = true;
        sessionEndedAnnounced = false;
        setConnectionState(true);
        setStatus('🎤 Listening — say hello or ask about your account', 'active');
        showTyping('user');
        startAudioCapture();
        flushPendingTextMessage();
    });

    socket.on('contentStart', (data) => {
        if (!data) return;
        if (data.type === 'TEXT') {
            const role = (data.role || 'ASSISTANT').toLowerCase() === 'user' ? 'user' : 'agent';
            showTyping(role);
        }
    });

    socket.on('textOutput', (data) => {
        if (!data || !data.content) return;
        if (isControlSignal(data.content)) {
            // Nova Sonic sends control markers (e.g. `{"interrupted":true}` on barge-in)
            // through the same textOutput channel as real transcript — don't render these.
            console.log('[Socket] Control signal:', data.content);
            return;
        }
        const role = (data.role || 'ASSISTANT').toLowerCase() === 'user' ? 'user' : 'agent';
        appendTranscript(role, data.content);
    });

    socket.on('audioOutput', (data) => {
        if (!data || !data.content) return;
        if (!isPlaying && scheduledSources.size === 0) {
            pendingAgentGap = true;
        }
        setMicState('speaking');
        setStatus('🔊 Speaking...', 'connected');
        removeTyping('user');
        finalizeStream('user');
        if (!streamBubbles.agent) showTyping('agent');
        queueAudioChunk(data.content);
    });

    socket.on('contentEnd', (data) => {
        if (data && data.type === 'TEXT') {
            finalizeStream('user');
            finalizeStream('agent');
        }
    });

    socket.on('toolUse', (data) => {
        console.log('[Socket] Tool invoked:', data && data.toolName);
        finalizeAllStreams();
        removeTyping('user');
        removeTyping('agent');
        pendingCardTarget = null;
        addToolChip(data.toolName);
        setStatus(`⚡ ${TOOL_LABELS[data.toolName] || data.toolName}...`, '');
    });

    socket.on('toolResult', (data) => {
        console.log('[Socket] Tool result:', data && data.toolName);
        resolveToolChip(data.toolName, data.result);
        queueToolResultCard(data.toolName, data.result);

        if (data.toolName === 'verifyOtpTool' && data.result && data.result.success) {
            isAuthenticated = true;
            updateSessionUI('authenticated');
        }
    });

    socket.on('streamComplete', () => {
        console.log('[Socket] Stream complete');
        isStreaming = false;
        stopAudioCapture();
        stopAudioPlayback();
        finalizeAllStreams();
        removeTyping('user');
        removeTyping('agent');
        setConnectionState(false);
        setStatus('Session ended (8 min limit). Tap mic to start a new conversation.', '');
        announceSessionEnded();
    });

    socket.on('sessionClosed', () => {
        console.log('[Socket] Session closed');
        const wasStreaming = isStreaming;
        isStreaming = false;
        stopAudioCapture();
        stopAudioPlayback();
        setConnectionState(false);
        setStatus('Tap microphone to start conversation', '');
        if (wasStreaming) {
            finalizeAllStreams();
            removeTyping('user');
            removeTyping('agent');
            announceSessionEnded();
        }
    });

    socket.on('error', (data) => {
        console.error('[Socket] Error:', data);
        addSystemMessage(`❌ Error: ${(data && (data.message || data.details)) || 'Unknown error'}`);
        setStatus('Session error — tap mic to retry', '');
        if (isStreaming) {
            isStreaming = false;
            stopAudioCapture();
            stopAudioPlayback();
            setConnectionState(false);
        }
    });
}

// ─── Conversation Control ───────────────────────────────────────────────────
function toggleConversation() {
    if (isStreaming) {
        stopConversation();
    } else {
        startConversation();
    }
}

function startConversation() {
    if (!socketConnected) {
        addSystemMessage('⚠️ Not connected to server. Please wait...');
        return;
    }
    if (isConnecting || isStreaming) return;

    isConnecting = true;
    const micBtn = document.getElementById('mic-btn');
    if (micBtn) micBtn.disabled = true;
    setStatus('Connecting to Nova Sonic...', '');

    socket.emit('initializeConnection', (response) => {
        if (response && response.success) {
            console.log('[App] Connection initialized, starting prompt...');
            socket.emit('promptStart', {});
            if (micBtn) micBtn.disabled = false;
        } else {
            console.error('[App] Failed to initialize:', response && response.error);
            isConnecting = false;
            if (micBtn) micBtn.disabled = false;
            setStatus('Failed to connect. Tap to retry.', '');
            addSystemMessage(`❌ Failed to initialize: ${(response && response.error) || 'Unknown error'}`);
        }
    });
}

function stopConversation() {
    console.log('[App] Stopping conversation');
    isStreaming = false;
    stopAudioCapture();
    stopAudioPlayback();
    finalizeAllStreams();
    removeTyping('user');
    removeTyping('agent');
    pendingToolResult = null;
    pendingCardTarget = null;

    if (socket) socket.emit('stopAudio');

    setConnectionState(false);
    setStatus('Tap microphone to start conversation', '');
    announceSessionEnded();
}

// ─── Text Chat ──────────────────────────────────────────────────────────────
function setChatEnabled(enabled) {
    const input = document.getElementById('chat-text');
    const sendBtn = document.getElementById('chat-send');
    if (input) input.disabled = !enabled;
    if (sendBtn) sendBtn.disabled = !enabled;
}

function sendTextMessage() {
    const input = document.getElementById('chat-text');
    if (!input) return;
    const text = input.value.trim();
    if (!text) return;

    if (!socketConnected) {
        addSystemMessage('⚠️ Not connected to server. Please wait...');
        return;
    }

    // Echo the user's message into the chat immediately.
    finalizeAllStreams();
    removeTyping('user');
    removeTyping('agent');
    appendTranscript('user', text);
    finalizeStream('user');
    input.value = '';

    if (isStreaming) {
        socket.emit('textInput', text);
        showTyping('agent');
    } else {
        // No active Nova Sonic session yet — queue the message and start one.
        pendingTextMessage = text;
        startConversation();
    }
}

function flushPendingTextMessage() {
    if (!pendingTextMessage) return;
    const text = pendingTextMessage;
    pendingTextMessage = null;
    if (socket && isStreaming) {
        socket.emit('textInput', text);
        showTyping('agent');
    }
}

// ─── Audio Capture (Microphone → PCM 16kHz) ─────────────────────────────────
async function startAudioCapture() {
    try {
        mediaStream = await navigator.mediaDevices.getUserMedia({
            audio: {
                sampleRate: 16000,
                channelCount: 1,
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true
            }
        });

        audioContext = new (window.AudioContext || window.webkitAudioContext)({
            sampleRate: 16000
        });

        const actualSampleRate = audioContext.sampleRate;
        console.log(`[Audio] Capture sample rate: ${actualSampleRate}`);

        sourceNode = audioContext.createMediaStreamSource(mediaStream);

        const bufferSize = 4096;
        scriptProcessor = audioContext.createScriptProcessor(bufferSize, 1, 1);

        scriptProcessor.onaudioprocess = (event) => {
            if (!isStreaming) return;

            const inputData = event.inputBuffer.getChannelData(0);

            // Detect voice energy for barge-in
            let energy = 0;
            for (let i = 0; i < inputData.length; i++) {
                energy += inputData[i] * inputData[i];
            }
            energy = Math.sqrt(energy / inputData.length);

            if (isPlaying && energy > BARGE_IN_THRESHOLD) {
                bargeInFrames++;
                if (bargeInFrames >= BARGE_IN_MIN_FRAMES) {
                    bargeIn();
                    bargeInFrames = 0;
                }
            } else {
                bargeInFrames = 0;
            }

            // Half-duplex: don't send mic audio while the agent is speaking
            if (isPlaying) return;

            let pcmData;
            if (actualSampleRate !== INPUT_SAMPLE_RATE) {
                pcmData = resampleTo16kHz(inputData, actualSampleRate);
            } else {
                pcmData = inputData;
            }

            const int16Data = float32ToInt16(pcmData);
            const base64 = arrayBufferToBase64(int16Data.buffer);
            socket.emit('audioInput', base64);
        };

        sourceNode.connect(scriptProcessor);
        scriptProcessor.connect(audioContext.destination);

        console.log('[Audio] Capture started');
    } catch (error) {
        console.error('[Audio] Capture error:', error);
        if (error.name === 'NotAllowedError') {
            addSystemMessage('⚠️ Microphone permission denied. Please allow microphone access and try again.');
        } else {
            addSystemMessage(`⚠️ Microphone error: ${error.message}`);
        }
    }
}

function stopAudioCapture() {
    if (scriptProcessor) {
        scriptProcessor.disconnect();
        scriptProcessor = null;
    }
    if (sourceNode) {
        sourceNode.disconnect();
        sourceNode = null;
    }
    if (audioContext && audioContext.state !== 'closed') {
        audioContext.close().catch(() => {});
        audioContext = null;
    }
    if (mediaStream) {
        mediaStream.getTracks().forEach(track => track.stop());
        mediaStream = null;
    }
    console.log('[Audio] Capture stopped');
}

// ─── Audio Playback (PCM 24kHz → Speaker) ───────────────────────────────────
function initPlaybackContext() {
    if (!playbackContext || playbackContext.state === 'closed') {
        playbackContext = new (window.AudioContext || window.webkitAudioContext)({
            sampleRate: OUTPUT_SAMPLE_RATE
        });
    }
    return playbackContext;
}

function queueAudioChunk(base64Data) {
    const ctx = initPlaybackContext();

    const binaryStr = atob(base64Data);
    const bytes = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) {
        bytes[i] = binaryStr.charCodeAt(i);
    }

    const int16Array = new Int16Array(bytes.buffer);
    const float32Array = new Float32Array(int16Array.length);
    for (let i = 0; i < int16Array.length; i++) {
        float32Array[i] = int16Array[i] / 32768.0;
    }

    const audioBuffer = ctx.createBuffer(1, float32Array.length, OUTPUT_SAMPLE_RATE);
    audioBuffer.getChannelData(0).set(float32Array);

    scheduleAudioBuffer(ctx, audioBuffer);
}

// Schedule one audio chunk to play back-to-back after previously scheduled chunks.
function scheduleAudioBuffer(ctx, buffer) {
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);

    const now = ctx.currentTime;
    let startTime = Math.max(now, nextPlayTime);
    if (pendingAgentGap) {
        startTime += AGENT_TURN_GAP;
        pendingAgentGap = false;
    }
    source.start(startTime);
    nextPlayTime = startTime + buffer.duration;

    isPlaying = true;
    scheduledSources.add(source);

    source.onended = () => {
        scheduledSources.delete(source);
        if (scheduledSources.size === 0) {
            isPlaying = false;
            nextPlayTime = 0;
            if (isStreaming) {
                setMicState('listening');
                setStatus('🎤 Listening — say hello or ask about your account', 'active');
                finalizeStream('agent');
                removeTyping('agent');
                if (!streamBubbles.user) showTyping('user');
            }
        }
    };
}

function stopAllScheduledSources() {
    scheduledSources.forEach((src) => {
        try {
            src.onended = null;
            src.stop();
        } catch (_e) { /* may already be stopped */ }
    });
    scheduledSources.clear();
    isPlaying = false;
    nextPlayTime = 0;
    pendingAgentGap = false;
}

function stopAudioPlayback() {
    stopAllScheduledSources();
    if (playbackContext && playbackContext.state !== 'closed') {
        playbackContext.close().catch(() => {});
        playbackContext = null;
    }
}

function bargeIn() {
    if (!isPlaying && scheduledSources.size === 0) return;
    console.log('[Audio] Barge-in — stopping playback immediately');
    stopAllScheduledSources();
    setMicState('listening');
    setStatus('🎤 Listening — say hello or ask about your account', 'active');
}

// ─── Connection / mic UI state ──────────────────────────────────────────────
function setConnectionState(streaming) {
    isStreaming = streaming;
    const dot = document.getElementById('connection-dot');
    const label = document.getElementById('connection-label');
    const micBtn = document.getElementById('mic-btn');
    const waveform = document.getElementById('waveform');

    if (streaming) {
        if (dot) dot.className = 'connection-dot connected';
        if (label) label.textContent = 'Connected to Sahayak';
        if (micBtn) {
            micBtn.classList.add('listening', 'in-call');
            micBtn.title = 'End conversation';
        }
        if (waveform) waveform.classList.add('active');
        startCallTimer();
    } else {
        if (dot) dot.className = 'connection-dot';
        if (label) label.textContent = 'Disconnected';
        if (micBtn) {
            micBtn.classList.remove('listening', 'speaking', 'in-call');
            micBtn.title = 'Start conversation';
        }
        if (waveform) waveform.classList.remove('active', 'speaking');
        stopCallTimer();
    }
}

// ─── Call timer (top-left, visible only while a call is active) ────────────
function startCallTimer() {
    if (callTimerInterval) return; // already running
    callStartTime = Date.now();
    updateCallTimerDisplay();
    callTimerInterval = setInterval(updateCallTimerDisplay, 1000);
    const timerEl = document.getElementById('call-timer');
    if (timerEl) timerEl.classList.add('visible');
}

function stopCallTimer() {
    if (callTimerInterval) {
        clearInterval(callTimerInterval);
        callTimerInterval = null;
    }
    callStartTime = null;
    const timerEl = document.getElementById('call-timer');
    if (timerEl) timerEl.classList.remove('visible');
    const valueEl = document.getElementById('call-timer-value');
    if (valueEl) valueEl.textContent = '00:00';
}

// Show the "session ended" system message at most once per call.
function announceSessionEnded() {
    if (sessionEndedAnnounced) return;
    sessionEndedAnnounced = true;
    addSystemMessage('Session ended. Tap the microphone to start a new conversation.');
}

function updateCallTimerDisplay() {
    if (!callStartTime) return;
    const valueEl = document.getElementById('call-timer-value');
    if (!valueEl) return;
    const elapsedSec = Math.floor((Date.now() - callStartTime) / 1000);
    const mins = Math.floor(elapsedSec / 60).toString().padStart(2, '0');
    const secs = (elapsedSec % 60).toString().padStart(2, '0');
    valueEl.textContent = `${mins}:${secs}`;
}

function setMicState(state) {
    const micBtn = document.getElementById('mic-btn');
    const waveform = document.getElementById('waveform');
    if (!micBtn || !waveform) return;
    micBtn.classList.remove('listening', 'speaking');
    waveform.classList.remove('speaking');

    if (state === 'listening') {
        micBtn.classList.add('listening');
        waveform.classList.add('active');
    } else if (state === 'speaking') {
        micBtn.classList.add('speaking');
        waveform.classList.add('active', 'speaking');
    }
}

function setStatus(text, className) {
    const el = document.getElementById('status-text');
    if (!el) return;
    el.textContent = text;
    el.className = 'status-text ' + (className || '');
}

function updateSessionUI(state) {
    const dot = document.getElementById('session-dot');
    const label = document.getElementById('session-label');
    if (!dot || !label) return;
    switch (state) {
        case 'authenticated':
            dot.className = 'dot authenticated';
            label.textContent = 'Authenticated';
            break;
        default:
            dot.className = 'dot unauthenticated';
            label.textContent = 'Not authenticated';
            break;
    }
}

// ─── Chat: typing indicators + streaming bubbles ────────────────────────────
function showTyping(role) {
    if (typingBubbles[role] || streamBubbles[role]) return;
    const chatArea = document.getElementById('chat-area');
    const el = document.createElement('div');
    el.className = `message ${role} typing message-enter-${role}`;
    el.innerHTML = `
        <div class="label">${role === 'user' ? 'You' : 'Agent'}</div>
        <div class="typing-dots"><span class="dot"></span><span class="dot"></span><span class="dot"></span></div>
    `;
    chatArea.appendChild(el);
    chatArea.scrollTop = chatArea.scrollHeight;
    typingBubbles[role] = el;
}

function removeTyping(role) {
    if (typingBubbles[role]) {
        typingBubbles[role].remove();
        typingBubbles[role] = null;
    }
}

function appendTranscript(role, text) {
    if (!text) return;
    removeTyping(role);

    const otherRole = role === 'user' ? 'agent' : 'user';
    finalizeStream(otherRole);
    removeTyping(otherRole);

    const chatArea = document.getElementById('chat-area');
    let bubble = streamBubbles[role];

    if (!bubble) {
        const el = document.createElement('div');
        el.className = `message ${role} streaming message-enter-${role}`;
        const label = document.createElement('div');
        label.className = 'label';
        label.textContent = role === 'user' ? 'You' : 'Agent';
        const body = document.createElement('span');
        body.className = 'text-body';
        const cursor = document.createElement('span');
        cursor.className = 'stream-cursor';
        el.appendChild(label);
        el.appendChild(body);
        el.appendChild(cursor);
        chatArea.appendChild(el);
        bubble = { el, body, cursor, raw: '' };
        streamBubbles[role] = bubble;
        if (role === 'user') {
            pendingCardTarget = null;
        } else {
            pendingCardTarget = el;
        }
    }

    // Deltas arrive token-by-token — concatenate raw, don't inject spaces.
    bubble.raw += text;
    bubble.body.textContent = bubble.raw;
    chatArea.scrollTop = chatArea.scrollHeight;
}

function finalizeStream(role) {
    const bubble = streamBubbles[role];
    if (bubble) {
        bubble.cursor.remove();
        bubble.el.classList.remove('streaming');
        bubble.body.innerHTML = formatResponseText(bubble.raw);
        if (role === 'agent') {
            pendingCardTarget = bubble.el;
            flushPendingToolCard();
        }
        streamBubbles[role] = null;
    }
}

function finalizeAllStreams() {
    finalizeStream('user');
    finalizeStream('agent');
}

function addSystemMessage(text) {
    finalizeAllStreams();
    removeTyping('user');
    removeTyping('agent');
    const chatArea = document.getElementById('chat-area');
    const msg = document.createElement('div');
    msg.className = 'system-message';
    msg.textContent = text;
    chatArea.appendChild(msg);
    chatArea.scrollTop = chatArea.scrollHeight;
}

// ─── Tool-call chip (pending → ok/fail) ─────────────────────────────────────
function addToolChip(tool) {
    const chatArea = document.getElementById('chat-area');
    const wrap = document.createElement('div');
    wrap.className = 'tool-chip-wrap';
    wrap.innerHTML = `
        <span class="tool-chip pending">
            <span class="spinner"></span>
            <span class="chip-text">${TOOL_LABELS[tool] || tool}</span>
        </span>
    `;
    chatArea.appendChild(wrap);
    chatArea.scrollTop = chatArea.scrollHeight;
    currentToolChip = { wrap, tool };
}

function resolveToolChip(tool, result) {
    if (!currentToolChip) return;
    const ok = result && !result.error;
    const chip = currentToolChip.wrap.querySelector('.tool-chip');
    if (!chip) return;

    chip.classList.remove('pending');
    chip.classList.add(ok ? 'ok' : 'fail', 'tool-chip-swap');
    chip.innerHTML = `
        <span>${ok ? '✅' : '⚠️'}</span>
        <span class="chip-text">${ok ? (TOOL_LABELS[tool] || tool) + ' done' : escapeHtml((result && result.error) || 'Failed')}</span>
    `;
    currentToolChip = null;
}

// ─── Data cards: rendered below agent text in each reply ───────────────────
function queueToolResultCard(tool, result) {
    pendingToolResult = { tool, result };
    if (!streamBubbles.agent && pendingCardTarget) {
        flushPendingToolCard();
    }
}

function flushPendingToolCard() {
    if (!pendingToolResult || !pendingCardTarget) return;
    const { tool, result } = pendingToolResult;
    pendingToolResult = null;
    renderToolResultCard(tool, result, pendingCardTarget);
}

function wrapAgentReply(agentEl) {
    if (agentEl.parentElement && agentEl.parentElement.classList.contains('agent-reply')) {
        return agentEl.parentElement;
    }
    const group = document.createElement('div');
    group.className = 'agent-reply';
    agentEl.parentNode.insertBefore(group, agentEl);
    group.appendChild(agentEl);
    return group;
}

function renderToolResultCard(tool, result, agentEl) {
    if (!result) return;

    const chatArea = document.getElementById('chat-area');
    const card = document.createElement('div');
    card.className = 'data-card';

    if (result.error) {
        card.classList.add('data-card-error');
        card.innerHTML = `
            <div class="card-header">
                <span class="card-title">⚠️ ${escapeHtml(TOOL_LABELS[tool] || tool)}</span>
            </div>
            <div class="card-empty">${escapeHtml(result.error)}</div>
        `;
    } else {
        switch (tool) {
            case 'verifyAadhaarTool':
                card.innerHTML = verifyAadhaarCardHtml(result);
                break;
            case 'verifyOtpTool':
                card.innerHTML = verifyOtpCardHtml(result);
                break;
            case 'checkBalanceTool':
                card.innerHTML = balanceCardHtml(result);
                break;
            case 'getFdQuoteTool':
                card.innerHTML = fdQuoteCardHtml(result);
                break;
            case 'bookFdTool':
                card.innerHTML = bookFdCardHtml(result);
                break;
            case 'withdrawCashTool':
                card.innerHTML = withdrawCardHtml(result);
                break;
            default:
                return;
        }
    }

    if (agentEl) {
        const group = wrapAgentReply(agentEl);
        group.appendChild(card);
    } else {
        chatArea.appendChild(card);
    }
    chatArea.scrollTop = chatArea.scrollHeight;
}

function verifyAadhaarCardHtml(r) {
    return `
        <div class="card-header">
            <span class="card-title">🔐 Identity Check</span>
            <span class="card-badge">${escapeHtml(r.customerId || '')}</span>
        </div>
        <div class="card-hero" style="font-size:1.15rem;">${escapeHtml(r.maskedName || '—')}</div>
        <div class="stat-grid">
            <div class="stat"><div class="stat-label">OTP Sent To</div><div class="stat-value">${escapeHtml(r.maskedMobile || '—')}</div></div>
        </div>
    `;
}

function verifyOtpCardHtml(r) {
    return `
        <div class="card-header">
            <span class="card-title">✅ Authenticated</span>
        </div>
        <div class="card-hero" style="font-size:1.2rem;">${escapeHtml(r.customerName || '—')}</div>
        <div class="card-empty" style="text-align:left; padding:0;">You're verified and ready to bank.</div>
    `;
}

function balanceCardHtml(r) {
    const accounts = r.accounts || [];
    const rows = accounts.map(a => `
        <div class="acct-row">
            <span class="acct-type">${escapeHtml(a.type || '')}</span>
            <span class="acct-mid">${escapeHtml(a.accountId || '')}</span>
            <span class="acct-value">${formatRupees(a.balance)}</span>
        </div>
    `).join('');
    const count = r.accountCount || accounts.length;
    return `
        <div class="card-header">
            <span class="card-title">💰 Account Balance</span>
            <span class="card-badge">${count} account${count === 1 ? '' : 's'}</span>
        </div>
        <div class="card-hero">${formatRupees(r.totalBalance)}<span class="hero-sub">total</span></div>
        <div class="acct-list">${rows}</div>
    `;
}

function fdQuoteCardHtml(r) {
    return `
        <div class="card-header">
            <span class="card-title">📈 Fixed Deposit Quote</span>
        </div>
        <div class="card-hero">${formatRupees(r.maturityAmount)}<span class="hero-sub">at maturity</span></div>
        <div class="stat-grid">
            <div class="stat"><div class="stat-label">Principal</div><div class="stat-value">${formatRupees(r.principal)}</div></div>
            <div class="stat"><div class="stat-label">Tenure</div><div class="stat-value">${r.tenureMonths} mo</div></div>
            <div class="stat"><div class="stat-label">Rate</div><div class="stat-value">${r.rate}% p.a.</div></div>
            <div class="stat success"><div class="stat-label">Interest Earned</div><div class="stat-value">${formatRupees(r.interestEarned)}</div></div>
            <div class="stat"><div class="stat-label">Matures On</div><div class="stat-value">${formatDate(r.maturityDate)}</div></div>
        </div>
    `;
}

function bookFdCardHtml(r) {
    const isDigital = r.route === 'DIGITAL';
    const routeStat = isDigital
        ? `<div class="stat success"><div class="stat-label">New Balance</div><div class="stat-value">${formatRupees(r.newBalance)}</div></div>`
        : `<div class="stat warning"><div class="stat-label">Counter Token</div><div class="stat-value">${escapeHtml(r.counterToken || '—')}</div></div>`;
    return `
        <div class="card-header">
            <span class="card-title">📈 Fixed Deposit ${isDigital ? 'Opened' : 'Prepared'}</span>
            <span class="card-badge">${escapeHtml(r.fdRefNo || '')}</span>
        </div>
        <div class="card-hero">${formatRupees(r.principal)}<span class="hero-sub">principal</span></div>
        <div class="stat-grid">
            <div class="stat"><div class="stat-label">Tenure</div><div class="stat-value">${r.tenureMonths} mo</div></div>
            <div class="stat"><div class="stat-label">Rate</div><div class="stat-value">${r.rate}% p.a.</div></div>
            <div class="stat"><div class="stat-label">Maturity Value</div><div class="stat-value">${formatRupees(r.maturityAmount)}</div></div>
            <div class="stat"><div class="stat-label">Matures On</div><div class="stat-value">${formatDate(r.maturityDate)}</div></div>
            ${routeStat}
        </div>
    `;
}

function withdrawCardHtml(r) {
    const dispensed = r.status === 'DISPENSED';
    const routeStat = dispensed
        ? `<div class="stat success"><div class="stat-label">New Balance</div><div class="stat-value">${formatRupees(r.newBalance)}</div></div>`
        : `<div class="stat warning"><div class="stat-label">Counter Token</div><div class="stat-value">${escapeHtml(r.counterToken || '—')}</div></div>`;
    return `
        <div class="card-header">
            <span class="card-title">💸 Withdrawal</span>
            <span class="card-badge">${escapeHtml((r.status || '').replace('_', ' '))}</span>
        </div>
        <div class="card-hero">${formatRupees(r.amount)}<span class="hero-sub">${dispensed ? 'dispensed' : 'requested'}</span></div>
        <div class="stat-grid">
            <div class="stat"><div class="stat-label">Reference</div><div class="stat-value" style="font-size:0.75rem;">${escapeHtml(r.txnRef || '—')}</div></div>
            ${routeStat}
        </div>
    `;
}

// ─── Formatting helpers ──────────────────────────────────────────────────────
function formatRupees(amount) {
    if (amount === undefined || amount === null || isNaN(amount)) return '—';
    const n = Math.round(Number(amount));
    const s = Math.abs(n).toString();
    let formatted;
    if (s.length <= 3) {
        formatted = s;
    } else {
        const last3 = s.slice(-3);
        let rest = s.slice(0, -3);
        const parts = [];
        while (rest.length > 2) {
            parts.unshift(rest.slice(-2));
            rest = rest.slice(0, -2);
        }
        if (rest) parts.unshift(rest);
        formatted = parts.join(',') + ',' + last3;
    }
    return (n < 0 ? '-₹' : '₹') + formatted;
}

function formatDate(iso) {
    if (!iso) return '—';
    try {
        const d = new Date(iso);
        return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
    } catch (e) {
        return iso;
    }
}

function formatResponseText(text) {
    return escapeHtml(text)
        .replace(/(FD|TXN|TKN|FORM|TASK|FDREF)[A-Z0-9]+/g, '<code>$&</code>')
        .replace(/₹[\d,]+/g, '<strong>$&</strong>')
        .replace(/Counter \d+/gi, '<strong>$&</strong>');
}

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str == null ? '' : String(str);
    return div.innerHTML;
}

// Nova Sonic occasionally pushes JSON control markers (e.g. `{"interrupted":true}`)
// through the same textOutput channel as real transcript text — detect and skip them.
function isControlSignal(text) {
    if (typeof text !== 'string') return false;
    const trimmed = text.trim();
    if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return false;
    try {
        const parsed = JSON.parse(trimmed);
        return !!parsed && typeof parsed === 'object' && !Array.isArray(parsed) &&
            ('interrupted' in parsed || 'stopReason' in parsed);
    } catch (e) {
        return false;
    }
}

// ─── Audio / byte utilities ──────────────────────────────────────────────────
function float32ToInt16(float32Array) {
    const int16Array = new Int16Array(float32Array.length);
    for (let i = 0; i < float32Array.length; i++) {
        const s = Math.max(-1, Math.min(1, float32Array[i]));
        int16Array[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    return int16Array;
}

function resampleTo16kHz(inputData, inputSampleRate) {
    const ratio = inputSampleRate / INPUT_SAMPLE_RATE;
    const outputLength = Math.floor(inputData.length / ratio);
    const output = new Float32Array(outputLength);

    for (let i = 0; i < outputLength; i++) {
        const srcIndex = i * ratio;
        const srcIndexFloor = Math.floor(srcIndex);
        const srcIndexCeil = Math.min(srcIndexFloor + 1, inputData.length - 1);
        const fraction = srcIndex - srcIndexFloor;
        output[i] = inputData[srcIndexFloor] * (1 - fraction) + inputData[srcIndexCeil] * fraction;
    }

    return output;
}

function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    const chunkSize = 8192;
    for (let i = 0; i < bytes.length; i += chunkSize) {
        const chunk = bytes.subarray(i, i + chunkSize);
        binary += String.fromCharCode.apply(null, chunk);
    }
    return btoa(binary);
}

// ─── Page intro: mic drop → welcome ──────────────────────────────────────────
function initIntroAnimation() {
    const micWrap = document.getElementById('mic-wrap');
    const welcomeMsg = document.getElementById('welcome-msg');
    const statusText = document.getElementById('status-text');
    const connectionIndicator = document.getElementById('connection-indicator');
    const chatInput = document.getElementById('chat-input');
    const waveform = document.getElementById('waveform');
    const controls = document.getElementById('controls');

    if (!micWrap) return;

    const reveal = (el, extraClass) => {
        if (!el) return;
        el.classList.remove('intro-hidden');
        if (extraClass) el.classList.add(extraClass);
        el.classList.add('reveal');
    };

    const onMicLanded = () => {
        micWrap.classList.remove('intro-drop');
        micWrap.classList.add('landed');
        if (controls) controls.classList.remove('controls-intro');

        setTimeout(() => reveal(statusText), 200);
        setTimeout(() => reveal(waveform), 300);
        setTimeout(() => {
            if (welcomeMsg) {
                welcomeMsg.classList.remove('intro-hidden');
                welcomeMsg.classList.add('message-enter-agent');
            }
        }, 550);
        setTimeout(() => reveal(connectionIndicator), 800);
        setTimeout(() => reveal(chatInput), 950);
    };

    const reducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reducedMotion) {
        micWrap.classList.remove('intro-drop');
        onMicLanded();
        if (welcomeMsg) welcomeMsg.classList.add('message-enter-agent');
        return;
    }

    micWrap.addEventListener('animationend', onMicLanded, { once: true });

    setTimeout(() => {
        if (micWrap.classList.contains('intro-drop')) {
            onMicLanded();
        }
    }, 1900);
}

// ─── Init ────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    initTheme();
    initIntroAnimation();
    initSocket();

    const micBtn = document.getElementById('mic-btn');
    if (micBtn) micBtn.addEventListener('click', toggleConversation);

    const chatForm = document.getElementById('chat-input');
    if (chatForm) {
        chatForm.addEventListener('submit', (e) => {
            e.preventDefault();
            sendTextMessage();
        });
    }
});
