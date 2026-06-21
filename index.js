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
  data.apps.push(...apps);
  console.log(`${apps.length} apps from ${token}`);
  res.json({ success: true });
});

// Dashboard - view all data
app.get('/dashboard', (req, res) => {
  res.json(data);
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});