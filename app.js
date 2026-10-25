'use strict';
/* ===================== فيورا — تطبيق ويب (PWA) ===================== */
const L = window.VioraLogic;
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const pad = n => String(n).padStart(2, '0');
const uid = () => Math.random().toString(36).slice(2, 9);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get(k, d) { try { const v = localStorage.getItem('viora.' + k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('viora.' + k, JSON.stringify(v)); } catch { /* التخزين ممتلئ أو ممنوع */ } }
};

/* ---------- الحالة ---------- */
const DEF_CH = ['نور الصالة', 'نور الأوضة', 'المروحة', 'السخان', 'التكييف', 'المطبخ'];
let channels = store.get('channels', DEF_CH.map(n => ({ name: n, on: false })));
if (!Array.isArray(channels) || channels.length !== 6) channels = DEF_CH.map(n => ({ name: n, on: false }));
let S = Object.assign({
  mode: 'demo', httpTpl: 'http://192.168.1.50/relay/{n}/{state}',
  mqttUrl: '', mqttUser: '', mqttPass: '', prefix: 'nexara/home',
  geminiKey: '', geminiModel: 'gemini-flash-latest', voice: true, userName: '', voiceName: '', rate: '0.95'
}, store.get('settings', {}));
let memory = store.get('memory', []);
let scenes = store.get('scenes', [
  { id: 'night', name: 'تصبح على خير', states: [false, false, false, false, false, false] },
  { id: 'morning', name: 'صباح الخير', states: [true, true, false, false, false, false] },
  { id: 'out', name: 'خروج من البيت', states: [false, false, false, false, false, false] }
]);
let log = store.get('log', []);
if (!Array.isArray(memory)) memory = [];
if (!Array.isArray(scenes)) scenes = [];
if (!Array.isArray(log)) log = [];
let weather = store.get('weather', null);
let chatMsgs = store.get('chat', []).map(m => ({ who: m.who, text: m.text }));
let linkState = 'idle'; // idle | ok | bad | connecting
let pending = null;

const saveCh = () => store.set('channels', channels);
const saveS = () => store.set('settings', S);
const saveMem = () => store.set('memory', memory);
const saveScenes = () => store.set('scenes', scenes);
function addLog(text) { log.unshift({ t: Date.now(), text }); log = log.slice(0, 60); store.set('log', log); }

function toast(msg, ms = 2600) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => { t.hidden = true; }, ms);
}

/* ---------- الاتصال بنيكسارا ---------- */
let mq = null;
function loadMqttLib() {
  return new Promise((res, rej) => {
    if (window.mqtt) return res();
    const s = document.createElement('script');
    s.src = 'https://unpkg.com/mqtt@5/dist/mqtt.min.js';
    s.onload = res; s.onerror = () => rej(new Error('mqtt-lib'));
    document.head.appendChild(s);
  });
}
async function mqttConnect() {
  if (mq && mq.connected) return mq;
  if (!S.mqttUrl) throw new Error('no-url');
  await loadMqttLib();
  if (mq) { try { mq.end(true); } catch { /* ignore */ } mq = null; }
  linkState = 'connecting'; renderPill();
  return new Promise((resolve, reject) => {
    const c = window.mqtt.connect(S.mqttUrl, {
      username: S.mqttUser || undefined, password: S.mqttPass || undefined,
      reconnectPeriod: 4000, connectTimeout: 7000, clientId: 'viora_' + uid()
    });
    const to = setTimeout(() => { try { c.end(true); } catch { /* ignore */ } linkState = 'bad'; renderPill(); reject(new Error('timeout')); }, 8000);
    c.on('connect', () => {
      clearTimeout(to); mq = c; linkState = 'ok'; renderPill();
      c.subscribe(`${S.prefix}/+/state`);
      resolve(c);
    });
    c.on('close', () => { if (S.mode === 'mqtt') { linkState = 'bad'; renderPill(); } });
    c.on('message', (topic, payload) => {
      const m = topic.match(/\/ch(\d)\/state$/);
      if (!m) return;
      const i = +m[1] - 1; if (!channels[i]) return;
      const on = /^(on|1|true)$/i.test(payload.toString().trim());
      if (channels[i].on !== on) { channels[i].on = on; saveCh(); renderHome(); }
    });
    c.on('error', () => { /* إعادة المحاولة تلقائية */ });
  });
}
async function sendRelay(i, on) {
  if (S.mode === 'demo') return true;
  if (S.mode === 'http') {
    const url = S.httpTpl.replace('{n}', i + 1).replace('{state}', on ? 'on' : 'off');
    const ctl = new AbortController(); const to = setTimeout(() => ctl.abort(), 4500);
    try { await fetch(url, { mode: 'no-cors', signal: ctl.signal }); linkState = 'ok'; renderPill(); return true; }
    catch { linkState = 'bad'; renderPill(); return false; }
    finally { clearTimeout(to); }
  }
  if (S.mode === 'mqtt') {
    try {
      const c = await mqttConnect();
      await new Promise((res, rej) => c.publish(`${S.prefix}/ch${i + 1}/set`, on ? 'ON' : 'OFF', { qos: 1, retain: false }, e => (e ? rej(e) : res())));
      return true;
    } catch { linkState = 'bad'; renderPill(); return false; }
  }
  return false;
}
async function setChannel(i, on) {
  const prev = channels[i].on;
  channels[i].on = on; saveCh(); renderHome();
  const ok = await sendRelay(i, on);
  if (!ok) { channels[i].on = prev; saveCh(); renderHome(); return false; }
  addLog(`${channels[i].name}: ${on ? 'تشغيل' : 'إيقاف'}`);
  return true;
}

