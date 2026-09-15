import subprocess, time, socket, threading, platform, json, re
import requests
import psutil
import db

CFG = json.load(open("config.json", encoding="utf-8"))
THRESH = CFG["thresholds"]

_last_latency = {}  # target -> last latency, for jitter calc
_active_incidents = {}  # (type,target) -> incident id

IS_WINDOWS = platform.system().lower().startswith("win")


def init_settings():
    """Seed editable lists (targets/dns) into DB from config.json on first run only."""
    if db.get_setting("targets") is None:
        db.set_setting("targets", json.dumps(CFG["targets"]))
    if db.get_setting("dns_servers") is None:
        db.set_setting("dns_servers", json.dumps(CFG["dns_servers"]))
    if db.get_setting("intervals") is None:
        db.set_setting("intervals", json.dumps({
            "ping_interval_seconds": CFG["ping_interval_seconds"],
            "dns_check_interval_seconds": CFG["dns_check_interval_seconds"],
            "public_ip_interval_seconds": CFG["public_ip_interval_seconds"],
            "system_interval_seconds": CFG["system_interval_seconds"],
        }))
    if db.get_setting("telegram") is None:
        db.set_setting("telegram", json.dumps({
            "enabled": False, "bot_token": "", "chat_id": "", "min_severity": "Alta"
        }))
    if db.get_setting("app_name") is None:
        db.set_setting("app_name", CFG.get("app_name", "NetNOC"))


def get_app_name():
    return db.get_setting("app_name", "NetNOC")


def set_app_name(name):
    name = (name or "").strip()
    if not name:
        raise ValueError("Nome não pode ser vazio")
    if len(name) > 40:
        raise ValueError("Nome muito longo (máx. 40 caracteres)")
    db.set_setting("app_name", name)


def get_intervals():
    defaults = {
        "ping_interval_seconds": 5, "dns_check_interval_seconds": 30,
        "public_ip_interval_seconds": 300, "system_interval_seconds": 5
    }
    saved = json.loads(db.get_setting("intervals", json.dumps(defaults)))
    defaults.update(saved)
    return defaults


def set_intervals(data):
    current = get_intervals()
    current.update({k: int(v) for k, v in data.items() if v is not None and int(v) > 0})
    db.set_setting("intervals", json.dumps(current))


def get_telegram():
    defaults = {"enabled": False, "bot_token": "", "chat_id": "", "min_severity": "Alta"}
    saved = json.loads(db.get_setting("telegram", json.dumps(defaults)))
    defaults.update(saved)
    return defaults


def set_telegram(enabled, bot_token, chat_id, min_severity):
    db.set_setting("telegram", json.dumps({
        "enabled": bool(enabled), "bot_token": bot_token or "",
        "chat_id": chat_id or "", "min_severity": min_severity or "Alta"
    }))


_SEVERITY_ORDER = {"Alta": 3, "Media": 2, "Baixa": 1, "Info": 0}


def send_telegram(message):
    cfg = get_telegram()
    if not cfg["enabled"] or not cfg["bot_token"] or not cfg["chat_id"]:
        return False
    try:
        url = f"https://api.telegram.org/bot{cfg['bot_token']}/sendMessage"
        requests.post(url, data={"chat_id": cfg["chat_id"], "text": message}, timeout=5)
        return True
    except Exception:
        return False


def get_targets():
    return json.loads(db.get_setting("targets", "[]"))


def get_dns_servers():
    return json.loads(db.get_setting("dns_servers", "[]"))


def add_target(name, host, parent=None):
    items = get_targets()
    if any(t["name"] == name for t in items):
        raise ValueError("Já existe um destino com esse nome")
    items.append({"name": name, "host": host, "parent": parent})
    db.set_setting("targets", json.dumps(items))


def remove_target(name):
    items = [t for t in get_targets() if t["name"] != name]
    db.set_setting("targets", json.dumps(items))


def add_dns(name, ip):
    items = get_dns_servers()
    if any(s["name"] == name for s in items):
        raise ValueError("Já existe um servidor DNS com esse nome")
    items.append({"name": name, "ip": ip})
    db.set_setting("dns_servers", json.dumps(items))


