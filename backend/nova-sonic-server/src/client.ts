import {
  BedrockRuntimeClient,
  BedrockRuntimeClientConfig,
  InvokeModelWithBidirectionalStreamCommand,
  InvokeModelWithBidirectionalStreamInput,
} from "@aws-sdk/client-bedrock-runtime";
import {
  NodeHttp2Handler,
  NodeHttp2HandlerOptions,
} from "@smithy/node-http-handler";
import { Provider } from "@smithy/types";
import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { Subject } from 'rxjs';
import { take } from 'rxjs/operators';
import { firstValueFrom } from 'rxjs';
import {
  InferenceConfig,
  AudioInputConfiguration,
  AudioOutputConfiguration,
  TextConfiguration,
  ToolSpec,
  ToolHandler,
  SessionState,
} from "./types";
import {
  DefaultAudioInputConfiguration,
  DefaultAudioOutputConfiguration,
  DefaultInferenceConfig,
  DefaultTextConfiguration,
  SahayakSystemPrompt,
} from "./consts";

// ─── Client Config ────────────────────────────────────────────────────────────

export interface NovaSonicClientConfig {
  requestHandlerConfig?: NodeHttp2HandlerOptions | Provider<NodeHttp2HandlerOptions | void>;
  clientConfig: Partial<BedrockRuntimeClientConfig>;
  inferenceConfig?: InferenceConfig;
}

// ─── Stream Session ───────────────────────────────────────────────────────────

export class StreamSession {
  private audioBufferQueue: Buffer[] = [];
  private maxQueueSize = 200;
  private isProcessingAudio = false;
  private isActive = true;

  constructor(
    private sessionId: string,
    private client: NovaSonicBidirectionalStreamClient
  ) {}

  public onEvent(eventType: string, handler: (data: any) => void): StreamSession {
    this.client.registerEventHandler(this.sessionId, eventType, handler);
    return this;
  }

  public async setupSessionAndPromptStart(tools: ToolSpec[]): Promise<void> {
    this.client.setupSessionStartEvent(this.sessionId);
    this.client.setupPromptStartEvent(this.sessionId, tools);
  }

  public async setupSystemPrompt(
    textConfig: TextConfiguration = DefaultTextConfiguration,
    systemPromptContent: string = SahayakSystemPrompt
  ): Promise<void> {
    this.client.setupSystemPromptEvent(this.sessionId, textConfig, systemPromptContent);
  }

  public async setupStartAudio(
    audioConfig: AudioInputConfiguration = DefaultAudioInputConfiguration
  ): Promise<void> {
    this.client.setupStartAudioEvent(this.sessionId, audioConfig);
  }

  public async streamAudio(audioData: Buffer): Promise<void> {
    if (this.audioBufferQueue.length >= this.maxQueueSize) {
      this.audioBufferQueue.shift();
    }
    this.audioBufferQueue.push(audioData);
    this.processAudioQueue();
  }

  private async processAudioQueue() {
    if (this.isProcessingAudio || this.audioBufferQueue.length === 0 || !this.isActive) return;

    this.isProcessingAudio = true;
    try {
      let processedChunks = 0;
      const maxChunksPerBatch = 5;

      while (this.audioBufferQueue.length > 0 && processedChunks < maxChunksPerBatch && this.isActive) {
        const audioChunk = this.audioBufferQueue.shift();
        if (audioChunk) {
          await this.client.streamAudioChunk(this.sessionId, audioChunk);
          processedChunks++;
        }
      }
    } finally {
      this.isProcessingAudio = false;
      if (this.audioBufferQueue.length > 0 && this.isActive) {
        setTimeout(() => this.processAudioQueue(), 0);
      }
    }
  }

  public async sendTextInput(text: string): Promise<void> {
    if (!this.isActive) return;
    await this.client.sendTextContent(this.sessionId, text);
  }

  public getSessionId(): string {
    return this.sessionId;
  }

  public async endAudioContent(): Promise<void> {
    if (!this.isActive) return;
    await this.client.sendContentEnd(this.sessionId);
  }

  public async endPrompt(): Promise<void> {
    if (!this.isActive) return;
    await this.client.sendPromptEnd(this.sessionId);
  }

  public async close(): Promise<void> {
    if (!this.isActive) return;
    this.isActive = false;
    this.audioBufferQueue = [];
    await this.client.sendSessionEnd(this.sessionId);
  }
}

