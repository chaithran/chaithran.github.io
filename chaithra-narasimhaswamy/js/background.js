// ---------------------------------------------------------------------------------
// Animated background: a 3D "vector search tower".
//
// It draws an HNSW index (Hierarchical Navigable Small World), the multi-layer graph
// that vector databases use for nearest-neighbour search. Each floor is one layer:
// the top floor holds a few vectors, the bottom floor all of them. On a loop, a query
// appears above the tower, hops greedily across each floor towards the closest vector,
// drops to the floor below, and finally lights up its top-k nearest neighbours.
//
// Drawn on <canvas id="bg-net"> in index.html, behind the page.
// Colours: --hnsw-* tokens in css/tokens.css (one per floor, plus path, query, label).
// Tuning: the numbers in SETTINGS below.
// Visitors with "reduce motion" turned on see one still frame of a finished search.
// ---------------------------------------------------------------------------------
(function () {
    const SETTINGS = {
        // Floors from top to bottom: how many vectors, and how many neighbours each links to.
        floors: [
            { count: 5, links: 2 },
            { count: 12, links: 3 },
            { count: 28, links: 3 },
            { count: 64, links: 4 },
        ],
        floorGap: 0.62,      // vertical space between floors (world units)
        half: 1.15,          // half the width of a floor
        spin: 0.045,         // tower rotation, radians per second
        pitch: 0.5,          // how far the camera looks down
        hopMs: 520,          // one hop across a floor
        dropMs: 420,         // one drop to the floor below
        revealMs: 1400,      // showing the top-k results
        holdMs: 1600,        // pause before the next query
        fadeMs: 600,
        topK: 5,
        stars: 70,
    };

    const canvas = document.getElementById("bg-net");
    if (!canvas || !canvas.getContext) return;
    const ctx = canvas.getContext("2d");
    const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");
    const F = SETTINGS.floors.length;

    let width = 0, height = 0, dpr = 1, scale = 1, ox = 0, oy = 0, dim = 1;
    let colors = null, points = [], floorEdges = [], neighbours = [], stars = [];
    let search = null, running = false, frame = 0, last = 0;
    let yaw = 0.6, tiltX = 0, tiltY = 0, aimX = 0, aimY = 0;

    // ---------- colours ----------

    function hexToRgb(hex) {
        const h = hex.replace("#", "").trim();
        const n = parseInt(h.length === 3 ? h.split("").map(c => c + c).join("") : h, 16);
        return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    }
    const rgba = (rgb, a) => `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${Math.max(0, Math.min(1, a))})`;

    function readColors() {
        const css = getComputedStyle(document.documentElement);
        const v = (name, fallback) => css.getPropertyValue(name).trim() || fallback;
        colors = {
            floors: [v("--hnsw-1", "#ff6fb5"), v("--hnsw-2", "#b07cff"), v("--hnsw-3", "#6f8bff"), v("--hnsw-4", "#3fd6e0")].map(hexToRgb),
            path: hexToRgb(v("--hnsw-path", "#ffd166")),
            query: hexToRgb(v("--hnsw-query", "#ffffff")),
            label: hexToRgb(v("--hnsw-label", "#97a2c2")),
            strength: parseFloat(v("--hnsw-strength", "1")) || 1,
            font: v("--font-code", "monospace"),
        };
    }

    // ---------- the index ----------

    function buildIndex() {
        // Points spread over the floor, not too close to each other.
        const total = SETTINGS.floors[F - 1].count;
        points = [];
        let minDist = 0.2, tries = 0;
        while (points.length < total) {
            const p = { x: Math.random() * 2 - 1, z: Math.random() * 2 - 1 };
            if (points.every(q => Math.hypot(p.x - q.x, p.z - q.z) > minDist)) points.push(p);
            if (++tries % 400 === 0) minDist *= 0.9;
        }
        // Vector i lives on every floor whose count is larger than i, so upper floors
        // hold a subset of the floors below them, as in HNSW.
        floorEdges = []; neighbours = [];
        SETTINGS.floors.forEach(({ count, links }, f) => {
            const adj = new Map(), edges = [];
            for (let i = 0; i < count; i++) adj.set(i, new Set());
            for (let i = 0; i < count; i++) {
                const nearest = [...Array(count).keys()].filter(j => j !== i)
                    .sort((a, b) => dist(points[a], points[i]) - dist(points[b], points[i]))
                    .slice(0, links);
                for (const j of nearest) {
                    if (!adj.get(i).has(j)) edges.push([i, j]);
                    adj.get(i).add(j); adj.get(j).add(i);
                }
            }
            neighbours[f] = adj; floorEdges[f] = edges;
        });
    }

    const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
    const floorY = f => ((F - 1) / 2 - f) * SETTINGS.floorGap;

    // Greedy search from the top floor down, like an HNSW lookup.
    function newSearch(now) {
        const q = { x: (Math.random() * 2 - 1) * 0.85, z: (Math.random() * 2 - 1) * 0.85 };
        const steps = [{ type: "enter", node: 0, ms: 520 }];
        let current = 0;
        for (let f = 0; f < F; f++) {
            for (;;) {
                let best = current;
                for (const n of neighbours[f].get(current)) if (dist(points[n], q) < dist(points[best], q)) best = n;
                if (best === current) break;
                steps.push({ type: "hop", floor: f, from: current, to: best, ms: SETTINGS.hopMs });
                current = best;
            }
            if (f < F - 1) steps.push({ type: "drop", floor: f, node: current, ms: SETTINGS.dropMs });
        }
        const results = [...points.keys()].sort((a, b) => dist(points[a], q) - dist(points[b], q)).slice(0, SETTINGS.topK);
        const searchMs = steps.reduce((s, x) => s + x.ms, 0);
        search = { q, steps, results, start: now, searchMs };
    }

    // ---------- camera ----------

    function project(x, y, z) {
        const cy = Math.cos(yaw + tiltX), sy = Math.sin(yaw + tiltX);
        const pitch = SETTINGS.pitch + tiltY;
        const cp = Math.cos(pitch), sp = Math.sin(pitch);
        const rx = x * cy - z * sy, rz = x * sy + z * cy;
        const py = y * cp - rz * sp, pz = y * sp + rz * cp;
        const D = 9, f = D / (D - pz);
        return { x: ox + rx * scale * f, y: oy - py * scale * f, s: f };
    }
    const nodeAt = (i, f) => project(points[i].x * SETTINGS.half * 0.9, floorY(f), points[i].z * SETTINGS.half * 0.9);

    function resize() {
        dpr = Math.min(window.devicePixelRatio || 1, 2);
        width = window.innerWidth; height = window.innerHeight;
        canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        const phone = width < 700;
        dim = phone ? 0.45 : 1; // quieter on phones, where text sits right on top of the tower
        scale = phone ? Math.min(width * 0.3, height * 0.2) : Math.min(width * 0.19, height * 0.24);
        ox = width * 0.5;
        oy = height * 0.56;
        stars = Array.from({ length: phone ? 35 : SETTINGS.stars }, () => ({
            x: Math.random() * width, y: Math.random() * height,
            r: 0.5 + Math.random() * 1.3, c: Math.floor(Math.random() * F),
            vx: (Math.random() - 0.5) * 0.05, vy: (Math.random() - 0.5) * 0.05, t: Math.random() * 6.28,
        }));
    }

    // ---------- drawing ----------

    function line(a, b, color, w) {
        ctx.strokeStyle = color; ctx.lineWidth = w;
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    }
    function dot(p, r, color) {
        ctx.fillStyle = color; ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.fill();
    }
    const depth = p => 0.55 + 0.45 * Math.max(0, Math.min(1, (p.s - 0.85) / 0.3));

    function drawStars(now) {
        for (const s of stars) {
            const a = (0.35 + 0.35 * Math.sin(now / 900 + s.t)) * colors.strength * 0.8 * dim;
            dot(s, s.r, rgba(colors.floors[s.c], a));
        }
    }

    function drawTower(now, visited) {
        const H = SETTINGS.half, k = colors.strength * dim;
        const corners = f => [[-H, -H], [H, -H], [H, H], [-H, H]].map(([x, z]) => project(x, floorY(f), z));

        // corner pillars: the building frame
        const top = corners(0), bottom = corners(F - 1);
        ctx.setLineDash([]);
        for (let c = 0; c < 4; c++) line(top[c], bottom[c], rgba(colors.label, 0.22 * k), 1);

        // pillars under every vector of the upper floors
        ctx.setLineDash([2, 5]);
        for (let i = 0; i < SETTINGS.floors[F - 2].count; i++) {
            const highest = SETTINGS.floors.findIndex(fl => i < fl.count);
            line(nodeAt(i, highest), nodeAt(i, F - 1), rgba(colors.floors[highest], 0.18 * k), 1);
        }
        ctx.setLineDash([]);

        // floors, bottom first so upper floors draw on top
        for (let f = F - 1; f >= 0; f--) {
            const c = colors.floors[f], cs = corners(f);

            ctx.beginPath(); cs.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y))); ctx.closePath();
            ctx.fillStyle = rgba(c, 0.045 * k); ctx.fill();
            ctx.strokeStyle = rgba(c, 0.42 * k); ctx.lineWidth = 1.1; ctx.stroke();

            // floor grid
            for (let g = 1; g < 4; g++) {
                const t = -H + (2 * H * g) / 4;
                line(project(t, floorY(f), -H), project(t, floorY(f), H), rgba(c, 0.08 * k), 1);
                line(project(-H, floorY(f), t), project(H, floorY(f), t), rgba(c, 0.08 * k), 1);
            }

            // links between neighbours on this floor
            for (const [a, b] of floorEdges[f]) {
                const pa = nodeAt(a, f), pb = nodeAt(b, f);
                line(pa, pb, rgba(c, 0.34 * k * depth(pa)), 1);
            }

            // vectors
            const count = SETTINGS.floors[f].count;
            for (let i = 0; i < count; i++) {
                const p = nodeAt(i, f), d = depth(p);
                const r = (f === F - 1 ? 1.7 : 2.4) * p.s;
                if (visited.has(f + ":" + i)) {
                    dot(p, r * 4, rgba(colors.path, 0.18 * k));
                    dot(p, r * 1.5, rgba(colors.path, 0.95 * k));
                } else {
                    dot(p, r * 2.6, rgba(c, 0.08 * k * d));
                    dot(p, r, rgba(c, 0.9 * k * d));
                }
            }

            // floor label at the right-most corner
            if (width >= 700) {
                const right = cs.reduce((a, b) => (b.x > a.x ? b : a));
                const text = `L${F - 1 - f} · ${count} vectors`;
                ctx.font = `11px ${colors.font}`;
                const w = ctx.measureText(text).width;
                const x = right.x + 12 + w < width - 8 ? right.x + 12 : right.x - 12 - w;
                ctx.fillStyle = rgba(c, 0.75 * k);
                ctx.fillText(text, x, right.y + 4);
            }
        }
    }

    function drawSearch(now) {
        const s = search, k = colors.strength * dim, P = colors.path;
        const t = now - s.start;
        const fadeStart = s.searchMs + SETTINGS.revealMs + SETTINGS.holdMs;
        const fade = t > fadeStart ? Math.max(0, 1 - (t - fadeStart) / SETTINGS.fadeMs) : 1;
        const a = k * fade;

        const qTop = project(s.q.x * SETTINGS.half * 0.9, floorY(0) + 0.55, s.q.z * SETTINGS.half * 0.9);
        const qBottom = project(s.q.x * SETTINGS.half * 0.9, floorY(F - 1), s.q.z * SETTINGS.half * 0.9);

        // query: a bright marker above the tower, with a guide line down to where it lands
        ctx.setLineDash([3, 5]);
        line(qTop, qBottom, rgba(colors.query, 0.25 * a), 1);
        ctx.setLineDash([]);
        const pulse = 1 + 0.25 * Math.sin(now / 220);
        dot(qTop, 11 * pulse, rgba(P, 0.15 * a));
        ctx.save(); ctx.translate(qTop.x, qTop.y); ctx.rotate(Math.PI / 4);
        ctx.fillStyle = rgba(colors.query, 0.95 * a); ctx.fillRect(-4, -4, 8, 8); ctx.restore();
        if (width >= 700) {
            ctx.font = `11px ${colors.font}`; ctx.fillStyle = rgba(colors.query, 0.8 * a);
            ctx.fillText("query", qTop.x + 12, qTop.y - 8);
        }

        // the path, step by step
        const visited = new Set();
        let elapsed = t;
        for (const step of s.steps) {
            const p = Math.max(0, Math.min(1, elapsed / step.ms));
            if (p <= 0) break;
            let from, to, endKey;
            if (step.type === "enter") { from = qTop; to = nodeAt(step.node, 0); endKey = "0:" + step.node; }
            else if (step.type === "hop") { from = nodeAt(step.from, step.floor); to = nodeAt(step.to, step.floor); endKey = step.floor + ":" + step.to; visited.add(step.floor + ":" + step.from); }
            else { from = nodeAt(step.node, step.floor); to = nodeAt(step.node, step.floor + 1); endKey = (step.floor + 1) + ":" + step.node; visited.add(step.floor + ":" + step.node); }
            const head = { x: from.x + (to.x - from.x) * p, y: from.y + (to.y - from.y) * p };
            line(from, head, rgba(P, 0.2 * a), 4);
            line(from, head, rgba(P, 0.85 * a), 1.4);
            if (p < 1) { dot(head, 7, rgba(P, 0.25 * a)); dot(head, 2.8, rgba(colors.query, a)); }
            else visited.add(endKey);
            elapsed -= step.ms;
        }

        // results: the top-k nearest vectors on the bottom floor
        const r = Math.max(0, Math.min(1, (t - s.searchMs) / SETTINGS.revealMs));
        if (r > 0) {
            s.results.forEach((i, n) => {
                const local = Math.max(0, Math.min(1, r * 1.6 - n * 0.12));
                if (local <= 0) return;
                const p = nodeAt(i, F - 1);
                ctx.setLineDash([2, 4]);
                line(qBottom, p, rgba(P, 0.55 * a * local), 1);
                ctx.setLineDash([]);
                ctx.strokeStyle = rgba(P, (1 - local * 0.6) * a); ctx.lineWidth = 1.4;
                ctx.beginPath(); ctx.arc(p.x, p.y, 3 + local * 9, 0, Math.PI * 2); ctx.stroke();
                dot(p, 3.2, rgba(P, a));
                visited.add((F - 1) + ":" + i);
            });
            if (width >= 700) {
                ctx.font = `11px ${colors.font}`; ctx.fillStyle = rgba(P, 0.85 * a * r);
                ctx.fillText(`top-${SETTINGS.topK} nearest`, qBottom.x + 14, qBottom.y + 22);
            }
        }
        return { visited, done: t > fadeStart + SETTINGS.fadeMs };
    }

    function render(now) {
        ctx.clearRect(0, 0, width, height);
        drawStars(now);
        // vectors the search has already reached glow on their floor
        drawTower(now, search ? collectVisited(now) : new Set());
        if (search) {
            const { done } = drawSearch(now);
            if (done) newSearch(now);
        }
    }

    // Which vectors the search has reached so far (for the glow on the floors).
    function collectVisited(now) {
        const set = new Set();
        let elapsed = now - search.start;
        for (const step of search.steps) {
            if (elapsed < step.ms) break;
            if (step.type === "enter") set.add("0:" + step.node);
            else if (step.type === "hop") { set.add(step.floor + ":" + step.from); set.add(step.floor + ":" + step.to); }
            else { set.add(step.floor + ":" + step.node); set.add((step.floor + 1) + ":" + step.node); }
            elapsed -= step.ms;
        }
        return set;
    }

    // ---------- loop ----------

    function loop(now) {
        if (!running) return;
        const dt = Math.min(64, now - (last || now)); last = now;
        yaw += SETTINGS.spin * dt / 1000;
        tiltX += (aimX - tiltX) * 0.04; tiltY += (aimY - tiltY) * 0.04;
        for (const s of stars) {
            s.x += s.vx * dt; s.y += s.vy * dt;
            if (s.x < 0) s.x += width; else if (s.x > width) s.x -= width;
            if (s.y < 0) s.y += height; else if (s.y > height) s.y -= height;
        }
        render(now);
        frame = requestAnimationFrame(loop);
    }

    function start() {
        if (reduceMotion.matches || document.hidden) { drawStill(); return; }
        if (running) return;
        running = true; last = 0;
        frame = requestAnimationFrame(loop);
    }
    function stop() { running = false; cancelAnimationFrame(frame); }

    // One frame of a finished search, for reduced motion and while hidden.
    function drawStill() {
        const now = performance.now();
        if (!search) newSearch(now);
        search.start = now - search.searchMs - SETTINGS.revealMs; // results fully shown
        render(now);
    }

    readColors();
    buildIndex();
    resize();
    newSearch(performance.now());
    if (reduceMotion.matches) drawStill(); else start();

    window.addEventListener("resize", () => { resize(); if (!running) drawStill(); });
    document.addEventListener("visibilitychange", () => (document.hidden ? stop() : start()));
    reduceMotion.addEventListener?.("change", () => { stop(); start(); });
    window.addEventListener("pointermove", e => {
        if (e.pointerType !== "mouse") return;
        aimX = (e.clientX / width - 0.5) * 0.35;
        aimY = (e.clientY / height - 0.5) * 0.1;
    }, { passive: true });

    // Re-read colours and strength when the visitor switches theme or view (site.js sets data-theme / data-mode on <html>).
    new MutationObserver(() => { readColors(); if (!running) drawStill(); })
        .observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-mode"] });
})();