def remove_dns(name):
    items = [s for s in get_dns_servers() if s["name"] != name]
    db.set_setting("dns_servers", json.dumps(items))


_MIKROTIK_DEFAULTS = {
    "enabled": False, "host": "", "port": 443, "use_https": True,
    "verify_ssl": False, "username": "", "password": "", "sync_interval_seconds": 60,
}


def get_mikrotik():
    saved = json.loads(db.get_setting("mikrotik", json.dumps(_MIKROTIK_DEFAULTS)))
    cfg = dict(_MIKROTIK_DEFAULTS)
    cfg.update(saved)
    return cfg


def set_mikrotik(payload):
    cfg = dict(_MIKROTIK_DEFAULTS)
    cfg.update(payload)
    db.set_setting("mikrotik", json.dumps(cfg))


def _mikrotik_base_url(cfg):
    scheme = "https" if cfg["use_https"] else "http"
    return f"{scheme}://{cfg['host']}:{cfg['port']}/rest"


def _mikrotik_get(path, cfg=None):
    cfg = cfg or get_mikrotik()
    if not cfg["host"] or not cfg["username"]:
        raise ValueError("MikroTik não configurado")
    url = f"{_mikrotik_base_url(cfg)}/{path}"
    r = requests.get(
        url, auth=(cfg["username"], cfg["password"]),
        verify=cfg["verify_ssl"], timeout=6
    )
    r.raise_for_status()
    return r.json()


def fetch_dhcp_leases():
    """Busca as leases ativas do DHCP server via API REST do MikroTik."""
    return _mikrotik_get("ip/dhcp-server/lease")


def sync_dhcp_leases():
    now = time.time()
    try:
        leases = fetch_dhcp_leases()
    except Exception:
        return []
    seen_macs = []
    for lease in leases:
        mac = lease.get("mac-address")
        if not mac:
            continue
        seen_macs.append(mac)
        ip = lease.get("address", "")
        hostname = lease.get("host-name", "")
        active = 1 if lease.get("status") == "bound" else 0
        existing = db.query("SELECT id FROM dhcp_hosts WHERE mac=?", (mac,))
        if existing:
            db.execute(
                "UPDATE dhcp_hosts SET ip=?, hostname=?, active=?, last_seen=? WHERE mac=?",
                (ip, hostname, active, now, mac)
            )
        else:
            db.execute(
                "INSERT INTO dhcp_hosts(mac,ip,hostname,active,first_seen,last_seen,promoted_target) "
                "VALUES(?,?,?,?,?,?,NULL)",
                (mac, ip, hostname, active, now, now)
            )
    if seen_macs:
        placeholders = ",".join("?" * len(seen_macs))
        db.execute(
            f"UPDATE dhcp_hosts SET active=0 WHERE mac NOT IN ({placeholders})",
            tuple(seen_macs)
        )
    return leases


def get_dhcp_hosts():
    return db.query("SELECT * FROM dhcp_hosts ORDER BY (promoted_target IS NULL) ASC, last_seen DESC")


def promote_dhcp_host(host_id, name=None, parent=None):
    rows = db.query("SELECT * FROM dhcp_hosts WHERE id=?", (host_id,))
    if not rows:
        raise ValueError("Dispositivo não encontrado")
    host = rows[0]
    if not host["ip"]:
        raise ValueError("Dispositivo sem IP conhecido, não é possível monitorar")
    name = (name or host["hostname"] or host["ip"]).strip()
    add_target(name, host["ip"], parent)
    db.execute("UPDATE dhcp_hosts SET promoted_target=? WHERE id=?", (name, host_id))
    log_event(f"Dispositivo promovido a destino monitorado: {name}", "Info")
    return name