/* ---------- الصوت: ردود مسجّلة ثم صوت الجهاز ---------- */
let curAudio = null;
let arVoice = null;
function pickVoice() {
  const vs = speechSynthesis.getVoices();
  arVoice = (S.voiceName && vs.find(v => v.name === S.voiceName)) || vs.find(v => /ar[-_]EG/i.test(v.lang)) || vs.find(v => /^ar/i.test(v.lang)) || null;
}
if ('speechSynthesis' in window) {
  pickVoice();
  speechSynthesis.onvoiceschanged = () => { pickVoice(); const t = $('#tab-settings'); if (t && !t.hidden) renderSettings(); };
}
/* قاموس نطق: كلمات لاتينية أو أسماء بتتنطق غلط من صوت الجهاز. زوّدي عليه براحتك */
const PRON = [[/NEXARA|Nexara/g, 'نيكسارا'], [/VIORA|Viora/g, 'فيورا'], [/Wi-?Fi/gi, 'واي فاي'], [/Gemini/gi, 'جيميناي'], [/\bAI\b/g, 'إيه آي']];
const prep = t => PRON.reduce((x, [r, w]) => x.replace(r, w), String(t));
function tts(text) {
  if (!('speechSynthesis' in window)) return;
  const u = new SpeechSynthesisUtterance(prep(text));
  u.lang = arVoice ? arVoice.lang : 'ar-EG'; if (arVoice) u.voice = arVoice;
  u.rate = Math.min(1.4, Math.max(0.6, parseFloat(S.rate) || 0.95)); u.pitch = 1.1;
  speechSynthesis.cancel(); speechSynthesis.speak(u);
}
function speak(text, key) {
  if (!S.voice) return;
  try { if (curAudio) { curAudio.pause(); curAudio = null; } if ('speechSynthesis' in window) speechSynthesis.cancel(); } catch { /* ignore */ }
  if (!key) return tts(text);
  let fell = false;
  const fb = () => { if (!fell) { fell = true; tts(text); } };
  const a = new Audio(`audio/${key}.mp3`);
  curAudio = a; a.onerror = fb;
  a.play().catch(fb);
}
document.addEventListener('pointerdown', function unlock() {
  document.removeEventListener('pointerdown', unlock);
  try { if ('speechSynthesis' in window) { const u = new SpeechSynthesisUtterance(' '); u.volume = 0; speechSynthesis.speak(u); } } catch { /* ignore */ }
}, { once: true });

/* ---------- المحادثة ---------- */
function persistChat() { store.set('chat', chatMsgs.slice(-30).map(m => ({ who: m.who, text: m.text }))); }
function addMsg(who, text, opts, interim) {
  chatMsgs.push({ who, text, opts, interim });
  if (chatMsgs.length > 80) chatMsgs.shift();
  persistChat(); renderChat();
}
function renderChat() {
  const box = $('#chat');
  if (!chatMsgs.length) {
    box.innerHTML = '<div class="empty">أهلاً! أنا فيورا 👋<br>جرّبي: «افتحي نور الصالة» أو «فكريني بدواء الضغط الساعة 8»</div>';
    return;
  }
  box.innerHTML = chatMsgs.map((m, i) => `<div class="bubble ${m.who}${m.interim ? ' int' : ''}">${esc(m.text)}${
    m.opts ? `<div class="opts">${m.opts.map((o, k) => `<button class="btn ghost sm" data-opt="${i}:${k}" type="button">${esc(o.label)}</button>`).join('')}</div>` : ''}</div>`).join('');
  box.scrollTop = box.scrollHeight;
}
function say(text, key, opts) { addMsg('her', text, opts); speak(text, key); }
const joinNames = a => a.join(' و');

