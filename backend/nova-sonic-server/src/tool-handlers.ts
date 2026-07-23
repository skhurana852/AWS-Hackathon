import path from 'path';
import fs from 'fs';
import { SessionState } from './types';
import { saveForm } from './form-generator';
import { isRealOtpEnabled, sendOtp, checkOtp } from './otp-service';

/**
 * Banking tool handlers for Nova Sonic tool-use.
 * Uses in-memory mock data loaded from JSON files for local development.
 */

// ─── Mock Data Store ──────────────────────────────────────────────────────────

interface Customer {
  customerId: string;
  aadhaarLast4: string;
  fullName: string;
  maskedName: string;
  pan: string;
  mobile: string;
  demoOtp: string;
  accounts: string[];
}

interface Account {
  accountId: string;
  customerId: string;
  type: string;
  balance: number;
  currency: string;
  branch: string;
  lastTxnDate: string;
  status: string;
}

interface RateSlab {
  minMonths: number;
  maxMonths: number;
  rate: number;
}

interface RatesData {
  slabs: RateSlab[];
  minAmount: number;
  maxAmount: number;
}

// Load mock data - resolve path relative to this file's location in src/
// When running from source: __dirname = .../nova-sonic-server/src
// When running compiled: __dirname = .../nova-sonic-server/dist
const MOCK_DATA_PATH = path.resolve(__dirname, '..', '..', 'mock-data');

let customers: Customer[] = [];
let accounts: Account[] = [];
let ratesData: RatesData = { slabs: [], minAmount: 1000, maxAmount: 10000000 };
let authRetryCount: Map<string, number> = new Map();

function loadMockData(): void {
  try {
    customers = JSON.parse(fs.readFileSync(path.join(MOCK_DATA_PATH, 'customers.json'), 'utf-8'));
    accounts = JSON.parse(fs.readFileSync(path.join(MOCK_DATA_PATH, 'accounts.json'), 'utf-8'));
    ratesData = JSON.parse(fs.readFileSync(path.join(MOCK_DATA_PATH, 'interest-rates.json'), 'utf-8'));
    console.log(`[MockData] Loaded ${customers.length} customers, ${accounts.length} accounts`);
  } catch (e) {
    console.error('[MockData] Error loading mock data:', e);
  }
}

// Load on module import
loadMockData();

// ─── Helper Functions ─────────────────────────────────────────────────────────

function generateRef(prefix: string): string {
  const ts = Date.now().toString().slice(-8);
  const rand = Math.floor(Math.random() * 1000).toString().padStart(3, '0');
  return `${prefix}${ts}${rand}`;
}

function calculateFdMaturity(principal: number, tenureMonths: number, annualRate: number): number {
  const maturityAmount = principal * (1 + (annualRate / 100) * (tenureMonths / 12));
  return Math.round(maturityAmount * 100) / 100;
}

function getFdRate(tenureMonths: number): number | null {
  const slab = ratesData.slabs.find(s => tenureMonths >= s.minMonths && tenureMonths <= s.maxMonths);
  return slab ? slab.rate : null;
}

function addMonths(dateStr: string, months: number): string {
  const d = new Date(dateStr);
  d.setMonth(d.getMonth() + months);
  return d.toISOString().split('T')[0];
}

// Generate an FD form, returning undefined on failure so a booking never fails
// just because the document could not be written.
function generateFdForm(customer: Customer | undefined, data: any) {
  try {
    const form = saveForm('FD_REQUEST', data, {
      customerId: customer?.customerId || data.customerId || '—',
      maskedName: customer?.maskedName,
      fullName: customer?.fullName,
      pan: data.pan
    });
    console.log(`[Form] ✅ FD form generated | ref=${form.refNo} | url=${form.url} | file=${form.filePath}`);
    return form;
  } catch (e) {
    console.error('[ToolHandler] FD form generation failed:', e);
    return undefined;
  }
}

// Generate a withdrawal slip/receipt, returning undefined on failure.
function generateWithdrawalForm(customer: Customer | undefined, data: any) {
  try {
    const form = saveForm('WITHDRAWAL_SLIP', data, {
      customerId: customer?.customerId || data.customerId || '—',
      maskedName: customer?.maskedName,
      fullName: customer?.fullName
    });
    console.log(`[Form] ✅ Withdrawal form generated | ref=${form.refNo} | url=${form.url} | file=${form.filePath}`);
    return form;
  } catch (e) {
    console.error('[ToolHandler] Withdrawal form generation failed:', e);
    return undefined;
  }
}

