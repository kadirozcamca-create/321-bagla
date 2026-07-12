const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const { WebSocketServer } = require('ws');

// Barındırma platformlarında (Render RENDER=true verir) TLS'i platform
// sonlandırır; yerel HTTPS yalnızca evde LAN oyunundaki mikrofon için gerekir.
const IS_HOSTED = !!(process.env.RENDER || process.env.DISABLE_LOCAL_HTTPS);
const PORT = process.env.PORT || 3001;
const HTTPS_PORT = 3443; // sesli giriş (mikrofon) için yerel güvenli bağlantı
const dir = __dirname;

// ============ STATIC SERVER ============
function handleRequest(req, res) {
    if (req.url.startsWith('/info')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ lanIp: getLanIp(), port: PORT, httpsPort: httpsServer ? HTTPS_PORT : null }));
        return;
    }

    const urlPath = req.url.split('?')[0];
    let filePath = path.join(dir, urlPath === '/' ? 'index.html' : urlPath);
    const ext = path.extname(filePath);
    const types = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' };

    fs.readFile(filePath, (err, data) => {
        if (err) {
            // Bilinmeyen yollar index.html'e düşsün (?oda=XXX linkleri için)
            fs.readFile(path.join(dir, 'index.html'), (err2, html) => {
                if (err2) { res.writeHead(404); res.end('Not found'); return; }
                res.writeHead(200, { 'Content-Type': 'text/html' });
                res.end(html);
            });
            return;
        }
        res.writeHead(200, { 'Content-Type': types[ext] || 'text/plain' });
        res.end(data);
    });
}

const server = http.createServer(handleRequest);

// Tarayıcılar mikrofona yalnızca güvenli bağlantıda izin verir; LAN'daki oyuncunun
// sesli giriş kullanabilmesi için kendinden imzalı sertifikayla HTTPS de açılır.
function ensureCerts() {
    const certDir = path.join(dir, 'certs');
    const keyPath = path.join(certDir, 'key.pem');
    const certPath = path.join(certDir, 'cert.pem');
    try {
        if (!fs.existsSync(keyPath) || !fs.existsSync(certPath)) {
            fs.mkdirSync(certDir, { recursive: true });
            execSync(`openssl req -x509 -newkey rsa:2048 -keyout "${keyPath}" -out "${certPath}" -days 3650 -nodes -subj "/CN=futbol-oyunu"`, { stdio: 'ignore' });
        }
        return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
    } catch (err) {
        console.error('Sertifika olusturulamadi, HTTPS kapali:', err.message);
        return null;
    }
}

const certs = IS_HOSTED ? null : ensureCerts();
const httpsServer = certs ? https.createServer(certs, handleRequest) : null;

function getLanIp() {
    const ifaces = os.networkInterfaces();
    for (const name of Object.keys(ifaces)) {
        for (const iface of ifaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) return iface.address;
        }
    }
    return 'localhost';
}

// ============ GAME ROOMS ============
const rooms = new Map(); // code -> room

function makeCode() {
    const chars = 'ABCDEFGHJKLMNPRSTUVYZ23456789';
    let code;
    do {
        code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
    } while (rooms.has(code));
    return code;
}

function createRoom() {
    const room = {
        code: makeCode(),
        sockets: [null, null], // index 0 = Oyuncu 1
        scores: [0, 0],
        round: 1,
        phase: 'lobby', // lobby | setup | countdown | answer | result
        team1: null,
        team2: null,
        locked: [false, false],
        answerEndsAt: null,
        answerTimeout: null,
        countdownTimeout: null,
        pendingVerdict: null, // { player, answer }
        lastResult: null,     // { winner, answer, via }
        emptyTimeout: null
    };
    rooms.set(room.code, room);
    return room;
}

function send(ws, type, data = {}) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type, ...data }));
}

function broadcast(room, type, data = {}) {
    room.sockets.forEach(ws => send(ws, type, data));
}

function snapshot(room) {
    return {
        code: room.code,
        phase: room.phase,
        team1: room.team1,
        team2: room.team2,
        scores: room.scores,
        round: room.round,
        locked: room.locked,
        players: [!!room.sockets[0], !!room.sockets[1]],
        timeLeft: room.answerEndsAt ? Math.max(0, Math.round((room.answerEndsAt - Date.now()) / 1000)) : null,
        pendingVerdict: room.pendingVerdict,
        lastResult: room.lastResult
    };
}

