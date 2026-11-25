// Small browser helpers that Blazor calls through JS interop (see Services/BrowserService.cs).
// Everything else on the site is C#.
window.site = {
    // Preferences are stored in the visitor's browser only (no cookies, no server).
    getPref(key) {
        try { return localStorage.getItem(key); } catch { return null; }
    },
    setPref(key, value) {
        try { localStorage.setItem(key, value); } catch { /* private mode: ignore */ }
    },

    // theme: "light" | "dark", mode: "recruiter" | "engineer"
    applyRoot(theme, mode, lang) {
        const d = document.documentElement;
        d.dataset.theme = theme;
        d.dataset.mode = mode;
        d.lang = lang;
        const meta = document.querySelectorAll('meta[name="theme-color"]');
        meta.forEach(m => m.setAttribute("content", theme === "dark" ? "#070b1a" : "#eef2f8"));
    },

    prefersDark() {
        return matchMedia("(prefers-color-scheme: dark)").matches;
    },
    prefersReducedMotion() {
        return matchMedia("(prefers-reduced-motion: reduce)").matches;
    },

    scrollToId(id) {
        const el = document.getElementById(id);
        if (!el) return;
        el.scrollIntoView({ behavior: this.prefersReducedMotion() ? "auto" : "smooth", block: "start" });
        el.setAttribute("tabindex", "-1");
        el.focus({ preventScroll: true });
    },

    async copyText(text) {
        try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
    },

    // Tells Blazor which section is on screen, so the nav can highlight it.
    observeSections(dotnetRef, ids) {
        const visible = new Map();
        const observer = new IntersectionObserver(entries => {
            entries.forEach(e => visible.set(e.target.id, e.intersectionRatio));
            let best = null, bestRatio = 0;
            visible.forEach((ratio, id) => { if (ratio > bestRatio) { best = id; bestRatio = ratio; } });
            if (best) dotnetRef.invokeMethodAsync("OnSectionVisible", best);
        }, { rootMargin: "-30% 0px -55% 0px", threshold: [0, 0.25, 0.5, 1] });
        ids.forEach(id => { const el = document.getElementById(id); if (el) observer.observe(el); });
    },

    // Calls dotnetRef.method once, the first time the element is at least 30% on screen.
    onceVisible(dotnetRef, id, method) {
        const el = document.getElementById(id);
        if (!el) return;
        const observer = new IntersectionObserver(entries => {
            if (entries.some(e => e.isIntersecting)) { observer.disconnect(); dotnetRef.invokeMethodAsync(method); }
        }, { threshold: 0.3 });
        observer.observe(el);
    },

    isNarrow() {
        return matchMedia("(max-width: 640px)").matches;
    },

    // Keeps a chat list scrolled to its newest message.
    scrollBottom(el) {
        if (el) el.scrollTop = el.scrollHeight;
    },

    // Scrolls to an element and briefly highlights it (used when a query result is clicked).
    flash(id) {
        const el = document.getElementById(id);
        if (!el) return;
        this.scrollToId(id);
        el.classList.remove("is-flash");
        void el.offsetWidth; // restart the animation
        el.classList.add("is-flash");
        setTimeout(() => el.classList.remove("is-flash"), 2200);
    },

    // Closes open popovers when the visitor clicks elsewhere or presses Escape.
    onOutsideClick(dotnetRef, selector) {
        const handler = ev => {
            if (!ev.target.closest(selector)) dotnetRef.invokeMethodAsync("CloseMenus");
        };
        const keys = ev => { if (ev.key === "Escape") dotnetRef.invokeMethodAsync("CloseMenus"); };
        document.addEventListener("click", handler);
        document.addEventListener("keydown", keys);
    },

    // The About terminal: keep Tab and the arrow keys inside the input (completion and history are in C#).
    trapKeys(el) {
        if (!el || el.dataset.trapped) return;
        el.dataset.trapped = "1";
        el.addEventListener("keydown", e => {
            if (e.key === "Tab" || e.key === "ArrowUp" || e.key === "ArrowDown") e.preventDefault();
        });
    },
    focus(el) { try { el?.focus({ preventScroll: true }); } catch { } },

    // Feedback popup: send a Google Form response. "no-cors" means we can't read the answer,
    // so success = the request went out. Returns false when the network call itself failed.
    async postForm(action, fields) {
        try {
            await fetch(action, { method: "POST", mode: "no-cors", body: new URLSearchParams(fields) });
            return true;
        } catch { return false; }
    }
};

// The assistant's eyes follow the scroll direction: sets --look (-1 up … 1 down) on <html>.
(function () {
    let lastY = window.scrollY, look = 0, raf = 0;
    const root = document.documentElement;
    function settle() {
        look *= 0.9;
        root.style.setProperty("--look", look.toFixed(3));
        raf = Math.abs(look) > 0.01 ? requestAnimationFrame(settle) : 0;
    }
    window.addEventListener("scroll", () => {
        const y = window.scrollY;
        look = Math.max(-1, Math.min(1, look + (y - lastY) / 60));
        lastY = y;
        if (!raf) raf = requestAnimationFrame(settle);
    }, { passive: true });
})();
