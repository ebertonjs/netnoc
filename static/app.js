// ---------- Layout livre dos cards (arrastar + redimensionar, como na Topologia) ----------
const WIDGET_LAYOUT_KEY = 'netnoc_widget_layout';
const WIDGET_DEFAULT_LAYOUT_KEY = 'netnoc_widget_default_layout';
const WIDGET_META_KEY = 'netnoc_widget_meta';
const GRID_SNAP = 10;
const MIN_W = 240;
const MIN_H = 120;

function loadWidgetLayout(){
  try{ return JSON.parse(localStorage.getItem(WIDGET_LAYOUT_KEY)) || {}; }catch(e){ return {}; }
}
function saveWidgetLayoutFor(id, patch){
  const layout = loadWidgetLayout();
  layout[id] = Object.assign({}, layout[id], patch);
  localStorage.setItem(WIDGET_LAYOUT_KEY, JSON.stringify(layout));
}
function loadWidgetMeta(){
  try{ return JSON.parse(localStorage.getItem(WIDGET_META_KEY)) || {}; }catch(e){ return {}; }
}
function saveWidgetMetaFor(id, patch){
  const meta = loadWidgetMeta();
  meta[id] = Object.assign({}, meta[id], patch);
  localStorage.setItem(WIDGET_META_KEY, JSON.stringify(meta));
}
function cleanHeaderLabel(span){
  if(!span) return '';
  const clone = span.cloneNode(true);
  clone.querySelectorAll('span,select,button,input').forEach(n => n.remove());
  return clone.textContent.replace('⠿','').trim();
}
function getWidgetDefs(){
  const grid = document.getElementById('widgetsGrid');
  if(!grid) return [];
  return Array.from(grid.querySelectorAll('.widget')).map(w => ({
    el: w,
    id: w.dataset.widget,
    label: cleanHeaderLabel(w.querySelector('.panel-header > span')) || w.dataset.widget
  }));
}
function snap(v){ return Math.round(v / GRID_SNAP) * GRID_SNAP; }

// Mede a posição/tamanho atuais (resultado do CSS grid original) para usar como
// layout padrão na primeira vez que o usuário abre a dash, antes de existir algo salvo.
function measureDefaultLayout(){
  const grid = document.getElementById('widgetsGrid');
  const gridRect = grid.getBoundingClientRect();
  const layout = {};
  grid.querySelectorAll('.widget').forEach(w => {
    const r = w.getBoundingClientRect();
    layout[w.dataset.widget] = {
      x: snap(r.left - gridRect.left),
      y: snap(r.top - gridRect.top),
      w: snap(r.width),
      h: snap(r.height),
    };
  });
  return layout;
}

function applyWidgetPosition(el, pos){
  el.style.left = pos.x + 'px';
  el.style.top = pos.y + 'px';
  el.style.width = pos.w + 'px';
  el.style.minHeight = pos.h + 'px';
}

function recalcGridHeight(){
  const grid = document.getElementById('widgetsGrid');
  if(!grid) return;
  let maxBottom = 0;
  grid.querySelectorAll('.widget').forEach(w => {
    if(w.classList.contains('widget-hidden')) return;
    const bottom = w.offsetTop + w.offsetHeight;
    if(bottom > maxBottom) maxBottom = bottom;
  });
  grid.style.height = (maxBottom + 20) + 'px';
}

// Reorganiza os cards visíveis num masonry de colunas (sem sobreposição), preservando
// a largura relativa de cada card e a ordem de leitura atual (topo→baixo, esquerda→direita).
function autoArrangeWidgets(){
  const grid = document.getElementById('widgetsGrid');
  if(!grid) return;
  const cols = 3;
  const gap = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--density-gap')) || 14;
  const gridWidth = grid.getBoundingClientRect().width;
  const colWidth = (gridWidth - gap * (cols - 1)) / cols;

  const defs = getWidgetDefs().filter(({el}) => !el.classList.contains('widget-hidden'));
  // Ordena pela posição atual (leitura: topo → baixo, esquerda → direita) pra manter o agrupamento que o usuário já fez
  defs.sort((a, b) => {
    const ay = Math.round(a.el.offsetTop / 40), by = Math.round(b.el.offsetTop / 40);
    if(ay !== by) return ay - by;
    return a.el.offsetLeft - b.el.offsetLeft;
  });

  const colHeights = new Array(cols).fill(0);
  defs.forEach(({el, id}) => {
    const span = Math.max(1, Math.min(cols, Math.round((el.offsetWidth + gap) / (colWidth + gap))));
    let bestStart = 0, bestHeight = Infinity;
    for(let start = 0; start <= cols - span; start++){
      const h = Math.max(...colHeights.slice(start, start + span));
      if(h < bestHeight){ bestHeight = h; bestStart = start; }
    }
    const x = bestStart * (colWidth + gap);
    const y = bestHeight;
    const w = span * colWidth + (span - 1) * gap;
    const h = el.offsetHeight;
    applyWidgetPosition(el, {x, y, w, h});
    saveWidgetLayoutFor(id, {x, y, w, h});
    for(let i = bestStart; i < bestStart + span; i++) colHeights[i] = y + h + gap;
  });

  recalcGridHeight();
  showToast('Layout reorganizado automaticamente', 'success');
}
document.getElementById('autoArrangeBtn')?.addEventListener('click', autoArrangeWidgets);
document.getElementById('autoArrangeBtn2')?.addEventListener('click', autoArrangeWidgets);