async function runRelay(idx, on) {
  const changed = idx.filter(i => channels[i].on !== on);
  if (!changed.length) return say(`${joinNames(idx.map(i => channels[i].name))} ${on ? 'مفتوح' : 'مقفول'} بالفعل`, 'ok');
  const res = await Promise.all(changed.map(i => setChannel(i, on)));
  if (res.some(r => !r)) return say('مش قادرة أوصل لنيكسارا، اتأكدي من الاتصال والإعدادات', 'unreachable');
  say(`تمام، ${on ? 'فتحت' : 'قفلت'} ${joinNames(changed.map(i => channels[i].name))}`, 'ok');
}
async function runScene(sc) {
  const diff = sc.states.map((s, i) => (channels[i].on !== s ? i : -1)).filter(i => i >= 0);
  const res = await Promise.all(diff.map(i => setChannel(i, sc.states[i])));
  if (res.some(r => !r)) return say('المشهد اتنفّذ جزئياً، في قنوات مردّتش', 'unreachable');
  addLog(`مشهد: ${sc.name}`);
  say(`تمام، شغّلت مشهد ${sc.name}`, 'ok');
}
async function askGemini(text) {
  const sys = `أنتِ فيورا، مساعدة منزلية بصوت بنت مصرية ودودة. ردّي بالعامية المصرية بجملة أو اتنين قصار. قنوات البيت: ${channels.map((c, i) => `${i + 1}=${c.name}`).join('، ')}. لو الطلب تحكم في قناة رجّعي relay. ردّي JSON فقط بالشكل {"say":"النص","relay":[{"channel":1,"on":true}]} واحذفي relay لو مفيش تحكم.`;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(S.geminiModel)}:generateContent?key=${encodeURIComponent(S.geminiKey)}`;
  const r = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ systemInstruction: { parts: [{ text: sys }] }, contents: [{ role: 'user', parts: [{ text }] }], generationConfig: { responseMimeType: 'application/json', temperature: 0.4 } })
  });
  if (!r.ok) throw new Error('gemini ' + r.status);
  const j = await r.json();
  return JSON.parse(j.candidates?.[0]?.content?.parts?.[0]?.text || '{}');
}

async function handleText(raw) {
  raw = (raw || '').trim(); if (!raw) return;
  addMsg('me', raw);
  const ctx = { channels, scenes, now: new Date() };

  if (pending) {
    const r = L.matchRelay(raw.split(' ').flatMap(w => L.tokenize(w)), pending.idx.map(i => channels[i]));
    if (r && !r.ambiguous) { const p = pending; pending = null; return runRelay(r.idx.map(k => p.idx[k]), p.on); }
    pending = null;
  }
  const it = L.interpret(raw, ctx);
  switch (it.type) {
    case 'empty': return;
    case 'relay': return runRelay(it.idx, it.on);
    case 'ambiguous':
      pending = { idx: it.idx, on: it.on };
      return say('تقصدي أنهي واحد؟', null, [...it.idx.map(i => ({ label: channels[i].name, fn: () => { pending = null; runRelay([i], it.on); } })),
        { label: 'الاتنين', fn: () => { pending = null; runRelay(it.idx, it.on); } }]);
    case 'relay_unknown_device': return say('مش لاقية الجهاز ده في قنوات نيكسارا. تقدري تغيّري أسماء القنوات من الرئيسية.', 'no_understand');
    case 'scene': return runScene(scenes.find(s => s.id === it.scene));
    case 'setname': S.userName = it.name; saveS(); renderHome(); return say(`أهلاً يا ${it.name}، اتشرفت بيك`, 'saved');
    case 'whoami': return say(S.userName ? `اسمك ${S.userName}` : 'لسه مقولتليش اسمك. قولي: اسمي …', 'no_understand');
    case 'save': {
      say('راجعي المعلومة واضغطي تأكيد:', null);
      return editItem(it.item, true);
    }
    case 'find': {
      const hits = L.searchMemory(it.q, memory);
      if (!hits.length) return say(`مش لاقية حاجة عن ${it.q} في ذاكرتي`, 'no_understand');
      const h = hits[0]; return say(h.detail ? `${h.title} ${h.detail}` : h.title, 'ok');
    }
    case 'list': {
      const items = memory.filter(m => (it.kind === 'all' ? m.time : m.type === it.kind));
      if (!items.length) return say('مفيش حاجة متسجلة', 'no_understand');
      return say('عندك: ' + items.map(m => `${m.title}${m.time ? ' الساعة ' + L.fmtTime(m.time) : ''}`).join('، '), 'ok');
    }
    case 'time': return say('الساعة دلوقتي ' + new Date().toLocaleTimeString('ar-EG', { hour: 'numeric', minute: '2-digit' }), null);
    case 'weather': return say(weather ? `الجو ${weather.desc}، ${weather.temp} درجة` : 'مقدرتش أجيب الطقس دلوقتي', null);
    case 'know': return say(it.say, null);
    case 'thanks': return say('العفو يا قمر', 'ok');
    case 'greet': return say(S.userName ? `أهلاً يا ${S.userName}` : 'أهلاً بيك! أنا فيورا', 'hello');
    default:
      if (S.geminiKey) {
        try {
          const out = await askGemini(raw);
          if (Array.isArray(out.relay) && out.relay.length) {
            const bad = out.relay.filter(r => channels[r.channel - 1]);
            for (const r of bad) await setChannel(r.channel - 1, !!r.on);
          }
          return say(out.say || 'تمام', null);
        } catch { return say('معرفتش أوصل لجيميناي، اتأكدي من المفتاح والنت', 'error'); }
      }
      say('مش فاهمة قصدك. جرّبي: «افتحي نور الصالة» أو «فكريني بدواء الضغط الساعة 8» أو «فين المفتاح؟»', 'no_understand');
  }
}

/* ---------- التعرّف على الصوت ---------- */
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null;
function stopListening() { try { rec && rec.stop(); } catch { /* ignore */ } }
function listen() {
  if (!SR) { toast('المتصفح ده مش بيدعم الميكروفون، اكتبي الأمر في الخانة'); $('#txtIn').focus(); return; }
  if (rec) { stopListening(); return; }
  try { speechSynthesis.cancel(); } catch { /* ignore */ }
  rec = new SR(); rec.lang = 'ar-EG'; rec.interimResults = true; rec.maxAlternatives = 1; rec.continuous = false;
  let finalText = '', interimIdx = -1;
  rec.onstart = () => { $('#mic').classList.add('rec'); $('#micHint').textContent = 'بسمعك… اتكلمي'; };
  rec.onresult = e => {
    let txt = ''; let fin = false;
    for (let i = e.resultIndex; i < e.results.length; i++) { txt += e.results[i][0].transcript; if (e.results[i].isFinal) fin = true; }
    if (fin) finalText = txt;
    if (interimIdx < 0) { chatMsgs.push({ who: 'me', text: txt, interim: true }); interimIdx = chatMsgs.length - 1; }
    else chatMsgs[interimIdx].text = txt;
    renderChat();
  };
  rec.onerror = e => {
    const m = { 'not-allowed': 'الميكروفون ممنوع. اسمحي بيه من إعدادات المتصفح.', 'service-not-allowed': 'الميكروفون ممنوع. اسمحي بيه من إعدادات المتصفح.',
      'no-speech': 'مسمعتش حاجة، ممكن تعيدي؟', 'network': 'التعرّف على الصوت محتاج إنترنت دلوقتي. اكتبي الأمر.', 'audio-capture': 'مش لاقية ميكروفون.' };
    toast(m[e.error] || 'حصل خطأ في الميكروفون');
  };
  rec.onend = () => {
    $('#mic').classList.remove('rec'); $('#micHint').textContent = 'اضغط المايك وقل: «يا فيورا، افتحي نور الصالة»';
    if (interimIdx >= 0) { chatMsgs.splice(interimIdx, 1); persistChat(); renderChat(); }
    rec = null;
    if (finalText) handleText(finalText);
  };
  try { rec.start(); } catch { rec = null; }
}

/* ---------- الطقس ---------- */
function wDesc(c) {
  if (c === 0) return ['صافي', '☀️']; if (c <= 2) return ['غائم جزئياً', '⛅']; if (c === 3) return ['غائم', '☁️'];
  if (c <= 48) return ['ضباب', '🌫️']; if (c <= 67) return ['مطر', '🌧️']; if (c <= 77) return ['ثلج', '❄️'];
  if (c <= 82) return ['زخات مطر', '🌦️']; return ['عاصفة', '⛈️'];
}
async function fetchWeather(lat = 30.04, lon = 31.24, place = 'القاهرة') {
  try {
    const r = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,weather_code&timezone=auto`);
    const j = await r.json(); const c = j.current; const [desc, em] = wDesc(c.weather_code);
    weather = { temp: Math.round(c.temperature_2m), hum: Math.round(c.relative_humidity_2m), desc, em, place, lat, lon, at: Date.now() };
    store.set('weather', weather); renderHome();
  } catch { /* نعرض آخر قراءة محفوظة */ }
}
function myWeather() {
  if (!navigator.geolocation) return toast('الموقع مش متاح على الجهاز ده');
  navigator.geolocation.getCurrentPosition(p => { fetchWeather(p.coords.latitude, p.coords.longitude, 'موقعك'); toast('اتحدّث الطقس لموقعك'); }, () => toast('مقدرتش أحدد موقعك'), { timeout: 8000 });
}

