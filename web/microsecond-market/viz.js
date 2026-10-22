// 3D views: the order-book landscape and the latency globe (Three.js r128). Colours come from window.Theme.
(function () {
  'use strict';
  const THREE = window.THREE;
  const { CATS, PLACES } = window.MM;
  const { linkUs } = window.Engine;
  const CAT_KEYS = ['mm', 'rebate', 'arb', 'stat', 'anticip', 'wholesale', 'momentum', 'fund', 'inst', 'retail', 'manip', 'stub', 'you'];
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const MAX_N = 81, MAX_S = 120; // widest price range and longest history the view supports

  // ---------- camera control: drag to orbit, right-drag or shift-drag to pan, wheel or pinch to zoom ----------
  class Orbit {
    constructor(camera, el, o) {
      Object.assign(this, { cam: camera, el, target: o.target.clone(), r: o.r, theta: o.theta, phi: o.phi, minR: o.minR, maxR: o.maxR });
      this.ptrs = new Map(); this.goal = null; this.pinch = null; this.active = false;
      el.addEventListener('pointerdown', e => {
        if (!this.active || e.target !== el) return;
        el.setPointerCapture(e.pointerId); this.ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY }); this.engaged = true;
        this.panning = e.button === 2 || e.shiftKey; this.goal = null; this.pinch = null; this.manual = true;
      });
      el.addEventListener('pointermove', e => {
        const p = this.ptrs.get(e.pointerId); if (!p) return;
        const dx = e.clientX - p.x, dy = e.clientY - p.y; p.x = e.clientX; p.y = e.clientY;
        if (this.ptrs.size === 2) {
          const [a, b] = [...this.ptrs.values()], d = Math.hypot(a.x - b.x, a.y - b.y);
          if (this.pinch) this.r = clamp(this.r * this.pinch / Math.max(1, d), this.minR, this.maxR);
          this.pinch = d; return;
        }
        if (this.panning) {
          const right = new THREE.Vector3().setFromMatrixColumn(this.cam.matrix, 0), up = new THREE.Vector3().setFromMatrixColumn(this.cam.matrix, 1);
          this.target.addScaledVector(right, -dx * this.r * 0.0016).addScaledVector(up, dy * this.r * 0.0016);
        } else { this.theta -= dx * 0.006; this.phi = clamp(this.phi - dy * 0.006, 0.04, Math.PI - 0.08); }
      });
      const up = e => { this.ptrs.delete(e.pointerId); this.pinch = null; };
      el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
      el.addEventListener('pointerleave', () => { if (!this.ptrs.size) this.engaged = false; });
      // The wheel zooms only after a click inside the view (or with Ctrl held), so the page still scrolls normally.
      el.addEventListener('wheel', e => { if (!this.active || !(this.engaged || e.ctrlKey || e.metaKey)) return; e.preventDefault(); this.r = clamp(this.r * Math.exp(e.deltaY * 0.0012), this.minR, this.maxR); this.goal = null; }, { passive: false });
      el.addEventListener('contextmenu', e => e.preventDefault());
    }
    flyTo(target, r, theta, phi) {
      let t = theta; while (t - this.theta > Math.PI) t -= 2 * Math.PI; while (t - this.theta < -Math.PI) t += 2 * Math.PI;
      this.goal = { target: target.clone(), r, theta: t, phi };
    }
    update(dt) {
      if (this.goal) {
        const k = 1 - Math.pow(0.002, dt), g = this.goal;
        this.target.lerp(g.target, k); this.r += (g.r - this.r) * k; this.theta += (g.theta - this.theta) * k; this.phi += (g.phi - this.phi) * k;
        if (Math.abs(g.r - this.r) < 1e-3 * g.r && Math.abs(g.theta - this.theta) < 1e-3 && Math.abs(g.phi - this.phi) < 1e-3) this.goal = null;
      }
      this.cam.position.setFromSpherical(new THREE.Spherical(this.r, this.phi, this.theta)).add(this.target);
      this.cam.lookAt(this.target);
    }
  }

  // ---------- HTML labels pinned to 3D points ----------
  class Labels {
    constructor(layer) { this.layer = layer; this.els = new Map(); }
    set(key, html, cls) {
      let el = this.els.get(key);
      if (!el) { el = document.createElement('div'); el.className = 'lbl ' + (cls || ''); this.layer.appendChild(el); this.els.set(key, el); el._pos = new THREE.Vector3(); }
      if (el._html !== html) { el.innerHTML = html; el._html = html; }
      return el;
    }
    place(key, pos, camera, w, h, visible = true) {
      const el = this.els.get(key); if (!el) return;
      const p = el._pos.copy(pos).project(camera);
      const on = visible && p.z < 1 && Math.abs(p.x) < 1.05 && Math.abs(p.y) < 1.05;
      el.style.display = on ? '' : 'none';
      if (on) el.style.transform = `translate(${((p.x + 1) / 2 * w).toFixed(1)}px, ${((1 - p.y) / 2 * h).toFixed(1)}px)`;
    }
    hide(key) { const el = this.els.get(key); if (el) el.style.display = 'none'; }
    clear() { for (const el of this.els.values()) el.remove(); this.els.clear(); }
    hideAll() { for (const el of this.els.values()) el.style.display = 'none'; }
  }

  // Size-intensity colour scale for the heat colouring (dark navy -> blue -> cyan -> yellow -> white).
  const HEAT = ['#0B2A55', '#1E5FC2', '#00B8D9', '#FFD84D', '#FFFFFF'].map(h => new THREE.Color(h));
  function heat(t, out) {
    t = clamp(t, 0, 1) * (HEAT.length - 1);
    const i = Math.min(HEAT.length - 2, Math.floor(t));
    return out.copy(HEAT[i]).lerp(HEAT[i + 1], t - i);
  }

  // ---------- order-book landscape ----------
  class BookView {
    constructor(dom, layer) {
      this.dz = 0.85;
      this.scene = new THREE.Scene();
      this.scene.fog = new THREE.Fog('#000000', 55, 105);
      this.camera = new THREE.PerspectiveCamera(40, 1, 0.1, 600);
      this.orbit = new Orbit(this.camera, dom, { target: new THREE.Vector3(0, 2.5, -14), r: 46, theta: 0.42, phi: 1.08, minR: 8, maxR: 220 });
      this.labels = new Labels(layer);
      this.hemi = new THREE.HemisphereLight(0xdfe7f2, 0x0b0f14, 0.85); this.scene.add(this.hemi);
      const sun = new THREE.DirectionalLight(0xffffff, 0.55); sun.position.set(18, 40, 22); this.scene.add(sun);

      const geo = new THREE.BoxGeometry(0.78, 1, this.dz * 0.86); geo.translate(0, 0.5, 0);
      this.hist = new THREE.InstancedMesh(geo, new THREE.MeshLambertMaterial({ color: 0xffffff }), MAX_N * MAX_S);
      this.front = new THREE.InstancedMesh(geo, new THREE.MeshLambertMaterial({ color: 0xffffff, emissive: 0x111111 }), MAX_N * CAT_KEYS.length);
      for (const m of [this.hist, this.front]) {
        m.instanceMatrix.setUsage(THREE.DynamicDrawUsage); m.frustumCulled = false;
        const c = new THREE.Color(0x000000); for (let i = 0; i < m.count; i++) m.setColorAt(i, c);
        this.scene.add(m);
      }
      this.floorMat = new THREE.MeshBasicMaterial({ color: '#070707' });
      this.gridMat = new THREE.LineBasicMaterial({ color: '#1C1C1C' });
      const mk = () => {
        const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(MAX_S * 3), 3));
        const l = new THREE.Line(g, new THREE.LineBasicMaterial({ color: '#ffffff' })); l.frustumCulled = false; this.scene.add(l); return l;
      };
      this.midLine = mk(); this.fairLine = mk();
      // trade sparks
      this.parts = [];
      this.pmesh = new THREE.InstancedMesh(new THREE.SphereGeometry(0.22, 10, 8), new THREE.MeshBasicMaterial({ color: 0xffffff }), 300);
      this.pmesh.frustumCulled = false; this.pmesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      for (let i = 0; i < 300; i++) this.pmesh.setColorAt(i, new THREE.Color(0));
      this.scene.add(this.pmesh);
      // Selected price level: its queue is pulled out in front of the book as one block per order.
      const qgeo = new THREE.BoxGeometry(1.25, 1, 1.25); qgeo.translate(0, 0.5, 0);
      this.queue = new THREE.InstancedMesh(qgeo, new THREE.MeshLambertMaterial({ color: 0xffffff, emissive: 0x161616 }), 120);
      this.queue.instanceMatrix.setUsage(THREE.DynamicDrawUsage); this.queue.frustumCulled = false;
      for (let i = 0; i < 120; i++) this.queue.setColorAt(i, new THREE.Color(0));
      this.scene.add(this.queue);
      this.laneMat = new THREE.MeshBasicMaterial({ color: '#FFA028', transparent: true, opacity: 0.1, depthWrite: false });
      this.ray = new THREE.Raycaster(); this.floorPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
      this.sel = null; this.flash = new Map();
      this.dummy = new THREE.Object3D(); this.col = new THREE.Color(); this.white = new THREE.Color('#FFFFFF');
      this.qRef = 1000; this.slices = []; this.center = null;
      this.bidCol = new THREE.Color(); this.askCol = new THREE.Color(); this.bg = new THREE.Color();
      this.configure(window.Theme.prefs.book, true);
      this.applyTheme(window.Theme.c);
    }
    // ---- view options ----
    configure(o, first) {
      const old = this.opts || {};
      this.opts = Object.assign({}, o);
      const N = 2 * clamp(o.range | 0, 5, (MAX_N - 1) / 2) + 1, S = clamp(o.history | 0, 20, MAX_S);
      const resized = N !== this.N || S !== this.S;
      this.N = N; this.H = (N - 1) / 2; this.S = S;
      if (resized || first) {
        if (this.floor) { this.scene.remove(this.floor, this.grid, this.lane); this.floor.geometry.dispose(); this.grid.geometry.dispose(); this.lane.geometry.dispose(); }
        const depth = this.S * this.dz;
        this.floor = new THREE.Mesh(new THREE.PlaneGeometry(this.N + 4, depth + 6), this.floorMat);
        this.floor.rotation.x = -Math.PI / 2; this.floor.position.set(0, -0.01, -depth / 2 + 1.5); this.scene.add(this.floor);
        const gp = [], step = this.H >= 30 ? 10 : 5;
        for (let i = 0; i <= this.N; i += step) { const x = i - this.H - 0.5; gp.push(x, 0, 1, x, 0, -depth); }
        for (let a = 0; a <= this.S; a += 10) gp.push(-this.H - 0.5, 0, -a * this.dz, this.H + 0.5, 0, -a * this.dz);
        this.grid = new THREE.LineSegments(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(gp, 3)), this.gridMat);
        this.scene.add(this.grid);
        this.lane = new THREE.Mesh(new THREE.PlaneGeometry(1, depth + 6), this.laneMat);
        this.lane.rotation.x = -Math.PI / 2; this.lane.position.set(0, 0.02, -depth / 2 + 2); this.lane.visible = false; this.scene.add(this.lane);
        this.slices = []; this.center = null; this.labels.clear();
      }
      this.midLine.visible = this.fairLine.visible = !!o.lines;
      this.pmesh.visible = !!o.sparks;
      if (!o.labels) this.labels.hideAll();
      if (first || o.camera !== old.camera || resized) this.setCamera(o.camera, first);
      if (this.center != null) this.layout();
    }
    // Camera presets. "free" keeps whatever the user has dragged to.
    setCamera(name, instant) {
      const d = this.S * this.dz, wide = Math.max(1, this.H / 20), long = Math.max(1, this.S / 70), narrow = this.camera.aspect < 1.1;
      const P = {
        perspective: narrow ? [new THREE.Vector3(0, 4, -4), 58 * Math.max(wide, long) ** 0.7, 0.25, 1.08] : [new THREE.Vector3(0, 2.5, -d * 0.2), 46 * Math.max(wide, long) ** 0.7, 0.42, 1.08],
        front: [new THREE.Vector3(0, 3, -1), 29 * wide ** 0.9 / Math.min(1, this.camera.aspect / 1.6), 0, 1.45],
        // heatmap layout: price up the screen, time left to right with now at the right edge
        top: [new THREE.Vector3(0, 0, -d / 2 + 1.5), Math.max((d + 8) / (0.728 * Math.max(0.6, this.camera.aspect)), (this.N + 6) / 0.728) * 1.02, -Math.PI / 2, 0.02],
        side: [new THREE.Vector3(0, 2, -d / 2 + 2), (d * 0.82 + 10) / Math.min(1, this.camera.aspect / 1.6), -Math.PI / 2, 1.32], // now on the right
      }[name];
      if (!P) return;
      this.orbit.manual = false; // re-fitted on resize until the user drags the view
      if (instant) Object.assign(this.orbit, { target: P[0].clone(), r: P[1], theta: P[2], phi: P[3], goal: null });
      else this.orbit.flyTo(P[0], P[1], P[2], P[3]);
    }
    applyTheme(c) {
      this.scene.background = new THREE.Color(c.stage); this.scene.fog.color.set(c.stage);
      this.floorMat.color.set(c.floor); this.gridMat.color.set(c.grid2);
      this.midLine.material.color.set(c.accent); this.fairLine.material.color.set(c.fair); this.laneMat.color.set(c.accent);
      this.bidCol.set(c.bid); this.askCol.set(c.ask); this.bg.set(c.floor);
      if (this.center != null) this.layout();
    }
    attach(sim, venueId) { this.sim = sim; this.venue = sim.venueById[venueId]; this.reset(); }
    reset() { this.slices = []; this.center = null; this.parts = []; this.sel = null; this.flash.clear(); this.lastSeq = this.venue ? this.venue.tradeSeq : 0; this.labels.clear(); }
    // Click picking: hit a bar if possible, otherwise the floor; returns the selected price or null.
    pick(nx, ny) {
      if (this.center == null) return null;
      this.ray.setFromCamera({ x: nx, y: ny }, this.camera);
      let k = null;
      const hit = this.ray.intersectObjects([this.queue, this.front, this.hist], false)[0];
      if (hit && hit.instanceId != null) {
        if (hit.object === this.queue) return this.sel ? this.sel.px : null;
        k = hit.object === this.front ? Math.floor(hit.instanceId / CAT_KEYS.length) - this.H : (hit.instanceId % this.N) - this.H;
      } else {
        const p = new THREE.Vector3();
        if (this.ray.ray.intersectPlane(this.floorPlane, p) && p.z < 5 && p.z > -this.S * this.dz - 2) k = Math.round(p.x);
      }
      if (k == null || Math.abs(k) > this.H) { this.sel = null; this.layout(); return null; }
      this.sel = { px: this.center + k * this.slicesTick };
      this.layout();
      return this.sel.px;
    }
    select(px) { this.sel = px == null ? null : { px }; if (this.center != null) this.layout(); }
    queueInfo() {
      if (!this.sel || !this.venue) return null;
      const v = this.venue, px = this.sel.px;
      const bl = v.bids.get(px), al = v.asks.get(px), lvl = bl || al || [];
      const side = bl ? 'bid' : al ? 'ask' : (px <= v.mid() ? 'bid' : 'ask');
      return { venue: v, px, side, orders: lvl.slice() };
    }
    setVenue(id) { this.venue = this.sim.venueById[id]; this.reset(); }
    pushSlice() {
      const v = this.venue, sim = this.sim; if (!v) return;
      const mid = v.mid(), tick = v.tickAt(mid);
      if (this.center == null || Math.abs(mid - this.center) > Math.max(7, this.H / 3) * tick) { this.center = v.roundDown(mid); }
      this.slicesTick = tick;
      const bid = new Float32Array(this.N), ask = new Float32Array(this.N);
      let maxQ = 0;
      for (let i = 0; i < this.N; i++) {
        const px = this.center + (i - this.H) * tick;
        const b = v.bids.get(px), a = v.asks.get(px);
        if (b) bid[i] = v.visQty(b); if (a) ask[i] = v.visQty(a);
        maxQ = Math.max(maxQ, bid[i], ask[i]);
      }
      this.qRef = this.qRef * 0.97 + Math.max(200, maxQ) * 0.03;
      const mm = sim.agentByKey('mmFast');
      const fair = mm && mm.enabled ? mm.leadFair() : null;
      this.slices.unshift({ center: this.center, tick, bid, ask, mid, fair, N: this.N });
      if (this.slices.length > this.S) this.slices.length = this.S;
      // new trades -> sparks
      for (const t of v.tradesSince(this.lastSeq)) {
        if (this.parts.length > 280) this.parts.shift();
        this.parts.push({ px: t.px, q: t.q, cat: t.tk.cat, side: t.side, age: 0 });
        this.flash.set(t.px, 0);
      }
      this.lastSeq = v.tradeSeq;
      this.layout();
    }
    // bar height for a quantity, by the chosen scale
    h(q) {
      if (!(q > 0)) return 0;
      if (this.opts.style === 'heatmap') return 0.08;
      const x = q / this.qRef, s = this.opts.scale;
      const v = s === 'linear' ? x * 2.4 : s === 'log' ? Math.log2(1 + x * 3) * 2.2 : Math.sqrt(x) * 3.2;
      return Math.min(13, v + 0.08);
    }
    cellColor(side, q, fade) {
      const o = this.opts;
      if (o.color === 'heat' || o.style === 'heatmap' && o.color !== 'side') return heat(Math.sqrt(q / (this.qRef * 2.2)), this.col).lerp(this.bg, (1 - fade) * 0.55);
      return this.col.copy(side > 0 ? this.bidCol : this.askCol).lerp(this.bg, 1 - fade);
    }
    layout() {
      const d = this.dummy, N = this.N, H = this.H, cur = this.center, tick = this.slicesTick, o = this.opts;
      const flat = o.style === 'heatmap', sx = flat ? 1 / 0.78 : 1, sz = flat ? 1 / 0.86 : 1;
      let k = 0;
      for (let a = 1; a < this.S; a++) {
        const s = this.slices[a];
        for (let i = 0; i < N; i++, k++) {
          let q = 0, side = 0;
          if (s) {
            const j = Math.round((cur - s.center) / tick) + i + (s.N - N) / 2; // level in that slice at the same price
            if (j >= 0 && j < s.N) { if (s.bid[j] > 0) { q = s.bid[j]; side = 1; } else if (s.ask[j] > 0) { q = s.ask[j]; side = -1; } }
          }
          const hh = this.h(q);
          d.position.set(i - H, 0, -a * this.dz);
          if (hh > 0) d.scale.set(sx, hh, sz); else d.scale.set(0, 0, 0); // empty price levels are invisible
          d.updateMatrix();
          this.hist.setMatrixAt(k, d.matrix);
          this.hist.setColorAt(k, this.cellColor(side, q, Math.max(0.12, 1 - a / this.S)));
        }
      }
      for (; k < this.hist.count; k++) { d.scale.set(0, 0, 0); d.updateMatrix(); this.hist.setMatrixAt(k, d.matrix); }
      this.hist.instanceMatrix.needsUpdate = true; this.hist.instanceColor.needsUpdate = true;

      // front row: who owns each level (or its side / size, by colour option)
      const v = this.venue;
      const dep = v.depthByCat(cur, H, CAT_KEYS);
      let f = 0;
      for (let i = 0; i < N; i++) {
        const isBid = dep.bids[i].some(x => x > 0), row = isBid ? dep.bids[i] : dep.asks[i];
        const tot = row.reduce((x, y) => x + y, 0), H2 = this.h(tot);
        let y = 0;
        for (let c = 0; c < CAT_KEYS.length; c++, f++) {
          const share = tot > 0 ? row[c] / tot : 0, hh = H2 * share;
          d.position.set(i - H, y, 0); d.scale.set(1.05 * sx, Math.max(hh, 1e-4), 1.05 * sz); d.updateMatrix();
          if (hh <= 0) { d.scale.set(0, 0, 0); d.updateMatrix(); }
          this.front.setMatrixAt(f, d.matrix);
          if (o.color === 'participant' && !flat) this.col.set(CATS[CAT_KEYS[c]].color);
          else this.cellColor(isBid ? 1 : -1, tot, 1);
          const fl = this.flash.get(cur + (i - H) * tick); // a level that just traded glows briefly
          if (fl != null && fl < 0.4) this.col.lerp(this.white, 0.65 * (1 - fl / 0.4));
          this.front.setColorAt(f, this.col);
          y += hh;
        }
      }
      for (; f < this.front.count; f++) { d.scale.set(0, 0, 0); d.updateMatrix(); this.front.setMatrixAt(f, d.matrix); }
      this.front.instanceMatrix.needsUpdate = true; this.front.instanceColor.needsUpdate = true;

      // pulled-out queue for the selected price: first in line at the bottom
      let qn = 0;
      const qi = this.queueInfo();
      if (qi) {
        const kx = Math.round((qi.px - cur) / tick);
        const vis = qi.orders.map(q => q.display ? q.vis : q.rem), tot = vis.reduce((a, b) => a + b, 0);
        const Hc = Math.max(flat ? Math.sqrt(tot / this.qRef) * 3.2 : this.h(tot), 0.3);
        let y = 0;
        for (let j = 0; j < qi.orders.length && qn < 120; j++, qn++) {
          const hh = Math.max(0.07, Hc * vis[j] / Math.max(1, tot));
          d.position.set(kx, y, 2.4); d.scale.set(1, hh, 1); d.updateMatrix();
          this.queue.setMatrixAt(qn, d.matrix);
          this.col.set(CATS[qi.orders[j].agent.cat].color); this.queue.setColorAt(qn, this.col);
          y += hh + 0.06;
        }
        this.lane.visible = Math.abs(kx) <= H; this.lane.position.x = kx;
        this.qTop = y; this.qx = kx;
      } else this.lane.visible = false;
      for (let j = qn; j < 120; j++) { d.scale.set(0, 0, 0); d.updateMatrix(); this.queue.setMatrixAt(j, d.matrix); }
      this.queue.instanceMatrix.needsUpdate = true; if (this.queue.instanceColor) this.queue.instanceColor.needsUpdate = true;

      // mid and fair-value lines across time
      const mp = this.midLine.geometry.attributes.position, fp = this.fairLine.geometry.attributes.position, y0 = flat ? 0.14 : 0.06;
      for (let a = 0; a < this.S; a++) {
        const s = this.slices[Math.min(a, this.slices.length - 1)];
        const xm = s ? (s.mid - cur) / tick : 0, xf = s && s.fair != null ? (s.fair - cur) / tick : xm;
        mp.setXYZ(a, clamp(xm, -H - 1, H + 1), y0, -a * this.dz);
        fp.setXYZ(a, clamp(xf, -H - 1, H + 1), y0 + 0.04, -a * this.dz);
      }
      mp.needsUpdate = true; fp.needsUpdate = true;
      this.midLine.geometry.setDrawRange(0, Math.max(2, Math.min(this.S, this.slices.length)));
      this.fairLine.geometry.setDrawRange(0, Math.max(2, Math.min(this.S, this.slices.length)));
      const now = this.slices[0];
      this.fairLine.visible = !!o.lines && !!(now && now.fair != null);
    }
    update(dt, w, h) {
      const o = this.opts, orb = this.orbit;
      if (o.spin && !orb.ptrs.size && !orb.goal) orb.theta += dt * 0.12;
      orb.update(dt);
      const fogNear = orb.r + 6, fogFar = orb.r + this.S * this.dz * 1.15 + 14;
      this.scene.fog.near = fogNear; this.scene.fog.far = fogFar;
      for (const [p, a] of this.flash) { if (a + dt > 0.4) this.flash.delete(p); else this.flash.set(p, a + dt); }
      const d = this.dummy, tick = this.slicesTick || 1;
      let i = 0;
      if (o.sparks) for (const p of this.parts) {
        p.age += dt;
        const x = (p.px - this.center) / tick, life = 1 - p.age / 1.6;
        if (life <= 0 || Math.abs(x) > this.H + 2) continue;
        const s = (0.5 + Math.min(2.2, Math.sqrt(p.q / 300))) * (0.4 + 0.6 * life);
        d.position.set(x, 0.6 + p.age * 3.2, 0.4); d.scale.set(s, s, s); d.updateMatrix();
        this.pmesh.setMatrixAt(i, d.matrix); this.col.set(CATS[p.cat].color); this.pmesh.setColorAt(i, this.col); i++;
        if (i >= 300) break;
      }
      this.parts = this.parts.filter(p => p.age < 1.6);
      for (let j = i; j < 300; j++) { d.scale.set(0, 0, 0); d.updateMatrix(); this.pmesh.setMatrixAt(j, d.matrix); }
      this.pmesh.instanceMatrix.needsUpdate = true; if (this.pmesh.instanceColor) this.pmesh.instanceColor.needsUpdate = true;

      // labels
      if (!this.venue || this.center == null) return;
      const L = this.labels, cam = this.camera, sim = this.sim, H = this.H;
      if (o.labels) {
        const step = H >= 30 ? 10 : 5;
        for (let k = -H; k <= H; k += step) {
          const key = 'p' + k;
          L.set(key, sim.fmtPx(this.center + k * tick), 'px');
          L.place(key, new THREE.Vector3(k, 0, 2.2), cam, w, h);
        }
        L.set('bids', '◂ BIDS', 'side'); L.place('bids', new THREE.Vector3(-H + 3, 0, 4), cam, w, h);
        L.set('asks', 'ASKS ▸', 'side'); L.place('asks', new THREE.Vector3(H - 3, 0, 4), cam, w, h);
        L.set('now', 'NOW', 'axis'); L.place('now', new THREE.Vector3(H + 2.5, 0, 0), cam, w, h);
        L.set('past', 'EARLIER', 'axis'); L.place('past', new THREE.Vector3(H + 2.5, 0, -(this.S - 2) * this.dz), cam, w, h);
        const s0 = this.slices[0];
        if (s0 && o.lines) {
          L.set('mid', 'MID', 'mid'); L.place('mid', new THREE.Vector3(clamp((s0.mid - this.center) / tick, -H, H), 0.2, -3 * this.dz), cam, w, h);
          L.set('fair', 'FAIR VALUE (FUTURES)', 'fair');
          L.place('fair', new THREE.Vector3(s0.fair != null ? clamp((s0.fair - this.center) / tick, -H, H) : 0, 0.2, -10 * this.dz), cam, w, h, s0.fair != null);
        } else { L.hide('mid'); L.hide('fair'); }
      }
      if (this.sel && this.lane.visible) {
        L.set('qlab', 'QUEUE ▴ last in line<br>first in line at the bottom', 'queue');
        L.place('qlab', new THREE.Vector3(this.qx + 0.9, (this.qTop || 0) + 0.6, 2.4), cam, w, h);
      } else L.hide('qlab');
      if (this.venue.halted) { L.set('halt', 'TRADING PAUSED', 'halt'); L.place('halt', new THREE.Vector3(0, 9, -8), cam, w, h); }
      else L.hide('halt');
    }
  }

  // ---------- latency globe ----------
  const GLOBE_LINKS = [
    { id: 'chiMw', a: 'aurora', b: 'carteret', m: 'microwave', lift: 0.035, race: 'chi', label: 'Microwave' },
    { id: 'chiFi', a: 'aurora', b: 'carteret', m: 'longfiber', lift: 0.012, race: 'chi', label: 'Fiber' },
    { id: 'njLd', a: 'carteret', b: 'london', m: 'subsea', lift: 0.08, race: 'world', label: 'NJ → London' },
    { id: 'njHk', a: 'carteret', b: 'tko', m: 'subsea', lift: 0.16, race: 'world', label: 'NJ → Hong Kong' },
    { id: 'hkSg', a: 'tko', b: 'singapore', m: 'subsea', lift: 0.04, race: 'asia', label: 'HK → Singapore' },
    { id: 'hkTy', a: 'tko', b: 'tokyo', m: 'subsea', lift: 0.05, race: 'asia', label: 'HK → Tokyo' },
  ];
  const GLOBE_PLACES = [['aurora', 'Chicago (CME)'], ['carteret', 'New Jersey (NYSE, Nasdaq)'], ['london', 'London'], ['tko', 'Hong Kong (HKEX)'], ['singapore', 'Singapore'], ['tokyo', 'Tokyo']];

  function ll(lat, lon, r = 1) {
    const a = lat * Math.PI / 180, b = lon * Math.PI / 180;
    return new THREE.Vector3(r * Math.cos(a) * Math.cos(b), r * Math.sin(a), -r * Math.cos(a) * Math.sin(b));
  }

  class GlobeView {
    constructor(dom, layer) {
      this.scene = new THREE.Scene();
      this.camera = new THREE.PerspectiveCamera(38, 1, 0.01, 100);
      this.orbit = new Orbit(this.camera, dom, { target: new THREE.Vector3(0, 0, 0), r: 3.4, theta: 0, phi: 1.1, minR: 1.15, maxR: 8 });
      this.labels = new Labels(layer);
      this.scene.add(new THREE.AmbientLight(0x8899aa, 0.7));
      const sun = new THREE.DirectionalLight(0xffffff, 0.5); sun.position.set(3, 2, 4); this.scene.add(sun);
      this.sphereMat = new THREE.MeshPhongMaterial({ color: '#0C1622', emissive: '#03060A', shininess: 8 });
      this.scene.add(new THREE.Mesh(new THREE.SphereGeometry(1, 72, 54), this.sphereMat));
      // coastlines
      const pts = [];
      for (const ring of window.LAND) {
        for (let i = 0; i + 3 < ring.length; i += 2) {
          const p = ll(ring[i + 1], ring[i], 1.0015), q = ll(ring[i + 3], ring[i + 2], 1.0015);
          pts.push(p.x, p.y, p.z, q.x, q.y, q.z);
        }
      }
      this.coastMat = new THREE.LineBasicMaterial({ color: '#3D5C78' });
      this.scene.add(new THREE.LineSegments(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(pts, 3)), this.coastMat));
      // graticule
      const gp = [];
      for (let lat = -60; lat <= 60; lat += 30) for (let lon = -180; lon < 180; lon += 3) { const p = ll(lat, lon, 1.001), q = ll(lat, lon + 3, 1.001); gp.push(p.x, p.y, p.z, q.x, q.y, q.z); }
      for (let lon = -180; lon < 180; lon += 30) for (let lat = -84; lat < 84; lat += 3) { const p = ll(lat, lon, 1.001), q = ll(lat + 3, lon, 1.001); gp.push(p.x, p.y, p.z, q.x, q.y, q.z); }
      this.gratMat = new THREE.LineBasicMaterial({ color: '#121C27' });
      this.scene.add(new THREE.LineSegments(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(gp, 3)), this.gratMat));
      // places
      this.markers = [];
      for (const [k, name] of GLOBE_PLACES) {
        const P = PLACES[k], m = new THREE.Mesh(new THREE.SphereGeometry(0.012, 12, 10), new THREE.MeshBasicMaterial({ color: '#ffffff' }));
        m.position.copy(ll(P.lat, P.lon, 1.003)); this.scene.add(m); this.markers.push({ k, name, pos: m.position, mesh: m, venue: !!P.venue });
      }
      // links and packets
      this.links = GLOBE_LINKS.map(L => {
        const A = PLACES[L.a], B = PLACES[L.b];
        const va = ll(A.lat, A.lon), vb = ll(B.lat, B.lon), ang = va.angleTo(vb), n = 96, path = [];
        for (let i = 0; i <= n; i++) {
          const t = i / n, s = Math.sin(ang);
          const v = va.clone().multiplyScalar(Math.sin((1 - t) * ang) / s).add(vb.clone().multiplyScalar(Math.sin(t * ang) / s)).normalize();
          path.push(v.multiplyScalar(1.002 + L.lift * Math.sin(Math.PI * t)));
        }
        const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(path), new THREE.LineBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.75 }));
        this.scene.add(line);
        const pk = new THREE.Mesh(new THREE.SphereGeometry(0.016, 12, 10), new THREE.MeshBasicMaterial({ color: '#ffffff' }));
        this.scene.add(pk);
        const us = linkUs(L.a, L.b, L.m);
        return Object.assign({}, L, { path, pk, line, us, t: 0 });
      });
      this.secPerMs = 0.25; this.clock = 0; this.raceStart = {};
      this.applyTheme(window.Theme.c);
    }
    applyTheme(c) {
      this.c = c;
      this.scene.background = new THREE.Color(c.bg);
      this.sphereMat.color.set(c.globe); this.coastMat.color.set(c.coast); this.gratMat.color.set(c.grat);
      for (const m of this.markers) m.mesh.material.color.set(m.venue ? c.node : c.ink);
      for (const L of this.links) { L.line.material.color.set(c.media[L.m]); L.pk.material.color.set(c.media[L.m]); }
    }
    setScale(secPerMs) { this.secPerMs = secPerMs; this.clock = 0; this.raceStart = {}; }
    focus(where) {
      const presets = { us: [41, -80, 1.75], hk: [24, 118, 1.7], world: [35, -20, 3.4] };
      const [lat, lon, r] = presets[where] || presets.world;
      const v = ll(lat, lon);
      this.orbit.flyTo(new THREE.Vector3(0, 0, 0), r, Math.atan2(v.x, v.z), Math.acos(v.y));
    }
    update(dt, w, h) {
      this.orbit.update(dt);
      this.clock += dt;
      const groups = {};
      for (const L of this.links) (groups[L.race] = groups[L.race] || []).push(L);
      for (const list of Object.values(groups)) {
        const g = list[0].race, durs = list.map(L => L.us / 1000 * this.secPerMs), cycle = Math.max(...durs) + 0.8;
        if (this.raceStart[g] == null || this.clock - this.raceStart[g] > cycle) this.raceStart[g] = this.clock;
        const el = this.clock - this.raceStart[g];
        list.forEach((L, i) => {
          const t = Math.min(1, el / durs[i]), idx = t * (L.path.length - 1), i0 = Math.floor(idx), f = idx - i0;
          const p = L.path[i0].clone().lerp(L.path[Math.min(L.path.length - 1, i0 + 1)], f);
          L.pk.position.copy(p); L.pk.scale.setScalar((t >= 1 ? 1.4 : 1) * Math.min(1, this.orbit.r / 3.4) * (this.orbit.r < 2.2 ? 0.55 : 1));
          L.done = t >= 1;
        });
      }
      const camDir = this.camera.position.clone().normalize(), Lb = this.labels, c = this.c;
      for (const m of this.markers) {
        m.mesh.scale.setScalar(Math.min(1, this.orbit.r / 3.4) * (this.orbit.r < 2.2 ? 0.6 : 1));
        Lb.set('m' + m.k, m.name, 'place');
        Lb.place('m' + m.k, m.pos, this.camera, w, h, m.pos.clone().normalize().dot(camDir) > 0.15);
      }
      for (const L of this.links) {
        const mid = L.path[Math.round(L.path.length * (L.race === 'chi' ? (L.m === 'microwave' ? 0.42 : 0.62) : 0.5))];
        const ms = L.us / 1000;
        Lb.set('l' + L.id, `<b style="color:${c.media[L.m]}">${L.label}</b> ${ms < 10 ? ms.toFixed(2) : ms.toFixed(1)} ms one way${L.done ? ' <span class="arr">arrived</span>' : ''}`, 'link');
        Lb.place('l' + L.id, mid, this.camera, w, h, mid.clone().normalize().dot(camDir) > 0.2);
      }
    }
  }

  window.Viz = { BookView, GlobeView, CAT_KEYS, Labels, ll, MAX_N, MAX_S };
})();
