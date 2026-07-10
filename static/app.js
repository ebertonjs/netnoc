const LAYOUT_KEY = 'netnoc_layout';
let draggedWidget = null;

function initDragAndDrop(){
  const grid = document.getElementById('widgetsGrid');
  if(!grid) return;

  grid.querySelectorAll('.widget').forEach(widget => {
    widget.addEventListener('dragstart', () => {
      draggedWidget = widget;
      setTimeout(() => widget.classList.add('dragging'), 0);
    });
    widget.addEventListener('dragend', () => {
      widget.classList.remove('dragging');
      grid.querySelectorAll('.widget').forEach(w => w.classList.remove('drag-over'));
      saveLayout();
    });
    widget.addEventListener('dragover', (e) => {
      e.preventDefault();
      if(widget === draggedWidget) return;
      widget.classList.add('drag-over');
    });
    widget.addEventListener('dragleave', () => widget.classList.remove('drag-over'));
    widget.addEventListener('drop', (e) => {
      e.preventDefault();
      widget.classList.remove('drag-over');
      if(!draggedWidget || widget === draggedWidget) return;
      const all = Array.from(grid.children);
      const draggedIdx = all.indexOf(draggedWidget);
      const targetIdx = all.indexOf(widget);
      if(draggedIdx < targetIdx) widget.after(draggedWidget);
      else widget.before(draggedWidget);
    });
  });
}

function saveLayout(){
  const grid = document.getElementById('widgetsGrid');
  const order = Array.from(grid.children).map(w => w.dataset.widget);
  localStorage.setItem(LAYOUT_KEY, JSON.stringify(order));
  document.getElementById('resetLayoutBtn').classList.remove('hidden');
}

function applyLayout(){
  const grid = document.getElementById('widgetsGrid');
  const saved = localStorage.getItem(LAYOUT_KEY);
  if(!saved) return;
  try{
    const order = JSON.parse(saved);
    order.forEach(id => {
      const el = grid.querySelector(`[data-widget="${id}"]`);
      if(el) grid.appendChild(el);
    });
    document.getElementById('resetLayoutBtn').classList.remove('hidden');
  }catch(e){}
}

document.getElementById('resetLayoutBtn').addEventListener('click', () => {
  localStorage.removeItem(LAYOUT_KEY);
  location.reload();
});

const PAGE_TITLES = {
  overview: ["Visão Geral", "Monitoramento em tempo real da sua rede"],
  config: ["Configurações", "Destinos, DNS, intervalos e alertas"],
};

function showPage(page){
  document.querySelectorAll('.page').forEach(p => p.classList.toggle('active', p.dataset.page === page));
  document.querySelectorAll('nav a').forEach(a => a.classList.toggle('active', a.dataset.page === page));
  const [title, subtitle] = PAGE_TITLES[page] || PAGE_TITLES.overview;
  document.querySelector('.topbar h1').textContent = title;
  document.querySelector('.topbar p').textContent = subtitle;
  localStorage.setItem('netnoc_page', page);
}

document.querySelectorAll('nav a[data-page]').forEach(a => {
  a.addEventListener('click', (e) => {
    e.preventDefault();
    showPage(a.dataset.page);
  });
});

