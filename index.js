const express = require('express');
const mongoose = require('mongoose');
const crypto = require('crypto');
const path = require('path');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const app = express();

// Render terminates TLS and forwards the original scheme; trust the proxy so
// the HTTPS redirect below works correctly.
app.set('trust proxy', 1);

// Security headers (HSTS, X-Content-Type-Options, frameguard, referrer policy, ...).
// CSP is intentionally off because every page uses inline scripts/styles; move
// JS/CSS to static files before enabling a strict CSP.
app.use(helmet({ contentSecurityPolicy: false }));

// Force HTTPS in production.
app.use((req, res, next) => {
    if (process.env.NODE_ENV === 'production' && req.headers['x-forwarded-proto'] === 'http') {
        return res.redirect(301, 'https://' + req.headers.host + req.originalUrl);
    }
    next();
});

// Signed, httpOnly session cookie. Set SESSION_SECRET to a long random string
// in the environment; without it sessions are regenerated on every restart.
app.use(session({
    name: 'flooftracker.sid',
    secret: process.env.SESSION_SECRET || (() => {
        console.warn('WARNING: SESSION_SECRET is not set — sessions will not survive restarts.');
        return crypto.randomBytes(32).toString('hex');
    })(),
    resave: false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict',
        maxAge: 7 * 24 * 60 * 60 * 1000
    }
}));

// Body parsers: a small limit by default, a large one only where bulk data
// (media, recordings, SMS sync) is actually uploaded. Parsers are attached
// per route so oversized bodies are rejected everywhere except where required.
app.use(express.urlencoded({ limit: '1mb', extended: false }));
const smallJson = express.json({ limit: '1mb' });
const bigJson = express.json({ limit: '52mb' });

app.use(express.static(__dirname + '/public', {
    setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache')
}));

const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI;

if (!MONGO_URI) {
    console.error('FATAL: MONGO_URI environment variable is not set.');
    process.exit(1);
}

mongoose.connect(MONGO_URI)
    .then(() => console.log('MongoDB connected'))
    .catch(err => console.error('MongoDB error:', err));

// Schemas
const EmployerSchema = new mongoose.Schema({
    email: { type: String, unique: true, lowercase: true, trim: true },
    password: { type: String, select: false },  // bcrypt hash; never returned by default
    plan: { type: String, default: 'free' },
    created_at: { type: Date, default: Date.now }
});

const TokenSchema = new mongoose.Schema({
    token: { type: String, unique: true },
    employer_id: mongoose.Schema.Types.ObjectId,
    device_name: { type: String, default: '' },
    registered: { type: Boolean, default: false },
    created_at: { type: Date, default: Date.now },
    active: { type: Boolean, default: true }
});

const DeviceSchema = new mongoose.Schema({
    token: String,
    device_model: String,
    android_version: String,
    last_seen: Date
});

const GpsSchema = new mongoose.Schema({
    token: String,
    latitude: Number,
    longitude: Number,
    accuracy: Number,
    received_at: Date
});

const CallSchema = new mongoose.Schema({
    token: String,
    number: String,
    contact_name: String,
    call_type: String,
    duration_seconds: Number,
    called_at: Number
});

const SmsSchema = new mongoose.Schema({
    token: String,
    number: String,
    contact_name: String,
    message_body: String,
    sms_type: String,
    received_at: Number
});

const AppSchema = new mongoose.Schema({
    token: String,
    app_name: String,
    package_name: String,
    usage_seconds: Number,
    usage_date: String
});

const ContactSchema = new mongoose.Schema({
    token: String,
    name: String,
    number: String
});

const MediaSchema = new mongoose.Schema({
    token: String,
    filename: String,
    media_type: { type: String, default: 'image' }, // 'image' | 'video'
    date_taken: Number,
    path: String,
    size_bytes: Number,
    duration_ms: Number, // videos only
    is_screenshot: Boolean,
    thumbnail: String
});

const NotificationSchema = new mongoose.Schema({
    token: String,
    app: String,
    sender: String,
    chat_id: { type: String, default: '' },
    recipient: { type: String, default: '' },
    message: String,
    direction: { type: String, default: 'incoming' },
    received_at: Date
});

const DownloadRequestSchema = new mongoose.Schema({
    token: String,
    filename: String,
    image_id: String,
    status: { type: String, default: 'pending' }, // pending, uploaded, downloaded
    full_image: String, // base64 full quality
    requested_at: { type: Date, default: Date.now }
});

const DownloadRequest = mongoose.model('DownloadRequest', DownloadRequestSchema);

const CallRecordingSchema = new mongoose.Schema({
    token: String,
    filename: String,
    audio_base64: String,
    recorded_at: Number,
    received_at: { type: Date, default: Date.now }
});
const CommandSchema = new mongoose.Schema({
    token: String,
    type: { type: String },
    status: { type: String, default: 'pending' },
    duration: { type: Number, default: 30 },
    facing: { type: String, default: 'back' },  // ← add this
    result: String,
    created_at: { type: Date, default: Date.now },
    completed_at: Date
});

const Command = mongoose.model('Command', CommandSchema);
const CallRecording = mongoose.model('CallRecording', CallRecordingSchema)
const Employer = mongoose.model('Employer', EmployerSchema);
const Token = mongoose.model('Token', TokenSchema);
const Device = mongoose.model('Device', DeviceSchema);
const Gps = mongoose.model('Gps', GpsSchema);
const Call = mongoose.model('Call', CallSchema);
const Sms = mongoose.model('Sms', SmsSchema);
const App = mongoose.model('App', AppSchema);
const Contact = mongoose.model('Contact', ContactSchema);
const Media = mongoose.model('Media', MediaSchema);
const Notification = mongoose.model('Notification', NotificationSchema);
const Recording = mongoose.model("Recording", CallRecordingSchema);

const PLAN_LIMITS = { free: 1, starter: 5, business: 10, professional: 20, enterprise: 50 };

// ── Rate limiting ────────────────────────────────────────────────────────────
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,   // 15 minutes
    limit: 20,                  // 20 login/register attempts per window
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { success: false, message: 'Too many attempts. Please try again later.' }
});
const deviceLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 240,                 // 240 requests/min per device is plenty
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { success: false, message: 'Rate limit exceeded' }
});

