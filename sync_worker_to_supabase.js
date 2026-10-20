// ==============================================================================
// 🕷️ SPIDER CLASSES - CLOUDFLARE WORKER TO SUPABASE FULL SYNC SCRIPT
// Run anytime via: node sync_worker_to_supabase.js
// ==============================================================================

const https = require('https');

const WORKER_URL = 'https://video-play-api.newstreamcp.workers.dev/api';
const SUPABASE_URL = 'https://wpfiukvawwmevgkfqbdz.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndwZml1a3Zhd3dtZXZna2ZxYmR6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE5MTI5MDUsImV4cCI6MjEwNzQ4ODkwNX0.qS5iNiEQo6-O8emH4nnhzek_ykW-DAazu4m83uoS8Ro';

function workerGet(path) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${WORKER_URL}${path}`);
    const req = https.request(url, {
      method: 'GET',
      headers: { 'Origin': 'http://localhost:8085' }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch(e) { resolve(data); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function sbRequest(table, method, body = null, params = '') {
  return new Promise((resolve, reject) => {
    const url = new URL(`${SUPABASE_URL}/rest/v1/${table}${params}`);
    const req = https.request(url, {
      method: method,
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates,return=representation'
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch(e) {
          resolve({ status: res.statusCode, data });
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

const SECTION_TO_SUBJ = {
  'recorded': 'subj_math',
  'math': 'subj_math',
  'reasoning': 'subj_reasoning',
  'quant': 'subj_quant',
  'computer': 'subj_computer',
  'english': 'subj_english'
};

const STANDARD_SUBJECTS = [
  { id: 'subj_math', name: 'Math', icon: '📐', color: 'blue' },
  { id: 'subj_reasoning', name: 'Reasoning', icon: '🧠', color: 'purple' },
  { id: 'subj_quant', name: 'Quant', icon: '🔢', color: 'emerald' },
  { id: 'subj_computer', name: 'Computer', icon: '💻', color: 'cyan' },
  { id: 'subj_english', name: 'English', icon: '📖', color: 'amber' }
];

(async () => {
  console.log('🚀 Starting full sync: Cloudflare Worker -> Supabase...');

  // 1. Sync Subjects
  console.log('\n--- 1. Syncing Standard Subjects to Supabase ---');
  for (const s of STANDARD_SUBJECTS) {
    const res = await sbRequest('subjects', 'POST', s);
    console.log(`  Subject "${s.name}": status ${res.status}`);
  }

  // 2. Fetch Playlists & Chapters from Cloudflare Worker
  console.log('\n--- 2. Fetching Playlists & Chapters from Cloudflare Worker ---');
  const plResp = await workerGet('/playlists');
  const playlists = plResp?.playlists || [];
  console.log(`Fetched ${playlists.length} playlists from Cloudflare Worker.`);

  let totalLecs = 0;
  for (const pl of playlists) {
    const secKey = (pl.section || 'recorded').toLowerCase();
    const subjId = SECTION_TO_SUBJ[secKey] || 'subj_math';
    
    // Upsert Chapter
    const chapData = {
      id: String(pl.id),
      name: (pl.name || '').trim(),
      subject_id: subjId
    };
    const cRes = await sbRequest('chapters', 'POST', chapData);
    console.log(`  Chapter "${chapData.name}" (${chapData.id}): status ${cRes.status}`);

    // Upsert Lectures in this chapter
    if (Array.isArray(pl.chapters) && pl.chapters.length > 0) {
      const lecsToInsert = pl.chapters.map((ch, idx) => ({
        id: String(ch.id),
        title: (ch.name || `Lecture ${idx + 1}`).trim(),
        url: ch.link || '',
        chapter_id: String(pl.id),
        sort_order: ch.chapter_number || (idx + 1)
      }));

      totalLecs += lecsToInsert.length;
      const lRes = await sbRequest('lectures', 'POST', lecsToInsert);
      console.log(`    -> Upserted ${lecsToInsert.length} lectures: status ${lRes.status}`);
    }
  }

  // 3. Fetch Users from Worker
  console.log('\n--- 3. Fetching Students/Users from Cloudflare Worker ---');
  let usersList = [];
  try {
    const uResp = await workerGet('/users');
    if (uResp && uResp.success && Array.isArray(uResp.users)) {
      usersList = uResp.users;
    }
  } catch (e) {
    console.warn('Worker /users error:', e.message);
  }
  console.log(`Fetched ${usersList.length} users from Cloudflare Worker.`);
  // Fetch existing Supabase users first
  const { data: dbExistingUsers } = await sbRequest('app_users', 'GET', null, '?select=id,name,email');
  const existingUsersMap = new Map((Array.isArray(dbExistingUsers) ? dbExistingUsers : []).map(x => [(x.email || '').toLowerCase().trim(), x]));

  for (const u of usersList) {
    if (!u.email) continue;
    const cleanEmail = u.email.toLowerCase().trim();
    const existing = existingUsersMap.get(cleanEmail);
    if (!existing) {
      const userData = {
        name: u.name || cleanEmail.split('@')[0],
        email: cleanEmail,
        role: u.role || 'student',
        status: u.status || 'approved'
      };
      const uRes = await sbRequest('app_users', 'POST', userData);
      console.log(`  Inserted User "${userData.email}": status ${uRes.status}`);
    } else {
      console.log(`  Kept existing User "${cleanEmail}" (Name: "${existing.name}")`);
    }
  }

  // 4. Fetch Allowed Emails from Worker
  console.log('\n--- 4. Fetching Allowed Emails from Cloudflare Worker ---');
  let allowedEmails = [];
  try {
    const aeResp = await workerGet('/allowed-emails');
    if (aeResp && aeResp.success && Array.isArray(aeResp.emails)) {
      allowedEmails = aeResp.emails.map(e => (e.email || '').toLowerCase().trim()).filter(Boolean);
    }
  } catch (e) {
    console.warn('Worker /allowed-emails error:', e.message);
  }
  console.log(`Fetched ${allowedEmails.length} allowed emails.`);
  for (const email of allowedEmails) {
    const aeRes = await sbRequest('allowed_emails', 'POST', { email });
    console.log(`  Allowed email "${email}": status ${aeRes.status}`);
  }

  // 5. Fetch Live/Important Classes from Worker
  console.log('\n--- 5. Fetching Live Classes from Cloudflare Worker ---');
  let impClasses = [];
  try {
    const impResp = await workerGet('/important/all');
    if (impResp && impResp.success && Array.isArray(impResp.items)) {
      impClasses = impResp.items;
    }
  } catch (e) {
    console.warn('Worker /important/all error:', e.message);
  }
  console.log(`Fetched ${impClasses.length} live classes from Worker.`);
  for (const item of impClasses) {
    const liveData = {
      id: 'imp_' + item.id,
      title: item.title,
      url: item.link || '',
      status: item.is_active === 0 ? 'hidden' : 'live',
      instructor: 'Teacher'
    };
    const lRes = await sbRequest('live_classes', 'POST', liveData);
    console.log(`  Live class "${item.title}": status ${lRes.status}`);
  }

  console.log('\n🎉 FULL SYNC COMPLETE!');
  console.log(`Total Playlists: ${playlists.length}, Total Lectures: ${totalLecs}, Users: ${usersList.length}, Allowed Emails: ${allowedEmails.length}`);
})();
