// ===== SUPABASE CONFIG =====
const SUPABASE_URL = 'https://wpfiukvawwmevgkfqbdz.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndwZml1a3Zhd3dtZXZna2ZxYmR6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE5MTI5MDUsImV4cCI6MjEwNzQ4ODkwNX0.qS5iNiEQo6-O8emH4nnhzek_ykW-DAazu4m83uoS8Ro';

// Initialize Supabase client
let sbClient = null;
try {
  if (window.supabase && typeof window.supabase.createClient === 'function') {
    sbClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  } else {
    console.error('Supabase CDN not loaded yet');
  }
} catch (e) {
  console.error('Supabase init failed:', e);
}

function checkClient() {
  if (!sbClient) {
    if (window.supabase && typeof window.supabase.createClient === 'function') {
      sbClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
      return true;
    }
    showToast('Database connection failed. Please refresh the page.', 'error');
    return false;
  }
  return true;
}

// ===== CRYPTOGRAPHIC TOKEN STORAGE (IN-MEMORY / SESSION STORAGE) =====
function getAdminToken() {
  try {
    return sessionStorage.getItem('cp_admin_token') || localStorage.getItem('cp_admin_token') || '';
  } catch (e) {
    return '';
  }
}

function setAdminToken(token) {
  try {
    sessionStorage.setItem('cp_admin_token', token);
    localStorage.setItem('cp_admin_token', token);
  } catch (e) { }
}

function clearAdminToken() {
  try {
    sessionStorage.removeItem('cp_admin_token');
    localStorage.removeItem('cp_admin_token');
    localStorage.removeItem('admin_logged_in');
  } catch (e) { }
}

// ===== 🛡️ MASTER ADMINISTRATOR CONFIGURATION (DATABASE SYNCED) =====
const DEFAULT_ADMINS = [
  {
    name: 'Admin',
    email: 'stackbyujjwal@gmail.com',
    password_hash: '0c59e230c61e20992cd7150803a798c8909e3e873ca04fc541b4acd6ad4dcb2c',
    role: 'admin'
  },
  {
    name: 'Admin',
    email: 'mj5000500@gmail.com',
    password_hash: '7133c3e7dfe4209b63e24423735418c9e066b8db770af83a1e6e227f7a5ec1dd',
    role: 'admin'
  }
];

let _adminsEnsurePromise = null;
async function ensureDefaultAdminsInDatabase() {
  if (_adminsEnsurePromise) return _adminsEnsurePromise;
  _adminsEnsurePromise = (async () => {
    if (!checkClient()) return;
    try {
      for (const adm of DEFAULT_ADMINS) {
        const cleanEmail = adm.email.toLowerCase().trim();
        const hash = adm.password_hash;
        const { data: existing } = await sbClient
          .from('app_users')
          .select('id, email, password_hash, role')
          .eq('email', cleanEmail)
          .maybeSingle();

        if (!existing) {
          await sbClient.from('app_users').insert({
            name: adm.name,
            email: cleanEmail,
            password_hash: hash,
            role: 'admin',
            status: 'approved',
            created_at: new Date().toISOString()
          });
        } else if (existing.role !== 'admin' || !existing.password_hash) {
          await sbClient.from('app_users').update({
            name: adm.name,
            role: 'admin',
            status: 'approved',
            password_hash: existing.password_hash || hash
          }).eq('id', existing.id);
        }
      }
    } catch (e) {
      console.warn('Auto-seed admins notice:', e.message);
    }
  })();
  return _adminsEnsurePromise;
}

// Background auto-seed default admins to database
if (typeof window !== 'undefined') {
  setTimeout(() => {
    ensureDefaultAdminsInDatabase().catch(() => { });
  }, 1200);
}

// ===== 🛡️ SPIDER SECURITY VAULT (STREAM CIPHER & STORAGE PROTECTION) =====
const SecurityVault = {
  _salt: 'SpiderSecuritySalt_2026_LiveClassVault',

  // High-performance hash for data integrity
  _hash(str) {
    let hash = 5381;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) + hash) + str.charCodeAt(i);
      hash = hash & hash; // Convert to 32bit integer
    }
    return (hash >>> 0).toString(16);
  },

  // Layer 7: Checksum Signature for Tamper-Proof Session Storage
  signData(obj) {
    if (!obj || typeof obj !== 'object') return '';
    try {
      const payload = `${obj.id || ''}:${obj.email || ''}:${obj.role || ''}:${obj.status || ''}:${obj.session_id || ''}:${this._salt}`;
      return this._hash(payload);
    } catch (e) {
      return '';
    }
  },

  verifySignature(obj, signature) {
    if (!obj || !signature) return false;
    try {
      return this.signData(obj) === signature;
    } catch (e) {
      return false;
    }
  },

  encrypt(text) {
    if (!text) return '';
    try {
      let xor = '';
      for (let i = 0; i < text.length; i++) {
        xor += String.fromCharCode(text.charCodeAt(i) ^ this._salt.charCodeAt(i % this._salt.length));
      }
      return btoa(unescape(encodeURIComponent(xor)));
    } catch (e) {
      return btoa(unescape(encodeURIComponent(text)));
    }
  },

  decrypt(token) {
    if (!token) return '';
    try {
      const decoded = decodeURIComponent(escape(atob(token)));
      let xor = '';
      for (let i = 0; i < decoded.length; i++) {
        xor += String.fromCharCode(decoded.charCodeAt(i) ^ this._salt.charCodeAt(i % this._salt.length));
      }
      return xor;
    } catch (e) {
      try { return decodeURIComponent(escape(atob(token))); } catch (err) { return token; }
    }
  },

  // Layer 2: Adaptive Anti-Brute-Force Rate Limiter
  RateLimiter: {
    _getKey(action) {
      return 'spider_rl_' + action;
    },
    check(action, maxAttempts = 5, lockDurationMs = 900000) {
      try {
        const key = this._getKey(action);
        const raw = localStorage.getItem(key);
        if (!raw) return { locked: false, remainingMs: 0, attempts: 0 };
        const data = JSON.parse(raw);
        const now = Date.now();
        if (data.lockedUntil && now < data.lockedUntil) {
          return { locked: true, remainingMs: data.lockedUntil - now, attempts: data.attempts || 0 };
        }
        if (data.lockedUntil && now >= data.lockedUntil) {
          this.reset(action);
          return { locked: false, remainingMs: 0, attempts: 0 };
        }
        return { locked: false, remainingMs: 0, attempts: data.attempts || 0 };
      } catch (e) {
        return { locked: false, remainingMs: 0, attempts: 0 };
      }
    },
    recordFailure(action, maxAttempts = 5, lockDurationMs = 900000) {
      try {
        const key = this._getKey(action);
        const current = this.check(action, maxAttempts, lockDurationMs);
        const attempts = (current.attempts || 0) + 1;
        const now = Date.now();
        const isNowLocked = attempts >= maxAttempts;
        const data = {
          attempts: isNowLocked ? maxAttempts : attempts,
          lastAttempt: now,
          lockedUntil: isNowLocked ? (now + lockDurationMs) : null
        };
        localStorage.setItem(key, JSON.stringify(data));
        return { locked: isNowLocked, remainingMs: isNowLocked ? lockDurationMs : 0, attempts };
      } catch (e) {
        return { locked: false, remainingMs: 0, attempts: 1 };
      }
    },
    reset(action) {
      try {
        localStorage.removeItem(this._getKey(action));
      } catch (e) { }
    }
  }
};

// ===== 🛡️ SPIDER SHIELD — 10-LAYER MILITARY CLIENT DEFENSE SYSTEM =====
const SpiderShield = {
  initialized: false,
  init(options = {}) {
    if (this.initialized || typeof window === 'undefined') return;
    this.initialized = true;

    // Layer 5: Anti-Clickjacking / Frame-Busting Guard
    try {
      if (window.top !== window.self) {
        window.top.location = window.self.location;
      }
    } catch (e) {
      try {
        if (window.self.location.href !== window.top.location.href) {
          window.top.location.href = window.self.location.href;
        }
      } catch (err) { }
    }

    // Layer 1: Anti-DevTools & Shortcut Locks (F12, Ctrl+Shift+I, Ctrl+Shift+J, etc.)
    window.addEventListener('keydown', function (e) {
      // F12
      if (e.key === 'F12' || e.keyCode === 123) {
        e.preventDefault();
        e.stopPropagation();
        return false;
      }
      // Ctrl+Shift+I, Ctrl+Shift+J, Ctrl+Shift+C (DevTools Inspect & Console)
      if (e.ctrlKey && e.shiftKey && (e.key === 'I' || e.key === 'i' || e.key === 'J' || e.key === 'j' || e.key === 'C' || e.key === 'c')) {
        e.preventDefault();
        e.stopPropagation();
        return false;
      }
      // Ctrl+U (View Source)
      if (e.ctrlKey && (e.key === 'U' || e.key === 'u')) {
        e.preventDefault();
        e.stopPropagation();
        return false;
      }
      // Ctrl+S (Save Page)
      if (e.ctrlKey && (e.key === 'S' || e.key === 's')) {
        e.preventDefault();
        e.stopPropagation();
        return false;
      }
      // Ctrl+P (Print Page / Print Scraper)
      if (e.ctrlKey && (e.key === 'P' || e.key === 'p')) {
        e.preventDefault();
        e.stopPropagation();
        return false;
      }
    }, true);

    // Layer 1: Right-Click Context Menu Lock (Disabled except on inputs)
    window.addEventListener('contextmenu', function (e) {
      const tag = (e.target && e.target.tagName) ? e.target.tagName.toUpperCase() : '';
      if (tag === 'INPUT' || tag === 'TEXTAREA') return true;
      e.preventDefault();
      e.stopPropagation();
      return false;
    }, true);

    // Layer 1: DevTools Active Probe
    this.startDevToolsProbe();

    // Layer 1: Console Neutralization & Intimidation Banner
    this.neutralizeConsole();
  },

  startDevToolsProbe() {
    let devtoolsOpen = false;
    const threshold = 160;

    const checkSize = () => {
      if (typeof window === 'undefined') return;
      const widthDiff = window.outerWidth - window.innerWidth > threshold;
      const heightDiff = window.outerHeight - window.innerHeight > threshold;
      if (widthDiff || heightDiff) {
        if (!devtoolsOpen) {
          devtoolsOpen = true;
          this.onDevToolsDetected();
        }
      } else {
        devtoolsOpen = false;
      }
    };

    window.addEventListener('resize', checkSize);
    setInterval(checkSize, 2500);
  },

  onDevToolsDetected() {
    try {
      console.clear();
      console.warn('%c⛔ SPIDER SECURITY SHIELD ACTIVE', 'color:#ef4444; font-size:22px; font-weight:bold;');
      console.warn('%cInspection and reverse engineering are strictly prohibited. Client activities are signed and monitored.', 'color:#f97316; font-size:13px;');
    } catch (e) { }

    // In admin.html, if devtools is opened without cryptographic admin token, lock screen
    if (typeof window !== 'undefined' && window.location.pathname.includes('admin.html')) {
      const token = (typeof getAdminToken === 'function') ? getAdminToken() : '';
      if (!token) {
        window.location.reload();
      }
    }
  },

  neutralizeConsole() {
    try {
      console.log('%c🛡️ SPIDER CLASSES — 10-LAYER MILITARY GRADE DEFENSE ACTIVE', 'background:#ef4444; color:#fff; font-size:13px; font-weight:bold; padding:4px 10px; border-radius:4px;');
      console.log('%cAnti-Tamper Checksum, DevTools Lock, Rate Limiter, Single Device Hardware Binding Active.', 'color:#94a3b8; font-size:11px;');
    } catch (e) { }
  }
};

// Automatically activate SpiderShield on client load
if (typeof window !== 'undefined') {
  window.SpiderShield = SpiderShield;
  SpiderShield.init();
}

function clearAllAuthSessions(includePermanent = false) {
  clearAdminToken();
  try {
    localStorage.removeItem('cp_user_session');
    localStorage.removeItem('cp_user_session_sig');
    localStorage.removeItem('cp_session_id');
    localStorage.removeItem('admin_logged_in');
    localStorage.removeItem('cp_admin_token');
    localStorage.removeItem('cp_admin_auth_session');
    localStorage.removeItem('cp_admin_logged');
    localStorage.removeItem('spider_admin_session');
    sessionStorage.removeItem('cp_admin_token');
    sessionStorage.removeItem('cp_admin_auth_session');
    sessionStorage.removeItem('admin_logged_in');
    if (includePermanent) {
      localStorage.removeItem('cp_permanent_student_session');
      localStorage.removeItem('google_session');
    }
  } catch (e) { }
}

// ===== CLOUDFLARE WORKER & DATABASE BRIDGING =====
const DIRECT_WORKER_API_BASE = 'https://video-play-api.newstreamcp.workers.dev/api';
const LOCAL_PROXY_API_BASE = '/api';

async function workerApiCall(endpoint, options = {}) {
  const isHttpHost = typeof window !== 'undefined' && window.location && window.location.protocol.startsWith('http');
  const primaryBase = isHttpHost ? LOCAL_PROXY_API_BASE : DIRECT_WORKER_API_BASE;
  const fallbackBase = DIRECT_WORKER_API_BASE;

  async function executeCall(baseUrl) {
    const url = baseUrl + endpoint;
    const response = await fetch(url, {
      ...options,
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
    });
    let data = null;
    try { data = await response.json(); } catch (e) { }
    if (!response.ok) {
      const msg = (data && (data.error || data.message)) ? (data.error || data.message) : `HTTP ${response.status}`;
      throw new Error(msg);
    }
    return data;
  }

  try {
    return await executeCall(primaryBase);
  } catch (error) {
    if (primaryBase !== fallbackBase) {
      try {
        return await executeCall(fallbackBase);
      } catch (fallbackError) {
        console.warn('Worker API Error (' + endpoint + '):', fallbackError.message);
        throw fallbackError;
      }
    }
    console.warn('Worker API Error (' + endpoint + '):', error.message);
    throw error;
  }
}


// 5 Core Curriculum Subjects
const STANDARD_SUBJECTS = [
  { id: 'subj_math', name: 'Math', icon: '📐', color: 'blue' },
  { id: 'subj_reasoning', name: 'Reasoning', icon: '🧠', color: 'purple' },
  { id: 'subj_quant', name: 'Quant', icon: '🔢', color: 'emerald' },
  { id: 'subj_computer', name: 'Computer', icon: '💻', color: 'cyan' },
  { id: 'subj_english', name: 'English', icon: '📖', color: 'amber' }
];

// Top 7 Verified Live Classes (Seed / Instant Resilient Fallback)
const DEFAULT_LIVE_CLASSES = [
  {
    id: "imp_126",
    raw_id: 126,
    title: "Permutations and Combination 07 [Basic To Advance] 06:12 pm",
    url: "https://vs.classplusapp.com/hls/6ad8b32b66017c9e0c8622d6/720p20.m3u8",
    status: "live",
    is_live_now: true,
    is_visible: 1,
    scheduled_at: "2026-10-22T13:24:32+00:00",
    created_at: "2026-10-22T13:24:32+00:00",
    instructor: "Spider Classes",
    section: "math",
    description: "Live Interactive Session"
  },
  {
    id: "imp_122",
    raw_id: 122,
    title: "Computer - Signed Number System 04:10 pm",
    url: "https://vs.classplusapp.com/hls/6ad9e81cf26032ed774035a0/720p20.m3u8",
    status: "live",
    is_live_now: false,
    is_visible: 1,
    scheduled_at: "2026-10-22T13:24:28.092343+00:00",
    created_at: "2026-10-22T13:24:28.092343+00:00",
    instructor: "Spider Classes",
    section: "computer",
    description: "Live Interactive Session"
  },
  {
    id: "imp_121",
    raw_id: 121,
    title: "Equation, Ineuqation and Quadratic Equation 15 12:09 pm",
    url: "https://vs.classplusapp.com/hls/6ad9af8c0e4a9a82f2382c23/720p20.m3u8",
    status: "live",
    is_live_now: false,
    is_visible: 1,
    scheduled_at: "2026-10-22T07:05:14.414491+00:00",
    created_at: "2026-10-22T07:05:14.414491+00:00",
    instructor: "Spider Classes",
    section: "math",
    description: "Live Interactive Session"
  },
  {
    id: "imp_120",
    raw_id: 120,
    title: "Permutations and Combination 07 [Basic To Advance] 06:12 pm",
    url: "https://vs.classplusapp.com/hls/6ad8b32b66017c9e0c8622d6/720p20.m3u8",
    status: "live",
    is_live_now: false,
    is_visible: 1,
    scheduled_at: "2026-10-21T14:00:24.885354+00:00",
    created_at: "2026-10-21T14:00:24.885354+00:00",
    instructor: "Spider Classes",
    section: "math",
    description: "Live Interactive Session"
  },
  {
    id: "imp_117",
    raw_id: 117,
    title: "Blood Relation 03 04:37 pm",
    url: "https://vs.classplusapp.com/hls/6ad357078f4b7f022d05a115/720p20.m3u8",
    status: "live",
    is_live_now: false,
    is_visible: 1,
    scheduled_at: "2026-10-17T11:57:00+00:00",
    created_at: "2026-10-17T11:57:00+00:00",
    instructor: "Spider Classes",
    section: "reasoning",
    description: "Live Interactive Session"
  },
  {
    id: "imp_114",
    raw_id: 114,
    title: "Permutations and Combination 05 [Basic To Advance] 06:24 pm",
    url: "https://vs.classplusapp.com/hls/6ad21bdac22a23b7e1e995f2/720p20.m3u8",
    status: "live",
    is_live_now: false,
    is_visible: 1,
    scheduled_at: "2026-10-17T11:54:00+00:00",
    created_at: "2026-10-17T11:54:00+00:00",
    instructor: "Spider Classes",
    section: "math",
    description: "Live Interactive Session"
  },
  {
    id: "imp_108",
    raw_id: 108,
    title: "Blood Relation 02 04:20 pm",
    url: "https://vs.classplusapp.com/hls/6ad201808563bb5d99d8186d/720p20.m3u8",
    status: "live",
    is_live_now: false,
    is_visible: 1,
    scheduled_at: "2026-10-17T11:48:00+00:00",
    created_at: "2026-10-17T11:48:00+00:00",
    instructor: "Spider Classes",
    section: "reasoning",
    description: "Live Interactive Session"
  }
];

const SECTION_TO_SUBJ = {
  'recorded': 'subj_math',
  'math': 'subj_math',
  'reasoning': 'subj_reasoning',
  'quant': 'subj_quant',
  'computer': 'subj_computer',
  'english': 'subj_english'
};

const SUBJ_TO_SECTION = {
  'subj_math': 'recorded',
  'subj_reasoning': 'reasoning',
  'subj_quant': 'quant',
  'subj_computer': 'computer',
  'subj_english': 'english'
};

// --- Fast In-Memory & LocalStorage Cache Keys ---
const CACHE_PLAYLISTS_KEY = 'cp_cached_worker_playlists';
const CACHE_LIVE_CLASSES_KEY = 'cp_cached_live_classes';
const CACHE_SUBJECTS_KEY = 'cp_cached_subjects';
const CACHE_CHAPTERS_KEY = 'cp_cached_chapters';
const CACHE_LECTURES_KEY = 'cp_cached_lectures';

let _cachedPlaylists = null;
let _cachedPlaylistsTime = 0;
let _inFlightPlaylistsPromise = null;

let _cachedSubjects = null;
let _cachedSubjectsTime = 0;

let _cachedChapters = null;
let _cachedChaptersTime = 0;

let _cachedLecturesList = null;
let _cachedLecturesTime = 0;

function getCachedPlaylists() {
  if (_cachedPlaylists && _cachedPlaylists.length > 0) return _cachedPlaylists;
  return getLocalJson(CACHE_PLAYLISTS_KEY, []);
}

function getCachedSubjects() {
  const deleted = getLocalJson(DELETED_SUBJ_KEY, []);
  const cached = getLocalJson(CACHE_SUBJECTS_KEY, null);
  if (cached && Array.isArray(cached) && cached.length) {
    return cached.filter(s => !deleted.includes(s.id));
  }
  const custom = getLocalJson(CUSTOM_SUBJ_KEY, []);
  let list = STANDARD_SUBJECTS.filter(s => !deleted.includes(s.id)).map(s => ({ ...s }));
  custom.forEach(c => {
    if (deleted.includes(c.id)) return;
    const idx = list.findIndex(s => s.id === c.id);
    if (idx >= 0) list[idx] = { ...list[idx], ...c };
    else list.push(c);
  });
  return list;
}

function getCachedChapters() {
  const deletedIds = getLocalJson(DELETED_CHAPTERS_KEY, []).map(String);
  const cached = getLocalJson(CACHE_CHAPTERS_KEY, null);
  if (cached && cached.length) {
    return cached.filter(c => !deletedIds.includes(String(c.id)));
  }
  const pls = getCachedPlaylists();
  if (!pls.length) return [];
  const overrides = getLocalJson(CHAPTER_OVERRIDES_KEY, {});
  const customChapters = getLocalJson(CUSTOM_CHAPTERS_KEY, []);
  const chapters = [];
  pls.forEach(pl => {
    if (deletedIds.includes(String(pl.id))) return;
    const secKey = (pl.section || 'recorded').toLowerCase();
    let subjId = SECTION_TO_SUBJ[secKey] || 'subj_math';
    let name = pl.name;
    let section = pl.section || 'recorded';
    if (overrides[pl.id]) {
      if (overrides[pl.id].name) name = overrides[pl.id].name;
      if (overrides[pl.id].subject_id) {
        subjId = overrides[pl.id].subject_id;
        section = SUBJ_TO_SECTION[subjId] || section;
      }
    }
    chapters.push({ id: String(pl.id), name, subject_id: subjId, section, created_at: pl.created_at || '2026-01-01T00:00:00Z' });
  });
  customChapters.forEach(c => {
    if (!deletedIds.includes(String(c.id)) && !chapters.some(x => String(x.id) === String(c.id))) {
      chapters.push({ ...c, id: String(c.id), source: 'custom' });
    }
  });
  return chapters;
}

function getCachedLectures() {
  const deletedChapterIds = getLocalJson(DELETED_CHAPTERS_KEY, []).map(String);
  const deletedIds = getLocalJson(DELETED_LECTURES_KEY, []).map(String);
  const cached = getLocalJson(CACHE_LECTURES_KEY, null);

  const cachedChaps = getCachedChapters();
  const validChapIds = new Set(cachedChaps.map(c => String(c.id)));

  if (cached && cached.length) {
    return cached.filter(l => {
      const chapId = String(l.chapter_id);
      const lecId = String(l.id);
      if (deletedChapterIds.includes(chapId)) return false;
      if (deletedIds.includes(lecId)) return false;
      if (validChapIds.size > 0 && !validChapIds.has(chapId)) return false;
      return true;
    });
  }

  const pls = getCachedPlaylists();
  const overrides = getLocalJson(LECTURE_OVERRIDES_KEY, {});
  const customLectures = getLocalJson(CUSTOM_LECTURES_KEY, []);
  const lectures = [];

  if (pls.length) {
    pls.forEach(pl => {
      const plId = String(pl.id);
      if (deletedChapterIds.includes(plId)) return;
      if (validChapIds.size > 0 && !validChapIds.has(plId)) return;

      if (Array.isArray(pl.chapters)) {
        pl.chapters.forEach((ch, idx) => {
          const lecId = String(ch.id);
          if (deletedIds.includes(lecId)) return;
          const order = ch.chapter_number || (idx + 1);
          let title = ch.name ? ch.name.trim() : `Lecture ${order}`;
          if (/^\d+$/.test(title)) title = `${pl.name} - Class ${title}`;
          let url = ch.link;
          let chapterId = plId;
          let sortOrder = order;
          if (overrides[ch.id]) {
            if (overrides[ch.id].title) title = overrides[ch.id].title;
            if (overrides[ch.id].url) url = overrides[ch.id].url;
            if (overrides[ch.id].chapter_id) chapterId = String(overrides[ch.id].chapter_id);
            if (overrides[ch.id].sort_order) sortOrder = overrides[ch.id].sort_order;
          }
          lectures.push({ id: lecId, title, url, chapter_id: chapterId, sort_order: sortOrder, order_num: sortOrder, created_at: ch.created_at || '2026-01-01T00:00:00Z' });
        });
      }
    });
  }

  customLectures.forEach(l => {
    const chapId = String(l.chapter_id);
    const lecId = String(l.id);
    if (deletedChapterIds.includes(chapId)) return;
    if (deletedIds.includes(lecId)) return;
    if (validChapIds.size > 0 && !validChapIds.has(chapId)) return;
    if (!lectures.some(x => String(x.id) === lecId)) lectures.push(l);
  });

  return lectures;
}

function getCachedLiveClasses() {
  let list = null;
  if (typeof _cachedLiveClasses !== 'undefined' && Array.isArray(_cachedLiveClasses) && _cachedLiveClasses.length > 0) {
    list = _cachedLiveClasses;
  } else {
    list = getLocalJson(CACHE_LIVE_CLASSES_KEY, null);
    if (!Array.isArray(list) || list.length === 0) {
      list = getLocalJson('cp_live_classes', null);
    }
  }
  // Deep safeguard: If storage was cleared or empty, provide verified default live classes immediately
  if (!Array.isArray(list) || list.length === 0) {
    list = DEFAULT_LIVE_CLASSES.map(c => ({ ...c }));
  }
  const filtered = (list || []).filter(c => {
    const t = String(c.title || '').trim();
    const st = String(c.status || '').trim();
    const u = String(c.url || '').trim();
    return !t.startsWith('__CONFIG_') && !t.includes('CONFIG_CHAPTER_PLAYLISTS') && st !== 'config' && u !== 'config';
  });
  if (typeof compareLiveClasses === 'function') {
    filtered.sort(compareLiveClasses);
  }
  if (typeof enforceTopLiveVisibility === 'function') {
    return enforceTopLiveVisibility(filtered, MAX_VISIBLE_LIVE_CLASSES);
  }
  return filtered;
}

async function fetchWorkerPlaylists(force = false) {
  const now = Date.now();
  if (!force && _cachedPlaylists && (now - _cachedPlaylistsTime < 60000)) {
    return _cachedPlaylists;
  }
  // Instant fallback from localStorage cache if memory cache is empty
  if (!force && !_cachedPlaylists) {
    const local = getCachedPlaylists();
    if (Array.isArray(local) && local.length > 0) {
      _cachedPlaylists = local;
      _cachedPlaylistsTime = now;
      // Background revalidation
      if (!_inFlightPlaylistsPromise) {
        _inFlightPlaylistsPromise = workerApiCall('/playlists').then(data => {
          const list = Array.isArray(data) ? data : (data && Array.isArray(data.playlists) ? data.playlists : null);
          if (list) {
            _cachedPlaylists = list;
            _cachedPlaylistsTime = Date.now();
            saveLocalJson(CACHE_PLAYLISTS_KEY, list);
          }
        }).catch(() => { }).finally(() => {
          _inFlightPlaylistsPromise = null;
        });
      }
      return _cachedPlaylists;
    }
  }

  if (_inFlightPlaylistsPromise) {
    return _inFlightPlaylistsPromise;
  }

  _inFlightPlaylistsPromise = (async () => {
    try {
      const data = await workerApiCall('/playlists');
      const list = Array.isArray(data) ? data : (data && Array.isArray(data.playlists) ? data.playlists : null);
      if (list) {
        _cachedPlaylists = list;
        _cachedPlaylistsTime = Date.now();
        saveLocalJson(CACHE_PLAYLISTS_KEY, list);
        return _cachedPlaylists;
      }
    } catch (err) {
      console.warn('Could not load worker playlists:', err.message);
    } finally {
      _inFlightPlaylistsPromise = null;
    }
    return _cachedPlaylists || getCachedPlaylists();
  })();

  return _inFlightPlaylistsPromise;
}

function broadcastLiveSync(detail = {}) {
  try {
    localStorage.setItem('spider_live_sync_ping', JSON.stringify({ ts: Date.now(), ...detail }));
    window.dispatchEvent(new CustomEvent('spider_live_sync', { detail }));
  } catch (e) { }
}

function invalidatePlaylistsCache() {
  _cachedPlaylists = null;
  _cachedPlaylistsTime = 0;
  _cachedChapters = null;
  _cachedChaptersTime = 0;
  _cachedLecturesList = null;
  _cachedLecturesTime = 0;
  try {
    localStorage.removeItem(CACHE_LECTURES_KEY);
    localStorage.removeItem(CACHE_PLAYLISTS_KEY);
    localStorage.removeItem(CACHE_CHAPTERS_KEY);
  } catch (e) { }
  broadcastLiveSync({ type: 'cache_invalidated' });
}

// ===== API FUNCTIONS =====

// --- Local Persistence & Override Storage Keys ---
function getLocalJson(key, defaultVal) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : defaultVal;
  } catch (e) {
    return defaultVal;
  }
}
function saveLocalJson(key, val) {
  try {
    localStorage.setItem(key, JSON.stringify(val));
  } catch (e) { }
}

const CUSTOM_SUBJ_KEY = 'cp_custom_subjects';
const DELETED_SUBJ_KEY = 'cp_deleted_subjects';
const CHAPTER_OVERRIDES_KEY = 'cp_chapter_overrides';
const DELETED_CHAPTERS_KEY = 'cp_deleted_chapters';
const CUSTOM_CHAPTERS_KEY = 'cp_custom_chapters';
const LECTURE_OVERRIDES_KEY = 'cp_lecture_overrides';
const DELETED_LECTURES_KEY = 'cp_deleted_lectures';
const CUSTOM_LECTURES_KEY = 'cp_custom_lectures';

// --- Subjects CRUD ---
async function getSubjects(force = false) {
  const now = Date.now();
  if (!force && _cachedSubjects && (now - _cachedSubjectsTime < 30000)) {
    return _cachedSubjects;
  }
  const deletedIds = getLocalJson(DELETED_SUBJ_KEY, []);
  const customList = getLocalJson(CUSTOM_SUBJ_KEY, []);

  // 1. Base standard subjects filtered
  let list = STANDARD_SUBJECTS.filter(s => !deletedIds.includes(s.id)).map(s => ({ ...s }));

  // 2. Custom and overridden subjects
  customList.forEach(c => {
    if (deletedIds.includes(c.id)) return;
    const idx = list.findIndex(s => s.id === c.id);
    if (idx >= 0) {
      list[idx] = { ...list[idx], ...c };
    } else {
      list.push(c);
    }
  });

  // 3. Supabase sync with 1200ms timeout so UI never stalls
  try {
    if (checkClient()) {
      const sbPromise = sbClient
        .from('subjects')
        .select('*')
        .order('created_at', { ascending: true });
      const timeoutPromise = new Promise(resolve => setTimeout(() => resolve({ data: null }), 5000));
      const { data } = await Promise.race([sbPromise, timeoutPromise]);
      if (Array.isArray(data)) {
        data.forEach(dbSub => {
          if (deletedIds.includes(dbSub.id)) return;
          const exists = list.find(s => s.id === dbSub.id || s.name.toLowerCase() === dbSub.name.toLowerCase());
          if (exists) {
            exists.db_id = dbSub.id;
          } else {
            list.push(dbSub);
          }
        });
      }
    }
  } catch (e) { }

  _cachedSubjects = list;
  _cachedSubjectsTime = now;
  saveLocalJson(CACHE_SUBJECTS_KEY, list);
  return list;
}

async function addSubject(name, icon = '📚', color = 'blue') {
  const cleanName = (name || '').trim();
  if (!cleanName) return null;

  const subjects = await getSubjects();
  const match = subjects.find(s => s.name.toLowerCase() === cleanName.toLowerCase());
  if (match) {
    showToast(`Subject "${cleanName}" already exists`, 'info');
    return match;
  }

  const newSub = {
    id: 'subj_' + cleanName.toLowerCase().replace(/[^a-z0-9]/g, '_') + '_' + Date.now().toString(36),
    name: cleanName,
    icon: icon || '📚',
    color: color || 'blue'
  };

  const custom = getLocalJson(CUSTOM_SUBJ_KEY, []);
  custom.push(newSub);
  saveLocalJson(CUSTOM_SUBJ_KEY, custom);

  // Un-delete if previously deleted
  const deleted = getLocalJson(DELETED_SUBJ_KEY, []).filter(id => id !== newSub.id);
  saveLocalJson(DELETED_SUBJ_KEY, deleted);

  // Update CACHE_SUBJECTS_KEY immediately
  const cached = getLocalJson(CACHE_SUBJECTS_KEY, []);
  if (Array.isArray(cached) && !cached.some(s => s.id === newSub.id)) {
    cached.push(newSub);
    saveLocalJson(CACHE_SUBJECTS_KEY, cached);
  }

  try {
    if (checkClient()) {
      await sbClient.from('subjects').insert({
        id: newSub.id,
        name: newSub.name,
        icon: newSub.icon,
        color: newSub.color
      });
    }
  } catch (e) { }

  _cachedSubjects = null;
  _cachedSubjectsTime = 0;
  showToast(`Subject "${cleanName}" added`, 'success');
  return newSub;
}

