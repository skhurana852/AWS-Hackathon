/**
 * Form Generator (local, for the Nova Sonic server).
 *
 * Generates a pre-filled HTML document for:
 *   - FD requests / confirmations
 *   - Cash withdrawal slips / receipts
 *
 * The HTML is written to a local directory that the server exposes at `/forms`,
 * so the browser can open or download the finished form. This is the local
 * equivalent of the S3-backed `form-generator` Lambda.
 */

import fs from 'fs';
import path from 'path';

export type FormType = 'FD_REQUEST' | 'WITHDRAWAL_SLIP';

export interface FormCustomer {
  customerId: string;
  maskedName?: string;
  fullName?: string;
  pan?: string;
}

export interface SavedForm {
  refNo: string;
  fileName: string;
  /** Public URL path served by the server, e.g. /forms/FORM12345678123.html */
  url: string;
  filePath: string;
}

// Directory where generated forms are written. Served statically at `/forms`.
export const FORMS_DIR = path.resolve(__dirname, '..', 'generated-forms');

function ensureFormsDir(): void {
  try {
    if (!fs.existsSync(FORMS_DIR)) {
      fs.mkdirSync(FORMS_DIR, { recursive: true });
    }
  } catch (e) {
    console.error('[FormGenerator] Could not create forms directory:', e);
  }
}

function generateRef(prefix: string): string {
  const ts = Date.now().toString().slice(-8);
  const rand = Math.floor(Math.random() * 1000).toString().padStart(3, '0');
  return `${prefix}${ts}${rand}`;
}

function inr(value: number | undefined): string {
  return `₹${(value || 0).toLocaleString('en-IN')}`;
}

/**
 * Generate a form, persist it to disk, and return its public URL.
 */
export function saveForm(formType: FormType, data: any, customer: FormCustomer): SavedForm {
  ensureFormsDir();

  const refNo = generateRef('FORM');
  const fileName = `${refNo}.html`;
  const filePath = path.join(FORMS_DIR, fileName);

  const html = formType === 'FD_REQUEST'
    ? generateFdFormHtml(customer, data, refNo)
    : generateWithdrawalSlipHtml(customer, data, refNo);

  fs.writeFileSync(filePath, html, 'utf-8');

  return {
    refNo,
    fileName,
    url: `/forms/${fileName}`,
    filePath
  };
}

// ─── FD Form HTML ─────────────────────────────────────────────────────────────

function generateFdFormHtml(customer: FormCustomer, data: any, refNo: string): string {
  const isManual = (data.route || '').toUpperCase() === 'MANUAL';
  const title = isManual ? 'Fixed Deposit Request Form' : 'Fixed Deposit Confirmation';
  const paymentMode = isManual ? 'Cash at Counter' : 'Debited from Account';

  const tellerBlock = isManual
    ? `<p style="margin-top:30px;"><strong>Instructions for Teller:</strong> Collect ${inr(data.amount)} cash from the customer and complete FD booking in CBS.</p>
       <p><strong>Counter Token:</strong> <span class="token">${data.counterToken || '—'}</span></p>`
    : `<p style="margin-top:30px;"><strong>Status:</strong> Your Fixed Deposit has been booked successfully and the amount debited from account ${data.debitedFrom || '—'}.</p>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} — ${refNo}</title>
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
    .token { font-size: 18px; font-weight: bold; }
    .watermark { color: #f0f0f0; font-size: 60px; position: fixed; top: 40%; left: 20%; transform: rotate(-30deg); z-index: -1; }
    @media print { .no-print { display: none; } }
    .no-print { text-align:center; margin-top: 24px; }
    .no-print button { background:#003366; color:#fff; border:none; padding:10px 18px; border-radius:6px; font-size:14px; cursor:pointer; }
  </style>
</head>
<body>
  <div class="watermark">MOCK ONLY</div>
  <div class="header">
    <div class="logo">🏦 SAHAYAK BANK</div>
    <div class="subtitle">AI-Powered Banking — Hackathon Prototype</div>
    <h2 style="color:#003366;">${title}</h2>
    <span class="badge">Ref: ${refNo}</span>
  </div>

  <table>
    <tr><td>Customer Name</td><td>${customer.maskedName || customer.fullName || '—'}</td></tr>
    <tr><td>Customer ID</td><td>${customer.customerId}</td></tr>
    <tr><td>Deposit Amount</td><td>${inr(data.amount)}</td></tr>
    <tr><td>Tenure</td><td>${data.tenureMonths || '—'} months</td></tr>
    <tr><td>Interest Rate</td><td>${data.rate || '—'}% per annum</td></tr>
    <tr><td>Maturity Amount</td><td>${inr(data.maturityAmount)}</td></tr>
    <tr><td>Maturity Date</td><td>${data.maturityDate || '—'}</td></tr>
    <tr><td>FD Reference No.</td><td>${data.fdRefNo || refNo}</td></tr>
    <tr><td>Form Generated On</td><td>${new Date().toLocaleString('en-IN')}</td></tr>
    <tr><td>Channel</td><td>Sahayak Voice Agent (Kiosk)</td></tr>
    <tr><td>Payment Mode</td><td>${paymentMode}</td></tr>
  </table>

  ${tellerBlock}

  <div class="no-print"><button onclick="window.print()">🖨️ Print / Save as PDF</button></div>

  <div class="footer">
    This form was pre-filled by Sahayak AI Agent. For hackathon demo purposes only — mock data.<br>
    Ref: ${refNo} | Generated: ${new Date().toISOString()}
  </div>
</body>
</html>`;
}

