# BillProof AI — backend MVP

**Tagline:** Every billed medicine checked against the prescription—with evidence.

BillProof AI is an AI-assisted administrative document reconciliation prototype. It extracts structured fields from a prescription and an Indian pharmacy invoice using Gemini, validates the extraction, then applies deterministic rules for name/strength matching, quantity units, line arithmetic, GST components, and invoice totals.

> **Important boundary:** This is a prototype for administrative cross-checking, not medical advice. It does not decide whether a prescription is clinically appropriate, tell a patient to start/stop a medicine, establish fraud, or replace a pharmacist. Use synthetic data for a public demo. Real healthcare documents can contain sensitive personal information.

## What makes the engineering meaningful

1. **Structured multimodal extraction:** Gemini receives the uploaded document bytes and must return every field in a defined JSON schema. Each extracted field includes `value`, model-estimated `confidence`, and `legible`.
2. **Bounded validation retry:** The output is checked using a runtime Zod schema. If structural validation fails, the backend re-runs extraction once with validation feedback; it does not retry indefinitely.
3. **Deterministic rules:** Amount arithmetic and unit comparison are performed in JavaScript, not delegated to an LLM. Rules produce stable IDs, field evidence, and plain-language explanations.
4. **Indian pharmacy invoice details:** Invoice schema includes batch number, expiry date, MRP, discount, HSN, GST rate, CGST/SGST/IGST, quantity unit, and explicit pack size.
5. **Synthetic benchmark endpoint:** `POST /api/benchmark` executes eight known cases against the deterministic rule engine and returns pass/fail plus measured latency. It is explicitly labelled as a rule-engine-only benchmark; it does **not** measure Gemini extraction quality or AI-provider latency.
6. **Privacy-minded upload handling:** Multer uses memory storage; file bytes are not written to application disk or persisted in a database. Files are sent to the Gemini API for extraction. The app does not log OCR text, prompts, names, invoice lines, or file bytes.

## Tech stack

- Node.js 20+
- Express 5
- Google Gen AI JavaScript SDK (`@google/genai`)
- Gemini multimodal extraction and JSON schema output
- Zod runtime validation
- Multer in-memory uploads
- Helmet, CORS allowlist, and express-rate-limit
- Node's built-in test runner
- Cloud Run + Secret Manager deployment configuration

## API

### `GET /health`
Health probe. Does not call Gemini.

### `GET /api/info`
Returns supported file types, configured size limit, endpoint descriptions, and privacy note.

### `POST /api/reconcile`
Send `multipart/form-data` with **two files**:

- `prescription`: PDF, JPEG, PNG, or WebP
- `invoice`: PDF, JPEG, PNG, or WebP

Default maximum is 8 MB per file (configurable up to 10 MB). Type is checked using magic bytes as well as the request MIME type. Unsupported file types and signature mismatches are rejected.

Success response includes:

- `documents.prescription` and `documents.invoice`: extracted fields with field-level confidence
- `stages`: upload validation → Gemini extraction → schema validation → rule checks → report
- `reconciliation.flags`: rule code, severity, evidence, fields, and human-readable explanation
- `processing.elapsedMs`: observed total time for the actual request
- `report`: a concise summary and a pharmacy clarification message draft

Example with curl:

```bash
curl -X POST http://localhost:8080/api/reconcile \
  -F "prescription=@./samples/prescription.pdf;type=application/pdf" \
  -F "invoice=@./samples/invoice.pdf;type=application/pdf"
```

### `POST /api/benchmark`
Runs eight synthetic, local test scenarios. It does not make Gemini requests.

```bash
curl -X POST http://localhost:8080/api/benchmark
```

Cases cover matching entries, unmatched billed item, quantity mismatch, line arithmetic, GST split, grand total, explicitly configured brand/generic alias, and strip-to-tablet conversion when pack size is printed.

### Common rule codes

- `UNMATCHED_BILLED_ITEM`
- `STRENGTH_MISMATCH`
- `QUANTITY_MISMATCH`
- `QUANTITY_UNIT_UNCLEAR`
- `LINE_TOTAL_MATH_MISMATCH`
- `GST_SPLIT_MISMATCH`
- `GST_TYPE_MIXED`
- `TAX_COMPONENT_SUM_MISMATCH`
- `GRAND_TOTAL_MISMATCH`
- `LOW_CONFIDENCE_FIELD`

Flags mean **review needed**, not that the bill is necessarily wrong. Layouts and tax treatments vary; the app skips calculations when required extracted inputs are missing or the invoice treatment is unknown.

## Local setup

1. Install Node.js 20 or later.
2. Copy the example environment file and add your Gemini key:

```bash
cp .env.example .env
```

3. Edit `.env` and set `GEMINI_API_KEY`. Keep it private and do not commit `.env`.
4. Install and run:

```bash
npm install
npm test
npm start
```

