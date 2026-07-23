/**
 * Balance / Account Status Lambda — GET /accounts/{customerId}
 * Returns all accounts belonging to an authenticated customer.
 */
const {
  ddb, TABLE, ok, badReq, unauth, notFound, err500,
  QueryCommand, verifyToken
} = require("./utils");

exports.handler = async (event) => {
  try {
    const authHeader = event.headers?.Authorization || event.headers?.authorization || "";
    const token = authHeader.replace("Bearer ", "").trim();
    const payload = verifyToken(token);
    if (!payload) return unauth("Session expired or invalid. Please re-authenticate.");

    const { customerId } = event.pathParameters || {};
    if (!customerId) return badReq("customerId path parameter is required.");

    // Only allow a customer to query their own accounts
    if (payload.customerId !== customerId) {
      return unauth("You can only access your own accounts.");
    }

    const result = await ddb.send(new QueryCommand({
      TableName: TABLE.ACCOUNTS,
      IndexName: "customerId-index",
      KeyConditionExpression: "customerId = :c",
      ExpressionAttributeValues: { ":c": customerId }
    }));

    if (!result.Items || result.Items.length === 0) {
      return notFound("No accounts found for this customer.");
    }

    const accounts = result.Items.map(acc => ({
      accountId: acc.accountId,
      type: acc.type,
      balance: acc.balance,
      currency: acc.currency || "INR",
      branch: acc.branch,
      lastTxnDate: acc.lastTxnDate,
      status: acc.status
    }));

    return ok({ customerId, accounts });

  } catch (e) {
    console.error("balance-flow error:", e);
    return err500("Unable to fetch account details. Please try again.");
  }
};