// ── Output escaping (stored-XSS defense) ────────────────────────────────────
function esc(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function maskToken(t) {
    return t ? String(t).slice(0, 6) + '…' + String(t).slice(-4) : '';
}

// ── CSRF (double-submit pattern) ─────────────────────────────────────────────
// A random token lives in the session, is echoed into every rendered page, and
// is sent back as the X-CSRF-Token header by the dashboard scripts. Cross-site
// requests cannot read or guess it.
app.use((req, res, next) => {
    if (!req.session.csrfToken) req.session.csrfToken = crypto.randomBytes(24).toString('hex');
    res.locals.csrfToken = req.session.csrfToken;
    next();
});

function requireCsrf(req, res, next) {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    const provided = req.headers['x-csrf-token'] || (req.body && req.body._csrf);
    if (!provided || provided !== req.session.csrfToken) {
        return res.status(403).json({ success: false, message: 'Invalid or missing CSRF token' });
    }
    next();
}

// ── Authentication / authorization ───────────────────────────────────────────
function requireAuth(req, res, next) {
    if (!req.session || !req.session.employer_id) {
        return res.status(401).json({ success: false, message: 'Not authenticated' });
    }
    next();
}

function requireAuthPage(req, res, next) {
    if (!req.session || !req.session.employer_id) return res.redirect('/');
    next();
}

// Only the employer that OWNS a device token may access that device's data.
async function requireOwnedToken(req, res, next) {
    try {
        const token = String(req.query.token || (req.body && req.body.token) || '').trim();
        const doc = await Token.findOne({ token, active: true, employer_id: req.session.employer_id });
        if (!doc) return res.status(403).json({ success: false, message: 'Device not found' });
        req.deviceToken = token;
        req.tokenDoc = doc;
        next();
    } catch (e) {
        next(e);
    }
}

// Devices authenticate with the x-device-token header (a hex secret).
async function requireValidDeviceToken(req, res, next) {
    try {
        const token = String(req.headers['x-device-token'] || '').trim();
        if (!/^[a-f0-9]{32,64}$/i.test(token)) {
            return res.status(401).json({ success: false, message: 'Invalid device token' });
        }
        const doc = await Token.findOne({ token, active: true });
        if (!doc) return res.status(401).json({ success: false, message: 'Invalid device token' });
        req.deviceToken = token;
        req.tokenDoc = doc;
        next();
    } catch (e) {
        next(e);
    }
}

// ── Validation helpers ───────────────────────────────────────────────────────
function isStr(v, max) { return typeof v === 'string' && v.length <= max; }
function isNonEmptyStr(v, max) { return typeof v === 'string' && v.length > 0 && v.length <= max; }
function isNum(v) { return typeof v === 'number' && Number.isFinite(v); }
function cleanFilename(name) {
    if (!isNonEmptyStr(name, 255)) return null;
    return String(name).replace(/[\\/]/g, '');  // strip path separators
}

const styles = `
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background: #f4f5f8; color: #1f2937; -webkit-font-smoothing: antialiased; }
    a { color: #1a1a2e; }

    /* Header */
    .header { background: linear-gradient(120deg, #15152e 0%, #1a1a2e 55%, #26264d 100%); color: #fff; padding: 14px 24px; display: flex; justify-content: space-between; align-items: center; gap: 16px; flex-wrap: wrap; box-shadow: 0 2px 12px rgba(20,20,43,.35); position: sticky; top: 0; z-index: 100; }
    .header h1 { font-size: 19px; font-weight: 700; letter-spacing: -0.01em; }
    .header small { color: #9aa3c0; font-size: 12.5px; display: block; margin-top: 3px; }
    .container { max-width: 1120px; margin: 26px auto; padding: 0 20px; animation: fadeUp .25s ease both; }

    /* Cards */
    .card { background: #fff; border: 1px solid #e8eaf0; border-radius: 14px; padding: 24px; margin-bottom: 20px; box-shadow: 0 1px 2px rgba(16,24,40,.04), 0 6px 22px rgba(16,24,40,.05); }
    .card-tight { padding: 0; overflow-x: auto; }

    /* Buttons */
    .btn { padding: 9px 18px; border: none; border-radius: 10px; cursor: pointer; font-size: 14px; font-weight: 500; font-family: inherit; display: inline-flex; align-items: center; justify-content: center; gap: 6px; transition: background .18s ease, color .18s ease, border-color .18s ease, transform .18s ease, box-shadow .18s ease; }
    .btn:active { transform: scale(.98); }
    .btn-primary { background: #1a1a2e; color: #fff; }
    .btn-primary:hover { background: #27274b; box-shadow: 0 6px 14px rgba(26,26,46,.28); transform: translateY(-1px); }
    .btn-danger { background: #fef2f2; color: #dc2626; border: 1px solid #fecaca; }
    .btn-danger:hover { background: #fee2e2; }
    .btn-success { background: #16a34a; color: #fff; }
    .btn-success:hover { background: #15803d; box-shadow: 0 6px 14px rgba(22,163,74,.25); transform: translateY(-1px); }
    .btn-outline { background: #fff; color: #374151; border: 1px solid #e2e4ea; }
    .btn-outline:hover { background: #f6f7fa; border-color: #c9cdd6; }
    .btn-sm { padding: 6px 12px; font-size: 12px; border-radius: 8px; }

    /* Inputs */
    input, select { width: 100%; padding: 10px 14px; border: 1px solid #d4d7df; border-radius: 10px; font-size: 14px; font-family: inherit; background: #fff; color: #1f2937; margin-bottom: 12px; transition: border-color .15s ease, box-shadow .15s ease; }
    input:focus, select:focus { outline: none; border-color: #1a1a2e; box-shadow: 0 0 0 3px rgba(26,26,46,.12); }

    /* Alerts */
    .msg { padding: 12px 14px; border-radius: 10px; margin-bottom: 12px; font-size: 13.5px; }
    .msg-error { background: #fef2f2; color: #b91c1c; border: 1px solid #fecaca; }
    .msg-success { background: #f0fdf4; color: #15803d; border: 1px solid #bbf7d0; }

    /* Tables */
    table { width: 100%; border-collapse: collapse; }
    th { background: #f8f9fc; color: #4b5563; font-weight: 600; font-size: 11.5px; text-transform: uppercase; letter-spacing: .05em; padding: 12px 16px; text-align: left; border-bottom: 1px solid #e8eaf0; white-space: nowrap; }
    td { padding: 12px 16px; border-bottom: 1px solid #f0f1f5; font-size: 13.5px; vertical-align: middle; }
    tr:last-child td { border-bottom: none; }
    tr:hover td { background: #f6f8ff; }
    .cell-text { max-width: 400px; overflow-wrap: break-word; }

    /* Tokens page */
    .top-bar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; gap: 12px; flex-wrap: wrap; }
    .token-card { background: #f8f9fc; border: 1px solid #eceef3; border-radius: 12px; padding: 16px 18px; margin-bottom: 12px; display: flex; justify-content: space-between; align-items: center; gap: 12px; transition: border-color .15s ease, box-shadow .15s ease; }
    .token-card:hover { border-color: #d4d7df; box-shadow: 0 4px 14px rgba(16,24,40,.06); }
    .token-code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; color: #6b7280; word-break: break-all; margin-top: 4px; }
    .badge { padding: 3px 10px; border-radius: 999px; font-size: 11.5px; font-weight: 600; display: inline-block; }
    .badge-green { background: #dcfce7; color: #15803d; }
    .badge-gray { background: #f3f4f6; color: #6b7280; }
    .badge-red { background: #fee2e2; color: #b91c1c; }

    /* Media */
    img.thumb { width: 76px; height: 76px; object-fit: cover; border-radius: 10px; cursor: pointer; transition: transform .15s ease, box-shadow .15s ease; }
    img.thumb:hover { transform: scale(1.06); box-shadow: 0 4px 14px rgba(16,24,40,.22); }

    /* Plans */
    .plan-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 16px; }
    .plan-card { border: 1px solid #e2e4ea; border-radius: 14px; padding: 24px 20px; text-align: center; cursor: pointer; transition: all .2s ease; background: #fff; }
    .plan-card:hover { border-color: #1a1a2e; transform: translateY(-3px); box-shadow: 0 10px 24px rgba(16,24,40,.08); }
    .plan-card h3 { margin-bottom: 8px; font-size: 16px; }
    .plan-card .price { font-size: 18px; font-weight: 700; color: #1a1a2e; margin: 8px 0; }
    .plan-card .devices { color: #6b7280; font-size: 13px; margin-bottom: 14px; }
    .plan-card.popular { border-color: #1a1a2e; background: linear-gradient(180deg, #f4f5ff, #fff); box-shadow: 0 8px 20px rgba(26,26,46,.12); }

    /* Tabs */
    .tabs { display: flex; gap: 8px; margin-bottom: 20px; flex-wrap: wrap; }
    .tab { padding: 9px 16px; border: 1px solid #e2e4ea; border-radius: 999px; cursor: pointer; font-size: 13.5px; font-weight: 500; background: #fff; color: #4b5563; display: inline-flex; align-items: center; gap: 6px; box-shadow: 0 1px 2px rgba(16,24,40,.04); transition: all .18s ease; font-family: inherit; }
    .tab:hover { border-color: #1a1a2e; color: #1a1a2e; transform: translateY(-1px); }
    .tab.active { background: #1a1a2e; color: #fff; border-color: #1a1a2e; box-shadow: 0 4px 12px rgba(26,26,46,.28); }
    .tab-content { display: none; }
    .tab-content.active { display: block; animation: fadeUp .2s ease both; }

    /* States */
    .empty { text-align: center; color: #9ca3af; padding: 48px 20px; font-size: 14px; }
    .no-data { color: #9ca3af; text-align: center; padding: 36px 20px; font-size: 13.5px; }

    /* Device status */
    .status-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; margin-right: 6px; }
    .status-online { background: #22c55e; box-shadow: 0 0 0 3px rgba(34,197,94,.2); }
    .status-offline { background: #9ca3af; }
    .status-text-online { color: #86efac; }
    .status-text-offline { color: #9aa3c0; }

    /* Remote control */
    .subtext { color: #6b7280; font-size: 13px; margin-bottom: 20px; }
    .section-title { color: #1f2937; margin-bottom: 14px; font-size: 15px; font-weight: 600; }
    .remote-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 16px; margin-bottom: 24px; }
    .remote-card { background: #f8f9fc; border: 1px solid #eceef3; border-radius: 14px; padding: 22px 20px; text-align: center; transition: all .18s ease; }
    .remote-card:hover { border-color: #d4d7df; transform: translateY(-2px); box-shadow: 0 8px 18px rgba(16,24,40,.07); }
    .remote-icon { font-size: 30px; margin-bottom: 10px; }
    .remote-card h4 { margin-bottom: 6px; font-size: 15px; }
    .remote-card p { color: #6b7280; font-size: 12.5px; margin-bottom: 14px; line-height: 1.45; }
    .result-card { background: #f8f9fc; border: 1px solid #eceef3; border-radius: 14px; padding: 16px; margin-bottom: 14px; }
    .result-head { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 4px; }
    .result-label { font-weight: 600; font-size: 14px; }
    .result-date { color: #9ca3af; font-size: 12px; }
    .result-card img { max-width: 100%; border-radius: 10px; cursor: pointer; margin-top: 10px; }
    .result-link { display: inline-block; margin-top: 10px; color: #1a1a2e; font-size: 13px; font-weight: 500; text-decoration: none; }
    .result-link:hover { text-decoration: underline; }
    audio { width: 100%; margin-top: 10px; }
    .audio-mini { height: 34px; width: 210px; margin: 0; }
    .map-link { color: #1a1a2e; font-weight: 600; text-decoration: none; font-size: 12.5px; background: #eef0ff; padding: 4px 10px; border-radius: 8px; transition: background .15s ease; }
    .map-link:hover { background: #e0e3ff; }

    /* Messages */
    .direction-btn.active { background: #1a1a2e; color: #fff; border-color: #1a1a2e; }
    .app-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 14px; margin-bottom: 20px; }
    .app-card { border: 1.5px solid #e6e8ef; border-radius: 14px; padding: 22px 16px; text-align: center; cursor: pointer; transition: all .18s ease; background: #fff; }
    .app-card:hover { border-color: #1a1a2e; transform: translateY(-3px); box-shadow: 0 8px 20px rgba(16,24,40,.08); }
    .app-icon { font-size: 30px; margin-bottom: 8px; }
    .app-name { font-weight: 600; font-size: 14.5px; }
    .app-count { color: #6b7280; font-size: 12.5px; margin-top: 4px; }
    .back-row { display: flex; align-items: center; gap: 12px; margin-bottom: 14px; }
    .chat-list { border: 1px solid #eceef3; border-radius: 12px; overflow: hidden; background: #fff; }
    .chat-item { display: flex; justify-content: space-between; align-items: center; padding: 14px 16px; border-bottom: 1px solid #f0f1f5; cursor: pointer; transition: background .12s ease; }
    .chat-item:last-child { border-bottom: none; }
    .chat-item:hover { background: #f6f8ff; }
    .chat-name { font-weight: 600; font-size: 14px; }
    .chat-preview { color: #9ca3af; font-size: 12.5px; margin-top: 3px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 420px; }
    .chat-meta { text-align: right; flex-shrink: 0; margin-left: 12px; }
    .chat-time { color: #9ca3af; font-size: 11.5px; }
    .chat-count { background: #1a1a2e; color: #fff; border-radius: 999px; padding: 2px 9px; font-size: 11px; font-weight: 600; margin-top: 5px; display: inline-block; }
    .msg-thread { max-height: 480px; overflow-y: auto; border: 1px solid #eceef3; border-radius: 12px; background: #fbfcfe; padding: 12px; }
    .msg-thread::-webkit-scrollbar { width: 8px; }
    .msg-thread::-webkit-scrollbar-thumb { background: #d4d7df; border-radius: 8px; }
    .msg-row { display: flex; justify-content: flex-start; margin-bottom: 10px; }
    .msg-bubble { background: #fff; border: 1px solid #e6e8ef; border-radius: 14px; border-bottom-left-radius: 4px; padding: 9px 14px; max-width: 78%; box-shadow: 0 1px 2px rgba(16,24,40,.05); }
    .msg-bubble .text { font-size: 14px; line-height: 1.45; }
    .msg-time { color: #9ca3af; font-size: 11px; margin-top: 6px; text-align: right; }
    .table-wrap { border: 1px solid #eceef3; border-radius: 12px; overflow: hidden; }

    /* Lightbox */
    #lightbox { display: none; position: fixed; inset: 0; background: rgba(15,15,30,.92); z-index: 9999; justify-content: center; align-items: center; cursor: pointer; }
    #lightbox img { max-width: 90%; max-height: 90%; border-radius: 12px; animation: zoomIn .18s ease both; box-shadow: 0 20px 60px rgba(0,0,0,.5); }
    .lightbox-close { position: fixed; top: 18px; right: 26px; color: #fff; font-size: 32px; font-weight: 300; line-height: 1; cursor: pointer; opacity: .75; transition: opacity .15s ease; z-index: 10000; }
    .lightbox-close:hover { opacity: 1; }

    /* Animations */
    @keyframes fadeUp { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }
    @keyframes zoomIn { from { opacity: 0; transform: scale(.96); } to { opacity: 1; transform: scale(1); } }
`;

// ── Employer Routes ──────────────────────────────────────────────────────────

app.post('/employer/register', smallJson, authLimiter, async (req, res) => {
    try {
        const email = String((req.body && req.body.email) || '').trim().toLowerCase();
        const password = String((req.body && req.body.password) || '');
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            return res.json({ success: false, message: 'Please enter a valid email address' });
        }
        if (password.length < 8) {
            return res.json({ success: false, message: 'Password must be at least 8 characters' });
        }
        const existing = await Employer.findOne({ email });
        if (existing) return res.json({ success: false, message: 'That email is already registered' });
        const hash = await bcrypt.hash(password, 10);
        const employer = await Employer.create({ email, password: hash });
        // Auto-login after registration: fresh session + fresh CSRF token.
        req.session.regenerate((err) => {
            if (err) return res.json({ success: false, message: 'Could not start session' });
            req.session.employer_id = employer._id.toString();
            req.session.plan = employer.plan;
            req.session.csrfToken = crypto.randomBytes(24).toString('hex');
            res.json({ success: true, employer_id: employer._id, plan: employer.plan });
        });
    } catch (e) {
        console.error('Register error:', e);
        res.json({ success: false, message: 'Registration failed' });
    }
});

