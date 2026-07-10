import time, json
from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel
import db
import monitor

CFG = monitor.CFG
APP_VERSION = "1.0"  # versão fixa do sistema — não editável pela interface
app = FastAPI(title="NetNOC")

RANGE_SECONDS = {
    "5m": 300, "1h": 3600, "24h": 86400, "7d": 7 * 86400, "30d": 30 * 86400
}


@app.on_event("startup")
def startup():
    monitor.start_all()


def since(range_key):
    return time.time() - RANGE_SECONDS.get(range_key, 300)


@app.get("/api/overview")
def overview():
    targets = [t["name"] for t in monitor.get_targets()]
    latest = {}
    for name in targets:
        rows = db.query(
            "SELECT latency, success, jitter, ts FROM pings WHERE target=? ORDER BY ts DESC LIMIT 20", (name,)
        )
        if rows:
            ok = [r for r in rows if r["success"]]
            latest[name] = {
                "online": bool(rows[0]["success"]),
                "latency": rows[0]["latency"],
                "avg_latency": sum(r["latency"] for r in ok) / len(ok) if ok else None,
                "avg_jitter": sum(r["jitter"] for r in rows if r["jitter"] is not None) / len(rows),
                "loss_pct": 100 * (1 - len(ok) / len(rows)),
                "last_ts": rows[0]["ts"],
            }
    overall_online = any(v["online"] for v in latest.values()) if latest else False
    avg_latency = None
    avg_jitter = None
    avg_loss = None
    onlines = [v for v in latest.values()]
    if onlines:
        lats = [v["avg_latency"] for v in onlines if v["avg_latency"] is not None]
        jits = [v["avg_jitter"] for v in onlines]
        losses = [v["loss_pct"] for v in onlines]
        avg_latency = round(sum(lats) / len(lats), 1) if lats else None
        avg_jitter = round(sum(jits) / len(jits), 1) if jits else None
        avg_loss = round(sum(losses) / len(losses), 2) if losses else None

    last_speed = db.query("SELECT * FROM speedtests ORDER BY ts DESC LIMIT 1")
    speed = last_speed[0] if last_speed else None

    return {
        "internet_online": overall_online,
        "public_ip": db.get_meta("public_ip"),
        "public_ipv6": db.get_meta("public_ipv6"),
        "avg_latency": avg_latency,
        "avg_jitter": avg_jitter,
        "avg_loss_pct": avg_loss,
        "speedtest": speed,
        "cpu_pct": db.get_meta("cpu_pct"),
        "mem_pct": db.get_meta("mem_pct"),
        "temp_c": db.get_meta("temp_c"),
        "targets": latest,
    }


@app.get("/api/ping/history")
def ping_history(range: str = "5m"):
    ts_from = since(range)
    out = {}
    for t in monitor.get_targets():
        name = t["name"]
        rows = db.query(
            "SELECT ts, latency, jitter FROM pings WHERE target=? AND ts>=? ORDER BY ts ASC",
            (name, ts_from)
        )
        out[name] = rows
    return out


@app.get("/api/loss/history")
def loss_history(range: str = "5m"):
    ts_from = since(range)
    out = {}
    for t in monitor.get_targets():
        name = t["name"]
        rows = db.query(
            "SELECT ts, success FROM pings WHERE target=? AND ts>=? ORDER BY ts ASC",
            (name, ts_from)
        )
        out[name] = rows
    return out


@app.get("/api/targets")
def targets():
    result = []
    for t in monitor.get_targets():
        name = t["name"]
        rows = db.query(
            "SELECT latency, success, jitter, ts FROM pings WHERE target=? ORDER BY ts DESC LIMIT 50",
            (name,)
        )
        first_seen = db.query(
            "SELECT MIN(ts) as mn FROM pings WHERE target=?", (name,)
        )
        last_fail = db.query(
            "SELECT ts FROM pings WHERE target=? AND success=0 ORDER BY ts DESC LIMIT 1", (name,)
        )
        if rows:
            ok = [r for r in rows if r["success"]]
            result.append({
                "name": name, "host": t["host"],
                "online": bool(rows[0]["success"]),
                "latency": rows[0]["latency"],
                "jitter": rows[0]["jitter"],
                "loss_pct": round(100 * (1 - len(ok) / len(rows)), 2),
                "uptime_24h": monitor.get_uptime_pct(name, 24),
                "since": first_seen[0]["mn"] if first_seen else None,
                "last_fail": last_fail[0]["ts"] if last_fail else None,
            })
        else:
            result.append({"name": name, "host": t["host"], "online": None, "uptime_24h": None})
    return result


@app.get("/api/uptime/bars")
def uptime_bars(hours: int = 24):
    result = {}
    for t in monitor.get_targets():
        result[t["name"]] = monitor.get_hourly_bars(t["name"], hours)
    return result


@app.get("/api/insights/patterns")
def insights_patterns(days: int = 30):
    return monitor.detect_patterns(days)