// ─── Tool Handlers ────────────────────────────────────────────────────────────

export async function handleVerifyAadhaar(input: any): Promise<any> {
  const { aadhaarLast4 } = input;

  if (!aadhaarLast4 || !/^\d{4}$/.test(aadhaarLast4)) {
    return { error: "Please provide exactly 4 digits of your Aadhaar number." };
  }

  const customer = customers.find(c => c.aadhaarLast4 === aadhaarLast4);
  if (!customer) {
    return { error: "We could not find an account linked to those Aadhaar digits. Please visit the counter." };
  }

  const mobileLast4 = customer.mobile.slice(-4);
  // Kept for the visual UI card only — NEVER meant to be read aloud by the voice agent.
  const maskedMobile = `XXXXXX${mobileLast4}`;

  // Real OTP path: dispatch a live SMS OTP via the OTP service (Twilio Verify).
  if (isRealOtpEnabled()) {
    const sent = await sendOtp(customer.mobile);
    if (!sent.success) {
      return {
        error: "We couldn't send the OTP to your registered number right now. Please try again or visit the counter."
      };
    }
    // Reset any prior retry counter for a fresh challenge.
    authRetryCount.set(customer.customerId, 0);
    return {
      success: true,
      customerId: customer.customerId,
      maskedName: customer.maskedName,
      maskedMobile,
      mobileLast4,
      message: `I've sent a 6-digit OTP to the mobile number ending in ${mobileLast4}. Please tell me the code once you receive it. Never read the masked number or its X characters aloud — refer to it only by the last 4 digits (${mobileLast4}).`
    };
  }

  // Mock path (no OTP provider configured): the fixed demoOtp is used.
  return {
    success: true,
    customerId: customer.customerId,
    maskedName: customer.maskedName,
    maskedMobile,
    mobileLast4,
    message: `OTP sent to the mobile number ending in ${mobileLast4}. Never read the masked number or its X characters aloud — refer to it only by the last 4 digits (${mobileLast4}).`
  };
}

export async function handleVerifyOtp(input: any, sessionState: SessionState): Promise<any> {
  const { customerId, otp } = input;

  if (!customerId || !otp) {
    return { error: "customerId and otp are required." };
  }

  const customer = customers.find(c => c.customerId === customerId);
  if (!customer) {
    return { error: "Customer not found." };
  }

  // Check retry count
  const retryCount = authRetryCount.get(customerId) || 0;
  if (retryCount >= 3) {
    return { error: "Too many failed attempts. Please visit the nearest counter with a valid ID." };
  }

  // Validate OTP — real (Twilio Verify) when configured, else the demo OTP.
  const cleanOtp = otp.replace(/\D/g, '').slice(0, 6);
  let otpValid: boolean;
  if (isRealOtpEnabled()) {
    const check = await checkOtp(customer.mobile, cleanOtp);
    otpValid = check.success;
  } else {
    otpValid = cleanOtp === customer.demoOtp;
  }

  if (!otpValid) {
    authRetryCount.set(customerId, retryCount + 1);
    const remaining = 3 - retryCount - 1;
    if (remaining === 0) {
      return { error: "Incorrect OTP. You have used all 3 attempts. Please visit the counter." };
    }
    return { error: `Incorrect OTP. You have ${remaining} attempt(s) remaining.` };
  }

  // Success — reset retry count
  authRetryCount.set(customerId, 0);

  // Update session state
  sessionState.customerId = customerId;
  sessionState.authenticated = true;
  sessionState.authToken = `mock-token-${customerId}-${Date.now()}`;

  return {
    success: true,
    customerId,
    customerName: customer.maskedName,
    message: `Welcome, ${customer.maskedName}! You are now authenticated. How can I help you today?`
  };
}