// ─── Session Data ─────────────────────────────────────────────────────────────

interface SessionData {
  queue: Array<any>;
  queueSignal: Subject<void>;
  closeSignal: Subject<void>;
  pendingToolUses: Array<{ toolUseId: string; toolName: string; content: any }>;
  responseHandlers: Map<string, (data: any) => void>;
  promptName: string;
  inferenceConfig: InferenceConfig;
  isActive: boolean;
  isPromptStartSent: boolean;
  isAudioContentStartSent: boolean;
  audioContentId: string;
  sessionState: SessionState;
  recentEvents: Array<{ type: string; count: number }>; // ring buffer of recently-sent event types, for diagnostics
}

// ─── Main Client ──────────────────────────────────────────────────────────────

export class NovaSonicBidirectionalStreamClient {
  private bedrockRuntimeClient: BedrockRuntimeClient;
  private inferenceConfig: InferenceConfig;
  private activeSessions: Map<string, SessionData> = new Map();
  private sessionLastActivity: Map<string, number> = new Map();
  private sessionCleanupInProgress = new Set<string>();
  private toolHandler: ToolHandler | null = null;

  constructor(config: NovaSonicClientConfig) {
    const nodeHttp2Handler = new NodeHttp2Handler({
      requestTimeout: 300000,
      sessionTimeout: 300000,
      disableConcurrentStreams: false,
      maxConcurrentStreams: 20,
      ...config.requestHandlerConfig,
    });

    if (!config.clientConfig.credentials) {
      throw new Error("No credentials provided");
    }

    this.bedrockRuntimeClient = new BedrockRuntimeClient({
      ...config.clientConfig,
      credentials: config.clientConfig.credentials,
      region: config.clientConfig.region || "us-east-1",
      requestHandler: nodeHttp2Handler
    });

    this.inferenceConfig = config.inferenceConfig ?? DefaultInferenceConfig;
  }

  public setToolHandler(handler: ToolHandler): void {
    this.toolHandler = handler;
  }

  public isSessionActive(sessionId: string): boolean {
    const session = this.activeSessions.get(sessionId);
    return !!session && session.isActive;
  }

  public getActiveSessions(): string[] {
    return Array.from(this.activeSessions.keys());
  }

  public getSessionState(sessionId: string): SessionState | null {
    const session = this.activeSessions.get(sessionId);
    return session?.sessionState ?? null;
  }

  public updateSessionState(sessionId: string, updates: Partial<SessionState>): void {
    const session = this.activeSessions.get(sessionId);
    if (session) {
      session.sessionState = { ...session.sessionState, ...updates };
    }
  }

  public getLastActivityTime(sessionId: string): number {
    return this.sessionLastActivity.get(sessionId) || 0;
  }

  private updateSessionActivity(sessionId: string): void {
    this.sessionLastActivity.set(sessionId, Date.now());
  }

  // ─── Session Creation ───────────────────────────────────────────────────────

  public createStreamSession(sessionId: string = randomUUID()): StreamSession {
    if (this.activeSessions.has(sessionId)) {
      throw new Error(`Stream session with ID ${sessionId} already exists`);
    }

    const session: SessionData = {
      queue: [],
      queueSignal: new Subject<void>(),
      closeSignal: new Subject<void>(),
      pendingToolUses: [],
      responseHandlers: new Map(),
      promptName: randomUUID(),
      inferenceConfig: this.inferenceConfig,
      isActive: true,
      isPromptStartSent: false,
      isAudioContentStartSent: false,
      audioContentId: randomUUID(),
      sessionState: {
        customerId: null,
        authToken: null,
        authenticated: false,
      },
      recentEvents: [],
    };

    this.activeSessions.set(sessionId, session);
    return new StreamSession(sessionId, this);
  }

  // ─── Bidirectional Streaming ────────────────────────────────────────────────

  public async initiateBidirectionalStreaming(sessionId: string): Promise<void> {
    const session = this.activeSessions.get(sessionId);
    if (!session) {
      throw new Error(`Stream session ${sessionId} not found`);
    }

    try {
      const asyncIterable = this.createSessionAsyncIterable(sessionId);

      console.log(`[${sessionId}] Starting bidirectional stream...`);

      const response = await this.bedrockRuntimeClient.send(
        new InvokeModelWithBidirectionalStreamCommand({
          modelId: "amazon.nova-2-sonic-v1:0",
          body: asyncIterable,
        })
      );

      console.log(`[${sessionId}] Stream established, processing responses...`);
      await this.processResponseStream(sessionId, response);

    } catch (error) {
      console.error(`[${sessionId}] Error in bidirectional stream:`, error);
      this.dispatchEvent(sessionId, 'error', {
        source: 'bidirectionalStream',
        error
      });

      if (session.isActive) {
        this.closeSession(sessionId);
      }
    }
  }