def get_mikrotik_status():
    """Retorna o último snapshot de recursos coletado, com flag de 'stale' se antigo."""
    cfg = get_mikrotik()
    if not cfg["enabled"]:
        return None
    rows = db.query("SELECT * FROM mikrotik_resource ORDER BY ts DESC LIMIT 1")
    if not rows:
        return None
    row = rows[0]
    stale = (time.time() - row["ts"]) > max(cfg["sync_interval_seconds"] * 3, 120)
    return {
        "ts": row["ts"], "stale": stale,
        "cpu_load": row["cpu_load"], "uptime_s": row["uptime_s"],
        "mem_pct": round(100 * (1 - row["free_memory"] / row["total_memory"]), 1)
        if row["total_memory"] else None,
        "hdd_pct": round(100 * (1 - row["free_hdd"] / row["total_hdd"]), 1)
        if row["total_hdd"] else None,
        "temperature": row["temperature"], "board_name": row["board_name"], "version": row["version"],
    }


def get_mikrotik_interfaces():
    rows = db.query("""
        SELECT name, running, disabled, rx_bytes, tx_bytes, rx_bps, tx_bps, MAX(ts) as ts
        FROM mikrotik_iface GROUP BY name ORDER BY name ASC
    """)
    return rows


def get_mikrotik_resource_history(seconds):
    ts_from = time.time() - seconds
    return db.query(
        "SELECT ts, cpu_load, temperature FROM mikrotik_resource WHERE ts>=? ORDER BY ts ASC",
        (ts_from,)
    )


def get_mikrotik_iface_history(iface, seconds):
    ts_from = time.time() - seconds
    return db.query(
        "SELECT ts, rx_bps, tx_bps FROM mikrotik_iface WHERE name=? AND ts>=? ORDER BY ts ASC",
        (iface, ts_from)
    )


def _poll_mikrotik_once(cfg):
    now = time.time()
    res = _mikrotik_get("system/resource", cfg)
    if isinstance(res, list):
        res = res[0] if res else {}
    board = res.get("board-name")
    version = res.get("version")
    cpu_load = float(res.get("cpu-load", 0) or 0)
    uptime_s = _mikrotik_parse_uptime(res.get("uptime", ""))
    free_mem = int(res.get("free-memory", 0) or 0)
    total_mem = int(res.get("total-memory", 0) or 0)
    free_hdd = int(res.get("free-hdd-space", 0) or 0)
    total_hdd = int(res.get("total-hdd-space", 0) or 0)
    temp = None
    try:
        health = _mikrotik_get("system/health", cfg)
        for item in health if isinstance(health, list) else [health]:
            if item.get("name") in ("temperature", "cpu-temperature"):
                temp = float(item.get("value"))
    except Exception:
        pass
    db.execute(
        "INSERT INTO mikrotik_resource(ts,cpu_load,uptime_s,free_memory,total_memory,free_hdd,total_hdd,temperature,board_name,version) "
        "VALUES(?,?,?,?,?,?,?,?,?,?)",
        (now, cpu_load, uptime_s, free_mem, total_mem, free_hdd, total_hdd, temp, board, version)
    )

    ifaces = _mikrotik_get("interface", cfg)
    prev_rows = {r["name"]: r for r in db.query(
        "SELECT name, rx_bytes, tx_bytes, ts FROM mikrotik_iface WHERE (name, ts) IN "
        "(SELECT name, MAX(ts) FROM mikrotik_iface GROUP BY name)"
    )}
    for iface in ifaces:
        name = iface.get("name")
        if not name:
            continue
        rx = int(iface.get("rx-byte", 0) or 0)
        tx = int(iface.get("tx-byte", 0) or 0)
        running = 1 if iface.get("running") in (True, "true") else 0
        disabled = 1 if iface.get("disabled") in (True, "true") else 0
        prev = prev_rows.get(name)
        rx_bps = tx_bps = 0.0
        if prev:
            dt = now - prev["ts"]
            if dt > 0:
                rx_bps = max(0, (rx - prev["rx_bytes"]) * 8 / dt)
                tx_bps = max(0, (tx - prev["tx_bytes"]) * 8 / dt)
        db.execute(
            "INSERT INTO mikrotik_iface(ts,name,running,disabled,rx_bytes,tx_bytes,rx_bps,tx_bps) VALUES(?,?,?,?,?,?,?,?)",
            (now, name, running, disabled, rx, tx, rx_bps, tx_bps)
        )

    if cfg.get("enabled"):
        sync_dhcp_leases()