// ─── Withdrawal Slip HTML ─────────────────────────────────────────────────────

function generateWithdrawalSlipHtml(customer: FormCustomer, data: any, refNo: string): string {
  const isKiosk = (data.channel || '').toUpperCase() === 'KIOSK';
  const title = isKiosk ? 'Cash Withdrawal Receipt' : 'Cash Withdrawal Slip';

  const tellerBlock = isKiosk
    ? `<p style="margin-top:30px;"><strong>Status:</strong> ${inr(data.amount)} dispensed at the kiosk. Updated balance: ${inr(data.newBalance)}.</p>`
    : `<p style="margin-top:30px;"><strong>Instructions for Teller:</strong> Verify the customer and hand over ${inr(data.amount)} in cash.</p>
       <p><strong>Counter Token:</strong> <span class="token">${data.counterToken || '—'}</span></p>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} — ${refNo}</title>
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
    .token { font-size: 18px; font-weight: bold; }
    .watermark { color: #f0f0f0; font-size: 60px; position: fixed; top: 40%; left: 20%; transform: rotate(-30deg); z-index: -1; }
    @media print { .no-print { display: none; } }
    .no-print { text-align:center; margin-top: 24px; }
    .no-print button { background:#003366; color:#fff; border:none; padding:10px 18px; border-radius:6px; font-size:14px; cursor:pointer; }
  </style>
</head>
<body>
  <div class="watermark">MOCK ONLY</div>
  <div class="header">
    <div class="logo">🏦 SAHAYAK BANK</div>
    <div class="subtitle">AI-Powered Banking — Hackathon Prototype</div>
    <h2 style="color:#003366;">${title}</h2>
    <span class="badge">Ref: ${refNo}</span>
  </div>

  <table>
    <tr><td>Customer Name</td><td>${customer.maskedName || customer.fullName || '—'}</td></tr>
    <tr><td>Customer ID</td><td>${customer.customerId}</td></tr>
    <tr><td>Account Number</td><td>${data.accountId || '—'}</td></tr>
    <tr><td>Withdrawal Amount</td><td>${inr(data.amount)}</td></tr>
    <tr><td>Denomination Preference</td><td>${data.denominationPreference || 'No preference'}</td></tr>
    <tr><td>Transaction Ref</td><td>${data.txnRef || refNo}</td></tr>
    <tr><td>Channel</td><td>${isKiosk ? 'Kiosk / ATM' : 'Teller Counter'}</td></tr>
    <tr><td>Form Generated On</td><td>${new Date().toLocaleString('en-IN')}</td></tr>
  </table>

  ${tellerBlock}

  <div class="no-print"><button onclick="window.print()">🖨️ Print / Save as PDF</button></div>

  <div class="footer">
    This slip was pre-filled by Sahayak AI Agent. For hackathon demo purposes only — mock data.<br>
    Ref: ${refNo} | Generated: ${new Date().toISOString()}
  </div>
</body>
</html>`;
}