  // ─── Event Setup ────────────────────────────────────────────────────────────

  public setupSessionStartEvent(sessionId: string): void {
    const session = this.activeSessions.get(sessionId);
    if (!session) return;

    this.addEventToSessionQueue(sessionId, {
      event: {
        sessionStart: {
          inferenceConfiguration: session.inferenceConfig
        }
      }
    });
  }

  public setupPromptStartEvent(sessionId: string, tools: ToolSpec[]): void {
    const session = this.activeSessions.get(sessionId);
    if (!session) return;

    this.addEventToSessionQueue(sessionId, {
      event: {
        promptStart: {
          promptName: session.promptName,
          textOutputConfiguration: {
            mediaType: "text/plain",
          },
          audioOutputConfiguration: DefaultAudioOutputConfiguration,
          toolUseOutputConfiguration: {
            mediaType: "application/json",
          },
          toolConfiguration: {
            tools: tools.map(tool => ({ toolSpec: tool }))
          },
        },
      }
    });
    session.isPromptStartSent = true;
  }

  public setupSystemPromptEvent(
    sessionId: string,
    textConfig: TextConfiguration = DefaultTextConfiguration,
    systemPromptContent: string = SahayakSystemPrompt
  ): void {
    const session = this.activeSessions.get(sessionId);
    if (!session) return;

    const textPromptId = randomUUID();

    this.addEventToSessionQueue(sessionId, {
      event: {
        contentStart: {
          promptName: session.promptName,
          contentName: textPromptId,
          type: "TEXT",
          interactive: false,
          role: "SYSTEM",
          textInputConfiguration: textConfig,
        },
      }
    });

    this.addEventToSessionQueue(sessionId, {
      event: {
        textInput: {
          promptName: session.promptName,
          contentName: textPromptId,
          content: systemPromptContent,
        },
      }
    });

    this.addEventToSessionQueue(sessionId, {
      event: {
        contentEnd: {
          promptName: session.promptName,
          contentName: textPromptId,
        },
      }
    });
  }

  public setupStartAudioEvent(
    sessionId: string,
    audioConfig: AudioInputConfiguration = DefaultAudioInputConfiguration
  ): void {
    const session = this.activeSessions.get(sessionId);
    if (!session) return;

    this.addEventToSessionQueue(sessionId, {
      event: {
        contentStart: {
          promptName: session.promptName,
          contentName: session.audioContentId,
          type: "AUDIO",
          interactive: true,
          role: "USER",
          audioInputConfiguration: audioConfig,
        },
      }
    });
    session.isAudioContentStartSent = true;
  }

  // ─── Audio Streaming ────────────────────────────────────────────────────────

  public async streamAudioChunk(sessionId: string, audioData: Buffer): Promise<void> {
    const session = this.activeSessions.get(sessionId);
    if (!session || !session.isActive || !session.audioContentId) {
      return;
    }

    const base64Data = audioData.toString('base64');

    this.addEventToSessionQueue(sessionId, {
      event: {
        audioInput: {
          promptName: session.promptName,
          contentName: session.audioContentId,
          content: base64Data,
        },
      }
    });
  }

  // ─── Text Input ─────────────────────────────────────────────────────────────

  public async sendTextContent(sessionId: string, text: string): Promise<void> {
    const session = this.activeSessions.get(sessionId);
    if (!session || !session.isActive) return;

    const contentId = randomUUID();

    this.addEventToSessionQueue(sessionId, {
      event: {
        contentStart: {
          promptName: session.promptName,
          contentName: contentId,
          type: "TEXT",
          interactive: true,
          role: "USER",
          textInputConfiguration: DefaultTextConfiguration,
        },
      }
    });

    this.addEventToSessionQueue(sessionId, {
      event: {
        textInput: {
          promptName: session.promptName,
          contentName: contentId,
          content: text,
        },
      }
    });

    this.addEventToSessionQueue(sessionId, {
      event: {
        contentEnd: {
          promptName: session.promptName,
          contentName: contentId,
        },
      }
    });
  }

