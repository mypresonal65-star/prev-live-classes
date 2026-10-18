-- ==============================================================================
-- 🕷️ SPIDER CLASSES - COMPLETE DATABASE SCHEMA (SUPABASE)
-- Email + Password Authentication, Registration Approvals, Single-Device Session
-- Run this script in Supabase -> SQL Editor -> Click RUN
-- ==============================================================================

-- 1. Enable pgcrypto for UUID & cryptographic hashing
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- 2. Clean slate: Drop legacy tables & functions safely
DROP TABLE IF EXISTS allowed_emails CASCADE;
DROP TABLE IF EXISTS chat_messages CASCADE;
DROP TABLE IF EXISTS app_admin_sessions CASCADE;
DROP TABLE IF EXISTS app_users CASCADE;
DROP TABLE IF EXISTS live_classes CASCADE;
DROP TABLE IF EXISTS starred CASCADE;
DROP TABLE IF EXISTS watched CASCADE;
DROP TABLE IF EXISTS lectures CASCADE;
DROP TABLE IF EXISTS chapters CASCADE;
DROP TABLE IF EXISTS subjects CASCADE;

DROP FUNCTION IF EXISTS admin_login(TEXT) CASCADE;
DROP FUNCTION IF EXISTS admin_verify_session(TEXT) CASCADE;
DROP FUNCTION IF EXISTS admin_logout(TEXT) CASCADE;
DROP FUNCTION IF EXISTS verify_user_login(TEXT, TEXT, TEXT) CASCADE;
DROP FUNCTION IF EXISTS verify_user_session(UUID, TEXT) CASCADE;
DROP FUNCTION IF EXISTS invalidate_user_session(UUID, TEXT) CASCADE;
DROP FUNCTION IF EXISTS admin_set_user_status(TEXT, UUID, TEXT) CASCADE;
DROP FUNCTION IF EXISTS admin_set_user_role(TEXT, UUID, TEXT) CASCADE;
DROP FUNCTION IF EXISTS is_valid_admin_token(TEXT) CASCADE;

-- ==============================================================================
-- 📋 CORE TABLES
-- ==============================================================================

