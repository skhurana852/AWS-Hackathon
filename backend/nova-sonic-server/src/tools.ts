import { ToolSpec } from "./types";

/**
 * Banking tool definitions for Nova Sonic tool-use.
 * Each tool has a name, description, and JSON schema for inputs.
 */

export const BankingTools: ToolSpec[] = [
  {
    name: "verifyAadhaarTool",
    description: "Verify a customer's identity by looking up their Aadhaar last 4 digits. Returns customer info and initiates OTP challenge. Use this when the customer provides their last 4 Aadhaar digits.",
    inputSchema: {
      json: JSON.stringify({
        type: "object",
        properties: {
          aadhaarLast4: {
            type: "string",
            description: "The last 4 digits of the customer's Aadhaar number (exactly 4 digits)"
          }
        },
        required: ["aadhaarLast4"]
      })
    }
  },
  {
    name: "verifyOtpTool",
    description: "Verify the OTP spoken by the customer to complete authentication. Returns auth token on success. Use this when the customer provides their 6-digit OTP.",
    inputSchema: {
      json: JSON.stringify({
        type: "object",
        properties: {
          customerId: {
            type: "string",
            description: "The customer ID returned from verifyAadhaarTool"
          },
          otp: {
            type: "string",
            description: "The 6-digit OTP spoken by the customer"
          }
        },
        required: ["customerId", "otp"]
      })
    }
  },
  {
    name: "checkBalanceTool",
    description: "Check the account balance for an authenticated customer. Returns all accounts with their balances. Only use after successful OTP verification.",
    inputSchema: {
      json: JSON.stringify({
        type: "object",
        properties: {
          customerId: {
            type: "string",
            description: "The authenticated customer's ID"
          }
        },
        required: ["customerId"]
      })
    }
  },
  {
    name: "getFdQuoteTool",
    description: "Get a Fixed Deposit quote with interest rate and maturity details. Use this to show the customer what they would earn before booking. When the FD is funded from the account balance (fundingRoute DIGITAL), this also validates that the customer has enough balance and returns an insufficient-balance error if they do not.",
    inputSchema: {
      json: JSON.stringify({
        type: "object",
        properties: {
          amount: {
            type: "number",
            description: "The deposit amount in INR (minimum 1000)"
          },
          tenureMonths: {
            type: "number",
            description: "The tenure in months (7 to 120 months)"
          },
          fundingRoute: {
            type: "string",
            enum: ["DIGITAL", "MANUAL"],
            description: "DIGITAL if the FD is funded from the account balance, MANUAL if funded with cash at the counter. When DIGITAL, the quote validates the chosen account's available balance."
          },
          customerId: {
            type: "string",
            description: "The authenticated customer's ID. Required when fundingRoute is DIGITAL so the balance can be validated."
          },
          accountId: {
            type: "string",
            description: "The account the customer chose to fund the FD from. Required when fundingRoute is DIGITAL. If omitted, the primary savings account is used."
          }
        },
        required: ["amount", "tenureMonths"]
      })
    }
  },
  {
    name: "bookFdTool",
    description: "Book a Fixed Deposit for an authenticated customer. Requires amount, tenure, and funding route. Only use after customer confirms the FD quote. Do NOT ask for or pass a PAN number.",
    inputSchema: {
      json: JSON.stringify({
        type: "object",
        properties: {
          customerId: {
            type: "string",
            description: "The authenticated customer's ID"
          },
          amount: {
            type: "number",
            description: "The FD amount in INR"
          },
          tenureMonths: {
            type: "number",
            description: "The FD tenure in months"
          },
          route: {
            type: "string",
            enum: ["DIGITAL", "MANUAL"],
            description: "DIGITAL to debit from account, MANUAL for cash deposit at counter"
          },
          accountId: {
            type: "string",
            description: "The account to debit for the FD. Required when route is DIGITAL. If omitted, the primary savings account is used."
          }
        },
        required: ["customerId", "amount", "tenureMonths", "route"]
      })
    }
  },
  {
    name: "withdrawCashTool",
    description: "Process a cash withdrawal for an authenticated customer. Only use after the customer confirms the withdrawal amount and channel.",
    inputSchema: {
      json: JSON.stringify({
        type: "object",
        properties: {
          customerId: {
            type: "string",
            description: "The authenticated customer's ID"
          },
          accountId: {
            type: "string",
            description: "The account ID to withdraw from (if not specified, uses primary account)"
          },
          amount: {
            type: "number",
            description: "The withdrawal amount in INR (multiples of 100, minimum 100)"
          },
          channel: {
            type: "string",
            enum: ["KIOSK", "MANUAL"],
            description: "KIOSK for ATM/kiosk dispense, MANUAL for teller counter collection"
          }
        },
        required: ["customerId", "amount", "channel"]
      })
    }
  }
];