function initWidgetAppearance(){
  const grid = document.getElementById('widgetsGrid');
  if(!grid) return;
  // Mede o arranjo original (grid CSS) ANTES de ativar o modo livre — precisa ser feito
  // sempre nesse momento, pois depois que o grid vira "free-grid" a informação se perde.
  // O snapshot fica salvo para uso posterior em resets individuais (sem precisar recarregar a página).
  const defaultLayout = measureDefaultLayout();
  localStorage.setItem(WIDGET_DEFAULT_LAYOUT_KEY, JSON.stringify(defaultLayout));

  let layout = loadWidgetLayout();
  const hasSaved = Object.keys(layout).length > 0;
  if(!hasSaved) layout = defaultLayout;

  grid.classList.add('free-grid');

  const defs = getWidgetDefs();
  const meta = loadWidgetMeta();

  defs.forEach(({el, id}) => {
    el.removeAttribute('draggable');
    el.classList.remove('widget-wide', 'widget-full', 'widget-size-2', 'widget-size-full');

    const pos = layout[id] || {x:0, y:0, w:340, h:220};
    applyWidgetPosition(el, pos);

    const m = meta[id] || {};
    el.classList.toggle('widget-hidden', !!m.hidden);

    attachWidgetInteractions(el, id);
  });

  if(!hasSaved) localStorage.setItem(WIDGET_LAYOUT_KEY, JSON.stringify(layout));
  recalcGridHeight();
  renderWidgetManagerList();
}

function attachWidgetInteractions(el, id){
  const header = el.querySelector('.panel-header.drag-handle');
  if(!header) return;

  // Menu (⋮): ocultar / restaurar posição individual
  if(!header.querySelector('.widget-menu-wrap')){
    const wrap = document.createElement('div');
    wrap.className = 'widget-menu-wrap';
    wrap.innerHTML = `
      <button type="button" class="widget-menu-btn" title="Opções do card">⋮</button>
      <div class="widget-menu-dropdown">
        <button type="button" data-action="hide">🙈 Ocultar card</button>
        <button type="button" data-action="reset">↺ Restaurar posição/tamanho</button>
      </div>`;
    header.appendChild(wrap);

    const btn = wrap.querySelector('.widget-menu-btn');
    const dropdown = wrap.querySelector('.widget-menu-dropdown');
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      document.querySelectorAll('.widget-menu-dropdown.open').forEach(d => { if(d !== dropdown) d.classList.remove('open'); });
      dropdown.classList.toggle('open');
    });
    wrap.querySelector('[data-action="hide"]').addEventListener('click', () => {
      el.classList.add('widget-hidden');
      saveWidgetMetaFor(id, {hidden:true});
      dropdown.classList.remove('open');
      recalcGridHeight();
      renderWidgetManagerList();
    });
    wrap.querySelector('[data-action="reset"]').addEventListener('click', () => {
      let defaults = {};
      try{ defaults = JSON.parse(localStorage.getItem(WIDGET_DEFAULT_LAYOUT_KEY)) || {}; }catch(e){}
      const def = defaults[id];
      if(def){
        applyWidgetPosition(el, def);
        saveWidgetLayoutFor(id, def);
        recalcGridHeight();
      }
      dropdown.classList.remove('open');
    });
  }

  // Alça de redimensionar (canto inferior direito)
  if(!el.querySelector('.resize-handle')){
    const handle = document.createElement('div');
    handle.className = 'resize-handle';
    handle.title = 'Arraste para redimensionar';
    el.appendChild(handle);

    handle.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      handle.setPointerCapture(e.pointerId);
      const startX = e.clientX, startY = e.clientY;
      const startW = el.offsetWidth, startH = el.offsetHeight;
      el.classList.add('resizing');

      function onMove(ev){
        const w = Math.max(MIN_W, snap(startW + (ev.clientX - startX)));
        const h = Math.max(MIN_H, snap(startH + (ev.clientY - startY)));
        el.style.width = w + 'px';
        el.style.minHeight = h + 'px';
        recalcGridHeight();
      }
      function onUp(){
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('pointerup', onUp);
        el.classList.remove('resizing');
        saveWidgetLayoutFor(id, {w: el.offsetWidth, h: el.offsetHeight});
      }
      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup', onUp);
    });
  }

  // Arrastar pelo cabeçalho para reposicionar livremente (não dispara em botões/selects/menu)
  header.addEventListener('pointerdown', (e) => {
    if(e.target.closest('button, select, input, .widget-menu-wrap')) return;
    e.preventDefault();
    header.setPointerCapture(e.pointerId);
    const grid = document.getElementById('widgetsGrid');
    const gridRect = grid.getBoundingClientRect();
    const startX = e.clientX, startY = e.clientY;
    const startLeft = el.offsetLeft, startTop = el.offsetTop;
    let moved = false;

    function onMove(ev){
      moved = true;
      let x = startLeft + (ev.clientX - startX);
      let y = startTop + (ev.clientY - startY);
      x = Math.max(0, Math.min(x, gridRect.width - el.offsetWidth));
      y = Math.max(0, y);
      el.style.left = snap(x) + 'px';
      el.style.top = snap(y) + 'px';
      el.classList.add('being-dragged');
      recalcGridHeight();
    }
    function onUp(){
      header.removeEventListener('pointermove', onMove);
      header.removeEventListener('pointerup', onUp);
      el.classList.remove('being-dragged');
      if(moved) saveWidgetLayoutFor(id, {x: el.offsetLeft, y: el.offsetTop});
    }
    header.addEventListener('pointermove', onMove);
    header.addEventListener('pointerup', onUp);
  });
}