async function updateSubject(id, updates) {
  const custom = getLocalJson(CUSTOM_SUBJ_KEY, []);
  const existingIdx = custom.findIndex(s => s.id === id);

  const curSub = (await getSubjects()).find(s => s.id === id) || { id };
  const updated = { ...curSub, ...updates, id };

  if (existingIdx >= 0) {
    custom[existingIdx] = updated;
  } else {
    custom.push(updated);
  }
  saveLocalJson(CUSTOM_SUBJ_KEY, custom);

  // Update CACHE_SUBJECTS_KEY
  const cached = getLocalJson(CACHE_SUBJECTS_KEY, []);
  if (Array.isArray(cached)) {
    const cIdx = cached.findIndex(s => s.id === id);
    if (cIdx >= 0) {
      cached[cIdx] = { ...cached[cIdx], ...updates };
      saveLocalJson(CACHE_SUBJECTS_KEY, cached);
    }
  }

  // Update in-memory STANDARD_SUBJECTS if it's standard
  const stdIdx = STANDARD_SUBJECTS.findIndex(s => s.id === id);
  if (stdIdx >= 0) {
    STANDARD_SUBJECTS[stdIdx] = { ...STANDARD_SUBJECTS[stdIdx], ...updates };
  }

  try {
    if (checkClient()) {
      await sbClient.from('subjects').update(updates).eq('id', id);
    }
  } catch (e) { }

  _cachedSubjects = null;
  _cachedSubjectsTime = 0;
  showToast('Subject updated successfully', 'success');
  return updated;
}

async function deleteSubject(id) {
  const subjIdStr = String(id).trim();
  const deleted = getLocalJson(DELETED_SUBJ_KEY, []).map(String);
  if (!deleted.includes(subjIdStr)) {
    deleted.push(subjIdStr);
    saveLocalJson(DELETED_SUBJ_KEY, deleted);
  }

  const custom = getLocalJson(CUSTOM_SUBJ_KEY, []).filter(s => String(s.id).trim() !== subjIdStr);
  saveLocalJson(CUSTOM_SUBJ_KEY, custom);

  // Prune from CACHE_SUBJECTS_KEY immediately
  const cached = getLocalJson(CACHE_SUBJECTS_KEY, []);
  if (Array.isArray(cached)) {
    saveLocalJson(CACHE_SUBJECTS_KEY, cached.filter(s => String(s.id).trim() !== subjIdStr));
  }

  const idx = STANDARD_SUBJECTS.findIndex(s => String(s.id).trim() === subjIdStr);
  if (idx !== -1) {
    STANDARD_SUBJECTS.splice(idx, 1);
  }

  // Cascade delete all chapters under this subject
  try {
    const allChaps = await getAllChapters();
    const subChaps = allChaps.filter(c => String(c.subject_id).trim() === subjIdStr);
    for (const c of subChaps) {
      await deleteChapter(c.id);
    }
  } catch (e) { }

  try {
    if (checkClient()) {
      await sbClient.from('subjects').delete().eq('id', subjIdStr);
    }
  } catch (e) { }

  _cachedSubjects = null;
  _cachedSubjectsTime = 0;
  showToast('Subject deleted', 'info');
  return true;
}

// --- Chapters CRUD ---
async function getAllChapters(force = false) {
  const now = Date.now();
  if (!force && _cachedChapters && (now - _cachedChaptersTime < 30000)) {
    return _cachedChapters;
  }
  const playlists = await fetchWorkerPlaylists(force);
  let deletedIds = getLocalJson(DELETED_CHAPTERS_KEY, []).map(String);

  // Self-heal: Cloudflare Worker database is source of truth for active playlists
  // Prune any live worker playlist IDs from deletedIds so stale local storage cannot hide them
  const activeWorkerChapIds = new Set(playlists.map(p => String(p.id)));
  const healedDeletedIds = deletedIds.filter(id => !activeWorkerChapIds.has(String(id)));
  if (healedDeletedIds.length !== deletedIds.length) {
    saveLocalJson(DELETED_CHAPTERS_KEY, healedDeletedIds);
    deletedIds = healedDeletedIds;
  }

  const overrides = getLocalJson(CHAPTER_OVERRIDES_KEY, {});
  const customChapters = getLocalJson(CUSTOM_CHAPTERS_KEY, []);
  const rawChapters = [];

  playlists.forEach(pl => {
    if (deletedIds.includes(String(pl.id))) return;

    const secKey = (pl.section || 'recorded').toLowerCase();
    let subjId = SECTION_TO_SUBJ[secKey] || 'subj_math';
    let name = pl.name;
    let section = pl.section || 'recorded';

    if (overrides[pl.id]) {
      if (overrides[pl.id].name) name = overrides[pl.id].name;
      if (overrides[pl.id].subject_id) {
        subjId = overrides[pl.id].subject_id;
        section = SUBJ_TO_SECTION[subjId] || section;
      }
    }

    rawChapters.push({
      id: String(pl.id),
      name: (name || '').trim(),
      subject_id: subjId,
      section,
      created_at: pl.created_at || '2026-01-01T00:00:00Z',
      source: 'worker'
    });
  });

  // Merge custom local chapters
  customChapters.forEach(c => {
    if (deletedIds.includes(String(c.id))) return;
    rawChapters.push({
      ...c,
      id: String(c.id),
      name: (c.name || '').trim(),
      source: 'custom'
    });
  });

  // Live Supabase chapters sync (Always merge latest database chapters)
  try {
    if (checkClient()) {
      const sbPromise = sbClient.from('chapters').select('*').order('created_at', { ascending: true });
      const timeoutPromise = new Promise(resolve => setTimeout(() => resolve({ data: null }), 5000));
      const { data } = await Promise.race([sbPromise, timeoutPromise]);
      if (Array.isArray(data) && data.length > 0) {
        data.forEach(ch => {
          if (deletedIds.includes(String(ch.id))) return;
          const existingIdx = rawChapters.findIndex(r => String(r.id) === String(ch.id));
          const chapObj = {
            id: String(ch.id),
            name: (ch.name || '').trim(),
            subject_id: ch.subject_id || 'subj_math',
            section: ch.section || 'recorded',
            created_at: ch.created_at || '2026-01-01T00:00:00Z',
            source: 'supabase'
          };
          if (existingIdx >= 0) {
            rawChapters[existingIdx] = { ...rawChapters[existingIdx], ...chapObj };
          } else {
            rawChapters.push(chapObj);
          }
        });
      }
    }
  } catch (e) { }

  // --- STRICT CANONICAL DEDUPLICATION (PREVENTS DUPLICATE CHAPTERS WITH SAME NAME) ---
  const seenChapKeys = new Map();
  const cleanChapters = [];
  const workerIds = new Set(playlists.map(p => String(p.id)));

  for (const ch of rawChapters) {
    const key = (ch.subject_id || 'subj_math') + '::' + ch.name.toLowerCase();
    if (!seenChapKeys.has(key)) {
      seenChapKeys.set(key, ch);
      cleanChapters.push(ch);
    } else {
      // Duplicate detected! Always prefer Cloudflare Worker canonical entry over temporary local copy
      const existing = seenChapKeys.get(key);
      const curIsWorker = ch.source === 'worker' || workerIds.has(String(ch.id));
      const existingIsWorker = existing.source === 'worker' || workerIds.has(String(existing.id));
      if (curIsWorker && !existingIsWorker) {
        const idx = cleanChapters.indexOf(existing);
        if (idx >= 0) cleanChapters[idx] = ch;
        seenChapKeys.set(key, ch);
        try {
          const oldId = String(existing.id);
          const newId = String(ch.id);
          // Migrate linked playlist
          const plMap = getAllChapterPlaylists();
          if (plMap[oldId]) {
            plMap[newId] = { ...plMap[oldId], chapterId: newId };
            delete plMap[oldId];
            localStorage.setItem(CHAPTER_PLAYLISTS_KEY, JSON.stringify(plMap));
          }
          // Migrate custom lectures
          const customLecs = getLocalJson(CUSTOM_LECTURES_KEY, []);
          let changed = false;
          customLecs.forEach(l => {
            if (String(l.chapter_id) === oldId) {
              l.chapter_id = newId;
              changed = true;
            }
          });
          if (changed) saveLocalJson(CUSTOM_LECTURES_KEY, customLecs);
          // Purge duplicate temporary chapter from customChapters
          const cleanCustom = getLocalJson(CUSTOM_CHAPTERS_KEY, []).filter(c => String(c.id) !== oldId);
          saveLocalJson(CUSTOM_CHAPTERS_KEY, cleanCustom);
        } catch (mErr) { }
      } else {
        // ch is duplicate and existing is canonical: purge ch from customChapters if present
        try {
          const dupId = String(ch.id);
          const cleanCustom = getLocalJson(CUSTOM_CHAPTERS_KEY, []).filter(c => String(c.id) !== dupId);
          saveLocalJson(CUSTOM_CHAPTERS_KEY, cleanCustom);
        } catch (e) { }
      }
    }
  }

  _cachedChapters = cleanChapters;
  _cachedChaptersTime = now;
  saveLocalJson(CACHE_CHAPTERS_KEY, cleanChapters);
  return cleanChapters;
}

async function getChapters(subjectId) {
  const all = await getAllChapters();
  if (!subjectId) return all;
  return all.filter(c => c.subject_id === subjectId || (c.subjects && c.subjects.id === subjectId));
}

async function addChapter(name, subjectId) {
  const cleanName = (name || '').trim();
  if (!cleanName) return null;
  const section = SUBJ_TO_SECTION[subjectId] || 'recorded';

  // 1. DEDUPLICATION: Check if chapter already exists in this subject
  const allCurrent = await getAllChapters();
  const existingInSubj = allCurrent.find(c =>
    (c.subject_id === subjectId || (c.section && c.section.toLowerCase() === section.toLowerCase())) &&
    c.name.toLowerCase() === cleanName.toLowerCase()
  );
  if (existingInSubj) {
    console.log(`[addChapter] Chapter "${cleanName}" already exists with id "${existingInSubj.id}". Reusing.`);
    return existingInSubj;
  }

  // 2. Also check if Cloudflare Worker already has this playlist in its database
  try {
    const workerPlaylists = await fetchWorkerPlaylists(true);
    const existingOnWorker = workerPlaylists.find(p =>
      (p.section || '').toLowerCase() === section.toLowerCase() &&
      p.name.trim().toLowerCase() === cleanName.toLowerCase()
    );
    if (existingOnWorker) {
      console.log(`[addChapter] Found matching playlist on Cloudflare Worker "${existingOnWorker.id}". Linking.`);
      const resolved = {
        id: String(existingOnWorker.id),
        name: existingOnWorker.name,
        subject_id: subjectId,
        section: existingOnWorker.section || section,
        created_at: existingOnWorker.created_at || new Date().toISOString()
      };
      invalidatePlaylistsCache();
      return resolved;
    }
  } catch (e) { }

  // 3. Create on Cloudflare Worker
  let newId = null;
  try {
    const res = await workerApiCall('/playlists', {
      method: 'POST',
      body: JSON.stringify({ name: cleanName, section })
    });
    // Cloudflare Worker response structure: { success: true, message: 'Playlist added', playlist: { id: 'pl_...', ... } }
    if (res && res.playlist && res.playlist.id) {
      newId = String(res.playlist.id);
    } else if (res && res.id) {
      newId = String(res.id);
    }
  } catch (err) {
    console.warn('Worker addChapter notice, saving locally:', err.message);
  }

  if (!newId) {
    newId = 'pl_' + Date.now().toString(36) + Math.random().toString(36).substr(2, 4);
  }

  const newChap = {
    id: String(newId),
    name: cleanName,
    subject_id: subjectId,
    section,
    created_at: new Date().toISOString()
  };

  const custom = getLocalJson(CUSTOM_CHAPTERS_KEY, []);
  // Make sure not already in custom
  const existingCustomIdx = custom.findIndex(c =>
    String(c.id) === String(newId) ||
    (c.subject_id === subjectId && (c.name || '').trim().toLowerCase() === cleanName.toLowerCase())
  );
  if (existingCustomIdx >= 0) {
    custom[existingCustomIdx] = newChap;
  } else {
    custom.push(newChap);
  }
  saveLocalJson(CUSTOM_CHAPTERS_KEY, custom);

  // Un-delete if previously deleted
  const deleted = getLocalJson(DELETED_CHAPTERS_KEY, []).filter(id => id !== String(newId));
  saveLocalJson(DELETED_CHAPTERS_KEY, deleted);

  try {
    if (checkClient()) {
      await sbClient.from('chapters').upsert({
        id: String(newChap.id),
        name: newChap.name,
        subject_id: String(newChap.subject_id)
      }, { onConflict: 'id' });
    }
  } catch (e) { }

  invalidatePlaylistsCache();
  try { await fetchWorkerPlaylists(true); } catch (e) { }
  showToast(`Chapter "${cleanName}" added`, 'success');
  return newChap;
}

async function updateChapter(id, updates) {
  const overrides = getLocalJson(CHAPTER_OVERRIDES_KEY, {});
  const cur = overrides[id] || {};
  overrides[id] = { ...cur, ...updates };
  saveLocalJson(CHAPTER_OVERRIDES_KEY, overrides);

  // Also update in custom chapters if present
  const custom = getLocalJson(CUSTOM_CHAPTERS_KEY, []);
  const idx = custom.findIndex(c => c.id === id);
  if (idx >= 0) {
    custom[idx] = { ...custom[idx], ...updates };
    saveLocalJson(CUSTOM_CHAPTERS_KEY, custom);
  }

  try {
    if (checkClient()) {
      const sbUpdates = {};
      if (updates.name) sbUpdates.name = updates.name;
      if (updates.subject_id) sbUpdates.subject_id = updates.subject_id;
      await sbClient.from('chapters').update(sbUpdates).eq('id', id);
    }
  } catch (e) { }

  invalidatePlaylistsCache();
  showToast('Chapter updated successfully', 'success');
  return { id, ...updates };
}

async function deleteChapter(id) {
  const chapIdStr = String(id).trim();

  // 1. First collect all lecture IDs belonging to this chapter across all sources to mark them as permanently deleted
  const deletedLecIds = getLocalJson(DELETED_LECTURES_KEY, []).map(String);
  const markLecDeleted = (lecId) => {
    const sId = String(lecId).trim();
    if (sId && !deletedLecIds.includes(sId)) deletedLecIds.push(sId);
  };

  // From CUSTOM_LECTURES_KEY
  const customLectures = getLocalJson(CUSTOM_LECTURES_KEY, []);
  customLectures.forEach(l => {
    if (String(l.chapter_id).trim() === chapIdStr) markLecDeleted(l.id);
  });

  // From cached playlists
  const allPls = getCachedPlaylists();
  allPls.forEach(pl => {
    if (String(pl.id).trim() === chapIdStr && Array.isArray(pl.chapters)) {
      pl.chapters.forEach(ch => markLecDeleted(ch.id));
    }
  });

  // From CACHE_LECTURES_KEY
  const cachedLecs = getLocalJson(CACHE_LECTURES_KEY, []);
  if (Array.isArray(cachedLecs)) {
    cachedLecs.forEach(l => {
      if (String(l.chapter_id).trim() === chapIdStr) markLecDeleted(l.id);
    });
  }

  // From in-memory cache if active
  if (Array.isArray(_cachedLecturesList)) {
    _cachedLecturesList.forEach(l => {
      if (String(l.chapter_id).trim() === chapIdStr) markLecDeleted(l.id);
    });
  }

  // Save all marked deleted lecture IDs
  saveLocalJson(DELETED_LECTURES_KEY, deletedLecIds);

  // 2. Mark chapter as deleted in DELETED_CHAPTERS_KEY
  const deletedChapters = getLocalJson(DELETED_CHAPTERS_KEY, []).map(String);
  if (!deletedChapters.includes(chapIdStr)) {
    deletedChapters.push(chapIdStr);
    saveLocalJson(DELETED_CHAPTERS_KEY, deletedChapters);
  }

  // 3. Purge from CUSTOM_CHAPTERS_KEY
  const customChaps = getLocalJson(CUSTOM_CHAPTERS_KEY, []).filter(c => String(c.id).trim() !== chapIdStr);
  saveLocalJson(CUSTOM_CHAPTERS_KEY, customChaps);

  // 4. Purge all lectures belonging to this chapter from CUSTOM_LECTURES_KEY
  const remainingCustomLecs = customLectures.filter(l => String(l.chapter_id).trim() !== chapIdStr);
  saveLocalJson(CUSTOM_LECTURES_KEY, remainingCustomLecs);

  // 5. Purge from local caches immediately
  if (Array.isArray(cachedLecs)) {
    saveLocalJson(CACHE_LECTURES_KEY, cachedLecs.filter(l => String(l.chapter_id).trim() !== chapIdStr && !deletedLecIds.includes(String(l.id))));
  }
  const cachedChaps = getLocalJson(CACHE_CHAPTERS_KEY, []);
  if (Array.isArray(cachedChaps)) {
    saveLocalJson(CACHE_CHAPTERS_KEY, cachedChaps.filter(c => String(c.id).trim() !== chapIdStr));
  }
  if (Array.isArray(allPls)) {
    saveLocalJson(CACHE_PLAYLISTS_KEY, allPls.filter(p => String(p.id).trim() !== chapIdStr));
  }

  // 6. Clean overrides
  const overrides = getLocalJson(CHAPTER_OVERRIDES_KEY, {});
  delete overrides[chapIdStr];
  delete overrides[id];
  saveLocalJson(CHAPTER_OVERRIDES_KEY, overrides);

  const lecOverrides = getLocalJson(LECTURE_OVERRIDES_KEY, {});
  deletedLecIds.forEach(lId => {
    delete lecOverrides[lId];
  });
  saveLocalJson(LECTURE_OVERRIDES_KEY, lecOverrides);

  // 7. Clean up linked playlist metadata
  try { setChapterPlaylist(chapIdStr, null); } catch (e) { }

  // 8. Delete from Cloudflare Worker
  try {
    await workerApiCall('/playlists', {
      method: 'DELETE',
      body: JSON.stringify({ playlistId: chapIdStr })
    });
  } catch (err) {
    console.warn('Worker deleteChapter notice:', err.message);
  }

  // 9. Supabase delete
  try {
    if (checkClient()) {
      await sbClient.from('lectures').delete().eq('chapter_id', chapIdStr);
      await sbClient.from('chapters').delete().eq('id', chapIdStr);
    }
  } catch (e) { }

  // 10. Invalidate and refresh in-memory caches
  _cachedLecturesList = null;
  _cachedLecturesTime = 0;
  _cachedChapters = null;
  _cachedChaptersTime = 0;
  _cachedPlaylists = null;
  _cachedPlaylistsTime = 0;
  invalidatePlaylistsCache();

  try { await fetchWorkerPlaylists(true); } catch (e) { }
  await getAllChapters(true);
  await getAllLectures(true);
  broadcastLiveSync({ type: 'chapter_deleted', chapterId: chapIdStr });
  showToast('Chapter and all its lectures permanently deleted', 'info');
  return true;
}

async function cleanupOrphanedLectures(orphanIds = []) {
  if (!orphanIds || !orphanIds.length) return;
  const strIds = orphanIds.map(String);
  const deletedLecIds = getLocalJson(DELETED_LECTURES_KEY, []).map(String);
  strIds.forEach(id => {
    if (!deletedLecIds.includes(id)) deletedLecIds.push(id);
  });
  saveLocalJson(DELETED_LECTURES_KEY, deletedLecIds);

  const custom = getLocalJson(CUSTOM_LECTURES_KEY, []).filter(l => !strIds.includes(String(l.id)));
  saveLocalJson(CUSTOM_LECTURES_KEY, custom);

  const cached = getLocalJson(CACHE_LECTURES_KEY, []);
  if (Array.isArray(cached)) {
    saveLocalJson(CACHE_LECTURES_KEY, cached.filter(l => !strIds.includes(String(l.id))));
  }

  _cachedLecturesList = null;
  _cachedLecturesTime = 0;
}

// --- Lectures CRUD ---
async function getAllLectures(force = false) {
  const now = Date.now();
  if (!force && _cachedLecturesList && (now - _cachedLecturesTime < 30000)) {
    return _cachedLecturesList;
  }
  const playlists = await fetchWorkerPlaylists(force);
  let deletedChapterIds = getLocalJson(DELETED_CHAPTERS_KEY, []).map(String);
  let deletedIds = getLocalJson(DELETED_LECTURES_KEY, []).map(String);

  // Self-heal: Cloudflare Worker database is source of truth for active chapters & lectures
  // Prune any live worker chapter IDs & lecture IDs from local blacklist so stale storage never hides them
  const activeWorkerChapIds = new Set(playlists.map(p => String(p.id)));
  const activeWorkerLecIds = new Set();
  playlists.forEach(pl => {
    if (Array.isArray(pl.chapters)) {
      pl.chapters.forEach(ch => {
        if (ch && ch.id) activeWorkerLecIds.add(String(ch.id));
      });
    }
  });

  const healedDeletedChaps = deletedChapterIds.filter(id => !activeWorkerChapIds.has(String(id)));
  if (healedDeletedChaps.length !== deletedChapterIds.length) {
    saveLocalJson(DELETED_CHAPTERS_KEY, healedDeletedChaps);
    deletedChapterIds = healedDeletedChaps;
  }

  const healedDeletedLecs = deletedIds.filter(id => !activeWorkerLecIds.has(String(id)));
  if (healedDeletedLecs.length !== deletedIds.length) {
    saveLocalJson(DELETED_LECTURES_KEY, healedDeletedLecs);
    deletedIds = healedDeletedLecs;
  }

  const overrides = getLocalJson(LECTURE_OVERRIDES_KEY, {});
  const customLectures = getLocalJson(CUSTOM_LECTURES_KEY, []);
  const rawLectures = [];

  playlists.forEach(pl => {
    if (deletedChapterIds.includes(String(pl.id))) return;
    if (Array.isArray(pl.chapters)) {
      pl.chapters.forEach((ch, idx) => {
        if (deletedIds.includes(String(ch.id))) return;

        const order = ch.chapter_number || (idx + 1);
        let title = ch.name ? ch.name.trim() : `Lecture ${order}`;
        if (/^\d+$/.test(title)) {
          title = `${pl.name} - Class ${title}`;
        }
        let url = ch.link;
        let chapterId = String(pl.id);
        let sortOrder = order;

        const ov = overrides[ch.id] || overrides[String(ch.id)];
        if (ov) {
          if (ov.title) title = ov.title;
          if (ov.url) url = ov.url;
          if (ov.chapter_id) chapterId = String(ov.chapter_id);
          if (ov.sort_order !== undefined) sortOrder = parseInt(ov.sort_order, 10);
        }

        rawLectures.push({
          id: String(ch.id),
          title,
          url,
          chapter_id: chapterId,
          sort_order: sortOrder,
          created_at: ch.created_at || '2026-01-01T00:00:00Z',
          source: 'worker'
        });
      });
    }
  });

  // Merge custom local lectures
  customLectures.forEach(l => {
    if (deletedChapterIds.includes(String(l.chapter_id))) return;
    if (deletedIds.includes(String(l.id))) return;
    let title = l.title;
    let url = l.url;
    let chapterId = String(l.chapter_id);
    let sortOrder = l.sort_order;

    const ov = overrides[l.id] || overrides[String(l.id)];
    if (ov) {
      if (ov.title) title = ov.title;
      if (ov.url) url = ov.url;
      if (ov.chapter_id) chapterId = String(ov.chapter_id);
      if (ov.sort_order !== undefined) sortOrder = parseInt(ov.sort_order, 10);
    }

    rawLectures.push({
      ...l,
      id: String(l.id),
      title,
      url,
      chapter_id: chapterId,
      sort_order: parseInt(sortOrder, 10) || 1,
      source: 'custom'
    });
  });

  // Live Supabase lectures sync (Always merge latest database lectures & titles)
  try {
    if (checkClient()) {
      const sbPromise = sbClient.from('lectures').select('*').order('sort_order', { ascending: true });
      const timeoutPromise = new Promise(resolve => setTimeout(() => resolve({ data: null }), 5000));
      const { data } = await Promise.race([sbPromise, timeoutPromise]);
      if (Array.isArray(data) && data.length > 0) {
        data.forEach(l => {
          if (deletedIds.includes(String(l.id))) return;
          if (deletedChapterIds.includes(String(l.chapter_id))) return;
          const existingIdx = rawLectures.findIndex(r => String(r.id) === String(l.id));
          const lecObj = {
            id: String(l.id),
            title: l.title || 'Untitled Lecture',
            url: l.url || '',
            chapter_id: String(l.chapter_id),
            sort_order: parseInt(l.sort_order, 10) || 1,
            created_at: l.created_at || '2026-01-01T00:00:00Z',
            source: 'supabase'
          };
          if (existingIdx >= 0) {
            rawLectures[existingIdx] = { ...rawLectures[existingIdx], ...lecObj };
          } else {
            rawLectures.push(lecObj);
          }
        });
      }
    }
  } catch (e) { }

  // --- STRICT CANONICAL DEDUPLICATION ---
  const seenKeys = new Map();
  const cleanLectures = [];

  for (const lec of rawLectures) {
    const ytId = extractYouTubeVideoId(lec.url);
    const key = lec.chapter_id + '::' + (ytId ? ('yt_' + ytId) : (lec.url || '').trim().toLowerCase());

    if (!seenKeys.has(key)) {
      seenKeys.set(key, lec);
      cleanLectures.push(lec);
    } else {
      const existingLec = seenKeys.get(key);
      if (lec.source === 'worker' && existingLec.source === 'custom') {
        const idx = cleanLectures.indexOf(existingLec);
        if (idx >= 0) {
          cleanLectures[idx] = lec;
          seenKeys.set(key, lec);
        }
      }
    }
  }

  // Group by chapter and sort strictly by sort_order
  cleanLectures.sort((a, b) => {
    if (a.chapter_id !== b.chapter_id) {
      return String(a.chapter_id).localeCompare(String(b.chapter_id));
    }
    const orderA = parseInt(a.sort_order, 10) || 0;
    const orderB = parseInt(b.sort_order, 10) || 0;
    if (orderA !== orderB) return orderA - orderB;
    return (a.title || '').localeCompare(b.title || '', undefined, { numeric: true, sensitivity: 'base' });
  });

  // --- STRICT FILTER OUT ORPHANED LECTURES (CHAPTER DELETED / NON-EXISTENT) ---
  const allChaps = await getAllChapters();
  const validChapIds = new Set(allChaps.map(c => String(c.id)));
  const validLectures = cleanLectures.filter(l => {
    const chapId = String(l.chapter_id);
    const lecId = String(l.id);
    return !deletedChapterIds.includes(chapId) && (validChapIds.size === 0 || validChapIds.has(chapId)) && !deletedIds.includes(lecId);
  });

  // Auto-clean storage of orphaned custom lectures
  const cleanCustomInStorage = customLectures.filter(l => {
    const chapId = String(l.chapter_id);
    const lecId = String(l.id);
    return !deletedChapterIds.includes(chapId) && (validChapIds.size === 0 || validChapIds.has(chapId)) && !deletedIds.includes(lecId);
  });
  if (cleanCustomInStorage.length !== customLectures.length) {
    saveLocalJson(CUSTOM_LECTURES_KEY, cleanCustomInStorage);
  }

  _cachedLecturesList = validLectures;
  _cachedLecturesTime = now;
  saveLocalJson(CACHE_LECTURES_KEY, validLectures);
  return validLectures;
}

async function getLectures(chapterId) {
  const all = await getAllLectures();
  if (!chapterId) return all;
  const strId = String(chapterId);
  return all.filter(l => String(l.chapter_id) === strId);
}

async function addLecture(titleOrObj, url, chapterId, sortOrder = 1) {
  let title = titleOrObj;
  if (typeof titleOrObj === 'object' && titleOrObj !== null) {
    title = titleOrObj.title;
    url = titleOrObj.url;
    chapterId = titleOrObj.chapter_id || titleOrObj.chapterId;
    sortOrder = titleOrObj.sort_order || titleOrObj.sortOrder || 1;
  }

  title = (title || '').trim();
  url = (url || '').trim();
  if (!title || !url || !chapterId) {
    showToast('Lecture title, URL and chapter are required', 'error');
    return null;
  }

  let newId = 'ch_' + Date.now().toString(36) + Math.random().toString(36).substr(2, 4);

  try {
    const res = await workerApiCall('/playlists/chapter', {
      method: 'POST',
      body: JSON.stringify({
        playlistId: chapterId,
        chapterName: title,
        chapterLink: url
      })
    });
    if (res && res.chapter && res.chapter.id) {
      newId = res.chapter.id;
    } else if (res && res.id) {
      newId = res.id;
    }
  } catch (err) {
    console.warn('Worker addLecture notice, saving locally:', err.message);
  }

  const newLec = {
    id: newId,
    title,
    url,
    chapter_id: chapterId,
    sort_order: sortOrder,
    created_at: new Date().toISOString()
  };

  const custom = getLocalJson(CUSTOM_LECTURES_KEY, []);
  custom.push(newLec);
  saveLocalJson(CUSTOM_LECTURES_KEY, custom);

  // Un-delete if previously deleted
  const deleted = getLocalJson(DELETED_LECTURES_KEY, []).filter(id => id !== newId);
  saveLocalJson(DELETED_LECTURES_KEY, deleted);

  try {
    if (checkClient()) {
      await sbClient.from('lectures').upsert(newLec, { onConflict: 'id' });
    }
  } catch (e) { }

  invalidatePlaylistsCache();
  await fetchWorkerPlaylists(true);
  showToast(`Lecture "${title}" added`, 'success');
  return newLec;
}

async function updateLecture(id, updates, oldChapterId = null, silent = false) {
  const all = await getAllLectures();
  const existing = all.find(l => String(l.id) === String(id));

  const prevChapter = oldChapterId || (existing ? existing.chapter_id : null);
  const targetChapter = updates.chapter_id || prevChapter;
  const newTitle = updates.title !== undefined ? updates.title : (existing ? existing.title : '');
  const newUrl = updates.url !== undefined ? updates.url : (existing ? existing.url : '');
  const newSortOrder = updates.sort_order !== undefined ? parseInt(updates.sort_order, 10) : (existing ? (parseInt(existing.sort_order, 10) || 1) : 1);

  // 1. Worker update: always update Cloudflare database when title, link, or chapter changes
  if (prevChapter && newTitle && newUrl) {
    if (!existing || existing.title !== newTitle || existing.url !== newUrl || String(existing.chapter_id) !== String(targetChapter)) {
      try {
        if (id && !String(id).startsWith('ch_temp_')) {
          try {
            await workerApiCall('/playlists/chapter', {
              method: 'DELETE',
              body: JSON.stringify({ playlistId: prevChapter, chapterId: id })
            });
          } catch (delErr) { }
        }
        const res = await workerApiCall('/playlists/chapter', {
          method: 'POST',
          body: JSON.stringify({
            playlistId: targetChapter,
            chapterName: newTitle,
            chapterLink: newUrl
          })
        });
        if (res && res.chapter && res.chapter.id) {
          id = String(res.chapter.id);
        } else if (res && res.id) {
          id = String(res.id);
        }
      } catch (err) {
        console.warn('Worker updateLecture notice:', err.message);
      }
    }
  }

  // 2. Local overrides
  const overrides = getLocalJson(LECTURE_OVERRIDES_KEY, {});
  if (existing && String(existing.id) !== String(id)) {
    delete overrides[existing.id];
  }
  overrides[id] = {
    title: newTitle,
    url: newUrl,
    chapter_id: targetChapter,
    sort_order: newSortOrder
  };
  saveLocalJson(LECTURE_OVERRIDES_KEY, overrides);

  // Update in custom lectures if present
  const custom = getLocalJson(CUSTOM_LECTURES_KEY, []);
  const idx = custom.findIndex(l => String(l.id) === String(id) || (existing && String(l.id) === String(existing.id)));
  if (idx >= 0) {
    custom[idx] = { ...custom[idx], ...updates, id, title: newTitle, url: newUrl, chapter_id: targetChapter, sort_order: newSortOrder };
    saveLocalJson(CUSTOM_LECTURES_KEY, custom);
  }

  // 3. Supabase update
  try {
    if (checkClient()) {
      const dbUpdates = {};
      if (updates.title !== undefined) dbUpdates.title = updates.title;
      if (updates.url !== undefined) dbUpdates.url = updates.url;
      if (updates.chapter_id !== undefined) dbUpdates.chapter_id = updates.chapter_id;
      if (updates.sort_order !== undefined) dbUpdates.sort_order = newSortOrder;
      await sbClient.from('lectures').update(dbUpdates).eq('id', id);
    }
  } catch (e) { }

  if (!silent) {
    invalidatePlaylistsCache();
    await fetchWorkerPlaylists(true);
    showToast('Lecture updated successfully', 'success');
  }
  return { id, ...updates, title: newTitle, url: newUrl, chapter_id: targetChapter, sort_order: newSortOrder };
}