/* ---------- الرئيسية ---------- */
function renderPill() {
  const p = $('#pill');
  const t = { demo: ['تجريبي', 'demo'], http: linkState === 'bad' ? ['غير متصل', 'bad'] : ['HTTP', 'live'],
    mqtt: linkState === 'ok' ? ['متصل بنيكسارا', 'live'] : linkState === 'connecting' ? ['بيتصل…', 'demo'] : ['غير متصل', 'bad'] }[S.mode];
  p.textContent = t[0]; p.className = 'pill ' + t[1];
}
function renderHome() {
  const el = $('#tab-home');
  const active = channels.filter(c => c.on).length;
  const w = weather ? `<div><strong>${weather.temp}°</strong><div class="sub">${esc(weather.place)} · ${esc(weather.desc)} · رطوبة ${weather.hum}%</div></div><div class="em">${weather.em}</div>`
    : '<div class="sub">اضغطي لتحميل الطقس</div>';
  el.innerHTML = `
    <h1>${S.userName ? `أهلاً يا ${esc(S.userName)} 👋` : 'أهلاً بيك 👋'}</h1>
    <div class="sub">${active ? `${active} قنوات شغّالة` : 'كل القنوات مقفولة'}${S.mode === 'demo' ? ' · وضع تجريبي (مش متصل بالجهاز)' : ''}</div>
    <div class="card weather" id="wcard" style="margin-top:12px">${w}</div>
    <div class="tools"><button class="btn sm" data-act="all-on" type="button">تشغيل الكل</button><button class="btn ghost sm" data-act="all-off" type="button">إيقاف الكل</button></div>
    <div class="grid">${channels.map((c, i) => `
      <div class="ch${c.on ? ' on' : ''}" data-ch="${i}" role="switch" aria-checked="${c.on}" tabindex="0">
        <button class="ed" data-ren="${i}" type="button" aria-label="تغيير الاسم"><svg viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16z"/></svg></button>
        <div class="n">قناة ${i + 1}</div><div class="t">${esc(c.name)}</div><div class="sw"></div>
      </div>`).join('')}</div>`;
}

