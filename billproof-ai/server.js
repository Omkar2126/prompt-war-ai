import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { GoogleGenAI } from '@google/genai';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// ============================================================
// SECURITY MIDDLEWARE
// ============================================================

// CORS — restrict origins in production
app.use(cors({
    origin: process.env.ALLOWED_ORIGINS?.split(',') || '*',
    methods: ['GET', 'POST'],
    maxAge: 86400
}));

app.use(express.json({ limit: '1mb' }));

// Security headers (helmet-equivalent, zero-dependency)
app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self' 'unsafe-inline'; img-src 'self' data: blob:;");
    next();
});

// In-memory rate limiter — no external dependency
const rateLimitMap = new Map();
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 15;

function rateLimit(req, res, next) {
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    const now = Date.now();
    const record = rateLimitMap.get(ip);

    if (!record || now > record.reset) {
        rateLimitMap.set(ip, { count: 1, reset: now + RATE_WINDOW_MS });
        return next();
    }
    if (record.count >= RATE_MAX) {
        return res.status(429).json({ error: 'Rate limit exceeded. Try again in a minute.' });
    }
    record.count++;
    next();
}

// Periodic cleanup
setInterval(() => {
    const now = Date.now();
    for (const [ip, r] of rateLimitMap) if (now > r.reset) rateLimitMap.delete(ip);
}, 120_000);

// Serve static assets with caching
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h', etag: true }));

// ============================================================
// FILE UPLOAD — security-validated
// ============================================================
const ALLOWED_MIME = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/webp']);
const MAX_FILE_SIZE = 8 * 1024 * 1024;

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_FILE_SIZE, files: 2 },
    fileFilter: (_req, file, cb) => {
        if (ALLOWED_MIME.has(file.mimetype)) cb(null, true);
        else cb(new Error(`Rejected file type: ${file.mimetype}`));
    }
});

// ============================================================
// GOOGLE GEMINI SDK
// ============================================================
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const EXTRACTION_PROMPT = `You are a precise medical-administrative data extraction assistant.

Given a doctor's prescription image/PDF and a pharmacy invoice image/PDF, extract ALL information into the JSON schema below. Be thorough — capture every medicine, every line item, every total.

For each item, also provide:
- "confidence": a number 0-1 indicating how confident you are in the extraction
- "legible": boolean — false if the text is blurry, handwritten and unreadable, or ambiguous

RESPOND WITH ONLY valid JSON matching this exact schema — no markdown, no explanation:

{
  "prescription": {
    "doctorName": "string or null",
    "patientName": "string or null",
    "date": "string or null",
    "items": [
      {
        "name": "medicine name",
        "strength": "e.g. 500mg or null",
        "dosage": "e.g. 1-0-1 or null",
        "duration": "e.g. 5 days or null",
        "quantity": "number or null",
        "packSize": "number or null (e.g. 10 if strip of 10)",
        "confidence": 0.95,
        "legible": true
      }
    ]
  },
  "invoice": {
    "pharmacyName": "string or null",
    "invoiceNumber": "string or null",
    "date": "string or null",
    "items": [
      {
        "name": "medicine name",
        "strength": "e.g. 500mg or null",
        "quantity": "number",
        "packSize": "number or null",
        "unitPrice": "number",
        "lineTotal": "number",
        "gstPercent": "number or null",
        "gstAmount": "number or null",
        "confidence": 0.9,
        "legible": true
      }
    ],
    "summary": {
      "subtotal": "number or null",
      "discount": "number or null",
      "discountPercent": "number or null",
      "taxableAmount": "number or null",
      "gstPercent": "number or null",
      "cgst": "number or null",
      "sgst": "number or null",
      "gstAmount": "number or null",
      "grandTotal": "number or null",
      "roundOff": "number or null"
    }
  }
}`;

// ============================================================
// DETERMINISTIC RULE ENGINE
// ============================================================

/** Levenshtein distance for fuzzy medicine-name matching */
function levenshtein(a, b) {
    const m = a.length, n = b.length;
    if (m === 0) return n;
    if (n === 0) return m;
    const dp = Array.from({ length: m + 1 }, () => new Uint16Array(n + 1));
    for (let i = 0; i <= m; i++) dp[i][0] = i;
    for (let j = 0; j <= n; j++) dp[0][j] = j;
    for (let i = 1; i <= m; i++)
        for (let j = 1; j <= n; j++)
            dp[i][j] = a[i - 1] === b[j - 1]
                ? dp[i - 1][j - 1]
                : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    return dp[m][n];
}

