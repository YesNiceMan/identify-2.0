import { TYPES, clamp, reduceMotion } from './util.js';

/**
 * 背景画布：透视点阵 + 雷达扫描 + 资源星座
 * 扫描时每个被识别到的资源都会在现场生成一个节点。
 */
export class Radar {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.mode = 'idle';
    this.progress = 0;
    this.nodes = [];
    this.ambient = [];
    this.bursts = [];
    this.mouse = { x: 0.5, y: 0.4, tx: 0.5, ty: 0.4 };
    this.t = 0;
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.static = reduceMotion();
    this.resize();
    this._onResize = () => this.resize();
    this._onMove = (e) => {
      this.mouse.tx = e.clientX / window.innerWidth;
      this.mouse.ty = e.clientY / window.innerHeight;
    };
    this._onVis = () => { if (document.hidden) this.stop(); else this.start(); };
    window.addEventListener('resize', this._onResize);
    window.addEventListener('pointermove', this._onMove, { passive: true });
    document.addEventListener('visibilitychange', this._onVis);
    this.seedAmbient();
    if (!this.static) this.start();
    else this.draw();
  }

  resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.w = w;
    this.h = h;
    this.canvas.width = Math.floor(w * this.dpr);
    this.canvas.height = Math.floor(h * this.dpr);
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    if (this.static) this.draw();
  }

  seedAmbient() {
    this.ambient = [];
    for (let i = 0; i < 26; i++) {
      this.ambient.push({
        x: Math.random(), y: Math.random(),
        vx: (Math.random() - 0.5) * 0.00016,
        vy: (Math.random() - 0.5) * 0.00013,
        r: 0.6 + Math.random() * 1.8,
        a: 0.1 + Math.random() * 0.3,
      });
    }
  }

  setMode(mode) { this.mode = mode; }
  setProgress(p) { this.progress = clamp(p, 0, 100); }

  addNode(type) {
    if (this.nodes.length > 300) this.nodes.shift();
    const info = TYPES[type] || TYPES.other;
    const angle = Math.random() * Math.PI * 2;
    const radius = 0.12 + Math.random() * 0.42;
    this.nodes.push({
      type,
      color: info.color,
      shape: type === 'video' || type === 'audio' ? 'tri' : type === 'font' || type === 'stylesheet' ? 'ring' : 'box',
      x: 0.5 + Math.cos(angle) * radius * (this.w / Math.max(1, this.h)) * 0.9,
      y: 0.5 + Math.sin(angle) * radius,
      vx: (Math.random() - 0.5) * 0.00022,
      vy: (Math.random() - 0.5) * 0.00022,
      size: 1.6 + Math.random() * 3.4,
      born: this.t,
      a: 0,
      pulse: 1,
    });
  }

  burst(x, y) {
    this.bursts.push({ x: x == null ? 0.5 : x, y: y == null ? 0.42 : y, r: 0, life: 1 });
  }

  clear() { this.nodes.length = 0; this.bursts.length = 0; }

  start() {
    if (this.raf) return;
    const loop = () => {
      this.t += 1;
      this.draw();
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = null;
  }

  destroy() {
    this.stop();
    window.removeEventListener('resize', this._onResize);
    window.removeEventListener('pointermove', this._onMove);
    document.removeEventListener('visibilitychange', this._onVis);
  }

  draw() {
    const ctx = this.ctx;
    const w = this.w;
    const h = this.h;
    ctx.clearRect(0, 0, w, h);
    this.mouse.x += (this.mouse.tx - this.mouse.x) * 0.05;
    this.mouse.y += (this.mouse.ty - this.mouse.y) * 0.05;
    this.drawGrid(ctx, w, h);
    this.drawSweep(ctx, w, h);
    this.drawNodes(ctx, w, h);
    this.drawBursts(ctx, w, h);
    if (this.mode === 'scan' && !this.static) this.drawScanline(ctx, w, h);
  }

  drawGrid(ctx, w, h) {
    const gap = 46;
    const px = (this.mouse.x - 0.5) * 16;
    const py = (this.mouse.y - 0.5) * 12;
    const drift = (this.t * 0.06) % gap;
    ctx.save();
    for (let x = -gap; x < w + gap; x += gap) {
      for (let y = -gap; y < h + gap; y += gap) {
        const gx = x + px - drift;
        const gy = y + py - drift * 0.5;
        const d = Math.hypot(gx - w * this.mouse.x, gy - h * this.mouse.y);
        const near = clamp(1 - d / 320, 0, 1);
        const a = 0.045 + near * 0.34;
        ctx.fillStyle = near > 0.55 ? 'rgba(184,255,60,' + (a * 0.85).toFixed(3) + ')' : 'rgba(140,170,200,' + a.toFixed(3) + ')';
        const s = 1 + near * 1.4;
        ctx.fillRect(gx, gy, s, s);
      }
    }
    ctx.restore();
  }

  drawSweep(ctx, w, h) {
    const cx = w * (this.mode === 'idle' ? 0.78 : 0.5);
    const cy = h * (this.mode === 'idle' ? 0.24 : 0.44);
    const radius = Math.max(w, h) * (this.mode === 'scan' ? 0.72 : 0.5);
    const speed = this.mode === 'scan' ? 0.011 : 0.0028;
    const angle = this.t * speed;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(angle);
    const grad = ctx.createLinearGradient(0, 0, radius, 0);
    const strength = this.mode === 'idle' ? 0.06 : 0.14;
    grad.addColorStop(0, 'rgba(184,255,60,' + strength + ')');
    grad.addColorStop(0.6, 'rgba(74,217,255,' + (strength * 0.4).toFixed(3) + ')');
    grad.addColorStop(1, 'rgba(74,217,255,0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, radius, -0.42, 0);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    ctx.save();
    ctx.translate(cx, cy);
    const rings = this.mode === 'idle' ? 3 : 5;
    for (let i = 1; i <= rings; i++) {
      const rr = (radius * 0.82 / rings) * i;
      ctx.beginPath();
      ctx.arc(0, 0, rr, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(255,255,255,' + (0.028 + (i === rings ? 0.02 : 0)).toFixed(3) + ')';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    ctx.restore();
  }

  drawScanline(ctx, w) {
    const y = ((this.t * 3.2) % (window.innerHeight + 260)) - 130;
    const grad = ctx.createLinearGradient(0, y - 70, 0, y + 70);
    grad.addColorStop(0, 'rgba(74,217,255,0)');
    grad.addColorStop(0.5, 'rgba(74,217,255,0.07)');
    grad.addColorStop(1, 'rgba(74,217,255,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, y - 70, w, 140);
  }

  drawNodes(ctx, w, h) {
    const nodes = this.nodes;
    for (const n of nodes) {
      n.a += (1 - n.a) * 0.06;
      n.x += n.vx * w * 0.006;
      n.y += n.vy * h * 0.006;
      if (n.x < 0.02 || n.x > 0.98) n.vx *= -1;
      if (n.y < 0.02 || n.y > 0.98) n.vy *= -1;
      n.pulse = 1 + Math.sin((this.t - n.born) * 0.05) * 0.25;
    }
    ctx.save();
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j];
        const ax = a.x * w; const ay = a.y * h;
        const bx = b.x * w; const by = b.y * h;
        const d = Math.hypot(ax - bx, ay - by);
        if (d > 128) continue;
        ctx.strokeStyle = 'rgba(120,160,190,' + ((1 - d / 128) * 0.1 * Math.min(a.a, b.a)).toFixed(3) + ')';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.lineTo(bx, by);
        ctx.stroke();
      }
    }
    for (const n of nodes) {
      const x = n.x * w; const y = n.y * h;
      const s = n.size * n.pulse;
      ctx.globalAlpha = n.a * 0.85;
      ctx.fillStyle = n.color;
      ctx.strokeStyle = n.color;
      if (n.shape === 'box') {
        ctx.fillRect(x - s / 2, y - s / 2, s, s);
      } else if (n.shape === 'ring') {
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(x, y, s, 0, Math.PI * 2);
        ctx.stroke();
      } else {
        ctx.beginPath();
        ctx.moveTo(x, y - s);
        ctx.lineTo(x + s, y + s);
        ctx.lineTo(x - s, y + s);
        ctx.closePath();
        ctx.fill();
      }
      if (this.t - n.born < 26) {
        ctx.globalAlpha = (1 - (this.t - n.born) / 26) * 0.5;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(x, y, s + (this.t - n.born) * 1.7, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
    ctx.restore();

    ctx.save();
    for (const p of this.ambient) {
      p.x += p.vx * w; p.y += p.vy * h;
      if (p.x < 0 || p.x > 1) p.vx *= -1;
      if (p.y < 0 || p.y > 1) p.vy *= -1;
      ctx.fillStyle = 'rgba(200,220,240,' + (p.a * 0.5).toFixed(3) + ')';
      ctx.beginPath();
      ctx.arc(p.x * w, p.y * h, p.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  drawBursts(ctx, w, h) {
    for (let i = this.bursts.length - 1; i >= 0; i--) {
      const b = this.bursts[i];
      b.r += 9;
      b.life -= 0.018;
      if (b.life <= 0) { this.bursts.splice(i, 1); continue; }
      ctx.strokeStyle = 'rgba(184,255,60,' + (b.life * 0.34).toFixed(3) + ')';
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.arc(b.x * w, b.y * h, b.r, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
}