document.addEventListener('click', () => {
  document.querySelectorAll('.widget-menu-dropdown.open').forEach(d => d.classList.remove('open'));
});

function renderWidgetManagerList(){
  const container = document.getElementById('widgetManagerList');
  if(!container) return;
  const defs = getWidgetDefs();
  const meta = loadWidgetMeta();
  container.innerHTML = defs.map(({id, label}) => {
    const hidden = !!(meta[id] || {}).hidden;
    return `
      <div class="widget-manager-row" data-widget-id="${id}">
        <label class="wm-name"><input type="checkbox" class="wm-visible-toggle" ${hidden ? '' : 'checked'}> ${label}</label>
      </div>`;
  }).join('') || '<div class="version-hint">Nenhum card encontrado.</div>';

  container.querySelectorAll('.widget-manager-row').forEach(row => {
    const id = row.dataset.widgetId;
    const el = document.querySelector(`#widgetsGrid [data-widget="${id}"]`);
    row.querySelector('.wm-visible-toggle').addEventListener('change', (e) => {
      const hidden = !e.target.checked;
      if(el) el.classList.toggle('widget-hidden', hidden);
      saveWidgetMetaFor(id, {hidden});
      recalcGridHeight();
    });
  });
}

document.getElementById('resetLayoutBtn')?.addEventListener('click', () => {
  localStorage.removeItem(WIDGET_LAYOUT_KEY);
  location.reload();
});

// ---------- Densidade (Aparência → Layout) ----------
const DENSITY_KEY = 'netnoc_density';
function applyDensity(value){
  document.documentElement.setAttribute('data-density', value);
  const sel = document.getElementById('densitySelect');
  if(sel) sel.value = value;
  localStorage.setItem(DENSITY_KEY, value);
}
document.getElementById('densitySelect')?.addEventListener('change', e => applyDensity(e.target.value));
(function initDensity(){
  applyDensity(localStorage.getItem(DENSITY_KEY) || 'comfortable');
})();

// ---------- Sub-tabs (dentro da aba Aparência) ----------
document.querySelectorAll('.sub-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    const wrap = tab.closest('.panel');
    wrap.querySelectorAll('.sub-tab').forEach(t => t.classList.toggle('active', t === tab));
    wrap.querySelectorAll('.sub-tab-panel').forEach(p => p.classList.toggle('active', p.dataset.subtabPanel === tab.dataset.subtab));
  });
});

// ---------- Editor de cores custom (Aparência → Cores) ----------
const CUSTOM_THEME_KEY = 'netnoc_custom_theme';
const COLOR_VARS = [
  {key:'bg', label:'Fundo'},
  {key:'panel', label:'Painel'},
  {key:'panel2', label:'Painel (alt)'},
  {key:'border', label:'Borda'},
  {key:'text', label:'Texto'},
  {key:'accent', label:'Destaque'},
  {key:'green', label:'Verde (ok)'},
  {key:'red', label:'Vermelho (erro)'},
  {key:'orange', label:'Laranja (alerta)'},
  {key:'blue', label:'Azul'},
  {key:'purple', label:'Roxo'},
];
const THEME_PRESETS = {
  'dark-blue': {bg:'#0b0f19', panel:'#11172a', panel2:'#161d33', border:'#232b45', text:'#e6e9f2', accent:'#4d8dff', green:'#3ddc84', red:'#ff5c5c', orange:'#ffb23d', blue:'#4d8dff', purple:'#8a63ff'},
  'dark-green': {bg:'#0a120d', panel:'#0f1c14', panel2:'#142418', border:'#1f3526', text:'#dff5e6', accent:'#4dd0e1', green:'#39e07a', red:'#ff6b6b', orange:'#f0b74e', blue:'#4dd0e1', purple:'#7ad48f'},
  'dark-purple': {bg:'#100b1c', panel:'#181227', panel2:'#20182f', border:'#332a49', text:'#ece6f9', accent:'#8a7dff', green:'#4de0a0', red:'#ff6f91', orange:'#ffb56b', blue:'#8a7dff', purple:'#c084fc'},
  'midnight-oled': {bg:'#000000', panel:'#0a0a0a', panel2:'#131313', border:'#232323', text:'#f0f0f0', accent:'#5c9dff', green:'#3ddc84', red:'#ff5c5c', orange:'#ffb23d', blue:'#5c9dff', purple:'#a37bff'},
  'light': {bg:'#f4f6fb', panel:'#ffffff', panel2:'#eef1f8', border:'#dbe1ee', text:'#131a2b', accent:'#2f6fe0', green:'#1fa15c', red:'#e0453f', orange:'#d98b1f', blue:'#2f6fe0', purple:'#6c47d6'},
};

