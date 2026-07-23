# 🏦 SAHAYAK — AI-Powered Multilingual Conversational Banking Agent

> **AWS Hackathon Prototype** · Voice-first banking · English & Hindi · Serverless on AWS

---

## What is Sahayak?

**Sahayak** (Hindi: "helper") is a voice-first conversational AI banking agent that lets customers speak naturally — in English or Hindi — to complete everyday banking tasks **without needing to fill forms or understand banking jargon**.

Customers can:
- 🗣️ **Check their account balance**
- 📄 **Open a Fixed Deposit** (digital debit *or* cash at counter)
- 💵 **Withdraw cash** (via kiosk dispense *or* teller counter)

The agent authenticates via Aadhaar last-4 + OTP, collects details through natural conversation, always seeks confirmation before acting, and either completes the transaction digitally or pre-fills paperwork for the teller — with a counter token.

---

## Architecture Overview

```
[User Speech / Text]
    │
    ▼
[Frontend — Kiosk Simulator]  ──POST /converse──►  [API Gateway]
                                                         │
                                          ┌──────────────▼──────────────┐
                                          │  Conversation Orchestrator  │
                                          │  Lambda                     │
                                          │  ┌─────────────────────┐   │
                                          │  │ Amazon Comprehend    │   │  Language Detection
                                          │  │ Amazon Lex (NLU)     │   │  Intent Recognition
                                          │  │ Amazon Bedrock       │   │  Natural Responses
                                          │  │ Amazon Polly (TTS)   │   │  Voice Synthesis
                                          │  └─────────────────────┘   │
                                          └──────────┬──────────────────┘
                                                     │ calls
                              ┌──────────────────────┼───────────────────────┐
                              ▼                      ▼                       ▼
                    [Auth Lambda]         [FD Flow Lambda]      [Withdrawal Lambda]
                    verify-id                 quote/book            execute
                    verify-otp                                     
                              │                      │                       │
                              └──────────────────────┼───────────────────────┘
                                                     │
                                          ┌──────────▼──────────┐
                                          │  DynamoDB Tables     │
                                          │  • Customers         │
                                          │  • Accounts          │
                                          │  • Fixed Deposits    │
                                          │  • Sessions          │
                                          │  • Teller Tasks      │
                                          │  • Interest Rates    │
                                          └──────────┬──────────┘
                                                     │ Manual route
                                          ┌──────────▼──────────┐
                                          │  Form Generator      │
                                          │  S3 (HTML forms)     │
                                          │  SQS (teller queue)  │
                                          └──────────┬──────────┘
                                                     │
                                          ┌──────────▼──────────┐
                                          │  Teller Dashboard   │
                                          │  (web UI)           │
                                          └─────────────────────┘
```

### AWS Services Used

| Service | Purpose |
|---------|---------|
| **Amazon Lex** | Intent recognition & slot filling (en_IN + hi_IN bots) |
| **Amazon Bedrock** (Claude 3 Haiku) | Natural language responses, fallback NLU |
| **Amazon Comprehend** | Per-turn language detection (EN/HI) |
| **Amazon Polly** | Text-to-speech (Aditi/Kajal neural voices) |
| **AWS Lambda** | All backend processing (serverless) |
| **Amazon API Gateway** | REST API for frontend ↔ backend |
| **Amazon DynamoDB** | Mock customer/account/FD/session data |
| **Amazon S3** | Pre-filled forms (HTML), audio temp files |
| **Amazon SQS** | Teller notification queue |
| **AWS SAM** | Infrastructure as code / deployment |

---

## Project Structure

```
sahayak/
├── frontend/
│   ├── index.html              ← Kiosk simulator (push-to-talk)
│   ├── teller-dashboard.html   ← Teller hand-off queue view
│   ├── css/styles.css
│   └── js/app.js
├── backend/
│   ├── lambdas/
│   │   ├── auth/
│   │   │   ├── verify-id/      ← POST /auth/verify-id
│   │   │   └── verify-otp/     ← POST /auth/verify-otp
│   │   ├── conversation-orchestrator/ ← POST /converse  (main entry point)
│   │   ├── balance-flow/       ← GET /accounts/{customerId}
│   │   ├── fd-flow/            ← POST /fd/quote, /fd/book; GET /fd/{id}
│   │   ├── withdrawal-flow/    ← POST /withdrawal/execute
│   │   ├── form-generator/     ← POST /forms/generate
│   │   └── teller-dashboard/   ← GET/PATCH /dashboard/tasks
│   ├── shared/
│   │   └── utils.js            ← Shared DynamoDB client, helpers, JWT
│   ├── mock-data/              ← JSON seed files
│   └── package.json
├── infrastructure/
│   └── template.yaml           ← AWS SAM CloudFormation template
└── scripts/
    ├── seed-dynamodb.js        ← Seed script (local or AWS)
    └── deploy.sh               ← One-click deploy
```

---

## Quick Start

### Prerequisites
- AWS CLI configured (`aws configure`)
- AWS SAM CLI (`brew install aws-sam-cli`)
- Node.js 20+

### Deploy to AWS

```bash
cd "AWS Hackathon/sahayak"
chmod +x scripts/deploy.sh
./scripts/deploy.sh
```