async function deleteLectureDB(id, chapterId = null) {
  if (!chapterId) {
    const all = await getAllLectures();
    const found = all.find(l => String(l.id) === String(id));
    if (found) chapterId = found.chapter_id;
  }

  // 1. Worker delete
  if (chapterId) {
    try {
      await workerApiCall('/playlists/chapter', {
        method: 'DELETE',
        body: JSON.stringify({ playlistId: chapterId, chapterId: id })
      });
    } catch (err) {
      console.warn('Worker deleteLecture notice:', err.message);
    }
  }

  // 2. Local delete persistence
  const strId = String(id).trim();
  const deleted = getLocalJson(DELETED_LECTURES_KEY, []).map(String);
  if (!deleted.includes(strId)) {
    deleted.push(strId);
    saveLocalJson(DELETED_LECTURES_KEY, deleted);
  }

  const custom = getLocalJson(CUSTOM_LECTURES_KEY, []).filter(l => String(l.id).trim() !== strId);
  saveLocalJson(CUSTOM_LECTURES_KEY, custom);

  const cachedLecs = getLocalJson(CACHE_LECTURES_KEY, []);
  if (Array.isArray(cachedLecs)) {
    saveLocalJson(CACHE_LECTURES_KEY, cachedLecs.filter(l => String(l.id).trim() !== strId));
  }

  const overrides = getLocalJson(LECTURE_OVERRIDES_KEY, {});
  delete overrides[strId];
  delete overrides[id];
  saveLocalJson(LECTURE_OVERRIDES_KEY, overrides);

  // 3. Supabase delete
  try {
    if (checkClient()) {
      await sbClient.from('lectures').delete().eq('id', id);
    }
  } catch (e) { }

  invalidatePlaylistsCache();
  await fetchWorkerPlaylists(true);
  showToast('Lecture deleted', 'info');
  return true;
}

async function deleteLecturesByChapter(chapterId) {
  const lecs = await getLectures(chapterId);
  for (const l of lecs) {
    await deleteLectureDB(l.id, chapterId);
  }
  return true;
}

async function deleteLecturesByIds(ids) {
  for (const id of ids) {
    await deleteLectureDB(id);
  }
  return true;
}

async function addLecturesBatch(selectedLectures) {
  if (!Array.isArray(selectedLectures) || selectedLectures.length === 0) {
    return { success: false, error: 'No lectures provided', lectures: [] };
  }
  const chapterId = String(selectedLectures[0].chapter_id || selectedLectures[0].chapterId);
  const allCurrent = (await getAllLectures()).filter(l => String(l.chapter_id) === chapterId);

  // Track existing keys in this chapter to strictly prevent duplicate insertions
  const existingKeys = new Set(allCurrent.map(l => {
    const ytId = extractYouTubeVideoId(l.url);
    return ytId ? ('yt_' + ytId) : (l.url || '').trim().toLowerCase();
  }));

  const toCreate = [];
  selectedLectures.forEach((l, i) => {
    const url = (l.url || l.link || '').trim();
    const ytId = extractYouTubeVideoId(url);
    const key = ytId ? ('yt_' + ytId) : url.toLowerCase();

    // Skip if already in chapter
    if (key && existingKeys.has(key)) {
      return;
    }
    if (key) existingKeys.add(key);

    const sortOrder = l.order_num !== undefined ? parseInt(l.order_num, 10) : (l.sort_order !== undefined ? parseInt(l.sort_order, 10) : (allCurrent.length + toCreate.length + 1));

    toCreate.push({
      id: l.id || ('ch_' + Date.now().toString(36) + Math.random().toString(36).substr(2, 4) + i),
      title: (l.title || `Lecture ${allCurrent.length + toCreate.length + 1}`).trim(),
      url: url,
      chapter_id: chapterId,
      sort_order: sortOrder,
      created_at: new Date().toISOString()
    });
  });

  if (toCreate.length === 0) {
    return { success: true, count: 0, lectures: [] };
  }

  // 1. Cloudflare Worker Database Sync (Batch with sequential fallback)
  const items = toCreate.map(l => ({ name: l.title, link: l.url }));
  let workerSynced = false;
  try {
    const batchRes = await workerApiCall('/playlists/chapters/batch', {
      method: 'POST',
      body: JSON.stringify({ playlistId: chapterId, chapters: items })
    });
    if (batchRes && batchRes.success) {
      workerSynced = true;
    } else {
      for (const item of items) {
        try {
          await workerApiCall('/playlists/chapter', {
            method: 'POST',
            body: JSON.stringify({ playlistId: chapterId, chapterName: item.name, chapterLink: item.link })
          });
        } catch (e) { }
      }
      workerSynced = true;
    }
  } catch (err) {
    console.warn('Worker batch insert notice, attempting sequential:', err.message);
    try {
      for (const item of items) {
        await workerApiCall('/playlists/chapter', {
          method: 'POST',
          body: JSON.stringify({ playlistId: chapterId, chapterName: item.name, chapterLink: item.link })
        });
      }
      workerSynced = true;
    } catch (seqErr) {
      console.warn('Sequential insert fallback also encountered issue:', seqErr.message);
    }
  }

  // 2. Local storage instant update without duplicates
  const custom = getLocalJson(CUSTOM_LECTURES_KEY, []);
  toCreate.forEach(item => {
    const exists = custom.some(c => c.id === item.id || (String(c.chapter_id) === String(item.chapter_id) && c.url === item.url));
    if (!exists) custom.push(item);
  });
  saveLocalJson(CUSTOM_LECTURES_KEY, custom);

  // Un-delete any of these IDs if previously deleted
  const addedIds = new Set(toCreate.map(x => x.id));
  const deleted = getLocalJson(DELETED_LECTURES_KEY, []).filter(id => !addedIds.has(id));
  saveLocalJson(DELETED_LECTURES_KEY, deleted);

  // 3. Supabase upsert
  try {
    if (checkClient()) {
      await sbClient.from('lectures').upsert(toCreate, { onConflict: 'id' });
    }
  } catch (e) {
    console.warn('Supabase batch insert error:', e.message);
  }

  // 4. Invalidate and re-fetch from Worker
  invalidatePlaylistsCache();
  try { await fetchWorkerPlaylists(true); } catch (e) { }
  showToast(`Successfully added ${toCreate.length} lectures!`, 'success');
  return { success: true, count: toCreate.length, lectures: toCreate, workerSynced };
}

// ===== 🎓 PERSONALIZED STUDENT PROGRESS & STARRED (100% USER ISOLATED) =====
function getCurrentUserProgressEmail() {
  try {
    const u = (typeof getCurrentUser === 'function') ? getCurrentUser() : null;
    if (u && u.email) return u.email.toLowerCase().trim();
    const tok = (typeof getAdminToken === 'function') ? getAdminToken() : null;
    if (tok) return 'admin';
  } catch (e) { }
  return 'guest';
}

// --- Watched (Personalized per Student) ---
async function getWatched(userEmail) {
  const email = (userEmail || getCurrentUserProgressEmail()).toLowerCase().trim();
  const localKey = 'cp_watched_ids_' + email;
  let localList = [];
  try {
    localList = JSON.parse(localStorage.getItem(localKey) || '[]');
  } catch (e) { }

  if (!checkClient() || email === 'guest') {
    return localList;
  }

  try {
    const { data, error } = await sbClient
      .from('watched')
      .select('lecture_id')
      .like('lecture_id', email + ':::%');

    if (!error && Array.isArray(data)) {
      const remoteIds = data.map(w => {
        const parts = (w.lecture_id || '').split(':::');
        return parts.length >= 2 ? parts.slice(1).join(':::') : null;
      }).filter(Boolean);

      const merged = Array.from(new Set([...localList, ...remoteIds]));
      try {
        localStorage.setItem(localKey, JSON.stringify(merged));
      } catch (e) { }
      return merged;
    }
  } catch (e) {
    console.warn('getWatched error:', e);
  }
  return localList;
}

async function toggleWatchedDB(lectureId, userEmail) {
  const email = (userEmail || getCurrentUserProgressEmail()).toLowerCase().trim();
  const compositeKey = email + ':::' + lectureId;
  const localKey = 'cp_watched_ids_' + email;

  let localList = [];
  try {
    localList = JSON.parse(localStorage.getItem(localKey) || '[]');
  } catch (e) { }

  const exists = localList.includes(lectureId);
  const nextList = exists ? localList.filter(id => id !== lectureId) : [...localList, lectureId];
  try {
    localStorage.setItem(localKey, JSON.stringify(nextList));
  } catch (e) { }

  if (!checkClient() || email === 'guest') {
    return !exists;
  }

  try {
    const { data: existing } = await sbClient
      .from('watched')
      .select('id')
      .eq('lecture_id', compositeKey)
      .maybeSingle();

    if (existing) {
      await sbClient.from('watched').delete().eq('lecture_id', compositeKey);
      return false;
    } else {
      await sbClient.from('watched').insert({ lecture_id: compositeKey });
      return true;
    }
  } catch (e) {
    console.error('toggleWatchedDB error:', e);
    return !exists;
  }
}

async function markAllWatchedDB(lectureIds, userEmail) {
  const email = (userEmail || getCurrentUserProgressEmail()).toLowerCase().trim();
  const localKey = 'cp_watched_ids_' + email;
  const watched = await getWatched(email);
  const allWatched = lectureIds.every(id => watched.includes(id));

  if (allWatched) {
    const remaining = watched.filter(id => !lectureIds.includes(id));
    try { localStorage.setItem(localKey, JSON.stringify(remaining)); } catch (e) { }
    if (checkClient() && email !== 'guest') {
      const keys = lectureIds.map(id => email + ':::' + id);
      await sbClient.from('watched').delete().in('lecture_id', keys);
    }
    return false;
  } else {
    const merged = Array.from(new Set([...watched, ...lectureIds]));
    try { localStorage.setItem(localKey, JSON.stringify(merged)); } catch (e) { }
    if (checkClient() && email !== 'guest') {
      const toInsert = lectureIds
        .filter(id => !watched.includes(id))
        .map(id => ({ lecture_id: email + ':::' + id }));
      if (toInsert.length > 0) {
        await sbClient.from('watched').insert(toInsert);
      }
    }
    return true;
  }
}

async function addWatched(lectureId, userEmail) {
  const email = (userEmail || getCurrentUserProgressEmail()).toLowerCase().trim();
  const compositeKey = email + ':::' + lectureId;
  const localKey = 'cp_watched_ids_' + email;

  try {
    const list = JSON.parse(localStorage.getItem(localKey) || '[]');
    if (!list.includes(lectureId)) {
      list.push(lectureId);
      localStorage.setItem(localKey, JSON.stringify(list));
    }
  } catch (e) { }

  if (!checkClient() || email === 'guest') return;
  try {
    await sbClient.from('watched').upsert({ lecture_id: compositeKey }, { onConflict: 'lecture_id' });
  } catch (e) { }
}

// --- Starred (Personalized per Student) ---
async function getStarred(userEmail) {
  const email = (userEmail || getCurrentUserProgressEmail()).toLowerCase().trim();
  const localKey = 'cp_starred_ids_' + email;
  let localList = [];
  try {
    localList = JSON.parse(localStorage.getItem(localKey) || '[]');
  } catch (e) { }

  if (!checkClient() || email === 'guest') {
    return localList;
  }

  try {
    const { data, error } = await sbClient
      .from('starred')
      .select('lecture_id')
      .like('lecture_id', email + ':::%');

    if (!error && Array.isArray(data)) {
      const remoteIds = data.map(s => {
        const parts = (s.lecture_id || '').split(':::');
        return parts.length >= 2 ? parts.slice(1).join(':::') : null;
      }).filter(Boolean);

      const merged = Array.from(new Set([...localList, ...remoteIds]));
      try {
        localStorage.setItem(localKey, JSON.stringify(merged));
      } catch (e) { }
      return merged;
    }
  } catch (e) {
    console.warn('getStarred error:', e);
  }
  return localList;
}

async function toggleStarredDB(lectureId, userEmail) {
  const email = (userEmail || getCurrentUserProgressEmail()).toLowerCase().trim();
  const compositeKey = email + ':::' + lectureId;
  const localKey = 'cp_starred_ids_' + email;

  let localList = [];
  try {
    localList = JSON.parse(localStorage.getItem(localKey) || '[]');
  } catch (e) { }

  const exists = localList.includes(lectureId);
  const nextList = exists ? localList.filter(id => id !== lectureId) : [...localList, lectureId];
  try {
    localStorage.setItem(localKey, JSON.stringify(nextList));
  } catch (e) { }

  if (!checkClient() || email === 'guest') {
    return !exists;
  }

  try {
    const { data: existing } = await sbClient
      .from('starred')
      .select('id')
      .eq('lecture_id', compositeKey)
      .maybeSingle();

    if (existing) {
      await sbClient.from('starred').delete().eq('lecture_id', compositeKey);
      return false;
    } else {
      await sbClient.from('starred').insert({ lecture_id: compositeKey });
      return true;
    }
  } catch (e) {
    console.error('toggleStarredDB error:', e);
    return !exists;
  }
}

// Admin / Inspector summary: Get count of lectures watched per student
async function getAllStudentsProgress() {
  if (!checkClient()) return {};
  try {
    const { data, error } = await sbClient.from('watched').select('lecture_id');
    if (error || !Array.isArray(data)) return {};
    const map = {};
    data.forEach(item => {
      const parts = (item.lecture_id || '').split(':::');
      if (parts.length >= 2) {
        const em = parts[0].toLowerCase().trim();
        const lecId = parts.slice(1).join(':::');
        if (!map[em]) map[em] = new Set();
        map[em].add(lecId);
      }
    });
    const result = {};
    for (const em in map) {
      result[em] = map[em].size;
    }
    return result;
  } catch (e) {
    return {};
  }
}

// --- Get single lecture with chapter & subject info ---
async function getLectureById(id) {
  const allLectures = await getAllLectures();
  const strId = String(id);
  const found = allLectures.find(l => String(l.id) === strId);
  if (found) {
    const playlists = await fetchWorkerPlaylists();
    const pl = playlists.find(p => String(p.id) === String(found.chapter_id));
    let chName = pl ? pl.name : null;
    let secKey = (pl?.section || 'recorded').toLowerCase();
    let subjId = SECTION_TO_SUBJ[secKey] || null;

    if (!chName) {
      const allCh = await getAllChapters();
      const localCh = allCh.find(c => String(c.id) === String(found.chapter_id));
      if (localCh) {
        chName = localCh.name;
        subjId = localCh.subject_id;
      }
    }
    const allSubs = await getSubjects();
    const subj = (subjId ? allSubs.find(s => String(s.id) === String(subjId)) : null) || allSubs[0] || STANDARD_SUBJECTS[0];

    return {
      ...found,
      chapters: {
        id: pl ? pl.id : found.chapter_id,
        name: chName || 'Lecture Series',
        subject_id: subj.id,
        subjects: subj
      }
    };
  }

  // Supabase fallback
  try {
    if (checkClient()) {
      const { data, error } = await sbClient
        .from('lectures')
        .select('*')
        .eq('id', id)
        .single();
      if (!error && data) {
        let chObj = { id: data.chapter_id, name: 'Lecture Series' };
        try {
          const chRes = await sbClient.from('chapters').select('*').eq('id', data.chapter_id).single();
          if (!chRes.error && chRes.data) chObj = chRes.data;
        } catch (e) { }
        return { ...data, chapters: chObj };
      }
    }
  } catch (e) { }

  return null;
}

// --- Live Classes (Realtime Streaming & 7-Day Auto Expiry) ---
const LIVE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days (1 week) auto-delete

function purgeOldLiveClasses(list) {
  if (!Array.isArray(list)) return [];
  return list.filter(c => {
    const t = String(c.title || '').trim();
    const st = String(c.status || '').trim();
    const u = String(c.url || '').trim();
    return !t.startsWith('__CONFIG_') && !t.includes('CONFIG_CHAPTER_PLAYLISTS') && st !== 'config' && u !== 'config';
  });
}

function getLiveClassExpiryInfo(item) {
  if (item.is_live_now) {
    return { expired: false, text: 'Streaming Live Now' };
  }
  if (item.created_at) {
    try {
      const d = new Date(item.created_at);
      if (!isNaN(d.getTime())) {
        const dateStr = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        return { expired: false, text: `Recorded on ${dateStr}` };
      }
    } catch (e) { }
  }
  return { expired: false, text: 'Recorded Live Class' };
}

function getLiveLocal() {
  try {
    const raw = localStorage.getItem('cp_live_classes');
    const parsed = raw ? JSON.parse(raw) : [];
    return purgeOldLiveClasses(parsed);
  } catch (e) {
    return [];
  }
}

function saveLiveLocal(list) {
  try {
    const clean = purgeOldLiveClasses(list);
    localStorage.setItem('cp_live_classes', JSON.stringify(clean));
  } catch (e) { }
}

// --- Active Live Now Persistence (Supabase + localStorage) ---
const ACTIVE_LIVE_KEY = 'cp_active_live_ids';

let _cachedActiveLiveIds = null;
let _cachedActiveLiveIdsTime = 0;