app.post('/employer/login', smallJson, authLimiter, async (req, res) => {
    try {
        const email = String((req.body && req.body.email) || '').trim().toLowerCase();
        const password = String((req.body && req.body.password) || '');
        const employer = await Employer.findOne({ email }).select('+password');
        const ok = employer && await bcrypt.compare(password, employer.password);
        if (!ok) return res.json({ success: false, message: 'Invalid credentials' });
        // Session fixation protection: fresh session id + fresh CSRF token on login.
        req.session.regenerate((err) => {
            if (err) return res.json({ success: false, message: 'Could not start session' });
            req.session.employer_id = employer._id.toString();
            req.session.plan = employer.plan;
            req.session.csrfToken = crypto.randomBytes(24).toString('hex');
            res.json({ success: true, employer_id: employer._id, plan: employer.plan });
        });
    } catch (e) {
        console.error('Login error:', e);
        res.json({ success: false, message: 'Login failed' });
    }
});

app.post('/employer/set-plan', smallJson, requireAuth, requireCsrf, async (req, res) => {
    try {
        const plan = String((req.body && req.body.plan) || '');
        if (!(plan in PLAN_LIMITS)) return res.json({ success: false, message: 'Unknown plan' });
        await Employer.findByIdAndUpdate(req.session.employer_id, { plan });
        req.session.plan = plan;
        res.json({ success: true });
    } catch (e) {
        console.error('set-plan error:', e);
        res.json({ success: false, message: 'Failed to update plan' });
    }
});

app.post('/employer/generate-token', smallJson, requireAuth, requireCsrf, async (req, res) => {
    try {
        const employer = await Employer.findById(req.session.employer_id);
        if (!employer) return res.json({ success: false, message: 'Employer not found' });
        const tokenCount = await Token.countDocuments({ employer_id: employer._id, active: true });
        const limit = PLAN_LIMITS[employer.plan] || 1;
        if (tokenCount >= limit) {
            return res.json({ success: false, message: `Device limit reached for ${employer.plan} plan. Please upgrade.` });
        }
        const token = crypto.randomBytes(32).toString('hex');  // 64-char hex secret
        await Token.create({ token, employer_id: employer._id });
        res.json({ success: true, token });
    } catch (e) {
        console.error('generate-token error:', e);
        res.json({ success: false, message: 'Failed to generate token' });
    }
});

app.post('/employer/tokens', smallJson, requireAuth, requireCsrf, async (req, res) => {
    try {
        const tokens = await Token.find({ employer_id: req.session.employer_id, active: true })
            .sort({ created_at: -1 });
        res.json({ success: true, tokens });
    } catch (e) {
        console.error('tokens error:', e);
        res.json({ success: false, message: 'Failed to load devices' });
    }
});