// Setup aşamasında rakibin takımı gizlenir: herkes yalnızca kendi seçimini görür
function maskedSnapshot(room, player) {
    const s = snapshot(room);
    if (room.phase === 'setup' || room.phase === 'lobby') {
        s.yourTeam = player === 1 ? room.team1 : room.team2;
        s.picked = [!!room.team1, !!room.team2];
        s.team1 = null;
        s.team2 = null;
    }
    return s;
}

function sendPickUpdate(room) {
    room.sockets.forEach((s, i) => send(s, 'pick_update', {
        picked: [!!room.team1, !!room.team2],
        yourTeam: i === 0 ? room.team1 : room.team2
    }));
}

function clearTimers(room) {
    if (room.answerTimeout) { clearTimeout(room.answerTimeout); room.answerTimeout = null; }
    if (room.countdownTimeout) { clearTimeout(room.countdownTimeout); room.countdownTimeout = null; }
    room.answerEndsAt = null;
}

function endRound(room, winner, answer, via, resolvedName) {
    clearTimers(room);
    room.phase = 'result';
    room.pendingVerdict = null;
    room.locked = [false, false];
    if (winner) room.scores[winner - 1]++;
    room.lastResult = { winner, answer: answer || null, via: via || null, resolvedName: resolvedName || null };
    broadcast(room, 'round_end', {
        winner, answer: answer || null, via: via || null, resolvedName: resolvedName || null,
        scores: room.scores, round: room.round,
        team1: room.team1, team2: room.team2
    });
}

function resetToSetup(room) {
    clearTimers(room);
    room.team1 = null;
    room.team2 = null;
    room.phase = 'setup';
    room.locked = [false, false];
    room.pendingVerdict = null;
    room.lastResult = null;
    broadcast(room, 'setup_reset', { round: room.round, scores: room.scores });
}

function startAnswerPhase(room) {
    room.phase = 'answer';
    room.locked = [false, false];
    room.pendingVerdict = null;
    const DURATION = 60;
    room.answerEndsAt = Date.now() + DURATION * 1000;
    room.answerTimeout = setTimeout(() => {
        if (room.phase === 'answer') endRound(room, null, null, 'timeout');
    }, DURATION * 1000);
    broadcast(room, 'answer_start', { seconds: DURATION, team1: room.team1, team2: room.team2 });
}

// ============ WEBSOCKET ============
// Hem HTTP hem HTTPS üzerinden bağlantı kabul edilir (odalar ortak)
const wss = new WebSocketServer({ noServer: true });

[server, httpsServer].filter(Boolean).forEach(srv => {
    srv.on('upgrade', (req, socket, head) => {
        wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
    });
});

