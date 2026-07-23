/**
 * OTP Service.
 *
 * Sends and verifies real OTPs on real phone numbers using the Twilio Verify API.
 * Twilio Verify generates, delivers (SMS), and validates the OTP for us, so we
 * never store or compare codes ourselves.
 *
 * If Twilio credentials are not configured, the service reports itself as
 * disabled and the caller falls back to the demo `demoOtp` mock flow — so the
 * project still runs end-to-end without any external account.
 *
 * Required environment variables (see .env):
 *   TWILIO_ACCOUNT_SID         — Account SID from the Twilio console
 *   TWILIO_AUTH_TOKEN          — Auth token from the Twilio console
 *   TWILIO_VERIFY_SERVICE_SID  — A Verify Service SID (starts with "VA...")
 * Optional:
 *   OTP_DEFAULT_COUNTRY_CODE   — Prepended to local numbers (default "+91")
 *
 * Sending arbitrary SMS (e.g. the generated form link) uses Twilio Programmable
 * Messaging, which needs a sender:
 *   TWILIO_FROM_NUMBER          — A Twilio phone number (e.g. "+1512...") OR
 *   TWILIO_MESSAGING_SERVICE_SID — A Messaging Service SID (starts with "MG...")
 *   PUBLIC_BASE_URL             — Public origin for form links in the SMS
 *                                 (e.g. an ngrok URL). Without it, phones can't
 *                                 open a localhost link, so only a summary is sent.
 */

// Read env vars lazily (at call time), NOT at module load. Module top-level code
// runs during `import` resolution, which happens BEFORE dotenv.config() executes
// in server.ts — so reading them here at the top would always see empty values.
const accountSid = () => process.env.TWILIO_ACCOUNT_SID || '';
const authToken = () => process.env.TWILIO_AUTH_TOKEN || '';
const verifyServiceSid = () => process.env.TWILIO_VERIFY_SERVICE_SID || '';
const defaultCountryCode = () => process.env.OTP_DEFAULT_COUNTRY_CODE || '+91';
const fromNumber = () => process.env.TWILIO_FROM_NUMBER || '';
const messagingServiceSid = () => process.env.TWILIO_MESSAGING_SERVICE_SID || '';
export const publicBaseUrl = () => (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');

let twilioClient: any = null;

/**
 * True when all Twilio Verify credentials are present, i.e. real OTP is active.
 */
export function isRealOtpEnabled(): boolean {
  return Boolean(accountSid() && authToken() && verifyServiceSid());
}

/**
 * True when we can send arbitrary SMS (Programmable Messaging): needs account
 * credentials plus a sender (a from-number or a messaging service SID).
 */
export function isSmsEnabled(): boolean {
  return Boolean(accountSid() && authToken() && (fromNumber() || messagingServiceSid()));
}

function getClient(): any {
  if (twilioClient) return twilioClient;
  // Lazy require so `twilio` is an optional dependency: the app runs without it
  // as long as real OTP is disabled.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const twilio = require('twilio');
  twilioClient = twilio(accountSid(), authToken());
  return twilioClient;
}

/**
 * Normalize a mobile number to E.164 format (e.g. +919876543210).
 * If it already starts with "+", it is used as-is. A leading "0" is stripped
 * before the country code is applied.
 */
export function toE164(mobile: string): string {
  const raw = (mobile || '').trim();
  if (raw.startsWith('+')) {
    return '+' + raw.slice(1).replace(/\D/g, '');
  }
  const digits = raw.replace(/\D/g, '').replace(/^0+/, '');
  return `${defaultCountryCode()}${digits}`;
}

export interface OtpResult {
  success: boolean;
  to?: string;
  error?: string;
}

/**
 * Trigger an OTP to be sent to the given mobile number via SMS.
 *
 * NOTE ON MESSAGE BODY: With Twilio Verify we do NOT control the SMS text.
 * Twilio generates the code and the message from the template attached to the
 * Verify Service, e.g. "Your <ServiceFriendlyName> verification code is: 123456".
 * Change the wording in the Twilio console (Verify -> Services -> Templates),
 * not here.
 */
export async function sendOtp(mobile: string): Promise<OtpResult> {
  if (!isRealOtpEnabled()) {
    console.warn('[OTP] Real OTP disabled (missing Twilio env vars) — falling back to demo OTP.');
    return { success: false, error: 'Real OTP is not configured.' };
  }
  const to = toE164(mobile);
  console.log(`[OTP] ▶ Sending OTP request to Twilio Verify | raw="${mobile}" -> e164="${to}" | service=${verifyServiceSid()} | channel=sms`);
  try {
    const client = getClient();
    const verification = await client.verify.v2
      .services(verifyServiceSid())
      .verifications.create({ to, channel: 'sms' });

    // verification.status is "pending" once Twilio has accepted and dispatched the SMS.
    console.log(
      `[OTP] ✅ Twilio accepted the send | to=${verification.to} | status=${verification.status} ` +
      `| sid=${verification.sid} | channel=${verification.channel} | valid=${verification.valid}`
    );
    console.log(`[OTP] 📩 SMS body sent by Twilio: "Your <${'Verify service friendly name'}> verification code is: <6-digit code>" (exact text set by your Verify Service template)`);

    const delivered = verification.status === 'pending' || verification.status === 'approved';
    if (!delivered) {
      console.warn(`[OTP] ⚠ Unexpected send status "${verification.status}" — the SMS may not have been delivered.`);
    }
    return { success: delivered, to };
  } catch (e: any) {
    // Common causes: unverified number on a trial account (error 60200/21608),
    // bad Verify Service SID, or invalid credentials.
    console.error(`[OTP] ❌ Failed to send OTP to ${to} | code=${e?.code || 'n/a'} | status=${e?.status || 'n/a'} | message=${e?.message || e}`);
    if (e?.moreInfo) console.error(`[OTP]    moreInfo: ${e.moreInfo}`);
    return { success: false, to, error: e?.message || 'Failed to send OTP.' };
  }
}

/**
 * Verify the OTP the customer entered against the code Twilio sent.
 * Returns success only when Twilio reports the check as "approved".
 */
export async function checkOtp(mobile: string, code: string): Promise<OtpResult> {
  if (!isRealOtpEnabled()) {
    return { success: false, error: 'Real OTP is not configured.' };
  }
  const to = toE164(mobile);
  const cleanCode = (code || '').replace(/\D/g, '');
  console.log(`[OTP] ▶ Checking OTP with Twilio Verify | to=${to} | codeLength=${cleanCode.length} | service=${verifyServiceSid()}`);
  try {
    const client = getClient();
    const check = await client.verify.v2
      .services(verifyServiceSid())
      .verificationChecks.create({ to, code: cleanCode });

    const approved = check.status === 'approved';
    console.log(`[OTP] ${approved ? '✅' : '❌'} Verification check result | to=${check.to} | status=${check.status} | valid=${check.valid} | sid=${check.sid}`);
    return { success: approved, to };
  } catch (e: any) {
    // Twilio throws 404 when the code has expired or the verification was already consumed.
    console.error(`[OTP] ❌ Failed to verify OTP for ${to} | code=${e?.code || 'n/a'} | status=${e?.status || 'n/a'} | message=${e?.message || e}`);
    if (e?.moreInfo) console.error(`[OTP]    moreInfo: ${e.moreInfo}`);
    return { success: false, to, error: e?.message || 'Failed to verify OTP.' };
  }
}
