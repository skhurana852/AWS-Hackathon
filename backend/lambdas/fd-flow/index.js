/**
 * Fixed Deposit Lambda
 *   POST /fd/quote  — compute maturity details
 *   POST /fd/book   — book FD (digital or manual route)
 *   GET  /fd/{customerId} — list FDs for a customer
 */
const {
  ddb, TABLE, ok, created, badReq, unauth, err500,
  GetCommand, PutCommand, QueryCommand, ScanCommand,
  verifyToken, calculateFdMaturity, getFdRate, addMonths, generateRef
} = require("./utils");

// ─── Helper: load interest rate slabs from DDB (or fallback) ────────────────
const getSlabs = async () => {
  try {
    const r = await ddb.send(new GetCommand({
      TableName: TABLE.RATES,
      Key: { rateId: "FD_STANDARD" }
    }));
    return r.Item?.slabs || defaultSlabs();
  } catch {
    return defaultSlabs();
  }
};

const defaultSlabs = () => [
  { minMonths: 7,  maxMonths: 11,  rate: 4.50 },
  { minMonths: 12, maxMonths: 17,  rate: 6.50 },
  { minMonths: 18, maxMonths: 23,  rate: 7.00 },
  { minMonths: 24, maxMonths: 35,  rate: 7.00 },
  { minMonths: 36, maxMonths: 47,  rate: 7.10 },
  { minMonths: 48, maxMonths: 59,  rate: 7.10 },
  { minMonths: 60, maxMonths: 120, rate: 6.50 }
];

// ─── Route dispatcher ────────────────────────────────────────────────────────
exports.handler = async (event) => {
  const method = event.httpMethod || event.requestContext?.http?.method;
  const path   = event.path || event.rawPath || "";

  if (method === "GET" && path.includes("/fd/")) return listFds(event);
  if (method === "POST" && path.endsWith("/fd/quote")) return quoteFd(event);
  if (method === "POST" && path.endsWith("/fd/book"))  return bookFd(event);

  return badReq("Unknown FD endpoint.");
};

// ─── Quote ──────────────────────────────────────────────────────────────────
const quoteFd = async (event) => {
  const authHeader = event.headers?.Authorization || event.headers?.authorization || "";
  const token = authHeader.replace("Bearer ", "").trim();
  if (!verifyToken(token)) return unauth("Session expired. Please re-authenticate.");

  const body = JSON.parse(event.body || "{}");
  const { amount, tenureMonths } = body;

  if (!amount || !tenureMonths) return badReq("amount and tenureMonths are required.");
  if (amount < 1000) return badReq("Minimum FD amount is ₹1,000.");
  if (tenureMonths < 7 || tenureMonths > 120) return badReq("Tenure must be between 7 and 120 months.");

  const slabs = await getSlabs();
  const rate  = getFdRate(tenureMonths, slabs);
  if (!rate) return badReq("No interest rate available for this tenure.");

  const maturityAmount = calculateFdMaturity(amount, tenureMonths, rate);
  const startDate      = new Date().toISOString().split("T")[0];
  const maturityDate   = addMonths(startDate, tenureMonths);

  return ok({
    principal: amount,
    tenureMonths,
    rate,
    maturityAmount,
    startDate,
    maturityDate,
    interestEarned: Math.round((maturityAmount - amount) * 100) / 100
  });
};