/* ---------- الذاكرة والتذكيرات ---------- */
const TYPES = ['دواء', 'موعد', 'تذكير', 'مكان', 'اسم', 'ملاحظة'];
const tagCls = t => ({ 'دواء': 'med', 'موعد': 'apt', 'تذكير': 'apt', 'مكان': 'plc' }[t] || '');
let memQ = '';
function renderMemory() {
  const el = $('#tab-memory');
  let items = memory.slice();
  if (memQ) { const hits = L.searchMemory(memQ, items); items = hits.length ? hits : items.filter(m => (m.title + m.detail).includes(memQ)); }
  items.sort((a, b) => TYPES.indexOf(a.type) - TYPES.indexOf(b.type));
  el.innerHTML = `
    <div class="row"><h1>ذاكرة فيورا</h1><button class="btn sm" data-act="mem-add" type="button">+ إضافة</button></div>
    <div class="sub">الذاكرة محفوظة على موبايلك أنت فقط.</div>
    <input class="search rtl" id="memSearch" type="search" placeholder="دوّري في الذاكرة… مثلاً: المفتاح" value="${esc(memQ)}">
    ${items.length ? items.map(m => `
      <div class="item" data-mem="${m.id}">
        <div class="l1"><b>${esc(m.title)}</b><span class="tag ${tagCls(m.type)}">${esc(m.type)}</span></div>
        <small>${esc(m.detail || '')}${m.time ? `${m.detail ? ' · ' : ''}${m.daily ? 'كل يوم' : esc(m.date || '')} · ${L.fmtTime(m.time)}` : ''}</small>
      </div>`).join('') : `<div class="empty">${memQ ? 'مفيش نتيجة' : 'لسه مفيش حاجة. قولي لفيورا: «افتكري إن المفتاح في الدرج التاني»'}</div>`}`;
}
function editItem(item, isNew) {
  const it = Object.assign({ id: uid(), type: 'ملاحظة', title: '', detail: '', time: '', date: '', daily: false }, item);
  openSheet(`
    <h3>${isNew ? 'حفظ في الذاكرة' : 'تعديل'}</h3>
    <div class="f"><label>النوع</label><select id="fType" class="rtl">${TYPES.map(t => `<option${t === it.type ? ' selected' : ''}>${t}</option>`).join('')}</select></div>
    <div class="f"><label>العنوان</label><input id="fTitle" class="rtl" type="text" value="${esc(it.title)}"></div>
    <div class="f"><label>تفاصيل (اختياري)</label><input id="fDetail" class="rtl" type="text" value="${esc(it.detail)}"></div>
    <div class="two">
      <div class="f"><label>وقت التذكير</label><input id="fTime" type="time" value="${esc(it.time || '')}"></div>
      <div class="f"><label>التاريخ</label><input id="fDate" type="date" value="${esc(it.date || '')}"></div>
    </div>
    <label class="chk"><input id="fDaily" type="checkbox"${it.daily ? ' checked' : ''}> يتكرر كل يوم</label>
    <div class="note m">راجعي الوقت صباحاً/مساءً قبل التأكيد، لأن الكلام ممكن يتفهم غلط. التذكير بيرنّ والتطبيق مفتوح.</div>
    <div class="acts">
      <button class="btn" id="fOk" type="button">${isNew ? 'تأكيد' : 'حفظ'}</button>
      ${isNew ? '' : '<button class="btn danger" id="fDel" type="button">حذف</button>'}
      <button class="btn ghost" id="fNo" type="button">إلغاء</button>
    </div>`, () => {
    $('#fNo').onclick = () => { closeSheet(); if (isNew) say('تمام، مش هحفظ', 'ok'); };
    if (!isNew) $('#fDel').onclick = () => { memory = memory.filter(m => m.id !== it.id); saveMem(); renderMemory(); closeSheet(); };
    $('#fOk').onclick = () => {
      const title = $('#fTitle').value.trim(); if (!title) { toast('اكتبي عنوان'); return; }
      const time = $('#fTime').value; const daily = $('#fDaily').checked; let date = $('#fDate').value;
      if (time && !daily && !date) { const n = new Date(); const [h, m] = time.split(':').map(Number); date = L.dateKey((h * 60 + m) <= n.getHours() * 60 + n.getMinutes() ? new Date(n.getTime() + 864e5) : n); }
      Object.assign(it, { type: $('#fType').value, title, detail: $('#fDetail').value.trim(), time, date: daily ? '' : date, daily, last: '' });
      const k = memory.findIndex(m => m.id === it.id);
      if (k >= 0) memory[k] = it; else { it.created = Date.now(); memory.push(it); }
      saveMem(); renderMemory(); closeSheet();
      if (time) askNotif();
      if (isNew) say('اتحفظ ✅', 'saved');
    };
  });
}
function askNotif() {
  if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission().catch(() => {});
}
function checkReminders() {
  const now = new Date(); const today = L.dateKey(now); const nm = now.getHours() * 60 + now.getMinutes();
  let changed = false;
  for (const m of memory) {
    if (!m.time || m.last === today) continue;
    if (!(m.daily || m.date === today)) continue;
    const [h, mi] = m.time.split(':').map(Number); const diff = nm - (h * 60 + mi);
    if (diff >= 0 && diff < 10) {
      m.last = today; changed = true;
      const text = `معاد ${m.title}`;
      addMsg('her', '⏰ ' + text); speak(text, null);
      if ('Notification' in window && Notification.permission === 'granted') {
        navigator.serviceWorker.ready.then(r => r.showNotification('فيورا', { body: text, tag: m.id, icon: 'icons/icon-192.png', dir: 'rtl', lang: 'ar', vibrate: [200, 100, 200] })).catch(() => {});
      }
    }
  }
  if (changed) saveMem();
}

/* ---------- وضع الحماية (أنا مسافر) ---------- */
let vac = Object.assign({ on: false, chs: [0, 1], from: 18, to: 24 }, store.get('vac', {}));
let vacNext = 0, vacTouched = false;
const saveVac = () => store.set('vac', vac);
function vacTick() {
  if (!vac.on || !vac.chs.length) return;
  const d = new Date(), h = d.getHours() + d.getMinutes() / 60;
  if (h < vac.from || h >= vac.to) {
    if (vacTouched) { vacTouched = false; vac.chs.forEach(i => setChannel(i, false)); addLog('وضع الحماية: قفلت الأنوار بنهاية الفترة'); }
    return;
  }
  if (Date.now() < vacNext) return;
  vacNext = Date.now() + (3 + Math.random() * 9) * 60000;
  const i = vac.chs[Math.floor(Math.random() * vac.chs.length)];
  vacTouched = true; setChannel(i, !channels[i].on);
}
setInterval(vacTick, 30000);