export async function handleCheckBalance(input: any, sessionState: SessionState): Promise<any> {
  const { customerId } = input;

  if (!sessionState.authenticated) {
    return { error: "Please authenticate first by providing your Aadhaar and OTP." };
  }

  if (customerId !== sessionState.customerId) {
    return { error: "You can only check your own account balance." };
  }

  const customerAccounts = accounts.filter(a => a.customerId === customerId);
  if (customerAccounts.length === 0) {
    return { error: "No accounts found for this customer." };
  }

  const accountSummary = customerAccounts.map(a => ({
    accountId: a.accountId,
    type: a.type,
    balance: a.balance,
    currency: a.currency,
    branch: a.branch,
    lastTxnDate: a.lastTxnDate
  }));

  return {
    success: true,
    customerId,
    accountCount: accountSummary.length,
    accounts: accountSummary,
    totalBalance: customerAccounts.reduce((sum, a) => sum + a.balance, 0)
  };
}

export async function handleGetFdQuote(input: any): Promise<any> {
  const { amount, tenureMonths } = input;

  if (!amount || !tenureMonths) {
    return { error: "amount and tenureMonths are required." };
  }
  if (amount < 1000) {
    return { error: "Minimum FD amount is ₹1,000." };
  }
  if (tenureMonths < 7 || tenureMonths > 120) {
    return { error: "Tenure must be between 7 and 120 months." };
  }

  const rate = getFdRate(tenureMonths);
  if (!rate) {
    return { error: "No interest rate available for this tenure." };
  }

  const startDate = new Date().toISOString().split('T')[0];
  const maturityDate = addMonths(startDate, tenureMonths);
  const maturityAmount = calculateFdMaturity(amount, tenureMonths, rate);

  return {
    success: true,
    principal: amount,
    tenureMonths,
    rate,
    maturityAmount,
    startDate,
    maturityDate,
    interestEarned: Math.round((maturityAmount - amount) * 100) / 100
  };
}

export async function handleBookFd(input: any, sessionState: SessionState): Promise<any> {
  const { customerId, pan, amount, tenureMonths, route } = input;

  if (!sessionState.authenticated) {
    return { error: "Please authenticate first." };
  }
  if (customerId !== sessionState.customerId) {
    return { error: "You can only book FDs for your own account." };
  }
  if (!pan || !amount || !tenureMonths || !route) {
    return { error: "pan, amount, tenureMonths, and route (DIGITAL|MANUAL) are all required." };
  }
  if (!["DIGITAL", "MANUAL"].includes(route)) {
    return { error: "route must be DIGITAL or MANUAL." };
  }

  const rate = getFdRate(tenureMonths);
  if (!rate) {
    return { error: "No rate available for this tenure." };
  }

  const maturityAmount = calculateFdMaturity(amount, tenureMonths, rate);
  const startDate = new Date().toISOString().split('T')[0];
  const maturityDate = addMonths(startDate, tenureMonths);
  const fdRefNo = generateRef("FDREF");
  const customer = customers.find(c => c.customerId === customerId);

  if (route === "DIGITAL") {
    // Find primary account and debit
    const primaryAccount = accounts.find(a => a.customerId === customerId && a.type === 'SAVINGS');
    if (!primaryAccount) {
      return { error: "No savings account found to debit." };
    }
    if (primaryAccount.balance < amount) {
      return { error: `Insufficient balance. Available: ₹${primaryAccount.balance}` };
    }

    // Mock debit
    primaryAccount.balance -= amount;

    const digitalForm = generateFdForm(customer, {
      route: "DIGITAL", pan, amount, tenureMonths, rate,
      maturityAmount, maturityDate, fdRefNo,
      debitedFrom: primaryAccount.accountId
    });

    return {
      success: true,
      fdRefNo,
      route: "DIGITAL",
      debitedFrom: primaryAccount.accountId,
      newBalance: primaryAccount.balance,
      principal: amount,
      tenureMonths,
      rate,
      maturityAmount,
      maturityDate,
      formUrl: digitalForm?.url,
      formRef: digitalForm?.refNo,
      message: `Your Fixed Deposit of ₹${amount} has been created successfully! FD Reference: ${fdRefNo}. It will mature on ${maturityDate} with a maturity amount of ₹${maturityAmount}. Your confirmation receipt is ready to view.`
    };
  }

  // MANUAL route
  const counterToken = generateRef("TKN");

  const manualForm = generateFdForm(customer, {
    route: "MANUAL", pan, amount, tenureMonths, rate,
    maturityAmount, maturityDate, fdRefNo, counterToken
  });

  return {
    success: true,
    fdRefNo,
    route: "MANUAL",
    status: "PENDING_CASH",
    counterToken,
    principal: amount,
    tenureMonths,
    rate,
    maturityAmount,
    maturityDate,
    formUrl: manualForm?.url,
    formRef: manualForm?.refNo,
    message: `Your FD request form has been generated! Please proceed to Counter 2 with token ${counterToken}. The teller will complete your ₹${amount} Fixed Deposit. Your FD Reference is ${fdRefNo}.`
  };
}