app.post('/employer/delete-token', smallJson, requireAuth, requireCsrf, async (req, res) => {
    try {
        const tokenDoc = await Token.findOne({
            _id: (req.body && req.body.token_id),
            employer_id: req.session.employer_id
        });
        if (!tokenDoc) return res.json({ success: false, message: 'Device not found' });
        const token = tokenDoc.token;
        await Token.findByIdAndUpdate(tokenDoc._id, { active: false });
        // Removing a device revokes its token AND deletes all of its data.
        await Promise.all([
            Device.deleteMany({ token }),
            Gps.deleteMany({ token }),
            Call.deleteMany({ token }),
            Sms.deleteMany({ token }),
            App.deleteMany({ token }),
            Contact.deleteMany({ token }),
            Media.deleteMany({ token }),
            Notification.deleteMany({ token }),
            DownloadRequest.deleteMany({ token }),
            CallRecording.deleteMany({ token }),
            Command.deleteMany({ token })
        ]);
        res.json({ success: true });
    } catch (e) {
        console.error('delete-token error:', e);
        res.json({ success: false, message: 'Failed to remove device' });
    }
});

// ── Device Routes ────────────────────────────────────────────────────────────

app.post('/device/validate-token', smallJson, deviceLimiter, requireValidDeviceToken, async (req, res) => {
    res.json({ success: true });
});

app.post('/device/register', smallJson, deviceLimiter, requireValidDeviceToken, async (req, res) => {
    try {
        const token = req.deviceToken;
        const model = String((req.body && req.body.device_model) || '').slice(0, 200);
        const androidVersion = String((req.body && req.body.android_version) || '').slice(0, 50);
        await Device.findOneAndUpdate(
            { token },
            { token, device_model: model, android_version: androidVersion, last_seen: new Date() },
            { upsert: true }
        );
        await Token.findOneAndUpdate(
            { token },
            { registered: true, device_name: model }
        );
        console.log(`Device registered: ${maskToken(token)}`);
        res.json({ success: true });
    } catch (e) {
        console.error('register error:', e);
        res.json({ success: false, message: 'Registration failed' });
    }
});

app.post('/device/gps', smallJson, deviceLimiter, requireValidDeviceToken, async (req, res) => {
    try {
        const b = req.body || {};
        if (b.latitude == null || b.longitude == null || b.accuracy == null) {
            return res.json({ success: false, message: 'Invalid location data' });
        }
        const lat = Number(b.latitude);
        const lon = Number(b.longitude);
        const acc = Number(b.accuracy);
        if (!Number.isFinite(lat) || lat < -90 || lat > 90 ||
            !Number.isFinite(lon) || lon < -180 || lon > 180 ||
            !Number.isFinite(acc) || acc < 0 || acc > 100000) {
            return res.json({ success: false, message: 'Invalid location data' });
        }
        await Gps.create({ token: req.deviceToken, latitude: lat, longitude: lon, accuracy: acc, received_at: new Date() });
        res.json({ success: true });
    } catch (e) {
        console.error('gps error:', e);
        res.json({ success: false, message: 'Failed to save location' });
    }
});

app.post('/device/calls', smallJson, deviceLimiter, requireValidDeviceToken, async (req, res) => {
    try {
        const calls = Array.isArray(req.body) ? req.body : [];
        if (calls.length > 1000) return res.json({ success: false, message: 'Too many call records' });
        const cleaned = [];
        for (const c of calls) {
            if (!c || !isNonEmptyStr(c.number, 64) || !isStr(c.contact_name, 255) ||
                !isNonEmptyStr(c.call_type, 16) || !isNum(c.duration_seconds) || !isNum(c.called_at)) continue;
            cleaned.push({
                token: req.deviceToken,
                number: c.number,
                contact_name: c.contact_name || '',
                call_type: c.call_type,
                duration_seconds: Math.max(0, Math.floor(c.duration_seconds)),
                called_at: Math.floor(c.called_at)
            });
        }
        await Call.deleteMany({ token: req.deviceToken });
        if (cleaned.length) await Call.insertMany(cleaned);
        console.log(`${cleaned.length} calls from ${maskToken(req.deviceToken)}`);
        res.json({ success: true });
    } catch (e) {
        console.error('calls error:', e);
        res.json({ success: false, message: 'Failed to save calls' });
    }
});

app.post('/device/sms', bigJson, deviceLimiter, requireValidDeviceToken, async (req, res) => {
    try {
        const messages = Array.isArray(req.body) ? req.body : [];
        if (messages.length > 5000) return res.json({ success: false, message: 'Too many SMS records' });
        const token = req.deviceToken;
        for (const msg of messages) {
            if (!msg || !isNonEmptyStr(msg.number, 64) || !isStr(msg.contact_name, 255) ||
                !isStr(msg.message_body, 5000) || !isNonEmptyStr(msg.sms_type, 8) || !isNum(msg.received_at)) continue;
            const existing = await Sms.findOne({ token, number: msg.number, received_at: msg.received_at });
            if (!existing) {
                await Sms.create({
                    token,
                    number: msg.number,
                    contact_name: msg.contact_name || '',
                    message_body: msg.message_body || '',
                    sms_type: msg.sms_type,
                    received_at: Math.floor(msg.received_at)
                });
            }
        }
        console.log(`${messages.length} SMS from ${maskToken(token)}`);
        res.json({ success: true });
    } catch (e) {
        console.error('sms error:', e);
        res.json({ success: false, message: 'Failed to save SMS' });
    }
});

app.post('/device/apps', bigJson, deviceLimiter, requireValidDeviceToken, async (req, res) => {
    try {
        const apps = Array.isArray(req.body) ? req.body : [];
        if (apps.length > 2000) return res.json({ success: false, message: 'Too many app records' });
        const cleaned = [];
        for (const a of apps) {
            if (!a || !isNonEmptyStr(a.app_name, 200) || !isNonEmptyStr(a.package_name, 200) ||
                !isNum(a.usage_seconds) || !isStr(a.usage_date, 20)) continue;
            cleaned.push({
                token: req.deviceToken,
                app_name: a.app_name,
                package_name: a.package_name,
                usage_seconds: Math.max(0, Math.floor(a.usage_seconds)),
                usage_date: a.usage_date || ''
            });
        }
        await App.deleteMany({ token: req.deviceToken });
        if (cleaned.length) await App.insertMany(cleaned);
        console.log(`${cleaned.length} apps from ${maskToken(req.deviceToken)}`);
        res.json({ success: true });
    } catch (e) {
        console.error('apps error:', e);
        res.json({ success: false, message: 'Failed to save apps' });
    }
});

app.post('/device/contacts', bigJson, deviceLimiter, requireValidDeviceToken, async (req, res) => {
    try {
        const contacts = Array.isArray(req.body) ? req.body : [];
        if (contacts.length > 10000) return res.json({ success: false, message: 'Too many contact records' });
        const cleaned = [];
        for (const c of contacts) {
            if (!c || !isStr(c.name, 255) || !isNonEmptyStr(c.number, 64)) continue;
            cleaned.push({ token: req.deviceToken, name: c.name || '', number: c.number });
        }
        await Contact.deleteMany({ token: req.deviceToken });
        if (cleaned.length) await Contact.insertMany(cleaned);
        console.log(`${cleaned.length} contacts from ${maskToken(req.deviceToken)}`);
        res.json({ success: true });
    } catch (e) {
        console.error('contacts error:', e);
        res.json({ success: false, message: 'Failed to save contacts' });
    }
});

app.post('/device/media', bigJson, deviceLimiter, requireValidDeviceToken, async (req, res) => {
    try {
        const media = Array.isArray(req.body) ? req.body : [];
        if (media.length > 500) return res.json({ success: false, message: 'Too many media records' });
        const token = req.deviceToken;
        const cleaned = [];
        for (const m of media) {
            if (!m || (m.media_type !== 'image' && m.media_type !== 'video') ||
                !isNonEmptyStr(m.filename, 255) || !isStr(m.path, 500) ||
                !isStr(m.thumbnail, 5 * 1024 * 1024)) continue;
            cleaned.push({
                token,
                media_type: m.media_type,
                filename: m.filename,
                date_taken: isNum(m.date_taken) ? m.date_taken : 0,
                path: m.path || '',
                size_bytes: isNum(m.size_bytes) ? Math.max(0, m.size_bytes) : 0,
                duration_ms: isNum(m.duration_ms) ? m.duration_ms : 0,
                is_screenshot: !!m.is_screenshot,
                thumbnail: m.thumbnail || ''
            });
        }
        await Media.deleteMany({ token });
        if (cleaned.length) await Media.insertMany(cleaned);
        console.log(`Media received from token: ${maskToken(token)}, count: ${cleaned.length}`);
        res.json({ success: true });
    } catch (e) {
        console.error('Media error:', e);
        res.json({ success: false, message: 'Failed to save media' });
    }
});

