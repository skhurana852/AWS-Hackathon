#!/bin/bash
# ──────────────────────────────────────────────────────────────────────────────
# deploy.sh — One-click deploy script for Sahayak on AWS
# ──────────────────────────────────────────────────────────────────────────────
set -e

STACK_NAME="sahayak-hackathon"
REGION="${AWS_REGION:-us-east-1}"
S3_BUCKET="sahayak-sam-deploy-$(aws sts get-caller-identity --query Account --output text)"

echo ""
echo "🏦  SAHAYAK — AWS Hackathon Deployment"
echo "    Region: $REGION | Stack: $STACK_NAME"
echo ""

# ── Step 1: Install Lambda dependencies ────────────────────────────────────────
echo "📦 Installing Lambda dependencies…"

LAMBDAS=(
  "backend/lambdas/auth/verify-id"
  "backend/lambdas/auth/verify-otp"
  "backend/lambdas/balance-flow"
  "backend/lambdas/fd-flow"
  "backend/lambdas/withdrawal-flow"
  "backend/lambdas/form-generator"
  "backend/lambdas/conversation-orchestrator"
  "backend/lambdas/teller-dashboard"
)

for dir in "${LAMBDAS[@]}"; do
  echo "  → $dir"
  # Copy shared utils
  cp backend/shared/utils.js "$dir/utils.js" 2>/dev/null || true
  # Create package.json if missing
  if [ ! -f "$dir/package.json" ]; then
    cat > "$dir/package.json" << 'PKGJSON'
{
  "name": "sahayak-lambda",
  "version": "1.0.0",
  "dependencies": {
    "@aws-sdk/client-bedrock-runtime": "^3.0.0",
    "@aws-sdk/client-comprehend": "^3.0.0",
    "@aws-sdk/client-dynamodb": "^3.0.0",
    "@aws-sdk/client-lex-runtime-v2": "^3.0.0",
    "@aws-sdk/client-polly": "^3.0.0",
    "@aws-sdk/client-s3": "^3.0.0",
    "@aws-sdk/client-sqs": "^3.0.0",
    "@aws-sdk/client-ssm": "^3.0.0",
    "@aws-sdk/client-transcribe": "^3.0.0",
    "@aws-sdk/lib-dynamodb": "^3.0.0",
    "@aws-sdk/s3-request-presigner": "^3.0.0"
  }
}
PKGJSON
  fi
  (cd "$dir" && npm install --production --silent)
done

# ── Step 1b: Bundle cross-Lambda deps into orchestrator ────────────────────────
echo "  → Bundling cross-Lambda handlers into orchestrator…"
ORCH_DIR="backend/lambdas/conversation-orchestrator"
mkdir -p "$ORCH_DIR/auth/verify-id"
mkdir -p "$ORCH_DIR/auth/verify-otp"
mkdir -p "$ORCH_DIR/balance-flow"
mkdir -p "$ORCH_DIR/fd-flow"
mkdir -p "$ORCH_DIR/withdrawal-flow"

cp backend/lambdas/auth/verify-id/index.js "$ORCH_DIR/auth/verify-id/index.js"
cp backend/shared/utils.js "$ORCH_DIR/auth/verify-id/utils.js"
cp backend/lambdas/auth/verify-otp/index.js "$ORCH_DIR/auth/verify-otp/index.js"
cp backend/shared/utils.js "$ORCH_DIR/auth/verify-otp/utils.js"
cp backend/lambdas/balance-flow/index.js "$ORCH_DIR/balance-flow/index.js"
cp backend/shared/utils.js "$ORCH_DIR/balance-flow/utils.js"
cp backend/lambdas/fd-flow/index.js "$ORCH_DIR/fd-flow/index.js"
cp backend/shared/utils.js "$ORCH_DIR/fd-flow/utils.js"
cp backend/lambdas/withdrawal-flow/index.js "$ORCH_DIR/withdrawal-flow/index.js"
cp backend/shared/utils.js "$ORCH_DIR/withdrawal-flow/utils.js"

# ── Step 2: Create SAM deploy bucket ───────────────────────────────────────────
echo ""
echo "🪣 Ensuring S3 deploy bucket: $S3_BUCKET"
aws s3 mb "s3://$S3_BUCKET" --region "$REGION" 2>/dev/null || true

# ── Step 3: SAM Build ──────────────────────────────────────────────────────────
echo ""
echo "🔨 Building SAM application…"
cd infrastructure
sam build --template template.yaml --parallel

# ── Step 4: SAM Deploy ────────────────────────────────────────────────────────
echo ""
echo "🚀 Deploying to AWS…"
sam deploy \
  --stack-name "$STACK_NAME" \
  --s3-bucket "$S3_BUCKET" \
  --region "$REGION" \
  --capabilities CAPABILITY_NAMED_IAM \
  --no-confirm-changeset \
  --parameter-overrides Environment=dev

cd ..

# ── Step 5: Seed DynamoDB ─────────────────────────────────────────────────────
echo ""
echo "🌱 Seeding DynamoDB tables…"
node scripts/seed-dynamodb.js

# ── Step 6: Print outputs ─────────────────────────────────────────────────────
echo ""
echo "✅ Deployment complete!"
echo ""
API_URL=$(aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" \
  --region "$REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='ApiEndpoint'].OutputValue" \
  --output text)

echo "  📡 API Endpoint: $API_URL"
echo ""
echo "  🖥️  Open frontend/index.html in your browser"
echo "  🔧  Set API URL: $API_URL"
echo "  📊  Open frontend/teller-dashboard.html for the teller view"
echo ""
echo "  Demo credentials:"
echo "  ┌──────────────┬────────────────┬─────────┐"
echo "  │ Customer     │ Aadhaar Last 4 │ OTP     │"
echo "  ├──────────────┼────────────────┼─────────┤"
echo "  │ S. Kumar     │ 1234           │ 482913  │"
echo "  │ P. Sharma    │ 5678           │ 193847  │"
echo "  │ R. Patel     │ 9012           │ 567291  │"
echo "  └──────────────┴────────────────┴─────────┘"
echo ""