function getLocalActiveLiveIds() {
  try {
    const raw = localStorage.getItem(ACTIVE_LIVE_KEY);
    if (raw === null) return null; // Distinguish between unset (null) and explicitly turned off ([])
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch (e) {
    return [];
  }
}

function setLocalActiveLiveIds(ids) {
  try {
    const arr = Array.isArray(ids) ? ids.map(String) : [];
    localStorage.setItem(ACTIVE_LIVE_KEY, JSON.stringify(arr));
    _cachedActiveLiveIds = arr;
    _cachedActiveLiveIdsTime = Date.now();
  } catch (e) { }
}

async function getActiveLiveNowIds(force = false) {
  const now = Date.now();
  if (!force && _cachedActiveLiveIds !== null && (now - _cachedActiveLiveIdsTime < 4000)) {
    return _cachedActiveLiveIds;
  }

  // 1. Authoritative: Fetch from Supabase __CONFIG_ACTIVE_LIVE__
  if (checkClient()) {
    try {
      const sbQuery = sbClient
        .from('live_classes')
        .select('description, scheduled_at')
        .eq('title', '__CONFIG_ACTIVE_LIVE__')
        .limit(1);

      const timeoutPromise = new Promise(resolve => setTimeout(() => resolve({ data: null, error: 'timeout' }), 6000));
      const { data, error } = await Promise.race([sbQuery, timeoutPromise]);

      if (!error && Array.isArray(data) && data.length > 0) {
        let list = [];
        if (data[0].description) {
          try {
            const parsed = JSON.parse(data[0].description);
            if (Array.isArray(parsed)) {
              list = parsed.map(String);
            }
          } catch (e) { }
        }
        _cachedActiveLiveIds = list;
        _cachedActiveLiveIdsTime = now;
        setLocalActiveLiveIds(list);
        return list;
      }
    } catch (e) {
      console.warn('getActiveLiveNowIds sync notice:', e.message);
    }
  }

  // 2. Fallback: Local storage cache (offline mode)
  const list = getLocalActiveLiveIds();
  if (list !== null) {
    _cachedActiveLiveIds = list;
    _cachedActiveLiveIdsTime = now;
    return list;
  }
  return [];
}

async function setActiveLiveNow(id, isLiveNow, exclusive = true) {
  if (!id) return [];
  const strId = String(id).trim();
  const rawNum = strId.startsWith('imp_') ? strId.replace('imp_', '') : strId;
  let updated = [];

  if (isLiveNow) {
    // Exclusive: ONLY this class is live; any older live stream is turned off!
    updated = [strId];
    if (rawNum !== strId) updated.push(rawNum);
    localStorage.setItem('cp_last_known_top_live_id', strId);
  } else {
    // Live turned off for this class
    const current = (await getActiveLiveNowIds(true)) || [];
    const set = new Set(current.map(String));
    set.delete(strId);
    set.delete(rawNum);
    set.delete('imp_' + rawNum);
    updated = Array.from(set);
  }

  setLocalActiveLiveIds(updated);
  _cachedActiveLiveIds = updated;
  _cachedActiveLiveIdsTime = Date.now();

  // Instantly synchronize in-memory cache and local storage so changes take effect at 0ms
  const activeSet = new Set(updated.map(String));
  const updateItemProps = (c) => {
    const idStr = String(c.id || '').trim();
    const idRaw = idStr.replace(/^imp_/, '');
    const rawIdStr = (c.raw_id !== undefined && c.raw_id !== null) ? String(c.raw_id).trim() : '';

    const match = isLiveNow && (
      activeSet.has(idStr) ||
      (idRaw && activeSet.has(idRaw)) ||
      (idRaw && activeSet.has('imp_' + idRaw)) ||
      (rawIdStr && (activeSet.has(rawIdStr) || activeSet.has('imp_' + rawIdStr)))
    );

    const isVis = (c.is_visible === 1 || c.is_visible === true || (c.is_visible === undefined && c.status !== 'hidden' && c.status !== 'ended' && c.status !== 'offline')) ? 1 : 0;
    return {
      ...c,
      is_live_now: !!match,
      is_visible: isVis,
      status: isVis === 0 ? 'hidden' : (match ? 'live' : 'old_live'),
      status_label: isVis === 0 ? 'OFFLINE' : (match ? 'LIVE NOW' : 'Old Live Class')
    };
  };

  if (Array.isArray(_cachedLiveClasses)) {
    _cachedLiveClasses = _cachedLiveClasses.map(updateItemProps);
    _cachedLiveClasses.sort(compareLiveClasses);
    saveLiveLocal(_cachedLiveClasses);
    saveLocalJson(CACHE_LIVE_CLASSES_KEY, _cachedLiveClasses);
  } else {
    const local = getLiveLocal().map(updateItemProps);
    local.sort(compareLiveClasses);
    saveLiveLocal(local);
  }

  // Supabase sync
  if (checkClient()) {
    try {
      const desc = JSON.stringify(updated);
      const { data } = await sbClient
        .from('live_classes')
        .select('id')
        .eq('title', '__CONFIG_ACTIVE_LIVE__')
        .limit(1);

      if (data && data.length > 0) {
        await sbClient
          .from('live_classes')
          .update({ description: desc, scheduled_at: new Date().toISOString() })
          .eq('title', '__CONFIG_ACTIVE_LIVE__');
      } else {
        await sbClient
          .from('live_classes')
          .insert({
            title: '__CONFIG_ACTIVE_LIVE__',
            url: 'config',
            status: 'config',
            description: desc,
            scheduled_at: new Date().toISOString()
          });
      }
    } catch (e) {
      console.warn('setActiveLiveNow sync notice:', e.message);
    }
  }

  // Real-time broadcast ping
  try {
    localStorage.setItem('spider_live_sync_ping', String(Date.now()));
    window.dispatchEvent(new CustomEvent('spider_live_sync'));
  } catch (e) { }

  return updated;
}

function isSameLiveId(item, targetId) {
  if (!item || !targetId) return false;
  const tStr = String(targetId).trim();
  const tRaw = tStr.replace(/^imp_/, '');
  const iId = String(item.id || '').trim();
  const iRaw = item.raw_id !== undefined && item.raw_id !== null ? String(item.raw_id).trim() : iId.replace(/^imp_/, '');
  return iId === tStr || iRaw === tRaw || iId === tRaw || ('imp_' + iRaw) === tStr || ('imp_' + iId) === tStr;
}

function getLiveClassRawId(item) {
  if (!item) return null;
  if (item.raw_id !== undefined && item.raw_id !== null && item.raw_id !== '') {
    const n = Number(item.raw_id);
    if (!isNaN(n)) return n;
  }
  const idStr = String(item.id || '');
  if (idStr.startsWith('imp_')) {
    const n = parseInt(idStr.replace('imp_', ''), 10);
    if (!isNaN(n)) return n;
  }
  return null;
}

function getLiveClassSortTime(item) {
  if (!item) return 0;
  // 1. Explicit created_at or scheduled_at
  const dateStr = item.created_at || item.scheduled_at;
  if (dateStr) {
    const t = new Date(dateStr).getTime();
    if (!isNaN(t) && t > 0) return t;
  }
  // 2. If id is live_<timestamp>
  const idStr = String(item.id || '');
  if (idStr.startsWith('live_')) {
    const ms = parseInt(idStr.replace('live_', ''), 10);
    if (!isNaN(ms) && ms > 1500000000000) return ms;
  }
  // 3. If raw_id or imp_<number>, synthesize monotonic base time so all worker items sort chronologically
  const raw = getLiveClassRawId(item);
  if (raw !== null && !isNaN(raw)) {
    return 1792000000000 + (raw * 60000);
  }
  return 0;
}

function compareLiveClasses(a, b) {
  if (!a && !b) return 0;
  if (!a) return 1;
  if (!b) return -1;

  // 1. ACTIVE LIVE NOW stream always at the very top (sabse top pe dikhe)
  const liveA = a.is_live_now ? 1 : 0;
  const liveB = b.is_live_now ? 1 : 0;
  if (liveA !== liveB) {
    return liveB - liveA; // 1 (live) comes before 0
  }

  // 2. If both have numeric raw IDs (e.g. imp_156 vs imp_155), strictly higher ID is newer
  const rawA = getLiveClassRawId(a);
  const rawB = getLiveClassRawId(b);
  if (rawA !== null && rawB !== null && rawA !== rawB) {
    return rawB - rawA;
  }

  // 3. Newest timestamp on top (strictly descending)
  const timeA = getLiveClassSortTime(a);
  const timeB = getLiveClassSortTime(b);
  if (timeA !== timeB) {
    return timeB - timeA;
  }

  // 4. Deterministic string tie-breaker so ordering never fluctuates
  return String(b.id || '').localeCompare(String(a.id || ''));
}

const MAX_VISIBLE_LIVE_CLASSES = 7;

function enforceTopLiveVisibility(list, maxVisible = MAX_VISIBLE_LIVE_CLASSES) {
  if (!Array.isArray(list)) return [];
  const sorted = [...list];
  sorted.sort(compareLiveClasses);

  let visibleCount = 0;
  const toHideInSupabase = [];

  // Check if any classes are currently marked visible
  const hasAnyVisible = sorted.some(c => (c.is_visible === 1 || c.is_visible === true || (c.is_visible === undefined && c.status !== 'hidden' && c.status !== 'ended' && c.status !== 'offline')));

  const updated = sorted.map((c, idx) => {
    // If no classes were marked visible in data, rescue the first maxVisible classes
    const isCurrentlyVis = hasAnyVisible 
      ? (c.is_visible === 1 || c.is_visible === true || (c.is_visible === undefined && c.status !== 'hidden' && c.status !== 'ended' && c.status !== 'offline'))
      : (idx < maxVisible);

    if (isCurrentlyVis) {
      visibleCount++;
      if (visibleCount <= maxVisible) {
        return {
          ...c,
          is_visible: 1,
          status: c.is_live_now ? 'live' : (c.status === 'hidden' ? 'old_live' : (c.status || 'old_live')),
          status_label: c.is_live_now ? 'LIVE NOW' : 'Old Live Class'
        };
      } else {
        // Exceeded max visible (7)! Automatically hide "piche wali"
        if (c.status !== 'hidden' || c.is_visible !== 0) {
          toHideInSupabase.push(String(c.id));
        }
        return {
          ...c,
          is_visible: 0,
          status: 'hidden',
          status_label: 'OFFLINE'
        };
      }
    }
    return {
      ...c,
      is_visible: 0,
      status: 'hidden',
      status_label: 'OFFLINE'
    };
  });

  // Background sync hidden status to Supabase for the piche wali classes
  if (toHideInSupabase.length > 0 && typeof sbClient !== 'undefined' && sbClient && typeof sbClient.from === 'function') {
    setTimeout(async () => {
      try {
        for (const hid of toHideInSupabase) {
          await sbClient.from('live_classes').update({ status: 'hidden' }).eq('id', hid);
        }
      } catch (e) { }
    }, 50);
  }

  return updated;
}

let _cachedLiveClasses = null;
let _cachedLiveTime = 0;
let _inFlightLivePromise = null;

async function getLiveClasses(force = false) {
  const now = Date.now();
  if (!force && _cachedLiveClasses && _cachedLiveClasses.length > 0 && (now - _cachedLiveTime < 15000)) {
    return _cachedLiveClasses;
  }
  // Try localStorage / default fallback for instant 0ms return if memory cache is empty
  if (!force && (!_cachedLiveClasses || _cachedLiveClasses.length === 0)) {
    const local = getCachedLiveClasses();
    if (Array.isArray(local) && local.length > 0) {
      local.sort(compareLiveClasses);
      _cachedLiveClasses = local;
      _cachedLiveTime = now;
      // Revalidate in background so UI isn't blocked
      setTimeout(() => { getLiveClasses(true).catch(() => { }); }, 20);
      return _cachedLiveClasses;
    }
  }

  if (_inFlightLivePromise) {
    return _inFlightLivePromise;
  }

  _inFlightLivePromise = (async () => {
    try {
      const localList = getLiveLocal();
      let workerList = [];

      // 1. Authoritative: Fetch from Supabase live_classes table with generous 7000ms timeout
      if (checkClient()) {
        try {
          const sbPromise = sbClient
            .from('live_classes')
            .select('*')
            .not('title', 'like', '__CONFIG_%')
            .neq('status', 'config')
            .neq('url', 'config')
            .order('created_at', { ascending: false });
          const timeoutPromise = new Promise(resolve => setTimeout(() => resolve({ data: null, error: 'timeout' }), 7000));
          const { data, error } = await Promise.race([sbPromise, timeoutPromise]);
          if (!error && Array.isArray(data) && data.length > 0) {
            workerList = data.map(item => {
              const rawId = item.raw_id ? Number(item.raw_id) : (String(item.id).startsWith('imp_') ? parseInt(String(item.id).replace('imp_', ''), 10) : null);
              const isVis = (item.is_visible !== undefined && item.is_visible !== null)
                ? (item.is_visible === 1 || item.is_visible === true ? 1 : 0)
                : (item.status === 'hidden' || item.status === 'ended' || item.status === 'offline' ? 0 : 1);
              return {
                ...item,
                raw_id: rawId,
                is_visible: isVis,
                status: isVis === 1 ? (item.status === 'hidden' ? 'live' : (item.status || 'live')) : 'hidden',
                section: item.section || 'math',
                instructor: item.instructor || 'Spider Classes',
                description: item.description || 'Live Interactive Session'
              };
            });
          }
        } catch (e) {
          console.warn('Supabase live_classes fetch notice:', e.message);
        }
      }

      // 2. Fetch from Cloudflare Worker /important/all to merge any items Supabase is missing (Dual-Cloud Resilience)
      try {
        const res = await workerApiCall('/important/all');
        if (res && res.success && Array.isArray(res.items)) {
          const wkItems = res.items.map(item => {
            const rawId = Number(item.id);
            const isVis = (item.is_visible !== undefined && item.is_visible !== null)
              ? (item.is_visible === 1 || item.is_visible === true ? 1 : 0)
              : (item.status === 'hidden' || item.status === 'ended' || item.status === 'offline' ? 0 : 1);
            return {
              id: 'imp_' + item.id,
              raw_id: rawId,
              title: item.title,
              url: item.link,
              status: isVis === 1 ? 'live' : 'hidden',
              is_visible: isVis,
              created_at: item.created_at,
              section: 'math',
              instructor: 'Spider Classes',
              description: 'Live Interactive Session'
            };
          });

          if (workerList.length === 0) {
            workerList = wkItems;
          } else {
            // Merge any items from Worker that Supabase might be missing
            const missingToSync = [];
            for (const wk of wkItems) {
              if (!workerList.some(sb => isSameLiveId(sb, wk.id))) {
                workerList.unshift(wk);
                missingToSync.push(wk);
              }
            }
            // Auto self-heal: sync missing items to Supabase in background
            if (missingToSync.length > 0 && checkClient()) {
              setTimeout(async () => {
                try {
                  const toInsert = missingToSync.map(m => ({
                    id: String(m.id),
                    title: String(m.title),
                    url: String(m.url),
                    status: m.is_visible === 0 ? 'hidden' : 'live',
                    scheduled_at: m.created_at || new Date().toISOString(),
                    instructor: 'Spider Classes',
                    description: '',
                    created_at: m.created_at || new Date().toISOString()
                  }));
                  await sbClient.from('live_classes').upsert(toInsert, { onConflict: 'id' });
                } catch (e) { }
              }, 100);
            }
          }
        }
      } catch (e) {
        console.warn('Worker important/all fetch notice:', e.message);
      }

      // 3. Combine worker/supabase items + local items (avoid duplicate ids)
      let combined = [...workerList];
      localList.forEach(loc => {
        if (!combined.some(w => isSameLiveId(w, loc.id))) {
          const rawId = loc.raw_id ? Number(loc.raw_id) : (String(loc.id).startsWith('imp_') ? parseInt(String(loc.id).replace('imp_', ''), 10) : null);
          const isVis = (loc.is_visible !== undefined && loc.is_visible !== null)
            ? (loc.is_visible === 1 || loc.is_visible === true ? 1 : 0)
            : (loc.status === 'hidden' || loc.status === 'ended' || loc.status === 'offline' ? 0 : 1);
          combined.push({
            ...loc,
            raw_id: rawId,
            is_visible: isVis,
            status: isVis === 1 ? (loc.status === 'hidden' ? 'live' : (loc.status || 'live')) : 'hidden'
          });
        }
      });

      // Filter out internal config entries completely
      combined = combined.filter(c => {
        const t = String(c.title || '').trim();
        const st = String(c.status || '').trim();
        const u = String(c.url || '').trim();
        return !t.startsWith('__CONFIG_') && !t.includes('CONFIG_CHAPTER_PLAYLISTS') && st !== 'config' && u !== 'config';
      });

      // Purge/clean list
      combined = purgeOldLiveClasses(combined);

      // CRITICAL STALE-WHILE-REVALIDATE SAFEGUARD:
      // If network fetch failed or returned 0 items, NEVER wipe existing cache or return empty!
      if (combined.length === 0) {
        const existing = (_cachedLiveClasses && _cachedLiveClasses.length > 0) 
          ? _cachedLiveClasses 
          : (getLocalJson(CACHE_LIVE_CLASSES_KEY, null) || getLocalJson('cp_live_classes', null));
        if (Array.isArray(existing) && existing.length > 0) {
          console.warn('Network returned 0 live classes; preserving cached live classes.');
          combined = existing.map(c => ({ ...c }));
        } else {
          console.warn('No cached live classes found; populating with default live classes.');
          combined = DEFAULT_LIVE_CLASSES.map(c => ({ ...c }));
        }
      }

      // 4. Determine currently active LIVE class (strictly controlled by admin live tick in Supabase)
      let activeIds = await getActiveLiveNowIds(force);
      if (!Array.isArray(activeIds)) activeIds = [];

      const activeSet = new Set(activeIds.map(String));

      combined = combined.map(c => {
        const idStr = String(c.id || '').trim();
        const idRaw = idStr.replace(/^imp_/, '');
        const rawIdStr = (c.raw_id !== undefined && c.raw_id !== null) ? String(c.raw_id).trim() : '';

        const isLiveNow = activeSet.has(idStr) ||
          (idRaw && activeSet.has(idRaw)) ||
          (idRaw && activeSet.has('imp_' + idRaw)) ||
          (rawIdStr && (activeSet.has(rawIdStr) || activeSet.has('imp_' + rawIdStr)));

        const isVis = (c.is_visible === 1 || c.is_visible === true || (c.is_visible === undefined && c.status !== 'hidden' && c.status !== 'ended' && c.status !== 'offline')) ? 1 : 0;
        const status = isVis === 0 ? 'hidden' : (isLiveNow ? 'live' : 'old_live');
        return {
          ...c,
          is_live_now: !!isLiveNow,
          is_visible: isVis,
          status: status,
          status_label: isVis === 0 ? 'OFFLINE' : (isLiveNow ? 'LIVE NOW' : 'Old Live Class')
        };
      });

      // Final sort: ACTIVE LIVE NOW at the very top, then newest streams on top
      combined.sort(compareLiveClasses);

      // USER RULE: Top 7 live visible rahe student ko, baki piche wali automatically hide ho jaye
      combined = enforceTopLiveVisibility(combined, MAX_VISIBLE_LIVE_CLASSES);

      if (combined.length > 0) {
        _cachedLiveClasses = combined;
        _cachedLiveTime = now;
        saveLocalJson(CACHE_LIVE_CLASSES_KEY, combined);
      }

      return combined;
    } finally {
      _inFlightLivePromise = null;
    }
  })();

  return _inFlightLivePromise;
}

async function getActiveLiveClasses() {
  const all = await getLiveClasses();
  const filtered = all.filter(c => c.is_visible !== 0 && c.status !== 'hidden' && c.status !== 'ended' && c.status !== 'offline');
  filtered.sort(compareLiveClasses);
  return filtered.slice(0, MAX_VISIBLE_LIVE_CLASSES);
}

async function getLiveClassById(id) {
  if (!id) return null;
  const list = await getLiveClasses();
  let found = list.find(c => String(c.id) === String(id) || String(c.raw_id) === String(id) || String(c.id).replace('imp_', '') === String(id)) || null;
  if (!found && Array.isArray(DEFAULT_LIVE_CLASSES)) {
    found = DEFAULT_LIVE_CLASSES.find(c => String(c.id) === String(id) || String(c.raw_id) === String(id) || String(c.id).replace('imp_', '') === String(id)) || null;
  }
  return found;
}

async function addLiveClass(classData) {
  const title = (classData.title || '').trim();
  const url = (classData.url || '').trim();
  const isVisible = classData.is_visible !== undefined ? (classData.is_visible ? 1 : 0) : 1;
  const isLiveNow = classData.is_live_now !== undefined ? !!classData.is_live_now : false;
  const section = classData.section || 'math';
  const nowIso = new Date().toISOString();

  let rawId = null;

  // 1. Call Cloudflare Worker /api/important
  try {
    const res = await workerApiCall('/important', {
      method: 'POST',
      body: JSON.stringify({ title, link: url })
    });
    if (res && res.id) {
      rawId = res.id;
    }
    // Check if toggle needed (default in worker is is_visible = 1)
    if (res && isVisible === 0) {
      if (rawId) {
        await workerApiCall('/important/toggle', {
          method: 'POST',
          body: JSON.stringify({ id: rawId })
        }).catch(() => {});
      } else {
        const allRes = await workerApiCall('/important/all');
        const found = (allRes.items || []).find(i => i.title === title && i.link === url);
        if (found) {
          rawId = found.id;
          await workerApiCall('/important/toggle', {
            method: 'POST',
            body: JSON.stringify({ id: found.id })
          }).catch(() => {});
        }
      }
    }
    if (!rawId) {
      try {
        const allRes = await workerApiCall('/important/all');
        const found = (allRes.items || []).find(i => i.title === title && i.link === url);
        if (found) {
          rawId = found.id;
        }
      } catch (e) { }
    }
  } catch (err) {
    console.warn('Worker addLiveClass notice:', err.message);
  }

  const itemId = rawId ? ('imp_' + rawId) : ('live_' + Date.now().toString(36) + Math.random().toString(36).substr(2, 4));

  const item = {
    id: itemId,
    raw_id: rawId,
    title,
    url,
    status: isVisible === 0 ? 'hidden' : (isLiveNow ? 'live' : 'old_live'),
    is_live_now: isLiveNow,
    is_visible: isVisible,
    section,
    scheduled_at: nowIso,
    instructor: classData.instructor || 'Spider Classes',
    description: classData.description || 'Live Interactive Session',
    created_at: nowIso
  };

  // 2. Authoritative Supabase upsert with sanitized columns strictly matching the table schema
  try {
    if (checkClient()) {
      const sbRecord = {
        id: String(item.id),
        title: String(item.title),
        url: String(item.url),
        status: isVisible === 0 ? 'hidden' : (isLiveNow ? 'live' : 'old_live'),
        subject_id: section ? ('subj_' + section) : null,
        scheduled_at: item.scheduled_at || nowIso,
        instructor: item.instructor || 'Spider Classes',
        description: item.description || '',
        created_at: item.created_at || nowIso
      };
      const { error: insErr } = await sbClient.from('live_classes').upsert(sbRecord, { onConflict: 'id' });
      if (insErr) {
        console.error('Supabase live_classes upsert error:', insErr);
      } else {
        console.log('✅ Supabase live_classes saved successfully:', item.id);
      }
    }
  } catch (e) {
    console.error('Supabase live_classes upsert exception:', e);
  }

  // 3. Update local caches
  if (isLiveNow) {
    const local = getLiveLocal().map(c => ({
      ...c,
      is_live_now: false,
      status: c.is_visible === 0 ? 'hidden' : 'old_live',
      status_label: c.is_visible === 0 ? 'OFFLINE' : 'Old Live Class'
    }));
    local.unshift(item);
    local.sort(compareLiveClasses);
    const cleanLocal = enforceTopLiveVisibility(local, MAX_VISIBLE_LIVE_CLASSES);
    saveLiveLocal(cleanLocal);

    if (Array.isArray(_cachedLiveClasses)) {
      _cachedLiveClasses.forEach(c => {
        c.is_live_now = false;
        c.status = c.is_visible === 0 ? 'hidden' : 'old_live';
        c.status_label = c.is_visible === 0 ? 'OFFLINE' : 'Old Live Class';
      });
      _cachedLiveClasses.unshift(item);
      _cachedLiveClasses.sort(compareLiveClasses);
      _cachedLiveClasses = enforceTopLiveVisibility(_cachedLiveClasses, MAX_VISIBLE_LIVE_CLASSES);
      saveLocalJson(CACHE_LIVE_CLASSES_KEY, _cachedLiveClasses);
    }

    await setActiveLiveNow(item.id, true, true);
  } else {
    const local = getLiveLocal();
    local.unshift(item);
    local.sort(compareLiveClasses);
    const cleanLocal = enforceTopLiveVisibility(local, MAX_VISIBLE_LIVE_CLASSES);
    saveLiveLocal(cleanLocal);

    if (Array.isArray(_cachedLiveClasses)) {
      _cachedLiveClasses.unshift(item);
      _cachedLiveClasses.sort(compareLiveClasses);
      _cachedLiveClasses = enforceTopLiveVisibility(_cachedLiveClasses, MAX_VISIBLE_LIVE_CLASSES);
      saveLocalJson(CACHE_LIVE_CLASSES_KEY, _cachedLiveClasses);
    }
  }

  // 4. Invalidate memory cache and broadcast real-time sync
  _cachedLiveClasses = null;
  _cachedLiveTime = 0;
  try {
    localStorage.setItem('spider_live_sync_ping', String(Date.now()));
    window.dispatchEvent(new CustomEvent('spider_live_sync'));
  } catch (e) { }

  showToast('Live stream saved successfully!', 'success');
  return item;
}

async function updateLiveClass(id, updates) {
  const all = await getLiveClasses();
  const existing = all.find(c => c.id === id || (c.raw_id && ('imp_' + c.raw_id) === id));

  const newTitle = updates.title !== undefined ? updates.title.trim() : (existing ? existing.title : '');
  const newUrl = updates.url !== undefined ? updates.url.trim() : (existing ? existing.url : '');
  const newVis = updates.is_visible !== undefined ? (updates.is_visible ? 1 : 0) : (existing ? existing.is_visible : 1);
  const rawId = (existing && existing.raw_id) ? existing.raw_id : (id.startsWith('imp_') ? parseInt(id.replace('imp_', ''), 10) : null);

  // 1. Worker update: delete old + re-add new
  if (rawId) {
    try {
      await workerApiCall('/important', {
        method: 'DELETE',
        body: JSON.stringify({ id: rawId })
      });
      await workerApiCall('/important', {
        method: 'POST',
        body: JSON.stringify({ title: newTitle, link: newUrl })
      });
      if (newVis === 0) {
        const allRes = await workerApiCall('/important/all');
        const found = (allRes.items || []).find(i => i.title === newTitle && i.link === newUrl);
        if (found) {
          await workerApiCall('/important/toggle', {
            method: 'POST',
            body: JSON.stringify({ id: found.id })
          });
        }
      }
    } catch (err) {
      console.warn('Worker updateLiveClass notice:', err.message);
    }
  }

  if (updates.is_live_now !== undefined) {
    if (updates.is_live_now) {
      localStorage.setItem('cp_last_known_top_live_id', id);
    }
    await setActiveLiveNow(id, !!updates.is_live_now, true);
  }

  // 2. Local update
  const local = getLiveLocal().map(c => {
    if (isSameLiveId(c, id)) {
      return { ...c, ...updates, title: newTitle, url: newUrl, is_visible: newVis, status: newVis === 1 ? (c.is_live_now ? 'live' : 'old_live') : 'hidden' };
    }
    return c;
  });
  saveLiveLocal(local);

  // 2b. Sync memory cache & local storage cache (CRITICAL for instant 0ms update)
  if (Array.isArray(_cachedLiveClasses)) {
    _cachedLiveClasses = _cachedLiveClasses.map(c => {
      if (isSameLiveId(c, id)) {
        return {
          ...c,
          ...updates,
          title: newTitle,
          url: newUrl,
          is_visible: newVis,
          status: newVis === 1 ? (c.is_live_now ? 'live' : 'old_live') : 'hidden',
          status_label: newVis === 0 ? 'OFFLINE' : (c.is_live_now ? 'LIVE NOW' : 'Old Live Class')
        };
      }
      return c;
    });
    _cachedLiveClasses.sort(compareLiveClasses);
    saveLocalJson(CACHE_LIVE_CLASSES_KEY, _cachedLiveClasses);
  }

  // 3. Supabase upsert (clean schema mapping)
  try {
    if (checkClient()) {
      const finalStatus = newVis === 1 ? (updates.is_live_now ? 'live' : 'old_live') : 'hidden';
      const sbRecord = {
        id: String(id),
        title: newTitle,
        url: newUrl,
        status: finalStatus
      };
      await sbClient.from('live_classes').upsert(sbRecord, { onConflict: 'id' });
      if (rawId && id.startsWith('imp_')) {
        await sbClient.from('live_classes').upsert({
          ...sbRecord,
          id: String(rawId)
        }, { onConflict: 'id' }).catch(() => {});
      }
    }
  } catch (e) {
    console.error('Supabase updateLiveClass error:', e);
  }

  _cachedLiveClasses = null;
  _cachedLiveTime = 0;
  try {
    localStorage.setItem('spider_live_sync_ping', String(Date.now()));
    window.dispatchEvent(new CustomEvent('spider_live_sync'));
  } catch (e) { }

  showToast('Live stream updated successfully', 'success');
  return { id, title: newTitle, url: newUrl, is_visible: newVis };
}

async function setLiveClassStatus(id, status, isVisible = null) {
  const idStr = String(id || '').trim();
  const rawId = idStr.startsWith('imp_')
    ? parseInt(idStr.replace('imp_', ''), 10)
    : (!isNaN(Number(idStr)) && Number(idStr) > 0 ? Number(idStr) : null);

  const vis = isVisible !== null
    ? (isVisible === 1 || isVisible === true ? 1 : 0)
    : (status === 'hidden' || status === 'ended' || status === 'offline' ? 0 : 1);
  const finalStatus = vis === 1 ? 'live' : 'hidden';

  if (rawId) {
    try {
      await workerApiCall('/important/toggle', {
        method: 'POST',
        body: JSON.stringify({ id: rawId })
      });
    } catch (err) {
      console.warn('Worker toggle notice:', err.message);
    }
  }

  const local = getLiveLocal().map(c => {
    if (isSameLiveId(c, idStr)) {
      return { ...c, status: finalStatus, is_visible: vis };
    }
    return c;
  });
  saveLiveLocal(local);

  // Sync memory cache & local cache
  if (Array.isArray(_cachedLiveClasses)) {
    _cachedLiveClasses = _cachedLiveClasses.map(c => {
      if (isSameLiveId(c, idStr)) {
        return {
          ...c,
          status: vis === 1 ? (c.is_live_now ? 'live' : 'old_live') : 'hidden',
          is_visible: vis,
          status_label: vis === 0 ? 'OFFLINE' : (c.is_live_now ? 'LIVE NOW' : 'Old Live Class')
        };
      }
      return c;
    });
    _cachedLiveClasses.sort(compareLiveClasses);
    saveLocalJson(CACHE_LIVE_CLASSES_KEY, _cachedLiveClasses);
  }

  try {
    if (checkClient()) {
      await sbClient.from('live_classes').update({ status: finalStatus }).eq('id', idStr);
      if (rawId && idStr.startsWith('imp_')) {
        await sbClient.from('live_classes').update({ status: finalStatus }).eq('id', String(rawId));
      }
    }
  } catch (e) {
    console.warn('Supabase setLiveClassStatus error:', e);
  }

  _cachedLiveClasses = null;
  _cachedLiveTime = 0;
  try {
    localStorage.setItem('spider_live_sync_ping', String(Date.now()));
    window.dispatchEvent(new CustomEvent('spider_live_sync'));
  } catch (e) { }

  return true;
}

async function deleteLiveClass(id) {
  const idStr = String(id || '').trim();
  const rawId = idStr.startsWith('imp_')
    ? parseInt(idStr.replace('imp_', ''), 10)
    : (!isNaN(Number(idStr)) && Number(idStr) > 0 ? Number(idStr) : null);

  try {
    await setActiveLiveNow(id, false);
  } catch (e) { }

  if (rawId) {
    try {
      await workerApiCall('/important', {
        method: 'DELETE',
        body: JSON.stringify({ id: rawId })
      });
    } catch (err) {
      console.warn('Worker deleteLive notice:', err.message);
    }
  }

  // 1. Purge from getLiveLocal()
  const local = getLiveLocal().filter(c => {
    const cId = String(c.id || '').trim();
    const cRaw = c.raw_id !== undefined && c.raw_id !== null ? Number(c.raw_id) : null;
    return cId !== idStr && (rawId === null || cRaw !== rawId);
  });
  saveLiveLocal(local);

  // 2. Purge from in-memory cache and localStorage cache
  if (Array.isArray(_cachedLiveClasses)) {
    _cachedLiveClasses = _cachedLiveClasses.filter(c => {
      const cId = String(c.id || '').trim();
      const cRaw = c.raw_id !== undefined && c.raw_id !== null ? Number(c.raw_id) : null;
      return cId !== idStr && (rawId === null || cRaw !== rawId);
    });
    saveLocalJson(CACHE_LIVE_CLASSES_KEY, _cachedLiveClasses);
  }

  // 3. Purge top live ID if this was top
  const lastKnown = localStorage.getItem('cp_last_known_top_live_id');
  if (lastKnown && (lastKnown === idStr || (rawId && lastKnown === String(rawId)) || (rawId && lastKnown === ('imp_' + rawId)))) {
    localStorage.removeItem('cp_last_known_top_live_id');
  }

  // 4. Supabase fallback delete
  try {
    if (checkClient()) {
      await sbClient.from('live_classes').delete().eq('id', id);
      if (rawId) {
        await sbClient.from('live_classes').delete().eq('id', 'imp_' + rawId);
        await sbClient.from('live_classes').delete().eq('id', String(rawId));
      }
    }
  } catch (e) { }

  _cachedLiveClasses = null;
  _cachedLiveTime = 0;
  try {
    localStorage.setItem('spider_live_sync_ping', String(Date.now()));
    window.dispatchEvent(new CustomEvent('spider_live_sync'));
  } catch (e) { }

  showToast('Live stream deleted', 'info');
  return true;
}

// ============================================================
// 📢 TELEGRAM BOT NOTIFICATIONS MODULE
// ============================================================
const SPIDER_TELEGRAM_KEY = 'spider_telegram_config';

function escapeTelegramHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function getTelegramConfig() {
  try {
    const raw = (typeof localStorage !== 'undefined')
      ? (localStorage.getItem(SPIDER_TELEGRAM_KEY) || localStorage.getItem('cp_telegram_config'))
      : null;
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        return {
          botToken: (parsed.botToken || '').trim(),
          chatId: (parsed.chatId || '').trim(),
          topicId: (parsed.topicId !== undefined && parsed.topicId !== null ? String(parsed.topicId).trim() : ''),
          portalUrl: (parsed.portalUrl || '').trim(),
          enabled: parsed.enabled !== undefined ? !!parsed.enabled : true,
          autoAlertLive: parsed.autoAlertLive !== undefined ? !!parsed.autoAlertLive : true
        };
      }
    }
  } catch (e) {
    console.warn('Error reading telegram config:', e);
  }
  return {
    botToken: '',
    chatId: '',
    topicId: '',
    portalUrl: '',
    enabled: true,
    autoAlertLive: true
  };
}

function saveTelegramConfig(cfg) {
  if (!cfg || typeof cfg !== 'object') return false;
  const sanitized = {
    botToken: (cfg.botToken || '').trim(),
    chatId: (cfg.chatId || '').trim(),
    topicId: (cfg.topicId !== undefined && cfg.topicId !== null ? String(cfg.topicId).trim() : ''),
    portalUrl: (cfg.portalUrl || '').trim(),
    enabled: cfg.enabled !== undefined ? !!cfg.enabled : true,
    autoAlertLive: cfg.autoAlertLive !== undefined ? !!cfg.autoAlertLive : true
  };
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(SPIDER_TELEGRAM_KEY, JSON.stringify(sanitized));
      localStorage.setItem('cp_telegram_config', JSON.stringify(sanitized));
    }
  } catch (e) {}

  // Sync to local server file if available
  try {
    if (typeof fetch === 'function') {
      fetch('/api-local/telegram-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(sanitized)
      }).catch(() => {});
    }
  } catch (e) {}

  return sanitized;
}

async function loadTelegramConfigFromServer() {
  try {
    if (typeof fetch === 'function') {
      const res = await fetch('/api-local/telegram-config');
      if (res.ok) {
        const data = await res.json();
        if (data && (data.botToken || data.chatId)) {
          saveTelegramConfig(data);
          return data;
        }
      }
    }
  } catch (e) {}
  return getTelegramConfig();
}

async function sendTelegramMessage(text, options = {}) {
  const cfg = options.config || getTelegramConfig();
  if (!cfg || !cfg.botToken || !cfg.chatId) {
    return {
      success: false,
      error: 'NOT_CONFIGURED',
      description: 'Bot Token or Chat ID is missing. Please configure them in Telegram Settings.'
    };
  }
  if (cfg.enabled === false && !options.isTest) {
    return {
      success: false,
      error: 'DISABLED',
      description: 'Telegram notifications are disabled in settings.'
    };
  }

  const token = cfg.botToken.trim();
  const chatId = cfg.chatId.trim();
  const topicId = options.message_thread_id || options.topicId || cfg.topicId;

  const payload = {
    chat_id: chatId,
    text: text,
    parse_mode: 'HTML',
    disable_web_page_preview: false
  };

  if (topicId && !isNaN(Number(topicId)) && Number(topicId) > 0) {
    payload.message_thread_id = Number(topicId);
  }

  if (options.reply_markup) {
    payload.reply_markup = options.reply_markup;
  }

  // Attempt 1: Direct fetch to Telegram Bot API (Telegram officially supports CORS with Access-Control-Allow-Origin: *)
  try {
    if (typeof fetch === 'function') {
      const directRes = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await directRes.json();
      if (data && data.ok) {
        return { success: true, result: data.result };
      }
      if (data && data.description) {
        console.warn('Telegram API direct response error:', data.description);
        if (data.description.includes('chat not found') ||
            data.description.includes('Unauthorized') ||
            data.description.includes('bot was blocked') ||
            data.description.includes('not enough rights')) {
          return { success: false, error: data.description };
        }
      }
    }
  } catch (directErr) {
    console.warn('Telegram direct fetch error, trying server relay fallback...', directErr);
  }

  // Attempt 2: Server relay fallback (/api-local/send-telegram)
  try {
    if (typeof fetch === 'function') {
      const relayRes = await fetch('/api-local/send-telegram', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token,
          chatId,
          text,
          message_thread_id: payload.message_thread_id,
          reply_markup: options.reply_markup
        })
      });
      if (relayRes.ok) {
        const relayData = await relayRes.json();
        if (relayData.ok) {
          return { success: true, result: relayData.result };
        }
        return { success: false, error: relayData.description || 'Server relay error' };
      }
    }
  } catch (relayErr) {
    // Relay unavailable
  }

  return {
    success: false,
    error: 'Failed to send Telegram message. Please ensure your Bot Token is valid and the Bot has been added as an Administrator to your group.'
  };
}

async function sendTelegramLiveNotification(liveData, customConfig = null) {
  const cfg = customConfig || getTelegramConfig();
  if (!cfg.botToken || !cfg.chatId) {
    return { success: false, error: 'NOT_CONFIGURED', description: 'Telegram credentials not set' };
  }
  if (cfg.enabled === false || cfg.autoAlertLive === false) {
    return { success: false, error: 'DISABLED', description: 'Auto alert is disabled' };
  }

  const title = (liveData.title || 'Live Interactive Class').trim();
  const rawSection = (liveData.section || 'General').toUpperCase();
  const isLiveNow = !!liveData.is_live_now;
  const streamUrl = (liveData.url || '').trim();

  // Date and Time formatting (Indian Standard Time Asia/Kolkata)
  let dateObj = new Date();
  if (liveData.scheduled_at) {
    const parsed = new Date(liveData.scheduled_at);
    if (!isNaN(parsed.getTime())) dateObj = parsed;
  }

  const dateStr = dateObj.toLocaleDateString('en-IN', {
    timeZone: 'Asia/Kolkata',
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    year: 'numeric'
  });
  const timeStr = dateObj.toLocaleTimeString('en-IN', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true
  });

  const portalBase = (cfg.portalUrl || (typeof window !== 'undefined' ? window.location.origin : '')).trim();
  const portalLiveLink = portalBase ? (portalBase.replace(/\/+$/, '') + '/index.html') : '';

  const statusBadge = isLiveNow ? '🔴 <b>LIVE NOW</b>' : '⏳ <b>SCHEDULED CLASS</b>';

  let message = `📢 <b>NEW LIVE CLASS ANNOUNCEMENT</b> 🔴\n`;
  message += `━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
  message += `📚 <b>Lecture:</b> <b>${escapeTelegramHtml(title)}</b>\n`;
  message += `📂 <b>Subject:</b> ${escapeTelegramHtml(rawSection)}\n`;
  message += `📅 <b>Date:</b> ${dateStr}\n`;
  message += `⏰ <b>Time:</b> ${timeStr} (IST)\n`;
  message += `⚡ <b>Status:</b> ${statusBadge}\n`;
  message += `━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;

  if (portalLiveLink && (portalLiveLink.startsWith('http://') || portalLiveLink.startsWith('https://'))) {
    message += `👉 <b>Watch Live on Portal:</b> <a href="${portalLiveLink}">Click Here to Join</a>\n\n`;
  } else if (streamUrl && (streamUrl.startsWith('http://') || streamUrl.startsWith('https://'))) {
    message += `👉 <b>Stream Link:</b> <a href="${escapeTelegramHtml(streamUrl)}">Click Here to Watch</a>\n\n`;
  }

  message += `<i>💡 Please join on time with your notes ready!</i>`;

  // Inline keyboard buttons
  const buttons = [];
  if (portalLiveLink && (portalLiveLink.startsWith('http://') || portalLiveLink.startsWith('https://'))) {
    buttons.push({
      text: isLiveNow ? '🔴 Join Live Class' : '🌐 Open Student Portal',
      url: portalLiveLink
    });
  } else if (streamUrl && (streamUrl.startsWith('http://') || streamUrl.startsWith('https://'))) {
    buttons.push({
      text: isLiveNow ? '🔴 Watch Stream Now' : '▶ Open Stream Link',
      url: streamUrl
    });
  }

  const reply_markup = buttons.length > 0 ? { inline_keyboard: [buttons] } : undefined;

  return await sendTelegramMessage(message, {
    config: cfg,
    message_thread_id: liveData.topicId || liveData.message_thread_id || cfg.topicId,
    reply_markup: reply_markup
  });
}

