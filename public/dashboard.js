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