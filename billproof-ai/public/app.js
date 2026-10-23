/* ============================================================
   BillProof AI — Client-Side Application Logic
   ============================================================ */

(function () {
    'use strict';

    // ── DOM References ──
    const $ = (sel) => document.querySelector(sel);
    const uploadForm     = $('#uploadForm');
    const submitBtn      = $('#submitBtn');
    const progressSec    = $('#progressSection');
    const progressFill   = $('#progressFill');
    const resultsSec     = $('#resultsSection');
    const errorBanner    = $('#errorBanner');
    const errorText      = $('#errorText');

    const rxZone   = $('#rxZone');
    const invZone  = $('#invZone');
    const rxInput  = $('#rxInput');
    const invInput = $('#invInput');
    const rxName   = $('#rxFileName');
    const invName  = $('#invFileName');

    const steps = document.querySelectorAll('.progress-step');

    // ── Drag-and-drop + click-to-select ──
    function setupUploadZone(zone, input, nameEl) {
        zone.addEventListener('click', () => input.click());

        zone.addEventListener('dragover', (e) => {
            e.preventDefault();
            zone.classList.add('dragover');
        });
        zone.addEventListener('dragleave', () => zone.classList.remove('dragover'));
        zone.addEventListener('drop', (e) => {
            e.preventDefault();
            zone.classList.remove('dragover');
            if (e.dataTransfer.files.length) {
                input.files = e.dataTransfer.files;
                onFileSelected(zone, input, nameEl);
            }
        });

        input.addEventListener('change', () => onFileSelected(zone, input, nameEl));
    }

    function onFileSelected(zone, input, nameEl) {
        const file = input.files[0];
        if (file) {
            zone.classList.add('has-file');
            nameEl.textContent = file.name;
        } else {
            zone.classList.remove('has-file');
            nameEl.textContent = '';
        }
    }

    setupUploadZone(rxZone, rxInput, rxName);
    setupUploadZone(invZone, invInput, invName);

    // ── Progress animation ──
    function setProgress(pct) {
        progressFill.style.width = pct + '%';
    }

    function activateStep(idx) {
        steps.forEach((s, i) => {
            s.classList.remove('active', 'done');
            if (i < idx) s.classList.add('done');
            else if (i === idx) s.classList.add('active');
        });
    }

    // ── Form submit ──
    uploadForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const rxFile  = rxInput.files[0];
        const invFile = invInput.files[0];

        if (!rxFile || !invFile) {
            showError('Please select both a prescription and an invoice file.');
            return;
        }

        // Validate file sizes client-side
        const MAX_SIZE = 8 * 1024 * 1024;
        if (rxFile.size > MAX_SIZE || invFile.size > MAX_SIZE) {
            showError('File size must be under 8 MB.');
            return;
        }

        // Validate MIME types client-side
        const allowed = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/webp']);
        if (!allowed.has(rxFile.type) || !allowed.has(invFile.type)) {
            showError('Only PDF, JPEG, PNG, and WebP files are accepted.');
            return;
        }

        hideError();
        resultsSec.classList.remove('visible');
        progressSec.classList.add('active');
        submitBtn.disabled = true;

        // Simulate step progress
        activateStep(0); setProgress(10);

        const formData = new FormData();
        formData.append('prescription', rxFile);
        formData.append('invoice', invFile);

        // Step 1: Uploading
        await delay(400);
        activateStep(1); setProgress(30);

        try {
            // Step 2: Gemini extraction
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 120_000); // 2 min timeout

            const fetchPromise = fetch('/api/reconcile', {
                method: 'POST',
                body: formData,
                signal: controller.signal
            });

            // Animate progress during fetch
            let pct = 30;
            const interval = setInterval(() => {
                pct = Math.min(pct + 2, 80);
                setProgress(pct);
                if (pct >= 50) activateStep(2);
            }, 500);

            const resp = await fetchPromise;
            clearTimeout(timeoutId);
            clearInterval(interval);

            activateStep(2); setProgress(85);
            const result = await resp.json();

            if (!resp.ok) throw new Error(result.error || 'Server error');

            // Step 3: Rule engine complete
            activateStep(3); setProgress(100);
            await delay(300);

            renderResults(result);
        } catch (err) {
            const msg = err.name === 'AbortError'
                ? 'Request timed out. Please try again.'
                : err.message || 'An unexpected error occurred.';
            showError(msg);
            progressSec.classList.remove('active');
        } finally {
            submitBtn.disabled = false;
        }
    });

    // ── Render results ──
    function renderResults(data) {
        progressSec.classList.remove('active');

        const recon  = data.reconciliation || {};
        const stats  = recon.stats || {};
        const flags  = recon.flags || [];
        const matched = recon.matched || [];
        const docs   = data.documents || {};
        const proc   = data.processing || {};
        const summary = docs.invoice?.summary || {};

        // Stats
        $('#statPrescribed').textContent = stats.prescribed || 0;
        $('#statInvoiced').textContent   = stats.invoiced || 0;
        $('#statMatched').textContent    = stats.matched || 0;
        $('#statFlags').textContent      = stats.totalFlags || 0;

        // Color the flags stat
        const flagCard = $('#statFlagsCard');
        flagCard.className = 'stat-card';
        if (stats.totalFlags > 0) flagCard.classList.add(stats.high > 0 ? 'danger' : 'warning');
        else flagCard.classList.add('success');

        // Confidence ring
        const conf = (recon.averageConfidence || 0) * 100;
        $('#confValue').textContent = conf.toFixed(0) + '%';
        const circumference = 2 * Math.PI * 26;
        const ring = $('#confRing');
        ring.style.strokeDasharray = circumference;
        ring.style.strokeDashoffset = circumference - (circumference * conf / 100);
        if (conf >= 80) ring.style.stroke = 'var(--success)';
        else if (conf >= 50) ring.style.stroke = 'var(--warning)';
        else ring.style.stroke = 'var(--danger)';

        $('#confLabel').innerHTML = `Avg. extraction confidence: <strong>${conf.toFixed(0)}%</strong>`;

        // Matched items table
        const tbody = $('#matchedBody');
        tbody.innerHTML = '';
        if (matched.length === 0) {
            tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--text-muted);padding:20px;">No matched items found</td></tr>';
        } else {
            matched.forEach(m => {
                const sim = (m.sim * 100).toFixed(0);
                const cls = sim >= 90 ? 'match-high' : sim >= 70 ? 'match-med' : 'match-low';
                const pQ = m.rx.quantity || '—';
                const iQ = m.inv.quantity || '—';
                const qtyMismatch = pQ !== '—' && iQ !== '—' && String(pQ) !== String(iQ);
                tbody.innerHTML += `
                <tr>
                    <td><span class="flag-item-name">${esc(m.rx.name)}</span><br><small style="color:var(--text-muted)">${esc(m.rx.strength || '')}</small></td>
                    <td><span class="flag-item-name">${esc(m.inv.name)}</span><br><small style="color:var(--text-muted)">${esc(m.inv.strength || '')}</small></td>
                    <td><span class="match-score ${cls}">${sim}%</span></td>
                    <td style="${qtyMismatch ? 'color:var(--danger);font-weight:600' : ''}">${esc(String(pQ))} → ${esc(String(iQ))}</td>
                    <td style="font-variant-numeric:tabular-nums">₹${formatNum(m.inv.lineTotal)}</td>
                </tr>`;
            });
        }

        // Flags
        const flagsContainer = $('#flagsList');
        flagsContainer.innerHTML = '';
        if (flags.length === 0) {
            flagsContainer.innerHTML = `
            <div class="empty-state">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 12l2 2 4-4"/><circle cx="12" cy="12" r="10"/></svg>
                <p>No discrepancies found — all checks passed!</p>
            </div>`;
        } else {
            flags.forEach(f => {
                flagsContainer.innerHTML += `
                <div class="flag-item ${f.severity}">
                    <span class="flag-severity ${f.severity}">${f.severity}</span>
                    <div class="flag-body">
                        <div class="flag-rule">${esc(f.ruleCode)} · <span class="flag-item-name">${esc(f.item || '')}</span></div>
                        <div class="flag-text">${esc(f.explanation)}</div>
                    </div>
                </div>`;
            });
        }

        // Arithmetic summary
        const arithGrid = $('#arithmeticGrid');
        arithGrid.innerHTML = '';
        if (summary && Object.keys(summary).length > 0) {
            const items = [
                ['Subtotal', summary.subtotal],
                ['Discount', summary.discount],
                ['Taxable Amount', summary.taxableAmount],
                ['CGST', summary.cgst],
                ['SGST', summary.sgst],
                ['Total GST', summary.gstAmount],
                ['Round-off', summary.roundOff],
            ];
            items.forEach(([label, val]) => {
                if (val != null) {
                    arithGrid.innerHTML += `
                    <div class="arith-item">
                        <span class="arith-label">${label}</span>
                        <span class="arith-value">₹${formatNum(val)}</span>
                    </div>`;
                }
            });
            if (summary.grandTotal != null) {
                arithGrid.innerHTML += `
                <div class="arith-item total">
                    <span class="arith-label">Grand Total</span>
                    <span class="arith-value">₹${formatNum(summary.grandTotal)}</span>
                </div>`;
            }
        } else {
            arithGrid.innerHTML = '<div class="empty-state" style="grid-column:1/-1"><p>No arithmetic data extracted</p></div>';
        }

        // Clarification draft
        const clarBox = $('#clarificationBox');
        const clarSection = $('#clarificationSection');
        if (recon.clarificationDraft) {
            clarBox.textContent = recon.clarificationDraft;
            clarSection.style.display = 'block';
        } else {
            clarSection.style.display = 'none';
        }

        // Processing meta
        $('#metaTime').textContent   = proc.elapsedMs ? `${proc.elapsedMs}ms` : '—';
        $('#metaModel').textContent  = proc.model || '—';
        $('#metaItems').textContent  = `${stats.prescribed || 0} Rx + ${stats.invoiced || 0} Inv`;

        // Raw JSON
        $('#rawJson').textContent = JSON.stringify(data, null, 2);

        resultsSec.classList.add('visible');

        // Scroll to results
        resultsSec.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    // ── Copy clarification ──
    const copyBtn = $('#copyClari');
    if (copyBtn) {
        copyBtn.addEventListener('click', () => {
            const text = $('#clarificationBox').textContent;
            navigator.clipboard.writeText(text).then(() => {
                copyBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 12l2 2 4-4"/></svg> Copied!`;
                setTimeout(() => {
                    copyBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg> Copy Message`;
                }, 2000);
            });
        });
    }

    // ── Helpers ──
    function showError(msg) {
        errorText.textContent = msg;
        errorBanner.classList.add('visible');
    }
    function hideError() {
        errorBanner.classList.remove('visible');
    }
    function delay(ms) {
        return new Promise(r => setTimeout(r, ms));
    }
    function esc(str) {
        const d = document.createElement('div');
        d.textContent = str;
        return d.innerHTML;
    }
    function formatNum(v) {
        const n = parseFloat(v);
        return isNaN(n) ? (v || '—') : n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }
})();