This will:
1. Install Lambda dependencies
2. Build the SAM application
3. Deploy the CloudFormation stack to `ap-south-1`
4. Seed DynamoDB with mock data
5. Print the API endpoint URL

### Open the Frontend

```bash
# Open the kiosk simulator
open frontend/index.html

# Open the teller dashboard
open frontend/teller-dashboard.html
```

Set the API URL (from deploy output) in the ⚙️ Config panel.

---

## Demo Walkthrough

### Demo Credentials (Mock Data)

| Customer | Aadhaar Last 4 | OTP | Accounts |
|----------|---------------|-----|---------|
| S. Kumar | `1234` | `482913` | Savings (₹85k), Current (₹2.5L) |
| P. Sharma | `5678` | `193847` | Savings (₹32.5k) |
| R. Patel | `9012` | `567291` | Savings (₹1.2L), RD (₹45k) |

### Scenario 1 — Balance Check (30 sec)
1. Type or say: *"What's my balance"*
2. Agent asks for Aadhaar last 4 → say **1234**
3. Agent sends OTP → say **482913**
4. Agent reads back both account balances

### Scenario 2 — Open FD (Digital) (2 min)
1. *"I want to open a fixed deposit"*
2. Authenticate (1234 / 482913)
3. Say amount: *"50000"*; tenure: *"12 months"*; PAN: *"A B C P K 1234 Z"*
4. Agent reads back quote (6.5% → ₹53,250 maturity)
5. Say *"yes"* → say *"digital"*
6. Agent confirms FD created + reference number

### Scenario 3 — Withdrawal (Manual/Counter route) (2 min)
1. *"I want to withdraw cash"*
2. Authenticate (5678 / 193847)
3. Say *"10000"* → confirm *"yes"* → *"counter"*
4. Agent gives counter token → teller dashboard shows the task

### Switch Language Mid-Conversation
- Click **हि** toggle or start speaking in Hindi
- Agent detects and switches language on the very next turn

---

## API Reference

All endpoints are under the base URL from API Gateway.

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/converse` | Main conversation turn (text or audio) |
| `POST` | `/auth/verify-id` | Look up customer by Aadhaar last-4 |
| `POST` | `/auth/verify-otp` | Validate OTP, issue session token |
| `GET`  | `/accounts/{customerId}` | List accounts + balances |
| `POST` | `/fd/quote` | Calculate FD maturity |
| `POST` | `/fd/book` | Book FD (DIGITAL or MANUAL route) |
| `GET`  | `/fd/{customerId}` | List existing FDs |
| `POST` | `/withdrawal/execute` | Execute withdrawal (KIOSK or MANUAL) |
| `POST` | `/forms/generate` | Generate pre-filled form + S3 presigned URL |
| `GET`  | `/dashboard/tasks` | Teller task queue |
| `PATCH`| `/dashboard/tasks/{taskId}` | Update task status |

---

## Conversation State Machine

```
UNAUTHENTICATED
    │
    ├─► AWAITING_AADHAAR  → (enter last 4 digits)
    │         │
    └─► AWAITING_OTP      → (enter 6-digit OTP)
              │
              ▼
         AUTHENTICATED
         /     |     \
        /      |      \
       ▼       ▼       ▼
  FD_COLLECTING  WD_COLLECTING  (balance query → instant)
  _SLOTS          _SLOTS
       │               │
       ▼               ▼
  FD_CONFIRMING   WD_CONFIRMING
       │               │
       ▼               ▼
  FD_CHOOSING     WD_CHOOSING
  _ROUTE          _ROUTE
       │               │
       └───────┬────────┘
               ▼
          AUTHENTICATED  (loop)
```

---

## Design Guardrails (from HLD)

- ✅ **Never act without explicit confirmation** — every transaction has a confirmation step
- ✅ **Must be authenticated** — all banking operations require OTP verification
- ✅ **Max 3 auth retries** — then gracefully redirect to counter
- ✅ **Single slot per question** — never asks multiple missing slots at once
- ✅ **Language switches per turn** — Comprehend runs on every utterance
- ✅ **Low confidence → disambiguation** — Lex confidence < 0.4 falls back to Bedrock
- ✅ **Empathetic tone** — Bedrock system prompt enforces plain, non-judgmental language

---

## What's Mocked (Prototype Scope)

Per the HLD, these are **intentionally simplified** for the hackathon:

- ❌ Real Aadhaar/UIDAI integration → replaced with last-4 lookup in DynamoDB
- ❌ Real OTP delivery → fixed demo OTPs per customer
- ❌ Real CBS (Core Banking System) → DynamoDB mock tables
- ❌ ATM hardware dispense → mock response
- ❌ Real PDF generation → HTML form with MOCK ONLY watermark
- ❌ Languages beyond English + Hindi

---

## Future Scope

- Real Aadhaar eKYC + UIDAI/RBI compliance
- Additional Indian regional languages
- Real ATM/kiosk hardware integration
- Proactive fraud/anomaly detection
- Full teller SLA dashboard with escalation
- Voice biometrics (speaker verification)

---

*Built for AWS Hackathon 2026 · Prototype only — mock data throughout*