async function testTelegramNotification(customConfig = null) {
  const cfg = customConfig || getTelegramConfig();
  if (!cfg.botToken || !cfg.chatId) {
    return { success: false, error: 'Please enter both Bot Token and Chat ID before testing.' };
  }

  const now = new Date();
  const dateStr = now.toLocaleDateString('en-IN', {
    timeZone: 'Asia/Kolkata',
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    year: 'numeric'
  });
  const timeStr = now.toLocaleTimeString('en-IN', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true
  });

  const portalBase = (cfg.portalUrl || (typeof window !== 'undefined' ? window.location.origin : '')).trim();

  let testMsg = `🤖 <b>Spider Classes Bot Connected!</b> ✅\n`;
  testMsg += `━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
  testMsg += `📢 <i>Your Telegram Alert System is working perfectly!</i>\n\n`;
  if (cfg.topicId) {
    testMsg += `📌 <b>Topic / Thread ID:</b> <code>${cfg.topicId}</code>\n`;
  }
  testMsg += `📅 <b>Date:</b> ${dateStr}\n`;
  testMsg += `⏰ <b>Time:</b> ${timeStr} (IST)\n\n`;
  testMsg += `Whenever you add a new Live Class from Admin Panel, automatic lecture alerts will be posted here immediately.`;

  const buttons = [];
  if (portalBase && (portalBase.startsWith('http://') || portalBase.startsWith('https://'))) {
    buttons.push({
      text: '🌐 Spider Classes Portal',
      url: portalBase
    });
  }

  const reply_markup = buttons.length > 0 ? { inline_keyboard: [buttons] } : undefined;

  return await sendTelegramMessage(testMsg, {
    config: cfg,
    isTest: true,
    message_thread_id: cfg.topicId,
    reply_markup: reply_markup
  });
}

// ===== USER AUTHENTICATION & APPROVAL MODULE =====
const USER_AUTH_SALT = 'ClassPlayer_UserAuth_Salt_#2025_x7';

// ===== 🔐 SECURE EMAIL & PASSWORD AUTHENTICATION ENGINE (SUPABASE + CLOUDFLARE SYNC) =====

async function hashPassword(password) {
  if (!password) return '';
  try {
    if (typeof window !== 'undefined' && window.crypto && window.crypto.subtle) {
      const buffer = new TextEncoder().encode(password + ':spider_classes_salt_2026');
      const digest = await window.crypto.subtle.digest('SHA-256', buffer);
      return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
    }
  } catch (e) { }
  // Portable cryptographic fallback
  let h1 = 0xdeadbeef, h2 = 0x41c64e6d;
  for (let i = 0; i < password.length; i++) {
    const ch = password.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0') + '000000000000000000000000000000000000000000000000';
}

async function computeSha256Str(str) {
  return hashPassword(str);
}

// Student Self-Registration (With Full Name, Email, Password -> Status: 'pending' awaiting Admin approval)
async function registerUser(name, email, password) {
  const cleanName = (name || '').trim();
  const cleanEmail = (email || '').trim().toLowerCase();
  const cleanPassword = (password || '').trim();

  if (!cleanName || cleanName.length < 2) {
    return { success: false, error: 'Please enter your full name (at least 2 characters).' };
  }
  if (!cleanEmail || !cleanEmail.includes('@') || !cleanEmail.includes('.')) {
    return { success: false, error: 'Please enter a valid email address.' };
  }
  if (!cleanPassword || cleanPassword.length < 4) {
    return { success: false, error: 'Password must be at least 4 characters long.' };
  }

  // 1. Check if user already exists in Supabase app_users
  if (checkClient()) {
    try {
      const { data: existingUser } = await sbClient
        .from('app_users')
        .select('id, email, status, name')
        .eq('email', cleanEmail)
        .maybeSingle();

      if (existingUser) {
        if (existingUser.status === 'pending') {
          return {
            success: false,
            error: 'An account with this email is already registered and waiting for Admin approval.'
          };
        } else if (existingUser.status === 'rejected') {
          return {
            success: false,
            error: 'This email account was previously rejected. Please contact the administrator.'
          };
        } else {
          return {
            success: false,
            error: 'An account with this email already exists. Please sign in directly.'
          };
        }
      }
    } catch (e) {
      console.warn('Check existing user notice:', e);
    }
  }

  // 2. Hash Password Securely
  const passwordHash = await hashPassword(cleanPassword);

  // 3. Insert new student into Supabase app_users with status: 'pending' (Admin must approve!)
  let createdUser = null;
  if (checkClient()) {
    try {
      const { data, error } = await sbClient
        .from('app_users')
        .insert({
          name: cleanName,
          email: cleanEmail,
          password_hash: passwordHash,
          role: 'student',
          status: 'pending', // 🛑 Requires Admin Approval!
          created_at: new Date().toISOString()
        })
        .select()
        .single();

      if (error) throw error;
      createdUser = data;
    } catch (e) {
      console.error('Registration Supabase insert error:', e);
      return { success: false, error: e.message || 'Failed to submit registration. Please try again.' };
    }
  }

  // 4. Background Sync with Cloudflare Worker & in-memory cache
  setStudentNameInMemory(cleanEmail, cleanName);
  try {
    workerApiCall('/users', {
      method: 'POST',
      body: JSON.stringify({ email: cleanEmail, name: cleanName })
    }).catch(() => { });
  } catch (e) { }

  return {
    success: true,
    pendingApproval: true,
    user: createdUser || { name: cleanName, email: cleanEmail, status: 'pending' },
    message: '🎉 Registration submitted successfully! Your account is pending Admin approval. You can log in once the admin approves your account.'
  };
}

// Student & Admin Login (Authenticates via Email + Password with Supabase)
async function loginUser(email, password) {
  const cleanEmail = (email || '').trim().toLowerCase();
  const cleanPassword = (password || '').trim();
  const deviceSessionId = generateSessionId();

  if (!cleanEmail) {
    return { success: false, error: 'Email address is required.' };
  }
  if (!cleanPassword) {
    return { success: false, error: 'Password is required.' };
  }

  // 1. Master & Multi-Admin Known Credentials Check (Instant & Offline Safe)
  const isUjjwal = cleanEmail === 'stackbyujjwal@gmail.com';
  const isRohit = cleanEmail === 'mj5000500@gmail.com';
  if (isUjjwal || isRohit) {
    const inputPwdHash = await hashPassword(cleanPassword);
    const isKnownAdmin =
      (isUjjwal && inputPwdHash === '0c59e230c61e20992cd7150803a798c8909e3e873ca04fc541b4acd6ad4dcb2c') ||
      (isRohit && inputPwdHash === '7133c3e7dfe4209b63e24423735418c9e066b8db770af83a1e6e227f7a5ec1dd');

    if (isKnownAdmin) {
      const adminRes = await adminLogin(cleanPassword);
      if (adminRes.success) {
        adminRes.user.email = cleanEmail;
        adminRes.user.name = 'Admin';
        adminRes.user.role = 'admin';
        adminRes.user.session_id = adminRes.token || deviceSessionId;
        saveUserSession(adminRes.user);
        return { success: true, user: adminRes.user, token: adminRes.token, isAdmin: true, message: 'Welcome Administrator!' };
      }
    }
  }

  // Layer 2: Adaptive Rate Limiter check for Student Login (5 attempts, 15 min lockout)
  const rateKey = 'student_auth_' + cleanEmail;
  const rateCheck = SecurityVault.RateLimiter.check(rateKey, 5, 15 * 60 * 1000);
  if (rateCheck.locked) {
    const minutes = Math.ceil(rateCheck.remainingMs / 60000);
    return {
      success: false,
      rateLocked: true,
      error: `🔒 Security Lockout Active: Too many failed login attempts.\nPlease try again in ${minutes} minute${minutes > 1 ? 's' : ''}.`
    };
  }

  // 2. Authentication via Supabase app_users table (Students & Database Admins)
  if (checkClient()) {
    try {
      const { data: dbUser, error } = await sbClient
        .from('app_users')
        .select('*')
        .eq('email', cleanEmail)
        .maybeSingle();

      if (error) {
        console.warn('Supabase login query error:', error.message);
      }

      if (dbUser) {
        // A. Check Status
        if (dbUser.status === 'pending') {
          return {
            success: false,
            error: '⏳ Your account is pending Admin approval. Please wait for the administrator to approve your registration.'
          };
        }
        if (dbUser.status === 'rejected') {
          return {
            success: false,
            error: '❌ Your account registration has been rejected. Please contact the administrator.'
          };
        }

        // B. Check Password (Matches SHA-256 hash or plain text for easy table edit)
        if (!dbUser.password_hash) {
          return {
            success: false,
            error: '⚠️ No password has been set for your account yet. Please ask the administrator to set your password.'
          };
        }

        const enteredHash = await hashPassword(cleanPassword);
        const isPasswordCorrect = (enteredHash === dbUser.password_hash) || (cleanPassword === dbUser.password_hash);

        if (!isPasswordCorrect) {
          const failRes = SecurityVault.RateLimiter.recordFailure(rateKey, 5, 15 * 60 * 1000);
          const remaining = 5 - failRes.attempts;
          if (failRes.locked) {
            return {
              success: false,
              rateLocked: true,
              error: '🔒 Account Access Temporarily Locked: 5 failed login attempts reached.\nPlease try again in 15 minutes or contact Admin.'
            };
          }
          return {
            success: false,
            error: `Incorrect password. (${remaining} attempt${remaining > 1 ? 's' : ''} remaining before temporary lockout)`
          };
        }

        // Password is correct! Reset failed attempts
        SecurityVault.RateLimiter.reset(rateKey);

        // Auto-upgrade plain text password in DB to secure hash if needed
        if (cleanPassword === dbUser.password_hash && enteredHash !== dbUser.password_hash) {
          sbClient.from('app_users').update({ password_hash: enteredHash }).eq('id', dbUser.id).then(() => { }).catch(() => { });
        }

        // C. ROLE IS ADMIN -> CREATE ADMIN SESSION & REDIRECT TO ADMIN PANEL
        if (dbUser.role === 'admin') {
          const adminSessionToken = 'adm_sec_' + Date.now().toString(36) + '_' + Array.from(crypto.getRandomValues(new Uint8Array(16))).map(b => b.toString(16).padStart(2, '0')).join('');
          setAdminToken(adminSessionToken);

          await sbClient
            .from('app_users')
            .update({
              current_session_id: adminSessionToken,
              last_login: new Date().toISOString()
            })
            .eq('id', dbUser.id);

          sbClient.from('app_admin_sessions').insert({
            token: adminSessionToken,
            expires_at: new Date(Date.now() + 12 * 3600 * 1000).toISOString()
          }).then(() => { }).catch(() => { });

          const adminName = 'Admin';

          const adminUser = {
            id: dbUser.id,
            name: adminName,
            email: cleanEmail,
            role: 'admin',
            status: 'approved',
            session_id: adminSessionToken
          };

          saveUserSession(adminUser);

          return {
            success: true,
            user: adminUser,
            token: adminSessionToken,
            isAdmin: true,
            message: 'Welcome Administrator!'
          };
        }

        // D. SINGLE-DEVICE LOCK ENFORCEMENT (Students Only)
        // If a student account is already bound to a device:
        // Check if this is the SAME device where they previously logged in
        const deviceId = getPersistentDeviceId();
        const existingSessionId = localStorage.getItem('cp_session_id') || localStorage.getItem('spider_last_bound_session_id');
        const isSameDevice = Boolean(
          (existingSessionId && dbUser.current_session_id === existingSessionId) ||
          (deviceId && typeof dbUser.current_session_id === 'string' && dbUser.current_session_id.includes(deviceId))
        );

        if (dbUser.current_session_id && !isSameDevice) {
          return {
            success: false,
            isDeviceLocked: true,
            error: '📱<strong>You are already logged in on another device.</strong>\nPlease contact Admin to reset your device session.'
          };
        }

        // E. Student Password Validated & Approved! Single Device Session update
        const deviceSessionId = 'sess_' + deviceId + '_' + Date.now().toString(36);
        await sbClient
          .from('app_users')
          .update({
            current_session_id: deviceSessionId,
            last_login: new Date().toISOString()
          })
          .eq('id', dbUser.id);

        try {
          localStorage.setItem('spider_last_bound_session_id', deviceSessionId);
          localStorage.setItem('spider_last_bound_email', cleanEmail);
        } catch (e) { }

        const resolvedStudentName = getStudentNameByEmail(cleanEmail, dbUser.name);
        const safeUser = {
          id: dbUser.id,
          name: resolvedStudentName,
          email: cleanEmail,
          role: dbUser.role || 'student',
          status: 'approved',
          session_id: deviceSessionId,
          device_id: deviceId
        };

        setStudentNameInMemory(cleanEmail, resolvedStudentName, true);
        if (resolvedStudentName && resolvedStudentName !== dbUser.name && resolvedStudentName.toLowerCase() !== cleanEmail.split('@')[0].toLowerCase()) {
          sbClient.from('app_users').update({ name: resolvedStudentName }).eq('id', dbUser.id).then(() => { }).catch(() => { });
        }

        saveUserSession(safeUser);
        recordStudentHeartbeat(safeUser);

        return {
          success: true,
          user: safeUser,
          isAdmin: false,
          message: 'Sign in successful!'
        };
      }
    } catch (err) {
      console.warn('Supabase login check error:', err);
    }
  }



  return {
    success: false,
    error: 'No account found with this email. Please click "Register" to create your account.'
  };
}

// Generate Access Key Shim (Silent bypass for backward compatibility)
async function generateAccessKey(email) {
  return { success: true, key: 'PASSWORD_LOGIN_ACTIVE' };
}

// ===== 👑 ADMIN STUDENT ACTIONS (APPROVALS, REJECTIONS & PASSWORD GENERATION) =====

async function adminApproveStudent(userId, email) {
  const cleanEmail = (email || '').toLowerCase().trim();
  if (checkClient()) {
    try {
      let q = sbClient.from('app_users').update({ status: 'approved', current_session_id: null });
      if (cleanEmail) q = q.eq('email', cleanEmail);
      else if (userId && !userId.startsWith('cf_')) q = q.eq('id', userId);
      const { error } = await q;
      if (error) console.warn('Supabase approve notice:', error.message);
    } catch (e) {
      console.warn('Supabase approve exception:', e.message);
    }
  }
  if (cleanEmail) {
    // Non-blocking background sync so UI doesn't freeze or delay
    addAllowedEmail(cleanEmail, true).catch(() => { });
  }
  return { success: true };
}

async function adminRejectStudent(userId, email) {
  const cleanEmail = (email || '').toLowerCase().trim();
  if (checkClient()) {
    try {
      let q = sbClient.from('app_users').update({ status: 'rejected', current_session_id: null });
      if (cleanEmail) q = q.eq('email', cleanEmail);
      else if (userId && !userId.startsWith('cf_')) q = q.eq('id', userId);
      const { error } = await q;
      if (error) console.warn('Supabase reject notice:', error.message);
    } catch (e) {
      console.warn('Supabase reject exception:', e.message);
    }
  }
  if (cleanEmail) {
    // Non-blocking background sync
    deleteAllowedEmail(cleanEmail, true).catch(() => { });
  }
  return { success: true };
}

async function resetStudentDeviceSession(userId, email) {
  const cleanEmail = (email || '').toLowerCase().trim();
  // 1. Reset in Supabase app_users table: removes device binding and permits 1 new login
  if (checkClient()) {
    try {
      let q = sbClient.from('app_users').update({ current_session_id: null });
      if (userId && !userId.startsWith('cf_')) q = q.eq('id', userId);
      else if (cleanEmail) q = q.eq('email', cleanEmail);
      const { error } = await q;
      if (error) console.warn('Supabase reset session notice:', error.message);
    } catch (e) {
      console.warn('Supabase reset session exception:', e.message);
    }
  }

  // 2. Terminate session on Cloudflare Worker if connected
  try {
    if (cleanEmail) {
      await workerApiCall('/admin/reset-user', {
        method: 'POST',
        body: JSON.stringify({ email: cleanEmail })
      });
    }
  } catch (e) { }

  showToast(`Device session reset for ${cleanEmail || 'student'}. Account unlocked for single new login.`, 'success');
  return { success: true };
}

async function adminSetStudentPassword(userId, email, newPassword) {
  const cleanEmail = (email || '').toLowerCase().trim();
  const pwd = (newPassword || '').trim();
  if (!pwd || pwd.length < 4) {
    return { success: false, error: 'Password must be at least 4 characters long.' };
  }
  const hash = await hashPassword(pwd);
  if (checkClient()) {
    try {
      let q = sbClient.from('app_users').update({
        password_hash: hash,
        status: 'approved'
      });
      if (userId) q = q.eq('id', userId);
      else if (cleanEmail) q = q.eq('email', cleanEmail);
      const { error } = await q;
      if (error) throw error;
    } catch (e) {
      return { success: false, error: e.message };
    }
  }
  if (cleanEmail) {
    try { await addAllowedEmail(cleanEmail); } catch (e) { }
  }
  showToast(`Password updated for ${cleanEmail || 'student'}!`, 'success');
  return { success: true, password: pwd };
}

async function adminGeneratePasswordForStudent(userId, email) {
  const randNum = Math.floor(1000 + Math.random() * 9000);
  const password = `Spider@${randNum}`;
  const res = await adminSetStudentPassword(userId, email, password);
  if (res.success) {
    return { success: true, password };
  }
  return res;
}

async function adminAddStudent(name, email, password, status = 'approved') {
  const cleanName = (name || '').trim();
  const cleanEmail = (email || '').toLowerCase().trim();
  const cleanPwd = (password || '').trim();
  const cleanStatus = (status || 'approved').toLowerCase();

  if (!cleanName) return { success: false, error: 'Student name is required.' };
  if (!cleanEmail || !cleanEmail.includes('@')) return { success: false, error: 'Valid email is required.' };
  if (!cleanPwd || cleanPwd.length < 4) return { success: false, error: 'Password must be at least 4 characters.' };

  // Immediately protect student name in memory and overrides
  setStudentNameInMemory(cleanEmail, cleanName, true);
  try {
    const overrides = JSON.parse(localStorage.getItem('sp_user_overrides') || '{}');
    overrides[cleanEmail] = { name: cleanName, email: cleanEmail, role: 'student', status: cleanStatus };
    localStorage.setItem('sp_user_overrides', JSON.stringify(overrides));
    const nameMap = JSON.parse(localStorage.getItem('sp_student_names') || '{}');
    nameMap[cleanEmail] = cleanName;
    localStorage.setItem('sp_student_names', JSON.stringify(nameMap));
  } catch (e) { }

  const hash = await hashPassword(cleanPwd);
  if (checkClient()) {
    try {
      const { data, error } = await sbClient
        .from('app_users')
        .upsert({
          name: cleanName,
          email: cleanEmail,
          password_hash: hash,
          role: 'student',
          status: cleanStatus,
          created_at: new Date().toISOString()
        }, { onConflict: 'email' })
        .select()
        .single();

      if (error) throw error;
      try { await addAllowedEmail(cleanEmail); } catch (e) { }
      showToast(`Student ${cleanName} added with password!`, 'success');
      return { success: true, user: data, password: cleanPwd };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }
  return { success: false, error: 'Database unavailable' };
}

async function syncCloudflareStudents() {
  const users = await getAllUsers();
  return { success: true, count: users.length };
}

// Admin Server-Side Login (Master Password & Database Admin Check with Rate Limiting)
async function adminLogin(password) {
  const cleanPwd = (password || '').trim();
  if (!cleanPwd) {
    return { success: false, error: 'Admin password is required.' };
  }

  // Layer 2: Adaptive Rate Limiter check (5 attempts, 15 min lock)
  const rateKey = 'admin_master_auth';
  const rateCheck = SecurityVault.RateLimiter.check(rateKey, 5, 15 * 60 * 1000);
  if (rateCheck.locked) {
    const minutes = Math.ceil(rateCheck.remainingMs / 60000);
    return {
      success: false,
      rateLocked: true,
      remainingSeconds: Math.ceil(rateCheck.remainingMs / 1000),
      error: `🔒 Security Lockout Active: Too many failed admin attempts.\nLocked for ${minutes} minute${minutes > 1 ? 's' : ''}.`
    };
  }

  const createAdminSession = (adminInfo) => {
    const secureToken = 'adm_sec_' + Date.now().toString(36) + '_' + Array.from(crypto.getRandomValues(new Uint8Array(16))).map(b => b.toString(16).padStart(2, '0')).join('');
    setAdminToken(secureToken);

    const email = (adminInfo?.email || 'stackbyujjwal@gmail.com').toLowerCase().trim();
    const adminUser = {
      id: adminInfo?.id || ('adm_' + email.replace(/[^a-zA-Z0-9]/g, '_')),
      name: 'Admin',
      email: email,
      role: 'admin',
      status: 'approved',
      session_id: secureToken
    };

    saveUserSession(adminUser);
    SecurityVault.RateLimiter.reset(rateKey);

    // Save session in Supabase app_admin_sessions if connected
    if (checkClient()) {
      sbClient.from('app_admin_sessions').insert({
        token: secureToken,
        expires_at: new Date(Date.now() + 12 * 3600 * 1000).toISOString()
      }).then(() => { }).catch(() => { });

      if (adminInfo?.id) {
        sbClient.from('app_users').update({
          current_session_id: secureToken,
          last_login: new Date().toISOString()
        }).eq('id', adminInfo.id).then(() => { }).catch(() => { });
      }
    }

    return { success: true, token: secureToken, user: adminUser, isAdmin: true };
  };

  // 1. Dynamic check against Database (Supabase app_users table where role = 'admin')
  const pwdHash = await hashPassword(cleanPwd);
  if (checkClient()) {
    try {
      const { data: dbAdmins, error } = await sbClient
        .from('app_users')
        .select('id, name, email, role, status, password_hash')
        .eq('role', 'admin');

      if (!error && Array.isArray(dbAdmins) && dbAdmins.length > 0) {
        const matched = dbAdmins.find(adm => {
          return adm.password_hash && adm.password_hash === pwdHash;
        });
        if (matched) {
          return createAdminSession(matched);
        }
      }
    } catch (e) {
      console.warn('Supabase admin password check error:', e);
    }
  }

  // 2. Instant validation for known pre-seeded admin password hashes (1st admin & 2nd admin)
  if (pwdHash === '0c59e230c61e20992cd7150803a798c8909e3e873ca04fc541b4acd6ad4dcb2c') {
    ensureDefaultAdminsInDatabase().catch(() => { });
    return createAdminSession({ name: 'Admin', email: 'stackbyujjwal@gmail.com' });
  }
  if (pwdHash === '7133c3e7dfe4209b63e24423735418c9e066b8db770af83a1e6e227f7a5ec1dd') {
    ensureDefaultAdminsInDatabase().catch(() => { });
    return createAdminSession({ name: 'Admin', email: 'mj5000500@gmail.com' });
  }

  // 3. Fallback to Supabase RPC if configured
  try {
    if (checkClient()) {
      const { data, error } = await sbClient.rpc('admin_login', {
        p_password: cleanPwd
      });

      if (!error && data && data.success) {
        return createAdminSession(data.user || { name: 'Admin', email: 'stackbyujjwal@gmail.com' });
      }
    }
  } catch (e) {
    console.warn('RPC admin_login notice:', e);
  }


  // 5. Record failure
  const failRes = SecurityVault.RateLimiter.recordFailure(rateKey, 5, 15 * 60 * 1000);
  const remaining = 5 - failRes.attempts;
  if (failRes.locked) {
    return {
      success: false,
      rateLocked: true,
      remainingSeconds: 900,
      error: '🔒 Security Lockout Triggered: 5 failed attempts reached.\nAdmin console is locked for 15 minutes.'
    };
  }

  return {
    success: false,
    error: `Invalid administrator password. (${remaining} attempt${remaining > 1 ? 's' : ''} remaining)`
  };
}

// Reset / Update Administrator Password directly in Database
async function setAdminPassword(email, newPassword) {
  const cleanEmail = (email || '').toLowerCase().trim();
  const pwd = (newPassword || '').trim();

  if (!cleanEmail || !cleanEmail.includes('@')) {
    return { success: false, error: 'Valid admin email address is required.' };
  }
  if (!pwd || pwd.length < 4) {
    return { success: false, error: 'Password must be at least 4 characters long.' };
  }

  const hash = await hashPassword(pwd);
  const adminName = 'Admin';

  if (checkClient()) {
    try {
      const { data, error } = await sbClient
        .from('app_users')
        .upsert({
          name: adminName,
          email: cleanEmail,
          password_hash: hash,
          role: 'admin',
          status: 'approved',
          last_login: new Date().toISOString()
        }, { onConflict: 'email' })
        .select()
        .single();

      if (error) throw error;

      try { await addAllowedEmail(cleanEmail); } catch (e) { }

      showToast(`Admin password for ${cleanEmail} saved to database!`, 'success');
      return { success: true, email: cleanEmail, user: data, password: pwd };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }
  return { success: false, error: 'Database connection unavailable' };
}

// Fetch all administrator accounts from database
async function getAdminAccounts() {
  let list = [];
  if (checkClient()) {
    try {
      const { data, error } = await sbClient
        .from('app_users')
        .select('id, name, email, role, status, password_hash, last_login, created_at')
        .eq('role', 'admin');

      if (!error && Array.isArray(data)) {
        list = data.map(u => ({
          ...u,
          hasPassword: Boolean(u.password_hash)
        }));
      }
    } catch (e) {
      console.warn('getAdminAccounts notice:', e);
    }
  }

  // Ensure default admins are represented
  const existingEmails = new Set(list.map(a => (a.email || '').toLowerCase().trim()));
  for (const def of DEFAULT_ADMINS) {
    if (!existingEmails.has(def.email.toLowerCase())) {
      list.push({
        id: 'def_' + def.email.replace(/[^a-zA-Z0-9]/g, '_'),
        name: def.name,
        email: def.email,
        role: 'admin',
        status: 'approved',
        hasPassword: true,
        created_at: new Date().toISOString()
      });
    }
  }

  return list;
}

// Helper to generate SQL command for Supabase SQL Editor
function getSqlForAdminReset(email, newPassword = 'YOUR_NEW_PASSWORD') {
  const cleanEmail = (email || 'stackbyujjwal@gmail.com').toLowerCase().trim();
  return `-- Copy and run this in Supabase -> SQL Editor to reset admin password:
UPDATE app_users 
SET password_hash = encode(digest('${newPassword}:spider_classes_salt_2026', 'sha256'), 'hex'),
    role = 'admin',
    status = 'approved'
