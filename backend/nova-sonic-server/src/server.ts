import express from 'express';
import http from 'http';
import path from 'path';
import { Server } from 'socket.io';
import { fromNodeProviderChain } from "@aws-sdk/credential-providers";
import { NovaSonicBidirectionalStreamClient, StreamSession } from './client';
import { processToolUse } from './tool-handlers';
import { FORMS_DIR } from './form-generator';
import { isRealOtpEnabled } from './otp-service';
import { BankingTools } from './tools';
import { SahayakSystemPrompt } from './consts';
import { SessionState } from './types';
import { Buffer } from 'node:buffer';
import dotenv from 'dotenv';

dotenv.config();

// ─── Express & Socket.IO Setup ────────────────────────────────────────────────

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  },
  maxHttpBufferSize: 1e7 // 10MB for audio chunks
});

// ─── Nova Sonic Client ────────────────────────────────────────────────────────

const REGION = process.env.AWS_REGION || "us-east-1";

const bedrockClient = new NovaSonicBidirectionalStreamClient({
  requestHandlerConfig: {
    maxConcurrentStreams: 10,
  },
  clientConfig: {
    region: REGION,
    credentials: fromNodeProviderChain()
  }
});

// Register the banking tool handler
bedrockClient.setToolHandler(async (toolName: string, toolInput: any, sessionState: SessionState) => {
  const result = await processToolUse(toolName, toolInput, sessionState);

  // If OTP verification succeeded, update the session state in the client
  if (toolName === 'verifyOtpTool' && result.success) {
    // sessionState is mutated by processToolUse, so it's already updated
    console.log(`[Server] Authentication successful for customer: ${sessionState.customerId}`);
  }

  return result;
});

// ─── Session Tracking ─────────────────────────────────────────────────────────

const socketSessions = new Map<string, StreamSession>();

enum SocketSessionState {
  INITIALIZING = 'initializing',
  READY = 'ready',
  ACTIVE = 'active',
  CLOSED = 'closed'
}

const sessionStates = new Map<string, SocketSessionState>();
const cleanupInProgress = new Map<string, boolean>();

// ─── Periodic Cleanup ─────────────────────────────────────────────────────────

setInterval(() => {
  const now = Date.now();
  bedrockClient.getActiveSessions().forEach(sessionId => {
    const lastActivity = bedrockClient.getLastActivityTime(sessionId);
    // Close sessions inactive for 5 minutes
    if (now - lastActivity > 5 * 60 * 1000) {
      console.log(`[Cleanup] Closing inactive session ${sessionId}`);
      try {
        bedrockClient.forceCloseSession(sessionId);
        socketSessions.delete(sessionId);
        sessionStates.set(sessionId, SocketSessionState.CLOSED);
      } catch (error) {
        console.error(`[Cleanup] Error closing session ${sessionId}:`, error);
      }
    }
  });
}, 60000);

// ─── Static Files ─────────────────────────────────────────────────────────────

// Serve frontend from the project's frontend directory
const frontendPath = path.resolve(__dirname, '..', '..', '..', 'frontend');
app.use(express.static(frontendPath));
console.log(`[Server] Serving frontend from: ${frontendPath}`);

// Serve generated FD/withdrawal forms so the browser can open or download them.
app.use('/forms', express.static(FORMS_DIR));
console.log(`[Server] Serving generated forms from: ${FORMS_DIR}`);

// ─── Health Check ─────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => {
  const activeSessions = bedrockClient.getActiveSessions().length;
  res.status(200).json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    service: 'sahayak-nova-sonic-server',
    activeSessions,
    region: REGION
  });
});

// ─── Helper: Create & Setup Session ───────────────────────────────────────────

function setupSessionEventHandlers(session: StreamSession, socket: any): void {
  session.onEvent('contentStart', (data) => {
    console.log(`[${socket.id}] contentStart:`, data.type);
    socket.emit('contentStart', data);
  });

  session.onEvent('textOutput', (data) => {
    socket.emit('textOutput', data);
  });

  session.onEvent('audioOutput', (data) => {
    socket.emit('audioOutput', data);
  });

  session.onEvent('toolUse', (data) => {
    console.log(`[${socket.id}] Tool use: ${data.toolName}`);
    socket.emit('toolUse', data);
  });

  session.onEvent('toolEnd', (data) => {
    console.log(`[${socket.id}] Tool end: ${data.toolName}`);
    socket.emit('toolEnd', data);
  });

  session.onEvent('toolResult', (data) => {
    console.log(`[${socket.id}] Tool result for: ${data.toolName}`);
    socket.emit('toolResult', data);
  });

  session.onEvent('contentEnd', (data) => {
    socket.emit('contentEnd', data);
  });

  session.onEvent('error', (data) => {
    console.error(`[${socket.id}] Stream error:`, data);
    socket.emit('error', data);
  });

  session.onEvent('streamComplete', () => {
    console.log(`[${socket.id}] Stream complete`);
    socket.emit('streamComplete');
    sessionStates.set(socket.id, SocketSessionState.CLOSED);
  });
}