  // ─── Session End Events ─────────────────────────────────────────────────────

  public async sendContentEnd(sessionId: string): Promise<void> {
    const session = this.activeSessions.get(sessionId);
    if (!session || !session.isAudioContentStartSent) return;

    this.addEventToSessionQueue(sessionId, {
      event: {
        contentEnd: {
          promptName: session.promptName,
          contentName: session.audioContentId,
        }
      }
    });

    await new Promise(resolve => setTimeout(resolve, 500));
  }

  public async sendPromptEnd(sessionId: string): Promise<void> {
    const session = this.activeSessions.get(sessionId);
    if (!session || !session.isPromptStartSent) return;

    this.addEventToSessionQueue(sessionId, {
      event: {
        promptEnd: {
          promptName: session.promptName
        }
      }
    });

    await new Promise(resolve => setTimeout(resolve, 300));
  }

  public async sendSessionEnd(sessionId: string): Promise<void> {
    const session = this.activeSessions.get(sessionId);
    if (!session) return;

    this.addEventToSessionQueue(sessionId, {
      event: {
        sessionEnd: {}
      }
    });

    await new Promise(resolve => setTimeout(resolve, 300));

    session.isActive = false;
    session.closeSignal.next();
    session.closeSignal.complete();
    this.activeSessions.delete(sessionId);
    this.sessionLastActivity.delete(sessionId);
    console.log(`[${sessionId}] Session closed and removed`);
  }

  // ─── Tool Results ───────────────────────────────────────────────────────────

  private async sendToolResult(sessionId: string, toolUseId: string, result: any): Promise<void> {
    const session = this.activeSessions.get(sessionId);
    if (!session || !session.isActive) return;

    console.log(`[${sessionId}] Sending tool result for tool use ID: ${toolUseId}`);
    const contentId = randomUUID();

    this.addEventToSessionQueue(sessionId, {
      event: {
        contentStart: {
          promptName: session.promptName,
          contentName: contentId,
          interactive: false,
          type: "TOOL",
          role: "TOOL",
          toolResultInputConfiguration: {
            toolUseId: toolUseId,
            type: "TEXT",
            textInputConfiguration: {
              mediaType: "text/plain"
            }
          }
        }
      }
    });

    const resultContent = typeof result === 'string' ? result : JSON.stringify(result);
    this.addEventToSessionQueue(sessionId, {
      event: {
        toolResult: {
          promptName: session.promptName,
          contentName: contentId,
          content: resultContent
        }
      }
    });

    this.addEventToSessionQueue(sessionId, {
      event: {
        contentEnd: {
          promptName: session.promptName,
          contentName: contentId
        }
      }
    });
  }

  // ─── Response Stream Processing ─────────────────────────────────────────────