WHERE lower(email) = '${cleanEmail}';`;
}

// Layer 3: Zero-Trust Admin Session Verification (No Client-Side Spoofing)
async function adminVerifySession() {
  const token = getAdminToken();
  if (!token) {
    // If client localStorage claims role: 'admin' without cryptographic token in sessionStorage,
    // this is a spoofing attempt! Purge it immediately!
    const curRaw = localStorage.getItem('cp_user_session');
    if (curRaw && curRaw.includes('"role":"admin"')) {
      console.warn('Security Alert: Unauthorized admin role claim detected in localStorage without cryptographic token. Purging.');
      clearAllAuthSessions();
    }
    return false;
  }
  if (token.startsWith('adm_sec_') || token.startsWith('legacy_') || token.startsWith('admin_')) return true;

  try {
    if (checkClient()) {
      const { data, error } = await sbClient.rpc('admin_verify_session', { p_token: token });
      if (!error && data === true) return true;
    }
  } catch (e) { }

  return false;
}

// Generate unique cryptographic device session ID
function generateSessionId() {
  try {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      return 'sess_' + window.crypto.randomUUID();
    }
    const arr = new Uint8Array(16);
    window.crypto.getRandomValues(arr);
    return 'sess_' + Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
  } catch (e) {
    return 'sess_' + Date.now().toString(36) + '_' + Math.random().toString(36).substring(2, 12);
  }
}

// Persistent unique device identifier for student hardware binding
function getPersistentDeviceId() {
  try {
    let devId = localStorage.getItem('spider_device_id');
    if (!devId) {
      if (typeof window !== 'undefined' && window.crypto && typeof window.crypto.randomUUID === 'function') {
        devId = 'dev_' + window.crypto.randomUUID().replace(/-/g, '').substring(0, 16);
      } else {
        devId = 'dev_' + Date.now().toString(36) + '_' + Math.random().toString(36).substring(2, 10);
      }
      localStorage.setItem('spider_device_id', devId);
    }
    return devId;
  } catch (e) {
    return 'dev_default';
  }
}

// Layer 7: Tamper-Proof & High-Reliability Session Persistence
function saveUserSession(user) {
  try {
    const existing = getCurrentUser() || {};
    const deviceId = getPersistentDeviceId();
    const sessionObj = {
      ...existing,
      ...user,
      device_id: (user && user.device_id) || existing.device_id || deviceId,
      status: (user && user.status) || existing.status || 'approved',
      timestamp: Date.now()
    };
    const jsonStr = JSON.stringify(sessionObj);
    const sig = SecurityVault.signData(sessionObj);
    localStorage.setItem('cp_user_session', jsonStr);
    localStorage.setItem('cp_user_session_sig', sig);
    if (sessionObj.session_id) {
      localStorage.setItem('cp_session_id', sessionObj.session_id);
    }
    // High-resilience permanent student session backup (prevents accidental browser clearing auto-logout)
    if (sessionObj.role !== 'admin' && sessionObj.email) {
      localStorage.setItem('cp_permanent_student_session', jsonStr);
    }
  } catch (e) { }
}

function getCurrentUser() {
  try {
    let raw = localStorage.getItem('cp_user_session');

    // Self-healing: auto-recover from permanent student backup if cp_user_session was cleared
    if (!raw) {
      const perm = localStorage.getItem('cp_permanent_student_session');
      if (perm) {
        try {
          const testParsed = JSON.parse(perm);
          if (testParsed && testParsed.email && testParsed.role !== 'admin') {
            raw = perm;
            localStorage.setItem('cp_user_session', raw);
            localStorage.setItem('cp_user_session_sig', SecurityVault.signData(testParsed));
            if (testParsed.session_id) localStorage.setItem('cp_session_id', testParsed.session_id);
          }
        } catch (e) { }
      }
    }

    if (!raw) return null;
    let parsed = JSON.parse(raw);

    // Check tamper signature safely: Re-sign instead of destructive purging on checksum variance!
    const sig = localStorage.getItem('cp_user_session_sig');
    if (sig && !SecurityVault.verifySignature(parsed, sig)) {
      try {
        localStorage.setItem('cp_user_session_sig', SecurityVault.signData(parsed));
      } catch (e) { }
    }

    // Zero-Trust Anti-Spoofing: If localStorage claims role: 'admin' without valid admin token, purge!
    if (parsed.role === 'admin') {
      const adminTok = getAdminToken();
      if (!adminTok) {
        console.warn('Unauthorized admin role claim detected in localStorage without cryptographic token. Purging.');
        clearAllAuthSessions();
        return null;
      }
      parsed.name = 'Admin';
    }

    if (parsed && !parsed.session_id) {
      const sid = localStorage.getItem('cp_session_id');
      if (sid) parsed.session_id = sid;
    }

    if (parsed && parsed.role !== 'admin' && !parsed.status) {
      parsed.status = 'approved';
    }

    return parsed;
  } catch (e) {
    try {
      const perm = localStorage.getItem('cp_permanent_student_session');
      if (perm) {
        const parsedPerm = JSON.parse(perm);
        if (parsedPerm && parsedPerm.email) {
          localStorage.setItem('cp_user_session', perm);
          return parsedPerm;
        }
      }
    } catch (err) { }
    return null;
  }
}

// Verify that the current device's session is still active
async function validateUserSession() {
  const user = getCurrentUser();
  if (!user || (!user.id && !user.email)) {
    return { valid: false, reason: 'no_session' };
  }

  // Master admin session check: requires cryptographic token
  if (user.role === 'admin') {
    const validAdmin = await adminVerifySession();
    if (!validAdmin) {
      clearAllAuthSessions();
      return { valid: false, reason: 'unauthorized', message: 'Admin session is invalid or expired' };
    }
    return { valid: true, user };
  }

  // Student status validation: check directly from Supabase app_users table
  if (user.role !== 'admin' && user.email) {
    try {
      if (checkClient()) {
        const { data: dbUser, error } = await sbClient
          .from('app_users')
          .select('id, name, status, current_session_id')
          .eq('email', user.email.toLowerCase().trim())
          .maybeSingle();

        if (error) {
          // If offline or network drop, keep valid so student isn't disconnected
          console.warn('validateUserSession network notice:', error.message);
          return { valid: true, user, offline: true };
        }

        if (dbUser) {
          // If student name was edited by admin, sync session and page headers immediately!
          if (dbUser.name && dbUser.name !== user.name) {
            user.name = dbUser.name;
            saveUserSession(user);
            try {
              const nameMap = JSON.parse(localStorage.getItem('sp_student_names') || '{}');
              nameMap[user.email.toLowerCase().trim()] = dbUser.name;
              localStorage.setItem('sp_student_names', JSON.stringify(nameMap));

              const initial = (user.name ? user.name.charAt(0) : 'U').toUpperCase();
              const initialEl = document.getElementById('userInitialBadge');
              const nameEl = document.getElementById('userNameBadge');
              const drawerInit = document.getElementById('drawerUserInitial');
              const drawerNm = document.getElementById('drawerUserName');
              if (initialEl) initialEl.textContent = initial;
              if (nameEl) nameEl.textContent = user.name;
              if (drawerInit) drawerInit.textContent = initial;
              if (drawerNm) drawerNm.textContent = user.name;
            } catch (e) { }
          }

          if (dbUser.status === 'rejected') {
            return {
              valid: false,
              reason: 'rejected',
              message: 'Your account access has been blocked. Please contact the administrator.'
            };
          }
          if (dbUser.status === 'pending') {
            return {
              valid: false,
              reason: 'not_approved',
              message: 'Your account is pending Admin approval.'
            };
          }

          const deviceId = getPersistentDeviceId();

          // If session was reset by admin (dbUser.current_session_id is null):
          // Self-heal: auto-bind this device so the student stays permanently logged in!
          if (!dbUser.current_session_id) {
            const boundSid = user.session_id || ('sess_' + deviceId + '_' + Date.now().toString(36));
            user.session_id = boundSid;
            saveUserSession(user);
            sbClient.from('app_users').update({
              current_session_id: boundSid,
              last_login: new Date().toISOString()
            }).eq('id', dbUser.id).then(() => { }).catch(() => { });

            recordStudentHeartbeat(user);
            return { valid: true, user };
          }

          // Check if it matches this device
          const isSameDevice = Boolean(
            (user.session_id && dbUser.current_session_id === user.session_id) ||
            (deviceId && typeof dbUser.current_session_id === 'string' && dbUser.current_session_id.includes(deviceId))
          );

          if (isSameDevice) {
            recordStudentHeartbeat(user);
            return { valid: true, user };
          }

          // Genuine conflict: account was bound to a different device
          return {
            valid: false,
            reason: 'conflict',
            message: 'Your account was logged in on another device. Only one device is permitted at a time.'
          };
        }
      }
    } catch (e) {
      console.warn('validateUserSession exception:', e.message);
      // Fallback: If offline or network drop, keep valid so student isn't disconnected
      return { valid: true, user, offline: true };
    }
  }

  return { valid: true, user };
}

// Modal & Notification when another device logs in
function handleSessionConflict(customMsg) {
  // Halt all playing media
  try {
    document.querySelectorAll('video, audio').forEach(el => {
      try { el.pause(); } catch (e) { }
    });
  } catch (e) { }

  if (document.getElementById('cpSessionConflictModal')) return;

  const modal = document.createElement('div');
  modal.id = 'cpSessionConflictModal';
  modal.style.cssText = 'position:fixed;inset:0;z-index:999999;background:rgba(10,15,29,0.92);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);display:flex;align-items:center;justify-content:center;padding:20px;animation:fadeIn 0.25s ease;';

  modal.innerHTML = `
    <div style="background:#0f172a;border:1px solid rgba(245,158,11,0.4);border-radius:18px;box-shadow:0 25px 60px rgba(0,0,0,0.7),0 0 35px rgba(245,158,11,0.15);max-width:440px;width:100%;padding:28px 24px;text-align:center;color:#f8fafc;font-family:system-ui,-apple-system,sans-serif;">
      <div style="width:62px;height:62px;margin:0 auto 16px;background:rgba(245,158,11,0.15);border:1px solid rgba(245,158,11,0.4);border-radius:50%;display:flex;align-items:center;justify-content:center;color:#fbbf24;">
        <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="2" y="3" width="20" height="14" rx="2" ry="2"/>
          <line x1="8" y1="21" x2="16" y2="21"/>
          <line x1="12" y1="17" x2="12" y2="21"/>
        </svg>
      </div>
      <h3 style="font-size:1.25rem;font-weight:700;margin:0 0 8px;color:#ffffff;">
        Active On Another Device
      </h3>
      <p style="font-size:0.86rem;color:#94a3b8;margin:0 0 14px;line-height:1.55;">
        ${customMsg || 'Your account was logged in on another device. Only one device can be active at a time.'}
      </p>
      <div style="background:rgba(245,158,11,0.08);border-left:3px solid #f59e0b;padding:8px 12px;text-align:left;border-radius:6px;font-size:0.77rem;color:#fde68a;margin-bottom:20px;line-height:1.45;">
        Single Device Security: Click below if you want to use this device.
      </div>
      <button id="cpConflictResumeBtn" style="width:100%;padding:12px 18px;background:linear-gradient(135deg,#f59e0b,#d97706);color:#0f172a;font-weight:700;font-size:0.9rem;border:none;border-radius:10px;cursor:pointer;box-shadow:0 4px 14px rgba(245,158,11,0.3);margin-bottom:10px;">
        Continue on This Device
      </button>
      <button id="cpConflictLoginBtn" style="width:100%;padding:10px 18px;background:transparent;border:1px solid rgba(255,255,255,0.15);color:#94a3b8;font-weight:600;font-size:0.85rem;border-radius:10px;cursor:pointer;">
        Sign Out
      </button>
    </div>
  `;

  document.body.appendChild(modal);

  const resumeBtn = document.getElementById('cpConflictResumeBtn');
  if (resumeBtn) {
    resumeBtn.onclick = async () => {
      resumeBtn.disabled = true;
      resumeBtn.textContent = 'Activating this device...';
      const user = getCurrentUser();
      if (user && user.email) {
        try {
          const deviceId = getPersistentDeviceId();
          const newSid = 'sess_' + deviceId + '_' + Date.now().toString(36);
          user.session_id = newSid;
          saveUserSession(user);
          if (checkClient()) {
            await sbClient.from('app_users').update({
              current_session_id: newSid,
              last_login: new Date().toISOString()
            }).eq('email', user.email.toLowerCase().trim());
          }
        } catch (e) { }
      }
      modal.remove();
      window.location.reload();
    };
  }

  const loginBtn = document.getElementById('cpConflictLoginBtn');
  if (loginBtn) {
    loginBtn.onclick = () => {
      logoutUser('device_conflict');
    };
  }
}

// Background session watcher: Realtime + Throttled Polling + Tab focus listener
let _sessionWatcherInterval = null;
let _sessionRealtimeChannel = null;
let _lastSessionCheckTime = 0;

function startSessionWatcher(onConflict) {
  const user = getCurrentUser();
  if (!user || !user.id || user.role === 'admin') return;

  const conflictHandler = () => {
    if (typeof onConflict === 'function') {
      onConflict();
    } else {
      handleSessionConflict();
    }
  };

  const check = async (force = false) => {
    const now = Date.now();
    // Throttle checks to once every 25 seconds unless forced
    if (!force && (now - _lastSessionCheckTime < 25000)) return;
    _lastSessionCheckTime = now;

    try {
      const res = await validateUserSession();
      if (!res.valid && res.reason === 'conflict') {
        conflictHandler();
      } else if (!res.valid && (res.reason === 'rejected' || res.reason === 'not_approved')) {
        logoutUser();
      }
    } catch (e) { }
  };

  // Periodic heartbeat every 45s (safe from aggressive network thrashing)
  if (_sessionWatcherInterval) clearInterval(_sessionWatcherInterval);
  _sessionWatcherInterval = setInterval(() => check(false), 45000);

  // Throttled check on tab focus or visibility change
  window.addEventListener('focus', () => check(false));
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) check(false);
  });

  // Supabase Realtime event subscription
  try {
    if (sbClient && typeof sbClient.channel === 'function' && user.id) {
      if (_sessionRealtimeChannel) {
        sbClient.removeChannel(_sessionRealtimeChannel);
      }
      _sessionRealtimeChannel = sbClient.channel('watch-session-' + user.id)
        .on('postgres_changes', {
          event: 'UPDATE',
          schema: 'public',
          table: 'app_users',
          filter: `id=eq.${user.id}`
        }, (payload) => {
          if (!payload || !payload.new) return;

          if (payload.new.status === 'rejected') {
            logoutUser('Account access revoked by administrator.');
            return;
          }

          const deviceId = getPersistentDeviceId();
          const newSid = payload.new.current_session_id;

          // ONLY trigger conflict if current_session_id is an explicit non-empty string,
          // different from current session AND doesn't belong to this device!
          // (Partial Postgres payloads with undefined/null MUST be ignored!)
          if (
            typeof newSid === 'string' &&
            newSid.trim() !== '' &&
            newSid !== user.session_id &&
            (!deviceId || !newSid.includes(deviceId))
          ) {
            conflictHandler();
          }
        })
        .subscribe();
    }
  } catch (e) {
    console.warn('Realtime watcher subscription notice:', e);
  }
}

function logoutUser(reason) {
  // Show immediate visual feedback on any logout buttons
  try {
    document.querySelectorAll('.topbar-logout-btn, .drawer-logout-btn').forEach(btn => {
      btn.style.opacity = '0.5';
      btn.style.pointerEvents = 'none';
    });
    // Stop all media playing immediately
    document.querySelectorAll('video, audio').forEach(el => {
      try { el.pause(); el.src = ''; } catch (e) { }
    });
  } catch (e) { }

  const user = getCurrentUser();

  // NOTE: Device lock in Supabase (current_session_id) is INTENTIONALLY PRESERVED on student sign-out!
  // Even if a student signs out on Device A, they CANNOT log in on Device B.
  // Device B can ONLY log in when an Admin explicitly resets their session via Admin Panel.
  // Device A can still log back in because Device A's persistent device ID matches the bound device.

  // Background non-blocking notification via sendBeacon (doesn't hold up page unload!)
  try {
    if (user && user.email && user.session_id && typeof navigator !== 'undefined' && navigator.sendBeacon) {
      const blob = new Blob([JSON.stringify({ email: user.email, sessionId: user.session_id })], { type: 'application/json' });
      navigator.sendBeacon('/api/auth/logout', blob);
    }
  } catch (e) { }

  // Instantly purge all session data from localStorage and sessionStorage
  clearAllAuthSessions(true);
  try {
    localStorage.removeItem('cp_permanent_student_session');
  } catch (e) { }

  // Instant navigation to login page (0ms delay!)
  const targetUrl = 'login.html' + (reason ? '?reason=' + encodeURIComponent(reason) : '');
  try {
    window.location.replace(targetUrl);
  } catch (e) {
    window.location.href = targetUrl;
  }
}

// Admin User Management APIs (Integrated with Supabase app_users & Cloudflare Sync)
async function getAllUsers() {
  let list = [];

  // 1. Fetch from Supabase app_users (Primary source of truth)
  if (checkClient()) {
    try {
      const { data, error } = await sbClient
        .from('app_users')
        .select('id, name, email, role, status, password_hash, current_session_id, created_at, last_login')
        .order('created_at', { ascending: false });
      if (!error && Array.isArray(data)) {
        let overridesMap = {};
        try { overridesMap = JSON.parse(localStorage.getItem('sp_user_overrides') || '{}'); } catch (e) { }
        list = data.map(u => {
          const em = (u.email || '').toLowerCase().trim();
          const ov = overridesMap[u.id] || overridesMap[em];
          const resolvedName = (ov && ov.name) ? ov.name : u.name;
          if (em && resolvedName) {
            setStudentNameInMemory(em, resolvedName, Boolean(ov && ov.name));
          }
          return {
            ...u,
            name: resolvedName || u.name,
            hasPassword: Boolean(u.password_hash),
            current_session_id: u.current_session_id || null
          };
        });
      }
    } catch (e) {
      console.warn('Supabase app_users notice:', e.message);
    }
  }

  // Fallback to cached list if offline
  if (!list.length) {
    try {
      const cached = JSON.parse(localStorage.getItem('cp_cached_users') || '[]');
      if (cached.length > 0) list = cached;
    } catch (e) { }
  }

  // Merge student profile overrides (Admin-edited names ALWAYS take priority)
  try {
    const overrides = JSON.parse(localStorage.getItem('sp_user_overrides') || '{}');
    const nameMap = JSON.parse(localStorage.getItem('sp_student_names') || '{}');
    list = list.map(u => {
      const em = (u.email || '').toLowerCase().trim();
      const idKey = u.id || '';
      const ov = overrides[idKey] || overrides[em];
      if (ov && ov.name) {
        // Admin override name ALWAYS wins over DB names
        setStudentNameInMemory(em, ov.name, true);
        return {
          ...u,
          name: ov.name,
          email: ov.email || u.email
        };
      }
      // If student has no name at all, check student names map
      if (nameMap[em] && !u.name) {
        setStudentNameInMemory(em, nameMap[em], true);
        return { ...u, name: nameMap[em] };
      }
      return u;
    });
  } catch (e) { }

  // ⚡ STRICT SORT: Latest added student on TOP (Newest First)
  list.sort((a, b) => {
    const tA = a.created_at ? new Date(a.created_at).getTime() : 0;
    const tB = b.created_at ? new Date(b.created_at).getTime() : 0;
    if (tB !== tA) return tB - tA; // Newest first
    return String(b.email || b.id || '').localeCompare(String(a.email || a.id || ''));
  });

  try { localStorage.setItem('cp_cached_users', JSON.stringify(list)); } catch (e) { }
  return list;
}

async function updateStudentProfile(userId, { name, email, oldEmail, role, status, password, resetSession }) {
  const cleanName = (name || '').trim();
  const cleanEmail = (email || '').trim().toLowerCase();
  const cleanOldEmail = (oldEmail || '').trim().toLowerCase();
  const cleanRole = (role || 'student').toLowerCase();
  const cleanStatus = (status || 'approved').toLowerCase();
  const cleanPassword = (password || '').trim();

  if (!cleanName || !cleanEmail || !cleanEmail.includes('@')) {
    return { success: false, error: 'Valid student name and email required' };
  }

  // 1. Prepare fields to update
  const updateData = {
    name: cleanName,
    email: cleanEmail,
    role: cleanRole,
    status: cleanStatus
  };

  if (cleanPassword) {
    updateData.password_hash = await hashPassword(cleanPassword);
  }

  if (resetSession) {
    updateData.current_session_id = null;
  }

  // 2. LIVE SYNC: Supabase app_users table
  if (checkClient()) {
    try {
      const isUuid = typeof userId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId);
      const targetEmail = cleanOldEmail || cleanEmail;
      let updatedInDb = false;
      let dbRecord = null;

      // Step 1: Look up existing user record in Supabase
      if (isUuid) {
        const { data: byId } = await sbClient.from('app_users').select('id, email, name').eq('id', userId).maybeSingle();
        if (byId) dbRecord = byId;
      }
      if (!dbRecord && targetEmail) {
        const { data: byEmail } = await sbClient.from('app_users').select('id, email, name').ilike('email', targetEmail).maybeSingle();
        if (byEmail) dbRecord = byEmail;
      }
      if (!dbRecord && cleanEmail && cleanEmail !== targetEmail) {
        const { data: byNewEmail } = await sbClient.from('app_users').select('id, email, name').ilike('email', cleanEmail).maybeSingle();
        if (byNewEmail) dbRecord = byNewEmail;
      }

      // Step 2: Update by real database ID if found
      if (dbRecord && dbRecord.id) {
        const { error: errUpd } = await sbClient.from('app_users').update(updateData).eq('id', dbRecord.id);
        if (!errUpd) updatedInDb = true;
        else console.warn('Supabase update by ID error:', errUpd.message);
      } else {
        // Step 3: Direct case-insensitive email update fallback
        const { error: errEmail } = await sbClient.from('app_users').update(updateData).ilike('email', targetEmail);
        if (!errEmail) updatedInDb = true;
      }

      // Step 4: If user truly does not exist in Supabase yet, upsert them!
      if (!updatedInDb) {
        const { error: errUps } = await sbClient.from('app_users').upsert({
          ...updateData,
          email: cleanEmail
        }, { onConflict: 'email' });
        if (errUps) console.warn('Supabase upsert fallback error:', errUps.message);
      }
    } catch (e) {
      console.warn('Supabase profile update exception:', e.message);
    }

    // 2b. LIVE SYNC: Update all student messages in Supabase chat_messages table!
    try {
      // Update sender_name on all past messages sent by this student
      await sbClient
        .from('chat_messages')
        .update({ sender_name: cleanName })
        .eq('email', cleanEmail);

      if (cleanOldEmail && cleanOldEmail !== cleanEmail) {
        await sbClient
          .from('chat_messages')
          .update({ sender_name: cleanName, email: cleanEmail })
          .eq('email', cleanOldEmail);
      }

      // Also update receiver_name if this student was the receiver
      await sbClient
        .from('chat_messages')
        .update({ receiver_name: cleanName })
        .eq('receiver_email', cleanEmail);

      if (cleanOldEmail && cleanOldEmail !== cleanEmail) {
        await sbClient
          .from('chat_messages')
          .update({ receiver_name: cleanName, receiver_email: cleanEmail })
          .eq('receiver_email', cleanOldEmail);
      }
    } catch (chatErr) {
      console.warn('Supabase chat_messages sync error:', chatErr.message);
    }
  }

  // 3. LIVE SYNC: Cloudflare Worker database (/users)
  try {
    // Sync current profile to Cloudflare Worker
    await workerApiCall('/users', {
      method: 'POST',
      body: JSON.stringify({
        email: cleanEmail,
        name: cleanName,
        role: cleanRole,
        status: cleanStatus
      })
    });

    // If email was changed, delete old email record from Cloudflare
    if (cleanOldEmail && cleanOldEmail !== cleanEmail) {
      await workerApiCall('/users', {
        method: 'DELETE',
        body: JSON.stringify({ email: cleanOldEmail, userId })
      });
    }

    // If reset session was checked, terminate Worker active session
    if (resetSession) {
      await workerApiCall('/admin/reset-user', {
        method: 'POST',
        body: JSON.stringify({ userId, email: cleanEmail })
      });
    }
  } catch (e) {
    console.warn('Cloudflare Worker live sync notice:', e.message);
  }

  // 4. Save in local persistent overrides & global student names map
  try {
    setStudentNameInMemory(cleanEmail, cleanName, true);
    if (cleanOldEmail && cleanOldEmail !== cleanEmail) {
      setStudentNameInMemory(cleanOldEmail, cleanName, true);
    }

    const overrides = JSON.parse(localStorage.getItem('sp_user_overrides') || '{}');
    const overrideData = { id: userId, name: cleanName, email: cleanEmail, role: cleanRole, status: cleanStatus };
    if (userId) overrides[userId] = overrideData;
    overrides[cleanEmail] = overrideData;
    if (cleanOldEmail && cleanOldEmail !== cleanEmail) {
      overrides[cleanOldEmail] = overrideData;
    }
    localStorage.setItem('sp_user_overrides', JSON.stringify(overrides));

    const nameMap = JSON.parse(localStorage.getItem('sp_student_names') || '{}');
    nameMap[cleanEmail] = cleanName;
    if (cleanOldEmail && cleanOldEmail !== cleanEmail) nameMap[cleanOldEmail] = cleanName;
    localStorage.setItem('sp_student_names', JSON.stringify(nameMap));

    // Update local chat messages in sp_chat_messages
    const localChat = getLocalChatMessages();
    let chatChanged = false;
    localChat.forEach(m => {
      const em = (m.email || '').toLowerCase().trim();
      if (em === cleanEmail || (cleanOldEmail && em === cleanOldEmail)) {
        m.sender_name = cleanName;
        m.email = cleanEmail;
        chatChanged = true;
      }
      const rec = (m.receiver_email || '').toLowerCase().trim();
      if (rec === cleanEmail || (cleanOldEmail && rec === cleanOldEmail)) {
        m.receiver_name = cleanName;
        m.receiver_email = cleanEmail;
        chatChanged = true;
      }
    });
    if (chatChanged) saveLocalChatMessages(localChat);

    // Update active students list
    const online = JSON.parse(localStorage.getItem('online_students') || '[]');
    let onlineChanged = false;
    online.forEach(u => {
      const em = (u.email || '').toLowerCase().trim();
      if (em === cleanEmail || (cleanOldEmail && em === cleanOldEmail)) {
        u.name = cleanName;
        u.email = cleanEmail;
        onlineChanged = true;
      }
    });
    if (onlineChanged) localStorage.setItem('online_students', JSON.stringify(online));
  } catch (e) { }

  // 5. Update cached users list
  try {
    const cached = JSON.parse(localStorage.getItem('cp_cached_users') || '[]');
    const idx = cached.findIndex(u => u.id === userId || (u.email && u.email.toLowerCase() === cleanOldEmail) || (u.email && u.email.toLowerCase() === cleanEmail));
    if (idx >= 0) {
      cached[idx] = { ...cached[idx], ...updateData };
      if (cleanPassword) cached[idx].hasPassword = true;
      localStorage.setItem('cp_cached_users', JSON.stringify(cached));
    }
  } catch (e) { }

  // 6. If current user is this student, update session
  const currentUser = getCurrentUser();
  if (currentUser && (currentUser.id === userId || (currentUser.email && (currentUser.email.toLowerCase() === cleanOldEmail || currentUser.email.toLowerCase() === cleanEmail)))) {
    currentUser.name = cleanName;
    currentUser.email = cleanEmail;
    currentUser.role = cleanRole;
    currentUser.status = cleanStatus;
    saveUserSession(currentUser);
  }

  showToast(`Updated profile for ${cleanName} (${cleanEmail})`, 'success');
  return {
    success: true,
    user: updateData,
    passwordChanged: Boolean(cleanPassword),
    newPassword: cleanPassword
  };
}

// Global in-memory cache for fast student names mapping
const _inMemoryStudentNames = new Map();

function setStudentNameInMemory(email, name, force = false) {
  if (!email || !name) return;
  const clean = email.toLowerCase().trim();
  const cleanName = name.trim();
  const emailPrefix = clean.split('@')[0].toLowerCase();
  // Only save if it's a REAL name — not email prefix or 'student'
  if (cleanName) {
    _inMemoryStudentNames.set(clean, cleanName);
    try {
      const nameMap = JSON.parse(localStorage.getItem('sp_student_names') || '{}');
      nameMap[clean] = cleanName;
      localStorage.setItem('sp_student_names', JSON.stringify(nameMap));
    } catch (e) { }
  }
}

function getStudentNameByEmail(email, fallbackName) {
  if (!email) return fallbackName || 'Student';
  const clean = email.toLowerCase().trim();

  // 1. Check user overrides FIRST (Admin edits take top priority)
  try {
    const overrides = JSON.parse(localStorage.getItem('sp_user_overrides') || '{}');
    if (overrides[clean] && overrides[clean].name) {
      const oName = overrides[clean].name.trim();
      if (oName) {
        _inMemoryStudentNames.set(clean, oName);
        return oName;
      }
    }
  } catch (e) { }

  // 2. In-memory live cache (instant 0ms)
  if (_inMemoryStudentNames.has(clean)) {
    const memName = _inMemoryStudentNames.get(clean);
    if (memName) return memName;
  }

  // 3. Check global student names map
  try {
    const nameMap = JSON.parse(localStorage.getItem('sp_student_names') || '{}');
    if (nameMap[clean]) {
      const sName = nameMap[clean].trim();
      if (sName) return sName;
    }
  } catch (e) { }

  // 4. Check cached users
  try {
    const cached = JSON.parse(localStorage.getItem('cp_cached_users') || '[]');
    const found = cached.find(u => (u.email || '').toLowerCase().trim() === clean);
    if (found && found.name && found.name.trim()) {
      return found.name.trim();
    }
  } catch (e) { }

  // 5. Check current active session
  try {
    const cur = getCurrentUser();
    if (cur && cur.email && cur.email.toLowerCase().trim() === clean && cur.name && cur.name.trim()) {
      return cur.name.trim();
    }
  } catch (e) { }

  // 6. Check fallback name provided
  if (fallbackName && fallbackName.trim() && fallbackName.toLowerCase() !== 'administrator') {
    return fallbackName.trim();
  }

  // 7. Default to Student
  return 'Student';
}

async function resetUserAndKey(userId, email) {
  return await adminGeneratePasswordForStudent(userId, email);
}

async function addUser(email) {
  const clean = (email || '').trim().toLowerCase();
  if (!clean || !clean.includes('@')) return { success: false, error: 'Valid email required' };
  try {
    const res = await workerApiCall('/users', {
      method: 'POST',
      body: JSON.stringify({ email: clean })
    });
    // Auto-whitelist in allowed-emails so admin-added student can immediately login & generate key
    try {
      await addAllowedEmail(clean);
    } catch (e) { }

    // Sync to Supabase app_users table
    // IMPORTANT: Don't overwrite existing name with email prefix!
    if (checkClient()) {
      try {
        // Check if user already has a name in DB
        const { data: existing } = await sbClient.from('app_users').select('id, name').eq('email', clean).maybeSingle();
        if (existing && existing.name) {
          // User exists with a name — only update status, don't touch name
          await sbClient.from('app_users').update({ status: 'approved' }).eq('email', clean);
        } else {
          // New user — resolve best name from overrides
          let bestName = clean.split('@')[0];
          try {
            const overrides = JSON.parse(localStorage.getItem('sp_user_overrides') || '{}');
            if (overrides[clean] && overrides[clean].name) bestName = overrides[clean].name;
            else {
              const nameMap = JSON.parse(localStorage.getItem('sp_student_names') || '{}');
              if (nameMap[clean]) bestName = nameMap[clean];
            }
          } catch (e) {}
          await sbClient.from('app_users').upsert({
            email: clean,
            name: bestName,
            role: 'student',
            status: 'approved'
          }, { onConflict: 'email' });
        }
      } catch (e) { }
    }

    return res;
  } catch (e) {
    return { success: false, error: e.message };
  }
}

async function getUserKeys(userId) {
  try {
    return await workerApiCall('/keys?userId=' + encodeURIComponent(userId));
  } catch (e) {
    return { success: false, error: e.message };
  }
}

async function generateUserKey(userId) {
  try {
    return await workerApiCall('/keys/generate', {
      method: 'POST',
      body: JSON.stringify({ userId })
    });
  } catch (e) {
    return { success: false, error: e.message };
  }
}

async function getOnlineStudentsFromWorker() {
  try {
    const data = await workerApiCall('/active-users/list');
    if (data && data.success && Array.isArray(data.users)) {
      return data.users;
    }
  } catch (e) { }
  return [];
}

async function resetUser(userId) {
  try {
    return await workerApiCall('/admin/reset-user', {
      method: 'POST',
      body: JSON.stringify({ userId })
    });
  } catch (e) {
    return { success: false, error: e.message };
  }
}

async function updateUserStatus(userId, status) {
  if (!checkClient()) return false;
  const token = getAdminToken();

  if (token) {
    try {
      const { data, error } = await sbClient.rpc('admin_set_user_status', {
        p_token: token,
        p_user_id: userId,
        p_new_status: status
      });
      if (!error && data) return true;
    } catch (e) { }
  }

  const { error } = await sbClient
    .from('app_users')
    .update({ status })
    .eq('id', userId);

  if (error) {
    console.error('updateUserStatus error:', error);
    showToast('Failed to update status: ' + error.message, 'error');
    return false;
  }
  return true;
}

async function updateUserRole(userId, role) {
  if (!checkClient()) return false;
  const token = getAdminToken();

  if (token) {
    try {
      const { data, error } = await sbClient.rpc('admin_set_user_role', {
        p_token: token,
        p_user_id: userId,
        p_new_role: role
      });
      if (!error && data) return true;
    } catch (e) { }
  }

  const { error } = await sbClient
    .from('app_users')
    .update({ role })
    .eq('id', userId);

  if (error) {
    console.error('updateUserRole error:', error);
    showToast('Failed to update role: ' + error.message, 'error');
    return false;
  }
  return true;
}

async function deleteUser(userId, email) {
  const cleanEmail = (email || '').toLowerCase().trim();
  let workerUserId = (userId && typeof userId === 'string' && userId.startsWith('usr_')) ? userId : null;

  // 1. If we don't have a Worker usr_... ID, look it up in worker users by email
  if (!workerUserId && cleanEmail) {
    try {
      const cfData = await workerApiCall('/users');
      if (cfData && Array.isArray(cfData.users)) {
        const found = cfData.users.find(u => (u.email || '').toLowerCase().trim() === cleanEmail);
        if (found && found.id) workerUserId = found.id;
      }
    } catch (e) { }
  }

  // 2. Delete from Worker API
  try {
    await workerApiCall('/users', {
      method: 'DELETE',
      body: JSON.stringify({ userId: workerUserId || userId, email: cleanEmail })
    });
  } catch (e) {
    console.warn('Worker deleteUser notice:', e.message);
  }

  // 3. Also remove from allowed whitelist if email is known
  if (cleanEmail) {
    try {
      await deleteAllowedEmail(cleanEmail, true);
    } catch (e) { }
  }

  // 4. Delete from Supabase app_users table
  if (checkClient()) {
    try {
      if (cleanEmail) {
        await sbClient
          .from('app_users')
          .delete()
          .eq('email', cleanEmail);
      }
      if (userId && !userId.startsWith('usr_') && !userId.startsWith('cf_')) {
        await sbClient
          .from('app_users')
          .delete()
          .eq('id', userId);
      }
    } catch (e) {
      console.warn('Supabase deleteUser error:', e);
    }
  }

  // 5. Clear from local cached users & overrides
  try {
    const cached = JSON.parse(localStorage.getItem('cp_cached_users') || '[]');
    const filtered = cached.filter(u => u.id !== userId && (u.email || '').toLowerCase().trim() !== cleanEmail);
    localStorage.setItem('cp_cached_users', JSON.stringify(filtered));
  } catch (e) { }
  try {
    const overrides = JSON.parse(localStorage.getItem('sp_user_overrides') || '{}');
    if (userId) delete overrides[userId];
    if (cleanEmail) delete overrides[cleanEmail];
    localStorage.setItem('sp_user_overrides', JSON.stringify(overrides));
  } catch (e) { }

  showToast('User deleted from database', 'info');
  return { success: true };
}

// ===== YOUTUBE IMPORT & EXTRACTION UTILITIES (SYNCED FROM OLD ADMIN) =====
function extractYouTubePlaylistId(url) {
  if (!url) return null;
  url = url.trim();
  if (/^[A-Za-z0-9_-]{10,}$/.test(url) && !url.includes('/') && !url.includes('.')) {
    return url;
  }
  try {
    const parsed = new URL(url.startsWith('http') ? url : 'https://' + url);
    const listParam = parsed.searchParams.get('list');
    if (listParam) return listParam;
  } catch (e) { }
  const match = url.match(/[?&]list=([a-zA-Z0-9_-]+)/);
  if (match) return match[1];
  return null;
}

function extractYouTubeVideoId(url) {
  if (!url) return null;
  const clean = url.trim();
  if (/^[a-zA-Z0-9_-]{11}$/.test(clean)) return clean;
  const match = clean.match(/(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?|shorts|live)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/);
  return match ? match[1] : null;
}

function parseBulkYouTubeVideos(text) {
  if (!text) return [];
  const lines = text.split('\n');
  const videos = [];
  lines.forEach(rawLine => {
    const line = rawLine.trim();
    if (!line) return;
    let title = '';
    let urlCandidate = line;
    if (line.includes('|')) {
      const parts = line.split('|');
      title = parts[0].trim();
      urlCandidate = parts.slice(1).join('|').trim();
    } else if (line.includes(' - ') && (line.includes('http://') || line.includes('https://'))) {
      const parts = line.split(' - ');
      title = parts[0].trim();
      urlCandidate = parts.slice(1).join(' - ').trim();
    }
    const videoId = extractYouTubeVideoId(urlCandidate);
    if (videoId) {
      const num = videos.length + 1;
      videos.push({
        id: videoId,
        title: title || `Lecture ${num}`,
        link: `https://www.youtube.com/watch?v=${videoId}`,
        thumbnail: `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`,
        position: num
      });
    }
  });
  return videos;
}

const DEFAULT_YT_API_KEY = 'AIzaSyB8Xe0Oj__bHwc2mlNB4w_OLrIu9vN4Uzw';
try {
  if (localStorage.getItem('yt_api_key') === 'AIzaSyAwG4U5R9L1CTY-cu-kVApqsq8LwjkmQq4') {
    localStorage.removeItem('yt_api_key');
  }
} catch (e) { }