def _mikrotik_parse_uptime(text):
    """Converte formatos tipo '1w2d3h4m5s' do RouterOS para segundos."""
    if not text:
        return None
    total = 0
    for value, unit in re.findall(r"(\d+)([wdhms])", text):
        value = int(value)
        total += value * {"w": 604800, "d": 86400, "h": 3600, "m": 60, "s": 1}[unit]
    return total


def mikrotik_worker():
    while True:
        cfg = get_mikrotik()
        if cfg["enabled"] and cfg["host"]:
            try:
                _poll_mikrotik_once(cfg)
            except Exception as e:
                log_event(f"Falha ao coletar dados do MikroTik: {e}", "Baixa")
        time.sleep(max(get_mikrotik()["sync_interval_seconds"], 15))


def build_topology():
    """Monta nós/arestas: Internet -> destinos monitorados, respeitando 'parent'."""
    targets = get_targets()
    nodes = [{"id": "internet", "label": "Internet", "type": "internet"}]
    edges = []
    names = {t["name"] for t in targets}
    for t in targets:
        online = None
        rows = db.query(
            "SELECT success FROM pings WHERE target=? ORDER BY ts DESC LIMIT 1", (t["name"],)
        )
        if rows:
            online = bool(rows[0]["success"])
        nodes.append({"id": t["name"], "label": t["name"], "host": t["host"], "type": "target", "online": online})
        parent = t.get("parent")
        source = parent if parent and parent in names else "internet"
        edges.append({"source": source, "target": t["name"]})
    return {"nodes": nodes, "edges": edges}


_AGH_DEFAULTS = {
    "enabled": False, "host": "", "port": 3000, "use_https": False,
    "username": "", "password": "", "sync_interval_seconds": 60,
}


def get_agh():
    saved = json.loads(db.get_setting("agh", json.dumps(_AGH_DEFAULTS)))
    cfg = dict(_AGH_DEFAULTS)
    cfg.update(saved)
    return cfg


def set_agh(payload):
    cfg = dict(_AGH_DEFAULTS)
    cfg.update(payload)
    db.set_setting("agh", json.dumps(cfg))


def _agh_base_url(cfg):
    scheme = "https" if cfg["use_https"] else "http"
    return f"{scheme}://{cfg['host']}:{cfg['port']}/control"


def _agh_get(path, cfg=None):
    cfg = cfg or get_agh()
    if not cfg["host"]:
        raise ValueError("AdGuard Home não configurado")
    url = f"{_agh_base_url(cfg)}/{path}"
    auth = (cfg["username"], cfg["password"]) if cfg["username"] else None
    r = requests.get(url, auth=auth, timeout=6)
    r.raise_for_status()
    return r.json()


def test_agh_connection():
    """Usado pelo botão 'Testar conexão' das configurações."""
    cfg = get_agh()
    return _agh_get("status", cfg)


def _poll_agh_once(cfg):
    stats = _agh_get("stats", cfg)
    db.execute(
        "INSERT INTO agh_stats(ts,num_dns_queries,num_blocked_filtering,num_replaced_safebrowsing,"
        "num_replaced_parental,avg_processing_time) VALUES(?,?,?,?,?,?)",
        (
            time.time(),
            stats.get("num_dns_queries", 0),
            stats.get("num_blocked_filtering", 0),
            stats.get("num_replaced_safebrowsing", 0),
            stats.get("num_replaced_parental", 0),
            stats.get("avg_processing_time", 0),
        )
    )


def agh_worker():
    while True:
        cfg = get_agh()
        if cfg["enabled"] and cfg["host"]:
            try:
                _poll_agh_once(cfg)
            except Exception as e:
                log_event(f"Falha ao coletar dados do AdGuard Home: {e}", "Baixa")
        time.sleep(max(get_agh()["sync_interval_seconds"], 15))