class IntervalsIn(BaseModel):
    ping_interval_seconds: int | None = None
    dns_check_interval_seconds: int | None = None
    public_ip_interval_seconds: int | None = None
    system_interval_seconds: int | None = None


@app.get("/api/settings/intervals")
def get_intervals_ep():
    return monitor.get_intervals()


@app.post("/api/settings/intervals")
def set_intervals_ep(data: IntervalsIn):
    monitor.set_intervals(data.dict())
    return {"ok": True}


class TelegramIn(BaseModel):
    enabled: bool
    bot_token: str = ""
    chat_id: str = ""
    min_severity: str = "Alta"


@app.get("/api/settings/telegram")
def get_telegram_ep():
    cfg = monitor.get_telegram()
    cfg["bot_token"] = "•" * 8 if cfg["bot_token"] else ""
    return cfg


@app.post("/api/settings/telegram")
def set_telegram_ep(data: TelegramIn):
    bot_token = data.bot_token
    if bot_token == "•" * 8:
        bot_token = monitor.get_telegram()["bot_token"]
    monitor.set_telegram(data.enabled, bot_token, data.chat_id, data.min_severity)
    return {"ok": True}


@app.post("/api/settings/telegram/test")
def test_telegram_ep():
    ok = monitor.send_telegram("✅ Teste de alerta NetNOC — configuração funcionando!")
    if not ok:
        raise HTTPException(400, "Não foi possível enviar. Confira o token e chat_id.")
    return {"ok": True}


@app.get("/api/dns")
def dns_status():
    result = []
    for s in monitor.get_dns_servers():
        rows = db.query(
            "SELECT latency, success, ts FROM dns_checks WHERE server=? ORDER BY ts DESC LIMIT 1",
            (s["name"],)
        )
        r = rows[0] if rows else None
        result.append({
            "name": s["name"],
            "ip": s["ip"],
            "latency": r["latency"] if r else None,
            "success": bool(r["success"]) if r else None,
        })
    return result


@app.get("/api/incidents")
def incidents(active_only: bool = False):
    q = "SELECT * FROM incidents"
    if active_only:
        q += " WHERE resolved_ts IS NULL"
    q += " ORDER BY started_ts DESC LIMIT 200"
    return db.query(q)


@app.get("/api/events")
def events(limit: int = 50):
    return db.query("SELECT * FROM events ORDER BY ts DESC LIMIT ?", (limit,))


@app.get("/api/incidents/summary")
def incidents_summary(days: int = 7):
    ts_from = time.time() - days * 86400
    rows = db.query("SELECT severity FROM incidents WHERE started_ts >= ?", (ts_from,))
    counts = {"Alta": 0, "Media": 0, "Baixa": 0, "Info": 0}
    for r in rows:
        counts[r["severity"]] = counts.get(r["severity"], 0) + 1
    return counts


@app.post("/api/speedtest/run")
def speedtest_run():
    return monitor.run_speedtest()


@app.get("/api/speedtest/history")
def speedtest_history(limit: int = 30):
    return db.query("SELECT * FROM speedtests ORDER BY ts DESC LIMIT ?", (limit,))


@app.get("/api/history/24h")
def history_24h(metric: str = "latency"):
    ts_from = time.time() - 86400
    rows = db.query(
        "SELECT ts, AVG(latency) as latency FROM pings WHERE ts>=? GROUP BY CAST(ts/300 AS INT) ORDER BY ts ASC",
        (ts_from,)
    )
    return rows


class TargetIn(BaseModel):
    name: str
    host: str


class DnsIn(BaseModel):
    name: str
    ip: str


@app.get("/api/settings")
def get_settings():
    return {
        "targets": monitor.get_targets(),
        "dns_servers": monitor.get_dns_servers(),
    }


class AppNameIn(BaseModel):
    name: str


@app.get("/api/settings/appname")
def get_appname_ep():
    return {"name": monitor.get_app_name(), "version": APP_VERSION}


@app.post("/api/settings/appname")
def set_appname_ep(data: AppNameIn):
    try:
        monitor.set_app_name(data.name)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {"ok": True, "name": data.name.strip(), "version": APP_VERSION}


@app.post("/api/settings/targets")
def create_target(item: TargetIn):
    try:
        monitor.add_target(item.name, item.host)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {"ok": True}


@app.delete("/api/settings/targets/{name}")
def delete_target(name: str):
    monitor.remove_target(name)
    return {"ok": True}


@app.post("/api/settings/dns")
def create_dns(item: DnsIn):
    try:
        monitor.add_dns(item.name, item.ip)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {"ok": True}


@app.delete("/api/settings/dns/{name}")
def delete_dns(name: str):
    monitor.remove_dns(name)
    return {"ok": True}


@app.post("/api/history/clear")
def clear_history():
    db.clear_history()
    monitor._active_incidents.clear()
    monitor._last_latency.clear()
    monitor.log_event("Histórico limpo pelo usuário", "Info")
    return {"ok": True}


app.mount("/", StaticFiles(directory="static", html=True), name="static")
