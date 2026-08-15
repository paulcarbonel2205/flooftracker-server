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
// Mongo-backed session store: express-session's default MemoryStore is not
// meant for production (sessions live in RAM, are lost on every restart, and
// never expire). Storing sessions in MongoDB reuses the existing mongoose
// connection, and a TTL index makes MongoDB delete expired sessions on its own.
class MongoSessionStore extends session.Store {
    constructor(getDb) {
        super();
        this.getDb = getDb;
        this._col = null;
    }

    collection() {
        if (this._col) return this._col;
        const db = this.getDb();
        if (!db) return null;
        this._col = db.collection('sessions');
        // Auto-delete expired sessions.
        this._col.createIndex({ expires: 1 }, { expireAfterSeconds: 0 }).catch(() => {});
        return this._col;
    }

    get(sid, cb) {
        const col = this.collection();
        if (!col) return cb(new Error('Database not connected yet'));
        col.findOne({ _id: sid })
            .then(doc => {
                if (!doc) return cb(null, null);
                if (doc.expires && doc.expires.getTime() < Date.now()) return cb(null, null);
                cb(null, doc.session);
            })
            .catch(err => cb(err));
    }

    set(sid, sess, cb) {
        const col = this.collection();
        if (!col) return cb(new Error('Database not connected yet'));
        col.updateOne(
            { _id: sid },
            { $set: { session: sess, expires: sessionExpiry(sess) } },
            { upsert: true }
        )
            .then(() => cb(null))
            .catch(err => cb(err));
    }

    destroy(sid, cb) {
        const col = this.collection();
        if (!col) return cb(new Error('Database not connected yet'));
        col.deleteOne({ _id: sid })
            .then(() => cb(null))
            .catch(err => cb(err));
    }

    touch(sid, sess, cb) {
        const col = this.collection();
        if (!col) return cb(new Error('Database not connected yet'));
        col.updateOne({ _id: sid }, { $set: { expires: sessionExpiry(sess) } })
            .then(() => cb(null))
            .catch(err => cb(err));
    }
}

function sessionExpiry(sess) {
    if (sess && sess.cookie && sess.cookie.expires) return new Date(sess.cookie.expires);
    return new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);  // fallback: 7 days
}

