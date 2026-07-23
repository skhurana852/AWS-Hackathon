/**
 * Minimal CLI test for Nova Sonic bidirectional streaming.
 * Usage: npm run cli
 *
 * This test:
 * 1. Creates a Nova Sonic session
 * 2. Sends the system prompt
 * 3. Sends a text input (simulating user speech)
 * 4. Logs all response events (text output, audio output, etc.)
 * 5. Closes the session after receiving a response
 */

import { NovaSonicBidirectionalStreamClient } from './client';
import { fromNodeProviderChain } from "@aws-sdk/credential-providers";
import { SahayakSystemPrompt } from './consts';
import dotenv from 'dotenv';

dotenv.config();

const REGION = process.env.AWS_REGION || "us-east-1";

async function main() {
  console.log("=== Nova Sonic CLI Test ===");
  console.log(`Region: ${REGION}`);

  const client = new NovaSonicBidirectionalStreamClient({
    clientConfig: {
      region: REGION,
      credentials: fromNodeProviderChain()
    }
  });

  const session = client.createStreamSession();
  const sessionId = session.getSessionId();
  console.log(`Session created: ${sessionId}`);

  let responseText = '';
  let audioChunksReceived = 0;

  // Register event handlers
  session.onEvent('textOutput', (data) => {
    if (data.content) {
      responseText += data.content;
      process.stdout.write(data.content);
    }
  });

  session.onEvent('audioOutput', (_data) => {
    audioChunksReceived++;
  });

  session.onEvent('contentStart', (data) => {
    if (data.type === 'TEXT') {
      console.log('\n[Nova Sonic speaking]:');
    }
  });

  session.onEvent('contentEnd', (data) => {
    if (data.type === 'TEXT' || !data.type) {
      console.log(`\n[Text complete]`);
    }
  });

  session.onEvent('streamComplete', () => {
    console.log(`\n\n=== Stream Complete ===`);
    console.log(`Total audio chunks received: ${audioChunksReceived}`);
    console.log(`Response text: ${responseText}`);
    process.exit(0);
  });

  session.onEvent('error', (data) => {
    console.error('\n[ERROR]:', data);
    process.exit(1);
  });

  // Define a simple tool for testing
  const tools = [
    {
      name: "verifyAadhaarTool",
      description: "Verify a customer's identity using the last 4 digits of their Aadhaar number.",
      inputSchema: {
        json: JSON.stringify({
          type: "object",
          properties: {
            aadhaarLast4: {
              type: "string",
              description: "The last 4 digits of the customer's Aadhaar number"
            }
          },
          required: ["aadhaarLast4"]
        })
      }
    }
  ];

  // Set up a mock tool handler
  client.setToolHandler(async (toolName, toolInput, _sessionState) => {
    console.log(`\n[Tool Called]: ${toolName}`, toolInput);
    return { customerId: "C1001", maskedName: "S. Kumar", maskedMobile: "XXXXXX3210" };
  });

  // Start the bidirectional stream (non-blocking)
  client.initiateBidirectionalStreaming(sessionId);

  // Wait a moment for stream to establish
  await new Promise(resolve => setTimeout(resolve, 1000));

  // Set up session, prompt, and system prompt
  await session.setupSessionAndPromptStart(tools);
  await session.setupSystemPrompt(undefined, SahayakSystemPrompt);
  await session.setupStartAudio();

  // Wait for setup to propagate
  await new Promise(resolve => setTimeout(resolve, 500));

  // Send a text input (simulating what a user would say)
  console.log('\n[Sending text]: "Hello, I want to check my balance"');
  await session.sendTextInput("Hello, I want to check my balance");

  // Wait for response (timeout after 30 seconds)
  setTimeout(async () => {
    console.log('\n\n=== Timeout — closing session ===');
    console.log(`Audio chunks received: ${audioChunksReceived}`);
    console.log(`Response text: ${responseText}`);
    try {
      await session.endAudioContent();
      await session.endPrompt();
      await session.close();
    } catch (_e) {
      // Ignore cleanup errors
    }
    process.exit(0);
  }, 30000);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