  private async processResponseStream(sessionId: string, response: any): Promise<void> {
    const session = this.activeSessions.get(sessionId);
    if (!session) return;

    try {
      for await (const event of response.body) {
        if (!session.isActive) {
          console.log(`[${sessionId}] Session no longer active, stopping response processing`);
          break;
        }

        if (event.chunk?.bytes) {
          try {
            this.updateSessionActivity(sessionId);
            const textResponse = new TextDecoder().decode(event.chunk.bytes);

            try {
              const jsonResponse = JSON.parse(textResponse);

              if (jsonResponse.event?.contentStart) {
                this.dispatchEvent(sessionId, 'contentStart', jsonResponse.event.contentStart);
              } else if (jsonResponse.event?.textOutput) {
                this.dispatchEvent(sessionId, 'textOutput', jsonResponse.event.textOutput);
              } else if (jsonResponse.event?.audioOutput) {
                this.dispatchEvent(sessionId, 'audioOutput', jsonResponse.event.audioOutput);
              } else if (jsonResponse.event?.toolUse) {
                const tu = jsonResponse.event.toolUse;
                this.dispatchEvent(sessionId, 'toolUse', tu);
                // Queue each tool use. Nova 2 Sonic can fire multiple (async) tool calls
                // back-to-back; a single slot would overwrite the first and cause a
                // mismatched toolUseId in the tool result (ValidationException).
                session.pendingToolUses.push({
                  toolUseId: tu.toolUseId,
                  toolName: tu.toolName,
                  content: tu
                });
              } else if (jsonResponse.event?.contentEnd?.type === 'TOOL') {
                // A tool-use content block closed — execute the matching queued tool (FIFO).
                const pending = session.pendingToolUses.shift();
                if (!pending) {
                  console.warn(`[${sessionId}] Received contentEnd(TOOL) with no pending tool use`);
                } else {
                  this.dispatchEvent(sessionId, 'toolEnd', {
                    toolUseContent: pending.content,
                    toolUseId: pending.toolUseId,
                    toolName: pending.toolName
                  });

                  if (this.toolHandler) {
                    try {
                      console.log(`[${sessionId}] Executing tool: ${pending.toolName} (id: ${pending.toolUseId})`);
                      const toolResult = await this.toolHandler(
                        pending.toolName,
                        pending.content,
                        session.sessionState
                      );

                      // Send tool result back to Nova Sonic
                      await this.sendToolResult(sessionId, pending.toolUseId, toolResult);

                      this.dispatchEvent(sessionId, 'toolResult', {
                        toolUseId: pending.toolUseId,
                        toolName: pending.toolName,
                        result: toolResult
                      });
                    } catch (toolError) {
                      console.error(`[${sessionId}] Tool execution error:`, toolError);
                      // Always respond to a tool call, even on error, or the model hangs.
                      await this.sendToolResult(sessionId, pending.toolUseId, {
                        error: toolError instanceof Error ? toolError.message : 'Tool execution failed'
                      });
                    }
                  }
                }
              } else if (jsonResponse.event?.contentEnd) {
                this.dispatchEvent(sessionId, 'contentEnd', jsonResponse.event.contentEnd);
              } else {
                const eventKeys = Object.keys(jsonResponse.event || {});
                if (eventKeys.length > 0) {
                  this.dispatchEvent(sessionId, eventKeys[0], jsonResponse.event);
                }
              }
            } catch (_parseError) {
              // Non-JSON response, ignore
            }
          } catch (e) {
            console.error(`[${sessionId}] Error processing response chunk:`, e);
          }
        } else if (event.modelStreamErrorException) {
          console.error(`[${sessionId}] Model stream error:`, event.modelStreamErrorException);
          this.dispatchEvent(sessionId, 'error', {
            type: 'modelStreamErrorException',
            details: event.modelStreamErrorException
          });
        } else if (event.internalServerException) {
          console.error(`[${sessionId}] Internal server error:`, event.internalServerException);
          this.dispatchEvent(sessionId, 'error', {
            type: 'internalServerException',
            details: event.internalServerException
          });
        }
      }

      console.log(`[${sessionId}] Response stream processing complete`);
      this.dispatchEvent(sessionId, 'streamComplete', {
        timestamp: new Date().toISOString()
      });

    } catch (error) {
      const session = this.activeSessions.get(sessionId);
      const eventTrail = session
        ? session.recentEvents.map(e => (e.count > 1 ? `${e.type} x${e.count}` : e.type)).join(' -> ')
        : '(session gone)';
      console.error(`[${sessionId}] Error processing response stream:`, error);
      console.error(`[${sessionId}] Error name: ${(error as any)?.name}, message: ${(error as any)?.message}`);
      console.error(`[${sessionId}] Last events sent before failure:\n    ${eventTrail}`);
      this.dispatchEvent(sessionId, 'error', {
        source: 'responseStream',
        message: 'Error processing response stream',
        details: error instanceof Error ? error.message : String(error),
        eventTrail
      });
    }
  }

  // ─── Async Iterable for Bedrock ─────────────────────────────────────────────

  private createSessionAsyncIterable(sessionId: string): AsyncIterable<InvokeModelWithBidirectionalStreamInput> {
    const session = this.activeSessions.get(sessionId);
    if (!session) {
      return {
        [Symbol.asyncIterator]: () => ({
          next: async () => ({ value: undefined as any, done: true as const })
        })
      };
    }

    return {
      [Symbol.asyncIterator]: () => {
        return {
          next: async (): Promise<IteratorResult<InvokeModelWithBidirectionalStreamInput>> => {
            try {
              if (!session.isActive || !this.activeSessions.has(sessionId)) {
                return { value: undefined as any, done: true };
              }

              if (session.queue.length === 0) {
                try {
                  await Promise.race([
                    firstValueFrom(session.queueSignal.pipe(take(1))),
                    firstValueFrom(session.closeSignal.pipe(take(1))).then(() => {
                      throw new Error("Stream closed");
                    })
                  ]);
                } catch (error) {
                  if (error instanceof Error && (error.message === "Stream closed" || !session.isActive)) {
                    return { value: undefined as any, done: true };
                  }
                }
              }

              if (session.queue.length === 0 || !session.isActive) {
                return { value: undefined as any, done: true };
              }

              const nextEvent = session.queue.shift();

              return {
                value: {
                  chunk: {
                    bytes: new TextEncoder().encode(JSON.stringify(nextEvent))
                  }
                },
                done: false
              };
            } catch (error) {
              console.error(`[${sessionId}] Error in iterator:`, error);
              session.isActive = false;
              return { value: undefined as any, done: true };
            }
          },

          return: async (): Promise<IteratorResult<InvokeModelWithBidirectionalStreamInput>> => {
            session.isActive = false;
            return { value: undefined as any, done: true };
          },

          throw: async (error: any): Promise<IteratorResult<InvokeModelWithBidirectionalStreamInput>> => {
            session.isActive = false;
            throw error;
          }
        };
      }
    };
  }

