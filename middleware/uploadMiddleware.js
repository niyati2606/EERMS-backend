const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const RECEIPT_MAX = 200 * 1024; // 200 KB expense receipts
const CHEQUE_MAX = 2 * 1024 * 1024; // 2 MB cancelled cheque (2,097,152 bytes)
const BUNDLED_ROOT = path.join(__dirname, '..', 'uploads');
const ROOT = process.env.VERCEL ? path.join('/tmp', 'uploads') : BUNDLED_ROOT;

function make(sub, maxBytes) {
  const dir = path.join(ROOT, sub);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (_) {}

  return multer({
    storage: multer.diskStorage({
      destination: (req, file, cb) => {
        try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
        cb(null, dir);
      },
      filename: (req, f, cb) => cb(null, crypto.randomBytes(12).toString('hex') + path.extname(f.originalname).toLowerCase()),
    }),
    limits: { fileSize: maxBytes, files: 25 },
    fileFilter: (req, f, cb) => {
      const ok = /^(image\/jpeg|image\/png|application\/pdf)$/.test(f.mimetype) && /\.(jpe?g|png|pdf)$/i.test(f.originalname);
      ok ? cb(null, true) : cb(Object.assign(new Error('Only PDF, JPG or PNG files are allowed'), { status: 400 }));
    },
  });
}

const receiptUpload = make('receipts', RECEIPT_MAX);
const chequeUpload = make('cheques', CHEQUE_MAX);

const sha256File = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const removeFiles = (files) => (files || []).forEach((f) => { try { fs.unlinkSync(f.path); } catch { /* ignore */ } });

function uploadErrors(err, req, res, next) {
  if (err instanceof multer.MulterError) {
    const limit = err.field && String(err.field).startsWith('cheque') ? '2 MB' : '200 KB';
    const message = err.code === 'LIMIT_FILE_SIZE' ? `File too large (max ${limit})` : err.message;
    return res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ message });
  }
  if (err && err.status === 400 && /Only PDF/.test(err.message)) return res.status(400).json({ message: err.message });
  next(err);
}

module.exports = { receiptUpload, chequeUpload, sha256File, removeFiles, uploadErrors, ROOT, RECEIPT_MAX, CHEQUE_MAX };