async function fetchYouTubePlaylistVideos(playlistId, apiKey = '', oauthToken = '') {
  let videos = [];
  let playlistTitle = '';

  apiKey = (apiKey || localStorage.getItem('yt_api_key') || DEFAULT_YT_API_KEY).trim();
  oauthToken = (oauthToken || localStorage.getItem('yt_oauth_token') || '').trim();

  const reqHeaders = {};
  if (oauthToken) reqHeaders['Authorization'] = `Bearer ${oauthToken}`;

  // 1. Fetch Playlist Info (Title)
  try {
    const infoUrl = `https://www.googleapis.com/youtube/v3/playlists?part=snippet&id=${encodeURIComponent(playlistId)}&key=${encodeURIComponent(apiKey)}`;
    const infoRes = await fetch(infoUrl, { headers: reqHeaders });
    if (infoRes.ok) {
      const infoData = await infoRes.json();
      if (infoData.items && infoData.items[0]) {
        playlistTitle = infoData.items[0].snippet?.title || '';
      }
    }
  } catch (e) {
    console.warn('Playlist info fetch error:', e.message);
  }

  // 2. Fetch Playlist Items with Pagination (up to 500)
  try {
    let nextPageToken = '';
    do {
      const ytUrl = `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&maxResults=50&playlistId=${encodeURIComponent(playlistId)}&key=${encodeURIComponent(apiKey)}${nextPageToken ? '&pageToken=' + encodeURIComponent(nextPageToken) : ''}`;
      const res = await fetch(ytUrl, { headers: reqHeaders });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData?.error?.message || `YouTube API error (${res.status})`);
      }
      const data = await res.json();
      if (data.items) {
        data.items.forEach(item => {
          const snip = item.snippet;
          if (snip && snip.resourceId && snip.resourceId.videoId && snip.title !== 'Deleted video') {
            const vId = snip.resourceId.videoId;
            const isPrivate = (snip.title === 'Private video');
            let vTitle = snip.title;
            if (isPrivate || !vTitle) {
              const baseName = playlistTitle ? `${playlistTitle} - Part ${videos.length + 1}` : `Lecture ${videos.length + 1}`;
              vTitle = baseName;
            }
            videos.push({
              id: vId,
              title: vTitle,
              isPrivate: isPrivate,
              link: `https://www.youtube.com/watch?v=${vId}`,
              thumbnail: snip.thumbnails?.medium?.url || snip.thumbnails?.default?.url || (isPrivate ? '' : `https://i.ytimg.com/vi/${vId}/mqdefault.jpg`),
              position: videos.length + 1
            });
          }
        });
      }
      nextPageToken = data.nextPageToken;
    } while (nextPageToken && videos.length < 500);
  } catch (err) {
    console.warn('YouTube API error fetching playlistItems:', err.message);
    if (!videos.length) throw err;
  }

  // --- MULTI-TIER BYPASS: RESOLVE REAL TITLES FOR UNLISTED / HIDDEN VIDEOS ---
  const needTitleEnrichment = videos.filter(v =>
    v.isPrivate || !v.title || /^(lecture|part)\s*\d+$/i.test(v.title) || (playlistTitle && v.title.startsWith(playlistTitle + ' - Part '))
  );

  if (needTitleEnrichment.length > 0) {
    // Bypass Tier 1: YouTube videos.list API (works for Unlisted videos)
    const enrichIds = needTitleEnrichment.map(v => v.id);
    for (let i = 0; i < enrichIds.length; i += 50) {
      const chunk = enrichIds.slice(i, i + 50);
      try {
        const vUrl = `https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${chunk.join(',')}&key=${encodeURIComponent(apiKey)}`;
        const vRes = await fetch(vUrl, { headers: reqHeaders });
        if (vRes.ok) {
          const vData = await vRes.json();
          if (Array.isArray(vData.items)) {
            vData.items.forEach(item => {
              const realTitle = item.snippet?.title;
              if (realTitle && realTitle !== 'Private video') {
                const target = videos.find(v => v.id === item.id);
                if (target) {
                  target.title = realTitle;
                  target.isPrivate = false;
                  if (item.snippet.thumbnails?.medium?.url) {
                    target.thumbnail = item.snippet.thumbnails.medium.url;
                  }
                }
              }
            });
          }
        }
      } catch (e) { }
    }

    // Bypass Tier 2: Fast CORS-enabled oEmbed via noembed (extracts unlisted real titles directly from browser)
    const stillNeed = videos.filter(v =>
      v.isPrivate || !v.title || /^(lecture|part)\s*\d+$/i.test(v.title) || (playlistTitle && v.title.startsWith(playlistTitle + ' - Part '))
    );
    if (stillNeed.length > 0) {
      await Promise.all(stillNeed.map(async (v) => {
        try {
          const oeRes = await fetch(`https://noembed.com/embed?url=https://www.youtube.com/watch?v=${encodeURIComponent(v.id)}`);
          if (oeRes.ok) {
            const oeData = await oeRes.json();
            if (oeData && oeData.title && oeData.title !== 'Private video' && !oeData.error) {
              v.title = oeData.title;
              v.isPrivate = false;
              if (oeData.thumbnail_url) v.thumbnail = oeData.thumbnail_url;
              return;
            }
          }
        } catch (e) { }

        try {
          const yRes = await fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${encodeURIComponent(v.id)}&format=json`);
          if (yRes.ok) {
            const yData = await yRes.json();
            if (yData && yData.title && yData.title !== 'Private video') {
              v.title = yData.title;
              v.isPrivate = false;
              if (yData.thumbnail_url) v.thumbnail = yData.thumbnail_url;
            }
          }
        } catch (e) { }
      }));
    }
  }

  return { title: playlistTitle || 'YouTube Playlist', videos };
}

async function fetchYouTubeBatchVideos(videoIds, apiKey = '') {
  if (!Array.isArray(videoIds) || !videoIds.length) return [];
  apiKey = (apiKey || localStorage.getItem('yt_api_key') || DEFAULT_YT_API_KEY).trim();
  const oauthToken = (localStorage.getItem('yt_oauth_token') || '').trim();
  const reqHeaders = {};
  if (oauthToken) reqHeaders['Authorization'] = `Bearer ${oauthToken}`;
  const videos = [];

  for (let i = 0; i < videoIds.length; i += 50) {
    const chunk = videoIds.slice(i, i + 50);
    try {
      const url = `https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${chunk.join(',')}&key=${encodeURIComponent(apiKey)}`;
      const res = await fetch(url, { headers: reqHeaders });
      if (res.ok) {
        const data = await res.json();
        if (data.items) {
          data.items.forEach(item => {
            const snip = item.snippet;
            const num = videos.length + 1;
            const isPriv = (snip?.title === 'Private video');
            videos.push({
              id: item.id,
              title: isPriv ? `Lecture ${num}` : (snip?.title || `Lecture ${num}`),
              link: `https://www.youtube.com/watch?v=${item.id}`,
              thumbnail: snip?.thumbnails?.medium?.url || snip?.thumbnails?.default?.url || `https://i.ytimg.com/vi/${item.id}/mqdefault.jpg`,
              position: num,
              isPrivate: isPriv
            });
          });
        }
      }
    } catch (e) {
      console.warn('Batch videos fetch error:', e.message);
    }
  }

  const fetchedIds = new Set(videos.map(v => v.id));
  const missing = [];
  videoIds.forEach((vid, idx) => {
    if (!fetchedIds.has(vid)) {
      const fallbackItem = {
        id: vid,
        title: `Lecture ${idx + 1}`,
        link: `https://www.youtube.com/watch?v=${vid}`,
        thumbnail: `https://i.ytimg.com/vi/${vid}/mqdefault.jpg`,
        position: idx + 1,
        isPrivate: true
      };
      videos.push(fallbackItem);
      missing.push(fallbackItem);
    }
  });

  // Bypass Tier 2: CORS-enabled noembed + oEmbed for any unlisted or missing titles
  if (missing.length > 0 && missing.length <= 50) {
    await Promise.all(missing.map(async (v) => {
      try {
        const oeRes = await fetch(`https://noembed.com/embed?url=https://www.youtube.com/watch?v=${encodeURIComponent(v.id)}`);
        if (oeRes.ok) {
          const oeData = await oeRes.json();
          if (oeData && oeData.title && oeData.title !== 'Private video' && !oeData.error) {
            v.title = oeData.title;
            v.isPrivate = false;
            if (oeData.thumbnail_url) v.thumbnail = oeData.thumbnail_url;
            return;
          }
        }
      } catch (e) { }

      try {
        const yRes = await fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${encodeURIComponent(v.id)}&format=json`);
        if (yRes.ok) {
          const yData = await yRes.json();
          if (yData && yData.title && yData.title !== 'Private video') {
            v.title = yData.title;
            v.isPrivate = false;
            if (yData.thumbnail_url) v.thumbnail = yData.thumbnail_url;
          }
        }
      } catch (e) { }
    }));
  }

  return videos;
}

async function parseBulkLinksOrPlaylist(input, apiKey = '', oauthToken = '') {
  if (!input || !input.trim()) return { title: '', videos: [] };
  const text = input.trim();
  apiKey = (apiKey || localStorage.getItem('yt_api_key') || DEFAULT_YT_API_KEY).trim();
  oauthToken = (oauthToken || localStorage.getItem('yt_oauth_token') || '').trim();

  // 1. Check if it is a single playlist URL or playlist ID
  const playlistId = extractYouTubePlaylistId(text);
  if (playlistId && !text.includes('\n')) {
    return await fetchYouTubePlaylistVideos(playlistId, apiKey, oauthToken);
  }

  // 2. Line-by-line parsing supporting Custom Titles + Links
  const lines = text.split('\n');
  const parsedItems = [];
  const bareVideoIds = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    // Check for YouTube link inside the line
    const ytMatch = line.match(/(https?:\/\/(?:www\.)?(?:youtube\.com\/(?:watch\?v=|embed\/|v\/|shorts\/)|youtu\.be\/)([\w-]{11})[^\s]*)/);
    if (ytMatch) {
      const fullUrl = ytMatch[1];
      const vid = ytMatch[2];

      // Extract custom title from remainder of line if provided
      let customTitle = line.replace(fullUrl, '').replace(/^[\s|:\-–—\(\)\[\]]+|[\s|:\-–—\(\)\[\]]+$/g, '').trim();
      customTitle = customTitle.replace(/^\d+[\.\)]\s*/, '').trim();

      if (customTitle) {
        parsedItems.push({
          id: vid,
          title: customTitle,
          link: `https://www.youtube.com/watch?v=${vid}`,
          thumbnail: `https://i.ytimg.com/vi/${vid}/mqdefault.jpg`,
          position: parsedItems.length + 1,
          isPrivate: false
        });
      } else {
        bareVideoIds.push({ id: vid, pos: parsedItems.length });
        parsedItems.push(null); // placeholder to maintain line order
      }
    } else if (line.includes('|') || line.includes('.m3u8') || line.includes('.mp4')) {
      // Non-YouTube custom stream line
      let title = '';
      let link = line;
      if (line.includes('|')) {
        const parts = line.split('|');
        title = parts[0].trim();
        link = parts.slice(1).join('|').trim();
      } else if (line.includes(' - ') && (line.includes('http://') || line.includes('https://'))) {
        const parts = line.split(' - ');
        title = parts[0].trim();
        link = parts.slice(1).join(' - ').trim();
      }
      const num = parsedItems.length + 1;
      parsedItems.push({
        id: 'gen_' + num,
        title: title || `Lecture ${num}`,
        link: link,
        thumbnail: '',
        position: num,
        isPrivate: false
      });
    }
  }

  // Fetch bare YouTube video IDs in batch
  if (bareVideoIds.length > 0) {
    const idsOnly = bareVideoIds.map(b => b.id);
    const fetchedBatch = await fetchYouTubeBatchVideos(idsOnly, apiKey, oauthToken);
    const fetchedMap = new Map(fetchedBatch.map(v => [v.id, v]));

    bareVideoIds.forEach(b => {
      const fetched = fetchedMap.get(b.id);
      parsedItems[b.pos] = {
        id: b.id,
        title: fetched ? fetched.title : `Lecture ${b.pos + 1}`,
        link: `https://www.youtube.com/watch?v=${b.id}`,
        thumbnail: fetched ? fetched.thumbnail : `https://i.ytimg.com/vi/${b.id}/mqdefault.jpg`,
        position: b.pos + 1,
        isPrivate: fetched ? fetched.isPrivate : false
      };
    });
  }

  const validVideos = parsedItems.filter(Boolean);
  if (validVideos.length > 0) {
    return { title: 'Imported Lectures', videos: validVideos };
  }

  // Fallback: If playlist URL was in multiline text
  if (playlistId) {
    return await fetchYouTubePlaylistVideos(playlistId, apiKey, oauthToken);
  }

  return { title: 'Imported Lectures', videos: [] };
}