wss.on('connection', (ws) => {
    ws.room = null;
    ws.player = null;

    ws.on('message', async (raw) => {
        let msg;
        try { msg = JSON.parse(raw); } catch { return; }
        const room = ws.room;

        switch (msg.type) {
            case 'create_room': {
                const newRoom = createRoom();
                newRoom.sockets[0] = ws;
                ws.room = newRoom;
                ws.player = 1;
                send(ws, 'room_created', { code: newRoom.code, player: 1, state: maskedSnapshot(newRoom, 1) });
                break;
            }

            case 'join_room': {
                const code = (msg.code || '').toUpperCase().trim();
                const target = rooms.get(code);
                if (!target) { send(ws, 'join_error', { message: 'Oda bulunamadı. Kod doğru mu?' }); return; }
                const freeSlot = target.sockets[0] === null ? 0 : (target.sockets[1] === null ? 1 : -1);
                if (freeSlot === -1) { send(ws, 'join_error', { message: 'Oda dolu!' }); return; }
                if (target.emptyTimeout) { clearTimeout(target.emptyTimeout); target.emptyTimeout = null; }
                target.sockets[freeSlot] = ws;
                ws.room = target;
                ws.player = freeSlot + 1;
                if (target.phase === 'lobby' && target.sockets[0] && target.sockets[1]) {
                    target.phase = 'setup';
                }
                const otherPlayer = freeSlot === 0 ? 2 : 1;
                send(ws, 'joined', { code: target.code, player: ws.player, state: maskedSnapshot(target, ws.player) });
                send(target.sockets[otherPlayer - 1], 'opponent_joined', { state: maskedSnapshot(target, otherPlayer) });
                break;
            }

            case 'select_team': {
                if (!room || room.phase !== 'setup') return;
                const team = msg.team;
                if (!team || !team.name || !team.id) return;
                // Herkes kendi takımını seçer; başlatana kadar değiştirebilir
                if (ws.player === 1) room.team1 = team;
                else room.team2 = team;
                sendPickUpdate(room);
                break;
            }

            case 'start_game': {
                if (!room || room.phase !== 'setup') return;
                if (!room.team1 || !room.team2) return;
                if (room.team1.id === room.team2.id) {
                    // İkisi de aynı takımı seçmiş: seçimleri sıfırla
                    room.team1 = null;
                    room.team2 = null;
                    broadcast(room, 'same_team', {});
                    sendPickUpdate(room);
                    return;
                }
                room.phase = 'countdown';
                // Takımlar ancak burada açıklanır
                broadcast(room, 'countdown_start', { team1: room.team1, team2: room.team2 });
                room.countdownTimeout = setTimeout(() => startAnswerPhase(room), 4000);
                break;
            }

            case 'submit_answer': {
                if (!room || room.phase !== 'answer') return;
                const p = ws.player;
                if (room.locked[p - 1]) return;
                const answer = (msg.answer || '').trim();
                if (!answer) return;
                room.locked[p - 1] = true;
                broadcast(room, 'answer_status', { player: p, status: 'checking', answer });

                const result = await verifyPlayer(answer, room.team1, room.team2);
                if (room.phase !== 'answer') return; // raund bu arada bitmiş olabilir

                const autoUnlock = (delayMs) => setTimeout(() => {
                    if (room.phase === 'answer' && room.locked[p - 1] &&
                        (!room.pendingVerdict || room.pendingVerdict.player !== p)) {
                        room.locked[p - 1] = false;
                        broadcast(room, 'answer_status', { player: p, status: 'unlocked' });
                    }
                }, delayMs);

                if (result.status === 'confirmed') {
                    endRound(room, p, answer, 'api', result.name);
                } else if (result.status === 'ambiguous') {
                    // İsim tek başına ayırt edici değil: tam ad istenir, bulunan isim açıklanmaz
                    broadcast(room, 'answer_status', { player: p, status: 'ambiguous', answer });
                    autoUnlock(2500);
                } else if (result.status === 'denied') {
                    broadcast(room, 'answer_status', { player: p, status: 'denied', answer, name: result.name });
                    autoUnlock(5000);
                } else { // unverified
                    room.pendingVerdict = { player: p, answer, kind: 'unverified' };
                    broadcast(room, 'verdict_request', { player: p, answer, kind: 'unverified' });
                }
                break;
            }

            case 'objection': {
                if (!room || room.phase !== 'answer') return;
                const p = ws.player;
                if (!room.locked[p - 1]) return;
                const answer = (msg.answer || '').trim();
                room.pendingVerdict = { player: p, answer, kind: 'objection' };
                broadcast(room, 'verdict_request', { player: p, answer, kind: 'objection' });
                break;
            }

            case 'verdict': {
                if (!room || room.phase !== 'answer' || !room.pendingVerdict) return;
                const pv = room.pendingVerdict;
                if (ws.player === pv.player) return; // kendi cevabına karar veremez
                if (msg.accepted) {
                    endRound(room, pv.player, pv.answer, 'opponent');
                } else {
                    room.pendingVerdict = null;
                    room.locked[pv.player - 1] = false;
                    broadcast(room, 'answer_status', { player: pv.player, status: 'rejected', answer: pv.answer });
                }
                break;
            }

            case 'skip_round': {
                if (!room || room.phase !== 'answer') return;
                endRound(room, null, null, 'skip');
                break;
            }

            case 'next_round': {
                if (!room || room.phase !== 'result') return;
                room.round++;
                resetToSetup(room);
                break;
            }

            case 'new_game': {
                if (!room) return;
                room.scores = [0, 0];
                room.round = 1;
                resetToSetup(room);
                break;
            }
        }
    });

    ws.on('close', () => {
        const room = ws.room;
        if (!room) return;
        const idx = ws.player - 1;
        if (room.sockets[idx] === ws) room.sockets[idx] = null;
        const other = room.sockets[idx === 0 ? 1 : 0];
        if (other) {
            send(other, 'opponent_left', {});
        } else {
            // İki oyuncu da gitti: odayı 10 dk sonra sil
            room.emptyTimeout = setTimeout(() => {
                clearTimers(room);
                rooms.delete(room.code);
            }, 10 * 60 * 1000);
        }
    });
});

