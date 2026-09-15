// topology.js — Topologia Cyberpunk/NOC moderna com animações contínuas
(function () {
  const canvas = document.getElementById('topoCanvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const emptyEl = document.getElementById('topoEmpty');
  const detailBody = document.getElementById('topoDetailBody');

  let nodes = [];      // {id, label, type, online, host}
  let edges = [];      // {source, target}
  let positions = {};  // id -> {x, y}
  let scale = 1, offsetX = 0, offsetY = 0;
  let dragging = null; // {kind: 'node'|'pan', id, startX, startY}
  let selectedId = null;
  let loaded = false;

  // Estado da animação
  let animFrameId = null;
  let animTime = 0;
  
  // Pacotes fluindo nas conexões
  let packets = []; 

  function resizeCanvas() {
    const box = canvas.parentElement.getBoundingClientRect();
    canvas.width = box.width * devicePixelRatio;
    canvas.height = box.height * devicePixelRatio;
    canvas.style.width = box.width + 'px';
    canvas.style.height = box.height + 'px';
  }
  window.addEventListener('resize', () => {
    resizeCanvas();
  });

  function getCss(varName, fallback) {
    const val = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
    return val || fallback;
  }

  function getColor(n) {
    if (n.type === 'internet') return getCss('--blue', '#00f0ff');
    if (n.online === true) return getCss('--green', '#00ff88');
    if (n.online === false) return getCss('--red', '#ff0055');
    return getCss('--muted', '#707c98');
  }

  function layout() {
    const children = {};
    edges.forEach(e => {
      (children[e.source] = children[e.source] || []).push(e.target);
    });
    const root = nodes.find(n => n.type === 'internet') || nodes[0];
    if (!root) return;

    const visited = new Set([root.id]);
    positions[root.id] = positions[root.id] || { x: 0, y: 0 };
    let frontier = [root.id];
    let level = 1;

    while (frontier.length) {
      const next = [];
      frontier.forEach(pid => (children[pid] || []).forEach(cid => {
        if (!visited.has(cid)) { visited.add(cid); next.push(cid); }
      }));
      const radius = level * 160;
      next.forEach((id, i) => {
        if (positions[id]) return;
        const angle = (i / Math.max(next.length, 1)) * Math.PI * 2 - Math.PI / 2;
        positions[id] = { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
      });
      frontier = next;
      level++;
    }

    let orphanIndex = 0;
    nodes.forEach(n => {
      if (!positions[n.id]) {
        positions[n.id] = { x: orphanIndex * 130 - 200, y: level * 160 };
        orphanIndex++;
      }
    });

    initPackets();
  }

  // Gera pacotes de tráfego visual nas arestas
  function initPackets() {
    packets = [];
    edges.forEach(e => {
      // 2 pacotes por aresta em tempos diferentes
      packets.push({ edge: e, progress: Math.random(), speed: 0.003 + Math.random() * 0.004 });
      packets.push({ edge: e, progress: Math.random(), speed: 0.003 + Math.random() * 0.004 });
    });
  }

  function worldToScreen(x, y) {
    const box = canvas.getBoundingClientRect();
    return {
      x: box.width / 2 + (x + offsetX) * scale,
      y: box.height / 2 + (y + offsetY) * scale,
    };
  }

  function screenToWorld(sx, sy) {
    const box = canvas.getBoundingClientRect();
    return {
      x: (sx - box.width / 2) / scale - offsetX,
      y: (sy - box.height / 2) / scale - offsetY,
    };
  }

  // Desenha um grid cibernético sutil no fundo
  function drawBackground(width, height) {
    ctx.strokeStyle = getCss('--border', 'rgba(255, 255, 255, 0.04)');
    ctx.lineWidth = 1;
    const gridSize = 40 * scale;
    const startX = (boxWidthHalf() + offsetX * scale) % gridSize;
    const startY = (boxHeightHalf() + offsetY * scale) % gridSize;

    ctx.beginPath();
    for (let x = startX; x < width; x += gridSize) {
      ctx.moveTo(x, 0); ctx.lineTo(x, height);
    }
    for (let y = startY; y < height; y += gridSize) {
      ctx.moveTo(0, y); ctx.lineTo(width, y);
    }
    ctx.stroke();
  }

  function boxWidthHalf() { return canvas.getBoundingClientRect().width / 2; }
  function boxHeightHalf() { return canvas.getBoundingClientRect().height / 2; }

  // Loop de renderização com requestAnimationFrame
  function startAnimation() {
    if (animFrameId) cancelAnimationFrame(animFrameId);

    function loop() {
      animTime += 0.02;
      draw();
      animFrameId = requestAnimationFrame(loop);
    }
    loop();
  }

  function draw() {
    const box = canvas.getBoundingClientRect();
    ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    ctx.clearRect(0, 0, box.width, box.height);

    drawBackground(box.width, box.height);

    if (!nodes.length) return;

    // 1. Desenhar Arestas (Conexões)
    edges.forEach(e => {
      const p1 = positions[e.source], p2 = positions[e.target];
      if (!p1 || !p2) return;
      const s1 = worldToScreen(p1.x, p1.y), s2 = worldToScreen(p2.x, p2.y);

      const targetNode = nodes.find(n => n.id === e.target);
      const isOffline = targetNode && targetNode.online === false;

      ctx.lineWidth = 1.8 * Math.min(scale, 1.2);
      ctx.strokeStyle = isOffline ? 'rgba(255, 0, 85, 0.3)' : getCss('--border', 'rgba(0, 240, 255, 0.2)');
      
      ctx.beginPath();
      ctx.moveTo(s1.x, s1.y);
      ctx.lineTo(s2.x, s2.y);
      ctx.stroke();
    });

    // 2. Animar Pacotes de Dados
    packets.forEach(p => {
      const p1 = positions[p.edge.source], p2 = positions[p.edge.target];
      if (!p1 || !p2) return;

      const targetNode = nodes.find(n => n.id === p.edge.target);
      if (targetNode && targetNode.online === false) return; // Não transmite se offline

      p.progress += p.speed;
      if (p.progress > 1) p.progress = 0;

      const s1 = worldToScreen(p1.x, p1.y), s2 = worldToScreen(p2.x, p2.y);
      const px = s1.x + (s2.x - s1.x) * p.progress;
      const py = s1.y + (s2.y - s1.y) * p.progress;

      ctx.shadowBlur = 8;
      ctx.shadowColor = '#00f0ff';
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(px, py, 2.5 * Math.min(scale, 1.3), 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0; // reset
    });

    // 3. Desenhar Nós
    nodes.forEach(n => {
      const p = positions[n.id];
      if (!p) return;
      const s = worldToScreen(p.x, p.y);
      const isInternet = n.type === 'internet';
      const baseRadius = isInternet ? 22 : 16;
      const r = baseRadius * Math.min(scale, 1.4);
      const color = getColor(n);

      // Pulso ao redor de nós online / selecionados
      if (n.online || isInternet) {
        const pulse = (Math.sin(animTime * 3) + 1) * 4;
        ctx.beginPath();
        ctx.arc(s.x, s.y, r + pulse, 0, Math.PI * 2);
        ctx.strokeStyle = color;
        ctx.globalAlpha = 0.25;
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.globalAlpha = 1.0;
      }

      // Anel Giratório para Internet
      if (isInternet) {
        ctx.save();
        ctx.translate(s.x, s.y);
        ctx.rotate(animTime);
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;
        ctx.setLineDash([6, 6]);
        ctx.beginPath();
        ctx.arc(0, 0, r + 8, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }

      // Glow do Nó principal
      ctx.shadowBlur = n.id === selectedId ? 20 : 10;
      ctx.shadowColor = color;

      // Círculo Central
      ctx.beginPath();
      ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();

      // Borda de Seleção
      if (n.id === selectedId) {
        ctx.lineWidth = 3;
        ctx.strokeStyle = '#ffffff';
        ctx.stroke();
      }

      ctx.shadowBlur = 0; // Desativa glow para o texto

      // Rótulo / Texto do Nó
      ctx.fillStyle = getCss('--text', '#e8ebf5');
      ctx.font = `600 ${Math.max(10, 12 * Math.min(scale, 1.2))}px system-ui, -apple-system, sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillText(n.label, s.x, s.y + r + 18);
    });
  }

  function nodeAt(sx, sy) {
    for (let i = nodes.length - 1; i >= 0; i--) {
      const n = nodes[i];
      const p = positions[n.id];
      if (!p) continue;
      const s = worldToScreen(p.x, p.y);
      const r = (n.type === 'internet' ? 22 : 16) * Math.min(scale, 1.4);
      if (Math.hypot(sx - s.x, sy - s.y) <= r + 5) return n;
    }
    return null;
  }

  function showDetail(n) {
    selectedId = n ? n.id : null;
    if (!detailBody) return;
    if (!n) {
      detailBody.innerHTML = '<div class="insight-empty">Clique em um nó do grafo para ver os detalhes. Arraste para reorganizar, use a roda do mouse para zoom.</div>';
      return;
    }
    const statusLabel = n.type === 'internet' ? 'Rede Principal' : (n.online === true ? 'Online' : n.online === false ? 'Offline' : 'Sem dados');
    detailBody.innerHTML = `
      <div class="topo-detail-title">${n.type === 'internet' ? '🌐' : (n.online ? '🟢' : n.online === false ? '🔴' : '⚪')} ${n.label}</div>
      <div class="topo-detail-row"><span>Status</span><span>${statusLabel}</span></div>
      ${n.host ? `<div class="topo-detail-row"><span>Host / IP</span><span>${n.host}</span></div>` : ''}
    `;
  }

  // ---------- Eventos & Interação ----------
  canvas.addEventListener('mousedown', (e) => {
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
    const hit = nodeAt(sx, sy);
    if (hit) {
      dragging = { kind: 'node', id: hit.id };
      showDetail(hit);
    } else {
      dragging = { kind: 'pan', lastX: e.clientX, lastY: e.clientY };
    }
  });

  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    if (dragging.kind === 'node') {
      const rect = canvas.getBoundingClientRect();
      const world = screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
      positions[dragging.id] = world;
    } else if (dragging.kind === 'pan') {
      const dx = e.clientX - dragging.lastX, dy = e.clientY - dragging.lastY;
      offsetX += dx / scale;
      offsetY += dy / scale;
      dragging.lastX = e.clientX;
      dragging.lastY = e.clientY;
    }
  });

  window.addEventListener('mouseup', () => { dragging = null; });

  // Suporte a Touch em dispositivos móveis
  canvas.addEventListener('touchstart', (e) => {
    if (e.touches.length === 1) {
      const rect = canvas.getBoundingClientRect();
      const touch = e.touches[0];
      const sx = touch.clientX - rect.left, sy = touch.clientY - rect.top;
      const hit = nodeAt(sx, sy);
      if (hit) {
        dragging = { kind: 'node', id: hit.id };
        showDetail(hit);
      } else {
        dragging = { kind: 'pan', lastX: touch.clientX, lastY: touch.clientY };
      }
    }
  }, { passive: true });

  canvas.addEventListener('touchmove', (e) => {
    if (!dragging || e.touches.length !== 1) return;
    const touch = e.touches[0];
    if (dragging.kind === 'node') {
      const rect = canvas.getBoundingClientRect();
      const world = screenToWorld(touch.clientX - rect.left, touch.clientY - rect.top);
      positions[dragging.id] = world;
    } else if (dragging.kind === 'pan') {
      const dx = touch.clientX - dragging.lastX, dy = touch.clientY - dragging.lastY;
      offsetX += dx / scale;
      offsetY += dy / scale;
      dragging.lastX = touch.clientX;
      dragging.lastY = touch.clientY;
    }
  }, { passive: true });

  canvas.addEventListener('touchend', () => { dragging = null; });

  // Zoom da Roda do Mouse
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? 0.9 : 1.1;
    scale = Math.min(Math.max(scale * delta, 0.3), 3);
  }, { passive: false });

  document.getElementById('topoZoomIn')?.addEventListener('click', () => { scale = Math.min(scale * 1.2, 3); });
  document.getElementById('topoZoomOut')?.addEventListener('click', () => { scale = Math.max(scale * 0.8, 0.3); });
  document.getElementById('topoReset')?.addEventListener('click', () => {
    positions = {}; scale = 1; offsetX = 0; offsetY = 0;
    layout();
  });

  async function refreshTopologyData() {
    try {
      const res = await fetch('/api/topology');
      const data = await res.json();
      nodes = data.nodes || [];
      edges = data.edges || [];
    } catch (e) {
      nodes = []; edges = [];
    }
    if (emptyEl) emptyEl.classList.toggle('hidden', nodes.length > 1);
    layout();
    if (!loaded) {
      resizeCanvas();
      startAnimation();
      loaded = true;
    }
  }

  function onTopologyPageShown() {
    resizeCanvas();
    refreshTopologyData();
  }

  window.refreshTopologyData = refreshTopologyData;
  window.onTopologyPageShown = onTopologyPageShown;
})();