/* ---------- المشاهد والسجل ---------- */
function renderScenes() {
  const el = $('#tab-scenes');
  const names = sc => sc.states.map((s, i) => (s ? channels[i].name : null)).filter(Boolean);
  el.innerHTML = `
    <div class="row"><h1>المشاهد</h1><button class="btn sm" data-act="scene-save" type="button">حفظ الوضع الحالي</button></div>
    <div class="sub">المشهد بيضبط كل القنوات بلمسة. جهّزي الأنوار زي ما تحبي من الرئيسية، وبعدين احفظيه.</div>
    <div style="margin-top:12px">${scenes.map(sc => `
      <div class="item scene"><div class="info"><b>${esc(sc.name)}</b><small>${names(sc).length ? 'شغّال: ' + esc(names(sc).join('، ')) : 'كله مقفول'}</small></div>
        <div class="acts"><button class="btn sm" data-scene="${sc.id}" type="button">تشغيل</button><button class="btn ghost sm" data-scene-del="${sc.id}" type="button">حذف</button></div></div>`).join('')}</div>
    <h2>🛡️ وضع الحماية: أنا مسافر</h2>
    <div class="card"><div class="row"><div><b>${vac.on ? 'شغّال' : 'مقفول'}</b>
      <div class="sub">الأنوار بتشتغل وتقفل بشكل عشوائي بين ${vac.from}:00 و${vac.to >= 24 ? 'منتصف الليل' : vac.to + ':00'} كأن في حد في البيت. بيشتغل والتطبيق مفتوح.</div></div>
      <button class="btn sm ${vac.on ? '' : 'ghost'}" data-act="vac-toggle" type="button">${vac.on ? 'إيقاف' : 'تفعيل'}</button></div>
      <div class="sub" style="margin:10px 0 6px">القنوات اللي تتحرك:</div>
      <div class="seg" style="flex-wrap:wrap">${channels.map((c, i) => `<button type="button" data-act="vac-ch" data-i="${i}" class="${vac.chs.includes(i) ? 'on' : ''}">${esc(c.name)}</button>`).join('')}</div></div>
    <h2>سجل التشغيل</h2>
    <div class="log">${log.length ? log.slice(0, 25).map(l => `<div>${new Date(l.t).toLocaleString('ar-EG', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })} · ${esc(l.text)}</div>`).join('') : '<div class="empty">لسه مفيش تشغيل</div>'}</div>`;
}

/* ---------- الإعدادات ---------- */
let deferredInstall = null;
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferredInstall = e; renderSettings(); });
const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
const isStandalone = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || navigator.standalone;
function voiceSettingsHtml() {
  if (!('speechSynthesis' in window)) return '<div class="note m">المتصفح ده مش بيدعم الصوت.</div>';
  const vs = speechSynthesis.getVoices();
  const ar = vs.filter(v => /^ar/i.test(v.lang)), other = vs.filter(v => !/^ar/i.test(v.lang));
  const opt = v => `<option value="${esc(v.name)}"${(arVoice && arVoice.name === v.name) ? ' selected' : ''}>${esc(v.name)} (${esc(v.lang)})</option>`;
  const warn = ar.length ? '' : '<div class="note m" style="border-color:#5a4410;color:var(--warn)">مفيش صوت عربي على الموبايل ده، علشان كده النطق بيطلع غلط. نزّلي صوت عربي: إعدادات الموبايل ← اللغة ← تحويل النص إلى كلام ← محرك Google ← تثبيت بيانات الصوت ← العربية (مصر) أو العربية. وبعدين افتحي التطبيق تاني.</div>';
  return `<div class="set"><label>صوت فيورا</label>
    <select data-set="voiceName"><option value="">تلقائي (أفضل صوت عربي)</option>${ar.length ? '<optgroup label="عربي">' + ar.map(opt).join('') + '</optgroup>' : ''}${other.length ? '<optgroup label="أصوات تانية">' + other.map(opt).join('') + '</optgroup>' : ''}</select></div>
    <div class="set"><label>سرعة الكلام: ${esc(String(S.rate))}</label><input data-set="rate" type="range" min="0.6" max="1.3" step="0.05" value="${esc(String(S.rate))}"></div>
    <div class="row" style="justify-content:flex-start"><button class="btn ghost sm" data-act="voice-test" type="button">اسمعي الصوت</button></div>${warn}`;
}