function loadCustomTheme(){
  try{ return JSON.parse(localStorage.getItem(CUSTOM_THEME_KEY)); }catch(e){ return null; }
}
function applyCustomThemeVars(vars){
  const root = document.documentElement;
  COLOR_VARS.forEach(({key}) => {
    if(vars[key]) root.style.setProperty(`--${key}`, vars[key]);
  });
}
function clearCustomThemeVars(){
  const root = document.documentElement;
  COLOR_VARS.forEach(({key}) => root.style.removeProperty(`--${key}`));
}
function ensureCustomOptionInSelects(){
  [document.getElementById('themeSelect')].forEach(sel => {
    if(sel && !sel.querySelector('option[value="custom"]')){
      const opt = document.createElement('option');
      opt.value = 'custom';
      opt.textContent = '🎨 Personalizado';
      sel.appendChild(opt);
    }
  });
}
function removeCustomOptionFromSelects(){
  document.querySelectorAll('option[value="custom"]').forEach(o => o.parentElement.removeChild(o));
}
function renderColorPickers(baseTheme){
  const container = document.getElementById('colorPickerGrid');
  if(!container) return;
  const custom = loadCustomTheme();
  const source = custom || THEME_PRESETS[baseTheme] || THEME_PRESETS['dark-blue'];
  container.innerHTML = COLOR_VARS.map(({key,label}) => `
    <div class="color-picker-item">
      <label for="cpick-${key}">${label}</label>
      <input type="color" id="cpick-${key}" data-key="${key}" value="${source[key] || '#000000'}">
    </div>`).join('');

  container.querySelectorAll('input[type="color"]').forEach(input => {
    input.addEventListener('input', (e) => {
      document.documentElement.style.setProperty(`--${e.target.dataset.key}`, e.target.value);
    });
  });
}
document.getElementById('themeBaseSelect')?.addEventListener('change', e => {
  clearCustomThemeVars();
  applyTheme(e.target.value);
  renderColorPickers(e.target.value);
});
document.getElementById('saveCustomThemeBtn')?.addEventListener('click', () => {
  const vars = {};
  document.querySelectorAll('#colorPickerGrid input[type="color"]').forEach(input => {
    vars[input.dataset.key] = input.value;
  });
  localStorage.setItem(CUSTOM_THEME_KEY, JSON.stringify(vars));
  ensureCustomOptionInSelects();
  document.documentElement.setAttribute('data-theme', 'custom');
  applyCustomThemeVars(vars);
  localStorage.setItem(THEME_KEY, 'custom');
  const sel = document.getElementById('themeSelect');
  if(sel) sel.value = 'custom';
  showToast('Tema personalizado salvo', 'success');
});
document.getElementById('resetCustomThemeBtn')?.addEventListener('click', () => {
  localStorage.removeItem(CUSTOM_THEME_KEY);
  clearCustomThemeVars();
  removeCustomOptionFromSelects();
  const base = document.getElementById('themeBaseSelect')?.value || 'dark-blue';
  applyTheme(base);
  renderColorPickers(base);
  showToast('Tema restaurado para o preset', 'success');
});

// ---------- Restaurar tudo (Aparência) ----------
document.getElementById('restoreAllBtn')?.addEventListener('click', () => {
  [WIDGET_LAYOUT_KEY, WIDGET_DEFAULT_LAYOUT_KEY, WIDGET_META_KEY, DENSITY_KEY, CUSTOM_THEME_KEY, THEME_KEY].forEach(k => localStorage.removeItem(k));
  location.reload();
});

const PAGE_TITLES = {
  overview: ["Visão Geral", "Monitoramento em tempo real da sua rede"],
  topologia: ["Topologia", "Mapa de rede interativo — arraste, dê zoom, clique para inspecionar"],
  config: ["Configurações", "Destinos, DNS, intervalos e alertas"],
};

