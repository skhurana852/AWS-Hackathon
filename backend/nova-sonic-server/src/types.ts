export type AudioType = "SPEECH";
export type AudioMediaType = "audio/lpcm";
export type TextMediaType = "text/plain";

export interface InferenceConfig {
  maxTokens: number;
  topP: number;
  temperature: number;
}

export interface AudioInputConfiguration {
  audioType: AudioType;
  encoding: string;
  mediaType: AudioMediaType;
  sampleRateHertz: number;
  sampleSizeBits: number;
  channelCount: number;
}

export interface AudioOutputConfiguration extends AudioInputConfiguration {
  voiceId: string;
}

export interface TextConfiguration {
  mediaType: TextMediaType;
}

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: {
    json: string;
  };
}

export interface SessionState {
  customerId: string | null;
  authToken: string | null;
  authenticated: boolean;
}

export interface ToolHandler {
  (toolName: string, toolInput: any, sessionState: SessionState): Promise<any>;
}
