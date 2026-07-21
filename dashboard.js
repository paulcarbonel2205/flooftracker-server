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
let currentApp = '';

fetch(window.location.href.replace('/device', '/device/notifications-data'))
    .then(r => r.json())
    .then(data => { allNotifications = data.notifications || []; });

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

    const appMessages = allNotifications.filter(function(n) { return n.app === app; });
    const senders = [...new Set(appMessages.map(function(n) { return n.sender; }))];

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