function showPage(page){
  document.querySelectorAll('.page').forEach(p => p.classList.toggle('active', p.dataset.page === page));
  document.querySelectorAll('nav a').forEach(a => a.classList.toggle('active', a.dataset.page === page));
  const [title, subtitle] = PAGE_TITLES[page] || PAGE_TITLES.overview;
  document.querySelector('.topbar h1').textContent = title;
  document.querySelector('.topbar p').textContent = subtitle;
  localStorage.setItem('netnoc_page', page);
  if(page === 'topologia' && typeof onTopologyPageShown === 'function'){
    onTopologyPageShown();
  }
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
    if(tab.dataset.tab === 'mikrotik') loadDhcpHosts();
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
  const sel = document.getElementById('themeSelect');
  if(sel) sel.value = theme;
  localStorage.setItem(THEME_KEY, theme);
  if(theme === 'custom'){
    const custom = loadCustomTheme();
    if(custom) applyCustomThemeVars(custom);
  } else {
    clearCustomThemeVars();
  }
}

document.getElementById('themeSelect').addEventListener('change', e => {
  applyTheme(e.target.value);
  const base = document.getElementById('themeBaseSelect');
  if(e.target.value !== 'custom' && base){
    base.value = e.target.value;
    renderColorPickers(e.target.value);
  }
});

(function initTheme(){
  const saved = localStorage.getItem(THEME_KEY) || 'dark-blue';
  const custom = loadCustomTheme();
  if(custom) ensureCustomOptionInSelects();
  applyTheme(saved);
  const baseSel = document.getElementById('themeBaseSelect');
  const baseForPickers = (saved === 'custom') ? (baseSel?.value || 'dark-blue') : saved;
  renderColorPickers(baseForPickers);
})();

const COLORS = ["#3ddc84", "#4d8dff", "#8a63ff", "#ffb23d", "#ff5c5c", "#2fd9d9"];
let currentRange = "5m";
let pingChart, jitterChart, lossChart, incidentsDonut, mikrotikIfaceChart, aghChart;
let mikrotikSelectedIface = null;
let mikrotikShowDisabled = false;

function barLevel(pct, warn=70, danger=90){
  if(pct >= danger) return 'danger';
  if(pct >= warn) return 'warn';
  return '';
}
function setBar(fillEl, pct, baseClass, warn, danger){
  fillEl.style.width = (pct || 0) + '%';
  fillEl.className = 'bar-fill ' + baseClass + ' ' + barLevel(pct || 0, warn, danger);
}

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

function fmtBps(bps){
  if(bps == null) return '--';
  if(bps >= 1_000_000) return (bps/1_000_000).toFixed(1) + ' Mbps';
  if(bps >= 1_000) return (bps/1_000).toFixed(0) + ' Kbps';
  return Math.round(bps) + ' bps';
}

function fmtUptime(seconds){
  if(seconds == null) return '--';
  const d = Math.floor(seconds/86400), h = Math.floor((seconds%86400)/3600), m = Math.floor((seconds%3600)/60);
  if(d) return `${d}d ${h}h`;
  if(h) return `${h}h ${m}m`;
  return `${m}m`;
}

async function loadMikrotikStatus(){
  const s = await getJSON('/api/mikrotik/status');
  const dot = document.getElementById('dotMikrotik');
  const body = document.getElementById('mikrotikBody');
  const offline = document.getElementById('mikrotikOffline');

  if(!s.enabled || !s.ts){
    body.classList.add('hidden');
    offline.classList.remove('hidden');
    dot.className = 'dot';
    return;
  }
  body.classList.remove('hidden');
  offline.classList.add('hidden');
  dot.className = 'dot ' + (s.stale ? 'offline' : 'online');

  document.getElementById('mkBoard').textContent = s.board_name || '--';
  document.getElementById('mkVersion').textContent = s.version || '--';
  document.getElementById('mkUptime').textContent = fmtUptime(s.uptime_s);
  document.getElementById('mkCpu').textContent = (s.cpu_load ?? '--') + '%';
  setBar(document.getElementById('mkBarCpu'), s.cpu_load, 'cpu', 70, 90);
  document.getElementById('mkMem').textContent = (s.mem_pct ?? '--') + '%';
  setBar(document.getElementById('mkBarMem'), s.mem_pct, 'mem', 75, 90);

  const tempRow = document.getElementById('mkTempRow');
  if(s.temperature != null){
    tempRow.classList.remove('hidden');
    document.getElementById('mkTemp').textContent = s.temperature + '°C';
  } else {
    tempRow.classList.add('hidden');
  }
}

// Ordem física das portas do hAP ax2 (internet, 2, 3, 4, 5) mapeada pros
// nomes que o RouterOS expõe em /interface. Ajuste aqui se o seu device
// renomeou as portas (ex: "ether1-gateway").
const MK_PORT_ORDER = ['ether1', 'ether2', 'ether3', 'ether4', 'ether5'];

function renderMikrotikPortPanel(allRows){
  const byName = Object.fromEntries(allRows.map(r => [r.name, r]));
  document.querySelectorAll('.mk-port-box').forEach(box => {
    const idx = Number(box.dataset.portIndex);
    const portName = MK_PORT_ORDER[idx];
    const row = byName[portName];
    box.classList.remove('online', 'offline');
    if(row) box.classList.add(row.running ? 'online' : 'offline');
  });
}

