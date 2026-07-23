// Shared utility for DynamoDB client and response helpers
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, ScanCommand, UpdateCommand } = require("@aws-sdk/lib-dynamodb");

const IS_LOCAL = process.env.IS_LOCAL === "true";

const ddbClient = new DynamoDBClient(
  IS_LOCAL
    ? { region: "ap-south-1", endpoint: "http://localhost:8000" }
    : { region: process.env.AWS_REGION || "ap-south-1" }
);

const ddb = DynamoDBDocumentClient.from(ddbClient, {
  marshallOptions: { removeUndefinedValues: true }
});

const TABLE = {
  CUSTOMERS: process.env.CUSTOMERS_TABLE || "sahayak-customers",
  ACCOUNTS:  process.env.ACCOUNTS_TABLE  || "sahayak-accounts",
  FDS:       process.env.FDS_TABLE       || "sahayak-fds",
  SESSIONS:  process.env.SESSIONS_TABLE  || "sahayak-sessions",
  TASKS:     process.env.TASKS_TABLE     || "sahayak-teller-tasks",
  RATES:     process.env.RATES_TABLE     || "sahayak-interest-rates"
};

// Standard Lambda response helper
const response = (statusCode, body, headers = {}) => ({
  statusCode,
  headers: {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
    ...headers
  },
  body: JSON.stringify(body)
});

const ok      = (body)  => response(200, body);
const created = (body)  => response(201, body);
const badReq  = (msg)   => response(400, { error: msg });
const unauth  = (msg)   => response(401, { error: msg });
const notFound= (msg)   => response(404, { error: msg });
const err500  = (msg)   => response(500, { error: msg });

// Simple JWT-like token (mock — not cryptographically secure)
const crypto = require("crypto");
const { SSMClient, GetParameterCommand } = require("@aws-sdk/client-ssm");
const ssmClient = new SSMClient({ region: process.env.AWS_REGION || "us-east-1" });

let _tokenSecret = null;
const getTokenSecret = async () => {
  if (_tokenSecret) return _tokenSecret;
  const paramName = process.env.TOKEN_SECRET_PARAM;
  if (!paramName) return "sahayak-demo-secret";
  try {
    const resp = await ssmClient.send(new GetParameterCommand({
      Name: paramName,
      WithDecryption: true
    }));
    _tokenSecret = resp.Parameter.Value;
    return _tokenSecret;
  } catch (e) {
    console.warn("SSM fetch failed, using fallback:", e.message);
    return "sahayak-demo-secret";
  }
};

const issueToken = async (customerId) => {
  const secret = await getTokenSecret();
  const payload = { customerId, iat: Date.now(), exp: Date.now() + 30 * 60 * 1000 };
  const b64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", secret)
    .update(b64).digest("base64url");
  return `${b64}.${sig}`;
};

const verifyToken = (token) => {
  try {
    const [b64] = token.split(".");
    const payload = JSON.parse(Buffer.from(b64, "base64url").toString());
    if (Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
};

// Format currency for speech output
const formatCurrency = (amount, lang = "en") => {
  if (lang === "hi") {
    if (amount >= 10000000) return `${(amount / 10000000).toFixed(2)} करोड़ रुपये`;
    if (amount >= 100000)   return `${(amount / 100000).toFixed(2)} लाख रुपये`;
    if (amount >= 1000)     return `${(amount / 1000).toFixed(2)} हज़ार रुपये`;
    return `${amount} रुपये`;
  }
  if (amount >= 10000000) return `${(amount / 10000000).toFixed(2)} crore rupees`;
  if (amount >= 100000)   return `${(amount / 100000).toFixed(2)} lakh rupees`;
  if (amount >= 1000)     return `${(amount / 1000).toFixed(2)} thousand rupees`;
  return `${amount} rupees`;
};

// FD maturity calculation (simple interest for prototype)
const calculateFdMaturity = (principal, tenureMonths, annualRate) => {
  const maturityAmount = principal * (1 + (annualRate / 100) * (tenureMonths / 12));
  return Math.round(maturityAmount * 100) / 100;
};

// Get FD rate from slabs
const getFdRate = (tenureMonths, rateSlabs) => {
  const slab = rateSlabs.find(s => tenureMonths >= s.minMonths && tenureMonths <= s.maxMonths);
  return slab ? slab.rate : null;
};

// Add months to a date
const addMonths = (dateStr, months) => {
  const d = new Date(dateStr);
  d.setMonth(d.getMonth() + months);
  return d.toISOString().split("T")[0];
};

// Generate a unique reference number
const generateRef = (prefix) => {
  const ts = Date.now().toString().slice(-8);
  const rand = Math.floor(Math.random() * 1000).toString().padStart(3, "0");
  return `${prefix}${ts}${rand}`;
};

module.exports = {
  ddb, TABLE,
  ok, created, badReq, unauth, notFound, err500,
  issueToken, verifyToken, getTokenSecret,
  formatCurrency, calculateFdMaturity, getFdRate, addMonths, generateRef,
  GetCommand, PutCommand, QueryCommand, ScanCommand, UpdateCommand
};
