/**
 * Auth Lambda — POST /auth/verify-id
 * Looks up customer by Aadhaar last-4 and initiates OTP challenge
 */
const { ddb, TABLE, ok, badReq, notFound, err500, GetCommand, QueryCommand } = require("./utils");

// In the prototype, mock OTPs are stored in DynamoDB seeded data.
// We also simulate "sending" the OTP by returning a masked mobile.
exports.handler = async (event) => {
  try {
    const body = JSON.parse(event.body || "{}");
    const { aadhaarLast4 } = body;

    if (!aadhaarLast4 || !/^\d{4}$/.test(aadhaarLast4)) {
      return badReq("Please provide the last 4 digits of your Aadhaar number.");
    }

    // Scan customers table for matching aadhaarLast4
    const result = await ddb.send(new QueryCommand({
      TableName: TABLE.CUSTOMERS,
      IndexName: "aadhaarLast4-index",
      KeyConditionExpression: "aadhaarLast4 = :a",
      ExpressionAttributeValues: { ":a": aadhaarLast4 },
      ProjectionExpression: "customerId, maskedName, mobile, demoOtp"
    }));

    if (!result.Items || result.Items.length === 0) {
      return notFound("We could not find an account linked to those Aadhaar digits. Please visit the counter.");
    }

    const customer = result.Items[0];
    const maskedMobile = customer.mobile
      ? `XXXXXX${customer.mobile.slice(-4)}`
      : "XXXXXXXXXX";

    // In a real system, trigger OTP dispatch here.
    // For demo: the OTP is fixed (demoOtp) and shown in the mock dashboard.
    return ok({
      customerId: customer.customerId,
      maskedName: customer.maskedName,
      maskedMobile,
      challengeType: "OTP",
      message: `OTP sent to ${maskedMobile}. Please say it aloud.`
    });

  } catch (e) {
    console.error("verify-id error:", e);
    return err500("Something went wrong during identity verification. Please try again.");
  }
};
