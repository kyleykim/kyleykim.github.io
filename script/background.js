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

    line: {
      init() {
        const rand = seeded(7), n = 64, pts = [];
        let v = 0;
        for (let i = 0; i < n; i++) {
          v += (rand() - 0.42) * 1.2;
          pts.push(v);
        }
        const lo = Math.min(...pts), hi = Math.max(...pts);
        state = {
          pts: pts.map((p, i) => [(i / (n - 1)) * W, H * 0.92 - ((p - lo) / (hi - lo)) * H * 0.38])
        };
      },
      draw(t) {
        const { pts } = state;
        const p = reduce ? 1 : Math.min(1, t / 2800);
        const e = 1 - (1 - p) ** 3;
        const k = Math.max(1, Math.floor(e * (pts.length - 1)));
        const visible = pts.slice(0, k + 1);
        ctx.clearRect(0, 0, W, H);

        ctx.strokeStyle = rgba(INK, 0.07);
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let i = 1; i <= 4; i++) {
          const y = Math.round(H * 0.5 + i * H * 0.1) + 0.5;
          ctx.moveTo(0, y); ctx.lineTo(W, y);
        }
        ctx.stroke();

        ctx.beginPath();
        visible.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
        const [lx, ly] = visible[visible.length - 1];
        ctx.lineTo(lx, H); ctx.lineTo(0, H); ctx.closePath();
        ctx.fillStyle = rgba(ACCENT, 0.06);
        ctx.fill();

        ctx.beginPath();
        visible.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
        ctx.strokeStyle = rgba(ACCENT, 0.55);
        ctx.lineWidth = 2;
        ctx.stroke();

        ctx.fillStyle = rgba(ACCENT, 0.9);
        ctx.beginPath(); ctx.arc(lx, ly, 3.5, 0, Math.PI * 2); ctx.fill();
        return p === 1;
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
  const requested = new URLSearchParams(location.search).get('bg');
  mode = names.includes(requested) ? requested : names[Math.floor(Math.random() * names.length)];
  run();
})();