def get_agh_status():
    """Status ao vivo (não fica salvo em tabela — vem direto da API do AGH)."""
    cfg = get_agh()
    if not cfg["enabled"]:
        return None
    try:
        status = _agh_get("status", cfg)
    except Exception:
        return {"enabled": True, "host": cfg["host"], "online": False}
    return {
        "enabled": True, "host": cfg["host"], "online": True,
        "version": status.get("version"), "protection_enabled": status.get("protection_enabled"),
        "dns_addresses": status.get("dns_addresses"),
    }


def get_agh_stats_latest():
    rows = db.query("SELECT * FROM agh_stats ORDER BY ts DESC LIMIT 1")
    if not rows:
        return None
    row = rows[0]
    total = row["num_dns_queries"] or 0
    blocked = row["num_blocked_filtering"] or 0
    row["blocked_pct"] = round(100 * blocked / total, 2) if total else 0
    return row


def get_agh_stats_history(seconds):
    ts_from = time.time() - seconds
    return db.query(
        "SELECT ts, num_dns_queries, num_blocked_filtering FROM agh_stats WHERE ts>=? ORDER BY ts ASC",
        (ts_from,)
    )


def _format_duration(seconds):
    seconds = max(0, int(seconds))
    h, rem = divmod(seconds, 3600)
    m, s = divmod(rem, 60)
    if h:
        return f"{h}h{m:02d}m"
    if m:
        return f"{m}m{s:02d}s"
    return f"{s}s"


def log_event(message, severity="Info"):
    db.execute("INSERT INTO events(ts,message,severity) VALUES(?,?,?)",
               (time.time(), message, severity))


def raise_incident(itype, target, message, severity):
    key = (itype, target)
    if key in _active_incidents:
        return
    started_ts = time.time()
    iid = db.execute(
        "INSERT INTO incidents(type,target,message,severity,started_ts,resolved_ts) VALUES(?,?,?,?,?,NULL)",
        (itype, target, message, severity, started_ts))
    _active_incidents[key] = {"id": iid, "severity": severity, "started_ts": started_ts}
    log_event(message, severity)
    cfg = get_telegram()
    if cfg["enabled"] and _SEVERITY_ORDER.get(severity, 0) >= _SEVERITY_ORDER.get(cfg["min_severity"], 3):
        send_telegram(f"🚨 NetNOC [{severity}]\n{message}")


def resolve_incident(itype, target, message="Resolvido"):
    key = (itype, target)
    incident = _active_incidents.pop(key, None)
    if incident:
        db.execute("UPDATE incidents SET resolved_ts=? WHERE id=?", (time.time(), incident["id"]))
        log_event(f"{message}: {target}", "Info")
        cfg = get_telegram()
        severity = incident["severity"]
        if cfg["enabled"] and _SEVERITY_ORDER.get(severity, 0) >= _SEVERITY_ORDER.get(cfg["min_severity"], 3):
            duration = time.time() - incident["started_ts"]
            send_telegram(
                f"✅ NetNOC [{severity}]\n{target}: {message}\nDuração: {_format_duration(duration)}")


def ping_host(host, timeout=1):
    """Returns latency_ms or None if unreachable."""
    count_flag = "-n" if IS_WINDOWS else "-c"
    timeout_flag = "-w" if IS_WINDOWS else "-W"
    timeout_val = str(int(timeout * 1000)) if IS_WINDOWS else str(timeout)
    try:
        out = subprocess.run(
            ["ping", count_flag, "1", timeout_flag, timeout_val, host],
            capture_output=True, text=True, timeout=timeout + 1
        )
        if out.returncode != 0:
            return None
        text = out.stdout
        m = re.search(r"time[=<]([\d.]+)", text)
        if m:
            return float(m.group(1))
        return None
    except Exception:
        return None


def ping_worker():
    while True:
        for t in get_targets():
            name, host = t["name"], t["host"]
            lat = ping_host(host)
            success = lat is not None
            prev = _last_latency.get(name)
            jitter = abs(lat - prev) if (success and prev is not None) else 0
            if success:
                _last_latency[name] = lat
            db.execute(
                "INSERT INTO pings(target,ts,latency,success,jitter) VALUES(?,?,?,?,?)",
                (name, time.time(), lat, int(success), jitter)
            )
            evaluate_target_health(name)
        time.sleep(get_intervals()["ping_interval_seconds"])