// ============ WIKIPEDIA DOĞRULAMA ============
const TEAM_ALIASES = {
    "besiktas": ["beşiktaş", "besiktas", "bjk"],
    "fenerbahce": ["fenerbahçe", "fenerbahce"],
    "galatasaray": ["galatasaray"],
    "trabzonspor": ["trabzonspor", "trabzon"],
    "eyupspor": ["eyüpspor", "eyupspor", "eyup"],
    "alanyaspor": ["alanyaspor", "alanya"],
    "antalyaspor": ["antalyaspor", "antalya"],
    "gaziantep": ["gaziantep", "gaziantep fk", "gaziantep f.k."],
    "goztepe": ["göztepe", "goztepe"],
    "istanbul basaksehir": ["başakşehir", "basaksehir", "istanbul başakşehir", "istanbul basaksehir"],
    "kasimpasa": ["kasımpaşa", "kasimpasa"],
    "kayserispor": ["kayserispor", "kayseri"],
    "kocaelispor": ["kocaelispor", "kocaeli"],
    "konyaspor": ["konyaspor", "konya"],
    "rizespor": ["rizespor", "rize", "çaykur rizespor"],
    "samsunspor": ["samsunspor", "samsun"],
    "sivasspor": ["sivasspor", "sivas"],
    "adana demirspor": ["adana demirspor", "adana demir"],
    "arsenal": ["arsenal"],
    "aston villa": ["aston villa"],
    "bournemouth": ["bournemouth", "afc bournemouth"],
    "brentford": ["brentford"],
    "brighton": ["brighton", "brighton & hove albion", "brighton and hove albion"],
    "chelsea": ["chelsea"],
    "crystal palace": ["crystal palace"],
    "everton": ["everton"],
    "fulham": ["fulham"],
    "liverpool": ["liverpool"],
    "manchester city": ["manchester city", "man city"],
    "manchester united": ["manchester united", "man united", "man utd"],
    "newcastle united": ["newcastle united", "newcastle"],
    "nottingham forest": ["nottingham forest", "nott'm forest"],
    "tottenham": ["tottenham hotspur", "tottenham", "spurs"],
    "west ham": ["west ham united", "west ham"],
    "wolverhampton": ["wolverhampton wanderers", "wolverhampton", "wolves"],
    "leicester city": ["leicester city", "leicester"],
    "athletic bilbao": ["athletic bilbao", "athletic club"],
    "atletico madrid": ["atlético madrid", "atletico madrid", "atlético de madrid", "atletico de madrid"],
    "barcelona": ["barcelona", "fc barcelona", "barça"],
    "celta vigo": ["celta vigo", "celta de vigo", "rc celta"],
    "espanyol": ["espanyol", "rcd espanyol"],
    "getafe": ["getafe"],
    "girona": ["girona"],
    "mallorca": ["mallorca", "rcd mallorca"],
    "osasuna": ["osasuna", "ca osasuna"],
    "rayo vallecano": ["rayo vallecano"],
    "real betis": ["real betis", "betis"],
    "real madrid": ["real madrid"],
    "real sociedad": ["real sociedad"],
    "sevilla": ["sevilla", "sevilla fc"],
    "valencia": ["valencia", "valencia cf"],
    "villarreal": ["villarreal"],
    "ac milan": ["ac milan", "a.c. milan", "milan f.c."],
    "atalanta": ["atalanta"],
    "bologna": ["bologna"],
    "fiorentina": ["fiorentina", "acf fiorentina"],
    "genoa": ["genoa"],
    "inter milan": ["inter milan", "internazionale"],
    "juventus": ["juventus"],
    "lazio": ["lazio", "s.s. lazio"],
    "lecce": ["lecce"],
    "napoli": ["napoli", "ssc napoli"],
    "roma": ["roma", "as roma", "a.s. roma"],
    "torino": ["torino"],
    "udinese": ["udinese"],
    "sassuolo": ["sassuolo"],
    "parma": ["parma"],
    "bayer leverkusen": ["bayer leverkusen", "leverkusen", "bayer 04 leverkusen"],
    "bayern munich": ["bayern munich", "bayern münchen", "fc bayern munich", "fc bayern"],
    "borussia dortmund": ["borussia dortmund", "dortmund", "bvb"],
    "eintracht frankfurt": ["eintracht frankfurt", "frankfurt"],
    "freiburg": ["freiburg", "sc freiburg"],
    "hoffenheim": ["hoffenheim", "tsg hoffenheim"],
    "mainz": ["mainz", "mainz 05"],
    "rb leipzig": ["rb leipzig", "rasenballsport leipzig", "leipzig"],
    "stuttgart": ["stuttgart", "vfb stuttgart"],
    "wolfsburg": ["wolfsburg", "vfl wolfsburg"],
    "werder bremen": ["werder bremen", "bremen"],
    "union berlin": ["union berlin", "1. fc union berlin"],
    "borussia monchengladbach": ["borussia mönchengladbach", "borussia monchengladbach", "mönchengladbach", "gladbach"],
    "fc koln": ["fc köln", "1. fc köln", "fc koln", "köln", "cologne"],
    "fc augsburg": ["fc augsburg", "augsburg"],
    "lyon": ["lyon", "olympique lyonnais"],
    "marseille": ["marseille", "olympique de marseille", "olympique marseille"],
    "monaco": ["monaco", "as monaco"],
    "nice": ["ogc nice"],
    "paris sg": ["paris saint-germain", "paris sg", "psg"],
    "lille": ["lille", "losc lille", "losc"],
    "lens": ["lens", "rc lens"],
    "rennes": ["rennes", "stade rennais"],
    "strasbourg": ["strasbourg", "rc strasbourg"],
    "toulouse": ["toulouse"],
    "nantes": ["nantes", "fc nantes"],
    "brest": ["brest", "stade brestois"],
    "benfica": ["benfica", "sl benfica", "s.l. benfica"],
    "fc porto": ["fc porto", "porto"],
    "sporting cp": ["sporting cp", "sporting lisbon", "sporting clube de portugal"],
    "braga": ["braga", "sc braga", "sporting braga"],
    "ajax": ["ajax", "afc ajax"],
    "az alkmaar": ["az alkmaar"],
    "feyenoord": ["feyenoord"],
    "psv eindhoven": ["psv eindhoven", "psv"]
};

