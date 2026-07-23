#!/usr/bin/env node
/**
 * DynamoDB Seed Script — Sahayak Hackathon
 * Seeds all mock tables with demo data.
 *
 * Usage:
 *   AWS_PROFILE=your-profile node scripts/seed-dynamodb.js
 *   # or with local DynamoDB:
 *   IS_LOCAL=true node scripts/seed-dynamodb.js
 */

const { DynamoDBClient }        = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, PutCommand, CreateTableCommand, ListTablesCommand } = require("@aws-sdk/lib-dynamodb");

const IS_LOCAL = process.env.IS_LOCAL === "true";
const REGION   = process.env.AWS_REGION || "us-east-1";

const client = new DynamoDBClient(
  IS_LOCAL
    ? { region: REGION, endpoint: "http://localhost:8000" }
    : { region: REGION }
);
const ddb = DynamoDBDocumentClient.from(client, {
  marshallOptions: { removeUndefinedValues: true }
});

// ─── Table definitions (for local DynamoDB only) ──────────────────────────────
const TABLE_DEFS = [
  {
    TableName: "sahayak-customers",
    AttributeDefinitions: [
      { AttributeName: "customerId",   AttributeType: "S" },
      { AttributeName: "aadhaarLast4", AttributeType: "S" }
    ],
    KeySchema: [{ AttributeName: "customerId", KeyType: "HASH" }],
    GlobalSecondaryIndexes: [{
      IndexName: "aadhaarLast4-index",
      KeySchema: [{ AttributeName: "aadhaarLast4", KeyType: "HASH" }],
      Projection: { ProjectionType: "ALL" },
      ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 }
    }],
    BillingMode: "PROVISIONED",
    ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 }
  },
  {
    TableName: "sahayak-accounts",
    AttributeDefinitions: [
      { AttributeName: "accountId",  AttributeType: "S" },
      { AttributeName: "customerId", AttributeType: "S" }
    ],
    KeySchema: [{ AttributeName: "accountId", KeyType: "HASH" }],
    GlobalSecondaryIndexes: [{
      IndexName: "customerId-index",
      KeySchema: [{ AttributeName: "customerId", KeyType: "HASH" }],
      Projection: { ProjectionType: "ALL" },
      ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 }
    }],
    BillingMode: "PROVISIONED",
    ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 }
  },
  {
    TableName: "sahayak-fds",
    AttributeDefinitions: [
      { AttributeName: "fdId",       AttributeType: "S" },
      { AttributeName: "customerId", AttributeType: "S" }
    ],
    KeySchema: [{ AttributeName: "fdId", KeyType: "HASH" }],
    GlobalSecondaryIndexes: [{
      IndexName: "customerId-index",
      KeySchema: [{ AttributeName: "customerId", KeyType: "HASH" }],
      Projection: { ProjectionType: "ALL" },
      ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 }
    }],
    BillingMode: "PROVISIONED",
    ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 }
  },
  {
    TableName: "sahayak-sessions",
    AttributeDefinitions: [{ AttributeName: "sessionId", AttributeType: "S" }],
    KeySchema: [{ AttributeName: "sessionId", KeyType: "HASH" }],
    BillingMode: "PROVISIONED",
    ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 }
  },
  {
    TableName: "sahayak-teller-tasks",
    AttributeDefinitions: [
      { AttributeName: "taskId",    AttributeType: "S" },
      { AttributeName: "status",    AttributeType: "S" },
      { AttributeName: "createdAt", AttributeType: "N" }
    ],
    KeySchema: [{ AttributeName: "taskId", KeyType: "HASH" }],
    GlobalSecondaryIndexes: [{
      IndexName: "status-createdAt-index",
      KeySchema: [
        { AttributeName: "status",    KeyType: "HASH" },
        { AttributeName: "createdAt", KeyType: "RANGE" }
      ],
      Projection: { ProjectionType: "ALL" },
      ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 }
    }],
    BillingMode: "PROVISIONED",
    ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 }
  },
  {
    TableName: "sahayak-interest-rates",
    AttributeDefinitions: [{ AttributeName: "rateId", AttributeType: "S" }],
    KeySchema: [{ AttributeName: "rateId", KeyType: "HASH" }],
    BillingMode: "PROVISIONED",
    ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 }
  }
];