def evaluate_target_health(name):
    rows = db.query(
        "SELECT latency, success, jitter FROM pings WHERE target=? ORDER BY ts DESC LIMIT 20", (name,)
    )
    if not rows:
        return
    total = len(rows)
    fails = sum(1 for r in rows if not r["success"])
    loss_pct = (fails / total) * 100
    latencies = [r["latency"] for r in rows if r["success"]]
    avg_lat = sum(latencies) / len(latencies) if latencies else None
    jitters = [r["jitter"] for r in rows if r["jitter"] is not None]
    avg_jit = sum(jitters) / len(jitters) if jitters else 0

    if rows[0]["success"] == 0 and fails >= 3:
        raise_incident("offline", name, f"{name} está offline", "Alta")
    elif rows[0]["success"] == 1:
        resolve_incident("offline", name)

    if avg_lat is not None:
        if avg_lat > THRESH["ping_ms"]:
            raise_incident("latency", name, f"Alta latência detectada no destino {name}", "Alta")
        else:
            resolve_incident("latency", name)

    if avg_jit > THRESH["jitter_ms"]:
        raise_incident("jitter", name, f"Jitter alto detectado em {name}", "Media")
    else:
        resolve_incident("jitter", name)

    if loss_pct > THRESH["loss_pct"]:
        raise_incident("loss", name, f"Perda de pacotes detectada para {name}", "Media")
    else:
        resolve_incident("loss", name)


def dns_worker():
    import dns.resolver
    while True:
        for s in get_dns_servers():
            resolver = dns.resolver.Resolver(configure=False)
            resolver.nameservers = [s["ip"]]
            resolver.timeout = 1.5
            resolver.lifetime = 1.5
            start = time.time()
            success = True
            try:
                resolver.resolve(CFG["dns_query_name"], "A")
            except Exception:
                success = False
            latency = (time.time() - start) * 1000
            db.execute(
                "INSERT INTO dns_checks(server,ts,latency,success) VALUES(?,?,?,?)",
                (s["name"], time.time(), latency, int(success))
            )
            if success and latency > THRESH["dns_ms"]:
                raise_incident("dns", s["name"], f"DNS da {s['name']} lento: {latency:.0f}ms", "Baixa")
            else:
                resolve_incident("dns", s["name"])
        time.sleep(get_intervals()["dns_check_interval_seconds"])


def public_ip_worker():
    while True:
        try:
            r = requests.get("https://api.ipify.org?format=json", timeout=5)
            ipv4 = r.json().get("ip")
            db.set_meta("public_ip", ipv4)
        except Exception:
            pass
        try:
            r6 = requests.get("https://api64.ipify.org?format=json", timeout=5)
            ipv6 = r6.json().get("ip")
            db.set_meta("public_ipv6", ipv6)
        except Exception:
            pass
        time.sleep(get_intervals()["public_ip_interval_seconds"])


def get_cpu_temp():
    try:
        with open("/sys/class/thermal/thermal_zone0/temp") as f:
            return round(int(f.read().strip()) / 1000, 1)
    except Exception:
        return None


def system_worker():
    while True:
        cpu = psutil.cpu_percent(interval=1)
        mem = psutil.virtual_memory().percent
        temp = get_cpu_temp()
        db.set_meta("cpu_pct", cpu)
        db.set_meta("mem_pct", mem)
        if temp is not None:
            db.set_meta("temp_c", temp)
            if temp > THRESH["temp_c"]:
                raise_incident("temp", "Raspberry Pi", f"Temperatura alta: {temp}°C", "Media")
            else:
                resolve_incident("temp", "Raspberry Pi")
        if cpu > THRESH["cpu_pct"]:
            raise_incident("cpu", "Raspberry Pi", f"CPU alta: {cpu}%", "Media")
        else:
            resolve_incident("cpu", "Raspberry Pi")
        time.sleep(get_intervals()["system_interval_seconds"])


def prune_worker():
    while True:
        db.prune_old(CFG["history_retention_days"])
        time.sleep(3600)


