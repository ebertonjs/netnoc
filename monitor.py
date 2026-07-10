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


def add_target(name, host):
    items = get_targets()
    if any(t["name"] == name for t in items):
        raise ValueError("Já existe um destino com esse nome")
    items.append({"name": name, "host": host})
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


def log_event(message, severity="Info"):
    db.execute("INSERT INTO events(ts,message,severity) VALUES(?,?,?)",
               (time.time(), message, severity))


def raise_incident(itype, target, message, severity):
    key = (itype, target)
    if key in _active_incidents:
        return
    iid = db.execute(
        "INSERT INTO incidents(type,target,message,severity,started_ts,resolved_ts) VALUES(?,?,?,?,?,NULL)",
        (itype, target, message, severity, time.time()))
    _active_incidents[key] = iid
    log_event(message, severity)
    cfg = get_telegram()
    if cfg["enabled"] and _SEVERITY_ORDER.get(severity, 0) >= _SEVERITY_ORDER.get(cfg["min_severity"], 3):
        send_telegram(f"🚨 NetNOC [{severity}]\n{message}")


def resolve_incident(itype, target, message="Resolvido"):
    key = (itype, target)
    iid = _active_incidents.pop(key, None)
    if iid:
        db.execute("UPDATE incidents SET resolved_ts=? WHERE id=?", (time.time(), iid))
        log_event(f"{message}: {target}", "Info")


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
    ]
    for t in threads:
        t.start()
