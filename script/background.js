(() => {
  const canvas = document.getElementById('bg');
  const ctx = canvas.getContext('2d');
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const INK = '20,20,19';
  const ACCENT = '194,100,63';
  const BG = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() || '#F5F3EC';
  const LAND_URL = 'https://cdn.jsdelivr.net/npm/world-atlas@2/land-110m.json';
  const mouse = { x: -1e4, y: -1e4 };
  let W = 0, H = 0, mode = 'contour', raf = 0, start = 0, state = {};
  let land = null, landRequested = false, graticule = null;

  // Cheap smooth pseudo-terrain in roughly [-2, 2].
  const field = (x, y, t) =>
    Math.sin(x * 1.3 + t * 0.7) * Math.cos(y * 1.1 - t * 0.5) +
    0.6 * Math.sin(x * 0.7 + y * 1.9 + t * 0.4) +
    0.4 * Math.cos(x * 2.3 - y * 0.8 - t * 0.3);

  const rgba = (rgb, a) => `rgba(${rgb},${a})`;

  function seeded(seed) {
    return () => {
      seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
      let r = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
      return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Smooth 1D value noise in roughly [-1, 1], for data-like wiggles.
  const noiseTable = Float32Array.from({ length: 1024 }, seeded(11)).map((v) => v * 2 - 1);
  function noise1(x) {
    const i = Math.floor(x), f = x - i, s = f * f * (3 - 2 * f);
    const a = noiseTable[i & 1023], b = noiseTable[(i + 1) & 1023];
    return a + (b - a) * s;
  }

  const modes = {
    contour: {
      init() {
        const cell = 14;
        const cols = Math.ceil(W / cell) + 2, rows = Math.ceil(H / cell) + 2;
        state = { cell, cols, rows, values: new Float64Array(cols * rows),
          gen: d3.contours().size([cols, rows]).thresholds(d3.range(-2, 2.01, 0.2)) };
      },
      draw(t) {
        const { cell, cols, rows, values, gen } = state;
        const s = (3 / Math.max(W, H)) * cell, tt = t * 0.00006;
        for (let j = 0; j < rows; j++)
          for (let i = 0; i < cols; i++) values[j * cols + i] = field(i * s, j * s, tt);
        ctx.clearRect(0, 0, W, H);
        ctx.save();
        ctx.scale(cell, cell);
        ctx.lineWidth = 1 / cell;
        const path = d3.geoPath(null, ctx);
        gen(values).forEach((c, k) => {
          ctx.beginPath();
          path(c);
          // every 5th line is a darker "index contour", like a topo map
          ctx.strokeStyle = rgba(INK, k % 5 === 0 ? 0.2 : 0.09);
          ctx.stroke();
        });
        ctx.restore();
      }
    },

    ridges: {
      draw(t) {
        const n = 28, top = H * 0.36, gap = (H - top) / n;
        const cx = W * 0.68, spread = Math.max(W * 0.18, 140), tt = t * 0.00025;
        ctx.clearRect(0, 0, W, H);
        ctx.lineWidth = 1;
        for (let i = 0; i < n; i++) {
          const base = top + i * gap;
          ctx.beginPath();
          ctx.moveTo(-10, H);
          for (let x = -10; x <= W + 10; x += 5) {
            const w = Math.exp(-(((x - cx) / spread) ** 2));
            const peak = gap * 16 * w * ((field(x * 0.008, i * 0.3, tt) + 2) / 4) ** 2;
            const jitter = gap * 0.35 * (field(x * 0.03, i * 1.7, tt * 1.5) + 2) / 4;
            ctx.lineTo(x, base - peak - jitter);
          }
          ctx.lineTo(W + 10, H);
          ctx.closePath();
          // fill with page color so nearer ridges hide the ones behind them
          ctx.fillStyle = BG;
          ctx.fill();
          ctx.strokeStyle = rgba(INK, 0.24);
          ctx.stroke();
        }
      }
    },

    grid: {
      draw() {
        const step = 64;
        ctx.clearRect(0, 0, W, H);
        ctx.lineWidth = 1;
        ctx.strokeStyle = rgba(INK, 0.07);
        ctx.beginPath();
        for (let x = step; x < W; x += step) { ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, H); }
        for (let y = step; y < H; y += step) { ctx.moveTo(0, y + 0.5); ctx.lineTo(W, y + 0.5); }
        ctx.stroke();

        ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
        ctx.fillStyle = rgba(INK, 0.28);
        for (let x = step * 2; x < W; x += step * 2) ctx.fillText(String(x / step * 10), x + 4, H - 8);
        for (let y = step * 2; y < H; y += step * 2) ctx.fillText(String(Math.round((H - y) / step * 10)), 6, y - 4);

        if (mouse.x > 0 && mouse.x < W && mouse.y > 0 && mouse.y < H) {
          const { x, y } = mouse;
          ctx.strokeStyle = rgba(ACCENT, 0.45);
          ctx.setLineDash([3, 4]);
          ctx.beginPath();
          ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, H);
          ctx.moveTo(0, y + 0.5); ctx.lineTo(W, y + 0.5);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.fillStyle = rgba(ACCENT, 0.9);
          ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2); ctx.fill();
          ctx.fillText(`${(x / step * 10).toFixed(1)}, ${((H - y) / step * 10).toFixed(1)}`, x + 8, y - 8);
        }
      }
    },

    flow: {
      init() {
        const n = Math.round((W * H) / 2400);
        const spawn = () => ({ x: Math.random() * W, y: Math.random() * H, age: 0, trail: [] });
        state = { spawn, ps: Array.from({ length: n }, () => Object.assign(spawn(), { age: Math.random() * 300 })) };
      },
      draw(t) {
        const s = 3 / Math.max(W, H), tt = reduce ? 0 : t * 0.00003;
        const len = reduce ? 90 : 60;
        // reduced motion: trace full streamlines once instead of animating particles
        const steps = reduce ? len : 1;
        for (let k = 0; k < steps; k++) {
          for (const p of state.ps) {
            const a = field(p.x * s, p.y * s, tt) * Math.PI;
            p.x += Math.cos(a) * 1.4; p.y += Math.sin(a) * 1.4;
            p.trail.push(p.x, p.y);
            if (p.trail.length > len * 2) p.trail.splice(0, 2);
            if (++p.age > 300 || p.x < 0 || p.x > W || p.y < 0 || p.y > H) Object.assign(p, state.spawn());
          }
        }
        ctx.clearRect(0, 0, W, H);
        ctx.lineWidth = 1;
        ctx.strokeStyle = rgba(INK, 0.22);
        ctx.beginPath();
        for (const { trail } of state.ps) {
          if (trail.length < 4) continue;
          ctx.moveTo(trail[0], trail[1]);
          for (let i = 2; i < trail.length; i += 2) ctx.lineTo(trail[i], trail[i + 1]);
        }
        ctx.stroke();
      }
    },

    globe: {
      init() {
        graticule = graticule || d3.geoGraticule10();
        if (!landRequested) {
          landRequested = true;
          fetch(LAND_URL)
            .then((r) => r.json())
            .then((topo) => {
              land = topojson.feature(topo, topo.objects.land);
              if (reduce && mode === 'globe') modes.globe.draw(0);
            })
            .catch(() => {});
        }
      },
      draw(t) {
        const r = Math.min(W, H) * 0.42;
        const proj = d3.geoOrthographic().scale(r).translate([W * 0.7, H * 0.58]).rotate([t * 0.003, -18]);
        const path = d3.geoPath(proj, ctx);
        ctx.clearRect(0, 0, W, H);
        ctx.lineWidth = 1;
        ctx.beginPath(); path(graticule); ctx.strokeStyle = rgba(INK, 0.05); ctx.stroke();
        if (land) {
          ctx.beginPath(); path(land);
          ctx.fillStyle = rgba(INK, 0.035); ctx.fill();
          ctx.strokeStyle = rgba(INK, 0.13); ctx.stroke();
        }
        ctx.beginPath(); path({ type: 'Sphere' }); ctx.strokeStyle = rgba(INK, 0.12); ctx.stroke();
      }
    },

    ticker: {
      draw(t) {
        const tipX = W * 0.86, sec = t / 1000;
        // fast draw-in that eases into a steady scroll, so the tip never stalls
        const d = reduce ? tipX : 24 * sec + tipX * (1 - Math.exp(-sec / 0.9));
        const off = Math.max(0, d - tipX), end = d - off;
        const yAt = (u) => H * 0.74 - H * 0.1 * (noise1(u / 230) + 0.4 * noise1(u / 75 + 50) + 0.15 * noise1(u / 24 + 90));
        ctx.clearRect(0, 0, W, H);

        ctx.strokeStyle = rgba(INK, 0.07);
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let i = 1; i <= 4; i++) {
          const y = Math.round(H * 0.5 + i * H * 0.1) + 0.5;
          ctx.moveTo(0, y); ctx.lineTo(W, y);
        }
        ctx.stroke();

        const line = new Path2D();
        for (let x = 0; x < end; x += 3) line.lineTo(x, yAt(x + off));
        const ty = yAt(d);
        line.lineTo(end, ty);
        const area = new Path2D(line);
        area.lineTo(end, H); area.lineTo(0, H); area.closePath();
        const g = ctx.createLinearGradient(0, H * 0.55, 0, H);
        g.addColorStop(0, rgba(ACCENT, 0.1)); g.addColorStop(1, rgba(ACCENT, 0));
        ctx.fillStyle = g;
        ctx.fill(area);
        ctx.strokeStyle = rgba(ACCENT, 0.55);
        ctx.lineWidth = 2;
        ctx.lineJoin = 'round';
        ctx.stroke(line);

        // "last value" guide from the tip to the edge
        ctx.setLineDash([3, 4]);
        ctx.lineWidth = 1;
        ctx.strokeStyle = rgba(ACCENT, 0.3);
        ctx.beginPath(); ctx.moveTo(end, ty); ctx.lineTo(W, ty); ctx.stroke();
        ctx.setLineDash([]);

        const pulse = (t / 1600) % 1;
        ctx.strokeStyle = rgba(ACCENT, 0.4 * (1 - pulse));
        ctx.beginPath(); ctx.arc(end, ty, 3.5 + pulse * 10, 0, Math.PI * 2); ctx.stroke();
        ctx.fillStyle = rgba(ACCENT, 0.9);
        ctx.beginPath(); ctx.arc(end, ty, 3.5, 0, Math.PI * 2); ctx.fill();
      }
    },

    ensemble: {
      draw(t) {
        const n = 36, step = 5, tt = t * 0.00007;
        const x0 = W * 0.4, y0 = H * 0.8, J = Math.ceil((W + 10 - x0) / step) + 1;
        const reveal = reduce ? 1 : d3.easeCubicOut(Math.min(1, t / 3600));
        const proj = (x, bias, k, amp) => {
          const f = (x - x0) / (W - x0);
          return y0 - H * 0.3 * f ** 1.3 + H * 0.17 * f ** 1.1 * (bias + amp * field(x * 0.0025, k * 0.83, tt));
        };
        const lo = new Float32Array(J).fill(Infinity), hi = new Float32Array(J).fill(-Infinity);
        const rows = Array.from({ length: n }, (_, k) => {
          const row = new Float32Array(J), bias = (k / (n - 1) - 0.5) * 1.2;
          for (let j = 0; j < J; j++) {
            row[j] = proj(x0 + j * step, bias, k, 0.45);
            lo[j] = Math.min(lo[j], row[j]); hi[j] = Math.max(hi[j], row[j]);
          }
          return row;
        });
        const n0 = noise1(x0 / 16) + 0.5 * noise1(x0 / 5 + 30);
        const hist = (x) => y0 + H * 0.06 * (1 - x / x0) ** 1.6 + H * 0.022 * (noise1(x / 16) + 0.5 * noise1(x / 5 + 30) - n0);

        ctx.clearRect(0, 0, W, H);
        ctx.save();
        ctx.beginPath(); ctx.rect(0, 0, reveal * (W + 10), H); ctx.clip();

        ctx.lineWidth = 1;
        ctx.setLineDash([3, 4]);
        ctx.strokeStyle = rgba(INK, 0.14);
        ctx.beginPath(); ctx.moveTo(x0 + 0.5, y0 - H * 0.42); ctx.lineTo(x0 + 0.5, H); ctx.stroke();
        ctx.setLineDash([]);

        ctx.beginPath();
        for (let j = 0; j < J; j++) ctx.lineTo(x0 + j * step, hi[j]);
        for (let j = J - 1; j >= 0; j--) ctx.lineTo(x0 + j * step, lo[j]);
        ctx.closePath();
        ctx.fillStyle = rgba(ACCENT, 0.06);
        ctx.fill();

        ctx.strokeStyle = rgba(INK, 0.09);
        ctx.beginPath();
        for (const row of rows) {
          ctx.moveTo(x0, row[0]);
          for (let j = 1; j < J; j++) ctx.lineTo(x0 + j * step, row[j]);
        }
        ctx.stroke();

        ctx.lineJoin = 'round';
        ctx.strokeStyle = rgba(INK, 0.4);
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        for (let x = 0; x <= x0; x += 3) ctx.lineTo(x, hist(x));
        ctx.lineTo(x0, y0);
        ctx.stroke();

        ctx.strokeStyle = rgba(ACCENT, 0.65);
        ctx.lineWidth = 2;
        ctx.beginPath();
        for (let j = 0; j < J; j++) ctx.lineTo(x0 + j * step, proj(x0 + j * step, 0, 50, 0.25));
        ctx.stroke();

        ctx.fillStyle = rgba(INK, 0.6);
        ctx.beginPath(); ctx.arc(x0, y0, 3, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
      }
    },

    spiral: {
      draw(t) {
        const years = 80, total = years * 12;
        const cx = W * 0.72, cy = H * 0.55, R = Math.min(W * 0.26, H * 0.38), r0 = R * 0.2;
        const DRAW = 18000, HOLD = 3000, FADE = 1500;
        const ct = reduce ? DRAW : t % (DRAW + HOLD + FADE);
        const months = Math.min(1, ct / DRAW) * total;
        const anom = (m) => -0.35 + 1.75 * (m / total) ** 2.6 + 0.13 * noise1(m / 14) + 0.06 * noise1(m / 3 + 40);
        const rad = (a) => r0 + ((a + 0.6) / 2.2) * (R - r0);
        const pt = (m) => {
          const a = (m / 12) * Math.PI * 2 - Math.PI / 2, r = rad(anom(m));
          return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
        };
        ctx.clearRect(0, 0, W, H);
        // fade in, hold the finished spiral, fade out, then loop
        ctx.globalAlpha = ct < 800 ? ct / 800 : Math.min(1, 1 - (ct - DRAW - HOLD) / FADE);

        ctx.lineWidth = 1;
        ctx.setLineDash([2, 4]);
        [[0, INK, 0.14], [1, INK, 0.14], [1.5, ACCENT, 0.4]].forEach(([a, c, al]) => {
          ctx.strokeStyle = rgba(c, al);
          ctx.beginPath(); ctx.arc(cx, cy, rad(a), 0, Math.PI * 2); ctx.stroke();
        });
        ctx.setLineDash([]);

        ctx.lineJoin = 'round';
        for (let y = 0; y * 12 < months; y++) {
          const f = y / (years - 1), m1 = Math.min(months, (y + 1) * 12);
          // older years in faint ink, recent years shift toward the accent
          const c = [20 + 174 * f ** 2, 20 + 80 * f ** 2, 19 + 44 * f ** 2].map(Math.round).join(',');
          ctx.strokeStyle = rgba(c, 0.03 + 0.4 * f ** 2.2);
          ctx.lineWidth = 1 + 0.5 * f;
          ctx.beginPath();
          for (let m = y * 12; m < m1; m += 0.25) ctx.lineTo(...pt(m));
          ctx.lineTo(...pt(m1));
          ctx.stroke();
        }
        const [tx, ty] = pt(months);
        ctx.fillStyle = rgba(ACCENT, 0.9);
        ctx.beginPath(); ctx.arc(tx, ty, 3.5, 0, Math.PI * 2); ctx.fill();
        ctx.globalAlpha = 1;
      }
    },

    scatter: {
      init() {
        const rand = seeded(21), n = Math.round(Math.min(240, (W * H) / 6000));
        state = {
          pts: Array.from({ length: n }, () => {
            const u = rand();
            return {
              tx: W * (0.08 + u * 0.88),
              ty: H * (0.86 - u * 0.4) + (rand() + rand() + rand() - 1.5) * H * 0.08,
              sx: rand() * W, sy: rand() * H,
              delay: u * 1000 + rand() * 600, ph: rand() * 6.28, hi: rand() < 0.035
            };
          })
        };
      },
      draw(t) {
        const T = reduce ? 1e6 : t, tt = T * 0.0006;
        const pos = state.pts.map((p) => {
          const e = d3.easeCubicInOut(Math.min(1, Math.max(0, (T - p.delay) / 2200)));
          return {
            x: p.sx + (p.tx - p.sx) * e + 5 * Math.sin(tt + p.ph),
            y: p.sy + (p.ty - p.sy) * e + 5 * Math.cos(tt * 0.8 + p.ph * 1.7),
            e, hi: p.hi
          };
        });
        const N = pos.length;
        const mx = d3.mean(pos, (p) => p.x), my = d3.mean(pos, (p) => p.y);
        let sxx = 0, sxy = 0;
        for (const p of pos) { sxx += (p.x - mx) ** 2; sxy += (p.x - mx) * (p.y - my); }
        const b = sxy / sxx, a = my - b * mx;
        const sd = Math.sqrt(d3.sum(pos, (p) => (p.y - a - b * p.x) ** 2) / N);
        // fit line only fades in once the dots have mostly settled
        const la = Math.max(0, (d3.mean(pos, (p) => p.e) - 0.7) / 0.3);
        const xL = W * 0.08, xR = xL + (W * 0.96 - xL) * la;

        ctx.clearRect(0, 0, W, H);
        ctx.strokeStyle = rgba(INK, 0.12);
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(xL, Math.round(H * 0.95) + 0.5); ctx.lineTo(W * 0.96, Math.round(H * 0.95) + 0.5); ctx.stroke();

        if (la > 0) {
          ctx.beginPath();
          ctx.moveTo(xL, a + b * xL - sd * 0.6); ctx.lineTo(xR, a + b * xR - sd * 0.6);
          ctx.lineTo(xR, a + b * xR + sd * 0.6); ctx.lineTo(xL, a + b * xL + sd * 0.6);
          ctx.closePath();
          ctx.fillStyle = rgba(ACCENT, 0.06 * la);
          ctx.fill();
        }

        for (const p of pos) {
          ctx.fillStyle = p.hi ? rgba(ACCENT, 0.3 + 0.55 * p.e) : rgba(INK, 0.08 + 0.14 * p.e);
          ctx.beginPath(); ctx.arc(p.x, p.y, p.hi ? 3.2 : 2.6, 0, Math.PI * 2); ctx.fill();
        }

        if (la > 0) {
          ctx.strokeStyle = rgba(ACCENT, 0.6 * la);
          ctx.lineWidth = 2;
          ctx.beginPath(); ctx.moveTo(xL, a + b * xL); ctx.lineTo(xR, a + b * xR); ctx.stroke();
        }
      }
    }
  };

  function resize() {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    W = innerWidth; H = innerHeight;
    canvas.width = W * dpr; canvas.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    state = {};
    if (modes[mode].init) modes[mode].init();
  }

  function frame(now) {
    if (!start) start = now;
    const done = modes[mode].draw(now - start);
    if (!done && !reduce) raf = requestAnimationFrame(frame);
  }

  function run() {
    cancelAnimationFrame(raf);
    start = 0;
    resize();
    raf = requestAnimationFrame(frame);
  }

  addEventListener('resize', run);
  addEventListener('pointermove', (e) => { mouse.x = e.clientX; mouse.y = e.clientY; });
  document.addEventListener('mouseout', (e) => { if (!e.relatedTarget) { mouse.x = mouse.y = -1e4; } });

  // random on every load; ?bg=<name> forces a specific one
  const names = Object.keys(modes);
  const params = new URLSearchParams(location.search);
  const requested = params.get('bg');
  const cycle = document.querySelector('.bg-cycle');
  let box = null;

  function setMode(name) {
    mode = name;
    run();
    if (cycle) cycle.querySelector('.bg-name').textContent = name;
    if (box) box.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.textContent === name)));
  }

  setMode(names.includes(requested) ? requested : names[Math.floor(Math.random() * names.length)]);

  if (cycle) {
    cycle.hidden = false;
    cycle.addEventListener('click', () => setMode(names[(names.indexOf(mode) + 1) % names.length]));
  }

  // Temporary picker: shown locally, or on the live site with ?preview
  const preview = params.has('preview') || location.protocol === 'file:' || /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
  if (preview) {
    box = document.createElement('div');
    box.className = 'bg-picker';
    box.innerHTML = '<span>Background preview</span>';
    names.forEach((name) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = name;
      btn.setAttribute('aria-pressed', String(name === mode));
      btn.addEventListener('click', () => {
        setMode(name);
        params.set('bg', name);
        try { history.replaceState(null, '', '?' + params); } catch (e) { /* file:// can refuse URL updates */ }
      });
      box.append(btn);
    });
    document.body.append(box);
  }
})();