export async function handleWithdrawCash(input: any, sessionState: SessionState): Promise<any> {
  const { customerId, accountId, amount, channel } = input;

  if (!sessionState.authenticated) {
    return { error: "Please authenticate first." };
  }
  if (customerId !== sessionState.customerId) {
    return { error: "You can only withdraw from your own account." };
  }
  if (!amount || !channel) {
    return { error: "amount and channel (KIOSK|MANUAL) are required." };
  }
  if (!["KIOSK", "MANUAL"].includes(channel)) {
    return { error: "channel must be KIOSK or MANUAL." };
  }
  if (amount < 100) {
    return { error: "Minimum withdrawal amount is ₹100." };
  }
  if (amount % 100 !== 0) {
    return { error: "Amount must be in multiples of ₹100." };
  }

  // Find the account
  let account: Account | undefined;
  if (accountId) {
    account = accounts.find(a => a.accountId === accountId && a.customerId === customerId);
  } else {
    // Use primary savings account
    account = accounts.find(a => a.customerId === customerId && a.type === 'SAVINGS');
  }

  if (!account) {
    return { error: "Account not found." };
  }
  if (account.balance < amount) {
    return { error: `Insufficient balance. Your available balance is ₹${account.balance}.` };
  }

  const txnRef = generateRef("TXN");
  const customer = customers.find(c => c.customerId === customerId);

  if (channel === "KIOSK") {
    // Mock dispense — deduct from balance
    account.balance -= amount;

    const kioskForm = generateWithdrawalForm(customer, {
      channel: "KIOSK", accountId: account.accountId, amount,
      newBalance: account.balance, txnRef
    });

    return {
      success: true,
      status: "DISPENSED",
      txnRef,
      amount,
      newBalance: account.balance,
      formUrl: kioskForm?.url,
      formRef: kioskForm?.refNo,
      message: `₹${amount} has been dispensed. Please collect your cash. Your new balance is ₹${account.balance}. Your withdrawal receipt is ready to view.`
    };
  }

  // MANUAL route
  const counterToken = generateRef("TKN");

  const manualForm = generateWithdrawalForm(customer, {
    channel: "MANUAL", accountId: account.accountId, amount, txnRef, counterToken
  });

  return {
    success: true,
    status: "FORM_GENERATED",
    txnRef,
    counterToken,
    amount,
    formUrl: manualForm?.url,
    formRef: manualForm?.refNo,
    message: `Your withdrawal slip for ₹${amount} has been generated! Please proceed to Counter 3 with token number ${counterToken}. The teller will hand you the cash.`
  };
}

// ─── Main Tool Dispatcher ─────────────────────────────────────────────────────

export async function processToolUse(
  toolName: string,
  toolInput: any,
  sessionState: SessionState
): Promise<any> {
  // Parse the tool input content if it's a string
  let parsedInput: any;
  if (toolInput && typeof toolInput.content === 'string') {
    try {
      parsedInput = JSON.parse(toolInput.content);
    } catch {
      parsedInput = toolInput;
    }
  } else if (toolInput && typeof toolInput === 'object') {
    parsedInput = toolInput.content ? toolInput : toolInput;
  } else {
    parsedInput = {};
  }

  console.log(`[ToolHandler] Executing ${toolName} with input:`, JSON.stringify(parsedInput));

  switch (toolName) {
    case "verifyAadhaarTool":
      return handleVerifyAadhaar(parsedInput);

    case "verifyOtpTool":
      return handleVerifyOtp(parsedInput, sessionState);

    case "checkBalanceTool":
      return handleCheckBalance(parsedInput, sessionState);

    case "getFdQuoteTool":
      return handleGetFdQuote(parsedInput);

    case "bookFdTool":
      return handleBookFd(parsedInput, sessionState);

    case "withdrawCashTool":
      return handleWithdrawCash(parsedInput, sessionState);

    default:
      console.warn(`[ToolHandler] Unknown tool: ${toolName}`);
      return { error: `Tool '${toolName}' is not supported.` };
  }
}
