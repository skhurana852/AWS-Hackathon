/**
 * Form Generator Lambda — POST /forms/generate
 * Generates a pre-filled PDF (mock: JSON manifest + HTML) for:
 *   - FD requests (cash route)
 *   - Withdrawal slips (manual route)
 * Stores the document in S3 and pushes a task to SQS teller queue.
 */

const { S3Client, PutObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");
const { SQSClient, SendMessageCommand }                = require("@aws-sdk/client-sqs");
const { getSignedUrl }                                 = require("@aws-sdk/s3-request-presigner");
const {
  ddb, TABLE, ok, created, badReq, unauth, err500,
  GetCommand, PutCommand,
  verifyToken, generateRef
} = require("./utils");

const REGION      = process.env.AWS_REGION  || "ap-south-1";
const FORMS_BUCKET= process.env.FORMS_BUCKET || "sahayak-forms";
const TELLER_QUEUE= process.env.TELLER_QUEUE_URL || "";

const s3  = new S3Client({ region: REGION });
const sqs = new SQSClient({ region: REGION });

exports.handler = async (event) => {
  try {
    const authHeader = event.headers?.Authorization || event.headers?.authorization || "";
    const token = authHeader.replace("Bearer ", "").trim();
    const payload = verifyToken(token);
    if (!payload) return unauth("Session expired. Please re-authenticate.");

    const body = JSON.parse(event.body || "{}");
    const { formType, data } = body;

    if (!formType || !data) return badReq("formType and data are required.");

    // Fetch customer details for the form
    const customerResult = await ddb.send(new GetCommand({
      TableName: TABLE.CUSTOMERS,
      Key: { customerId: payload.customerId }
    }));
    const customer = customerResult.Item || { customerId: payload.customerId, maskedName: "Customer" };

    let formContent, s3Key, taskType;
    const refNo = generateRef("FORM");

    if (formType === "FD_REQUEST") {
      formContent = generateFdFormHtml(customer, data, refNo);
      s3Key       = `fd-forms/${payload.customerId}/${refNo}.html`;
      taskType    = "FD_CASH_DEPOSIT";
    } else if (formType === "WITHDRAWAL_SLIP") {
      formContent = generateWithdrawalSlipHtml(customer, data, refNo);
      s3Key       = `withdrawal-slips/${payload.customerId}/${refNo}.html`;
      taskType    = "CASH_WITHDRAWAL";
    } else {
      return badReq("formType must be FD_REQUEST or WITHDRAWAL_SLIP.");
    }

    // Upload to S3
    await s3.send(new PutObjectCommand({
      Bucket: FORMS_BUCKET,
      Key: s3Key,
      Body: formContent,
      ContentType: "text/html",
      Metadata: {
        customerId: payload.customerId,
        formType,
        refNo
      }
    }));

    // Generate pre-signed URL (valid 1 hour)
    const presignedUrl = await getSignedUrl(s3, new GetObjectCommand({
      Bucket: FORMS_BUCKET,
      Key: s3Key
    }), { expiresIn: 3600 });

    // Raise teller task in DynamoDB
    const counterToken = generateRef("TKN");
    const taskId = generateRef("TASK");

    const taskItem = {
      taskId,
      type: taskType,
      customerId: payload.customerId,
      customerName: customer.maskedName,
      refNo,
      counterToken,
      formKey: s3Key,
      presignedUrl,
      status: "PENDING",
      data,
      createdAt: Date.now(),
      expiresAt: Math.floor(Date.now() / 1000) + 3600
    };

    await ddb.send(new PutCommand({ TableName: TABLE.TASKS, Item: taskItem }));

    // Push to SQS teller queue (if configured)
    if (TELLER_QUEUE) {
      await sqs.send(new SendMessageCommand({
        QueueUrl: TELLER_QUEUE,
        MessageBody: JSON.stringify(taskItem),
        MessageAttributes: {
          taskType: { DataType: "String", StringValue: taskType },
          counterToken: { DataType: "String", StringValue: counterToken }
        }
      }));
    }

    return created({
      refNo,
      counterToken,
      s3Key,
      presignedUrl,
      message: `Your form has been generated. Please proceed to Counter 2 with token ${counterToken}.`
    });

  } catch (e) {
    console.error("form-generator error:", e);
    return err500("Form generation failed. Please try again.");
  }
};

// ─── FD Form HTML ─────────────────────────────────────────────────────────────
const generateFdFormHtml = (customer, data, refNo) => `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Fixed Deposit Request — ${refNo}</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 40px; color: #222; }
    .header { text-align: center; border-bottom: 2px solid #003366; padding-bottom: 10px; }
    .logo { font-size: 28px; font-weight: bold; color: #003366; }
    .subtitle { color: #666; font-size: 13px; }
    table { width: 100%; border-collapse: collapse; margin-top: 20px; }
    td { padding: 8px 12px; border: 1px solid #ccc; }
    td:first-child { font-weight: bold; background: #f0f4ff; width: 40%; }
    .footer { margin-top: 40px; font-size: 11px; color: #888; text-align: center; }
    .badge { background: #003366; color: white; padding: 4px 10px; border-radius: 4px; font-size: 12px; }
    .watermark { color: #e0e0e0; font-size: 60px; position: fixed; top: 40%; left: 20%; transform: rotate(-30deg); z-index: -1; }
  </style>
</head>
<body>
  <div class="watermark">MOCK ONLY</div>
  <div class="header">
    <div class="logo">🏦 SAHAYAK BANK</div>
    <div class="subtitle">AI-Powered Banking — Hackathon Prototype</div>
    <h2 style="color:#003366;">Fixed Deposit Request Form</h2>
    <span class="badge">Ref: ${refNo}</span>
  </div>

  <table>
    <tr><td>Customer Name</td><td>${customer.maskedName || "—"}</td></tr>
    <tr><td>Customer ID</td><td>${customer.customerId}</td></tr>
    <tr><td>PAN Number</td><td>${data.pan || "—"}</td></tr>
    <tr><td>Deposit Amount</td><td>₹${(data.amount || 0).toLocaleString("en-IN")}</td></tr>
    <tr><td>Tenure</td><td>${data.tenureMonths || "—"} months</td></tr>
    <tr><td>Interest Rate</td><td>${data.rate || "—"}% per annum</td></tr>
    <tr><td>Maturity Amount</td><td>₹${(data.maturityAmount || 0).toLocaleString("en-IN")}</td></tr>
    <tr><td>Maturity Date</td><td>${data.maturityDate || "—"}</td></tr>
    <tr><td>FD Reference No.</td><td>${data.fdRefNo || refNo}</td></tr>
    <tr><td>Form Generated On</td><td>${new Date().toLocaleString("en-IN")}</td></tr>
    <tr><td>Channel</td><td>Sahayak Voice Agent (Kiosk)</td></tr>
    <tr><td>Payment Mode</td><td>Cash at Counter</td></tr>
  </table>

  <p style="margin-top:30px;"><strong>Instructions for Teller:</strong> Collect ₹${(data.amount || 0).toLocaleString("en-IN")} cash from the customer, verify PAN, and complete FD booking in CBS.</p>
  <p><strong>Counter Token:</strong> <span style="font-size:18px;font-weight:bold;">${data.counterToken || "—"}</span></p>

  <div class="footer">
    This form was pre-filled by Sahayak AI Agent. For hackathon demo purposes only — mock data.<br>
    Ref: ${refNo} | Generated: ${new Date().toISOString()}
  </div>
</body>
</html>`;

// ─── Withdrawal Slip HTML ─────────────────────────────────────────────────────
const generateWithdrawalSlipHtml = (customer, data, refNo) => `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Cash Withdrawal Slip — ${refNo}</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 40px; color: #222; }
    .header { text-align: center; border-bottom: 2px solid #003366; padding-bottom: 10px; }
    .logo { font-size: 28px; font-weight: bold; color: #003366; }
    table { width: 100%; border-collapse: collapse; margin-top: 20px; }
    td { padding: 8px 12px; border: 1px solid #ccc; }
    td:first-child { font-weight: bold; background: #f0f4ff; width: 40%; }
    .footer { margin-top: 40px; font-size: 11px; color: #888; text-align: center; }
    .badge { background: #006633; color: white; padding: 4px 10px; border-radius: 4px; font-size: 12px; }
    .watermark { color: #e0e0e0; font-size: 60px; position: fixed; top: 40%; left: 20%; transform: rotate(-30deg); z-index: -1; }
  </style>
</head>
<body>
  <div class="watermark">MOCK ONLY</div>
  <div class="header">
    <div class="logo">🏦 SAHAYAK BANK</div>
    <div class="subtitle">AI-Powered Banking — Hackathon Prototype</div>
    <h2 style="color:#006633;">Cash Withdrawal Slip</h2>
    <span class="badge">Ref: ${refNo}</span>
  </div>

  <table>
    <tr><td>Customer Name</td><td>${customer.maskedName || "—"}</td></tr>
    <tr><td>Customer ID</td><td>${customer.customerId}</td></tr>
    <tr><td>Account No.</td><td>${data.accountId || "—"}</td></tr>
    <tr><td>Withdrawal Amount</td><td>₹${(data.amount || 0).toLocaleString("en-IN")}</td></tr>
    <tr><td>Denomination Preference</td><td>${data.denominationPreference || "As available"}</td></tr>
    <tr><td>Transaction Reference</td><td>${data.txnRef || refNo}</td></tr>
    <tr><td>Form Generated On</td><td>${new Date().toLocaleString("en-IN")}</td></tr>
    <tr><td>Channel</td><td>Sahayak Voice Agent (Kiosk)</td></tr>
  </table>

  <p style="margin-top:30px;"><strong>Instructions for Teller:</strong> Verify customer identity, check signature, and disburse ₹${(data.amount || 0).toLocaleString("en-IN")} cash.</p>
  <p><strong>Counter Token:</strong> <span style="font-size:18px;font-weight:bold;">${data.counterToken || "—"}</span></p>

  <div class="footer">
    This slip was pre-filled by Sahayak AI Agent. For hackathon demo purposes only — mock data.<br>
    Ref: ${refNo} | Generated: ${new Date().toISOString()}
  </div>
</body>
</html>`;