function renderSettings() {
  const el = $('#tab-settings');
  el.innerHTML = `
    <h1>الإعدادات</h1>
    ${!isStandalone ? `<div class="card" style="margin:10px 0">${deferredInstall
      ? '<div class="row"><span>ثبّتي فيورا على الشاشة الرئيسية</span><button class="btn sm" data-act="install" type="button">تثبيت</button></div>'
      : isIOS ? '<span class="sub">على الآيفون: اضغطي زر المشاركة ثم «إضافة إلى الشاشة الرئيسية».</span>'
        : '<span class="sub">من قائمة المتصفح (⋮) اختاري «تثبيت التطبيق» أو «إضافة إلى الشاشة الرئيسية».</span>'}</div>` : ''}
    <div class="set"><label>اسمك</label><input class="rtl" data-set="userName" type="text" value="${esc(S.userName)}" placeholder="مثلاً: أحمد"></div>
    <h2>الاتصال بنيكسارا</h2>
    <div class="set"><div class="seg" id="modeSeg">
      <button data-mode="demo" type="button" class="${S.mode === 'demo' ? 'on' : ''}">تجريبي</button>
      <button data-mode="http" type="button" class="${S.mode === 'http' ? 'on' : ''}">HTTP</button>
      <button data-mode="mqtt" type="button" class="${S.mode === 'mqtt' ? 'on' : ''}">MQTT</button></div></div>
    ${S.mode === 'demo' ? '<div class="note">في الوضع التجريبي الأزرار بتشتغل على الشاشة بس ومبتبعتش أي حاجة للجهاز.</div>' : ''}
    ${S.mode === 'http' ? `
      <div class="set"><label>عنوان الأمر (استخدمي {n} لرقم القناة و{state} لـ on/off)</label><input data-set="httpTpl" type="url" value="${esc(S.httpTpl)}"></div>
      <div class="note">المتصفح بيمنع صفحة HTTPS من مناداة عنوان HTTP على شبكتك. الوضع ده بيشتغل بس لو التطبيق نفسه مفتوح من عنوان http داخل البيت. للاستخدام العادي استخدمي MQTT.</div>` : ''}
    ${S.mode === 'mqtt' ? `
      <div class="set"><label>عنوان الـ Broker (WebSocket آمن)</label><input data-set="mqttUrl" type="url" value="${esc(S.mqttUrl)}" placeholder="wss://xxxx.s1.eu.hivemq.cloud:8884/mqtt"></div>
      <div class="set"><label>اسم المستخدم</label><input data-set="mqttUser" type="text" value="${esc(S.mqttUser)}"></div>
      <div class="set"><label>كلمة المرور</label><input data-set="mqttPass" type="password" value="${esc(S.mqttPass)}"></div>
      <div class="set"><label>بادئة القنوات</label><input data-set="prefix" type="text" value="${esc(S.prefix)}"></div>
      <button class="btn ghost sm" data-act="mqtt-test" type="button">اختبار الاتصال</button>
      <div class="code">أمر: ${esc(S.prefix)}/ch1/set ← ON | OFF<br>حالة: ${esc(S.prefix)}/ch1/state ← ON | OFF</div>` : ''}
    <h2>الصوت</h2>
    <div class="set"><label class="chk"><input data-chk="voice" type="checkbox"${S.voice ? ' checked' : ''}> فيورا ترد بالصوت</label>
    ${voiceSettingsHtml()}
      <div class="note m">لو حطيتي ملفات MP3 في فولدر audio بتتشغّل بصوت فيورا، وغير كده بيتنطق الرد بصوت الجهاز.</div></div>
    <h2>ذكاء حر (اختياري)</h2>
    <div class="set"><label>مفتاح Gemini</label><input data-set="geminiKey" type="password" value="${esc(S.geminiKey)}" placeholder="من Google AI Studio"></div>
    <div class="set"><label>اسم النموذج</label><input data-set="geminiModel" type="text" value="${esc(S.geminiModel)}"></div>
    <div class="note m">الأوامر الأساسية والذاكرة شغّالة من غيره. لو أضفتيه، الجمل اللي مش مفهومة محليّاً بتتبعت لجوجل (نص الجملة بس، من غير ذاكرتك).</div>
    <h2>نسخة احتياطية</h2>
    <div class="row" style="justify-content:flex-start"><button class="btn ghost sm" data-act="export" type="button">تصدير</button><button class="btn ghost sm" data-act="import" type="button">استيراد</button>
      <button class="btn danger sm" data-act="reset" type="button">مسح كل شيء</button></div>
    <input id="impFile" type="file" accept="application/json" hidden>
    <div class="note m" style="margin-top:14px">الذاكرة والإعدادات محفوظة في متصفح موبايلك. لو مسحتي بيانات المتصفح بتضيع، فاعملي تصدير من وقت لوقت.</div>`;
}

/* ---------- Sheet ---------- */
function openSheet(html, mount) { $('#sheet').innerHTML = html; $('#sheetWrap').hidden = false; if (mount) mount(); }
function closeSheet() { $('#sheetWrap').hidden = true; $('#sheet').innerHTML = ''; }
$('#sheetWrap').addEventListener('pointerdown', e => { if (e.target.id === 'sheetWrap') closeSheet(); });