async function loadMikrotikInterfaces(){
  const allRows = await getJSON('/api/mikrotik/interfaces');
  renderMikrotikPortPanel(allRows);
  const body = document.getElementById('mikrotikIfaceBody');
  const select = document.getElementById('mikrotikIfaceSelect');
  const toggleBtn = document.getElementById('mkToggleDisabled');

  const activeRows = allRows.filter(r => r.running || !r.disabled);
  const disabledCount = allRows.length - activeRows.length;
  toggleBtn.textContent = mikrotikShowDisabled
    ? `Ocultar desabilitadas (${disabledCount})`
    : `Mostrar desabilitadas (${disabledCount})`;
  toggleBtn.classList.toggle('hidden', disabledCount === 0);

  const rows = (mikrotikShowDisabled ? allRows : activeRows)
    .slice()
    .sort((a, b) => (b.running - a.running) || ((b.rx_bps + b.tx_bps) - (a.rx_bps + a.tx_bps)));

  body.innerHTML = rows.map(r => `
    <tr data-iface="${r.name}" class="${r.name === mikrotikSelectedIface ? 'iface-active' : ''} ${r.disabled ? 'iface-disabled' : ''}">
      <td>${r.name}</td>
      <td><span class="dot ${r.running ? 'online' : 'offline'}"></span></td>
      <td>${fmtBps(r.rx_bps)}</td>
      <td>${fmtBps(r.tx_bps)}</td>
    </tr>`).join('') || '<tr><td colspan="4">Nenhuma interface encontrada.</td></tr>';

  body.querySelectorAll('tr[data-iface]').forEach(tr => {
    tr.addEventListener('click', () => {
      mikrotikSelectedIface = tr.dataset.iface;
      select.value = mikrotikSelectedIface;
      body.querySelectorAll('tr').forEach(t => t.classList.remove('iface-active'));
      tr.classList.add('iface-active');
      loadMikrotikIfaceChart();
    });
  });

  const runningRows = allRows.filter(r => r.running);
  document.getElementById('mkTotalRx').textContent = fmtBps(runningRows.reduce((sum, r) => sum + (r.rx_bps || 0), 0));
  document.getElementById('mkTotalTx').textContent = fmtBps(runningRows.reduce((sum, r) => sum + (r.tx_bps || 0), 0));
  document.getElementById('mkIfaceCount').textContent = runningRows.length;

  const currentNames = allRows.map(r => r.name);
  const selectNames = Array.from(select.options).map(o => o.value);
  if(JSON.stringify(currentNames) !== JSON.stringify(selectNames)){
    select.innerHTML = allRows.map(r => `<option value="${r.name}">${r.name}</option>`).join('');
  }
  if(!mikrotikSelectedIface && rows.length){
    mikrotikSelectedIface = rows[0].name;
  }
  if(mikrotikSelectedIface) select.value = mikrotikSelectedIface;
}

document.getElementById('mkToggleDisabled').addEventListener('click', () => {
  mikrotikShowDisabled = !mikrotikShowDisabled;
  loadMikrotikInterfaces();
});

async function loadMikrotikIfaceChart(){
  if(!mikrotikSelectedIface || !mikrotikIfaceChart) return;
  const data = await getJSON(`/api/mikrotik/history?range=${currentRange}&iface=${encodeURIComponent(mikrotikSelectedIface)}`);
  const points = data.points || [];
  mikrotikIfaceChart.data.labels = points.map(p => fmtTime(p.ts));
  mikrotikIfaceChart.data.datasets = [
    {label:'↓ RX', data: points.map(p => ({x:fmtTime(p.ts), y: p.rx_bps/1000})), borderColor:'#3ba3ff', backgroundColor:'transparent', tension:.3, pointRadius:0, borderWidth:2},
    {label:'↑ TX', data: points.map(p => ({x:fmtTime(p.ts), y: p.tx_bps/1000})), borderColor:'#ff9d3b', backgroundColor:'transparent', tension:.3, pointRadius:0, borderWidth:2},
  ];
  mikrotikIfaceChart.update();
}

document.getElementById('mikrotikIfaceSelect').addEventListener('change', e => {
  mikrotikSelectedIface = e.target.value;
  loadMikrotikIfaceChart();
});