// ─── Book ───────────────────────────────────────────────────────────────────
const bookFd = async (event) => {
  const authHeader = event.headers?.Authorization || event.headers?.authorization || "";
  const token = authHeader.replace("Bearer ", "").trim();
  const payload = verifyToken(token);
  if (!payload) return unauth("Session expired. Please re-authenticate.");

  const body = JSON.parse(event.body || "{}");
  const { pan, amount, tenureMonths, route, accountId } = body;

  if (!pan || !amount || !tenureMonths || !route) {
    return badReq("pan, amount, tenureMonths, and route (DIGITAL|MANUAL) are required.");
  }
  if (!["DIGITAL", "MANUAL"].includes(route)) {
    return badReq("route must be DIGITAL or MANUAL.");
  }

  const customerId = payload.customerId;
  const slabs      = await getSlabs();
  const rate        = getFdRate(tenureMonths, slabs);
  if (!rate) return badReq("No rate for this tenure.");

  const maturityAmount = calculateFdMaturity(amount, tenureMonths, rate);
  const startDate      = new Date().toISOString().split("T")[0];
  const maturityDate   = addMonths(startDate, tenureMonths);
  const fdRefNo        = generateRef("FDREF");

  if (route === "DIGITAL") {
    // Deduct from the linked account (mock)
    const sourceAccountId = accountId || (await getPrimaryAccount(customerId));
    if (sourceAccountId) {
      await debitAccount(sourceAccountId, amount);
    }

    const fdItem = {
      fdId: generateRef("FD"),
      customerId,
      accountId: sourceAccountId,
      pan,
      principal: amount,
      tenureMonths,
      rate,
      maturityAmount,
      startDate,
      maturityDate,
      fdRefNo,
      route: "DIGITAL",
      status: "ACTIVE",
      createdAt: Date.now()
    };

    await ddb.send(new PutCommand({ TableName: TABLE.FDS, Item: fdItem }));

    // Fetch updated balance for confirmation
    const acctResult = await ddb.send(new GetCommand({
      TableName: TABLE.ACCOUNTS,
      Key: { accountId: sourceAccountId }
    }));

    return created({
      fdRefNo,
      debitedFrom: sourceAccountId,
      newBalance: acctResult.Item?.balance ?? null,
      maturityAmount,
      maturityDate,
      message: `Your Fixed Deposit of ₹${amount} has been created successfully! FD Reference: ${fdRefNo}. It will mature on ${maturityDate} with a maturity amount of ₹${maturityAmount}.`
    });
  }

  // MANUAL route — generate form and raise teller task
  const counterToken = generateRef("TKN");
  const formKey = `fd-forms/${customerId}/${fdRefNo}.json`;  // In prod: generate PDF

  // Store provisional FD record
  await ddb.send(new PutCommand({
    TableName: TABLE.FDS,
    Item: {
      fdId: generateRef("FD"),
      customerId,
      pan,
      principal: amount,
      tenureMonths,
      rate,
      maturityAmount,
      startDate,
      maturityDate,
      fdRefNo,
      route: "MANUAL",
      status: "PENDING_CASH",
      counterToken,
      createdAt: Date.now()
    }
  }));

  // Raise teller task
  await ddb.send(new PutCommand({
    TableName: TABLE.TASKS,
    Item: {
      taskId: generateRef("TASK"),
      type: "FD_CASH_DEPOSIT",
      customerId,
      fdRefNo,
      amount,
      tenureMonths,
      counterToken,
      formKey,
      status: "PENDING",
      createdAt: Date.now(),
      expiresAt: Math.floor(Date.now() / 1000) + 3600
    }
  }));

  return created({
    fdRefNo,
    status: "PENDING_CASH",
    counterToken,
    formKey,
    message: `Your FD request has been prepared! Please proceed to Counter 2 with token ${counterToken}. The teller will complete your ₹${amount} Fixed Deposit. Your FD Reference is ${fdRefNo}.`
  });
};

// ─── List FDs ────────────────────────────────────────────────────────────────
const listFds = async (event) => {
  const authHeader = event.headers?.Authorization || event.headers?.authorization || "";
  const token = authHeader.replace("Bearer ", "").trim();
  const payload = verifyToken(token);
  if (!payload) return unauth("Session expired.");

  const { customerId } = event.pathParameters || {};
  if (payload.customerId !== customerId) return unauth("Access denied.");

  const result = await ddb.send(new QueryCommand({
    TableName: TABLE.FDS,
    IndexName: "customerId-index",
    KeyConditionExpression: "customerId = :c",
    ExpressionAttributeValues: { ":c": customerId }
  }));

  return ok({ customerId, fds: result.Items || [] });
};

// ─── Helpers ─────────────────────────────────────────────────────────────────
const getPrimaryAccount = async (customerId) => {
  const r = await ddb.send(new QueryCommand({
    TableName: TABLE.ACCOUNTS,
    IndexName: "customerId-index",
    KeyConditionExpression: "customerId = :c",
    ExpressionAttributeValues: { ":c": customerId },
    Limit: 1
  }));
  return r.Items?.[0]?.accountId ?? null;
};

const { UpdateCommand } = require("./utils");
const debitAccount = async (accountId, amount) => {
  await ddb.send(new UpdateCommand({
    TableName: TABLE.ACCOUNTS,
    Key: { accountId },
    UpdateExpression: "SET balance = balance - :a, lastTxnDate = :d",
    ExpressionAttributeValues: {
      ":a": amount,
      ":d": new Date().toISOString().split("T")[0]
    },
    ConditionExpression: "balance >= :a"
  }));
};