  // ─── Event Queue ────────────────────────────────────────────────────────────

  private addEventToSessionQueue(sessionId: string, event: any): void {
    const session = this.activeSessions.get(sessionId);
    if (!session || !session.isActive) return;

    this.recordRecentEvent(session, event);
    this.updateSessionActivity(sessionId);
    session.queue.push(event);
    session.queueSignal.next();
  }

  // Track the last outgoing events (collapsing runs of the same type, e.g. audioInput) so that
  // if Bedrock rejects an input we can see exactly what sequence preceded the failure.
  private recordRecentEvent(session: SessionData, event: any): void {
    const e = event?.event ?? {};
    const key = Object.keys(e)[0] ?? 'unknown';
    let type = key;
    if (key === 'contentStart') {
      type = `contentStart(${e.contentStart?.type}/${e.contentStart?.role})`;
    } else if (key === 'contentEnd') {
      type = `contentEnd(${e.contentEnd?.type ?? ''})`;
    }

    const last = session.recentEvents[session.recentEvents.length - 1];
    if (last && last.type === type) {
      last.count++;
    } else {
      session.recentEvents.push({ type, count: 1 });
      if (session.recentEvents.length > 25) session.recentEvents.shift();
    }
  }

  // ─── Event Dispatching ──────────────────────────────────────────────────────

  public registerEventHandler(sessionId: string, eventType: string, handler: (data: any) => void): void {
    const session = this.activeSessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }
    session.responseHandlers.set(eventType, handler);
  }

  private dispatchEvent(sessionId: string, eventType: string, data: any): void {
    const session = this.activeSessions.get(sessionId);
    if (!session) return;

    const handler = session.responseHandlers.get(eventType);
    if (handler) {
      try {
        handler(data);
      } catch (e) {
        console.error(`[${sessionId}] Error in ${eventType} handler:`, e);
      }
    }

    const anyHandler = session.responseHandlers.get('any');
    if (anyHandler) {
      try {
        anyHandler({ type: eventType, data });
      } catch (e) {
        console.error(`[${sessionId}] Error in 'any' handler:`, e);
      }
    }
  }

  // ─── Session Cleanup ────────────────────────────────────────────────────────

  public async closeSession(sessionId: string): Promise<void> {
    if (this.sessionCleanupInProgress.has(sessionId)) return;
    this.sessionCleanupInProgress.add(sessionId);

    try {
      await this.sendContentEnd(sessionId);
      await this.sendPromptEnd(sessionId);
      await this.sendSessionEnd(sessionId);
    } catch (error) {
      console.error(`[${sessionId}] Error during close:`, error);
      const session = this.activeSessions.get(sessionId);
      if (session) {
        session.isActive = false;
        this.activeSessions.delete(sessionId);
        this.sessionLastActivity.delete(sessionId);
      }
    } finally {
      this.sessionCleanupInProgress.delete(sessionId);
    }
  }

  public forceCloseSession(sessionId: string): void {
    if (this.sessionCleanupInProgress.has(sessionId) || !this.activeSessions.has(sessionId)) return;

    this.sessionCleanupInProgress.add(sessionId);
    try {
      const session = this.activeSessions.get(sessionId);
      if (!session) return;

      session.isActive = false;
      session.closeSignal.next();
      session.closeSignal.complete();
      this.activeSessions.delete(sessionId);
      this.sessionLastActivity.delete(sessionId);
      console.log(`[${sessionId}] Force closed`);
    } finally {
      this.sessionCleanupInProgress.delete(sessionId);
    }
  }
}