async function loadMikrotik(){
  await loadMikrotikStatus();
  await loadMikrotikInterfaces();
  await loadMikrotikIfaceChart();
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
      <span>${getIconHtml(t.name, t.host)} ${t.name} — ${t.host}${t.parent ? ` <span class="parent-hint">↳ conectado a ${t.parent}</span>` : ''}</span>
      <button data-kind="target" data-name="${t.name}" title="Remover">✕</button>
    </div>`).join('') || '<div style="color:var(--muted);font-size:12px;">Nenhum destino cadastrado</div>';

  const parentSelect = document.getElementById('targetParentSelect');
  const currentParentValue = parentSelect.value;
  parentSelect.innerHTML = '<option value="">🌐 Rede local (raiz)</option>' +
    d.targets.map(t => `<option value="${t.name}">${t.name}</option>`).join('');
  if(d.targets.some(t => t.name === currentParentValue)) parentSelect.value = currentParentValue;

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
    await refreshTopologyData();
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
    body: JSON.stringify({name:f.get('name'), host:f.get('host'), parent: f.get('parent') || null})
  });
  if(!r.ok){ const j = await r.json(); showToast(j.detail || 'Erro ao adicionar', 'error'); return; }
  e.target.reset();
  await loadSettings();
  await refreshTopologyData();
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

// ---------- MikroTik / DHCP ----------
async function loadMikrotikSettings(){
  const d = await getJSON('/api/settings/mikrotik');
  const f = document.getElementById('formMikrotik');
  f.elements['enabled'].checked = !!d.enabled;
  f.elements['host'].value = d.host || '';
  f.elements['port'].value = d.port || 443;
  f.elements['use_https'].checked = !!d.use_https;
  f.elements['verify_ssl'].checked = !!d.verify_ssl;
  f.elements['username'].value = d.username || '';
  f.elements['password'].value = d.password || '';
  f.elements['sync_interval_seconds'].value = d.sync_interval_seconds || 60;
}

document.getElementById('formMikrotik').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const body = {
    enabled: f.get('enabled') === 'on',
    host: f.get('host') || '',
    port: parseInt(f.get('port')) || 443,
    use_https: f.get('use_https') === 'on',
    verify_ssl: f.get('verify_ssl') === 'on',
    username: f.get('username') || '',
    password: f.get('password') || '',
    sync_interval_seconds: parseInt(f.get('sync_interval_seconds')) || 60,
  };
  if(body.enabled && !body.host.trim()){
    showToast('Informe o host/IP do MikroTik para ativar.', 'error');
    return;
  }
  const r = await fetch('/api/settings/mikrotik', {
    method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body)
  });
  if(!r.ok){ const j = await r.json(); showToast(j.detail || 'Erro ao salvar', 'error'); return; }
  showToast('Configuração do MikroTik salva.');
  await loadMikrotikSettings();
});

document.getElementById('testMikrotikBtn').addEventListener('click', async () => {
  const btn = document.getElementById('testMikrotikBtn');
  btn.disabled = true;
  const original = btn.textContent;
  btn.textContent = 'Testando...';
  try{
    const r = await fetch('/api/settings/mikrotik/test', {method:'POST'});
    const j = await r.json();
    if(r.ok){ showToast(`Conectado! ${j.leases_found} lease(s) encontrada(s).`); await loadDhcpHosts(); }
    else { showToast(j.detail || 'Falha na conexão', 'error'); }
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
});

function fmtRelativeTime(ts){
  if(!ts) return '-';
  const diff = Date.now()/1000 - ts;
  if(diff < 90) return 'agora mesmo';
  if(diff < 3600) return `${Math.round(diff/60)} min atrás`;
  if(diff < 86400) return `${Math.round(diff/3600)}h atrás`;
  return `${Math.round(diff/86400)}d atrás`;
}

async function loadDhcpHosts(){
  const rows = await getJSON('/api/dhcp/hosts');
  const el = document.getElementById('dhcpHostsList');
  if(rows.length === 0){
    el.innerHTML = '<div style="color:var(--muted);font-size:12px;">Nenhum dispositivo descoberto ainda. Configure e teste a conexão com o MikroTik acima.</div>';
    return;
  }
  el.innerHTML = rows.map(h => {
    const label = h.hostname || h.ip || h.mac;
    const statusDot = h.active ? 'online' : 'offline';
    const promoted = h.promoted_target;
    return `
      <div class="settings-item dhcp-item">
        <span class="dhcp-item-main">
          <span class="dot ${statusDot}" style="margin-right:4px;"></span>
          ${label} <span class="parent-hint">${h.ip || ''} · ${h.mac}</span>
        </span>
        ${promoted
          ? `<span class="parent-hint">✅ monitorado como "${promoted}"</span>`
          : `<button type="button" class="promote-btn" data-id="${h.id}" data-suggested="${label}">+ Promover</button>`}
      </div>`;
  }).join('');
}

document.getElementById('dhcpHostsList').addEventListener('click', async (e) => {
  const btn = e.target.closest('button.promote-btn');
  if(!btn) return;
  const suggested = btn.dataset.suggested;
  const name = prompt('Nome do destino monitorado:', suggested);
  if(!name || !name.trim()) return;
  const targets = await getJSON('/api/settings');
  const parentNames = targets.targets.map(t => t.name).join(', ');
  let parent = '';
  if(targets.targets.length){
    parent = prompt(`Conectar a qual destino? (deixe em branco para "Rede local")\nOpções: ${parentNames}`, '') || '';
  }
  const r = await fetch(`/api/dhcp/hosts/${btn.dataset.id}/promote`, {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({name: name.trim(), parent: parent.trim() || null})
  });
  if(!r.ok){ const j = await r.json(); showToast(j.detail || 'Erro ao promover', 'error'); return; }
  await loadDhcpHosts();
  await loadSettings();
  await refreshTopologyData();
  showToast(`"${name.trim()}" agora é um destino monitorado.`);
});

// ---------- AdGuard Home ----------
async function loadAghStatus(){
  const s = await getJSON('/api/agh/status');
  const dot = document.getElementById('dotAgh');
  const body = document.getElementById('aghBody');
  const offline = document.getElementById('aghOffline');

  if(!s.enabled){
    body.classList.add('hidden');
    offline.classList.remove('hidden');
    dot.className = 'dot';
    return;
  }
  body.classList.remove('hidden');
  offline.classList.add('hidden');
  dot.className = 'dot ' + (s.online ? 'online' : 'offline');

  document.getElementById('aghProtection').textContent = s.protection_enabled ? 'Ativa' : 'Desativada';
  document.getElementById('aghVersion').textContent = s.version || '--';

  const stats = await getJSON('/api/agh/stats');
  document.getElementById('aghQueries').textContent = stats.num_dns_queries ?? '--';
  document.getElementById('aghBlocked').textContent = stats.num_blocked_filtering ?? '--';
  document.getElementById('aghBlockedPct').textContent = (stats.blocked_pct ?? 0) + '%';
  setBar(document.getElementById('aghBarBlocked'), stats.blocked_pct, 'cpu', 20, 40);
}

async function loadAghChart(){
  if(!aghChart) return;
  const data = await getJSON(`/api/agh/history?range=${currentRange}`);
  aghChart.data.labels = data.map(p => fmtTime(p.ts));
  aghChart.data.datasets = [
    { label: 'Consultas', data: data.map(p => p.num_dns_queries), borderColor: '#5b9dff' },
    { label: 'Bloqueadas', data: data.map(p => p.num_blocked_filtering), borderColor: '#ff5b7a' },
  ];
  aghChart.update();
}

async function loadAgh(){
  await loadAghStatus();
  await loadAghChart();
}

async function loadAghSettings(){
  const d = await getJSON('/api/settings/agh');
  const f = document.getElementById('formAgh');
  f.enabled.checked = !!d.enabled;
  f.host.value = d.host || '';
  f.port.value = d.port || 3000;
  f.use_https.checked = !!d.use_https;
  f.username.value = d.username || '';
  f.password.value = d.password || '';
  f.sync_interval_seconds.value = d.sync_interval_seconds || 60;
}

document.getElementById('formAgh').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const payload = {
    enabled: f.enabled.checked,
    host: f.host.value.trim(),
    port: parseInt(f.port.value) || 3000,
    use_https: f.use_https.checked,
    username: f.username.value.trim(),
    password: f.password.value,
    sync_interval_seconds: parseInt(f.sync_interval_seconds.value) || 60,
  };
  if(payload.enabled && !payload.host){
    showToast('Informe o host/IP do AdGuard Home para ativar.', 'error');
    return;
  }
  const r = await fetch('/api/settings/agh', {
    method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload)
  });
  if(!r.ok){ const j = await r.json(); showToast(j.detail || 'Erro ao salvar', 'error'); return; }
  showToast('Configuração do AdGuard Home salva.');
  await loadAghSettings();
  await loadAgh();
});

document.getElementById('testAghBtn').addEventListener('click', async () => {
  const btn = document.getElementById('testAghBtn');
  btn.disabled = true; btn.textContent = 'Testando...';
  try {
    const r = await fetch('/api/settings/agh/test', {method:'POST'});
    const j = await r.json();
    if(r.ok){ showToast(`Conectado! Versão ${j.version || '--'}.`); await loadAgh(); }
    else { showToast(j.detail || 'Falha ao conectar', 'error'); }
  } finally {
    btn.disabled = false; btn.textContent = 'Testar Conexão';
  }
});

async function refreshAll(){
  await Promise.all([
    loadOverview(), loadPingCharts(), loadLossChart(), loadTargets(),
    loadDns(), loadEvents(), loadIncidents(), loadIncidentsSummary(),
    loadAvailability(), loadInsights(), loadIncidentBanner(), loadMikrotik(), loadAgh()
  ]);
  const currentPage = document.querySelector('.page.active')?.dataset.page;
  if(currentPage === 'topologia' && typeof refreshTopologyData === 'function'){
    refreshTopologyData();
  }
  if(currentPage === 'config' && document.querySelector('.config-tab-panel[data-tab-panel="mikrotik"]')?.classList.contains('active')){
    loadDhcpHosts();
  }
}

document.getElementById('rangeSelect').addEventListener('change', e => {
  currentRange = e.target.value;
  loadPingCharts(); loadLossChart(); loadMikrotikIfaceChart(); loadAghChart();
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
  mikrotikIfaceChart = makeChart(document.getElementById('mikrotikIfaceChart'), baseChartOpts('kbps'));
  aghChart = makeChart(document.getElementById('aghChart'), baseChartOpts('queries'));
  initWidgetAppearance();
  refreshAll();
  loadSettings();
  loadIntervalsSettings();
  loadTelegramSettings();
  loadMikrotikSettings();
  loadDhcpHosts();
  loadAghSettings();
  loadAppName();
  setInterval(refreshAll, 5000);
});