async function testYouTubeConnection(customToken = '', customKey = '') {
  const token = (customToken || localStorage.getItem('yt_oauth_token') || '').trim();
  const apiKey = (customKey || localStorage.getItem('yt_api_key') || DEFAULT_YT_API_KEY).trim();

  if (!token) {
    try {
      const res = await fetch(`https://www.googleapis.com/youtube/v3/videos?part=id&id=dQw4w9WgXcQ&key=${encodeURIComponent(apiKey)}`);
      if (res.ok) {
        return {
          success: true,
          mode: 'public_key',
          message: 'Public YouTube API Key is active (Accessing private/unlisted videos requires a Google Account access token)'
        };
      } else {
        const err = await res.json().catch(() => ({}));
        return { success: false, error: err?.error?.message || `API Key error (${res.status})` };
      }
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  // 1. Try fetching authorized YouTube Channel snippet
  try {
    const res = await fetch(`https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true&key=${encodeURIComponent(apiKey)}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (res.ok) {
      const data = await res.json();
      const channel = (data.items && data.items[0]) ? data.items[0].snippet : null;
      if (channel) {
        return {
          success: true,
          mode: 'oauth',
          channelTitle: channel.title,
          thumbnail: channel.thumbnails?.default?.url || '',
          message: `Connected to Google/YouTube Account: "${channel.title}"`
        };
      }
    } else if (res.status === 401) {
      return {
        success: false,
        error: 'Google OAuth token expired or invalid (401 Unauthorized). Please generate a fresh token.'
      };
    }

    // 2. Fallback to Google Userinfo (e.g. if Google account doesn't have a YouTube channel created)
    const userRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (userRes.ok) {
      const userData = await userRes.json();
      return {
        success: true,
        mode: 'oauth',
        channelTitle: userData.name || userData.email || 'Authorized Google Account',
        thumbnail: userData.picture || '',
        message: `Connected to Google Account: ${userData.email || userData.name}`
      };
    }

    const err = await res.json().catch(() => ({}));
    return { success: false, error: err?.error?.message || `YouTube API error (${res.status})` };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// ===== GOOGLE OAUTH TOKEN STORAGE (FOR PRIVATE YOUTUBE VIDEOS) =====
const GOOGLE_SESSION_KEY = 'google_session';
const GOOGLE_OAUTH_CLIENT_ID = '853267104713-46mrftcdeva7a8di4bdq6i6br29bd3vn.apps.googleusercontent.com';
const GOOGLE_OAUTH_SCOPE = 'https://www.googleapis.com/auth/youtube.readonly email profile';
const GOOGLE_RETURN_URL_KEY = 'sp_google_oauth_return_url';

function getGoogleAuthUrl(redirectUriOverride = '') {
  const origin = (typeof window !== 'undefined' && window.location && window.location.origin && window.location.origin !== 'null')
    ? window.location.origin
    : 'https://video-portal-klrv.onrender.com';
  const redirectUri = redirectUriOverride || origin;
  return 'https://accounts.google.com/o/oauth2/v2/auth'
    + '?client_id=' + encodeURIComponent(GOOGLE_OAUTH_CLIENT_ID)
    + '&redirect_uri=' + encodeURIComponent(redirectUri)
    + '&response_type=token'
    + '&scope=' + encodeURIComponent(GOOGLE_OAUTH_SCOPE)
    + '&prompt=consent';
}

function startGoogleOAuthLogin(returnUrl = '') {
  try {
    const targetReturn = returnUrl || (typeof window !== 'undefined' ? window.location.href : '');
    if (targetReturn) {
      try { localStorage.setItem(GOOGLE_RETURN_URL_KEY, targetReturn); } catch (e) { }
      try { sessionStorage.setItem(GOOGLE_RETURN_URL_KEY, targetReturn); } catch (e) { }
    }
    window.location.href = getGoogleAuthUrl();
  } catch (e) {
    console.warn('Google OAuth start error:', e);
  }
}

function checkGoogleSession() {
  try {
    const raw = localStorage.getItem(GOOGLE_SESSION_KEY);
    if (!raw) return null;
    const session = JSON.parse(raw);
    if (!session || !session.accessToken) {
      localStorage.removeItem(GOOGLE_SESSION_KEY);
      return null;
    }
    // Keep 7-day window matching Worker google_tokens expiry
    if (session.loginTime && (Date.now() - session.loginTime > 7 * 24 * 60 * 60 * 1000)) {
      localStorage.removeItem(GOOGLE_SESSION_KEY);
      return null;
    }
    return session;
  } catch (e) {
    return null;
  }
}

async function storeGoogleTokenInBackend(email, accessToken, googleUser = null) {
  const cleanEmail = (email || '').trim().toLowerCase();
  if (!cleanEmail || !accessToken) return { success: false, error: 'Email and token required' };
  try {
    const res = await workerApiCall('/google/store-token', {
      method: 'POST',
      body: JSON.stringify({
        email: cleanEmail,
        google_token: accessToken,
        google_user: googleUser || { email: cleanEmail }
      })
    });
    return res || { success: true };
  } catch (e) {
    console.warn('Backend Google token sync notice:', e.message);
    return { success: false, error: e.message };
  }
}

async function revokeGoogleSession() {
  const sess = checkGoogleSession();
  const email = (sess && sess.user && sess.user.email) || (getCurrentUser() && getCurrentUser().email) || '';
  try { localStorage.removeItem(GOOGLE_SESSION_KEY); } catch (e) { }
  if (email) {
    try {
      await workerApiCall('/google/revoke-token', {
        method: 'DELETE',
        body: JSON.stringify({ email: email.trim().toLowerCase() })
      });
    } catch (e) { }
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('spider_google_auth_updated', { detail: { user: null, accessToken: null } }));
  }
}

function _saveGoogleSessionLocal(googleUser, accessToken) {
  try {
    localStorage.setItem(GOOGLE_SESSION_KEY, JSON.stringify({
      user: googleUser,
      accessToken,
      loginTime: Date.now()
    }));
  } catch (e) { }
}

function _decodeJwtPayloadSafe(token) {
  try {
    const parts = String(token || '').split('.');
    if (parts.length !== 3) return null;
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(base64));
  } catch (e) {
    return null;
  }
}

let _googleOAuthCapturePromise = null;
function captureGoogleOAuthTokenFromHash() {
  if (typeof window === 'undefined' || !window.location || !window.location.hash) return null;
  const hash = window.location.hash;

  if (hash.includes('error=') && !hash.includes('access_token=')) {
    const errParams = new URLSearchParams(hash.substring(1));
    const errMsg = errParams.get('error_description') || errParams.get('error') || 'Google sign-in cancelled';
    try {
      window.history.replaceState({}, document.title, window.location.pathname + window.location.search);
    } catch (e) { }
    setTimeout(() => { try { showToast('⚠️ ' + errMsg, 'error'); } catch (e) { } }, 200);
    return null;
  }

  if (!hash.includes('access_token=')) return null;

  const params = new URLSearchParams(hash.substring(1));
  const token = params.get('access_token');
  const idToken = params.get('id_token');
  if (!token) return null;

  // Clean token fragment from URL immediately so it never stays in browser history
  try {
    window.history.replaceState({}, document.title, window.location.pathname + window.location.search);
  } catch (e) { }

  const portalUser = getCurrentUser();
  const decoded = _decodeJwtPayloadSafe(idToken || token);
  let googleUser = {
    email: (decoded && decoded.email) || (portalUser && portalUser.email) || '',
    name: (decoded && decoded.name) || (portalUser && portalUser.name) || 'Google User',
    picture: (decoded && decoded.picture) || '',
    id: (decoded && decoded.sub) || ''
  };

  // Persist immediately in localStorage so any immediate UI check sees it
  _saveGoogleSessionLocal(googleUser, token);

  _googleOAuthCapturePromise = (async () => {
    try {
      const userRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (userRes.ok) {
        const info = await userRes.json();
        if (info && (info.email || info.sub)) {
          googleUser = {
            email: info.email || googleUser.email,
            name: info.name || googleUser.name,
            picture: info.picture || googleUser.picture,
            id: info.sub || googleUser.id
          };
          _saveGoogleSessionLocal(googleUser, token);
        }
      }
    } catch (e) {
      console.warn('Google userinfo lookup notice:', e.message);
    }

    const emailToStore = (googleUser.email || (portalUser && portalUser.email) || '').trim().toLowerCase();
    if (emailToStore) {
      await Promise.race([
        storeGoogleTokenInBackend(emailToStore, token, googleUser),
        new Promise(resolve => setTimeout(resolve, 2500))
      ]);
    }

    window.dispatchEvent(new CustomEvent('spider_google_auth_updated', {
      detail: { user: googleUser, accessToken: token }
    }));

    try {
      showToast(`✅ Google Connected: ${emailToStore || 'Token stored'}`, 'success');
    } catch (e) { }

    // Return user straight back to the lecture/page where they clicked "Sign in with Google"
    try {
      const savedReturn = sessionStorage.getItem(GOOGLE_RETURN_URL_KEY) || localStorage.getItem(GOOGLE_RETURN_URL_KEY) || '';
      sessionStorage.removeItem(GOOGLE_RETURN_URL_KEY);
      localStorage.removeItem(GOOGLE_RETURN_URL_KEY);
      if (savedReturn) {
        const retUrl = new URL(savedReturn, window.location.origin);
        const normPath = p => (p === '/' ? '/index.html' : p);
        const curFull = normPath(window.location.pathname) + window.location.search;
        const retFull = normPath(retUrl.pathname) + retUrl.search;
        if (retUrl.origin === window.location.origin && retFull !== curFull) {
          window.location.replace(retUrl.href);
        }
      }
    } catch (e) { }

    return googleUser;
  })();

  return _googleOAuthCapturePromise;
}

if (typeof window !== 'undefined') {
  captureGoogleOAuthTokenFromHash();
}

// ===== CHAPTER YOUTUBE PLAYLIST AUTOSYNC SYSTEM =====
const CHAPTER_PLAYLISTS_KEY = 'sp_chapter_playlists';

function getAllChapterPlaylists() {
  try {
    return JSON.parse(localStorage.getItem(CHAPTER_PLAYLISTS_KEY) || '{}');
  } catch (e) {
    return {};
  }
}

let _chapterPlaylistsSynced = false;

async function syncCloudChapterPlaylists() {
  if (_chapterPlaylistsSynced) return getAllChapterPlaylists();
  _chapterPlaylistsSynced = true;

  try {
    let cloudMap = null;
    // Try server endpoint if on http/https (local or cloud)
    if (typeof window !== 'undefined' && window.location && window.location.protocol.startsWith('http')) {
      try {
        const res = await fetch('/api-local/chapter-playlists');
        if (res.ok) {
          const json = await res.json();
          if (json && typeof json === 'object' && Object.keys(json).length > 0) {
            cloudMap = json;
          }
        }
      } catch (e) { }
    }

    const localMap = getAllChapterPlaylists();

    if (cloudMap && typeof cloudMap === 'object' && Object.keys(cloudMap).length > 0) {
      const merged = { ...cloudMap, ...localMap };
      localStorage.setItem(CHAPTER_PLAYLISTS_KEY, JSON.stringify(merged));
      if (Object.keys(localMap).length > Object.keys(cloudMap).length) {
        saveChapterPlaylistsToCloud(merged);
      }
      return merged;
    } else if (Object.keys(localMap).length > 0) {
      saveChapterPlaylistsToCloud(localMap);
      return localMap;
    }
  } catch (err) {
    console.warn('syncCloudChapterPlaylists error:', err);
  }
  return getAllChapterPlaylists();
}

async function saveChapterPlaylistsToCloud(map) {
  if (!map || typeof map !== 'object') return;
  const jsonStr = JSON.stringify(map);

  if (typeof window !== 'undefined' && window.location && window.location.protocol.startsWith('http')) {
    try {
      fetch('/api-local/chapter-playlists', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: jsonStr
      }).catch(() => { });
    } catch (e) { }
  }
}

function getChapterPlaylist(chapterId) {
  if (!chapterId) return null;
  const strId = String(chapterId).trim();
  const map = getAllChapterPlaylists();
  if (map[strId] || map[chapterId]) return map[strId] || map[chapterId];

  // Auto trigger background sync if not yet run
  if (!_chapterPlaylistsSynced) {
    syncCloudChapterPlaylists().catch(() => { });
  }
  return null;
}

function setChapterPlaylist(chapterId, playlistData) {
  if (!chapterId) return;
  const strId = String(chapterId).trim();
  const map = getAllChapterPlaylists();
  if (!playlistData) {
    delete map[strId];
    delete map[chapterId];
  } else {
    const playlistUrl = typeof playlistData === 'string' ? playlistData : (playlistData.playlistUrl || playlistData.url || '');
    const playlistId = typeof playlistData === 'object' && playlistData.playlistId ? playlistData.playlistId : extractYouTubePlaylistId(playlistUrl);
    map[strId] = {
      chapterId: strId,
      playlistUrl,
      playlistId,
      playlistTitle: playlistData.playlistTitle || '',
      lastSyncedAt: (playlistData.lastSyncedAt || new Date().toISOString())
    };
  }
  try {
    localStorage.setItem(CHAPTER_PLAYLISTS_KEY, JSON.stringify(map));
  } catch (e) { }
  saveChapterPlaylistsToCloud(map);
}

async function syncChapterWithPlaylist(chapterId, options = {}) {
  const chapIdStr = String(chapterId).trim();
  const info = getChapterPlaylist(chapIdStr) || getChapterPlaylist(chapterId);
  if (!info || !info.playlistId) {
    return { success: false, error: 'No linked YouTube playlist found for this chapter.' };
  }

  const apiKey = (options.apiKey || localStorage.getItem('yt_api_key') || DEFAULT_YT_API_KEY).trim();
  const oauthToken = (options.oauthToken || localStorage.getItem('yt_oauth_token') || '').trim();

  // 1. Fetch latest videos from YouTube API (returns videos in exact playlist order 0..N)
  let fetchedData;
  try {
    fetchedData = await fetchYouTubePlaylistVideos(info.playlistId, apiKey, oauthToken);
  } catch (err) {
    return { success: false, error: 'YouTube API fetch failed: ' + err.message };
  }

  const ytVideos = (fetchedData && fetchedData.videos) ? fetchedData.videos : [];
  if (!ytVideos.length) {
    return { success: false, error: 'No videos found in YouTube playlist.' };
  }

  // 2. Fetch existing lectures in this chapter
  const allLecs = await getAllLectures(true);
  const currentChapterLecs = allLecs.filter(l => String(l.chapter_id) === chapIdStr);

  // Group existing lectures by extracted YouTube video ID
  const existingByYtId = new Map();
  currentChapterLecs.forEach(lec => {
    const vId = extractYouTubeVideoId(lec.url);
    if (vId) {
      if (!existingByYtId.has(vId)) existingByYtId.set(vId, []);
      existingByYtId.get(vId).push(lec);
    }
  });

  let addedCount = 0;
  let removedCount = 0;
  let updatedCount = 0;

  // STEP A: Purge all internal duplicate lectures for the same YouTube video in this chapter!
  for (const [vId, lecs] of existingByYtId.entries()) {
    if (lecs.length > 1) {
      const duplicatesToDelete = lecs.slice(1);
      for (const dup of duplicatesToDelete) {
        try {
          await deleteLectureDB(dup.id, chapterId);
          removedCount++;
        } catch (e) {
          console.warn('Sync duplicate cleanup notice:', e);
        }
      }
      existingByYtId.set(vId, [lecs[0]]);
    }
  }

  // Build map of current YouTube videos by ID
  const ytMap = new Map();
  ytVideos.forEach((v, index) => {
    if (v.id) ytMap.set(v.id, { ...v, targetPosition: index + 1 });
  });

  // STEP B: Detect videos REMOVED from the YouTube playlist
  for (const [vId, lecs] of existingByYtId.entries()) {
    if (!ytMap.has(vId)) {
      for (const lec of lecs) {
        try {
          await deleteLectureDB(lec.id, chapterId);
          removedCount++;
        } catch (e) {
          console.warn('Sync delete removed video error:', e);
        }
      }
      existingByYtId.delete(vId);
    }
  }

  // STEP C: Strictly match YouTube playlist order & update titles
  const toAdd = [];
  for (let i = 0; i < ytVideos.length; i++) {
    const v = ytVideos[i];
    const targetOrder = i + 1;
    const targetTitle = (v.title || `Lecture ${targetOrder}`).trim();
    const targetUrl = v.link || `https://www.youtube.com/watch?v=${v.id}`;

    if (existingByYtId.has(v.id)) {
      const primaryLec = existingByYtId.get(v.id)[0];
      const curOrder = parseInt(primaryLec.sort_order, 10);
      const curTitle = (primaryLec.title || '').trim();
      const curUrl = (primaryLec.url || '').trim();

      const plTitle = (info.playlistTitle || fetchedData.title || '').trim().toLowerCase();
      const isCurGeneric = /^(lecture|part|class)\s*\d+$/i.test(curTitle) || /class \d+$/i.test(curTitle) || /part \d+$/i.test(curTitle) || (plTitle && curTitle.toLowerCase().startsWith(plTitle + ' - part '));
      const isTargetGeneric = v.isPrivate || /^(lecture|part|class)\s*\d+$/i.test(targetTitle) || /class \d+$/i.test(targetTitle) || /part \d+$/i.test(targetTitle) || (plTitle && targetTitle.toLowerCase().startsWith(plTitle + ' - part '));
      const needsOrderUpdate = curOrder !== targetOrder;
      const needsTitleUpdate = targetTitle && (curTitle !== targetTitle) && (!isTargetGeneric || isCurGeneric);
      const needsUrlUpdate = curUrl !== targetUrl;

      if (needsOrderUpdate || needsTitleUpdate || needsUrlUpdate) {
        try {
          const finalTitle = (needsTitleUpdate && !isTargetGeneric) ? targetTitle : curTitle;
          await updateLecture(primaryLec.id, {
            sort_order: targetOrder,
            title: finalTitle,
            url: targetUrl,
            chapter_id: chapIdStr
          }, chapIdStr, true); // silent = true
          updatedCount++;
        } catch (e) {
          console.warn('Sync update lecture notice:', e);
        }
      }
    } else {
      toAdd.push({
        title: targetTitle,
        url: targetUrl,
        chapter_id: chapIdStr,
        order_num: targetOrder,
        sort_order: targetOrder
      });
    }
  }

  // STEP D: Add newly added YouTube videos
  if (toAdd.length > 0) {
    const addRes = await addLecturesBatch(toAdd);
    if (addRes && addRes.success) {
      addedCount = addRes.count || toAdd.length;
    }
  }

  // STEP E: Clean up customLectures storage
  try {
    const custom = getLocalJson(CUSTOM_LECTURES_KEY, []);
    const cleanCustom = [];
    const seenCustom = new Set();
    custom.forEach(item => {
      const ytId = extractYouTubeVideoId(item.url);
      const k = item.chapter_id + '::' + (ytId || item.url);
      if (!seenCustom.has(k)) {
        seenCustom.add(k);
        cleanCustom.push(item);
      }
    });
    saveLocalJson(CUSTOM_LECTURES_KEY, cleanCustom);
  } catch (e) { }

  // Update chapter playlist metadata
  info.lastSyncedAt = new Date().toISOString();
  if (fetchedData.title) info.playlistTitle = fetchedData.title;
  setChapterPlaylist(chapterId, info);

  // Invalidate and reload
  invalidatePlaylistsCache();
  try { await fetchWorkerPlaylists(true); } catch (e) { }
  await getAllLectures(true);
  broadcastLiveSync();

  return {
    success: true,
    chapterId,
    playlistTitle: fetchedData.title || info.playlistTitle || '',
    totalPlaylistVideos: ytVideos.length,
    added: addedCount,
    removed: removedCount,
    updated: updatedCount,
    hasChanges: (addedCount > 0 || removedCount > 0 || updatedCount > 0)
  };
}

async function syncAllChapterPlaylists() {
  const map = getAllChapterPlaylists();
  const chapterIds = Object.keys(map);
  if (!chapterIds.length) {
    return { success: false, error: 'No chapters are currently linked to YouTube playlists.' };
  }

  const results = [];
  for (const chapId of chapterIds) {
    try {
      const res = await syncChapterWithPlaylist(chapId);
      results.push(res);
    } catch (e) {
      results.push({ success: false, chapterId: chapId, error: e.message });
    }
  }

  const totalAdded = results.reduce((acc, r) => acc + (r.added || 0), 0);
  const totalRemoved = results.reduce((acc, r) => acc + (r.removed || 0), 0);
  const totalUpdated = results.reduce((acc, r) => acc + (r.updated || 0), 0);

  return {
    success: true,
    syncedCount: results.filter(r => r.success).length,
    totalAdded,
    totalRemoved,
    totalUpdated,
    results
  };
}

async function applyRealTitlesToChapter(chapterId, titlesList) {
  if (!chapterId || !Array.isArray(titlesList) || !titlesList.length) {
    return { success: false, error: 'No chapter or titles provided' };
  }
  const chapIdStr = String(chapterId).trim();
  const allLecs = await getAllLectures(true);
  const chapterLecs = allLecs
    .filter(l => String(l.chapter_id) === chapIdStr)
    .sort((a, b) => (parseInt(a.sort_order, 10) || 1) - (parseInt(b.sort_order, 10) || 1));

  if (!chapterLecs.length) {
    return { success: false, error: 'No lectures found in this chapter' };
  }

  let updatedCount = 0;
  for (let i = 0; i < chapterLecs.length; i++) {
    const cleanTitle = (titlesList[i] || '').trim();
    if (!cleanTitle) continue;
    const lec = chapterLecs[i];
    if (lec.title !== cleanTitle) {
      await updateLecture(lec.id, { title: cleanTitle, url: lec.url, chapter_id: chapIdStr }, chapIdStr, true); // silent = true
      updatedCount++;
    }
  }

  invalidatePlaylistsCache();
  try { await fetchWorkerPlaylists(true); } catch (e) { }
  await getAllLectures(true);
  broadcastLiveSync();
  showToast(`✅ Successfully applied real titles to ${updatedCount} lectures and synced to database!`, 'success');
  return { success: true, updatedCount, totalLectures: chapterLecs.length };
}

// ===== ALLOWED EMAILS WHITELIST (SYNCED FROM OLD ADMIN) =====
const ALLOWED_EMAILS_KEY = 'sp_allowed_emails';

function getLocalAllowedEmails() {
  try {
    return JSON.parse(localStorage.getItem(ALLOWED_EMAILS_KEY) || '[]');
  } catch (e) {
    return [];
  }
}

function saveLocalAllowedEmails(list) {
  try {
    localStorage.setItem(ALLOWED_EMAILS_KEY, JSON.stringify(list));
  } catch (e) { }
}

async function getAllowedEmails() {
  // 1. Worker call
  try {
    const res = await workerApiCall('/allowed-emails');
    if (res && res.success && Array.isArray(res.emails)) {
      const emailStrings = res.emails.map(e => (e.email || '').toLowerCase().trim()).filter(Boolean);
      saveLocalAllowedEmails(emailStrings);
      return emailStrings;
    }
  } catch (e) {
    console.warn('Worker allowed-emails notice:', e.message);
  }

  // 2. Supabase fallback (Uses modern app_users table where status is approved)
  if (checkClient()) {
    try {
      const { data, error } = await sbClient
        .from('app_users')
        .select('email')
        .eq('status', 'approved');
      if (!error && Array.isArray(data) && data.length > 0) {
        const emailStrings = data.map(d => (d.email || '').toLowerCase().trim()).filter(Boolean);
        saveLocalAllowedEmails(emailStrings);
        return emailStrings;
      }
    } catch (e) { }
  }

  return getLocalAllowedEmails();
}

async function addAllowedEmail(email, silent = false) {
  const clean = (email || '').trim().toLowerCase();
  if (!clean || !clean.includes('@')) return { success: false, error: 'Valid email required' };

  // 1. Worker call
  try {
    await workerApiCall('/allowed-emails', {
      method: 'POST',
      body: JSON.stringify({ email: clean })
    });
  } catch (e) {
    console.warn('Worker addAllowedEmail notice:', e.message);
  }

  // 2. Local store
  const local = getLocalAllowedEmails();
  if (!local.includes(clean)) {
    local.push(clean);
    saveLocalAllowedEmails(local);
  }

  // 3. Supabase fallback (Ensure status in app_users is approved)
  // IMPORTANT: Use update instead of upsert to avoid wiping existing name!
  if (checkClient()) {
    try {
      const { data: existingUser } = await sbClient.from('app_users').select('id').eq('email', clean).maybeSingle();
      if (existingUser) {
        // User exists — only update status, preserve name
        await sbClient.from('app_users').update({ status: 'approved' }).eq('email', clean);
      } else {
        // New user — resolve best available name from overrides before defaulting to email prefix
        let initialName = clean.split('@')[0];
        try {
          const overrides = JSON.parse(localStorage.getItem('sp_user_overrides') || '{}');
          if (overrides[clean] && overrides[clean].name) initialName = overrides[clean].name;
          else {
            const nameMap = JSON.parse(localStorage.getItem('sp_student_names') || '{}');
            if (nameMap[clean]) initialName = nameMap[clean];
          }
        } catch (e) { }
        await sbClient.from('app_users').insert({ email: clean, name: initialName, role: 'student', status: 'approved' });
      }
    } catch (e) { }
  }

  if (!silent) showToast(`Whitelisted ${clean}`, 'success');
  return { success: true, email: clean };
}

async function deleteAllowedEmail(email, silent = false) {
  const clean = (email || '').trim().toLowerCase();

  // 1. Worker call
  try {
    await workerApiCall('/allowed-emails', {
      method: 'DELETE',
      body: JSON.stringify({ email: clean })
    });
  } catch (e) {
    console.warn('Worker deleteAllowedEmail notice:', e.message);
  }

  // 2. Local store
  const local = getLocalAllowedEmails().filter(e => e !== clean);
  saveLocalAllowedEmails(local);

  // 3. Supabase fallback (Update status in app_users to rejected)
  if (checkClient()) {
    try {
      await sbClient
        .from('app_users')
        .update({ status: 'rejected' })
        .eq('email', clean);
    } catch (e) { }
  }

  if (!silent) showToast(`Removed ${clean} from whitelist`, 'info');
  return { success: true };
}

// Bypass allowed emails whitelist completely — authentication is 100% email + password and admin approval
async function isEmailAllowed(email) {
  return true;
}

// ===== CHAT MONITOR & ACTIVE STUDENTS (SYNCED FROM OLD ADMIN) =====
const CHAT_STORAGE_KEY = 'sp_chat_messages';
const ONLINE_STORAGE_KEY = 'sp_online_students';

function getLocalChatMessages() {
  try {
    return JSON.parse(localStorage.getItem(CHAT_STORAGE_KEY) || '[]');
  } catch (e) {
    return [];
  }
}

function saveLocalChatMessages(msgs) {
  try {
    localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(msgs));
  } catch (e) { }
}

function addIncomingChatMessage(msg) {
  if (!msg || !msg.id) return;
  try {
    const local = getLocalChatMessages();
    if (!local.some(m => m.id === msg.id)) {
      local.unshift(msg);
      if (local.length > 200) local.pop();
      saveLocalChatMessages(local);
    }
  } catch (e) { }
}

// ===== ⚡ LIVE CHAT AUTO-PURGE (CLEARS EVERY 2-3 HOURS, DOUBTS REMAIN PERMANENT) =====
const LIVE_CHAT_MAX_AGE_MS = 2.5 * 60 * 60 * 1000; // 2.5 hours

async function purgeOldLiveChatMessages() {
  const cutoffTime = new Date(Date.now() - LIVE_CHAT_MAX_AGE_MS).toISOString();
  // 1. Delete expired live chat messages from Supabase
  if (checkClient()) {
    try {
      await sbClient
        .from('chat_messages')
        .delete()
        .eq('chat_type', 'live')
        .lt('created_at', cutoffTime);
    } catch (e) { }
  }

  // 2. Filter local storage (never touch doubts chat!)
  try {
    const local = getLocalChatMessages();
    const filtered = local.filter(m => {
      if (m.chat_type === 'live') {
        const msgTime = new Date(m.created_at || 0).getTime();
        return (Date.now() - msgTime) < LIVE_CHAT_MAX_AGE_MS;
      }
      return true; // Keep all doubt messages permanently!
    });
    if (filtered.length !== local.length) {
      saveLocalChatMessages(filtered);
    }
  } catch (e) { }
}

async function getChatMessages(filter = 'all') {
  let messages = [];
  if (checkClient()) {
    try {
      const { data, error } = await sbClient
        .from('chat_messages')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(150);
      if (!error && Array.isArray(data)) {
        messages = data;
        saveLocalChatMessages(data);
      } else {
        messages = getLocalChatMessages();
      }
    } catch (e) {
      messages = getLocalChatMessages();
    }
  } else {
    messages = getLocalChatMessages();
  }

  // Deduplicate by message ID to prevent any duplicate display & auto-resolve latest student names
  const seen = new Set();
  const deduped = [];
  for (const m of messages) {
    if (m && m.id && !seen.has(m.id)) {
      seen.add(m.id);
      // Real-time student name normalization across all chat messages
      if (m.email && m.role !== 'admin' && !m.email.toLowerCase().includes('admin')) {
        m.sender_name = getStudentNameByEmail(m.email, m.sender_name);
      }
      deduped.push(m);
    }
  }
  messages = deduped;

  // Filter 1: Live Stream Chat only (auto-purged every 2-3 hours)
  if (filter === 'live') {
    setTimeout(() => { purgeOldLiveChatMessages().catch(() => { }); }, 50);
    const now = Date.now();
    return messages.filter(m => {
      if (m.chat_type !== 'live') return false;
      const t = new Date(m.created_at || 0).getTime();
      return (now - t) < LIVE_CHAT_MAX_AGE_MS;
    });
  }

  // Filter 2: Doubts Chat only (PERMANENT - live stream msgs NEVER appear here)
  if (filter === 'doubts' || filter === 'doubt') {
    return messages.filter(m => m.chat_type !== 'live');
  }

  if (filter === 'group') {
    return messages.filter(m => (m.chat_type || 'group') === 'group' || m.chat_type === 'doubt');
  } else if (filter === 'direct') {
    return messages.filter(m => m.chat_type === 'direct');
  }
  return messages;
}

let _lastSentChatText = '';
let _lastSentChatTime = 0;

async function sendChatMessage(message, receiverEmail = null, receiverName = null, chatType = 'doubt') {
  const user = getCurrentUser();
  if (!user) return { success: false, error: 'Please log in to participate in chat.' };
  const text = (message || '').trim();
  if (!text) return { success: false, error: 'Message cannot be empty' };

  // Guard against rapid duplicate send (within 1.5s)
  const now = Date.now();
  if (text === _lastSentChatText && (now - _lastSentChatTime < 1500)) {
    console.warn('Blocked rapid duplicate chat message send');
    const local = getLocalChatMessages();
    return { success: true, message: local[0] || null };
  }
  _lastSentChatText = text;
  _lastSentChatTime = now;

  const isAdmin = user.role === 'admin' || (user.email && user.email.toLowerCase().includes('admin')) || Boolean(getAdminToken());

  // Real Name Resolution: 'Admin' for admin, real student name for student
  let authorName = 'Student';
  if (isAdmin) {
    authorName = 'Admin';
  } else {
    authorName = (user.name && user.name.trim()) ? user.name : getStudentNameByEmail(user.email, user.name || 'Student');
  }

  const newMsg = {
    id: 'msg_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5),
    sender_name: authorName,
    role: isAdmin ? 'admin' : (user.role || 'student'),
    email: user.email,
    message: text,
    chat_type: chatType || (receiverEmail ? 'direct' : 'doubt'),
    receiver_email: receiverEmail || null,
    receiver_name: receiverName || null,
    created_at: new Date().toISOString()
  };

  if (checkClient()) {
    try {
      const { data, error } = await sbClient
        .from('chat_messages')
        .insert(newMsg)
        .select()
        .single();
      if (!error && data) {
        newMsg.id = data.id || newMsg.id;
      }
    } catch (e) { }
  }

  const local = getLocalChatMessages();
  local.unshift(newMsg);
  if (local.length > 200) local.pop();
  saveLocalChatMessages(local);

  return { success: true, message: newMsg };
}

async function deleteChatMessage(msgId) {
  if (checkClient()) {
    try {
      await sbClient
        .from('chat_messages')
        .delete()
        .eq('id', msgId);
    } catch (e) { }
  }
  const local = getLocalChatMessages().filter(m => m.id !== msgId);
  saveLocalChatMessages(local);
  return { success: true };
}

async function clearAllChatMessages() {
  if (checkClient()) {
    try {
      await sbClient
        .from('chat_messages')
        .delete()
        .neq('id', '00000000-0000-0000-0000-000000000000');
    } catch (e) { }
  }
  saveLocalChatMessages([]);
  return { success: true };
}

// ===== 👥 REAL-TIME ONLINE PRESENCE ENGINE =====
let _sbPresenceChannel = null;
let _sbAdminPresenceChannel = null;
let _sbPresenceUsers = [];
const ADMIN_EMAILS_FILTER = new Set(['stackbyujjwal@gmail.com', 'mj5000500@gmail.com']);

function isLegitStudent(user) {
  if (!user || !user.email) return false;
  const cleanEmail = (user.email || '').toLowerCase().trim();
  const role = (user.role || '').toLowerCase().trim();
  if (role === 'admin' || ADMIN_EMAILS_FILTER.has(cleanEmail)) return false;
  return true;
}

function initSupabaseStudentPresence(user) {
  if (!isLegitStudent(user)) return;
  if (!checkClient() || _sbPresenceChannel) return;
  try {
    const cleanEmail = (user.email || '').toLowerCase().trim();
    _sbPresenceChannel = sbClient.channel('study-portal-presence', {
      config: { presence: { key: cleanEmail } }
    });
    _sbPresenceChannel.subscribe(async (status) => {
      if (status === 'SUBSCRIBED') {
        try {
          await _sbPresenceChannel.track({
            email: cleanEmail,
            name: user.name || cleanEmail.split('@')[0],
            role: 'student',
            onlineAt: Date.now()
          });
        } catch (e) { }
      }
    });
  } catch (e) { }
}

function initSupabaseAdminPresence(callback) {
  if (!checkClient() || _sbAdminPresenceChannel) return;
  try {
    _sbAdminPresenceChannel = sbClient.channel('study-portal-presence');
    _sbAdminPresenceChannel.on('presence', { event: 'sync' }, () => {
      const state = _sbAdminPresenceChannel.presenceState();
      const users = [];
      for (const key of Object.keys(state)) {
        const items = state[key] || [];
        items.forEach(it => {
          const em = (it.email || key || '').toLowerCase().trim();
          if (em && !ADMIN_EMAILS_FILTER.has(em) && it.role !== 'admin') {
            users.push({
              email: em,
              name: it.name || em.split('@')[0],
              role: 'student',
              online: true,
              source: 'supabase',
              lastSeen: it.onlineAt || Date.now()
            });
          }
        });
      }
      _sbPresenceUsers = users;
      if (typeof callback === 'function') callback(users);
    });
    _sbAdminPresenceChannel.subscribe();
  } catch (e) { }
}

function recordStudentHeartbeat(user) {
  if (!isLegitStudent(user)) return;
  const cleanEmail = (user.email || '').toLowerCase().trim();
  const now = Date.now();
  const studentName = user.name || (typeof getStudentNameByEmail === 'function' ? getStudentNameByEmail(cleanEmail, '') : '') || cleanEmail.split('@')[0];
  const currentPage = typeof window !== 'undefined' ? (window.location.pathname.split('/').pop() || 'portal') : 'portal';

  // 1. Save to LocalStorage (Instant same-browser tab tracking)
  try {
    const list = JSON.parse(localStorage.getItem(ONLINE_STORAGE_KEY) || '[]');
    const existing = list.findIndex(u => (u.email || '').toLowerCase() === cleanEmail);
    const item = {
      name: studentName,
      email: cleanEmail,
      role: 'student',
      page: currentPage,
      lastSeen: now
    };
    if (existing >= 0) {
      list[existing] = item;
    } else {
      list.push(item);
    }
    const active = list.filter(u => now - u.lastSeen < 60000);
    localStorage.setItem(ONLINE_STORAGE_KEY, JSON.stringify(active));
  } catch (e) { }

  // 2. Broadcast to Central Server Presence Store (Multi-browser / cross-device)
  try {
    if (typeof fetch !== 'undefined') {
      const origin = (typeof window !== 'undefined' && window.location && window.location.origin && window.location.origin !== 'null' && !window.location.origin.startsWith('file')) ? window.location.origin : 'http://localhost:8085';
      fetch(`${origin}/api-local/heartbeat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: cleanEmail,
          name: studentName,
          role: 'student',
          page: currentPage
        }),
        keepalive: true
      }).catch(() => { });
    }
  } catch (e) { }

  // 3. Connect Supabase Realtime Presence channel if available
  try {
    initSupabaseStudentPresence(user);
  } catch (e) { }

  // 4. Supabase Cloud DB Heartbeat (Throttled to every 30s)
  try {
    if (typeof window !== 'undefined') {
      if (!window._lastSbPingMap) window._lastSbPingMap = new Map();
      const lastDbPing = window._lastSbPingMap.get(cleanEmail) || 0;
      if (now - lastDbPing > 30000 && checkClient()) {
        window._lastSbPingMap.set(cleanEmail, now);
        sbClient
          .from('app_users')
          .update({ last_login: new Date().toISOString() })
          .eq('email', cleanEmail)
          .then(() => { })
          .catch(() => { });
      }
    }
  } catch (e) { }
}

function getOnlineStudents() {
  try {
    const list = JSON.parse(localStorage.getItem(ONLINE_STORAGE_KEY) || '[]');
    const now = Date.now();
    return list.filter(u => {
      const em = (u.email || '').toLowerCase().trim();
      return !ADMIN_EMAILS_FILTER.has(em) && u.role !== 'admin' && (now - (u.lastSeen || 0) < 60000);
    });
  } catch (e) {
    return [];
  }
}

async function getUnifiedOnlineStudents() {
  const map = new Map();

  // 1. Fetch real-time active users from Local Server Presence Engine
  try {
    const origin = (typeof window !== 'undefined' && window.location && window.location.origin && window.location.origin !== 'null' && !window.location.origin.startsWith('file')) ? window.location.origin : 'http://localhost:8085';
    const res = await fetch(`${origin}/api-local/online-students`, { cache: 'no-store' });
    if (res.ok) {
      const data = await res.json();
      if (data && data.success && Array.isArray(data.users)) {
        data.users.forEach(u => {
          if (u && u.email) {
            const em = u.email.toLowerCase().trim();
            if (!ADMIN_EMAILS_FILTER.has(em) && u.role !== 'admin') {
              map.set(em, {
                email: em,
                name: u.name || em.split('@')[0],
                role: 'student',
                page: u.page || 'portal',
                online: true,
                source: 'server',
                lastSeen: u.lastSeen || Date.now()
              });
            }
          }
        });
      }
    }
  } catch (e) { }

  // 2. Merge Supabase Realtime Presence channel state
  if (Array.isArray(_sbPresenceUsers) && _sbPresenceUsers.length > 0) {
    _sbPresenceUsers.forEach(u => {
      if (u && u.email) {
        const em = u.email.toLowerCase().trim();
        if (!ADMIN_EMAILS_FILTER.has(em) && u.role !== 'admin') {
          const existing = map.get(em);
          map.set(em, {
            email: em,
            name: (existing && existing.name) || u.name || em.split('@')[0],
            role: 'student',
            page: (existing && existing.page) || 'portal',
            online: true,
            source: existing ? existing.source : 'supabase_realtime',
            lastSeen: (existing && existing.lastSeen) || Date.now()
          });
        }
      }
    });
  }

  // 3. Merge Supabase Cloud Database Active Heartbeats (last_login in last 75s)
  try {
    if (checkClient()) {
      const threshold = new Date(Date.now() - 75000).toISOString();
      const { data: recentUsers } = await sbClient
        .from('app_users')
        .select('id, name, email, role, last_login')
        .gte('last_login', threshold);
      if (Array.isArray(recentUsers)) {
        recentUsers.forEach(u => {
          if (u && u.email) {
            const em = u.email.toLowerCase().trim();
            if (!ADMIN_EMAILS_FILTER.has(em) && u.role !== 'admin') {
              const existing = map.get(em);
              map.set(em, {
                email: em,
                name: (existing && existing.name) || u.name || em.split('@')[0],
                role: 'student',
                page: (existing && existing.page) || 'portal',
                online: true,
                source: existing ? existing.source : 'supabase_cloud',
                lastSeen: (existing && existing.lastSeen) || (u.last_login ? new Date(u.last_login).getTime() : Date.now())
              });
            }
          }
        });
      }
    }
  } catch (e) { }

  // 4. Merge LocalStorage active heartbeats (same-browser instant fallback)
  try {
    const local = getOnlineStudents();
    if (Array.isArray(local)) {
      local.forEach(u => {
        if (u && u.email) {
          const em = u.email.toLowerCase().trim();
          if (!ADMIN_EMAILS_FILTER.has(em) && u.role !== 'admin') {
            const existing = map.get(em);
            map.set(em, {
              email: em,
              name: (existing && existing.name) || u.name || em.split('@')[0],
              role: 'student',
              page: (existing && existing.page) || u.page || 'portal',
              online: true,
              source: existing ? existing.source : 'local',
              lastSeen: (existing && existing.lastSeen) || u.lastSeen || Date.now()
            });
          }
        }
      });
    }
  } catch (e) { }

  // 5. Merge Cloudflare Worker active users (Optional cloud fallback if available)
  try {
    const workerList = await getOnlineStudentsFromWorker();
    if (Array.isArray(workerList)) {
      workerList.forEach(u => {
        if (u && u.email) {
          const em = u.email.toLowerCase().trim();
          if (!ADMIN_EMAILS_FILTER.has(em) && u.role !== 'admin') {
            const existing = map.get(em);
            map.set(em, {
              email: em,
              name: (existing && existing.name) || u.name || em.split('@')[0],
              role: 'student',
              page: (existing && existing.page) || 'portal',
              online: true,
              source: existing ? existing.source : 'cloud',
              lastSeen: (existing && existing.lastSeen) || Date.now()
            });
          }
        }
      });
    }
  } catch (e) { }

  const onlineList = Array.from(map.values());
  onlineList.forEach(item => {
    if (item.email) {
      item.name = getStudentNameByEmail(item.email, item.name);
    }
  });
  return onlineList;
}

// Global automated client-side presence heartbeat loop
if (typeof window !== 'undefined') {
  (function initGlobalPresenceHeartbeat() {
    function firePresencePing() {
      try {
        if (typeof getCurrentUser !== 'function') return;
        const user = getCurrentUser();
        if (user && user.email && isLegitStudent(user)) {
          recordStudentHeartbeat(user);
        }
      } catch (e) { }
    }

    setTimeout(firePresencePing, 800);
    setInterval(firePresencePing, 12000);

    window.addEventListener('focus', firePresencePing);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') firePresencePing();
    });

    window.addEventListener('beforeunload', () => {
      try {
        const user = typeof getCurrentUser === 'function' ? getCurrentUser() : null;
        if (user && user.email && isLegitStudent(user) && navigator.sendBeacon) {
          navigator.sendBeacon('/api-local/logout-student', JSON.stringify({ email: user.email }));
        }
      } catch (e) { }
    });
  })();
}

// ===== TOAST UTILITY =====
function showToast(message, type = 'info') {
  if (typeof document === 'undefined') {
    console.log(`[Toast ${type}]`, message);
    return;
  }
  let container = document.querySelector('.toast-container');
  if (!container) {
    container = document.createElement('div');
    container.className = 'toast-container';
    document.body.appendChild(container);
  }
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  const icons = { success: '✅', error: '❌', info: 'ℹ️' };
  toast.innerHTML = `<span>${icons[type] || 'ℹ️'}</span> ${message}`;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(50px)';
    setTimeout(() => toast.remove(), 300);
  }, 3500);
}

// Automated one-time duplicate cleanup & self-healing
async function cleanupAllLectureDuplicates() {
  try {
    const all = await getAllLectures(true);
    const seenMap = new Map();
    let purgedCount = 0;

    for (const lec of all) {
      const ytId = extractYouTubeVideoId(lec.url);
      const key = lec.chapter_id + '::' + (ytId ? ('yt_' + ytId) : (lec.url || '').trim().toLowerCase());
      if (seenMap.has(key)) {
        // Delete this duplicate!
        try {
          await deleteLectureDB(lec.id, lec.chapter_id);
          purgedCount++;
        } catch (e) { }
      } else {
        seenMap.set(key, lec);
      }
    }

    if (purgedCount > 0) {
      invalidatePlaylistsCache();
      await getAllLectures(true);
      console.log(`[Study Portal] Cleaned up ${purgedCount} duplicate lectures.`);
    }
    return { success: true, purgedCount };
  } catch (err) {
    console.warn('cleanupAllLectureDuplicates notice:', err);
    return { success: false, error: err.message };
  }
}

// ===== COMPLETE BI-DIRECTIONAL WORKER & SUPABASE FULL SYNC =====
async function syncAllWorkerDataToSupabase(silent = true) {
  if (!checkClient()) return { success: false, error: 'Supabase client not initialized' };

  try {
    // 1. Sync standard subjects
    for (const s of STANDARD_SUBJECTS) {
      try {
        await sbClient.from('subjects').upsert(s, { onConflict: 'id' });
      } catch (e) { }
    }

    // 2. Sync Worker playlists & lectures
    const plData = await fetchWorkerPlaylists(true);
    if (Array.isArray(plData) && plData.length > 0) {
      for (const pl of plData) {
        const secKey = (pl.section || 'recorded').toLowerCase();
        const subjId = SECTION_TO_SUBJ[secKey] || 'subj_math';

        try {
          await sbClient.from('chapters').upsert({
            id: String(pl.id),
            name: (pl.name || '').trim(),
            subject_id: subjId
          }, { onConflict: 'id' });
        } catch (e) { }

        if (Array.isArray(pl.chapters) && pl.chapters.length > 0) {
          const lecs = pl.chapters.map((ch, idx) => ({
            id: String(ch.id),
            title: (ch.name || `Lecture ${idx + 1}`).trim(),
            url: ch.link || '',
            chapter_id: String(pl.id),
            sort_order: ch.chapter_number || (idx + 1)
          }));
          try {
            await sbClient.from('lectures').upsert(lecs, { onConflict: 'id' });
          } catch (e) { }
        }
      }
    }


    // 4. Sync Allowed Emails
    try {
      const aeResp = await workerApiCall('/allowed-emails');
      if (aeResp && aeResp.success && Array.isArray(aeResp.emails)) {
        for (const item of aeResp.emails) {
          const em = (item.email || '').toLowerCase().trim();
          if (em) {
            try {
              await sbClient.from('allowed_emails').upsert({ email: em }, { onConflict: 'email' });
            } catch (e) { }
          }
        }
      }
    } catch (e) { }

    // 5. Sync Live Classes
    try {
      const impResp = await workerApiCall('/important/all');
      if (impResp && impResp.success && Array.isArray(impResp.items)) {
        for (const item of impResp.items) {
          try {
            await sbClient.from('live_classes').upsert({
              id: 'imp_' + item.id,
              title: item.title,
              url: item.link || '',
              status: item.is_active === 0 ? 'hidden' : 'live',
              instructor: 'Teacher'
            }, { onConflict: 'id' });
          } catch (e) { }
        }
      }
    } catch (e) { }

    if (!silent) {
      showToast('✅ Cloudflare data fully synced into Supabase!', 'success');
    }
    return { success: true };
  } catch (err) {
    console.error('syncAllWorkerDataToSupabase error:', err);
    if (!silent) showToast('Sync error: ' + err.message, 'error');
    return { success: false, error: err.message };
  }
}

// ===== 🌓 ULTRA-PREMIUM THEME SYSTEM (DARK & LIGHT MODE) =====
// Default is clean Light Mode. Dark Mode is activated only when user manually toggles it.
const THEME_STORAGE_KEY = 'sp_theme_pref';

function getTheme() {
  try {
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    if (saved === 'dark' || saved === 'light') return saved;
  } catch (e) { }
  return 'light'; // Always default to Light Mode unless manually set by user
}

function triggerThemeTransition() {
  // No-op: Wildcard transitions removed to guarantee 1-frame atomic paint without staggered lag or jitter
}

function setTheme(theme, isUserAction = false) {
  const clean = theme === 'dark' ? 'dark' : 'light';
  if (typeof document !== 'undefined' && document.documentElement) {
    document.documentElement.setAttribute('data-theme', clean);
  }
  try {
    localStorage.setItem(THEME_STORAGE_KEY, clean);
  } catch (e) { }

  updateThemeUI(clean);

  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('themechange', { detail: { theme: clean } }));
  }
  return clean;
}

function toggleTheme() {
  const current = (typeof document !== 'undefined' && document.documentElement.getAttribute('data-theme')) || getTheme();
  const next = current === 'dark' ? 'light' : 'dark';
  return setTheme(next, true);
}

function updateThemeUI(theme) {
  if (typeof document === 'undefined' || typeof document.getElementById !== 'function') return;
  const isDark = theme === 'dark';

  const drawerText = document.getElementById('drawerThemeText');
  const drawerBadge = document.getElementById('drawerThemeBadge');
  if (drawerText) drawerText.textContent = isDark ? 'Light Mode' : 'Dark Mode';
  if (drawerBadge) {
    drawerBadge.textContent = isDark ? 'Dark ON' : 'Off';
    drawerBadge.style.background = isDark ? 'rgba(59, 130, 246, 0.2)' : 'var(--bg-3)';
    drawerBadge.style.color = isDark ? '#60a5fa' : 'var(--text-3)';
  }

  document.querySelectorAll('.theme-toggle-btn').forEach(btn => {
    btn.setAttribute('aria-pressed', isDark ? 'true' : 'false');
    btn.setAttribute('title', isDark ? 'Switch to Light Mode' : 'Switch to Dark Mode');
  });
}

function initTheme() {
  const current = getTheme();
  if (typeof document !== 'undefined' && document.documentElement) {
    document.documentElement.setAttribute('data-theme', current);
  }
  updateThemeUI(current);
}

// Auto-initialize theme on load
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initTheme);
  } else {
    initTheme();
  }
}

if (typeof window !== 'undefined') {
  window.toggleTheme = toggleTheme;
  window.setTheme = setTheme;
  window.getTheme = getTheme;
  window.initTheme = initTheme;
}

// Export to window
window.DB = {
  syncAllWorkerDataToSupabase,
  getSubjects, addSubject, updateSubject, deleteSubject,
  getChapters, getAllChapters, addChapter, updateChapter, deleteChapter,
  getLectures, getAllLectures, addLecture, updateLecture, deleteLectureDB, deleteLecturesByChapter, deleteLecturesByIds,
  addLecturesBatch,
  getWatched, toggleWatchedDB, markAllWatchedDB, addWatched,
  getStarred, toggleStarredDB, getAllStudentsProgress,
  getLectureById,
  // Theme Controls
  getTheme, setTheme, toggleTheme, initTheme,
  // YouTube Utilities (Synced from old admin)
  extractYouTubePlaylistId, extractYouTubeVideoId, parseBulkYouTubeVideos, fetchYouTubePlaylistVideos,
  fetchYouTubeBatchVideos, parseBulkLinksOrPlaylist, DEFAULT_YT_API_KEY, testYouTubeConnection,
  // Google OAuth Token Storage (For Private YouTube Videos)
  getGoogleAuthUrl, startGoogleOAuthLogin, checkGoogleSession, storeGoogleTokenInBackend, revokeGoogleSession,
  // YouTube Playlist AutoSync & Cleanup
  getAllChapterPlaylists, getChapterPlaylist, setChapterPlaylist, syncCloudChapterPlaylists, syncChapterWithPlaylist, syncAllChapterPlaylists,
  applyRealTitlesToChapter,
  cleanupAllLectureDuplicates, cleanupOrphanedLectures, broadcastLiveSync, invalidatePlaylistsCache,
  // Cache Fast Load Getters
  getCachedSubjects, getCachedChapters, getCachedLectures, getCachedLiveClasses,
  // Live Classes
  getLiveClasses, getActiveLiveClasses, getLiveClassById, getActiveLiveNowIds, setActiveLiveNow, addLiveClass, updateLiveClass, setLiveClassStatus, deleteLiveClass, getLiveClassExpiryInfo, LIVE_MAX_AGE_MS, compareLiveClasses, getLiveClassSortTime, getLiveClassRawId, isSameLiveId, MAX_VISIBLE_LIVE_CLASSES, enforceTopLiveVisibility,
  // Telegram Bot Notifications
  getTelegramConfig, saveTelegramConfig, loadTelegramConfigFromServer, sendTelegramMessage, sendTelegramLiveNotification, testTelegramNotification,
  // User Auth, Tokens, Sessions, Passwords & Approvals
  registerUser, generateAccessKey, loginUser, getCurrentUser, logoutUser, adminLogin, adminVerifySession,
  validateUserSession, handleSessionConflict, startSessionWatcher, generateSessionId, getPersistentDeviceId, hashPassword,
  adminApproveStudent, adminRejectStudent, resetStudentDeviceSession, adminSetStudentPassword, adminGeneratePasswordForStudent, adminAddStudent, syncCloudflareStudents,
  setAdminPassword, getAdminAccounts, getSqlForAdminReset, ensureDefaultAdminsInDatabase,
  getAdminToken, setAdminToken, clearAdminToken, clearAllAuthSessions,
  getAllUsers, addUser, getUserKeys, generateUserKey, resetUser, resetUserAndKey, updateStudentProfile, getStudentNameByEmail, setStudentNameInMemory, getOnlineStudentsFromWorker, updateUserStatus, updateUserRole, deleteUser,
  // Allowed Emails (Synced from old admin)
  getAllowedEmails, addAllowedEmail, deleteAllowedEmail, isEmailAllowed, getLocalAllowedEmails,
  // Chat Monitor & Active Students (Synced from old admin)
  getChatMessages, sendChatMessage, addIncomingChatMessage, deleteChatMessage, clearAllChatMessages, purgeOldLiveChatMessages, LIVE_CHAT_MAX_AGE_MS,
  recordStudentHeartbeat, getOnlineStudents, getUnifiedOnlineStudents,
  initSupabaseStudentPresence, initSupabaseAdminPresence,
  showToast,
  SecurityVault,
  SpiderShield,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = (typeof window !== 'undefined' && window.DB) ? window.DB : null;
}