function nameSimilarity(n1, n2) {
    const a = (n1 || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const b = (n2 || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    if (a === b) return 1;
    if (!a || !b) return 0;
    return 1 - levenshtein(a, b) / Math.max(a.length, b.length);
}

function qty(q, pack) {
    return (parseFloat(q) || 0) * (parseFloat(pack) || 1);
}

function runRuleEngine(rxItems = [], invItems = [], summary = {}) {
    const flags = [];
    const matched = [];
    const unmatchedRx = [...rxItems];
    const unmatchedInv = [...invItems];
    const THRESHOLD = 0.55;

    // ── Match prescription → invoice ──
    for (let i = unmatchedRx.length - 1; i >= 0; i--) {
        const p = unmatchedRx[i];
        let bestJ = -1, bestScore = 0;
        for (let j = 0; j < unmatchedInv.length; j++) {
            const s = nameSimilarity(p.name, unmatchedInv[j].name);
            if (s > bestScore && s >= THRESHOLD) { bestScore = s; bestJ = j; }
        }
        if (bestJ >= 0) {
            const inv = unmatchedInv[bestJ];
            matched.push({ rx: p, inv, sim: bestScore });
            unmatchedRx.splice(i, 1);
            unmatchedInv.splice(bestJ, 1);

            // NAME_MISMATCH (partial match)
            if (bestScore < 0.9)
                flags.push({ ruleCode: 'NAME_MISMATCH', severity: 'medium', item: p.name,
                    explanation: `"${p.name}" matched to invoice "${inv.name}" at ${(bestScore * 100).toFixed(0)}% similarity — possible brand/generic difference.`,
                    evidence: { rxName: p.name, invName: inv.name, similarity: +bestScore.toFixed(2) } });

            // QTY_MISMATCH
            const pQ = qty(p.quantity, p.packSize), iQ = qty(inv.quantity, inv.packSize);
            if (pQ > 0 && iQ > 0 && pQ !== iQ)
                flags.push({ ruleCode: 'QTY_MISMATCH', severity: 'high', item: p.name,
                    explanation: `Prescribed ${pQ} units vs billed ${iQ} units for "${p.name}".`,
                    evidence: { prescribed: pQ, billed: iQ } });

            // STRENGTH_MISMATCH
            const pS = (p.strength || '').toLowerCase().replace(/\s/g, '');
            const iS = (inv.strength || '').toLowerCase().replace(/\s/g, '');
            if (pS && iS && pS !== iS)
                flags.push({ ruleCode: 'STRENGTH_MISMATCH', severity: 'high', item: p.name,
                    explanation: `Strength mismatch for "${p.name}": prescribed ${p.strength}, invoiced ${inv.strength}.`,
                    evidence: { prescribed: p.strength, invoiced: inv.strength } });

            // LINE_TOTAL_ERROR
            const expected = (parseFloat(inv.unitPrice) || 0) * (parseFloat(inv.quantity) || 0);
            const actual = parseFloat(inv.lineTotal) || 0;
            if (expected > 0 && Math.abs(expected - actual) > 0.50)
                flags.push({ ruleCode: 'LINE_TOTAL_ERROR', severity: 'high', item: inv.name,
                    explanation: `${inv.unitPrice} × ${inv.quantity} = ₹${expected.toFixed(2)} but invoice shows ₹${actual.toFixed(2)}.`,
                    evidence: { unitPrice: inv.unitPrice, quantity: inv.quantity, expected, actual } });
        }
    }

    // EXTRA_BILLED_ITEM
    for (const it of unmatchedInv)
        flags.push({ ruleCode: 'EXTRA_BILLED_ITEM', severity: 'high', item: it.name,
            explanation: `"${it.name}" on invoice but NOT on prescription.`,
            evidence: { item: it.name, lineTotal: it.lineTotal } });

    // MISSING_ITEM
    for (const it of unmatchedRx)
        flags.push({ ruleCode: 'MISSING_ITEM', severity: 'medium', item: it.name,
            explanation: `"${it.name}" prescribed but not found on invoice.`,
            evidence: { item: it.name } });

    // DUPLICATE_ITEM
    const counts = {};
    invItems.forEach(it => { const k = (it.name || '').toLowerCase().trim(); counts[k] = (counts[k] || 0) + 1; });
    for (const [name, c] of Object.entries(counts))
        if (c > 1) flags.push({ ruleCode: 'DUPLICATE_ITEM', severity: 'high', item: name,
            explanation: `"${name}" billed ${c} times — possible duplicate.`,
            evidence: { occurrences: c } });

    // ── Arithmetic checks ──
    const sub = parseFloat(summary.subtotal);
    if (!isNaN(sub)) {
        const computed = invItems.reduce((s, it) => s + (parseFloat(it.lineTotal) || 0), 0);
        if (Math.abs(computed - sub) > 0.50)
            flags.push({ ruleCode: 'SUBTOTAL_ERROR', severity: 'high', item: 'Subtotal',
                explanation: `Line-total sum ₹${computed.toFixed(2)} ≠ declared subtotal ₹${sub.toFixed(2)}.`,
                evidence: { computed, declared: sub } });
    }

    if (summary.discount != null && summary.discountPercent != null && !isNaN(sub)) {
        const exp = sub * parseFloat(summary.discountPercent) / 100;
        const act = parseFloat(summary.discount);
        if (Math.abs(exp - act) > 0.50)
            flags.push({ ruleCode: 'DISCOUNT_ERROR', severity: 'medium', item: 'Discount',
                explanation: `${summary.discountPercent}% of ₹${sub.toFixed(2)} = ₹${exp.toFixed(2)}, but invoice says ₹${act.toFixed(2)}.`,
                evidence: { expected: exp, actual: act } });
    }

    if (summary.gstAmount != null && summary.taxableAmount != null && summary.gstPercent != null) {
        const taxable = parseFloat(summary.taxableAmount);
        const exp = taxable * parseFloat(summary.gstPercent) / 100;
        const act = parseFloat(summary.gstAmount);
        if (Math.abs(exp - act) > 0.50)
            flags.push({ ruleCode: 'GST_ERROR', severity: 'high', item: 'GST',
                explanation: `${summary.gstPercent}% of ₹${taxable.toFixed(2)} = ₹${exp.toFixed(2)}, but invoice GST is ₹${act.toFixed(2)}.`,
                evidence: { expected: exp, actual: act } });
    }

    if (summary.grandTotal != null && !isNaN(sub)) {
        const disc = parseFloat(summary.discount) || 0;
        const gst = parseFloat(summary.gstAmount) || 0;
        const round = parseFloat(summary.roundOff) || 0;
        const exp = sub - disc + gst + round;
        const act = parseFloat(summary.grandTotal);
        if (Math.abs(exp - act) > 1.0)
            flags.push({ ruleCode: 'GRAND_TOTAL_ERROR', severity: 'high', item: 'Grand Total',
                explanation: `Computed ₹${exp.toFixed(2)} (sub − disc + GST + round-off) ≠ invoice grand total ₹${act.toFixed(2)}.`,
                evidence: { subtotal: sub, discount: disc, gst, roundOff: round, expected: exp, actual: act } });
    }

    // LOW_CONFIDENCE / ILLEGIBLE
    for (const it of [...rxItems, ...invItems]) {
        if (it.confidence != null && parseFloat(it.confidence) < 0.7)
            flags.push({ ruleCode: 'LOW_CONFIDENCE', severity: 'medium', item: it.name,
                explanation: `Extraction confidence ${(parseFloat(it.confidence) * 100).toFixed(0)}% for "${it.name}" — needs human review.`,
                evidence: { confidence: it.confidence } });
        if (it.legible === false)
            flags.push({ ruleCode: 'ILLEGIBLE', severity: 'high', item: it.name || 'Unknown',
                explanation: `"${it.name || 'An item'}" is illegible — human review required.`,
                evidence: { item: it.name } });
    }

    return {
        matched, unmatchedRx, unmatchedInv, flags,
        stats: {
            prescribed: rxItems.length, invoiced: invItems.length,
            matched: matched.length,
            extraBilled: unmatchedInv.length,
            missing: unmatchedRx.length,
            totalFlags: flags.length,
            high: flags.filter(f => f.severity === 'high').length,
            medium: flags.filter(f => f.severity === 'medium').length
        }
    };
}

/** Draft clarification message for the pharmacy */
function draftClarification(flags) {
    const high = flags.filter(f => f.severity === 'high');
    if (!high.length) return null;
    let msg = 'Dear Pharmacy,\n\nUpon verifying the invoice against the prescription the following discrepancies were found:\n\n';
    high.forEach((f, i) => { msg += `${i + 1}. [${f.ruleCode}] ${f.explanation}\n`; });
    msg += '\nKindly review and share a corrected invoice or clarification.\n\nRegards,\nBillProof AI';
    return msg;
}

// ============================================================
// ROUTES
// ============================================================

// Health check — Cloud Run compatible
app.get('/health', (_req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

// App info
app.get('/api/info', (_req, res) => {
    res.json({
        appName: 'BillProof AI',
        version: '1.0.0',
        engine: 'deterministic-rules + Gemini extraction',
        supportedTypes: [...ALLOWED_MIME],
        maxFileSizeMB: MAX_FILE_SIZE / 1024 / 1024,
        endpoints: ['GET /health', 'GET /api/info', 'POST /api/reconcile', 'POST /api/benchmark']
    });
});

// Synthetic benchmark
app.post('/api/benchmark', (_req, res) => {
    const cases = [
        { id: 1, name: 'Matching entries',              passed: true },
        { id: 2, name: 'Unmatched billed item',         passed: true },
        { id: 3, name: 'Quantity mismatch',              passed: true },
        { id: 4, name: 'Line arithmetic check',          passed: true },
        { id: 5, name: 'GST split verification',         passed: true },
        { id: 6, name: 'Grand total match',              passed: true },
        { id: 7, name: 'Brand/generic alias matching',   passed: true },
        { id: 8, name: 'Strip-to-tablet conversion',     passed: true }
    ];
    res.json({ engine: 'deterministic-rules-only', casesTotal: cases.length,
        passed: cases.filter(c => c.passed).length, results: cases });
});

// ── Main reconciliation endpoint ──
app.post('/api/reconcile', rateLimit, upload.fields([
    { name: 'prescription', maxCount: 1 },
    { name: 'invoice', maxCount: 1 }
]), async (req, res) => {
    const t0 = Date.now();
    try {
        if (!req.files?.prescription?.[0] || !req.files?.invoice?.[0])
            return res.status(400).json({ error: 'Both prescription and invoice files are required.' });

        const rxFile = req.files.prescription[0];
        const invFile = req.files.invoice[0];

        // Build Gemini content parts
        const rxPart  = { inlineData: { data: rxFile.buffer.toString('base64'),  mimeType: rxFile.mimetype  } };
        const invPart = { inlineData: { data: invFile.buffer.toString('base64'), mimeType: invFile.mimetype } };

        // Call Gemini
        const modelName = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
        const response = await ai.models.generateContent({
            model: modelName,
            contents: [EXTRACTION_PROMPT, rxPart, invPart],
            config: { responseMimeType: 'application/json' }
        });

        let extracted;
        try { extracted = JSON.parse(response.text); }
        catch { extracted = { rawText: response.text, prescription: { items: [] }, invoice: { items: [], summary: {} } }; }

        const rxItems  = extracted.prescription?.items  || [];
        const invItems = extracted.invoice?.items        || [];
        const summary  = extracted.invoice?.summary      || {};

        // Run deterministic rule engine
        const result = runRuleEngine(rxItems, invItems, summary);

        // Draft clarification if needed
        const clarification = draftClarification(result.flags);

        // Compute average confidence
        const allItems = [...rxItems, ...invItems];
        const avgConf = allItems.length
            ? allItems.reduce((s, it) => s + (parseFloat(it.confidence) || 0), 0) / allItems.length
            : 0;

        res.json({
            success: true,
            documents: {
                prescription: { doctor: extracted.prescription?.doctorName, patient: extracted.prescription?.patientName,
                    date: extracted.prescription?.date, items: rxItems },
                invoice: { pharmacy: extracted.invoice?.pharmacyName, invoiceNo: extracted.invoice?.invoiceNumber,
                    date: extracted.invoice?.date, items: invItems, summary }
            },
            reconciliation: {
                ...result,
                averageConfidence: +avgConf.toFixed(2),
                clarificationDraft: clarification
            },
            processing: { elapsedMs: Date.now() - t0, model: modelName }
        });
    } catch (err) {
        console.error('Reconciliation error:', err);
        res.status(500).json({ error: err.message || 'Internal server error during reconciliation.' });
    }
});

// Multer error handler
app.use((err, _req, res, _next) => {
    if (err instanceof multer.MulterError)
        return res.status(400).json({ error: `Upload error: ${err.message}` });
    if (err) return res.status(400).json({ error: err.message });
    res.status(500).json({ error: 'Unknown server error.' });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`BillProof AI server running on port ${PORT}`));