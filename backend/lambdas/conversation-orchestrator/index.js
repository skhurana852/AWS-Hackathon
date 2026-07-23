/**
 * Conversation Orchestrator Lambda — POST /converse
 *
 * This is the CORE of Sahayak. Every turn from the user routes through here.
 * It:
 *   1. Detects language (EN / HI) using Amazon Comprehend
 *   2. Transcribes speech → text if audio blob provided (via Transcribe)
 *   3. Detects intent using Amazon Lex (configured bot)
 *   4. Falls back to Bedrock (Claude) for natural responses / slot clarification
 *   5. Manages the session state machine
 *   6. Calls downstream service Lambdas as needed
 *   7. Generates TTS response via Amazon Polly
 *
 * Input:  { text?, audioBase64?, sessionId, authToken?, language? }
 * Output: { responseText, audioBase64?, sessionState, language }
 */

const {
  BedrockRuntimeClient,
  InvokeModelCommand
} = require("@aws-sdk/client-bedrock-runtime");
const {
  ComprehendClient,
  DetectDominantLanguageCommand
} = require("@aws-sdk/client-comprehend");
const {
  LexRuntimeV2Client,
  RecognizeTextCommand
} = require("@aws-sdk/client-lex-runtime-v2");
const {
  PollyClient,
  SynthesizeSpeechCommand
} = require("@aws-sdk/client-polly");
const {
  TranscribeClient,
  StartTranscriptionJobCommand,
  GetTranscriptionJobCommand
} = require("@aws-sdk/client-transcribe");
const { S3Client, PutObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");

const {
  ddb, TABLE, ok, badReq, unauth, err500,
  GetCommand, PutCommand, UpdateCommand,
  verifyToken
} = require("./utils");

const REGION   = process.env.AWS_REGION  || "ap-south-1";
const LEX_BOT_ID       = process.env.LEX_BOT_ID || "SahayakBot";
const LEX_BOT_ALIAS_ID = process.env.LEX_BOT_ALIAS_ID || "TSTALIASID";
const BEDROCK_MODEL    = process.env.BEDROCK_MODEL || "us.anthropic.claude-sonnet-4-5-20250929-v1:0";
const AUDIO_BUCKET     = process.env.AUDIO_BUCKET || "sahayak-audio-temp";

const comprehend = new ComprehendClient({ region: REGION });
const lex        = new LexRuntimeV2Client({ region: REGION });
const polly      = new PollyClient({ region: REGION });
const bedrock    = new BedrockRuntimeClient({ region: REGION });
const s3         = new S3Client({ region: REGION });

// ─── Main Handler ─────────────────────────────────────────────────────────────
exports.handler = async (event) => {
  try {
    const body = JSON.parse(event.body || "{}");
    const { text, sessionId, authToken, language: clientLang } = body;

    if (!text && !body.audioBase64) return badReq("text or audioBase64 is required.");
    if (!sessionId) return badReq("sessionId is required.");

    // Load or create session
    let session = await loadSession(sessionId);
    if (!session) {
      session = createNewSession(sessionId, clientLang || "en");
    }

    // Validate auth for protected actions
    if (authToken) {
      const payload = verifyToken(authToken);
      if (payload) {
        session.customerId = payload.customerId;
        session.authenticated = true;
      }
    }

    // Detect language
    const userText  = text || "(voice input)";
    const lang      = await detectLanguage(userText, session.language);
    session.language = lang;

    // Get intent from Lex
    const lexResult = await recognizeIntent(userText, sessionId, lang);
    const intent    = lexResult?.sessionState?.intent?.name || "FallbackIntent";
    const slots     = lexResult?.sessionState?.intent?.slots || {};
    const confidence= extractConfidence(lexResult);

    // Route based on intent and session state
    const { responseText, newState } = await routeIntent(
      intent, slots, confidence, session, body
    );

    // Update session state
    session.currentState = newState;
    session.lastActivity  = Date.now();
    await saveSession(session);

    // Generate TTS audio
    const audioBase64 = await synthesizeSpeech(responseText, lang);

    return ok({
      responseText,
      audioBase64,
      sessionState: session.currentState,
      language: lang,
      intent,
      sessionId
    });

  } catch (e) {
    console.error("conversation-orchestrator error:", e);
    return err500("I'm having trouble processing that right now. Please try again in a moment.");
  }
};

// ─── Language Detection ───────────────────────────────────────────────────────
const detectLanguage = async (text, fallback = "en") => {
  try {
    const result = await comprehend.send(
      new DetectDominantLanguageCommand({ Text: text })
    );
    const top = result.Languages?.[0];
    if (!top || top.Score < 0.7) return fallback;
    return top.LanguageCode === "hi" ? "hi" : "en";
  } catch {
    return fallback;
  }
};

// ─── Lex Intent Recognition ───────────────────────────────────────────────────
const recognizeIntent = async (text, sessionId, lang) => {
  try {
    const localeId = lang === "hi" ? "hi_IN" : "en_IN";
    const result = await lex.send(new RecognizeTextCommand({
      botId: LEX_BOT_ID,
      botAliasId: LEX_BOT_ALIAS_ID,
      localeId,
      sessionId,
      text
    }));
    return result;
  } catch (e) {
    console.warn("Lex unavailable, using Bedrock fallback:", e.message);
    return null;
  }
};

const extractConfidence = (lexResult) => {
  const scores = lexResult?.interpretations?.[0]?.nluConfidence;
  return scores?.score ?? 0.5;
};

// ─── Intent Router / Dialog State Machine ────────────────────────────────────
const routeIntent = async (intent, slots, confidence, session, body) => {
  // Not authenticated yet — force auth flow
  if (!session.authenticated) {
    if (session.currentState === "AWAITING_OTP") {
      return handleOtpVerification(body.text, session);
    }
    if (session.currentState === "AWAITING_AADHAAR") {
      return handleAadhaarLookup(body.text, session);
    }
    // First unauthenticated message → greet and ask for Aadhaar
    session.currentState = "AWAITING_AADHAAR";
    return {
      responseText: greet(session.language),
      newState: "AWAITING_AADHAAR"
    };
  }

  // Confidence-based routing
  if (confidence < 0.4 || intent === "FallbackIntent") {
    return handleLowConfidence(body.text, session);
  }

  if (confidence >= 0.4 && confidence < 0.75) {
    return handleAmbiguous(intent, session);
  }

  // High confidence — route to task
  switch (intent) {
    case "CheckBalance":
    case "CHECK_BALANCE":
      return handleBalanceEnquiry(session);
    case "OpenFD":
    case "OPEN_FD":
      return handleFdFlow(slots, session, body);
    case "WithdrawCash":
    case "WITHDRAW_CASH":
      return handleWithdrawalFlow(slots, session, body);
    case "GREETING":
    case "Greeting":
      return { responseText: greet(session.language), newState: "AUTHENTICATED" };
    case "CANCEL":
    case "Cancel":
      return handleCancel(session);
    case "REPEAT":
    case "Repeat":
      return { responseText: session.lastResponse || "I didn't say anything yet.", newState: session.currentState };
    default:
      return handleLowConfidence(body.text, session);
  }
};

// ─── Flow Handlers ────────────────────────────────────────────────────────────

const greet = (lang) => {
  if (lang === "hi") {
    return "नमस्ते! मैं सहायक हूँ, आपका AI बैंकिंग सहायक। कृपया अपने आधार के अंतिम 4 अंक बताएं।";
  }
  return "Hello! I'm Sahayak, your AI banking assistant. I can help you check your balance, open a Fixed Deposit, or withdraw cash. Please tell me the last 4 digits of your Aadhaar to get started.";
};

const handleAadhaarLookup = async (text, session) => {
  const digits = (text || "").match(/\d{4}/)?.[0];
  if (!digits) {
    return {
      responseText: session.language === "hi"
        ? "कृपया अपने आधार के अंतिम 4 अंक बताएं।"
        : "Please say the last 4 digits of your Aadhaar number.",
      newState: "AWAITING_AADHAAR"
    };
  }

  // Call verify-id internally
  const verifyId = require("./auth/verify-id/index");
  const resp = await verifyId.handler({
    body: JSON.stringify({ aadhaarLast4: digits }),
    headers: {}
  });
  const result = JSON.parse(resp.body);

  if (resp.statusCode !== 200) {
    return {
      responseText: result.error || "Unable to find your account. Please visit the counter.",
      newState: "UNAUTHENTICATED"
    };
  }

  session.pendingCustomerId = result.customerId;
  const msg = session.language === "hi"
    ? `${result.maskedName} जी, आपको ${result.maskedMobile} पर OTP भेजा गया है। कृपया OTP बताएं।`
    : `Hello ${result.maskedName}, an OTP has been sent to ${result.maskedMobile}. Please say your OTP.`;

  return { responseText: msg, newState: "AWAITING_OTP" };
};

const handleOtpVerification = async (text, session) => {
  const otp = (text || "").replace(/\D/g, "").slice(0, 6);
  if (otp.length !== 6) {
    return {
      responseText: session.language === "hi"
        ? "कृपया 6 अंकों का OTP बताएं।"
        : "Please say your 6-digit OTP.",
      newState: "AWAITING_OTP"
    };
  }

  const verifyOtp = require("./auth/verify-otp/index");
  const resp = await verifyOtp.handler({
    body: JSON.stringify({ customerId: session.pendingCustomerId, otp }),
    headers: {}
  });
  const result = JSON.parse(resp.body);

  if (resp.statusCode !== 200) {
    return {
      responseText: result.error,
      newState: result.error.includes("all 3") ? "UNAUTHENTICATED" : "AWAITING_OTP"
    };
  }

  session.authToken = result.authToken;
  session.customerId = session.pendingCustomerId;
  session.authenticated = true;

  const msg = session.language === "hi"
    ? `${result.message} मैं आपकी क्या मदद कर सकता हूँ? बैलेंस जानना है, FD खोलनी है, या नकद निकालना है?`
    : `${result.message} Would you like to check your balance, open a Fixed Deposit, or withdraw cash?`;

  return { responseText: msg, newState: "AUTHENTICATED" };
};

const handleBalanceEnquiry = async (session) => {
  try {
    const balanceHandler = require("./balance-flow/index");
    const resp = await balanceHandler.handler({
      headers: { Authorization: `Bearer ${session.authToken}` },
      pathParameters: { customerId: session.customerId }
    });
    const result = JSON.parse(resp.body);

    if (resp.statusCode !== 200) {
      return { responseText: result.error, newState: "AUTHENTICATED" };
    }

    const accounts = result.accounts;
    let msg;
    if (session.language === "hi") {
      msg = `आपके ${accounts.length} खाते हैं: `;
      accounts.forEach(a => {
        msg += `${a.type} खाता (${a.accountId}): ₹${a.balance.toLocaleString("en-IN")}. `;
      });
      msg += "क्या और कुछ चाहिए?";
    } else {
      msg = `You have ${accounts.length} account(s): `;
      accounts.forEach(a => {
        msg += `${a.type} account ending in ${a.accountId.slice(-4)}: ₹${a.balance.toLocaleString("en-IN")}. `;
      });
      msg += "Is there anything else I can help you with?";
    }
    return { responseText: msg, newState: "AUTHENTICATED" };
  } catch (e) {
    return { responseText: "Unable to fetch balance right now. Please try again.", newState: "AUTHENTICATED" };
  }
};

const handleFdFlow = async (slots, session, body) => {
  // Slot collection phase
  if (!session.fdSlots) session.fdSlots = {};

  const amount   = slots?.Amount?.value?.interpretedValue || session.fdSlots.amount;
  const tenure   = slots?.Tenure?.value?.interpretedValue || session.fdSlots.tenureMonths;
  const pan      = slots?.PAN?.value?.interpretedValue    || session.fdSlots.pan;

  // Persist collected slots
  if (amount)  session.fdSlots.amount       = parseFloat(String(amount).replace(/[,₹]/g, ""));
  if (tenure)  session.fdSlots.tenureMonths = parseInt(tenure);
  if (pan)     session.fdSlots.pan          = pan.toUpperCase();

  // Ask for missing slots one at a time
  if (!session.fdSlots.amount) {
    const q = session.language === "hi"
      ? "आप कितनी राशि की FD खोलना चाहते हैं?"
      : "How much would you like to deposit for the Fixed Deposit?";
    return { responseText: q, newState: "FD_COLLECTING_SLOTS" };
  }
  if (!session.fdSlots.tenureMonths) {
    const q = session.language === "hi"
      ? "FD कितने महीनों के लिए चाहते हैं? जैसे 12 महीने, 24 महीने।"
      : "For how many months? For example, 12 months, 24 months, or 36 months.";
    return { responseText: q, newState: "FD_COLLECTING_SLOTS" };
  }
  if (!session.fdSlots.pan) {
    const q = session.language === "hi"
      ? "कृपया अपना PAN नंबर बताएं।"
      : "Please tell me your PAN number.";
    return { responseText: q, newState: "FD_COLLECTING_SLOTS" };
  }

  // All slots collected — get quote and ask for confirmation
  if (session.currentState !== "FD_CONFIRMING" && session.currentState !== "FD_CHOOSING_ROUTE") {
    const fdFlow = require("./fd-flow/index");
    const quoteResp = await fdFlow.handler({
      httpMethod: "POST",
      path: "/fd/quote",
      rawPath: "/fd/quote",
      headers: { Authorization: `Bearer ${session.authToken}` },
      body: JSON.stringify({ amount: session.fdSlots.amount, tenureMonths: session.fdSlots.tenureMonths })
    });
    const quote = JSON.parse(quoteResp.body);
    session.fdQuote = quote;

    let msg;
    if (session.language === "hi") {
      msg = `यहाँ आपके FD की जानकारी है: ₹${session.fdSlots.amount} की FD, ${session.fdSlots.tenureMonths} महीनों के लिए, ${quote.rate}% ब्याज दर पर। परिपक्वता राशि: ₹${quote.maturityAmount}, परिपक्वता तिथि: ${quote.maturityDate}। क्या आप इसकी पुष्टि करते हैं? हाँ या नहीं।`;
    } else {
      msg = `Here are your FD details: ₹${session.fdSlots.amount} for ${session.fdSlots.tenureMonths} months at ${quote.rate}% interest. Maturity amount: ₹${quote.maturityAmount} on ${quote.maturityDate}. Do you confirm? Please say yes or no.`;
    }
    return { responseText: msg, newState: "FD_CONFIRMING" };
  }

  // Confirmation response
  if (session.currentState === "FD_CONFIRMING") {
    const userResponse = (body.text || "").toLowerCase();
    if (userResponse.includes("no") || userResponse.includes("नहीं") || userResponse.includes("cancel")) {
      session.fdSlots = {};
      return {
        responseText: session.language === "hi"
          ? "ठीक है, FD रद्द कर दी। क्या मैं और कुछ कर सकता हूँ?"
          : "Alright, FD request cancelled. Is there anything else I can help you with?",
        newState: "AUTHENTICATED"
      };
    }
    if (userResponse.includes("yes") || userResponse.includes("हाँ") || userResponse.includes("confirm")) {
      const q = session.language === "hi"
        ? "भुगतान कैसे करना है? अपने खाते से डेबिट (Digital) या काउंटर पर नकद जमा (Manual)?"
        : "How would you like to fund this FD? Say 'digital' to debit from your account, or 'manual' to deposit cash at the counter.";
      return { responseText: q, newState: "FD_CHOOSING_ROUTE" };
    }
    return {
      responseText: session.language === "hi" ? "कृपया हाँ या नहीं कहें।" : "Please say yes to confirm or no to cancel.",
      newState: "FD_CONFIRMING"
    };
  }

  // Route selection
  if (session.currentState === "FD_CHOOSING_ROUTE") {
    const userResponse = (body.text || "").toLowerCase();
    const route = (userResponse.includes("digital") || userResponse.includes("account") || userResponse.includes("डिजिटल"))
      ? "DIGITAL" : "MANUAL";

    const fdFlow = require("./fd-flow/index");
    const bookResp = await fdFlow.handler({
      httpMethod: "POST",
      path: "/fd/book",
      rawPath: "/fd/book",
      headers: { Authorization: `Bearer ${session.authToken}` },
      body: JSON.stringify({
        pan: session.fdSlots.pan,
        amount: session.fdSlots.amount,
        tenureMonths: session.fdSlots.tenureMonths,
        route
      })
    });
    const bookResult = JSON.parse(bookResp.body);
    session.fdSlots = {};

    return {
      responseText: bookResult.message || bookResult.error,
      newState: "AUTHENTICATED"
    };
  }

  return { responseText: "FD flow error. Please try again.", newState: "AUTHENTICATED" };
};

const handleWithdrawalFlow = async (slots, session, body) => {
  if (!session.wdSlots) session.wdSlots = {};

  const amount    = slots?.Amount?.value?.interpretedValue || session.wdSlots.amount;
  const accountId = slots?.AccountId?.value?.interpretedValue || session.wdSlots.accountId;

  if (amount) session.wdSlots.amount    = parseFloat(String(amount).replace(/[,₹]/g, ""));
  if (accountId) session.wdSlots.accountId = accountId;

  // Fetch primary account if not specified
  if (!session.wdSlots.accountId) {
    const { QueryCommand: QC } = require("./utils");
    const r = await ddb.send(new QC({
      TableName: TABLE.ACCOUNTS,
      IndexName: "customerId-index",
      KeyConditionExpression: "customerId = :c",
      ExpressionAttributeValues: { ":c": session.customerId },
      Limit: 1
    }));
    if (r.Items?.[0]) session.wdSlots.accountId = r.Items[0].accountId;
  }

  if (!session.wdSlots.amount) {
    const q = session.language === "hi"
      ? "आप कितनी राशि निकालना चाहते हैं?"
      : "How much cash would you like to withdraw?";
    return { responseText: q, newState: "WD_COLLECTING_SLOTS" };
  }

  // Confirmation
  if (session.currentState !== "WD_CONFIRMING" && session.currentState !== "WD_CHOOSING_ROUTE") {
    const msg = session.language === "hi"
      ? `क्या आप खाते ${session.wdSlots.accountId?.slice(-4)} से ₹${session.wdSlots.amount} निकालना चाहते हैं? हाँ या नहीं।`
      : `Shall I withdraw ₹${session.wdSlots.amount} from account ending ${session.wdSlots.accountId?.slice(-4)}? Please say yes or no.`;
    return { responseText: msg, newState: "WD_CONFIRMING" };
  }

  if (session.currentState === "WD_CONFIRMING") {
    const userResponse = (body.text || "").toLowerCase();
    if (userResponse.includes("no") || userResponse.includes("नहीं") || userResponse.includes("cancel")) {
      session.wdSlots = {};
      return {
        responseText: session.language === "hi" ? "ठीक है, निकासी रद्द।" : "Alright, withdrawal cancelled.",
        newState: "AUTHENTICATED"
      };
    }
    if (userResponse.includes("yes") || userResponse.includes("हाँ")) {
      const q = session.language === "hi"
        ? "ATM/Kiosk से निकालना है (KIOSK) या काउंटर से (MANUAL)?"
        : "Would you like to collect cash from the kiosk (say 'kiosk') or from the teller counter (say 'counter')?";
      return { responseText: q, newState: "WD_CHOOSING_ROUTE" };
    }
    return {
      responseText: session.language === "hi" ? "कृपया हाँ या नहीं कहें।" : "Please say yes or no.",
      newState: "WD_CONFIRMING"
    };
  }

  if (session.currentState === "WD_CHOOSING_ROUTE") {
    const userResponse = (body.text || "").toLowerCase();
    const channel = (userResponse.includes("kiosk") || userResponse.includes("atm") || userResponse.includes("machine"))
      ? "KIOSK" : "MANUAL";

    const wdHandler = require("./withdrawal-flow/index");
    const resp = await wdHandler.handler({
      headers: { Authorization: `Bearer ${session.authToken}` },
      body: JSON.stringify({
        accountId: session.wdSlots.accountId,
        amount: session.wdSlots.amount,
        channel
      })
    });
    const result = JSON.parse(resp.body);
    session.wdSlots = {};

    return { responseText: result.message || result.error, newState: "AUTHENTICATED" };
  }

  return { responseText: "Withdrawal flow error. Please try again.", newState: "AUTHENTICATED" };
};

const handleLowConfidence = async (text, session) => {
  // Use Bedrock Claude for natural response
  try {
    const systemPrompt = session.language === "hi"
      ? `आप सहायक हैं, एक दयालु AI बैंकिंग सहायक। आप केवल बैलेंस जानने, Fixed Deposit खोलने, और नकद निकालने में मदद करते हैं। सरल हिंदी में जवाब दें।`
      : `You are Sahayak, an empathetic AI banking assistant for a retail bank. You ONLY help with: checking account balance, opening a Fixed Deposit, and cash withdrawal. Reply in simple, friendly English. If the request is out of scope, politely say so and re-state what you can help with.`;

    const response = await bedrock.send(new InvokeModelCommand({
      modelId: BEDROCK_MODEL,
      contentType: "application/json",
      accept: "application/json",
      body: JSON.stringify({
        anthropic_version: "bedrock-2023-05-31",
        max_tokens: 200,
        system: systemPrompt,
        messages: [{ role: "user", content: text || "Hello" }]
      })
    }));

    const responseBody = JSON.parse(Buffer.from(response.body).toString());
    const responseText = responseBody.content?.[0]?.text || "I'm sorry, could you rephrase that?";
    return { responseText, newState: session.currentState };
  } catch (e) {
    console.warn("Bedrock fallback error:", e.message);
    const fallback = session.language === "hi"
      ? "मुझे समझ नहीं आया। मैं बैलेंस जानने, FD खोलने, या नकद निकालने में मदद कर सकता हूँ।"
      : "I'm sorry, I didn't understand that. I can help you with checking your balance, opening a Fixed Deposit, or withdrawing cash. Which would you like?";
    return { responseText: fallback, newState: session.currentState };
  }
};

const handleAmbiguous = (intent, session) => {
  const questions = {
    "hi": {
      "OpenFD":       "क्या आप Fixed Deposit खोलना चाहते हैं?",
      "WithdrawCash": "क्या आप नकद निकालना चाहते हैं?",
      "CheckBalance": "क्या आप अपना बैलेंस जानना चाहते हैं?",
      "default":      "मैं बैलेंस जानने, FD खोलने, या नकद निकालने में मदद कर सकता हूँ। आप क्या चाहते हैं?"
    },
    "en": {
      "OpenFD":       "Just to confirm, would you like to open a Fixed Deposit?",
      "WithdrawCash": "Just to confirm, would you like to withdraw cash?",
      "CheckBalance": "Just to confirm, would you like to check your account balance?",
      "default":      "I can help you check your balance, open a Fixed Deposit, or withdraw cash. Which would you like?"
    }
  };
  const langMap = questions[session.language] || questions["en"];
  return { responseText: langMap[intent] || langMap["default"], newState: session.currentState };
};

const handleCancel = (session) => {
  session.fdSlots = {};
  session.wdSlots = {};
  const msg = session.language === "hi"
    ? "ठीक है, सब रद्द कर दिया। मैं और क्या मदद कर सकता हूँ?"
    : "Alright, I've cancelled. Is there anything else I can help you with?";
  return { responseText: msg, newState: "AUTHENTICATED" };
};

// ─── TTS ──────────────────────────────────────────────────────────────────────
const synthesizeSpeech = async (text, lang) => {
  try {
    const voiceId = "Kajal";  // Kajal supports neural for both en-IN and hi-IN
    const result = await polly.send(new SynthesizeSpeechCommand({
      Text: text,
      VoiceId: voiceId,
      OutputFormat: "mp3",
      Engine: "neural",
      LanguageCode: lang === "hi" ? "hi-IN" : "en-IN"
    }));

    const chunks = [];
    for await (const chunk of result.AudioStream) chunks.push(chunk);
    return Buffer.concat(chunks).toString("base64");
  } catch (e) {
    console.warn("Polly TTS error:", e.message);
    return null;
  }
};

// ─── Session helpers ──────────────────────────────────────────────────────────
const loadSession = async (sessionId) => {
  try {
    const r = await ddb.send(new GetCommand({
      TableName: TABLE.SESSIONS,
      Key: { sessionId }
    }));
    return r.Item || null;
  } catch {
    return null;
  }
};

const createNewSession = (sessionId, language) => ({
  sessionId,
  language,
  currentState: "UNAUTHENTICATED",
  authenticated: false,
  createdAt: Date.now(),
  lastActivity: Date.now()
});

const saveSession = async (session) => {
  await ddb.send(new PutCommand({
    TableName: TABLE.SESSIONS,
    Item: { ...session, expiresAt: Math.floor(Date.now() / 1000) + 1800 }
  }));
};