function teamMatchesText(teamName, text) {
    const key = teamName.toLowerCase();
    const aliases = TEAM_ALIASES[key] || [key];
    const lowerText = text.toLowerCase();
    return aliases.some(alias => lowerText.includes(alias));
}

// Türkçe karakterleri ve aksanları sadeleştirir: "Şükür" -> "sukur"
function normalizeName(s) {
    return s.toLowerCase()
        .replace(/ı/g, 'i')
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function cleanTitle(title) {
    // "Alex (footballer, born 1977)" -> "Alex"
    return title.replace(/\(.*?\)/g, '').trim();
}

// Yazılan isim, bulunan sayfadaki futbolcuyu tek başına ayırt ediyor mu?
// Kural: soyadı yazılmış olmalı, ya da başlıktaki en az iki kelime eşleşmeli.
function isDistinctive(typed, title) {
    const titleTokens = normalizeName(cleanTitle(title)).split(' ').filter(Boolean);
    const typedTokens = normalizeName(typed).split(' ').filter(Boolean);
    if (titleTokens.length === 0 || typedTokens.length === 0) return false;

    const surname = titleTokens[titleTokens.length - 1];
    if (typedTokens.includes(surname)) return true;

    const matches = titleTokens.filter(t => typedTokens.includes(t)).length;
    return matches >= 2;
}

// Wikipedia API kurallarına uygun kimlikli istek (kimliksiz istekler hız sınırına takılır)
async function wikiFetch(url) {
    const res = await fetch(url, { headers: { 'User-Agent': 'FutbolBaglantiOyunu/2.0 (iki kisilik yerel oyun)' } });
    if (!res.ok || !(res.headers.get('content-type') || '').includes('json')) {
        throw new Error(`Wikipedia yanit vermedi (HTTP ${res.status}) - muhtemelen hiz siniri`);
    }
    return res;
}

// Aynı cevap + takım ikilisi için sonucu önbelleğe al (itiraz/tekrar denemelerde API'ye gitme)
const verifyCache = new Map();
const CACHE_MAX = 500;

// Yazılan ad-soyad (en az 2 kelime) oyuncunun sayfa metninde geçiyor mu?
// Takma / sonradan alınan isimleri yakalar (ör. "Kaan Dobra" = Roman Dąbrowski)
function aliasInText(typed, wikitext) {
    const t = normalizeName(typed);
    if (t.split(' ').filter(Boolean).length < 2) return false;
    return normalizeName(wikitext).includes(t);
}

// Bilgi kutusundaki kariyer satırlarını çıkar: yalnızca oynadığı kulüpler.
// Sayfanın geri kalanı (rakipler, transfer söylentileri, maç anlatımları) takım
// eşleşmesinde SAYILMAZ - ör. Morata'nın sayfasında "Arsenal" geçmesi yeterli değil.
function careerText(wikitext) {
    return wikitext.split('\n').filter(l =>
        /^\s*\|\s*(youthclubs|clubs|nationalteam|kulüp|gençlik|takım|millitakım)[^=]{0,25}=/i.test(l)
    ).join('\n');
}

// Sayfa metnini analiz et: futbolcu sayfası mı, iki takımda da OYNAMIŞ mı?
function analyzePage(wikitext, team1, team2) {
    // Anlam ayrımı / isim listesi sayfaları futbolcu sayfası sayılmaz
    // (ör. "Dobra" soyadı sayfası yüzünden yanlış "denied" kararı çıkıyordu)
    const isNamePage = /\{\{\s*(disambig|dmbox|hndis|given name|surname|infobox given name)/i.test(wikitext) ||
                       /\{\{\s*(anlam ayrımı|ad sayfası|soyadı)/i.test(wikitext);
    // Takım kontrolü YALNIZCA kariyer satırlarında yapılır. Kariyer bilgi kutusu
    // olmayan sayfalar (istatistik listeleri, haber sayfaları vb.) oyuncu
    // biyografisi sayılmaz - tüm metne düşmek yanlış kabullere yol açıyordu
    // (ör. "messi" için başarı listesi sayfasında Galatasaray adının geçmesi).
    const career = careerText(wikitext);
    const isFootballer = !isNamePage && career.length > 0 &&
        /football|futbol|soccer|position|caps|goals|youthclubs|clubs|currentclub/i.test(wikitext);

    return {
        isFootballer,
        hasTeam1: teamMatchesText(team1.name, career),
        hasTeam2: teamMatchesText(team2.name, career)
    };
}

function pageContent(page) {
    return (page.revisions && page.revisions[0] && page.revisions[0].slots &&
            page.revisions[0].slots.main && page.revisions[0].slots.main.content) || null;
}

// Yazılan ismi doğrudan Wikipedia başlığı olarak dene (yönlendirmeler dahil, tek istekte içerikle).
// "Kaan Dobra" -> redirect -> "Roman Dąbrowski" gibi durumları çözer.
async function lookupByTitle(lang, typedName, team1, team2) {
    try {
        const title = typedName.trim().replace(/\s+/g, ' ')
            .split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
        const url = `https://${lang}.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(title)}&redirects=1&prop=revisions&rvprop=content&rvslots=main&formatversion=2&format=json`;
        const res = await wikiFetch(url);
        const data = await res.json();
        const page = data.query && data.query.pages && data.query.pages[0];
        if (!page || page.missing) return null;

        const wikitext = pageContent(page);
        if (!wikitext) return null;

        const a = analyzePage(wikitext, team1, team2);
        if (a.isFootballer && a.hasTeam1 && a.hasTeam2) {
            return { status: 'confirmed', name: cleanTitle(page.title) };
        }
        return null;
    } catch (err) {
        return null;
    }
}

// Arama + ilk 3 sonucun içeriği tek istekte (generator=search)
async function searchPagesWithContent(lang, query) {
    const url = `https://${lang}.wikipedia.org/w/api.php?action=query&generator=search&gsrsearch=${encodeURIComponent(query)}&gsrlimit=3&prop=revisions&rvprop=content&rvslots=main&formatversion=2&format=json`;
    const res = await wikiFetch(url);
    const data = await res.json();
    const pages = (data.query && data.query.pages) || [];
    return pages.slice().sort((a, b) => (a.index || 0) - (b.index || 0));
}

// Dönüş: { status: "confirmed" | "ambiguous" | "denied" | "unverified", name?: string }
// - confirmed: iki takımda da oynamış VE yazılan isim o oyuncuyu ayırt ediyor
//   (başlık eşleşmesi, sayfa metninde ad-soyad geçmesi veya yönlendirme ile)
// - ambiguous: iki takımda da oynamış bir oyuncu bulundu ama yazılan isim belirsiz (ör. sadece "eren")
// - denied: yazılan isimle tam eşleşen futbolcu bulundu ama iki takımda birden oynamamış
// - unverified: hiçbir sonuç yok, karar rakibe kalır
async function verifyPlayer(playerName, team1, team2) {
    const cacheKey = `${normalizeName(playerName)}|${team1.id}|${team2.id}`;
    if (verifyCache.has(cacheKey)) return verifyCache.get(cacheKey);

    const remember = (result) => {
        // Geçici hatalardan kaynaklanabilecek "unverified" önbelleğe alınmaz
        if (result.status !== 'unverified') {
            if (verifyCache.size >= CACHE_MAX) verifyCache.delete(verifyCache.keys().next().value);
            verifyCache.set(cacheKey, result);
        }
        return result;
    };

    let ambiguous = null;
    let denied = null;

    const sources = [
        { lang: 'en', suffix: ' footballer', limit: 5 },
        { lang: 'tr', suffix: ' futbolcu', limit: 3 }
    ];

    // Her kaynak kendi hata alanında: en wiki'de sorun çıkarsa tr wiki yine denenir
    for (const src of sources) {
        try {
            // Önce doğrudan başlık/yönlendirme dene (1 istek)
            const direct = await lookupByTitle(src.lang, playerName, team1, team2);
            if (direct) return remember(direct);

            // Sonra arama + içerikler (1 istek)
            const pages = await searchPagesWithContent(src.lang, playerName + src.suffix);

            for (const result of pages) {
                const wikitext = pageContent(result);
                if (!wikitext) continue;

                const a = analyzePage(wikitext, team1, team2);
                if (!a.isFootballer) continue;

                const fullName = cleanTitle(result.title);
                const distinctive = isDistinctive(playerName, result.title) ||
                                    aliasInText(playerName, wikitext);

                if (a.hasTeam1 && a.hasTeam2) {
                    if (distinctive) return remember({ status: 'confirmed', name: fullName });
                    if (!ambiguous) ambiguous = { status: 'ambiguous', name: fullName };
                } else if (distinctive && !denied) {
                    denied = { status: 'denied', name: fullName };
                }
            }
        } catch (err) {
            console.error(`Verification error (${src.lang}):`, err.message);
        }
    }

    if (ambiguous) return remember(ambiguous);
    if (denied) return remember(denied);
    return { status: 'unverified' };
}

server.listen(PORT, '0.0.0.0', () => {
    console.log(`Futbol Oyunu running on http://localhost:${PORT} (LAN: http://${getLanIp()}:${PORT})`);
});

if (httpsServer) {
    httpsServer.listen(HTTPS_PORT, '0.0.0.0', () => {
        console.log(`Sesli giris icin HTTPS: https://${getLanIp()}:${HTTPS_PORT} (sertifika uyarisini kabul edin)`);
    });
}
