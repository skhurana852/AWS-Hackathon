/**
 * Auth Lambda — POST /auth/verify-otp
 * Validates the OTP spoken by the customer and issues a session token.
 * Also tracks consecutive failure count (max 3 retries).
 */
const {
  ddb, TABLE, ok, badReq, unauth, err500,
  GetCommand, PutCommand, UpdateCommand,
  issueToken
} = require("./utils");

const MAX_RETRIES = 3;

exports.handler = async (event) => {
  try {
    const body = JSON.parse(event.body || "{}");
    const { customerId, otp } = body;

    if (!customerId || !otp) {
      return badReq("customerId and otp are required.");
    }

    // Fetch customer record
    const customerResult = await ddb.send(new GetCommand({
      TableName: TABLE.CUSTOMERS,
      Key: { customerId }
    }));

    if (!customerResult.Item) {
      return unauth("Customer not found.");
    }

    const customer = customerResult.Item;

    // Check retry count
    const retryCount = customer.authRetryCount || 0;
    if (retryCount >= MAX_RETRIES) {
      return unauth(
        "Too many failed attempts. For your security, please visit the nearest counter with a valid ID."
      );
    }

    // Validate OTP (mock: compare against demoOtp stored in customer record)
    if (otp.trim() !== customer.demoOtp) {
      // Increment retry counter
      await ddb.send(new UpdateCommand({
        TableName: TABLE.CUSTOMERS,
        Key: { customerId },
        UpdateExpression: "SET authRetryCount = :r",
        ExpressionAttributeValues: { ":r": retryCount + 1 }
      }));

      const remaining = MAX_RETRIES - retryCount - 1;
      if (remaining === 0) {
        return unauth(
          "Incorrect OTP. You have used all 3 attempts. Please visit the counter."
        );
      }
      return unauth(`Incorrect OTP. You have ${remaining} attempt(s) remaining.`);
    }

    // Success — reset retry count, issue token
    await ddb.send(new UpdateCommand({
      TableName: TABLE.CUSTOMERS,
      Key: { customerId },
      UpdateExpression: "SET authRetryCount = :r",
      ExpressionAttributeValues: { ":r": 0 }
    }));

    const authToken = await issueToken(customerId);

    // Persist session in DynamoDB (TTL = 30 min)
    await ddb.send(new PutCommand({
      TableName: TABLE.SESSIONS,
      Item: {
        sessionId: authToken.slice(0, 40),
        customerId,
        authToken,
        language: "en",
        currentState: "AUTHENTICATED",
        createdAt: Date.now(),
        expiresAt: Math.floor(Date.now() / 1000) + 1800  // TTL for DynamoDB
      }
    }));

    return ok({
      authToken,
      status: "SUCCESS",
      customerId,
      message: `Welcome, ${customer.maskedName}! How can I help you today?`
    });

  } catch (e) {
    console.error("verify-otp error:", e);
    return err500("Authentication service is currently unavailable. Please visit the counter.");
  }
};