-- 1. SUBJECTS (Math, Reasoning, Quant, Computer, English, Science)
CREATE TABLE subjects (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  name TEXT NOT NULL,
  icon TEXT DEFAULT '📚',
  color TEXT DEFAULT 'blue',
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 2. CHAPTERS (Modules within a subject)
CREATE TABLE chapters (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  name TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 3. LECTURES (Video lectures - HLS .m3u8, YouTube, Cloudflare Stream)
CREATE TABLE lectures (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  chapter_id TEXT NOT NULL,
  sort_order INT DEFAULT 1,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 4. WATCHED (Stores student watched lecture tracking)
CREATE TABLE watched (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  lecture_id TEXT UNIQUE NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 5. STARRED (Bookmarked lectures by students)
CREATE TABLE starred (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  lecture_id TEXT UNIQUE NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 6. LIVE CLASSES & STREAM CONFIGS (Real-time live class broadcasts)
CREATE TABLE live_classes (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  title TEXT NOT NULL,
  url TEXT NOT NULL DEFAULT '',
  status TEXT DEFAULT 'live',             -- 'live' | 'hidden' | 'config'
  subject_id TEXT,
  scheduled_at TIMESTAMPTZ DEFAULT now(),
  instructor TEXT DEFAULT 'Teacher',
  description TEXT DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 7. CHAT MESSAGES (Live chat & Student Doubt discussions)
CREATE TABLE chat_messages (
  id TEXT PRIMARY KEY DEFAULT ('msg_' || gen_random_uuid()::text),
  sender_name TEXT NOT NULL,
  role TEXT DEFAULT 'student',
  email TEXT,
  message TEXT NOT NULL,
  chat_type TEXT DEFAULT 'group',          -- 'group' | 'doubt' | 'direct'
  receiver_email TEXT,
  receiver_name TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 8. APP USERS (Email + Password Student & Admin Accounts)
-- Self-registered students have status: 'pending' until Admin approves!
CREATE TABLE app_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL DEFAULT 'Student',
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT,
  role TEXT NOT NULL DEFAULT 'student',    -- 'student' | 'admin'
  status TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'approved' | 'rejected'
  current_session_id TEXT,                 -- Single-device session protection
  last_login TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 9. ADMIN SESSIONS (Single-device cryptographic admin token)
CREATE TABLE app_admin_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token TEXT UNIQUE NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ==============================================================================
-- ⚡ PERFORMANCE INDEXES
-- ==============================================================================
CREATE INDEX idx_chapters_subj ON chapters(subject_id);
CREATE INDEX idx_lectures_chap ON lectures(chapter_id);
CREATE INDEX idx_lectures_order ON lectures(chapter_id, sort_order);
CREATE INDEX idx_watched_lec ON watched(lecture_id);
CREATE INDEX idx_starred_lec ON starred(lecture_id);
CREATE INDEX idx_live_created ON live_classes(created_at DESC);
CREATE INDEX idx_chat_created ON chat_messages(created_at DESC);
CREATE INDEX idx_users_email ON app_users(lower(email));
CREATE INDEX idx_users_status ON app_users(status);
CREATE INDEX idx_admin_token ON app_admin_sessions(token);

-- ==============================================================================
-- 🔒 ROW LEVEL SECURITY (RLS) POLICIES
-- ==============================================================================
ALTER TABLE subjects ENABLE ROW LEVEL SECURITY;
ALTER TABLE chapters ENABLE ROW LEVEL SECURITY;
ALTER TABLE lectures ENABLE ROW LEVEL SECURITY;
ALTER TABLE watched ENABLE ROW LEVEL SECURITY;
ALTER TABLE starred ENABLE ROW LEVEL SECURITY;
ALTER TABLE live_classes ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_admin_sessions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all on subjects" ON subjects FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all on chapters" ON chapters FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all on lectures" ON lectures FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all on watched" ON watched FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all on starred" ON starred FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all on live_classes" ON live_classes FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all on chat_messages" ON chat_messages FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all on app_users" ON app_users FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all on app_admin_sessions" ON app_admin_sessions FOR ALL USING (true) WITH CHECK (true);

-- ==============================================================================
-- 📡 REALTIME SUBSCRIPTION ENABLER
-- ==============================================================================
DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE live_classes;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE chat_messages;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE app_users;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

-- ==============================================================================
-- 👑 SEED ADMINISTRATOR ACCOUNTS IN DATABASE
-- 1st Admin: stackbyujjwal@gmail.com | Password: @stackbyspider
-- 2nd Admin: mj5000500@gmail.com        | Password: rohit3350
-- ==============================================================================

-- Clean up any typo or obsolete dummy accounts if they exist in database
DELETE FROM app_users 
WHERE lower(email) IN ('stackbyujjwal@gamil.com', 'stasckbyujjwal@gmail.com', 'admin@spiderclasses.com', 'admain@stackbyujjwal.com');

-- 1. Admin 1: stackbyujjwal@gmail.com
INSERT INTO app_users (name, email, password_hash, role, status)
VALUES (
  'Admin',
  'stackbyujjwal@gmail.com',
  encode(digest('@stackbyspider:spider_classes_salt_2026', 'sha256'), 'hex'),
  'admin',
  'approved'
)
ON CONFLICT (email) DO UPDATE 
SET password_hash = EXCLUDED.password_hash,
    name = 'Admin',
    role = 'admin',
    status = 'approved';

-- 2. Admin 2: mj5000500@gmail.com
INSERT INTO app_users (name, email, password_hash, role, status)
VALUES (
  'Admin',
  'mj5000500@gmail.com',
  encode(digest('rohit3350:spider_classes_salt_2026', 'sha256'), 'hex'),
  'admin',
  'approved'
)
ON CONFLICT (email) DO UPDATE 
SET password_hash = EXCLUDED.password_hash,
    name = 'Admin',
    role = 'admin',
    status = 'approved';

-- ==============================================================================
-- 🔑 RESET ADMIN PASSWORD HELPER (Run in Supabase SQL Editor anytime)
-- Example: SELECT reset_admin_password('stackbyujjwal@gmail.com', '@myNewPass123');
-- Or SQL: UPDATE app_users SET password_hash = encode(digest('NEW_PASS:spider_classes_salt_2026', 'sha256'), 'hex') WHERE email = 'stackbyujjwal@gmail.com';
-- ==============================================================================
CREATE OR REPLACE FUNCTION reset_admin_password(p_email TEXT, p_new_password TEXT)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_hash TEXT;
  v_clean_email TEXT;
BEGIN
  v_clean_email := lower(trim(p_email));
  v_hash := encode(digest(p_new_password || ':spider_classes_salt_2026', 'sha256'), 'hex');

  UPDATE app_users
  SET password_hash = v_hash,
      role = 'admin',
      status = 'approved'
  WHERE lower(email) = v_clean_email;

  IF FOUND THEN
    RETURN jsonb_build_object('success', true, 'message', 'Admin password successfully updated in database for ' || v_clean_email);
  ELSE
    INSERT INTO app_users (name, email, password_hash, role, status)
    VALUES (p_email, v_clean_email, v_hash, 'admin', 'approved');
    RETURN jsonb_build_object('success', true, 'message', 'New admin account created in database for ' || v_clean_email);
  END IF;
END;
$$;

-- ==============================================================================
-- 🛡️ SECURITY & AUTH RPC FUNCTIONS
-- ==============================================================================

-- Helper: Check if admin token is valid and unexpired
CREATE OR REPLACE FUNCTION is_valid_admin_token(p_token TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF p_token IS NULL OR trim(p_token) = '' THEN
    RETURN FALSE;
  END IF;
  RETURN EXISTS (
    SELECT 1 FROM app_admin_sessions 
    WHERE token = p_token AND expires_at > now()
  );
END;
$$;

-- 1. Admin Login (Dynamically authenticates against app_users table where role = 'admin')
CREATE OR REPLACE FUNCTION admin_login(p_password TEXT)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_clean_pwd TEXT;
  v_hash TEXT;
  v_legacy_hash TEXT;
  v_admin RECORD;
  v_token TEXT;
BEGIN
  v_clean_pwd := trim(p_password);
  v_hash := encode(digest(v_clean_pwd || ':spider_classes_salt_2026', 'sha256'), 'hex');
  v_legacy_hash := encode(digest('ClassPlayer_Admin_Secure_Salt_2025_#x9' || v_clean_pwd, 'sha256'), 'hex');

  -- Look up matching admin account in database
  SELECT id, name, email, role INTO v_admin
  FROM app_users
  WHERE role = 'admin'
    AND (
      password_hash = v_hash
      OR password_hash = v_clean_pwd
      OR (lower(email) = 'stackbyujjwal@gmail.com' AND v_clean_pwd = '@stackbyspider')
      OR (lower(email) = 'mj5000500@gmail.com' AND v_clean_pwd = 'rohit3350')
    )
  LIMIT 1;

  IF FOUND THEN
    -- Invalidate expired admin sessions
    DELETE FROM app_admin_sessions WHERE expires_at < now();

    v_token := encode(gen_random_bytes(32), 'hex');
    INSERT INTO app_admin_sessions (token, expires_at)
    VALUES (v_token, now() + INTERVAL '12 hours');

    UPDATE app_users
    SET current_session_id = v_token,
        last_login = now()
    WHERE id = v_admin.id;

    RETURN jsonb_build_object(
      'success', true, 
      'token', v_token,
      'user', jsonb_build_object(
        'id', v_admin.id,
        'name', v_admin.name,
        'email', v_admin.email,
        'role', 'admin'
      )
    );
  ELSE
    RETURN jsonb_build_object('success', false, 'error', 'Invalid admin password');
  END IF;
END;
$$;

-- 2. Verify Admin Session Token
CREATE OR REPLACE FUNCTION admin_verify_session(p_token TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  RETURN is_valid_admin_token(p_token);
END;
$$;

-- 3. Admin Logout
CREATE OR REPLACE FUNCTION admin_logout(p_token TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  DELETE FROM app_admin_sessions WHERE token = p_token;
  RETURN TRUE;
END;
$$;

-- 4. Verify User Active Single-Device Session
CREATE OR REPLACE FUNCTION verify_user_session(p_user_id UUID, p_session_id TEXT)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_user RECORD;
BEGIN
  IF p_user_id IS NULL OR p_session_id IS NULL OR trim(p_session_id) = '' THEN
    RETURN jsonb_build_object('valid', false, 'reason', 'missing_params');
  END IF;

  SELECT id, name, email, role, status, current_session_id
  INTO v_user
  FROM app_users
  WHERE id = p_user_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('valid', false, 'reason', 'user_not_found');
  END IF;

  IF v_user.status = 'rejected' THEN
    RETURN jsonb_build_object('valid', false, 'reason', 'rejected', 'message', 'Your account has been rejected');
  END IF;

  IF v_user.status = 'pending' THEN
    RETURN jsonb_build_object('valid', false, 'reason', 'pending', 'message', 'Your account is pending admin approval');
  END IF;

  -- Conflict detected: student logged in from another device
  IF v_user.current_session_id IS NULL OR v_user.current_session_id <> p_session_id THEN
    RETURN jsonb_build_object(
      'valid', false, 
      'reason', 'conflict', 
      'message', 'Your account is active on another device. Playback stopped here.'
    );
  END IF;

  RETURN jsonb_build_object('valid', true);
END;
$$;

-- 5. Invalidate User Session (Logout)
CREATE OR REPLACE FUNCTION invalidate_user_session(p_user_id UUID, p_session_id TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  UPDATE app_users
  SET current_session_id = NULL
  WHERE id = p_user_id 
    AND (current_session_id = p_session_id OR p_session_id IS NULL);
  RETURN TRUE;
END;
$$;

-- 6. Admin Set User Status (Approve / Reject)
CREATE OR REPLACE FUNCTION admin_set_user_status(p_token TEXT, p_user_id UUID, p_new_status TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF NOT is_valid_admin_token(p_token) THEN
    RAISE EXCEPTION 'Unauthorized admin token';
  END IF;
  UPDATE app_users SET status = p_new_status WHERE id = p_user_id;
  RETURN FOUND;
END;
$$;

-- 7. Admin Set User Role (Admin / Student)
CREATE OR REPLACE FUNCTION admin_set_user_role(p_token TEXT, p_user_id UUID, p_new_role TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF NOT is_valid_admin_token(p_token) THEN
    RAISE EXCEPTION 'Unauthorized admin token';
  END IF;
  UPDATE app_users SET role = p_new_role WHERE id = p_user_id;
  RETURN FOUND;
END;
$$;

-- 8. Admin Reset Student Device Session Lock (Unlock for single login)
CREATE OR REPLACE FUNCTION admin_reset_user_device_session(p_user_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  UPDATE app_users 
  SET current_session_id = NULL 
  WHERE id = p_user_id;
  RETURN TRUE;
END;
$$;

