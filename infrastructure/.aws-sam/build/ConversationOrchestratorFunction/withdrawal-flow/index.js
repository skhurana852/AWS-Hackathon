/**
 * Cash Withdrawal Lambda — POST /withdrawal/execute
 * Handles both KIOSK (mock dispense) and MANUAL (teller form) routes.
 */
const {
  ddb, TABLE, ok, created, badReq, unauth, err500,
  GetCommand, PutCommand, QueryCommand, UpdateCommand,
  verifyToken, generateRef
} = require("./utils");

exports.handler = async (event) => {
  try {
    const authHeader = event.headers?.Authorization || event.headers?.authorization || "";
    const token = authHeader.replace("Bearer ", "").trim();
    const payload = verifyToken(token);
    if (!payload) return unauth("Session expired. Please re-authenticate.");

    const body = JSON.parse(event.body || "{}");
    const { accountId, amount, channel, denominationPreference } = body;

    if (!accountId || !amount || !channel) {
      return badReq("accountId, amount, and channel (KIOSK|MANUAL) are required.");
    }
    if (!["KIOSK", "MANUAL"].includes(channel)) {
      return badReq("channel must be KIOSK or MANUAL.");
    }
    if (amount < 100) return badReq("Minimum withdrawal amount is ₹100.");
    if (amount % 100 !== 0) return badReq("Amount must be in multiples of ₹100.");

    // Validate account ownership
    const acctResult = await ddb.send(new GetCommand({
      TableName: TABLE.ACCOUNTS,
      Key: { accountId }
    }));

    if (!acctResult.Item) {
      return badReq("Account not found.");
    }

    const account = acctResult.Item;
    if (account.customerId !== payload.customerId) {
      return unauth("You can only withdraw from your own account.");
    }

    if (account.balance < amount) {
      return badReq(`Insufficient balance. Your available balance is ₹${account.balance}.`);
    }

    const txnRef = generateRef("TXN");

    if (channel === "KIOSK") {
      // Mock dispense — deduct from balance
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

      const newBalance = account.balance - amount;

      return ok({
        status: "DISPENSED",
        txnRef,
        amount,
        newBalance,
        denominationPreference: denominationPreference || null,
        message: `₹${amount} has been dispensed. Please collect your cash. Your new balance is ₹${newBalance}.`
      });
    }

    // MANUAL route — generate withdrawal slip and raise teller task
    const counterToken = generateRef("TKN");
    const formKey = `withdrawal-slips/${payload.customerId}/${txnRef}.json`;

    // Raise teller task
    await ddb.send(new PutCommand({
      TableName: TABLE.TASKS,
      Item: {
        taskId: generateRef("TASK"),
        type: "CASH_WITHDRAWAL",
        customerId: payload.customerId,
        accountId,
        txnRef,
        amount,
        denominationPreference: denominationPreference || null,
        counterToken,
        formKey,
        status: "PENDING",
        createdAt: Date.now(),
        expiresAt: Math.floor(Date.now() / 1000) + 3600
      }
    }));

    return created({
      status: "FORM_GENERATED",
      txnRef,
      counterToken,
      formKey,
      message: `Your withdrawal slip for ₹${amount} is ready! Please proceed to Counter 3 with token number ${counterToken}. The teller will hand you the cash.`
    });

  } catch (e) {
    console.error("withdrawal-flow error:", e);
    if (e.name === "ConditionalCheckFailedException") {
      return badReq("Insufficient balance. Please try a smaller amount.");
    }
    return err500("Withdrawal service is temporarily unavailable. Please try again.");
  }
};
