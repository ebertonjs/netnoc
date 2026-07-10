import sqlite3, time, threading

DB_PATH = "netnoc.db"
_lock = threading.Lock()

def get_conn():
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    return conn

_conn = get_conn()

def init_db():
    with _lock:
        c = _conn.cursor()
        c.executescript("""
        CREATE TABLE IF NOT EXISTS pings(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            target TEXT, ts REAL, latency REAL, success INTEGER, jitter REAL
        );
        CREATE INDEX IF NOT EXISTS idx_pings_target_ts ON pings(target, ts);

        CREATE TABLE IF NOT EXISTS port_checks(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT, ip TEXT, port INTEGER, proto TEXT, ts REAL, is_open INTEGER, latency REAL
        );
        CREATE INDEX IF NOT EXISTS idx_ports_ts ON port_checks(ip, port, ts);

        CREATE TABLE IF NOT EXISTS dns_checks(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            server TEXT, ts REAL, latency REAL, success INTEGER
        );

        CREATE TABLE IF NOT EXISTS speedtests(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ts REAL, download REAL, upload REAL, latency REAL
        );

        CREATE TABLE IF NOT EXISTS incidents(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            type TEXT, target TEXT, message TEXT, severity TEXT,
            started_ts REAL, resolved_ts REAL
        );

        CREATE TABLE IF NOT EXISTS events(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ts REAL, message TEXT, severity TEXT
        );

        CREATE TABLE IF NOT EXISTS meta(
            key TEXT PRIMARY KEY, value TEXT, ts REAL
        );

        CREATE TABLE IF NOT EXISTS settings(
            key TEXT PRIMARY KEY, value TEXT
        );
        """)
        _conn.commit()

def execute(query, params=()):
    with _lock:
        c = _conn.cursor()
        c.execute(query, params)
        _conn.commit()
        return c.lastrowid

def query(query, params=()):
    with _lock:
        c = _conn.cursor()
        c.execute(query, params)
        return [dict(r) for r in c.fetchall()]

def set_meta(key, value):
    execute("INSERT INTO meta(key,value,ts) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, ts=excluded.ts",
            (key, str(value), time.time()))

def get_meta(key, default=None):
    r = query("SELECT value FROM meta WHERE key=?", (key,))
    return r[0]["value"] if r else default

def set_setting(key, value_json):
    execute("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (key, value_json))

def get_setting(key, default=None):
    r = query("SELECT value FROM settings WHERE key=?", (key,))
    return r[0]["value"] if r else default

def clear_history():
    with _lock:
        c = _conn.cursor()
        c.executescript("""
            DELETE FROM pings;
            DELETE FROM port_checks;
            DELETE FROM dns_checks;
            DELETE FROM speedtests;
            DELETE FROM incidents;
            DELETE FROM events;
        """)
        _conn.commit()

def prune_old(days):
    cutoff = time.time() - days * 86400
    execute("DELETE FROM pings WHERE ts < ?", (cutoff,))
    execute("DELETE FROM port_checks WHERE ts < ?", (cutoff,))
    execute("DELETE FROM dns_checks WHERE ts < ?", (cutoff,))
