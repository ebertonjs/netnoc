import sqlite3, time, threading

DB_PATH = "netnoc.db"
_lock = threading.Lock()

def get_conn():
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA auto_vacuum=INCREMENTAL")
    conn.execute("PRAGMA synchronous=NORMAL")
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

        CREATE TABLE IF NOT EXISTS dhcp_hosts(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            mac TEXT UNIQUE,
            ip TEXT,
            hostname TEXT,
            active INTEGER,
            first_seen REAL,
            last_seen REAL,
            promoted_target TEXT
        );

        CREATE TABLE IF NOT EXISTS mikrotik_resource(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ts REAL, cpu_load REAL, uptime_s INTEGER,
            free_memory INTEGER, total_memory INTEGER,
            free_hdd INTEGER, total_hdd INTEGER,
            temperature REAL, board_name TEXT, version TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_mikrotik_resource_ts ON mikrotik_resource(ts);

        CREATE TABLE IF NOT EXISTS mikrotik_iface(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ts REAL, name TEXT, running INTEGER, disabled INTEGER,
            rx_bytes INTEGER, tx_bytes INTEGER, rx_bps REAL, tx_bps REAL
        );
        CREATE INDEX IF NOT EXISTS idx_mikrotik_iface_ts ON mikrotik_iface(name, ts);

        CREATE TABLE IF NOT EXISTS agh_stats(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ts REAL, num_dns_queries INTEGER, num_blocked_filtering INTEGER,
            num_replaced_safebrowsing INTEGER, num_replaced_parental INTEGER,
            avg_processing_time REAL
        );
        CREATE INDEX IF NOT EXISTS idx_agh_stats_ts ON agh_stats(ts);
        """)
        _conn.commit()
        # migração leve: garante a coluna em bancos criados antes desta versão
        cols = [r[1] for r in c.execute("PRAGMA table_info(dhcp_hosts)").fetchall()]
        if cols and "promoted_target" not in cols:
            c.execute("ALTER TABLE dhcp_hosts ADD COLUMN promoted_target TEXT")
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
            DELETE FROM mikrotik_resource;
            DELETE FROM mikrotik_iface;
            DELETE FROM agh_stats;
        """)
        _conn.commit()

def prune_old(days):
    cutoff = time.time() - days * 86400
    execute("DELETE FROM pings WHERE ts < ?", (cutoff,))
    execute("DELETE FROM port_checks WHERE ts < ?", (cutoff,))
    execute("DELETE FROM dns_checks WHERE ts < ?", (cutoff,))
    execute("DELETE FROM mikrotik_resource WHERE ts < ?", (cutoff,))
    execute("DELETE FROM mikrotik_iface WHERE ts < ?", (cutoff,))
    execute("DELETE FROM agh_stats WHERE ts < ?", (cutoff,))
    vacuum_incremental()


def vacuum_incremental():
    """Devolve ao SO as páginas liberadas pelos DELETEs acima (auto_vacuum=INCREMENTAL não faz isso sozinho)."""
    with _lock:
        _conn.execute("PRAGMA incremental_vacuum")
        _conn.commit()


def vacuum_full():
    """VACUUM completo (mais lento, trava o banco por um instante) — usar sob demanda via /api/history/vacuum."""
    with _lock:
        _conn.execute("VACUUM")
