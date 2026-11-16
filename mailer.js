const nodemailer = require('nodemailer');

function smtpConfig() {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM } = process.env;
  const port = Number(SMTP_PORT || 587);
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS || !SMTP_FROM || !Number.isInteger(port) || port < 1 || port > 65535) {
    const error = new Error('SMTP is not configured. Copy .env.example to .env and set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, and SMTP_FROM.');
    error.code = 'SMTP_CONFIG';
    throw error;
  }
  return {
    host: SMTP_HOST,
    port,
    secure: String(process.env.SMTP_SECURE || (port === 465)).toLowerCase() === 'true',
    auth: { user: SMTP_USER, pass: SMTP_PASS },
    from: SMTP_FROM,
  };
}

async function sendEmail(to, subject, text) {
  const config = smtpConfig();
  const transporter = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: config.auth,
  });
  return transporter.sendMail({ from: config.from, to, subject, text });
}

module.exports = { sendEmail };