app.post('/device/notifications', smallJson, deviceLimiter, requireValidDeviceToken, async (req, res) => {
    try {
        const b = req.body || {};
        const token = req.deviceToken;
        if (!isNonEmptyStr(b.app, 50) || !isStr(b.sender, 255) || !isStr(b.message, 5000) ||
            (b.direction !== undefined && b.direction !== 'incoming' && b.direction !== 'outgoing')) {
            return res.json({ success: false, message: 'Invalid notification data' });
        }
        const existing = await Notification.findOne({ token, app: b.app, sender: b.sender, message: b.message });
        if (!existing) {
            await Notification.create({
                token,
                app: b.app,
                sender: b.sender || '',
                chat_id: isStr(b.chat_id, 255) ? b.chat_id : '',
                recipient: isStr(b.recipient, 255) ? b.recipient : '',
                message: b.message || '',
                direction: b.direction === 'outgoing' ? 'outgoing' : 'incoming',
                received_at: new Date()
            });
            console.log(`Notification from ${maskToken(token)}: ${b.app} - ${b.sender}`);
        }
        res.json({ success: true });
    } catch (e) {
        console.error('notifications error:', e);
        res.json({ success: false, message: 'Failed to save notification' });
    }
});

app.post('/device/call-recording', bigJson, deviceLimiter, requireValidDeviceToken, async (req, res) => {
    try {
        const b = req.body || {};
        if (!isNonEmptyStr(b.filename, 255) || !isNonEmptyStr(b.audio_base64, 52 * 1024 * 1024)) {
            return res.json({ success: false, message: 'Invalid recording data' });
        }
        await CallRecording.create({
            token: req.deviceToken,
            filename: b.filename,
            audio_base64: b.audio_base64,
            recorded_at: isNum(b.recorded_at) ? b.recorded_at : 0,
            received_at: new Date()
        });
        console.log(`Call recording received from ${maskToken(req.deviceToken)}: ${b.filename}`);
        res.json({ success: true });
    } catch (e) {
        console.error('call-recording error:', e);
        res.json({ success: false, message: 'Failed to save recording' });
    }
});

// ── Frontend Pages ───────────────────────────────────────────────────────────