/* ---------- الأحداث ---------- */
function go(tab) {
  $$('.tab').forEach(s => { s.hidden = s.dataset.tab !== tab; });
  $$('#nav button').forEach(b => b.classList.toggle('on', b.dataset.go === tab));
  try {
    if (tab === 'memory') renderMemory(); if (tab === 'scenes') renderScenes(); if (tab === 'settings') renderSettings(); if (tab === 'viora') renderChat();
  } catch (err) {
    const el = $('#tab-' + tab); if (el) el.innerHTML = '<div class="card"><b>حصل خطأ في الشاشة دي</b><div class="sub" dir="ltr" style="margin-top:8px">' + esc(String(err && err.message || err)) + '</div><div class="sub" style="margin-top:8px">صوّري الشاشة وابعتيها لي.</div></div>';
  }
}
document.addEventListener('click', async e => {
  const t = e.target;
  const nav = t.closest('[data-go]'); if (nav) return go(nav.dataset.go);
  if (t.closest('#pill')) return go('settings');
  const ren = t.closest('[data-ren]');
  if (ren) { e.stopPropagation(); const i = +ren.dataset.ren; const n = prompt('اسم القناة', channels[i].name); if (n && n.trim()) { channels[i].name = n.trim(); saveCh(); renderHome(); } return; }
  const ch = t.closest('[data-ch]');
  if (ch) { const i = +ch.dataset.ch; ch.classList.add('busy'); const ok = await setChannel(i, !channels[i].on); if (!ok) toast('مش قادرة أوصل لنيكسارا'); return; }
  if (t.closest('#wcard')) { fetchWeather(weather?.lat, weather?.lon, weather?.place); return myWeather(); }
  const opt = t.closest('[data-opt]');
  if (opt) { const [i, k] = opt.dataset.opt.split(':').map(Number); const o = chatMsgs[i]?.opts?.[k]; if (o) { chatMsgs[i].opts = null; renderChat(); o.fn(); } return; }
  const mem = t.closest('[data-mem]'); if (mem) return editItem(memory.find(m => m.id === mem.dataset.mem), false);
  const sc = t.closest('[data-scene]'); if (sc) return runScene(scenes.find(s => s.id === sc.dataset.scene));
  const scd = t.closest('[data-scene-del]');
  if (scd) { if (confirm('حذف المشهد؟')) { scenes = scenes.filter(s => s.id !== scd.dataset.sceneDel); saveScenes(); renderScenes(); } return; }
  const md = t.closest('[data-mode]');
  if (md) { S.mode = md.dataset.mode; saveS(); linkState = 'idle'; renderPill(); renderSettings(); if (S.mode === 'mqtt' && S.mqttUrl) mqttConnect().catch(() => {}); return; }
  const act = t.closest('[data-act]'); if (!act) return;
  switch (act.dataset.act) {
    case 'all-on': return runRelay(channels.map((_, i) => i), true);
    case 'all-off': return runRelay(channels.map((_, i) => i), false);
    case 'mem-add': return editItem({}, true);
    case 'scene-save': {
      const n = prompt('اسم المشهد'); if (!n || !n.trim()) return;
      scenes.push({ id: uid(), name: n.trim(), states: channels.map(c => c.on) }); saveScenes(); renderScenes(); return toast('اتحفظ المشهد');
    }
    case 'vac-toggle': vac.on = !vac.on; vacNext = 0; if (!vac.on) vacTouched = false; saveVac(); addLog(vac.on ? 'تفعيل وضع الحماية' : 'إيقاف وضع الحماية'); renderScenes(); return;
    case 'vac-ch': { const i = +act.dataset.i; vac.chs = vac.chs.includes(i) ? vac.chs.filter(x => x !== i) : vac.chs.concat(i); saveVac(); renderScenes(); return; }
    case 'voice-test': pickVoice(); return tts('أهلاً، أنا فيورا. بتحكّم في نيكسارا وبفكّرك بمواعيدك.');
    case 'install': if (deferredInstall) { deferredInstall.prompt(); deferredInstall = null; } return;
    case 'mqtt-test': try { await mqttConnect(); toast('اتصلت بالـ Broker ✅'); } catch { toast('مقدرتش أتصل، راجعي العنوان والبيانات'); } return;
    case 'export': {
      const blob = new Blob([JSON.stringify({ v: 1, channels, settings: { ...S, geminiKey: '', mqttPass: '' }, memory, scenes }, null, 2)], { type: 'application/json' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'viora-backup.json'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000); return;
    }
    case 'import': return $('#impFile').click();
    case 'reset': if (confirm('هتمسحي الذاكرة والإعدادات كلها. متأكدة؟')) { try { Object.keys(localStorage).filter(k => k.startsWith('viora.')).forEach(k => localStorage.removeItem(k)); } catch { /* ignore */ } location.reload(); } return;
  }
});
document.addEventListener('input', e => {
  const t = e.target;
  if (t.id === 'memSearch') { memQ = t.value.trim(); const pos = t.selectionStart; renderMemory(); const n = $('#memSearch'); n.focus(); n.setSelectionRange(pos, pos); return; }
  if (t.dataset.set) { S[t.dataset.set] = t.value.trim(); saveS(); if (t.dataset.set === 'userName') renderHome(); if (t.dataset.set === 'voiceName' || t.dataset.set === 'rate') pickVoice(); }
});
document.addEventListener('change', e => {
  const t = e.target;
  if (t.dataset.chk) { S[t.dataset.chk] = t.checked; saveS(); }
  if (t.id === 'impFile' && t.files[0]) {
    t.files[0].text().then(txt => {
      try {
        const d = JSON.parse(txt);
        if (Array.isArray(d.channels) && d.channels.length === 6) { channels = d.channels; saveCh(); }
        if (d.settings) { S = Object.assign(S, d.settings, { geminiKey: S.geminiKey, mqttPass: S.mqttPass }); saveS(); }
        if (Array.isArray(d.memory)) { memory = d.memory; saveMem(); }
        if (Array.isArray(d.scenes)) { scenes = d.scenes; saveScenes(); }
        renderHome(); renderSettings(); renderPill(); toast('اتستورد بنجاح');
      } catch { toast('الملف مش صالح'); }
    });
  }
});
document.addEventListener('keydown', e => { if ((e.key === 'Enter' || e.key === ' ') && e.target.matches?.('[data-ch]')) { e.preventDefault(); e.target.click(); } });
$('#mic').addEventListener('click', listen);
$('#txtForm').addEventListener('submit', e => { e.preventDefault(); const i = $('#txtIn'); const v = i.value; i.value = ''; handleText(v); });

/* ---------- تشغيل ---------- */
renderPill(); renderHome(); renderChat();
if (!weather || Date.now() - (weather.at || 0) > 30 * 60 * 1000) fetchWeather(weather?.lat, weather?.lon, weather?.place);
if (S.mode === 'mqtt' && S.mqttUrl) mqttConnect().catch(() => {});
setInterval(checkReminders, 15000); checkReminders();
document.addEventListener('visibilitychange', () => { if (!document.hidden) checkReminders(); });
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

window.addEventListener('error', e => { try { toast('خطأ: ' + (e.message || '').slice(0, 80), 6000); } catch {} });