def run_speedtest():
    """Simple download/upload estimate using Cloudflare speed endpoints."""
    result = {"download": None, "upload": None, "latency": None}
    try:
        start = time.time()
        requests.get("https://speed.cloudflare.com/__down?bytes=0", timeout=3)
        result["latency"] = (time.time() - start) * 1000
    except Exception:
        pass
    try:
        size_bytes = 25_000_000
        start = time.time()
        r = requests.get(f"https://speed.cloudflare.com/__down?bytes={size_bytes}", timeout=20)
        elapsed = time.time() - start
        mbps = (len(r.content) * 8 / 1_000_000) / elapsed
        result["download"] = round(mbps, 1)
    except Exception:
        pass
    try:
        payload = b"0" * 5_000_000
        start = time.time()
        requests.post("https://speed.cloudflare.com/__up", data=payload, timeout=20)
        elapsed = time.time() - start
        mbps = (len(payload) * 8 / 1_000_000) / elapsed
        result["upload"] = round(mbps, 1)
    except Exception:
        pass
    db.execute(
        "INSERT INTO speedtests(ts,download,upload,latency) VALUES(?,?,?,?)",
        (time.time(), result["download"], result["upload"], result["latency"])
    )
    log_event(
        f"Teste de velocidade concluído: {result['download']} Mbps down / {result['upload']} Mbps up",
        "Info"
    )
    return result


def get_uptime_pct(target, hours=24):
    ts_from = time.time() - hours * 3600
    rows = db.query(
        "SELECT success FROM pings WHERE target=? AND ts>=?", (target, ts_from)
    )
    if not rows:
        return None
    ok = sum(1 for r in rows if r["success"])
    return round(100 * ok / len(rows), 2)


def get_hourly_bars(target, hours=24):
    """Returns list of {hour_label, pct} bucketed per hour for the last N hours."""
    now = time.time()
    buckets = []
    for i in range(hours - 1, -1, -1):
        start = now - (i + 1) * 3600
        end = now - i * 3600
        rows = db.query(
            "SELECT success FROM pings WHERE target=? AND ts>=? AND ts<?",
            (target, start, end)
        )
        if rows:
            ok = sum(1 for r in rows if r["success"])
            pct = round(100 * ok / len(rows), 1)
        else:
            pct = None
        buckets.append({"ts": end, "pct": pct})
    return buckets


def detect_patterns(days=30):
    """Finds hours-of-day with disproportionately more incidents than average."""
    ts_from = time.time() - days * 86400
    rows = db.query(
        "SELECT target, started_ts FROM incidents WHERE started_ts >= ? AND type IN ('offline','loss','latency')",
        (ts_from,)
    )
    if len(rows) < 5:
        return []
    from collections import defaultdict
    import datetime
    per_target_hour = defaultdict(lambda: defaultdict(int))
    for r in rows:
        hour = datetime.datetime.fromtimestamp(r["started_ts"]).hour
        per_target_hour[r["target"]][hour] += 1

    insights = []
    for target, hours_map in per_target_hour.items():
        total = sum(hours_map.values())
        if total < 4:
            continue
        avg = total / 24
        for hour, count in sorted(hours_map.items(), key=lambda x: -x[1]):
            if count >= max(3, avg * 2):
                insights.append({
                    "target": target,
                    "hour": hour,
                    "count": count,
                    "message": f"{target} costuma ter problemas por volta de {hour:02d}h ({count} incidentes nos últimos {days} dias)"
                })
    insights.sort(key=lambda x: -x["count"])
    return insights[:8]


def start_all():
    db.init_db()
    init_settings()
    log_event("NetNOC iniciado", "Info")
    threads = [
        threading.Thread(target=ping_worker, daemon=True),
        threading.Thread(target=dns_worker, daemon=True),
        threading.Thread(target=public_ip_worker, daemon=True),
        threading.Thread(target=system_worker, daemon=True),
        threading.Thread(target=prune_worker, daemon=True),
        threading.Thread(target=mikrotik_worker, daemon=True),
        threading.Thread(target=agh_worker, daemon=True),
    ]
    for t in threads:
        t.start()