async function createNewSession(socket: any): Promise<StreamSession> {
  const sessionId = socket.id;

  console.log(`[Server] Creating session for: ${sessionId}`);
  sessionStates.set(sessionId, SocketSessionState.INITIALIZING);

  const session = bedrockClient.createStreamSession(sessionId);
  setupSessionEventHandlers(session, socket);

  socketSessions.set(sessionId, session);
  sessionStates.set(sessionId, SocketSessionState.READY);

  return session;
}

// ─── Socket.IO Connection Handler ─────────────────────────────────────────────

io.on('connection', (socket) => {
  console.log(`[Server] Client connected: ${socket.id}`);
  sessionStates.set(socket.id, SocketSessionState.CLOSED);

  // ── Initialize Connection ──────────────────────────────────────────────────

  socket.on('initializeConnection', async (callback) => {
    try {
      const currentState = sessionStates.get(socket.id);
      if (currentState === SocketSessionState.ACTIVE || currentState === SocketSessionState.READY) {
        console.log(`[${socket.id}] Session already active`);
        if (callback) callback({ success: true });
        return;
      }

      await createNewSession(socket);

      // Start the bidirectional stream (non-blocking)
      bedrockClient.initiateBidirectionalStreaming(socket.id);
      sessionStates.set(socket.id, SocketSessionState.ACTIVE);

      if (callback) callback({ success: true });
    } catch (error) {
      console.error(`[${socket.id}] Error initializing:`, error);
      sessionStates.set(socket.id, SocketSessionState.CLOSED);
      if (callback) callback({
        success: false,
        error: error instanceof Error ? error.message : String(error)
      });
      socket.emit('error', {
        message: 'Failed to initialize session',
        details: error instanceof Error ? error.message : String(error)
      });
    }
  });

  // ── Prompt Start (setup session, system prompt, audio) ─────────────────────

  socket.on('promptStart', async (data) => {
    try {
      const session = socketSessions.get(socket.id);
      if (!session) {
        socket.emit('error', { message: 'No active session for prompt start' });
        return;
      }

      const systemPrompt = data?.systemPrompt || SahayakSystemPrompt;

      await session.setupSessionAndPromptStart(BankingTools);
      await session.setupSystemPrompt(undefined, systemPrompt);
      await session.setupStartAudio();

      console.log(`[${socket.id}] Prompt setup complete`);
      socket.emit('audioReady');
    } catch (error) {
      console.error(`[${socket.id}] Error in promptStart:`, error);
      socket.emit('error', {
        message: 'Error setting up prompt',
        details: error instanceof Error ? error.message : String(error)
      });
    }
  });

  // ── Audio Input ────────────────────────────────────────────────────────────

  socket.on('audioInput', async (audioData) => {
    try {
      const session = socketSessions.get(socket.id);
      const currentState = sessionStates.get(socket.id);

      if (!session || currentState !== SocketSessionState.ACTIVE) {
        return; // Silently drop audio if session isn't active
      }

      const audioBuffer = typeof audioData === 'string'
        ? Buffer.from(audioData, 'base64')
        : Buffer.from(audioData);

      await session.streamAudio(audioBuffer);
    } catch (error) {
      console.error(`[${socket.id}] Error processing audio:`, error);
    }
  });

  // ── Text Input ─────────────────────────────────────────────────────────────

  socket.on('textInput', async (text: string) => {
    try {
      const session = socketSessions.get(socket.id);
      const currentState = sessionStates.get(socket.id);

      if (!session || currentState !== SocketSessionState.ACTIVE) {
        socket.emit('error', { message: 'No active session for text input' });
        return;
      }

      console.log(`[${socket.id}] Text input: "${text}"`);
      await session.sendTextInput(text);
    } catch (error) {
      console.error(`[${socket.id}] Error processing text input:`, error);
      socket.emit('error', {
        message: 'Error processing text input',
        details: error instanceof Error ? error.message : String(error)
      });
    }
  });

  // ── Stop Audio / End Session ───────────────────────────────────────────────

  socket.on('stopAudio', async () => {
    try {
      const session = socketSessions.get(socket.id);
      if (!session || cleanupInProgress.get(socket.id)) {
        return;
      }

      console.log(`[${socket.id}] Stop audio requested`);
      cleanupInProgress.set(socket.id, true);
      sessionStates.set(socket.id, SocketSessionState.CLOSED);

      const cleanupPromise = Promise.race([
        (async () => {
          await session.endAudioContent();
          await session.endPrompt();
          await session.close();
        })(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Session cleanup timeout')), 5000)
        )
      ]);

      await cleanupPromise;

      socketSessions.delete(socket.id);
      cleanupInProgress.delete(socket.id);
      socket.emit('sessionClosed');
      console.log(`[${socket.id}] Session closed cleanly`);
    } catch (error) {
      console.error(`[${socket.id}] Error stopping audio:`, error);
      try {
        bedrockClient.forceCloseSession(socket.id);
      } catch (_e) { /* ignore */ }
      socketSessions.delete(socket.id);
      cleanupInProgress.delete(socket.id);
      sessionStates.set(socket.id, SocketSessionState.CLOSED);
      socket.emit('sessionClosed');
    }
  });

  // ── Get Session State ──────────────────────────────────────────────────────

  socket.on('getSessionState', (callback) => {
    const state = bedrockClient.getSessionState(socket.id);
    if (callback) callback(state);
  });

  // ── Disconnect ─────────────────────────────────────────────────────────────

  socket.on('disconnect', async () => {
    console.log(`[Server] Client disconnected: ${socket.id}`);

    const session = socketSessions.get(socket.id);
    if (session && bedrockClient.isSessionActive(socket.id) && !cleanupInProgress.get(socket.id)) {
      try {
        cleanupInProgress.set(socket.id, true);
        const cleanupPromise = Promise.race([
          (async () => {
            await session.endAudioContent();
            await session.endPrompt();
            await session.close();
          })(),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Disconnect cleanup timeout')), 3000)
          )
        ]);
        await cleanupPromise;
      } catch (error) {
        console.error(`[${socket.id}] Error cleaning up on disconnect:`, error);
        try {
          bedrockClient.forceCloseSession(socket.id);
        } catch (_e) { /* ignore */ }
      }
    }

    socketSessions.delete(socket.id);
    sessionStates.delete(socket.id);
    cleanupInProgress.delete(socket.id);
  });
});

