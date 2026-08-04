# Vendor Tracker — Backend

AWS CDK (TypeScript) stack that provisions the Vendor Tracker API, auth, data store, and static frontend hosting.

**Frontend:** [littlegod20/vendor-tracking-aws-frontend](https://github.com/littlegod20/vendor-tracking-aws-frontend.git)

## What this stack creates

| Resource | Purpose |
|----------|---------|
| **DynamoDB** `VendorTable` | Vendor records (`vendorId` partition key) |
| **Lambda** × 3 | Create / list / delete vendors |
| **API Gateway** REST API | `POST/GET/DELETE /vendors` |
| **Cognito User Pool** + App Client + domain | Sign-up, email verification, JWT auth |
| **Cognito authorizer** | Protects API methods |
| **S3 bucket** | Hosts the Next.js static export (`frontend/out`) |
| **CloudFront** | HTTPS CDN in front of S3 |

```
CloudFront → S3 (static UI)
                 │
Browser ─────────┼─→ Cognito (sign-up / sign-in)
                 │
                 └─→ API Gateway (+ Cognito JWT authorizer)
                           ├─ POST   /vendors → createVendor Lambda → DynamoDB
                           ├─ GET    /vendors → getVendors Lambda  → DynamoDB
                           └─ DELETE /vendors → deleteVendor Lambda → DynamoDB
```

## Tech stack

| Layer | Choice |
|-------|--------|
| IaC | [AWS CDK](https://docs.aws.amazon.com/cdk/) v2 (TypeScript) |
| Runtime | Node.js Lambdas via `NodejsFunction` (esbuild bundling) |
| Data | DynamoDB (on-demand billing) |
| Auth | Amazon Cognito User Pools |
| API | API Gateway REST |
| Hosting | S3 + CloudFront |
| AWS SDK | `@aws-sdk/client-dynamodb`, `@aws-sdk/lib-dynamodb` |

## Project structure

```
backend/
├── bin/
│   └── backend.ts           # CDK app entry — instantiates BackendStack
├── lib/
│   └── backend-stack.ts     # All infrastructure definitions
├── lambda/
│   ├── createVendor.ts      # POST — PutItem + UUID
│   ├── getVendors.ts        # GET  — Scan table
│   └── deleteVendor.ts      # DELETE — DeleteItem by vendorId
├── test/
│   └── backend.test.ts
├── cdk.json                 # CDK toolkit config
└── package.json
```

## Prerequisites

- Node.js 20+ recommended
- [AWS CLI](https://aws.amazon.com/cli/) configured (`aws configure`) with deploy permissions
- [AWS CDK CLI](https://docs.aws.amazon.com/cdk/v2/guide/cli.html) (`npm i -g aws-cdk` or use `npx cdk`)
- CDK bootstrapped in the target account/region once:

```bash
npx cdk bootstrap
```

## Install

```bash
cd backend
npm install
```

## Useful commands

| Command | Description |
|---------|-------------|
| `npm run build` | Type-check / compile TypeScript |
| `npm run watch` | Watch mode type-check |
| `npm run test` | Jest unit tests |
| `npx cdk synth` | Synthesize CloudFormation template |
| `npx cdk diff` | Show pending changes vs deployed stack |
| `npx cdk deploy` | Deploy `BackendStack` |
| `npx cdk destroy` | Tear down the stack |

## Deploy

### 1. Build the frontend static site first

The stack uploads `../frontend/out` to S3. That folder must exist:

```bash
cd ../frontend
# Configure .env.local with API + Cognito values (after first deploy, or use placeholders then redeploy)
npm install
npm run build
cd ../backend
```

On a **first** deploy you may not have Cognito/API URLs yet. Common approach:

1. Deploy backend once (frontend may be empty/placeholder).
2. Copy stack outputs into `frontend/.env.local`.
3. Rebuild frontend, then `npx cdk deploy` again to refresh S3/CloudFront.

### 2. Deploy the stack

```bash
cd backend
npx cdk deploy
```

Approve IAM changes when prompted. Note the outputs:

| Output | Use in frontend |
|--------|-----------------|
| `ApiEndpoint` | `NEXT_PUBLIC_API_URL` |
| `UserPoolId` | `NEXT_PUBLIC_USER_POOL_ID` |
| `UserPoolClientId` | `NEXT_PUBLIC_USER_POOL_CLIENT_ID` |
| `CloudFrontURL` | Open this URL in the browser |

## Cognito (auth directory)

Defined in `lib/backend-stack.ts`:

- **Self sign-up** enabled
- **Sign-in alias**: email
- **Auto-verify** email with a **code** (not a link)
- Cognito **hosted domain** prefix: `vendor-tracker-<account-id>`
- **App client** for the Next.js / Amplify frontend

Think of the User Pool as a managed user directory (not a Postgres connection pool and not your DynamoDB vendor table). The App Client is how the frontend is allowed to call Cognito auth APIs.

## API

Base URL: `ApiEndpoint` output (example shape: `https://xxxx.execute-api.<region>.amazonaws.com/prod/`).

All methods below require a Cognito **ID token** in the `Authorization` header (API Gateway Cognito User Pool authorizer).

CORS is enabled for all origins with `Content-Type` and `Authorization` headers (suitable for local + CloudFront during development).

### `POST /vendors`

Create a vendor.

**Body (JSON):**

```json
{
  "name": "Acme Cloud",
  "category": "SaaS",
  "contactEmail": "ops@acme.example"
}
```

**Behavior:** Generates `vendorId` (`randomUUID`), stores the item in DynamoDB, returns `201`.

**Success response (shape):**

```json
{
  "message": "Vendor created",
  "vendorId": "..."
}
```

### `GET /vendors`

List all vendors (`Scan` on the table). Returns a JSON array of items (`200`).

### `DELETE /vendors`

Delete by id.

**Body (JSON):**

```json
{
  "vendorId": "..."
}
```

Returns `400` if `vendorId` is missing; `200` on success.

## DynamoDB item shape

| Attribute | Type | Notes |
|-----------|------|--------|
| `vendorId` | string (PK) | UUID from create handler |
| `name` | string | Required from client |
| `category` | string | Required from client |
| `contactEmail` | string | Required from client |
| `createAt` | string (ISO) | Set by create Lambda |

Billing: **PAY_PER_REQUEST**.  
`removalPolicy: DESTROY` is set for **development** — the table can be deleted with the stack. Do not use as-is for production data you need to keep.

## Lambda handlers

Shared pattern:

- Document client over low-level DynamoDB client
- Table name from `TABLE_NAME` env (wired by CDK)
- CORS headers on responses
- Least-privilege IAM: create/delete get write; get gets read

| File | DynamoDB op | Trigger |
|------|-------------|---------|
| `lambda/createVendor.ts` | `PutCommand` | `POST /vendors` |
| `lambda/getVendors.ts` | `ScanCommand` | `GET /vendors` |
| `lambda/deleteVendor.ts` | `DeleteCommand` | `DELETE /vendors` |

## Frontend hosting (S3 + CloudFront)

- Private S3 bucket (`BLOCK_ALL` public access)
- CloudFront origin = S3; HTTPS redirect
- `defaultRootObject`: `index.html`
- 404 → `index.html` (SPA-friendly)
- `BucketDeployment` syncs `../frontend/out` and invalidates CloudFront (`/*`) on deploy

## Development notes

### Environment / account

`bin/backend.ts` currently leaves `env` unset (environment-agnostic). For account/region-specific features, uncomment and set:

```ts
env: {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION,
}
```

### Cognito domain prefix

Domain prefix is `vendor-tracker-${this.account}`. It must be globally unique within Cognito’s domain namespace. If deploy fails on the domain, change the prefix in `backend-stack.ts`.

### Cost / cleanup

Resources are intended for learning/dev (`DESTROY`, `autoDeleteObjects` on the site bucket). Tear down when finished:

```bash
npx cdk destroy
```

## Troubleshooting

| Symptom | Likely cause |
|---------|----------------|
| Deploy fails: `../frontend/out` missing | Run `npm run build` in `frontend` first |
| Deploy fails: Cognito domain taken | Change `domainPrefix` |
| API 401 | Missing/invalid Cognito ID token; wrong User Pool / App Client in frontend |
| API 500 on create/list/delete | Check CloudWatch Logs for the Lambda; IAM or table name issues |
| CloudFront shows old UI | Redeploy after rebuild so invalidation runs; wait for distribution |
| CORS errors from localhost | Confirm API CORS allows your methods/headers; check preflight |

