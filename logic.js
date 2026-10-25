/* منطق فهم الأوامر بالمصري — بدون أي اعتماد على المتصفح، علشان يتجرّب لوحده */
(function (root) {
'use strict';

const AR_DIGITS = '٠١٢٣٤٥٦٧٨٩';
const pad = n => String(n).padStart(2, '0');

function norm(s) {
  return String(s || '')
    .replace(/[٠-٩]/g, d => AR_DIGITS.indexOf(d))
    .replace(/[ً-ٰٟـ]/g, '')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/[؟?!.,،"«»()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

const SYN = {
  'غرفه': 'اوضه', 'صالون': 'صاله', 'تكيف': 'تكييف', 'مكيف': 'تكييف', 'انوار': 'نور', 'اضاءه': 'نور',
  'ضوء': 'نور', 'لمبه': 'نور', 'لمبات': 'نور', 'هيتر': 'سخان', 'فان': 'مروحه', 'مراوح': 'مروحه'
};

function stem(w) {
  if (w.length > 3 && w.startsWith('ال')) w = w.slice(2);
  if (w.length > 3 && w.endsWith('ي')) w = w.slice(0, -1);
  return SYN[w] || w;
}
const tokenize = s => norm(s).split(' ').filter(Boolean);

const ON_V = new Set(['افتح', 'افتحي', 'فتح', 'شغل', 'شغلي', 'ولع', 'ولعي', 'نوري', 'اوقد', 'اضيء', 'فعل', 'فعلي']);
const OFF_V = new Set(['اقفل', 'اقفلي', 'قفل', 'اطفي', 'اطفيه', 'طفي', 'وقف', 'وقفي', 'افصل', 'افصلي', 'فصل', 'اغلق', 'اغلقي', 'سكر', 'سكري']);
const ALL_W = new Set(['كل', 'كله', 'كلها', 'جميع']);

function matchRelay(tokens, channels) {
  const toks = tokens.map(stem);
  const all = toks.some(w => ALL_W.has(w));
  const scores = channels.map(c => tokenize(c.name).map(stem).filter(w => toks.includes(w)).length);
  const max = Math.max(0, ...scores);
  if (max === 0) return all ? { idx: channels.map((_, i) => i) } : null;
  if (all) return { idx: scores.map((s, i) => (s > 0 ? i : -1)).filter(i => i >= 0) };
  const idx = scores.map((s, i) => (s === max ? i : -1)).filter(i => i >= 0);
  return idx.length > 1 ? { idx, ambiguous: true } : { idx };
}

/* ---------- الحفظ ---------- */
const SAVE_RE = /^(افتكر|افتكري|فكرني|فكريني|ذكرني|ذكريني|نبهني|نبهيني|احفظ|احفظي|سجل|سجلي|اكتب|اكتبي|ضيف|ضيفي)(\s|$)/;
const WORDNUM = { 'واحده': 1, 'وحده': 1, 'اتنين': 2, 'اثنين': 2, 'ثنتين': 2, 'تلاته': 3, 'ثلاثه': 3, 'اربعه': 4, 'خمسه': 5, 'سته': 6,
  'سبعه': 7, 'تمانيه': 8, 'ثمانيه': 8, 'تسعه': 9, 'عشره': 10, 'احداشر': 11, 'اتناشر': 12 };
const WEEKDAYS = { 'الاحد': 0, 'الاتنين': 1, 'الاثنين': 1, 'التلات': 2, 'التلاتاء': 2, 'الثلاثاء': 2, 'الاربع': 3, 'الاربعاء': 3,
  'الخميس': 4, 'الجمعه': 5, 'السبت': 6 };
const PM_RE = /(مساء|بالليل|الليل|العصر|بعد الظهر|عشيه|المغرب|العشا)/;
const AM_RE = /(صباح|الصبح|الفجر|الضحي)/;
const MED_RE = /(دواء|دوا|دوايا|ادويه|حبوب|حبايه|قرص|علاج|انسولين|فيتامين)/;
const APPT_RE = /(ميعاد|موعد|اجتماع|دكتور|مقابله|حجز|امتحان|مناسبه|عيد ميلاد)/;

const dateKey = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };

function parseSave(t, now) {
  now = now || new Date();
  let rest = t.replace(SAVE_RE, '').replace(/^(ان|اني|انى)\s+/, '').trim();
  rest = rest.replace(/(?:الساعه|ساعه)\s+(\S+)/, (m, w) => (WORDNUM[w] ? `الساعه ${WORDNUM[w]}` : m));

  // الوقت
  let h = null, mi = 0;
  const tm = rest.match(/(?:الساعه|ساعه)\s*(\d{1,2})(?:\s*[:.]\s*(\d{2}))?/) || rest.match(/(\d{1,2})\s*:\s*(\d{2})/);
  if (tm) {
    h = +tm[1]; mi = tm[2] ? +tm[2] : 0;
    rest = rest.replace(tm[0], ' ');
    if (/(?:^|\s)(?:و|ال)?نص(?:\s|$)/.test(rest)) { mi = 30; rest = rest.replace(/(?:^|\s)(?:و|ال)?نص(?=\s|$)/, ' '); }
    else if (/(?:^|\s)وربع(?:\s|$)/.test(rest)) { mi = 15; rest = rest.replace(/وربع/, ' '); }
    const pm = PM_RE.test(rest), am = AM_RE.test(rest);
    if (h <= 12) {
      if (pm && h < 12) h += 12;
      else if (am && h === 12) h = 0;
      else if (!pm && !am && h >= 1 && h <= 6) h += 12; // 6 من غير تحديد → غالباً مساءً (المستخدم بيراجع)
    }
  }
  rest = rest.replace(PM_RE, ' ').replace(AM_RE, ' ');

  // اليوم
  let date = null;
  if (/(?:^|\s)(بكره|غدا)(?:\s|$)/.test(rest)) { date = dateKey(addDays(now, 1)); rest = rest.replace(/(?:^|\s)(بكره|غدا)(?=\s|$)/, ' '); }
  else if (/(النهارده|انهارده|الليله)/.test(rest)) { date = dateKey(now); rest = rest.replace(/(النهارده|انهارده|الليله)/, ' '); }
  else {
    for (const [w, n] of Object.entries(WEEKDAYS)) {
      const re = new RegExp('(?:^|\\s)' + w + '(?=\\s|$)');
      if (re.test(rest)) {
        let diff = (n - now.getDay() + 7) % 7;
        if (diff === 0 && h !== null && (h * 60 + mi) <= now.getHours() * 60 + now.getMinutes()) diff = 7;
        date = dateKey(addDays(now, diff)); rest = rest.replace(re, ' '); break;
      }
    }
  }
  let daily = false;
  if (/(كل يوم|يوميا)/.test(rest)) { daily = true; rest = rest.replace(/(كل يوم|يوميا)/, ' '); }

  rest = rest.replace(/\s+/g, ' ').trim();
  let type = 'ملاحظة', title = rest, detail = '';

  const nameM = rest.match(/^(.+?)\s+اسم(?:ه|ها|ي)\s+(.+)$/);
  const placeM = rest.match(/^(.+?)\s+(في|فى|جوه|جوا|عند)\s+(.+)$/);
  if (nameM) { type = 'اسم'; title = nameM[1]; detail = nameM[2]; }
  else if (MED_RE.test(rest)) { type = 'دواء'; if (!date && h !== null) daily = true; }
  else if (APPT_RE.test(rest)) { type = 'موعد'; }
  else if (h !== null) { type = 'تذكير'; }
  else if (placeM) { type = 'مكان'; title = placeM[1]; detail = placeM[2] + ' ' + placeM[3]; }

  title = title.replace(/^ب(?=دواء|دوا|ميعاد|موعد)/, '').replace(/^(ان|اللي)\s+/, '');
  if (type === 'موعد') title = title.replace(/^(ميعاد|موعد)\s+/, '');
  title = title.trim() || rest;

  let time = null;
  if (h !== null) {
    time = `${pad(h % 24)}:${pad(mi)}`;
    if (!daily && !date) date = dateKey((h * 60 + mi) <= now.getHours() * 60 + now.getMinutes() ? addDays(now, 1) : now);
  }
  return { type, title, detail, time, date: daily ? '' : (date || ''), daily };
}

function fmtTime(hhmm) {
  if (!hhmm) return '';
  const [H, M] = hhmm.split(':').map(Number);
  const per = H < 12 ? 'صباحاً' : 'مساءً';
  const h12 = H % 12 === 0 ? 12 : H % 12;
  return `${h12}:${pad(M)} ${per}`;
}

/* ---------- البحث في الذاكرة ---------- */
const STOP = new Set(['راح', 'حطيت', 'حطيته', 'كان', 'انا', 'اللي', 'بتاع', 'بتاعي', 'ياتري', 'فين', 'وين', 'اين', 'في', 'من']);
function searchMemory(q, memory) {
  const qt = tokenize(q).map(stem).filter(w => !STOP.has(w));
  if (!qt.length) return [];
  return memory
    .map(m => {
      const mt = tokenize(m.title + ' ' + (m.detail || '')).map(stem);
      return { m, s: qt.filter(w => mt.includes(w)).length };
    })
    .filter(x => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .map(x => x.m);
}

/* =====================================================================
   معلومات فيورا نفسها — عدّلي هنا بحرية
   - PERSONA: كلام فيورا عن نفسها.
   - KB: أسئلة وأجوبة ثابتة. كل سطر: [ تعبير يطابق السؤال (بعد التطبيع: من غير تشكيل، ة=ه، ى=ي) , الرد ]
   - الرد ممكن يبقى نص، أو دالة بترجّع نص.
   ===================================================================== */
const PERSONA = {
  name: 'فيورا',
  about: 'أنا فيورا، مساعدتك الصوتية بالمصري. بتحكّم في أجهزة البيت عن طريق نيكسارا، وبحفظ مواعيدك وأدويتك وأسماء الناس وأماكن حاجاتك، وبفكّرك بيها في وقتها.',
  maker: 'أنا جزء من منظومة نيكسارا للبيت الذكي.',
  abilities: 'أقدر أفتح وأقفل أجهزة البيت، وأشغّل المشاهد، وأحفظ المواعيد والأدوية والأسماء وأماكن الحاجات وأفكّرك بيها، وأقولك الساعة والتاريخ والجو. جرّبي تقولي: افتحي نور الصالة، أو فكريني بدواء الضغط الساعة 8.'
};
const CAPITALS = {
  'مصر': 'القاهرة', 'السعوديه': 'الرياض', 'الامارات': 'أبوظبي', 'الكويت': 'مدينة الكويت', 'قطر': 'الدوحة', 'البحرين': 'المنامة',
  'عمان': 'مسقط', 'الاردن': 'عمّان', 'لبنان': 'بيروت', 'سوريا': 'دمشق', 'العراق': 'بغداد', 'ليبيا': 'طرابلس', 'تونس': 'تونس',
  'الجزائر': 'الجزائر', 'المغرب': 'الرباط', 'السودان': 'الخرطوم', 'فرنسا': 'باريس', 'بريطانيا': 'لندن', 'انجلترا': 'لندن',
  'المانيا': 'برلين', 'ايطاليا': 'روما', 'اسبانيا': 'مدريد', 'تركيا': 'أنقرة', 'امريكا': 'واشنطن', 'اليابان': 'طوكيو',
  'الصين': 'بكين', 'الهند': 'نيودلهي', 'روسيا': 'موسكو', 'البرازيل': 'برازيليا', 'كندا': 'أوتاوا'
};
const DAYS_AR = ['الأحد', 'الاتنين', 'التلات', 'الأربع', 'الخميس', 'الجمعة', 'السبت'];
const MONTHS_AR = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];
const KB = [
  [/(اسمك|انتي مين|انت مين|مين انتي|مين انت|عرفي بنفسك|عرفيني بنفسك|عرفي نفسك|عرفينا بنفسك|قوليلي عن نفسك|احكي عن نفسك|اتكلمي عن نفسك|اتعرفي|عرفي بنفسك)/, () => PERSONA.about],
  [/(مين (عملك|صنعك|صممك|برمجك|اللي عملك)|مين صاحبك|مين مطورك|عملك مين)/, () => PERSONA.maker],
  [/(بتعملي ايه|تقدري تعملي ايه|بتعرفي تعملي ايه|ايه اللي تقدري|وظيفتك|مهامك|ايه مميزاتك|ساعديني)/, () => PERSONA.abilities],
  [/(عامله ايه|اخبارك|ازيك|عامل ايه)/, () => 'الحمد لله تمام. وانتي عامله ايه؟'],
  [/(عندك كام سنه|عمرك كام|كام سنه عمرك|عمرك)/, () => 'أنا برنامج، مفيش عندي عمر. بس أنا لسه جديدة.'],
  [/(انتي (بني ادم|انسان|روبوت|ست|بنت)|انتي حقيقيه)/, () => 'أنا مساعدة صوتية، مش بني آدم. بس بحاول أبقى قريبة منك.'],
  [/(بتحبي ايه|بتحبيني|بتحبي)/, () => 'أحب أشوف بيتك منوّر ومنظّم، وأفتكرلك مواعيدك.'],
  [/(النهارده ايه|انهارده ايه|النهارده كام|تاريخ النهارده|التاريخ ايه|ايه التاريخ|النهارده يوم ايه|يوم ايه النهارده)/,
    c => { const d = c.now; return `النهارده ${DAYS_AR[d.getDay()]} ${d.getDate()} ${MONTHS_AR[d.getMonth()]} ${d.getFullYear()}`; }],
  [/(عدد ايام الاسبوع|كام يوم في الاسبوع)/, () => 'الأسبوع سبعة أيام.'],
  [/(عدد شهور السنه|كام شهر في السنه)/, () => 'السنة اتناشر شهر.'],
  [/(كام كوكب|عدد الكواكب)/, () => 'المجموعة الشمسية فيها تمانية كواكب.'],
  [/(اكبر كوكب)/, () => 'أكبر كوكب هو المشتري.'],
  [/(اقرب كوكب للشمس)/, () => 'أقرب كوكب للشمس هو عطارد.'],
  [/(اطول نهر|اطول نهر في العالم)/, () => 'نهر النيل من أطول أنهار العالم، وبيعدّي في مصر.'],
  [/(اكبر محيط)/, () => 'أكبر محيط هو المحيط الهادي.'],
  [/(اعلي جبل|اعلى جبل)/, () => 'أعلى جبل في العالم هو جبل إفرست.'],
  [/(كام ثانيه في الدقيقه|كام ثانيه في الساعه)/, c => /الساعه/.test(c.t) ? 'في الساعة تلات تلاف وستميت ثانية.' : 'في الدقيقة ستين ثانية.'],
  [/(كام دقيقه في الساعه)/, () => 'في الساعة ستين دقيقة.']
];
function knowledge(t, now) {
  const ctx = { t, now: now || new Date() };
  const cm = t.match(/عاصم[هة]? (?:دوله )?(\S+)/);
  if (cm) {
    const w = cm[1];
    const city = CAPITALS[w] || CAPITALS['ال' + w] || CAPITALS[w.replace(/^ال/, '')];
    if (city) return `عاصمة ${w.length > 3 ? w.replace(/ه$/, 'ة') : w} هي ${city}.`;
  }
  for (const [re, ans] of KB) if (re.test(t)) return typeof ans === 'function' ? ans(ctx) : ans;
  return null;
}

/* ---------- الفهم ---------- */
function interpret(raw, ctx) {
  ctx = ctx || {};
  const channels = ctx.channels || [];
  const scenes = ctx.scenes || [];
  const now = ctx.now || new Date();

  const t = norm(raw).replace(/(^|\s)(يا )?(فيور[اهي]|viora)(?=\s|$)/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t) return { type: 'empty' };

  let m = t.match(/^(?:انا )?اسمي (.+)$/);
  if (m) return { type: 'setname', name: m[1] };

  if (SAVE_RE.test(t)) {
    const stripped = t.replace(SAVE_RE, '').replace(/^ان[يى]?\s+/, '');
    m = stripped.match(/^اسمي (.+)$/);
    if (m) return { type: 'setname', name: m[1] };
    return { type: 'save', item: parseSave(t, now) };
  }

  m = t.match(/^(.+?)\s+اسم(?:ه|ها)\s+(.+)$/);
  if (m) return { type: 'save', item: { type: 'اسم', title: m[1], detail: m[2], time: null, date: '', daily: false } };

  m = t.match(/^(?:فين|وين|اين)\s+(.+)$/) || t.match(/^(.+?)\s+(?:فين|وين)$/);
  if (m) return { type: 'find', q: m[1] };

  if (/(مواعيد|ميعاد|موعد)/.test(t) && /(ايه|اي|قولي|قوليلي|عندي)/.test(t)) return { type: 'list', kind: 'موعد' };
  if (/(ادويه|دوايا|ادويتي|دوائي|علاجي)/.test(t) && /(ايه|اي|قولي|قوليلي|عندي)/.test(t)) return { type: 'list', kind: 'دواء' };
  if (/تذكيرات/.test(t)) return { type: 'list', kind: 'all' };
  if (/(اسمي ايه|انا مين)/.test(t)) return { type: 'whoami' };
  if (/(الساعه كام|كام الساعه|الوقت كام)/.test(t)) return { type: 'time' };
  if (/(الجو|الطقس|درجه الحراره|الحر ده)/.test(t)) return { type: 'weather' };

  const kn = knowledge(t, now);
  if (kn) return { type: 'know', say: kn };

  // مشهد
  const tkey = tokenize(t).map(stem).join(' ');
  for (const s of scenes) {
    const sk = tokenize(s.name).map(stem).join(' ');
    if (sk && tkey.includes(sk)) return { type: 'scene', scene: s.id };
  }

  // تحكم في القنوات
  const tokens = t.split(' ');
  const off = tokens.some(w => OFF_V.has(w));
  const on = tokens.some(w => ON_V.has(w));
  if (on || off) {
    const r = matchRelay(tokens, channels);
    if (r) return r.ambiguous ? { type: 'ambiguous', idx: r.idx, on: !off } : { type: 'relay', idx: r.idx, on: !off };
    return { type: 'relay_unknown_device' };
  }

  if (/(شكرا|تسلمي|متشكر)/.test(t)) return { type: 'thanks' };
  if (/(صباح الخير|مساء الخير|ازيك|اهلا|مرحبا|هاي|السلام عليكم)/.test(t)) return { type: 'greet' };
  return { type: 'unknown', text: t };
}

const api = { knowledge, PERSONA, norm, stem, tokenize, interpret, parseSave, matchRelay, searchMemory, fmtTime, dateKey };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else root.VioraLogic = api;
})(typeof window !== 'undefined' ? window : globalThis);