// ---------- Toast notifications ----------
function showToast(message, type='success'){
  const container = document.getElementById('toastContainer');
  const icon = type === 'success' ? '✅' : type === 'error' ? '❌' : 'ℹ️';
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<span>${icon}</span><span>${message}</span>`;
  container.appendChild(el);
  setTimeout(() => {
    el.classList.add('fade-out');
    setTimeout(() => el.remove(), 250);
  }, 3500);
}

// ---------- Config tabs ----------
document.querySelectorAll('.config-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.config-tab').forEach(t => t.classList.toggle('active', t === tab));
    document.querySelectorAll('.config-tab-panel').forEach(p => p.classList.toggle('active', p.dataset.tabPanel === tab.dataset.tab));
    localStorage.setItem('netnoc_config_tab', tab.dataset.tab);
  });
});
(function restoreConfigTab(){
  const saved = localStorage.getItem('netnoc_config_tab');
  if(!saved) return;
  const tab = document.querySelector(`.config-tab[data-tab="${saved}"]`);
  if(tab) tab.click();
})();

// ---------- Validation helpers ----------
function isValidHost(value){
  const v = (value || '').trim();
  if(!v) return false;
  const ipv4 = /^(\d{1,3}\.){3}\d{1,3}$/;
  const hostname = /^[a-zA-Z0-9]([a-zA-Z0-9\-\.]{0,251}[a-zA-Z0-9])?$/;
  if(ipv4.test(v)){
    return v.split('.').every(o => Number(o) >= 0 && Number(o) <= 255);
  }
  return hostname.test(v);
}

function markFieldValidity(input, valid, message){
  input.classList.toggle('invalid', !valid);
  let err = input.parentElement.querySelector('.field-error');
  if(!valid){
    if(!err){
      err = document.createElement('div');
      err.className = 'field-error';
      input.parentElement.appendChild(err);
    }
    err.textContent = message;
  } else if(err){
    err.remove();
  }
}

async function loadIncidentBanner(){
  const rows = await getJSON('/api/incidents?active_only=true');
  const el = document.getElementById('incidentBanner');
  if(rows.length === 0){
    el.classList.add('hidden');
    return;
  }
  const hasAlta = rows.some(r => r.severity === 'Alta');
  el.classList.remove('hidden');
  el.innerHTML = `<span class="banner-dot"></span> ${rows.length} incidente${rows.length>1?'s':''} ativo${rows.length>1?'s':''}${hasAlta ? ' — severidade Alta presente' : ''} — clique para ver detalhes`;
  el.onclick = () => {
    showPage('overview');
    const widget = document.querySelector('[data-widget="incidents"]');
    if(widget){
      widget.scrollIntoView({behavior:'smooth', block:'center'});
      widget.classList.remove('flash-highlight');
      void widget.offsetWidth; // reflow para reiniciar a animação
      widget.classList.add('flash-highlight');
    }
  };
}

(function initPage(){
  const saved = localStorage.getItem('netnoc_page') || 'overview';
  showPage(saved);
})();

const THEME_KEY = 'netnoc_theme';

function applyTheme(theme){
  document.documentElement.setAttribute('data-theme', theme);
  document.getElementById('themeSelect').value = theme;
  localStorage.setItem(THEME_KEY, theme);
}

document.getElementById('themeSelect').addEventListener('change', e => {
  applyTheme(e.target.value);
});

(function initTheme(){
  const saved = localStorage.getItem(THEME_KEY) || 'dark-blue';
  applyTheme(saved);
})();

const COLORS = ["#3ddc84", "#4d8dff", "#8a63ff", "#ffb23d", "#ff5c5c", "#2fd9d9"];
let currentRange = "5m";
let pingChart, jitterChart, lossChart, incidentsDonut;

function fmtTime(ts){
  return new Date(ts * 1000).toLocaleTimeString('pt-BR', {hour:'2-digit', minute:'2-digit'});
}

function baseChartOpts(yLabel){
  return {
    responsive:true,
    animation:false,
    interaction:{mode:'index', intersect:false},
    plugins:{legend:{labels:{color:'#8891ab', boxWidth:10}}},
    scales:{
      x:{ticks:{color:'#8891ab', maxTicksLimit:8}, grid:{color:'#232b45'}},
      y:{ticks:{color:'#8891ab'}, grid:{color:'#232b45'}, title:{display:!!yLabel, text:yLabel, color:'#8891ab'}}
    }
  };
}

function makeChart(ctx, opts){
  return new Chart(ctx, {type:'line', data:{datasets:[]}, options: opts});
}

async function getJSON(url, opts){
  const r = await fetch(url, opts);
  return r.json();
}

async function loadOverview(){
  const d = await getJSON('/api/overview');
  const dot = document.getElementById('dotInternet');
  const status = document.getElementById('internetStatus');
  if(d.internet_online){ dot.className='dot online'; status.textContent='Online'; }
  else { dot.className='dot offline'; status.textContent='Offline'; }

  document.getElementById('publicIp').textContent = d.public_ip || '--';
  document.getElementById('publicIpv6').textContent = d.public_ipv6 || '';
  document.getElementById('avgLatency').textContent = d.avg_latency != null ? d.avg_latency + ' ms' : '-- ms';
  document.getElementById('avgJitter').textContent = d.avg_jitter != null ? d.avg_jitter + ' ms' : '-- ms';
  document.getElementById('avgLoss').textContent = d.avg_loss_pct != null ? d.avg_loss_pct + ' %' : '-- %';

  if(d.speedtest){
    document.getElementById('speedDown').textContent = (d.speedtest.download ?? '--') + ' Mbps ↓';
    document.getElementById('speedUp').textContent = (d.speedtest.upload ?? '--') + ' Mbps ↑';
    document.getElementById('speedDownBig').textContent = d.speedtest.download ?? '--';
    document.getElementById('speedUpBig').textContent = d.speedtest.upload ?? '--';
    document.getElementById('speedLatBig').textContent = d.speedtest.latency ? d.speedtest.latency.toFixed(0) : '--';
  }

  document.getElementById('sysCpu').textContent = (d.cpu_pct ?? '--') + '%';
  document.getElementById('sysMem').textContent = (d.mem_pct ?? '--') + '%';
  document.getElementById('sysTemp').textContent = (d.temp_c ?? '--') + '°C';
  document.getElementById('barCpu').style.width = (d.cpu_pct || 0) + '%';
  document.getElementById('barMem').style.width = (d.mem_pct || 0) + '%';
  document.getElementById('barTemp').style.width = Math.min(100, ((d.temp_c || 0) / 90) * 100) + '%';
}

async function loadPingCharts(){
  const data = await getJSON(`/api/ping/history?range=${currentRange}`);
  const names = Object.keys(data);
  const labelsSet = new Set();
  names.forEach(n => data[n].forEach(r => labelsSet.add(fmtTime(r.ts))));
  const labels = Array.from(labelsSet);

  pingChart.data.labels = labels;
  pingChart.data.datasets = names.map((n,i) => ({
    label:`${getIcon(n)} ${n}`, data:data[n].map(r=>({x:fmtTime(r.ts), y:r.latency})),
    borderColor:COLORS[i%COLORS.length], backgroundColor:'transparent', tension:.3, pointRadius:0, borderWidth:2
  }));
  pingChart.update();

  jitterChart.data.labels = labels;
  jitterChart.data.datasets = names.map((n,i) => ({
    label:`${getIcon(n)} ${n}`, data:data[n].map(r=>({x:fmtTime(r.ts), y:r.jitter})),
    borderColor:COLORS[i%COLORS.length], backgroundColor:'transparent', tension:.3, pointRadius:0, borderWidth:2
  }));
  jitterChart.update();
}

async function loadLossChart(){
  const data = await getJSON(`/api/loss/history?range=${currentRange}`);
  const names = Object.keys(data);
  const buckets = 20;
  const datasets = names.map((n,i) => {
    const rows = data[n];
    const chunk = Math.max(1, Math.floor(rows.length / buckets));
    const points = [];
    for(let j=0;j<rows.length;j+=chunk){
      const slice = rows.slice(j, j+chunk);
      const fails = slice.filter(r=>!r.success).length;
      points.push({x: fmtTime(slice[0].ts), y: slice.length ? (fails/slice.length*100) : 0});
    }
    return {label:`${getIcon(n)} ${n}`, data:points, backgroundColor:COLORS[i%COLORS.length]};
  });
  lossChart.data.datasets = datasets;
  lossChart.data.labels = datasets[0] ? datasets[0].data.map(p=>p.x) : [];
  lossChart.update();
}

const ICON_RULES = [
  { match: /google/i, icon: '🔍' },
  { match: /cloudflare/i, icon: '☁️' },
  { match: /quad9/i, icon: '🛡️' },
  { match: /instagram/i, icon: '📷' },
  { match: /facebook/i, icon: '📘' },
  { match: /whatsapp/i, icon: '💬' },
  { match: /(twitter|\bx\.com)/i, icon: '🐦' },
  { match: /tiktok/i, icon: '🎵' },
  { match: /youtube/i, icon: '▶️' },
  { match: /netflix/i, icon: '🎬' },
  { match: /discord/i, icon: '🎮' },
  { match: /steam/i, icon: '🕹️' },
  { match: /valorant|riot/i, icon: '🎯' },
  { match: /(mikrotik|routeros)/i, icon: '📡' },
  { match: /(gateway|router|onu|olt)/i, icon: '🌐' },
  { match: /(vps|server|servidor)/i, icon: '🖥️' },
  { match: /(nas)/i, icon: '💾' },
];
const PRIVATE_IP = /^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;

function getIcon(name, host){
  const hay = `${name || ''} ${host || ''}`;
  for(const r of ICON_RULES){ if(r.match.test(hay)) return r.icon; }
  if(host && PRIVATE_IP.test(host)) return '🖥️';
  if(host && /^\d+\.\d+\.\d+\.\d+$/.test(host)) return '🌐';
  return '🌐';
}

const BRAND_RULES = [
  { match: /google/i, key: 'google' },
  { match: /cloudflare/i, key: 'cloudflare' },
  { match: /quad9/i, key: 'shield' },
  { match: /instagram/i, key: 'instagram' },
  { match: /facebook/i, key: 'facebook' },
  { match: /whatsapp/i, key: 'whatsapp' },
  { match: /(twitter|\bx\.com)/i, key: 'x' },
  { match: /tiktok/i, key: 'tiktok' },
  { match: /youtube/i, key: 'youtube' },
  { match: /netflix/i, key: 'netflix' },
  { match: /discord/i, key: 'discord' },
  { match: /steam/i, key: 'steam' },
  { match: /valorant/i, key: 'valorant' },
  { match: /riot/i, key: 'riotgames' },
  { match: /(mikrotik|routeros)/i, key: 'mikrotik' },
  { match: /(gateway|router|onu|olt)/i, key: 'gateway' },
  { match: /(vps|server|servidor)/i, key: 'server' },
  { match: /(nas)/i, key: 'nas' },
];

function getIconHtml(name, host){
  const hay = `${name || ''} ${host || ''}`;
  let key = null;
  for(const r of BRAND_RULES){ if(r.match.test(hay)){ key = r.key; break; } }
  if(!key){
    key = (host && PRIVATE_IP.test(host)) ? 'server' : 'globe';
  }
  const svg = (typeof BRAND_ICONS !== 'undefined' && BRAND_ICONS[key]) ? BRAND_ICONS[key] : '';
  return `<span class="icon-badge">${svg}</span>`;
}

async function loadTargets(){
  const rows = await getJSON('/api/targets');
  const tbody = document.getElementById('targetsBody');
  tbody.innerHTML = rows.map(r => `
    <tr>
      <td class="name-cell">${getIconHtml(r.name, r.host)} ${r.name}</td>
      <td>${r.host}</td>
      <td><span class="status-pill ${r.online ? 'online':'offline'}">${r.online ? 'Online':'Offline'}</span></td>
      <td>${r.latency != null ? r.latency.toFixed(0)+' ms' : '-'}</td>
      <td>${r.jitter != null ? r.jitter.toFixed(0)+' ms' : '-'}</td>
      <td>${r.loss_pct != null ? r.loss_pct+'%' : '-'}</td>
      <td>${r.uptime_24h != null ? r.uptime_24h+'%' : '-'}</td>
    </tr>`).join('');
}

async function loadDns(){
  const rows = await getJSON('/api/dns');
  const el = document.getElementById('dnsList');
  el.innerHTML = rows.map(r => {
    const cls = r.latency > 150 ? 'bad' : (r.latency > 80 ? 'high' : '');
    return `<div class="dns-item"><span>${r.name}</span><span class="lat ${cls}">${r.latency != null ? r.latency.toFixed(0)+' ms' : '-'}</span></div>`;
  }).join('');
}

function iconForMessage(msg){
  return getIconHtml(msg, '');
}

async function loadEvents(){
  const rows = await getJSON('/api/events?limit=30');
  const el = document.getElementById('eventsList');
  el.innerHTML = rows.map(r => `
    <div class="event-item">
      <span class="event-time">${fmtTime(r.ts)}</span>
      <span class="event-msg">${iconForMessage(r.message)} ${r.message}</span>
      <span class="sev ${r.severity}">${r.severity}</span>
    </div>`).join('');
}

async function loadIncidents(){
  const rows = await getJSON('/api/incidents?active_only=true');
  document.getElementById('incidentCount').textContent = rows.length;
  const el = document.getElementById('incidentsList');
  if(rows.length === 0){
    el.innerHTML = '<div style="color:var(--muted);font-size:13px;">Nenhum incidente ativo</div>';
    return;
  }
  el.innerHTML = rows.map(r => `
    <div class="incident-item">
      <span>${iconForMessage(r.target + ' ' + r.message)} ${r.message}</span>
      <span class="sev ${r.severity}">${r.severity}</span>
    </div>`).join('');
}

async function loadIncidentsSummary(){
  const d = await getJSON('/api/incidents/summary?days=7');
  const labels = Object.keys(d);
  const values = Object.values(d);
  const colorMap = {Alta:'#ff5c5c', Media:'#ffb23d', Baixa:'#4d8dff', Info:'#8a63ff'};
  incidentsDonut.data.labels = labels;
  incidentsDonut.data.datasets = [{data:values, backgroundColor:labels.map(l=>colorMap[l])}];
  incidentsDonut.update();
}

async function loadSettings(){
  const d = await getJSON('/api/settings');

  document.getElementById('listTargets').innerHTML = d.targets.map(t => `
    <div class="settings-item">
      <span>${getIconHtml(t.name, t.host)} ${t.name} — ${t.host}</span>
      <button data-kind="target" data-name="${t.name}" title="Remover">✕</button>
    </div>`).join('') || '<div style="color:var(--muted);font-size:12px;">Nenhum destino cadastrado</div>';

  document.getElementById('listDns').innerHTML = d.dns_servers.map(s => `
    <div class="settings-item">
      <span>${s.name} — ${s.ip}</span>
      <button data-kind="dns" data-name="${s.name}" title="Remover">✕</button>
    </div>`).join('') || '<div style="color:var(--muted);font-size:12px;">Nenhum servidor DNS cadastrado</div>';
}

async function handleSettingsClick(e){
  const btn = e.target.closest('button[data-kind]');
  if(!btn) return;
  const kind = btn.dataset.kind;
  if(!confirm(`Remover "${btn.dataset.name}"?`)) return;
  try{
    if(kind === 'target'){
      await fetch(`/api/settings/targets/${encodeURIComponent(btn.dataset.name)}`, {method:'DELETE'});
    } else if(kind === 'dns'){
      await fetch(`/api/settings/dns/${encodeURIComponent(btn.dataset.name)}`, {method:'DELETE'});
    }
    await loadSettings();
    showToast(`"${btn.dataset.name}" removido.`);
  }catch(err){ showToast('Erro ao remover: ' + err, 'error'); }
}

document.getElementById('listTargets').addEventListener('click', handleSettingsClick);
document.getElementById('listDns').addEventListener('click', handleSettingsClick);

document.getElementById('formTarget').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const hostInput = e.target.elements['host'];
  if(!isValidHost(f.get('host'))){
    markFieldValidity(hostInput, false, 'IP ou host inválido');
    showToast('Informe um IP ou host válido.', 'error');
    return;
  }
  markFieldValidity(hostInput, true);
  const r = await fetch('/api/settings/targets', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({name:f.get('name'), host:f.get('host')})
  });
  if(!r.ok){ const j = await r.json(); showToast(j.detail || 'Erro ao adicionar', 'error'); return; }
  e.target.reset();
  await loadSettings();
  showToast(`Destino "${f.get('name')}" adicionado.`);
});

document.getElementById('formDns').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const ipInput = e.target.elements['ip'];
  if(!isValidHost(f.get('ip'))){
    markFieldValidity(ipInput, false, 'IP inválido');
    showToast('Informe um IP válido.', 'error');
    return;
  }
  markFieldValidity(ipInput, true);
  const r = await fetch('/api/settings/dns', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({name:f.get('name'), ip:f.get('ip')})
  });
  if(!r.ok){ const j = await r.json(); showToast(j.detail || 'Erro ao adicionar', 'error'); return; }
  e.target.reset();
  await loadSettings();
  showToast(`Servidor DNS "${f.get('name')}" adicionado.`);
});

function applyAppName(name, version){
  document.title = `${name} - Monitoramento de Rede`;
  document.getElementById('brandName').innerHTML = `🛰 ${name}`;
  if(version){
    document.getElementById('brandVersion').textContent = `v${version}`;
    document.getElementById('versionDisplay').textContent = `v${version}`;
  }
}

async function loadAppName(){
  const d = await getJSON('/api/settings/appname');
  applyAppName(d.name, d.version);
  document.getElementById('appNameInput').value = d.name;
}

document.getElementById('formAppName').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const name = f.get('app_name').trim();
  if(!name) return;
  const r = await fetch('/api/settings/appname', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({name})
  });
  if(!r.ok){ const j = await r.json(); showToast(j.detail || 'Erro ao salvar', 'error'); return; }
  const j = await r.json();
  applyAppName(name, j.version);
  showToast('Nome da aplicação atualizado.');
});

document.getElementById('clearHistoryBtn').addEventListener('click', async () => {
  if(!confirm('Isso vai apagar TODO o histórico (pings, DNS, incidentes, eventos, speedtests). Confirmar?')) return;
  await fetch('/api/history/clear', {method:'POST'});
  await refreshAll();
  showToast('Histórico limpo.');
});

async function loadAvailability(){
  const data = await getJSON('/api/uptime/bars?hours=24');
  const el = document.getElementById('availabilityList');
  const names = Object.keys(data);
  if(names.length === 0){
    el.innerHTML = '<div class="insight-empty">Sem destinos cadastrados</div>';
    return;
  }
  el.innerHTML = names.map(name => {
    const bars = data[name];
    const okCount = bars.filter(b => b.pct != null).length;
    const avgPct = okCount ? (bars.reduce((s,b)=> s + (b.pct||0), 0) / okCount).toFixed(1) : '-';
    const barsHtml = bars.map(b => {
      let cls = 'nodata';
      if(b.pct != null){
        cls = b.pct >= 98 ? 'ok' : (b.pct >= 90 ? 'warn' : 'bad');
      }
      const label = b.pct != null ? `${fmtTime(b.ts)} — ${b.pct}%` : `${fmtTime(b.ts)} — sem dados`;
      return `<div class="avail-bar ${cls}" title="${label}"></div>`;
    }).join('');
    return `
      <div class="avail-row">
        <div class="avail-row-label"><span>${getIconHtml(name,'')} ${name}</span><span>${avgPct}%</span></div>
        <div class="avail-bars">${barsHtml}</div>
      </div>`;
  }).join('');
}

async function loadInsights(){
  const rows = await getJSON('/api/insights/patterns?days=30');
  const el = document.getElementById('insightsList');
  if(rows.length === 0){
    el.innerHTML = '<div class="insight-empty">Nenhum padrão relevante encontrado ainda (precisa de mais histórico).</div>';
    return;
  }
  el.innerHTML = rows.map(r => `
    <div class="insight-item">${getIconHtml(r.target,'')} ${r.message}</div>
  `).join('');
}

async function loadIntervalsSettings(){
  const d = await getJSON('/api/settings/intervals');
  const f = document.getElementById('formIntervals');
  for(const key of Object.keys(d)){
    if(f.elements[key]) f.elements[key].value = d[key];
  }
}

document.getElementById('formIntervals').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const body = {};
  for(const [k,v] of f.entries()) body[k] = parseInt(v);
  const invalid = Object.entries(body).filter(([k,v]) => !Number.isFinite(v) || v <= 0);
  if(invalid.length){
    showToast('Os intervalos precisam ser números maiores que zero.', 'error');
    return;
  }
  await fetch('/api/settings/intervals', {
    method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body)
  });
  showToast('Intervalos salvos. Passam a valer no próximo ciclo de cada worker.');
});

async function loadTelegramSettings(){
  const d = await getJSON('/api/settings/telegram');
  const f = document.getElementById('formTelegram');
  f.elements['enabled'].checked = !!d.enabled;
  f.elements['bot_token'].value = d.bot_token || '';
  f.elements['chat_id'].value = d.chat_id || '';
  f.elements['min_severity'].value = d.min_severity || 'Alta';
}

document.getElementById('formTelegram').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const enabled = f.get('enabled') === 'on';
  const bot_token = f.get('bot_token') || '';
  const chat_id = f.get('chat_id') || '';
  if(enabled && (!bot_token.trim() || !chat_id.trim())){
    showToast('Preencha Bot Token e Chat ID para ativar os alertas.', 'error');
    return;
  }
  const body = {
    enabled, bot_token, chat_id,
    min_severity: f.get('min_severity')
  };
  await fetch('/api/settings/telegram', {
    method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body)
  });
  showToast('Configuração do Telegram salva.');
  await loadTelegramSettings();
});

document.getElementById('testTelegramBtn').addEventListener('click', async () => {
  const btn = document.getElementById('testTelegramBtn');
  btn.disabled = true;
  const original = btn.textContent;
  btn.textContent = 'Enviando...';
  try{
    const r = await fetch('/api/settings/telegram/test', {method:'POST'});
    if(r.ok){ showToast('Mensagem de teste enviada! Confira o Telegram.'); }
    else { const j = await r.json(); showToast(j.detail || 'Não foi possível enviar', 'error'); }
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
});

async function refreshAll(){
  await Promise.all([
    loadOverview(), loadPingCharts(), loadLossChart(), loadTargets(),
    loadDns(), loadEvents(), loadIncidents(), loadIncidentsSummary(),
    loadAvailability(), loadInsights(), loadIncidentBanner()
  ]);
}

document.getElementById('rangeSelect').addEventListener('change', e => {
  currentRange = e.target.value;
  loadPingCharts(); loadLossChart();
});

document.getElementById('runSpeedtest').addEventListener('click', async (e) => {
  e.target.disabled = true; e.target.textContent = 'Testando...';
  await getJSON('/api/speedtest/run', {method:'POST'});
  await loadOverview();
  e.target.disabled = false; e.target.textContent = 'Executar Teste';
});

window.addEventListener('load', () => {
  pingChart = makeChart(document.getElementById('pingChart'), baseChartOpts('ms'));
  jitterChart = makeChart(document.getElementById('jitterChart'), baseChartOpts('ms'));
  lossChart = new Chart(document.getElementById('lossChart'), {
    type:'bar', data:{datasets:[]}, options: baseChartOpts('%')
  });
  incidentsDonut = new Chart(document.getElementById('incidentsDonut'), {
    type:'doughnut',
    data:{labels:[], datasets:[]},
    options:{plugins:{legend:{position:'bottom', labels:{color:'#8891ab'}}}}
  });
  applyLayout();
  initDragAndDrop();
  refreshAll();
  loadSettings();
  loadIntervalsSettings();
  loadTelegramSettings();
  loadAppName();
  setInterval(refreshAll, 5000);
});