// ─── Seed Data ────────────────────────────────────────────────────────────────
const SEED_DATA = {

  "sahayak-customers": [
    {
      customerId: "C1001", aadhaarLast4: "1234", fullName: "Suresh Kumar",
      maskedName: "S. Kumar", pan: "ABCPK1234Z", mobile: "9876543210",
      email: "suresh.kumar@example.com", dob: "1980-05-15", demoOtp: "482913",
      accounts: ["ACC001", "ACC002"], authRetryCount: 0
    },
    {
      customerId: "C1002", aadhaarLast4: "5678", fullName: "Priya Sharma",
      maskedName: "P. Sharma", pan: "DEFPS5678Y", mobile: "9123456789",
      email: "priya.sharma@example.com", dob: "1992-11-22", demoOtp: "193847",
      accounts: ["ACC003"], authRetryCount: 0
    },
    {
      customerId: "C1003", aadhaarLast4: "9012", fullName: "Ramesh Patel",
      maskedName: "R. Patel", pan: "GHIRP9012X", mobile: "9988776655",
      email: "ramesh.patel@example.com", dob: "1975-03-08", demoOtp: "567291",
      accounts: ["ACC004", "ACC005"], authRetryCount: 0
    }
  ],

  "sahayak-accounts": [
    { accountId: "ACC001", customerId: "C1001", type: "SAVINGS",          balance: 85000.00, currency: "INR", ifsc: "DEMO0001234", branch: "Main Branch, Delhi",         lastTxnDate: "2026-07-18", status: "ACTIVE" },
    { accountId: "ACC002", customerId: "C1001", type: "CURRENT",          balance: 250000.00,currency: "INR", ifsc: "DEMO0001234", branch: "Main Branch, Delhi",         lastTxnDate: "2026-07-20", status: "ACTIVE" },
    { accountId: "ACC003", customerId: "C1002", type: "SAVINGS",          balance: 32500.50, currency: "INR", ifsc: "DEMO0001235", branch: "Connaught Place, Delhi",     lastTxnDate: "2026-07-15", status: "ACTIVE" },
    { accountId: "ACC004", customerId: "C1003", type: "SAVINGS",          balance: 120000.00,currency: "INR", ifsc: "DEMO0001236", branch: "Lajpat Nagar, Delhi",        lastTxnDate: "2026-07-19", status: "ACTIVE" },
    { accountId: "ACC005", customerId: "C1003", type: "RECURRING_DEPOSIT",balance: 45000.00, currency: "INR", ifsc: "DEMO0001236", branch: "Lajpat Nagar, Delhi",        lastTxnDate: "2026-07-01", status: "ACTIVE" }
  ],

  "sahayak-fds": [
    {
      fdId: "FD001", customerId: "C1001", accountId: "ACC001",
      principal: 50000, tenureMonths: 12, rate: 6.5, maturityAmount: 53250,
      startDate: "2026-01-10", maturityDate: "2027-01-10",
      status: "ACTIVE", fdRefNo: "FDREF20260110001", route: "DIGITAL", createdAt: Date.now()
    },
    {
      fdId: "FD002", customerId: "C1003", accountId: "ACC004",
      principal: 100000, tenureMonths: 24, rate: 7.0, maturityAmount: 114900,
      startDate: "2025-06-01", maturityDate: "2027-06-01",
      status: "ACTIVE", fdRefNo: "FDREF20250601002", route: "DIGITAL", createdAt: Date.now()
    }
  ],

  "sahayak-interest-rates": [
    {
      rateId: "FD_STANDARD",
      slabs: [
        { minMonths: 7,  maxMonths: 11,  rate: 4.50 },
        { minMonths: 12, maxMonths: 17,  rate: 6.50 },
        { minMonths: 18, maxMonths: 23,  rate: 7.00 },
        { minMonths: 24, maxMonths: 35,  rate: 7.00 },
        { minMonths: 36, maxMonths: 47,  rate: 7.10 },
        { minMonths: 48, maxMonths: 59,  rate: 7.10 },
        { minMonths: 60, maxMonths: 120, rate: 6.50 }
      ],
      seniorCitizenBonusRate: 0.50,
      minAmount: 1000,
      maxAmount: 10000000,
      currency: "INR",
      updatedAt: new Date().toISOString()
    }
  ],

  // Demo teller tasks to show in dashboard
  "sahayak-teller-tasks": [
    {
      taskId: "TASK_DEMO_001",
      type: "FD_CASH_DEPOSIT",
      customerId: "C1002",
      customerName: "P. Sharma",
      fdRefNo: "FDREF_DEMO_001",
      amount: 25000,
      data: { amount: 25000, tenureMonths: 12, pan: "DEFPS5678Y", rate: 6.5, maturityAmount: 26625, maturityDate: "2027-07-22" },
      counterToken: "TKN_DEMO_001",
      status: "PENDING",
      createdAt: Date.now() - 300000,  // 5 min ago
      expiresAt: Math.floor(Date.now() / 1000) + 3600
    },
    {
      taskId: "TASK_DEMO_002",
      type: "CASH_WITHDRAWAL",
      customerId: "C1001",
      customerName: "S. Kumar",
      accountId: "ACC001",
      txnRef: "TXN_DEMO_002",
      amount: 10000,
      data: { amount: 10000, accountId: "ACC001" },
      counterToken: "TKN_DEMO_002",
      status: "PENDING",
      createdAt: Date.now() - 600000,  // 10 min ago
      expiresAt: Math.floor(Date.now() / 1000) + 3600
    }
  ]
};

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n🌱 Sahayak DynamoDB Seed Script`);
  console.log(`   Mode: ${IS_LOCAL ? "Local DynamoDB" : "AWS " + REGION}\n`);

  if (IS_LOCAL) {
    console.log("Creating tables (local)…");
    const { TableNames } = await client.send(new ListTablesCommand({})).catch(() => ({ TableNames: [] }));
    for (const def of TABLE_DEFS) {
      if (!TableNames.includes(def.TableName)) {
        try {
          await client.send(new CreateTableCommand(def));
          console.log(`  ✅ Created: ${def.TableName}`);
          await new Promise(r => setTimeout(r, 500));
        } catch (e) {
          console.error(`  ❌ Failed to create ${def.TableName}: ${e.message}`);
        }
      } else {
        console.log(`  ⏭  Exists: ${def.TableName}`);
      }
    }
    console.log();
  }

  console.log("Seeding data…");
  for (const [table, items] of Object.entries(SEED_DATA)) {
    for (const item of items) {
      try {
        await ddb.send(new PutCommand({ TableName: table, Item: item }));
        console.log(`  ✅ ${table} ← ${Object.values(item)[0]}`);
      } catch (e) {
        console.error(`  ❌ ${table} ← ${Object.values(item)[0]}: ${e.message}`);
      }
    }
  }

  // Store token secret in SSM (only for non-local)
  if (!IS_LOCAL) {
    const { SSMClient, PutParameterCommand } = require("@aws-sdk/client-ssm");
    const ssm = new SSMClient({ region: REGION });
    try {
      await ssm.send(new PutParameterCommand({
        Name: "/sahayak/token-secret",
        Value: "sahayak-demo-secret-" + Math.random().toString(36).slice(2),
        Type: "SecureString",
        Overwrite: true
      }));
      console.log("\n  ✅ SSM /sahayak/token-secret stored");
    } catch (e) {
      console.warn("  ⚠️  SSM write failed (you may need SSM permission):", e.message);
    }
  }

  console.log("\n🎉 Seed complete!\n");
  console.log("  Demo credentials:");
  console.log("  ┌─────────────────────────────────────────────────────────┐");
  console.log("  │ Customer   │ Aadhaar Last 4 │ OTP     │ Accounts        │");
  console.log("  ├────────────┼────────────────┼─────────┼─────────────────┤");
  console.log("  │ S. Kumar   │ 1234           │ 482913  │ SAVINGS, CURRENT│");
  console.log("  │ P. Sharma  │ 5678           │ 193847  │ SAVINGS         │");
  console.log("  │ R. Patel   │ 9012           │ 567291  │ SAVINGS, RD     │");
  console.log("  └─────────────────────────────────────────────────────────┘\n");
}

main().catch(e => { console.error("Fatal error:", e); process.exit(1); });