Open `http://localhost:8080/health` and `http://localhost:8080/api/info`.

The default model is configured through `GEMINI_MODEL` (currently set to `gemini-3.8-flash` in `.env.example`). If that model is not available to your project, change the environment variable to a model enabled for your Gemini API key.

## Security and threat model

| Threat | Prototype control | Remaining limitation |
|---|---|---|
| Fake extension / MIME spoofing | Validate file magic bytes and require MIME/signature match | Signature checks are not a complete malware scanner |
| Very large upload | In-memory Multer storage with size and file-count caps | Production may need stricter gateway limits and PDF page-count checks |
| Upload written to local disk | No disk storage; buffers stay in memory | Memory is still used for request lifetime; avoid oversized concurrency |
| API key theft | Key read server-side; `.env` git-ignored; Cloud Run instructions use Secret Manager | Local `.env` is only for development and must never be committed |
| Abuse / expensive repeated calls | Per-IP rate limiter | In-memory limiter is per instance, not globally distributed; production should use a shared store and/or edge controls |
| Cross-origin browser access | Explicit `FRONTEND_ORIGINS` allowlist | CORS is not authentication; do not treat it as access control |
| Sensitive data in logs | Log only request ID and error code; no request bodies or document text | Review cloud/platform logs and access policy as part of real deployment |
| Incorrect model extraction | Field confidence, null for unreadable values, structured schema, one bounded validation retry, deterministic checks, review flags | Confidence is model-estimated and not calibrated; always review original documents |
| Incorrect brand/generic matching | Alias table is explicit and off by default; aliases are not inferred by Gemini | Only configure aliases from a trusted, verified source |
| Misleading performance claim | Benchmark identifies itself as synthetic rule-engine-only and times real local checks | End-to-end Gemini latency/accuracy must be measured separately with representative held-out documents |

### Google API data note

Uploaded bytes are transmitted to Gemini because that service performs the extraction. This backend itself does not persist uploads. Review Google's API data-use terms and your event requirements before sending any real personal or medical records; for hackathon demos, use synthetic documents.

## Google Cloud Run deployment

### 1. Prepare a project

Enable Cloud Run, Secret Manager, and the appropriate build/deploy APIs in your Google Cloud project. Authenticate with `gcloud` and select your project.

### 2. Create a secret

```bash
printf '%s' 'YOUR_GEMINI_API_KEY' | gcloud secrets create gemini-api-key --data-file=-
```

If that secret already exists, add a new version instead:

```bash
printf '%s' 'YOUR_GEMINI_API_KEY' | gcloud secrets versions add gemini-api-key --data-file=-
```

### 3. Deploy from this directory

Replace `PROJECT_ID`, `REGION`, and the allowed frontend origin:

```bash
gcloud run deploy billproof-ai-api \
  --source . \
  --project PROJECT_ID \
  --region REGION \
  --allow-unauthenticated \
  --set-env-vars GEMINI_MODEL=gemini-3.8-flash,FRONTEND_ORIGINS=https://YOUR-FRONTEND.example,MAX_FILE_MB=8 \
  --update-secrets GEMINI_API_KEY=gemini-api-key:1 \
  --memory 1Gi \
  --cpu 1 \
  --timeout 120
```

Grant the Cloud Run service identity permission to access the key (`roles/secretmanager.secretAccessor`) before deployment. The command above uses secret version `1` intentionally; update the version when rotating the key. Follow Google Cloud's current Secret Manager and Cloud Run documentation for your chosen project configuration.

`--allow-unauthenticated` is used only to make a public hackathon demo easy to open. The API still has a per-instance limiter but no user authentication. For production or sensitive records, require authentication and add a shared rate limit/store and suitable ingress controls.

Cloud Run supplies `PORT`; this service binds to `0.0.0.0` as required by the Cloud Run container contract.

## Alias configuration

No brand/generic equivalences are assumed by default. To enable verified entries, set `MEDICINE_ALIASES_JSON` to JSON mapping a normalized brand label to a canonical name, e.g.:

```json
{"brand-x":"ingredient-x"}
```

This example is fictitious. Only configure real-world aliases after verifying them against a trusted source. A similar name alone is not evidence that two products are equivalent.

## Known limitations and next steps

- This is the API layer, not the complete user-facing React dashboard. The frontend should display the `stages`, `documents` field values/confidences, `reconciliation.flags`, actual request latency, and benchmark results.
- Gemini structured output enforces shape but not semantic truth. Zod checks schema shape, and deterministic rules check only rules for which inputs are available.
- Quantity conversion is deliberately conservative: a strip/pack is converted to tablets/capsules only when a pack size was explicitly extracted.
- Local rate limiting is not distributed across Cloud Run instances.
- Add representative labeled documents and report precision/recall for flags before claiming extraction or discrepancy-detection accuracy.