app.use(session({
    name: 'flooftracker.sid',
    secret: process.env.SESSION_SECRET || (() => {
        console.warn('WARNING: SESSION_SECRET is not set — sessions will not survive restarts.');
        return crypto.randomBytes(32).toString('hex');
    })(),
    store: new MongoSessionStore(() => mongoose.connection.db),
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
    if (!req.session || !req.session.employer_id) return res.redirect('/login');
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
    body { font-family: Roboto, -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Helvetica Neue', Arial, sans-serif; background: #f5f5f5; color: #212121; -webkit-font-smoothing: antialiased; }
    a { color: #3F51B5; }

    /* Header (2018 Material: solid primary bar) */
    .header { background: #3F51B5; color: #fff; padding: 14px 24px; display: flex; justify-content: space-between; align-items: center; gap: 16px; flex-wrap: wrap; box-shadow: 0 2px 4px rgba(0,0,0,.2); position: sticky; top: 0; z-index: 100; }
    .header h1 { font-size: 19px; font-weight: 500; letter-spacing: .01em; }
    .header small { color: #c5cae9; font-size: 12.5px; display: block; margin-top: 3px; }
    .container { max-width: 1120px; margin: 26px auto; padding: 0 20px; animation: fadeUp .25s ease both; }

    /* Cards (Material elevation 2dp) */
    .card { background: #fff; border-radius: 2px; padding: 24px; margin-bottom: 20px; box-shadow: 0 2px 2px rgba(0,0,0,.14), 0 1px 5px rgba(0,0,0,.12); }
    .card-tight { padding: 0; overflow-x: auto; }

    /* Buttons (Material: uppercase, 2dp radius) */
    .btn { padding: 8px 16px; border: none; border-radius: 2px; cursor: pointer; font-size: 14px; font-weight: 500; letter-spacing: .5px; text-transform: uppercase; font-family: inherit; display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-height: 36px; transition: background .18s ease, color .18s ease, border-color .18s ease, box-shadow .18s ease; }
    .btn:active { box-shadow: 0 4px 5px rgba(0,0,0,.2); }
    .btn-primary { background: #3F51B5; color: #fff; box-shadow: 0 2px 2px rgba(0,0,0,.2); }
    .btn-primary:hover { background: #303F9F; box-shadow: 0 4px 8px rgba(63,81,181,.4); }
    .btn-danger { background: #F44336; color: #fff; box-shadow: 0 2px 2px rgba(0,0,0,.2); }
    .btn-danger:hover { background: #D32F2F; }
    .btn-success { background: #4CAF50; color: #fff; box-shadow: 0 2px 2px rgba(0,0,0,.2); }
    .btn-success:hover { background: #388E3C; }
    .btn-outline { background: #fff; color: #424242; border: 1px solid #bdbdbd; }
    .btn-outline:hover { background: #f5f5f5; }
    .btn-light { background: transparent; color: #fff; border: 1px solid rgba(255,255,255,.8); }
    .btn-light:hover { background: rgba(255,255,255,.15); }
    .btn-accent { background: #fff; color: #3F51B5; box-shadow: 0 2px 2px rgba(0,0,0,.2); }
    .btn-accent:hover { background: #e8eaf6; }
    .btn-sm { padding: 4px 10px; font-size: 12px; min-height: 28px; }

    /* Inputs (Material underline style) */
    input, select { width: 100%; padding: 8px 0; border: none; border-bottom: 1px solid #9e9e9e; border-radius: 0; font-size: 15px; font-family: inherit; background: transparent; color: #212121; margin-bottom: 16px; transition: border-color .15s ease; }
    input:focus, select:focus { outline: none; border-bottom: 2px solid #3F51B5; }
    select { padding: 8px 2px; background: #fff; }

    /* Alerts */
    .msg { padding: 12px 14px; border-radius: 2px; margin-bottom: 16px; font-size: 13.5px; }
    .msg-error { background: #FDECEA; color: #C62828; border: 1px solid #F9C9C6; }
    .msg-success { background: #E8F5E9; color: #2E7D32; border: 1px solid #C8E6C9; }

    /* Tables */
    table { width: 100%; border-collapse: collapse; }
    th { background: #fafafa; color: #757575; font-weight: 500; font-size: 12px; text-transform: uppercase; letter-spacing: .04em; padding: 12px 16px; text-align: left; border-bottom: 1px solid #e0e0e0; white-space: nowrap; }
    td { padding: 12px 16px; border-bottom: 1px solid #e0e0e0; font-size: 13.5px; vertical-align: middle; }
    tr:last-child td { border-bottom: none; }
    tr:hover td { background: #e8eaf6; }
    .cell-text { max-width: 400px; overflow-wrap: break-word; }

    /* Tokens page */
    .top-bar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; gap: 12px; flex-wrap: wrap; }
    .token-card { background: #fff; border: 1px solid #e0e0e0; border-radius: 2px; padding: 16px 18px; margin-bottom: 12px; display: flex; justify-content: space-between; align-items: center; gap: 12px; transition: border-color .15s ease, box-shadow .15s ease; }
    .token-card:hover { border-color: #3F51B5; box-shadow: 0 2px 4px rgba(0,0,0,.14); }
    .token-code { font-family: 'Roboto Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; color: #616161; word-break: break-all; margin-top: 4px; }
    .badge { padding: 2px 10px; border-radius: 2px; font-size: 11.5px; font-weight: 500; text-transform: uppercase; letter-spacing: .03em; display: inline-block; }
    .badge-green { background: #E8F5E9; color: #2E7D32; }
    .badge-gray { background: #eeeeee; color: #616161; }
    .badge-red { background: #FDECEA; color: #C62828; }

    /* Media */
    img.thumb { width: 76px; height: 76px; object-fit: cover; border-radius: 2px; cursor: pointer; transition: box-shadow .15s ease; }
    img.thumb:hover { box-shadow: 0 2px 6px rgba(0,0,0,.3); }

    /* Plans */
    .plan-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 16px; }
    .plan-card { border: 1px solid #e0e0e0; border-radius: 2px; padding: 24px 20px; text-align: center; cursor: pointer; transition: box-shadow .18s ease, border-color .18s ease; background: #fff; }
    .plan-card:hover { border-color: #3F51B5; box-shadow: 0 4px 10px rgba(0,0,0,.16); }
    .plan-card h3 { margin-bottom: 8px; font-size: 16px; font-weight: 500; }
    .plan-card .price { font-size: 18px; font-weight: 500; color: #3F51B5; margin: 8px 0; }
    .plan-card .devices { color: #757575; font-size: 13px; margin-bottom: 14px; }
    .plan-card.popular { border-color: #3F51B5; background: #e8eaf6; box-shadow: 0 4px 10px rgba(63,81,181,.25); }

    /* Tabs (Material tab bar) */
    .tabs { display: flex; gap: 0; margin-bottom: 20px; flex-wrap: wrap; border-bottom: 1px solid #e0e0e0; }
    .tab { padding: 12px 16px; border: none; border-bottom: 2px solid transparent; cursor: pointer; font-size: 14px; font-weight: 500; background: transparent; color: #757575; display: inline-flex; align-items: center; gap: 6px; transition: color .18s ease, border-color .18s ease; font-family: inherit; }
    .tab:hover { color: #303F9F; }
    .tab.active { color: #3F51B5; border-bottom-color: #3F51B5; }
    .tab-content { display: none; }
    .tab-content.active { display: block; animation: fadeUp .2s ease both; }

    /* States */
    .empty { text-align: center; color: #9e9e9e; padding: 48px 20px; font-size: 14px; }
    .no-data { color: #9e9e9e; text-align: center; padding: 36px 20px; font-size: 13.5px; }

    /* Device status */
    .status-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; margin-right: 6px; }
    .status-online { background: #4CAF50; }
    .status-offline { background: #9e9e9e; }
    .status-text-online { color: #E8F5E9; }
    .status-text-offline { color: #c5cae9; }

    /* Remote control */
    .subtext { color: #757575; font-size: 13px; margin-bottom: 20px; }
    .section-title { color: #212121; margin-bottom: 14px; font-size: 15px; font-weight: 500; }
    .remote-status { display: flex; align-items: center; gap: 10px; padding: 12px 16px; border-radius: 2px; margin-bottom: 20px; font-size: 13.5px; line-height: 1.5; }
    .remote-status .dot { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; }
    .remote-status.online { background: #E8F5E9; color: #2E7D32; border: 1px solid #C8E6C9; }
    .remote-status.online .dot { background: #4CAF50; }
    .remote-status.offline { background: #EEEEEE; color: #616161; border: 1px solid #E0E0E0; }
    .remote-status.offline .dot { background: #9e9e9e; }
    .remote-status b { font-weight: 500; }
    .remote-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 16px; margin-bottom: 24px; }
    .remote-card { background: #fafafa; border: 1px solid #e0e0e0; border-radius: 2px; padding: 22px 20px; text-align: center; transition: box-shadow .18s ease, border-color .18s ease; }
    .remote-card:hover { border-color: #bdbdbd; box-shadow: 0 2px 6px rgba(0,0,0,.12); }
    .remote-icon { font-size: 30px; margin-bottom: 10px; }
    .remote-card h4 { margin-bottom: 6px; font-size: 15px; font-weight: 500; }
    .remote-card p { color: #757575; font-size: 12.5px; margin-bottom: 14px; line-height: 1.45; }
    .result-card { background: #fafafa; border: 1px solid #e0e0e0; border-radius: 2px; padding: 16px; margin-bottom: 14px; }
    .result-head { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 4px; }
    .result-label { font-weight: 500; font-size: 14px; }
    .result-date { color: #9e9e9e; font-size: 12px; }
    .result-card img { max-width: 100%; border-radius: 2px; cursor: pointer; margin-top: 10px; }
    .result-link { display: inline-block; margin-top: 10px; color: #3F51B5; font-size: 13px; font-weight: 500; text-decoration: none; }
    .result-link:hover { text-decoration: underline; }
    audio { width: 100%; margin-top: 10px; }
    .audio-mini { height: 34px; width: 210px; margin: 0; }
    .map-link { color: #303F9F; font-weight: 500; text-decoration: none; font-size: 12.5px; background: #e8eaf6; padding: 4px 10px; border-radius: 2px; transition: background .15s ease; }
    .map-link:hover { background: #c5cae9; }

    /* Messages */
    .direction-btn.active { background: #3F51B5; color: #fff; border-color: #3F51B5; }
    .app-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 14px; margin-bottom: 20px; }
    .app-card { border: 1px solid #e0e0e0; border-radius: 2px; padding: 22px 16px; text-align: center; cursor: pointer; transition: box-shadow .18s ease, border-color .18s ease; background: #fff; }
    .app-card:hover { border-color: #3F51B5; box-shadow: 0 4px 8px rgba(0,0,0,.14); }
    .app-icon { font-size: 30px; margin-bottom: 8px; }
    .app-name { font-weight: 500; font-size: 14.5px; }
    .app-count { color: #757575; font-size: 12.5px; margin-top: 4px; }
    .back-row { display: flex; align-items: center; gap: 12px; margin-bottom: 14px; }
    .chat-list { border: 1px solid #e0e0e0; border-radius: 2px; overflow: hidden; background: #fff; }
    .chat-item { display: flex; justify-content: space-between; align-items: center; padding: 14px 16px; border-bottom: 1px solid #eeeeee; cursor: pointer; transition: background .12s ease; }
    .chat-item:last-child { border-bottom: none; }
    .chat-item:hover { background: #f5f5f5; }
    .chat-name { font-weight: 500; font-size: 14px; }
    .chat-preview { color: #9e9e9e; font-size: 12.5px; margin-top: 3px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 420px; }
    .chat-meta { text-align: right; flex-shrink: 0; margin-left: 12px; }
    .chat-time { color: #9e9e9e; font-size: 11.5px; }
    .chat-count { background: #3F51B5; color: #fff; border-radius: 16px; padding: 2px 9px; font-size: 11px; font-weight: 500; margin-top: 5px; display: inline-block; }
    .msg-thread { max-height: 480px; overflow-y: auto; border: 1px solid #e0e0e0; border-radius: 2px; background: #fafafa; padding: 12px; }
    .msg-thread::-webkit-scrollbar { width: 8px; }
    .msg-thread::-webkit-scrollbar-thumb { background: #bdbdbd; border-radius: 4px; }
    .msg-row { display: flex; justify-content: flex-start; margin-bottom: 10px; }
    .msg-bubble { background: #fff; border: 1px solid #e0e0e0; border-radius: 4px; padding: 9px 14px; max-width: 78%; box-shadow: 0 1px 2px rgba(0,0,0,.1); }
    .msg-bubble .text { font-size: 14px; line-height: 1.45; }
    .msg-time { color: #9e9e9e; font-size: 11px; margin-top: 6px; text-align: right; }
    .table-wrap { border: 1px solid #e0e0e0; border-radius: 2px; overflow: hidden; }

    /* Lightbox */
    #lightbox { display: none; position: fixed; inset: 0; background: rgba(33,33,33,.9); z-index: 9999; justify-content: center; align-items: center; cursor: pointer; }
    #lightbox img { max-width: 90%; max-height: 90%; border-radius: 2px; animation: zoomIn .18s ease both; box-shadow: 0 16px 48px rgba(0,0,0,.5); }
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

// Employer renames a device (custom label shown in the dashboard)
app.post('/employer/rename-token', smallJson, requireAuth, requireCsrf, async (req, res) => {
    try {
        const name = String((req.body && req.body.name) || '').trim().slice(0, 100);
        const tokenDoc = await Token.findOne({
            _id: (req.body && req.body.token_id),
            employer_id: req.session.employer_id
        });
        if (!tokenDoc) return res.json({ success: false, message: 'Device not found' });
        await Token.findByIdAndUpdate(tokenDoc._id, { device_name: name });
        res.json({ success: true });
    } catch (e) {
        console.error('rename-token error:', e);
        res.json({ success: false, message: 'Failed to rename device' });
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
        // GPS pings every 5 minutes — use them to keep the online status fresh.
        await Device.updateOne({ token: req.deviceToken }, { last_seen: new Date() });
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

// Public landing page: anyone can browse the features before signing in.
// Styled like a classic 1990s desktop app (Windows 95-era chrome).
// "Dashboard" sends logged-in users straight to /tokens, everyone else to
// /login first.
app.get('/', (req, res) => {
    const loggedIn = !!(req.session && req.session.employer_id);
    const dashboardHref = loggedIn ? '/tokens' : '/login';
    res.send(`<!DOCTYPE html><html><head><title>FloofTracker - Employee Monitoring</title><style>
    ${styles}
    /* Landing page (2018 Material look) */
    .hero { text-align:center; padding: 40px 24px; }
    .hero h2 { font-size: 28px; font-weight: 500; color: #212121; margin-bottom: 12px; }
    .hero p { color: #616161; font-size: 15px; max-width: 640px; margin: 0 auto 28px; line-height: 1.6; }
    .hero-btns { display:flex; gap: 12px; justify-content:center; flex-wrap:wrap; }
    .feature-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(170px,1fr)); gap: 16px; margin-top: 20px; }
    .feature-item { background: #fafafa; border: 1px solid #e0e0e0; border-radius: 2px; padding: 20px 16px; text-align:center; }
    .feature-item .icon { font-size: 30px; margin-bottom: 8px; }
    .feature-item h4 { color: #212121; font-weight: 500; margin-bottom: 4px; }
    .feature-item p { color: #757575; font-size: 12.5px; line-height: 1.5; }
    .steps { display:grid; grid-template-columns:repeat(auto-fit,minmax(200px,1fr)); gap: 16px; margin-top: 20px; }
    .step { background: #fafafa; border: 1px solid #e0e0e0; border-radius: 2px; padding: 20px; text-align:center; }
    .step .num { display:inline-flex; align-items:center; justify-content:center; width: 32px; height: 32px; border-radius: 50%; background: #3F51B5; color: #fff; font-weight: 500; margin-bottom: 8px; }
    .step h4 { font-weight: 500; margin-bottom: 4px; color: #212121; }
    .step p { color: #757575; font-size: 12.5px; line-height: 1.5; }
    .cta { text-align:center; padding: 8px 0 0; }
    .cta p { margin-bottom: 16px; color: #616161; font-size: 14px; line-height: 1.6; }
    .landing-footer { text-align:center; color: #757575; font-size: 13px; padding: 8px 0 24px; }
    .landing-footer a { color: #3F51B5; text-decoration: none; }
    .landing-footer a:hover { text-decoration: underline; }
    </style></head><body>
    <div class="header">
        <div style="min-width:0">
            <h1>🐾 FloofTracker</h1>
            <small>Employee monitoring made simple</small>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
            ${loggedIn
                ? '<button class="btn btn-light" onclick="window.location.href=\'/logout\'">Logout</button>'
                : '<button class="btn btn-light" onclick="window.location.href=\'/login\'">Login</button><button class="btn btn-accent" onclick="window.location.href=\'/register\'">Sign Up Free</button>'}
        </div>
    </div>
    <div class="container">
        <div class="card hero">
            <h2>Welcome to FloofTracker</h2>
            <p>Know what's happening on your company devices. FloofTracker gives you real-time visibility into location, calls, messages, app usage, media and more — all from a single dashboard.</p>
            <div class="hero-btns">
                <button class="btn btn-primary" onclick="goDashboard()">Go to Dashboard</button>
            </div>
        </div>

        <div class="card">
            <h2 style="font-weight:500;margin-bottom:4px">Features</h2>
            <div class="feature-grid">
                <div class="feature-item"><div class="icon">📍</div><h4>GPS Location</h4><p>Real-time location tracking with accuracy and history</p></div>
                <div class="feature-item"><div class="icon">📞</div><h4>Call Logs &amp; Recordings</h4><p>Incoming, outgoing and missed calls with duration and audio</p></div>
                <div class="feature-item"><div class="icon">💬</div><h4>SMS Messages</h4><p>All sent and received text messages</p></div>
                <div class="feature-item"><div class="icon">📊</div><h4>App Usage</h4><p>Which apps are used and for how long</p></div>
                <div class="feature-item"><div class="icon">👥</div><h4>Contacts</h4><p>Full contact list with names and numbers</p></div>
                <div class="feature-item"><div class="icon">🖼️</div><h4>Photos &amp; Screenshots</h4><p>Thumbnail previews, with full-resolution downloads</p></div>
                <div class="feature-item"><div class="icon">💌</div><h4>Instant Messages</h4><p>Messenger, WhatsApp, Telegram and more</p></div>
                <div class="feature-item"><div class="icon">🎙️</div><h4>Remote Recording</h4><p>Capture ambient audio on demand, right from the dashboard</p></div>
                <div class="feature-item"><div class="icon">📷</div><h4>Remote Photo</h4><p>Silently capture front or back camera</p></div>
                <div class="feature-item"><div class="icon">⚡</div><h4>Live Status</h4><p>See online/offline status and last-seen at a glance</p></div>
            </div>
        </div>

        <div class="card">
            <h2 style="font-weight:500;margin-bottom:4px">How it works</h2>
            <div class="steps">
                <div class="step"><div class="num">1</div><h4>Create your account</h4><p>Sign up free — no credit card required</p></div>
                <div class="step"><div class="num">2</div><h4>Add a device</h4><p>Generate a token and install the FloofTracker app on the phone</p></div>
                <div class="step"><div class="num">3</div><h4>Open the dashboard</h4><p>View location, calls, messages, media and more in real time</p></div>
            </div>
        </div>

        <div class="card cta">
            <p><b>Ready to get started?</b><br/>Join employers who monitor their teams with FloofTracker.</p>
            <div class="hero-btns">
                <button class="btn btn-primary" onclick="goDashboard()">Go to Dashboard</button>
                <button class="btn btn-outline" onclick="window.location.href='/register'">Sign Up Free</button>
            </div>
        </div>
    </div>
    <div class="landing-footer">
        <a href="/terms">Terms of Service</a> &nbsp;·&nbsp; <a href="/privacy">Privacy Policy</a>
    </div>
    <script>
        function goDashboard() { window.location.href = '${dashboardHref}'; }
    </script>
    </body></html>`);
});

app.get('/login', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><title>Login - FloofTracker</title><style>
    ${styles}
    .login-wrap { display:flex; justify-content:center; align-items:center; min-height:100vh; padding:20px; }
    .login-box { background:#fff; border-radius:2px; padding:40px; width:380px; box-shadow:0 2px 2px rgba(0,0,0,.14), 0 1px 5px rgba(0,0,0,.12); }
    .login-box h2 { margin-bottom:6px; color:#212121; }
    .login-box p { color:#757575; margin-bottom:24px; font-size:14px; }
    .btn { width:100%; padding:12px; font-size:15px; }
    a { display:block; text-align:center; margin-top:16px; color:#757575; font-size:13px; text-decoration:none; }
    a:hover { color:#303F9F; }
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
            <a href="/">← Back to home</a>
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
                // Existing users go straight to their devices dashboard.
                window.location.href = '/tokens';
            } else {
                const msg = document.getElementById('msg');
                msg.style.display = 'block';
                msg.textContent = data.message;
            }
        }
    </script>
    </body></html>`);
});

// ── Legal pages (public) ────────────────────────────────────────────────────
// NOTE: These are informational templates, not legal advice. Have them reviewed
// by counsel before relying on them in production.
function renderLegal(title, updated, sections) {
    return `<!DOCTYPE html><html><head><title>${title} - FloofTracker</title><style>
    ${styles}
    .legal { max-width: 860px; }
    .legal h2 { font-size: 22px; font-weight: 500; color: #212121; margin-bottom: 4px; }
    .updated { color: #757575; font-size: 13px; margin-bottom: 16px; border-bottom: 1px solid #e0e0e0; padding-bottom: 12px; }
    .legal h3 { font-size: 15px; font-weight: 500; color: #3F51B5; margin: 18px 0 8px; }
    .legal p, .legal li { font-size: 14px; color: #424242; line-height: 1.6; margin-bottom: 8px; }
    .legal ul { margin: 0 0 8px 20px; }
    .back { text-align:center; margin-top: 20px; }
    </style></head><body>
    <div class="header">
        <div style="min-width:0">
            <h1>FloofTracker</h1>
            <small>${title}</small>
        </div>
        <div style="display:flex;gap:8px">
            <button class="btn btn-light" onclick="window.location.href='/'">Home</button>
            <button class="btn btn-light" onclick="window.location.href='/login'">Login</button>
        </div>
    </div>
    <div class="container">
        <div class="card legal">
            <h2>${title}</h2>
            <div class="updated">Last updated: ${updated}</div>
            ${sections.map(s => `<h3>${s.h}</h3>${s.p.map(p => `<p>${p}</p>`).join('')}${s.list ? `<ul>${s.list.map(i => `<li>${i}</li>`).join('')}</ul>` : ''}`).join('')}
            <div class="back"><button class="btn btn-outline" onclick="window.location.href='/'" style="width:auto">← Back to home</button></div>
        </div>
    </div>
    </body></html>`;
}

app.get('/terms', (req, res) => {
    res.send(renderLegal('Terms of Service', 'August 15, 2026', [
        { h: '1. Agreement', p: [
            'By creating an account or using FloofTracker (the "Service"), you agree to these Terms of Service. If you are using the Service on behalf of an organization, you confirm that you have authority to bind that organization to these terms.'
        ]},
        { h: '2. The Service', p: [
            'FloofTracker provides a web dashboard and a companion Android app that let employers monitor company-owned or employer-authorized devices, including location, call logs and recordings, SMS messages, app usage, contacts, media, instant messages, and remote commands such as ambient audio recording and photo capture.'
        ]},
        { h: '3. Your responsibilities', p: [
            'You are solely responsible for how you use the Service. Before monitoring any device you must:'
        ], list: [
            'Own the device or have the legal right to monitor it',
            'Obtain any required consent from, and provide proper notice to, the device user (this may include consent to call recording and other surveillance, which is regulated in many jurisdictions)',
            'Comply with all applicable laws, including labor, privacy, wiretap, and recording-consent laws'
        ]},
        { h: '4. Accounts & security', p: [
            'You are responsible for safeguarding your account credentials and device tokens. Notify us immediately if you suspect unauthorized access to your account or any monitored device.'
        ]},
        { h: '5. Prohibited conduct', p: [
            'You may not use the Service to engage in illegal surveillance, to monitor devices you have no right to monitor, to circumvent rate limits or security controls, to reverse engineer the Service, or to otherwise violate the law or the rights of others.'
        ]},
        { h: '6. Plans & fees', p: [
            'The Service offers a free plan and paid plans (currently coming soon). We may change plan features, limits, or pricing with reasonable notice. All plans include all monitoring features.'
        ]},
        { h: '7. Termination', p: [
            'You may stop using the Service and delete your devices or account at any time. We may suspend or terminate access for violations of these terms, illegal use, or abuse of the Service. Removing a device permanently deletes the data associated with it.'
        ]},
        { h: '8. Disclaimers', p: [
            'The Service is provided "as is" and "as available" without warranties of any kind, express or implied, including accuracy, reliability, availability, or fitness for a particular purpose. Monitoring data may be incomplete, delayed, or unavailable.'
        ]},
        { h: '9. Limitation of liability', p: [
            'To the maximum extent permitted by law, FloofTracker shall not be liable for indirect, incidental, special, consequential, or punitive damages, or for any damages arising from your use of, or inability to use, the Service or from data collected through it.'
        ]},
        { h: '10. Changes to these terms', p: [
            'We may update these Terms of Service from time to time. Continued use of the Service after changes take effect constitutes acceptance of the updated terms.'
        ]},
        { h: '11. Contact', p: [
            'Questions about these terms can be sent to the account owner or the support contact listed on the dashboard.'
        ]}
    ]));
});

app.get('/privacy', (req, res) => {
    res.send(renderLegal('Privacy Policy', 'August 15, 2026', [
        { h: '1. Overview', p: [
            'This Privacy Policy explains what information FloofTracker collects, how it is used, and the choices available to you. The Service is designed for employers to monitor devices they own or are authorized to monitor.'
        ]},
        { h: '2. Information we collect', p: [
            'Account information: email address and a securely hashed password, plus your selected plan.'
        ]},
        { h: '3. Device data', p: [
            'With a device enrolled under your account, the Service collects:',
        ], list: [
            'GPS location and accuracy',
            'Call logs and audio recordings of calls',
            'SMS messages (sent and received)',
            'App usage statistics',
            'Contacts list',
            'Photos and screenshots',
            'Instant messaging notifications from apps such as Messenger, WhatsApp, and Telegram',
            'Ambient audio recordings and photos captured via remote commands'
        ]},
        { h: '4. How we use this information', p: [
            'Device data is displayed in your private dashboard so you can monitor enrolled devices. We use account information to run the Service, enforce plan limits, and communicate about your account. We do not sell your data or the data of monitored devices.'
        ]},
        { h: '5. Consent & notice', p: [
            'You are responsible for obtaining any legally required consent from device users and for notifying them that the device is monitored, including that calls may be recorded and that the microphone and camera may be used. Recording conversations and other surveillance is regulated in many jurisdictions; it is your responsibility to comply.'
        ]},
        { h: '6. Storage & retention', p: [
            'Data is stored on our servers (a hosted MongoDB database) and kept while the device remains active on your account. Removing a device from your account permanently deletes its data, including recordings and media. We retain account records as needed to provide the Service and comply with law.'
        ]},
        { h: '7. Security', p: [
            'Passwords are stored as bcrypt hashes, sessions use signed HTTP-only cookies, device access uses per-device secret tokens, and data is transmitted over HTTPS in production. No method of transmission or storage is completely secure.'
        ]},
        { h: '8. Sharing & legal requests', p: [
            'We do not share your data with third parties except as required by law, legal process, or to protect the rights and safety of FloofTracker, its users, or the public.'
        ]},
        { h: '9. Your choices', p: [
            'You can remove monitored devices from your dashboard at any time, which deletes their data. You may also stop using the Service and request deletion of your account by contacting support.'
        ]},
        { h: '10. Changes to this policy', p: [
            'We may update this Privacy Policy as the Service evolves. We will post any changes here, and continued use of the Service after changes take effect constitutes acceptance.'
        ]}
    ]));
});

app.get('/register', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><title>Register - FloofTracker</title><style>
    ${styles}
    .login-wrap { display:flex; justify-content:center; align-items:center; min-height:100vh; padding:20px; }
    .login-box { background:#fff; border-radius:2px; padding:40px; width:380px; box-shadow:0 2px 2px rgba(0,0,0,.14), 0 1px 5px rgba(0,0,0,.12); }
    .login-box h2 { margin-bottom:6px; color:#212121; }
    .login-box p { color:#757575; margin-bottom:24px; font-size:14px; }
    .btn { width:100%; padding:12px; font-size:15px; }
    a { display:block; text-align:center; margin-top:16px; color:#757575; font-size:13px; text-decoration:none; }
    a:hover { color:#303F9F; }
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
            <a href="/login">Already have an account? Login</a>
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
    .feature-item { background:#fafafa; border:1px solid #e0e0e0; border-radius:2px; padding:20px; text-align:center; transition: box-shadow .18s ease, border-color .18s ease; }
    .feature-item:hover { border-color:#3F51B5; box-shadow: 0 4px 8px rgba(0,0,0,.14); }
    .feature-item .icon { font-size:32px; margin-bottom:10px; }
    .feature-item h4 { color:#212121; margin-bottom:6px; }
    .feature-item p { color:#757575; font-size:13px; line-height:1.5; }
    </style></head><body>
    <div class="header"><h1>FloofTracker</h1><button class="btn btn-light" onclick="logout()">Logout</button></div>
    <div class="container">
        <div class="card" style="text-align:center;padding:40px">
            <h2 style="color:#212121;margin-bottom:10px">Welcome to FloofTracker </h2>
            <p style="color:#757575;margin-bottom:30px">Here's what you can monitor on your employees' devices</p>
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
        if (!localStorage.getItem('employer_id')) window.location.href = '/login';
        function logout() { window.location.href = '/logout'; }
    </script>
    </body></html>`);
});

app.get('/plans', requireAuthPage, (req, res) => {
    res.send(`<!DOCTYPE html><html><head><title>Plans - FloofTracker</title><style>
    ${styles}
    .btn { padding:12px 24px; font-size:14px; width:100%; margin-top:12px; }
    </style></head><body>
    <div class="header"><h1>FloofTracker</h1><button class="btn btn-light" onclick="logout()" style="width:auto">Logout</button></div>
    <div class="container">
        <div class="card">
            <h2 style="color:#212121;margin-bottom:6px">Choose Your Plan</h2>
            <p style="color:#757575;margin-bottom:24px">All plans include all features. Upgrade anytime.</p>
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
        if (!localStorage.getItem('employer_id')) window.location.href = '/login';
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
            <button class="btn btn-light" onclick="window.location.href='/plans'">Change Plan</button>
            <button class="btn btn-light" onclick="logout()">Logout</button>
        </div>
    </div>
    <div class="container">
        <div class="card">
            <div class="top-bar">
                <div>
                    <h2 style="color:#212121">Your Devices</h2>
                    <p style="color:#757575;font-size:13px;margin-top:4px">Plan: <b id="plan_label"></b> &nbsp;·&nbsp; <span id="device_count"></span></p>
                </div>
                <button class="btn btn-success" onclick="generateToken()">+ Add Device</button>
            </div>
            <div class="msg msg-error" id="msg" style="display:none"></div>
            <div id="tokens_list"></div>
        </div>
    </div>
    <script>
        if (!localStorage.getItem('employer_id')) window.location.href = '/login';
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
                    <div style="display:flex;gap:8px;flex-shrink:0;flex-wrap:wrap">
                        <button class="btn btn-sm btn-outline" onclick="copyToken('\${esc(t.token)}')">Copy</button>
                        \${t.registered ? \`<button class="btn btn-sm btn-primary" onclick="viewDevice('\${esc(t.token)}')">View</button>\` : ''}
                        <button class="btn btn-sm btn-outline" data-id="\${esc(t._id)}" data-name="\${esc(t.device_name)}" onclick="renameToken(this)">Rename</button>
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

        async function renameToken(btn) {
            const token_id = btn.dataset.id;
            const current = btn.dataset.name || '';
            const name = prompt('Rename device', current);
            if (name === null) return;
            const trimmed = name.trim();
            if (trimmed === '' || trimmed === current) return;
            const res = await fetch('/employer/rename-token', {
                method:'POST', headers:{'Content-Type':'application/json','X-CSRF-Token':window.CSRF_TOKEN},
                body: JSON.stringify({ token_id, name: trimmed })
            });
            const data = await res.json();
            if (data.success) { loadTokens(); }
            else { const msg = document.getElementById('msg'); msg.style.display='block'; msg.textContent=data.message; }
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
            <h1>📱 ${esc(owner.device_name || device?.device_model) || 'Device'}</h1>
            <small>Android ${esc(device?.android_version) || '—'}
                · <span class="status-dot ${isOnline ? 'status-online' : 'status-offline'}"></span><span class="${isOnline ? 'status-text-online' : 'status-text-offline'}">${isOnline ? 'Online' : 'Offline'}</span>
                · Last seen: ${device?.last_seen ? esc(new Date(device.last_seen).toLocaleString()) : 'Never'}
            </small>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
            <button class="btn btn-light" onclick="window.location.href='/tokens'">← Back</button>
            <button class="btn btn-light" onclick="renameDevice()">✏️ Rename</button>
            <button class="btn btn-light" onclick="window.location.href='/logout'">Logout</button>
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
                                '<span style="color:#9e9e9e;font-size:12px">No recording</span>'
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
                        <td>${m.thumbnail ? `<img class="thumb" src="data:image/jpeg;base64,${esc(m.thumbnail)}" data-src="data:image/jpeg;base64,${esc(m.thumbnail)}" onclick="openLightbox(this)"/>` : '<span style="color:#9e9e9e;font-size:12px">No preview</span>'}</td>
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
                <div class="remote-status ${isOnline ? 'online' : 'offline'}">
                    <span class="dot"></span>
                    <div>
                        <b>${isOnline ? 'Device is online' : 'Device is offline'}</b>
                        &nbsp;·&nbsp; Remote commands ${isOnline ? 'are delivered immediately' : 'are queued and will run when the phone comes back online'}.
                        Last seen: ${device?.last_seen ? esc(new Date(device.last_seen).toLocaleString()) : 'Never'}
                    </div>
                </div>
                <h3 style="color:#212121;margin-bottom:6px">Remote Control</h3>
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
    if (!localStorage.getItem('employer_id')) window.location.href = '/login';
    window.CSRF_TOKEN = '${res.locals.csrfToken}';

    async function renameDevice() {
        const current = (document.querySelector('.header h1').textContent || '').replace(/^📱\s*/, '').trim();
        const name = prompt('Rename device', current);
        if (name === null) return;
        const trimmed = name.trim();
        if (trimmed === '' || trimmed === current) return;
        const res = await fetch('/employer/rename-token', {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': window.CSRF_TOKEN },
            body: JSON.stringify({ token_id: '${owner._id}', name: trimmed })
        });
        const data = await res.json();
        if (data.success) window.location.reload();
        else alert(data.message || 'Failed to rename device');
    }
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
        // The 2-minute command poll is a reliable heartbeat for the online status.
        await Device.updateOne({ token: req.deviceToken }, { last_seen: new Date() });
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