// ─── Start Server ─────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n========================================`);
  console.log(`  Sahayak Nova Sonic Server`);
  console.log(`  Port: ${PORT}`);
  console.log(`  Region: ${REGION}`);
  console.log(`  Health: http://localhost:${PORT}/health`);
  console.log(`  Frontend: http://localhost:${PORT}`);
  console.log(`  OTP mode: ${isRealOtpEnabled() ? 'REAL (Twilio Verify SMS)' : 'MOCK (demoOtp from customers.json)'}`);
  console.log(`========================================\n`);
});

// ─── Graceful Shutdown ────────────────────────────────────────────────────────

process.on('SIGINT', async () => {
  console.log('\n[Server] Shutting down...');

  const forceExitTimer = setTimeout(() => {
    console.error('[Server] Forcing shutdown');
    process.exit(1);
  }, 5000);

  try {
    // Close all active sessions
    const activeSessions = bedrockClient.getActiveSessions();
    console.log(`[Server] Closing ${activeSessions.length} active sessions...`);

    await Promise.all(activeSessions.map(async (sessionId) => {
      try {
        await bedrockClient.closeSession(sessionId);
      } catch (_error) {
        bedrockClient.forceCloseSession(sessionId);
      }
    }));

    await new Promise<void>(resolve => io.close(() => resolve()));
    await new Promise<void>(resolve => server.close(() => resolve()));

    clearTimeout(forceExitTimer);
    console.log('[Server] Shut down gracefully');
    process.exit(0);
  } catch (error) {
    console.error('[Server] Error during shutdown:', error);
    process.exit(1);
  }
});

export { app, server, io };
