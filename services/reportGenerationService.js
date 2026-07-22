const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');
const Report = require('../models/Report');
const r2Service = require('./r2Service');
const { getReportData } = require('./reportDataService');
const logger = require('../utils/logger');

const REPORT_TYPE_LABELS = {
  revenue: 'Revenue Report',
  finance: 'Finance Report',
  transactions: 'Transactions Report',
  customer_activity: 'Customer Activity Report',
  runner_performance: 'Runner Performance Report',
  errands: 'Errands Report',
  verification: 'Verification Report',
  withdrawals: 'Withdrawals Report',
  disputes: 'Disputes Report',
  locations: 'Locations Report',
  audit_logs: 'Audit Logs Report',
};

const MIME_TYPES = {
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pdf: 'application/pdf',
  csv: 'text/csv',
};

// ── CSV ──────────────────────────────────────────────────────────────────────

const escapeCsv = (val) => {
  const s = String(val ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const renderCsv = ({ summary, rows, columns }) => {
  const lines = ['Summary'];
  Object.entries(summary).forEach(([k, v]) => lines.push(`${escapeCsv(k)},${escapeCsv(v)}`));
  lines.push('');
  lines.push(columns.map((c) => escapeCsv(c.label)).join(','));
  rows.forEach((r) => lines.push(columns.map((c) => escapeCsv(r[c.key])).join(',')));
  return Buffer.from(lines.join('\n'), 'utf-8');
};

// ── Excel ────────────────────────────────────────────────────────────────────

const renderXlsx = async ({ name, summary, rows, columns }) => {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Tumwa Admin';
  workbook.created = new Date();

  const sheet = workbook.addWorksheet((name || 'Report').slice(0, 31));

  sheet.addRow(['Summary']).font = { bold: true };
  Object.entries(summary).forEach(([k, v]) => sheet.addRow([k, v]));
  sheet.addRow([]);

  const headerRow = sheet.addRow(columns.map((c) => c.label));
  headerRow.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF248249' } };
  });

  rows.forEach((r) => sheet.addRow(columns.map((c) => r[c.key] ?? '')));
  sheet.columns.forEach((col) => {
    col.width = 20;
  });

  return workbook.xlsx.writeBuffer();
};

// ── PDF ──────────────────────────────────────────────────────────────────────

const renderPdf = ({ name, summary, rows, columns }) =>
  new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      margin: 40,
      size: 'A4',
      layout: columns.length > 6 ? 'landscape' : 'portrait',
    });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.fillColor('#FF6F3C').fontSize(22).text('Tumwa');
    doc.fillColor('#111827').fontSize(15).text(name);
    doc.fillColor('#6B7280').fontSize(9).text(`Generated ${new Date().toLocaleString('en-KE')}`);
    doc.moveDown(1);

    doc.fillColor('#111827').fontSize(12).text('Summary', { underline: true });
    doc.moveDown(0.3);
    doc.fontSize(9);
    Object.entries(summary).forEach(([k, v]) => {
      doc.fillColor('#374151').text(`${k}: ${v}`);
    });
    doc.moveDown(1);

    doc.fillColor('#111827').fontSize(12).text('Data', { underline: true });
    doc.moveDown(0.3);
    doc.fontSize(7);
    doc.fillColor('#111827').text(columns.map((c) => c.label).join('   |   '));
    doc.fillColor('#374151');
    // PDFKit has no built-in grid table — a monospace-ish delimited line per
    // row is the simplest layout that stays readable without a table engine.
    rows.slice(0, 2000).forEach((r) => {
      doc.text(columns.map((c) => String(r[c.key] ?? '')).join('   |   '));
    });

    doc.end();
  });

const RENDERERS = {
  xlsx: renderXlsx,
  pdf: renderPdf,
  csv: async (data) => renderCsv(data),
};

// ── Orchestration ──────────────────────────────────────────────────────────────

/**
 * Generate a report file and persist its metadata. The Report doc is created
 * up front (status: 'generating') so the list endpoint can show in-flight
 * generations, then flipped to 'completed'/'failed' once rendering + the R2
 * upload finish.
 */
exports.generateReport = async ({ type, format, filters = {}, generatedBy }) => {
  if (type === 'promo_codes') {
    throw new Error('Promo Codes reporting is not available yet — the Promo Codes feature has not launched.');
  }
  if (!REPORT_TYPE_LABELS[type]) {
    throw new Error(`Unsupported report type: ${type}`);
  }
  if (!RENDERERS[format]) {
    throw new Error(`Unsupported file format: ${format}`);
  }

  const name = REPORT_TYPE_LABELS[type];

  const report = await Report.create({
    name,
    type,
    filters,
    generatedBy,
    fileFormat: format,
    status: 'generating',
  });

  try {
    const data = await getReportData(type, filters);
    const buffer = await RENDERERS[format]({ name, ...data });

    const key = await r2Service.uploadFile(buffer, 'admin-reports', report._id.toString(), MIME_TYPES[format]);

    report.filePath = key;
    report.status = 'completed';
    report.generatedAt = new Date();
    await report.save();

    return report;
  } catch (err) {
    logger.error('Report generation failed', { reportId: report._id, type, format, error: err.message });
    report.status = 'failed';
    report.errorMessage = err.message;
    await report.save();
    throw err;
  }
};

exports.REPORT_TYPE_LABELS = REPORT_TYPE_LABELS;