app.get('/', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><title>FloofTracker</title><style>
    ${styles}
    .login-wrap { display:flex; justify-content:center; align-items:center; min-height:100vh; padding:20px; }
    .login-box { background:white; border:1px solid #e8eaf0; border-radius:16px; padding:40px; width:380px; box-shadow:0 8px 30px rgba(16,24,40,.08); }
    .login-box h2 { margin-bottom:6px; color:#1a1a2e; }
    .login-box p { color:#888; margin-bottom:24px; font-size:14px; }
    .btn { width:100%; padding:12px; font-size:15px; }
    a { display:block; text-align:center; margin-top:16px; color:#6b7280; font-size:13px; text-decoration:none; }
    a:hover { color:#1a1a2e; }
    </style></head><body>
    <div class="login-wrap">
        <div class="login-box">
            <h2>FloofTracker</h2>
            <p>Employee monitoring made simple</p>
            <div class="msg msg-error" id="msg" style="display:none"></div>
            <input type="email" id="email" placeholder="Email address"/>
            <input type="password" id="password" placeholder="Password"/>
            <button class="btn btn-primary" onclick="login()">Login</button>
            <a href="/register">Don't have an account? Register here</a>
        </div>
    </div>
    <script>
        async function login() {
            const email = document.getElementById('email').value;
            const password = document.getElementById('password').value;
            const res = await fetch('/employer/login', {
                method:'POST', headers:{'Content-Type':'application/json'},
                body: JSON.stringify({ email, password })
            });
            const data = await res.json();
            if (data.success) {
                localStorage.setItem('employer_id', data.employer_id);
                localStorage.setItem('plan', data.plan);
                window.location.href = data.plan === 'free' ? '/welcome' : '/tokens';
            } else {
                const msg = document.getElementById('msg');
                msg.style.display = 'block';
                msg.textContent = data.message;
            }
        }
    </script>
    </body></html>`);
});

app.get('/register', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><title>Register - FloofTracker</title><style>
    ${styles}
    .login-wrap { display:flex; justify-content:center; align-items:center; min-height:100vh; padding:20px; }
    .login-box { background:white; border:1px solid #e8eaf0; border-radius:16px; padding:40px; width:380px; box-shadow:0 8px 30px rgba(16,24,40,.08); }
    .login-box h2 { margin-bottom:6px; color:#1a1a2e; }
    .login-box p { color:#888; margin-bottom:24px; font-size:14px; }
    .btn { width:100%; padding:12px; font-size:15px; }
    a { display:block; text-align:center; margin-top:16px; color:#6b7280; font-size:13px; text-decoration:none; }
    a:hover { color:#1a1a2e; }
    </style></head><body>
    <div class="login-wrap">
        <div class="login-box">
            <h2>Create Account</h2>
            <p>Start monitoring your team today</p>
            <div class="msg msg-error" id="msg" style="display:none"></div>
            <input type="email" id="email" placeholder="Email address"/>
            <input type="password" id="password" placeholder="Password"/>
            <input type="password" id="confirm" placeholder="Confirm password"/>
            <button class="btn btn-primary" onclick="register()">Create Account</button>
            <a href="/">Already have an account? Login</a>
        </div>
    </div>
    <script>
        async function register() {
            const email = document.getElementById('email').value;
            const password = document.getElementById('password').value;
            const confirm = document.getElementById('confirm').value;
            const msg = document.getElementById('msg');
            if (password !== confirm) { msg.style.display='block'; msg.textContent='Passwords do not match'; return; }
            const res = await fetch('/employer/register', {
                method:'POST', headers:{'Content-Type':'application/json'},
                body: JSON.stringify({ email, password })
            });
            const data = await res.json();
            if (data.success) {
                localStorage.setItem('employer_id', data.employer_id);
                localStorage.setItem('plan', 'free');
                window.location.href = '/welcome';
            } else {
                msg.style.display='block'; msg.textContent=data.message;
            }
        }
    </script>
    </body></html>`);
});

app.get('/welcome', requireAuthPage, (req, res) => {
    res.send(`<!DOCTYPE html><html><head><title>Welcome - FloofTracker</title><style>
    ${styles}
    .feature-grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(180px,1fr)); gap:16px; margin:20px 0; }
    .feature-item { background:#f8f9fc; border:1px solid #eceef3; border-radius:12px; padding:20px; text-align:center; transition: transform .18s ease, box-shadow .18s ease; }
    .feature-item:hover { transform: translateY(-2px); box-shadow: 0 8px 18px rgba(16,24,40,.07); }
    .feature-item .icon { font-size:32px; margin-bottom:10px; }
    .feature-item h4 { color:#1a1a2e; margin-bottom:6px; }
    .feature-item p { color:#6b7280; font-size:13px; line-height:1.5; }
    </style></head><body>
    <div class="header"><h1>FloofTracker</h1><button class="btn btn-danger" onclick="logout()">Logout</button></div>
    <div class="container">
        <div class="card" style="text-align:center;padding:40px">
            <h2 style="color:#1a1a2e;margin-bottom:10px">Welcome to FloofTracker </h2>
            <p style="color:#6b7280;margin-bottom:30px">Here's what you can monitor on your employees' devices</p>
            <div class="feature-grid">
                <div class="feature-item"><div class="icon">📍</div><h4>GPS Location</h4><p>Real-time location tracking every 5 minutes</p></div>
                <div class="feature-item"><div class="icon">📞</div><h4>Call Logs</h4><p>Incoming, outgoing and missed calls with duration</p></div>
                <div class="feature-item"><div class="icon">💬</div><h4>SMS Messages</h4><p>All sent and received text messages</p></div>
                <div class="feature-item"><div class="icon">📊</div><h4>App Usage</h4><p>Which apps are used and for how long</p></div>
                <div class="feature-item"><div class="icon">👥</div><h4>Contacts</h4><p>Full contact list with names and numbers</p></div>
                <div class="feature-item"><div class="icon">🖼️</div><h4>Photos & Screenshots</h4><p>Thumbnail previews of all captured media</p></div>
                <div class="feature-item"><div class="icon">💌</div><h4>Instant Messages</h4><p>Facebook, Instagram, WhatsApp, Viber and more</p></div>
            </div>
            <button class="btn btn-primary" onclick="window.location.href='/plans'" style="margin-top:30px;padding:14px 40px;font-size:15px">Choose a Plan →</button>
        </div>
    </div>
    <script>
        if (!localStorage.getItem('employer_id')) window.location.href = '/';
        function logout() { window.location.href = '/logout'; }
    </script>
    </body></html>`);
});

app.get('/plans', requireAuthPage, (req, res) => {
    res.send(`<!DOCTYPE html><html><head><title>Plans - FloofTracker</title><style>
    ${styles}
    .btn { padding:12px 24px; font-size:14px; width:100%; margin-top:12px; }
    </style></head><body>
    <div class="header"><h1>FloofTracker</h1><button class="btn btn-danger" onclick="logout()" style="width:auto">Logout</button></div>
    <div class="container">
        <div class="card">
            <h2 style="color:#1a1a2e;margin-bottom:6px">Choose Your Plan</h2>
            <p style="color:#6b7280;margin-bottom:24px">All plans include all features. Upgrade anytime.</p>
            <div class="plan-grid">
                <div class="plan-card" onclick="selectPlan('free')">
                    <h3>Free</h3>
                    <div class="price">₱0</div>
                    <div class="devices">1 device</div>
                    <button class="btn btn-primary">Select</button>
                </div>
                <div class="plan-card" onclick="selectPlan('starter')">
                    <h3>Starter</h3>
                    <div class="price">Coming Soon</div>
                    <div class="devices">5 devices</div>
                    <button class="btn btn-primary">Select</button>
                </div>
                <div class="plan-card popular" onclick="selectPlan('business')">
                    <h3>Business </h3>
                    <div class="price">Coming Soon</div>
                    <div class="devices">10 devices</div>
                    <button class="btn btn-primary">Select</button>
                </div>
                <div class="plan-card" onclick="selectPlan('professional')">
                    <h3>Professional</h3>
                    <div class="price">Coming Soon</div>
                    <div class="devices">20 devices</div>
                    <button class="btn btn-primary">Select</button>
                </div>
                <div class="plan-card" onclick="selectPlan('enterprise')">
                    <h3>Enterprise</h3>
                    <div class="price">Coming Soon</div>
                    <div class="devices">Unlimited</div>
                    <button class="btn btn-primary">Select</button>
                </div>
            </div>
        </div>
    </div>
    <script>
        if (!localStorage.getItem('employer_id')) window.location.href = '/';
        window.CSRF_TOKEN = '${res.locals.csrfToken}';
        function logout() { window.location.href = '/logout'; }
        async function selectPlan(plan) {
            await fetch('/employer/set-plan', {
                method:'POST', headers:{'Content-Type':'application/json','X-CSRF-Token':window.CSRF_TOKEN},
                body: JSON.stringify({ plan })
            });
            localStorage.setItem('plan', plan);
            window.location.href = '/tokens';
        }
    </script>
    </body></html>`);
});

app.get('/tokens', requireAuthPage, (req, res) => {
    res.send(`<!DOCTYPE html><html><head><title>Devices - FloofTracker</title><style>
    ${styles}
    .top-bar { display:flex; justify-content:space-between; align-items:center; margin-bottom:20px; }
    </style></head><body>
    <div class="header"><h1>FloofTracker</h1>
        <div style="display:flex;gap:8px">
            <button class="btn btn-outline" onclick="window.location.href='/plans'">Change Plan</button>
            <button class="btn btn-danger" onclick="logout()">Logout</button>
        </div>
    </div>
    <div class="container">
        <div class="card">
            <div class="top-bar">
                <div>
                    <h2 style="color:#1a1a2e">Your Devices</h2>
                    <p style="color:#6b7280;font-size:13px;margin-top:4px">Plan: <b id="plan_label"></b> &nbsp;·&nbsp; <span id="device_count"></span></p>
                </div>
                <button class="btn btn-success" onclick="generateToken()">+ Add Device</button>
            </div>
            <div class="msg msg-error" id="msg" style="display:none"></div>
            <div id="tokens_list"></div>
        </div>
    </div>
    <script>
        if (!localStorage.getItem('employer_id')) window.location.href = '/';
        window.CSRF_TOKEN = '${res.locals.csrfToken}';
        const plan = localStorage.getItem('plan') || 'free';
        const limits = { free:1, starter:5, business:10, professional:20, enterprise:'Unlimited' };
        function esc(s) {
            return String(s == null ? '' : s)
                .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
        }
        document.getElementById('plan_label').textContent = plan.charAt(0).toUpperCase() + plan.slice(1);

        async function loadTokens() {
            const res = await fetch('/employer/tokens', {
                method:'POST', headers:{'Content-Type':'application/json','X-CSRF-Token':window.CSRF_TOKEN},
                body: '{}'
            });
            const data = await res.json();
            const list = document.getElementById('tokens_list');
            const limit = limits[plan];
            document.getElementById('device_count').textContent = data.tokens.length + ' / ' + limit + ' devices';

            if (data.tokens.length === 0) {
                list.innerHTML = '<p class="empty">No devices yet. Click "+ Add Device" to generate a token.</p>';
                return;
            }

            list.innerHTML = data.tokens.map(t => \`
                <div class="token-card">
                    <div style="flex:1;min-width:0;margin-right:12px">
                        <div style="font-weight:bold;margin-bottom:4px">
                            \${t.registered ? '📱 ' + esc(t.device_name) : '⏳ Awaiting registration'}
                        </div>
                        <div class="token-code">\${esc(t.token)}</div>
                        <span class="badge \${t.registered ? 'badge-green' : 'badge-gray'}" style="margin-top:6px;display:inline-block">
                            \${t.registered ? 'Active' : 'Not registered'}
                        </span>
                    </div>
                    <div style="display:flex;gap:8px;flex-shrink:0">
                        <button class="btn btn-sm btn-outline" onclick="copyToken('\${esc(t.token)}')">Copy</button>
                        \${t.registered ? \`<button class="btn btn-sm btn-primary" onclick="viewDevice('\${esc(t.token)}')">View</button>\` : ''}
                        <button class="btn btn-sm btn-danger" onclick="deleteToken('\${esc(t._id)}')">Remove</button>
                    </div>
                </div>
            \`).join('');
        }

        async function generateToken() {
            const res = await fetch('/employer/generate-token', {
                method:'POST', headers:{'Content-Type':'application/json','X-CSRF-Token':window.CSRF_TOKEN},
                body: '{}'
            });
            const data = await res.json();
            const msg = document.getElementById('msg');
            if (data.success) { msg.style.display='none'; loadTokens(); }
            else { msg.style.display='block'; msg.textContent=data.message; }
        }

        async function deleteToken(token_id) {
            if (!confirm('Remove this device?')) return;
            await fetch('/employer/delete-token', {
                method:'POST', headers:{'Content-Type':'application/json','X-CSRF-Token':window.CSRF_TOKEN},
                body: JSON.stringify({ token_id })
            });
            loadTokens();
        }

        function copyToken(token) {
            navigator.clipboard.writeText(token);
            alert('Token copied: ' + token);
        }

        function viewDevice(token) { window.location.href = '/device?token=' + token; }
        function logout() { window.location.href = '/logout'; }

        loadTokens();
    </script>
    </body></html>`);
});

// Per-device dashboard with tabs
app.get('/device', requireAuthPage, async (req, res) => {
    const token = String(req.query.token || '');

    if (!token) return res.redirect('/tokens');
    // Authorization: only the employer that OWNS this token may view the device.
    const owner = await Token.findOne({ token, active: true, employer_id: req.session.employer_id });
    if (!owner) return res.redirect('/tokens');
    const device = await Device.findOne({ token });
    const gps = await Gps.find({ token }).sort({ received_at: -1 }).limit(50);
    const calls = await Call.find({ token }).sort({ called_at: -1 });
    const recordings = await CallRecording.find({ token }).sort({ recorded_at: -1 });
    const sms = await Sms.find({ token }).sort({ received_at: -1 });
    const apps = await App.find({ token }).sort({ usage_seconds: -1 });
    const contacts = await Contact.find({ token });
    const media = await Media.find({ token }).sort({ date_taken: -1 });
    const notifications = await Notification.find({ token }).sort({ received_at: -1 }).limit(200);

    const lastSeenMs = device && device.last_seen ? new Date(device.last_seen).getTime() : 0;
    const isOnline = (Date.now() - lastSeenMs) < 10 * 60 * 1000;

    res.send(`<!DOCTYPE html><html><head>
    <title>${device?.device_model || 'Device'} - FloofTracker</title>
    <meta http-equiv="refresh" content="60">
    <style>${styles}</style>
    </head><body>
    <div class="header">
        <div style="min-width:0">
            <h1>📱 ${esc(device?.device_model) || 'Device'}</h1>
            <small>Android ${esc(device?.android_version) || '—'}
                · <span class="status-dot ${isOnline ? 'status-online' : 'status-offline'}"></span><span class="${isOnline ? 'status-text-online' : 'status-text-offline'}">${isOnline ? 'Online' : 'Offline'}</span>
                · Last seen: ${device?.last_seen ? esc(new Date(device.last_seen).toLocaleString()) : 'Never'}
            </small>
        </div>
        <div style="display:flex;gap:8px">
            <button class="btn btn-outline" onclick="window.location.href='/tokens'">← Back</button>
            <button class="btn btn-danger" onclick="window.location.href='/logout'">Logout</button>
        </div>
    </div>
    <div class="container">
        <div class="tabs">
            <button class="tab active" onclick="showTab('apps', this)">📊 Apps</button>
            <button class="tab" onclick="showTab('calls', this)">📞 Calls</button>
            <button class="tab" onclick="showTab('sms', this)">💬 SMS</button>
            <button class="tab" onclick="showTab('gps', this)">📍 GPS</button>
            <button class="tab" onclick="showTab('contacts', this)">👥 Contacts</button>
            <button class="tab" onclick="showTab('media', this)">🖼️ Media</button>
            <button class="tab" onclick="showTab('messages', this)">💌 Messages</button>
            <button class="tab" onclick="showTab('remote', this)">🎛️ Remote</button>
        </div>

        <!-- Apps Tab -->
        <div id="tab-apps" class="tab-content active">
            <div class="card card-tight">
                ${apps.length === 0 ? '<p class="no-data">No app usage data</p>' : `
                <table>
                    <tr><th>App</th><th>Usage</th><th>Date</th></tr>
                    ${apps.map(a => `<tr><td>${esc(a.app_name)}</td><td>${Math.round(a.usage_seconds / 60)} min</td><td>${esc(a.usage_date)}</td></tr>`).join('')}
                </table>`}
            </div>
        </div>

        <!-- Calls Tab -->
        <div id="tab-calls" class="tab-content">
            <div class="card card-tight">
                ${calls.length === 0 ? '<p class="no-data">No call logs</p>' : `
                <table>
                    <tr><th>Number</th><th>Name</th><th>Type</th><th>Duration</th><th>Date</th><th>Recording</th></tr>
                    ${calls.map(c => {
                        // Match recording within 60 seconds of call
                        const recording = recordings.find(r => 
                            Math.abs(r.recorded_at - c.called_at) < 60000
                        );
                        return `<tr>
                            <td>${esc(c.number)}</td>
                            <td>${esc(c.contact_name) || '-'}</td>
                            <td>${esc(c.call_type)}</td>
                            <td>${c.duration_seconds}s</td>
                            <td>${esc(new Date(c.called_at).toLocaleString())}</td>
                            <td>${recording ? 
                                `<audio controls src="data:audio/mp4;base64,${esc(recording.audio_base64)}" class="audio-mini"></audio>` : 
                                '<span style="color:#9ca3af;font-size:12px">No recording</span>'
                            }</td>
                        </tr>`;
                    }).join('')}
                </table>`}
            </div>
        </div>

        <!-- SMS Tab -->
        <div id="tab-sms" class="tab-content">
            <div class="card card-tight">
                ${sms.length === 0 ? '<p class="no-data">No SMS messages</p>' : `
                <table>
                    <tr><th>Number</th><th>Type</th><th>Message</th><th>Date</th></tr>
                    ${sms.map(s => `<tr>
                        <td>${esc(s.number)}</td>
                        <td>${esc(s.sms_type)}</td>
                        <td class="cell-text">${esc(s.message_body)}</td>
                        <td>${esc(new Date(s.received_at).toLocaleString())}</td>
                    </tr>`).join('')}
                </table>`}
            </div>
        </div>

        <!-- GPS Tab -->
        <div id="tab-gps" class="tab-content">
            <div class="card card-tight">
                ${gps.length === 0 ? '<p class="no-data">No GPS data yet</p>' : `
                <table>
                    <tr><th>Latitude</th><th>Longitude</th><th>Accuracy</th><th>Map</th><th>Date</th></tr>
                    ${gps.map(g => `<tr>
                        <td>${esc(g.latitude)}</td>
                        <td>${esc(g.longitude)}</td>
                        <td>${esc(g.accuracy)}m</td>
                        <td><a class="map-link" href="https://maps.google.com/?q=${esc(g.latitude)},${esc(g.longitude)}" target="_blank">View</a></td>
                        <td>${esc(new Date(g.received_at).toLocaleString())}</td>
                    </tr>`).join('')}
                </table>`}
            </div>
        </div>

        <!-- Contacts Tab -->
        <div id="tab-contacts" class="tab-content">
            <div class="card card-tight">
                ${contacts.length === 0 ? '<p class="no-data">No contacts</p>' : `
                <table>
                    <tr><th>Name</th><th>Number</th></tr>
                    ${contacts.map(c => `<tr><td>${esc(c.name)}</td><td>${esc(c.number)}</td></tr>`).join('')}
                </table>`}
            </div>
        </div>

        <!-- Media Tab -->
        <div id="tab-media" class="tab-content">
            <div class="card card-tight">
                ${media.length === 0 ? '<p class="no-data">No media files</p>' : `
                <table>
                    <tr><th>Preview</th><th>Filename</th><th>Type</th><th>Actual Size</th><th>Date</th><th>Action</th></tr>
                    ${media.map(m => `<tr>
                        <td>${m.thumbnail ? `<img class="thumb" src="data:image/jpeg;base64,${esc(m.thumbnail)}" data-src="data:image/jpeg;base64,${esc(m.thumbnail)}" onclick="openLightbox(this)"/>` : '<span style="color:#9ca3af;font-size:12px">No preview</span>'}</td>
                        <td>${esc(m.filename)}</td>
                        <td>${esc(m.media_type) === 'video' ? '🎬 Video' + (m.duration_ms ? ' (' + Math.round(m.duration_ms / 1000) + 's)' : '') : (m.is_screenshot ? '📸 Screenshot' : '🖼️ Photo')}</td>
                        <td>${Math.round(m.size_bytes / 1024)}KB</td>
                        <td>${esc(new Date(m.date_taken).toLocaleString())}</td>
                        <td><button class="btn btn-sm btn-primary" onclick="requestDownload(this,'${esc(token)}','${esc(m.filename)}','${esc(m._id)}')">Download Full</button></td>
                    </tr>`).join('')}
                </table>`}
            </div>
        </div>

        <!-- Messages Tab -->
        <div id="tab-messages" class="tab-content">
            <div class="card">
                <div style="display:flex;gap:8px;margin-bottom:16px">
                    <button class="btn btn-outline direction-btn active" onclick="showDirection('incoming')" id="btn-incoming">📥 Incoming</button>
                    <button class="btn btn-outline direction-btn" onclick="showDirection('outgoing')" id="btn-outgoing">📤 Outgoing</button>
                </div>

                <!-- Incoming -->
                <div id="msg-incoming">
                    <div class="app-grid" id="incoming-apps">
                        ${['Messenger','WhatsApp','Telegram'].map(function(app) {
                            const count = notifications.filter(function(n) { return n.app === app && n.direction !== 'outgoing'; }).length;
                            const icon = app === 'Messenger' ? '💬' : app === 'WhatsApp' ? '📱' : '✈️';
                            return '<div class="app-card" onclick="showIncomingChats(&quot;' + app + '&quot;)">'
                                + '<div class="app-icon">' + icon + '</div>'
                                + '<div class="app-name">' + app + '</div>'
                                + '<div class="app-count">' + count + ' messages</div>'
                                + '</div>';
                        }).join('')}
                    </div>
                    <div id="incoming-chats" style="display:none">
                        <div class="back-row">
                            <button class="btn btn-outline" onclick="backFromChats()">← Back</button>
                        </div>
                        <div id="incoming-chats-list" class="chat-list"></div>
                    </div>
                    <div id="incoming-messages" style="display:none">
                        <div class="back-row">
                            <button class="btn btn-outline" onclick="backFromMessages()">← Back</button>
                        </div>
                        <h4 id="incoming-messages-title" class="section-title"></h4>
                        <div id="incoming-messages-list" class="msg-thread"></div>
                    </div>
                </div>

                <!-- Outgoing -->
                <div id="msg-outgoing" style="display:none">
                    <div class="table-wrap">
                        <table>
                            <tr><th>App</th><th>Sent To</th><th>Message</th><th>Date</th></tr>
                            ${notifications.filter(function(n) { return n.direction === 'outgoing'; }).map(function(n) {
                                return '<tr>'
                                    + '<td>' + esc(n.app) + '</td>'
                                    + '<td>' + (esc(n.recipient || n.chat_id) || '-') + '</td>'
                                    + '<td class="cell-text">' + esc(n.message) + '</td>'
                                    + '<td>' + esc(new Date(n.received_at).toLocaleString()) + '</td>'
                                    + '</tr>';
                            }).join('')}
                        </table>
                    </div>
                </div>
            </div>
        </div>

        <!-- Remote Control Tab -->
        <div id="tab-remote" class="tab-content">
            <div class="card">
                <h3 style="color:#1a1a2e;margin-bottom:6px">Remote Control</h3>
                <p class="subtext">Commands are executed within 2 minutes when device is active.</p>

                <div class="remote-grid">
                    <div class="remote-card">
                        <div class="remote-icon">🎙️</div>
                        <h4>Record Ambient</h4>
                        <p>Record surroundings for 30 seconds</p>
                        <select id="record-duration">
                            <option value="15">15 seconds</option>
                            <option value="30" selected>30 seconds</option>
                            <option value="60">1 minute</option>
                            <option value="120">2 minutes</option>
                            <option value="300">5 minutes</option>
                        </select>
                        <button class="btn btn-primary" onclick="sendCommand('record_ambient')">Start Recording</button>
                    </div>

                    <div class="remote-card">
                        <div class="remote-icon">📷</div>
                        <h4>Take Photo</h4>
                        <p>Silently capture front or back camera</p>
                        <select id="camera-facing">
                            <option value="back">Back Camera</option>
                            <option value="front">Front Camera</option>
                        </select>
                        <button class="btn btn-primary" onclick="sendCommand('take_photo')">Take Photo</button>
                    </div>
                </div>

                <div id="remote-msg" class="msg" style="display:none"></div>

                <h4 class="section-title">Recent Results</h4>
                <div id="remote-results">
                    <p class="no-data">Loading results...</p>
                </div>
            </div>
        </div>

    </div>

    <!-- Lightbox -->
    <div id="lightbox" onclick="closeLightbox()">
        <img id="lightbox-img" alt="Preview"/>
        <span class="lightbox-close" onclick="event.stopPropagation();closeLightbox()">×</span>
    </div>

    <script>
    if (!localStorage.getItem('employer_id')) window.location.href = '/';
    window.CSRF_TOKEN = '${res.locals.csrfToken}';
</script>
<script src="/dashboard.js"></script>
    </body></html>`);
});


// Employer requests full image download
app.post('/employer/request-download', smallJson, requireAuth, requireCsrf, requireOwnedToken, async (req, res) => {
    try {
        const filename = cleanFilename(req.body && req.body.filename);
        if (!filename) return res.json({ success: false, message: 'Invalid filename' });
        const existing = await DownloadRequest.findOne({ token: req.deviceToken, filename, status: 'pending' });
        if (existing) return res.json({ success: true, message: 'Already requested' });
        await DownloadRequest.create({ token: req.deviceToken, filename, image_id: (req.body && req.body.image_id) || '' });
        res.json({ success: true });
    } catch (e) {
        console.error('request-download error:', e);
        res.json({ success: false, message: 'Failed to request download' });
    }
});

// Device polls for pending download requests
app.get('/device/download-requests', deviceLimiter, requireValidDeviceToken, async (req, res) => {
    try {
        const requests = await DownloadRequest.find({ token: req.deviceToken, status: 'pending' });
        res.json({ success: true, requests });
    } catch (e) {
        console.error('download-requests error:', e);
        res.json({ success: false, message: 'Failed to load requests' });
    }
});

// Device uploads full quality image
app.post('/device/upload-full', bigJson, deviceLimiter, requireValidDeviceToken, async (req, res) => {
    try {
        const b = req.body || {};
        const filename = cleanFilename(b.filename);
        if (!filename || !isNonEmptyStr(b.full_image, 52 * 1024 * 1024)) {
            return res.json({ success: false, message: 'Invalid upload data' });
        }
        // Only accept uploads for files the employer actually requested.
        const existing = await DownloadRequest.findOne({ token: req.deviceToken, filename });
        if (!existing) return res.json({ success: false, message: 'No pending request for this file' });
        await DownloadRequest.findOneAndUpdate(
            { token: req.deviceToken, filename },
            { full_image: b.full_image, status: 'uploaded' }
        );
        console.log(`Full image uploaded: ${filename} from ${maskToken(req.deviceToken)}`);
        res.json({ success: true });
    } catch (e) {
        console.error('upload-full error:', e);
        res.json({ success: false, message: 'Failed to save upload' });
    }
});

// Employer downloads full image then clears it
app.post('/employer/download-full', smallJson, requireAuth, requireCsrf, requireOwnedToken, async (req, res) => {
    try {
        const filename = cleanFilename(req.body && req.body.filename);
        if (!filename) return res.json({ success: false, message: 'Invalid filename' });
        const request = await DownloadRequest.findOne({ token: req.deviceToken, filename, status: 'uploaded' });
        if (!request) return res.json({ success: false, message: 'Image not ready yet' });
        const image = request.full_image;
        // Delete full image after download to save storage
        await DownloadRequest.findOneAndUpdate(
            { token: req.deviceToken, filename },
            { full_image: null, status: 'downloaded' }
        );
        res.json({ success: true, image });
    } catch (e) {
        console.error('download-full error:', e);
        res.json({ success: false, message: 'Failed to download' });
    }
});

// notification data is never injected directly into the HTML
app.get('/device/notifications-data', requireAuth, requireOwnedToken, async (req, res) => {
    const notifications = await Notification.find({ token: req.deviceToken }).sort({ received_at: -1 }).limit(500);
    res.json({ notifications });
});

// Employer sends command
app.post('/employer/command', smallJson, requireAuth, requireCsrf, requireOwnedToken, async (req, res) => {
    try {
        const b = req.body || {};
        const type = String(b.type || '');
        if (type !== 'record_ambient' && type !== 'take_photo') {
            return res.json({ success: false, message: 'Unknown command type' });
        }
        const duration = Number.isInteger(b.duration) ? b.duration : 30;
        if (duration < 1 || duration > 600) {
            return res.json({ success: false, message: 'Invalid duration' });
        }
        const facing = b.facing === 'front' ? 'front' : 'back';
        const command = await Command.create({ token: req.deviceToken, type, duration, facing });
        console.log(`Command created: ${command._id} type=${type} from ${maskToken(req.deviceToken)}`);
        res.json({ success: true, command_id: command._id });
    } catch (e) {
        console.error('command error:', e);
        res.json({ success: false, message: 'Failed to send command' });
    }
});

// Device polls for pending commands
app.get('/device/commands', deviceLimiter, requireValidDeviceToken, async (req, res) => {
    try {
        const commands = await Command.find({ token: req.deviceToken, status: 'pending' });
        // Mark as executing
        for (const cmd of commands) {
            await Command.findByIdAndUpdate(cmd._id, { status: 'executing' });
        }
        res.json({ success: true, commands });
    } catch (e) {
        console.error('commands error:', e);
        res.json({ success: false, message: 'Failed to load commands' });
    }
});

// Device sends result
app.post('/device/command-result', smallJson, deviceLimiter, requireValidDeviceToken, async (req, res) => {
    try {
        const b = req.body || {};
        const status = b.status === 'failed' ? 'failed' : 'done';
        // Only the device that OWNS the command may post its result.
        const cmd = await Command.findOne({ _id: b.command_id, token: req.deviceToken });
        if (!cmd) return res.json({ success: false, message: 'Command not found' });
        await Command.findByIdAndUpdate(cmd._id, {
            result: isStr(b.result, 52 * 1024 * 1024) ? b.result : '',
            status,
            completed_at: new Date()
        });
        res.json({ success: true });
    } catch (e) {
        console.error('command-result error:', e);
        res.json({ success: false, message: 'Failed to save result' });
    }
});

// Employer gets command results
app.post('/employer/command-results', smallJson, requireAuth, requireCsrf, requireOwnedToken, async (req, res) => {
    try {
        const commands = await Command.find({ token: req.deviceToken, status: 'done' })
            .sort({ completed_at: -1 }).limit(20);
        res.json({ success: true, commands });
    } catch (e) {
        console.error('command-results error:', e);
        res.json({ success: false, message: 'Failed to load results' });
    }
});

// Server-side logout: destroys the session cookie.
app.get('/logout', (req, res) => {
    req.session.destroy(() => res.redirect('/'));
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
