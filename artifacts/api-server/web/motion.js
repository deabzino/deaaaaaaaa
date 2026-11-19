(() => {
  const root = document.documentElement;
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  const fine = matchMedia("(hover: hover) and (pointer: fine)");
  const $$ = (selector, scope = document) => [...scope.querySelectorAll(selector)];

  // Scroll progress bar. Works with reduced motion too.
  const bar = document.createElement("div");
  bar.className = "scroll-progress";
  bar.setAttribute("aria-hidden", "true");
  document.body.append(bar);
  let ticking = false;
  const onScroll = () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      const max = document.documentElement.scrollHeight - innerHeight;
      bar.style.setProperty("--p", max > 0 ? Math.min(1, scrollY / max).toFixed(4) : 0);
      ticking = false;
    });
  };
  addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  if (reduced.matches) return;
  root.classList.add("motion");

  // Headlines: every word rises out of its own mask. Line breaks and accent spans stay exactly as written.
  const splitWords = (node, counter) => {
    [...node.childNodes].forEach((child) => {
      if (child.nodeType === Node.TEXT_NODE) {
        const frag = document.createDocumentFragment();
        child.textContent.split(/(\s+)/).forEach((part) => {
          if (!part) return;
          if (/^\s+$/.test(part)) { frag.append(" "); return; }
          const mask = document.createElement("span");
          mask.className = "w";
          mask.setAttribute("aria-hidden", "true");
          const inner = document.createElement("span");
          inner.className = "wi";
          inner.style.setProperty("--i", counter.n++);
          inner.textContent = part;
          mask.append(inner);
          frag.append(mask);
        });
        child.replaceWith(frag);
      } else if (child.nodeType === Node.ELEMENT_NODE && child.tagName !== "BR") {
        splitWords(child, counter);
      }
    });
  };
  $$(".hero-copy h1, .page-heading h1, .not-found h1").forEach((heading) => {
    const label = [...heading.childNodes].map((n) => n.tagName === "BR" ? " " : n.textContent).join("").replace(/\s+/g, " ").trim();
    heading.setAttribute("aria-label", label);
    splitWords(heading, { n: 0 });
    requestAnimationFrame(() => requestAnimationFrame(() => heading.classList.add("is-in")));
  });

  // Things below the fold arrive in their own way as they scroll into view.
  const kinds = [
    [".section-heading", "m-up"], [".feature-card", "m-pop"], [".auto-card", "m-pop"], [".demo-layout", "m-pop"],
    [".live-strip", "m-up"], [".final-cta", "m-pop"], [".status-card", "m-pop"], [".status-footnote", "m-up"],
    [".changelog-tools", "m-up"], [".command-browser .search-wrap", "m-up"], [".connect-card", "m-pop"],
  ];
  if ("IntersectionObserver" in window) {
    const seen = new IntersectionObserver((entries) => entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      entry.target.classList.add("m-in");
      seen.unobserve(entry.target);
    }), { threshold: 0.12, rootMargin: "0px 0px -6% 0px" });
    kinds.forEach(([selector, kind]) => {
      $$(selector).forEach((node) => {
        const siblings = $$(selector, node.parentElement);
        node.style.setProperty("--d", Math.max(0, siblings.indexOf(node)) % 4);
        if (node.getBoundingClientRect().top < innerHeight * 0.9) return;
        node.classList.add("m", kind);
        seen.observe(node);
      });
    });
  }

  // Rendered lists (commands, changelog) get a stagger index every time they are rebuilt.
  const stagger = (container, selector) => {
    if (!container) return;
    const mark = () => $$(selector, container).forEach((node, index) => node.style.setProperty("--i", index));
    new MutationObserver(mark).observe(container, { childList: true });
    mark();
  };
  stagger(document.getElementById("command-grid"), ".command-card");
  stagger(document.getElementById("timeline"), ".timeline-entry");

  // Buttons lean toward the pointer, and the voice card tilts a few degrees.
  if (fine.matches) {
    document.addEventListener("pointermove", (event) => {
      const button = event.target.closest?.(".button");
      if (!button || button.disabled) return;
      const box = button.getBoundingClientRect();
      const dx = (event.clientX - (box.left + box.width / 2)) / box.width;
      const dy = (event.clientY - (box.top + box.height / 2)) / box.height;
      button.style.translate = `${(dx * 8).toFixed(1)}px ${(dy * 5).toFixed(1)}px`;
    });
    document.addEventListener("pointerout", (event) => {
      const button = event.target.closest?.(".button");
      if (button) button.style.translate = "";
    });
    const card = document.querySelector(".voice-card");
    if (card) {
      card.addEventListener("pointermove", (event) => {
        const box = card.getBoundingClientRect();
        const x = (event.clientX - box.left) / box.width - 0.5;
        const y = (event.clientY - box.top) / box.height - 0.5;
        card.style.transform = `perspective(900px) rotateY(${(x * 6).toFixed(2)}deg) rotateX(${(-y * 5).toFixed(2)}deg)`;
      });
      card.addEventListener("pointerleave", () => { card.style.transform = ""; });
    }
  }

  // Automatic mode: the phase list walks through a round while it is on screen.
  const steps = $$(".auto-steps li");
  if (steps.length && "IntersectionObserver" in window) {
    let at = 0;
    let timer = null;
    const show = () => steps.forEach((step, index) => step.classList.toggle("is-active", index === at));
    const tick = () => { at = (at + 1) % steps.length; show(); };
    const run = (on) => {
      clearInterval(timer);
      timer = on && !document.hidden ? setInterval(tick, 2300) : null;
    };
    show();
    new IntersectionObserver(([entry]) => run(entry.isIntersecting), { threshold: 0.35 }).observe(steps[0].closest(".auto-card"));
    document.addEventListener("visibilitychange", () => run(!document.hidden));
    steps.forEach((step, index) => step.addEventListener("pointerenter", () => { at = index; show(); clearInterval(timer); }));
  }

  // The 404 tile spins when you poke it.
  const tile = document.querySelector(".not-found-orbit");
  tile?.addEventListener("click", () => {
    tile.animate([{ rotate: "0deg" }, { rotate: "360deg" }], { duration: 700, easing: "cubic-bezier(.34,1.56,.64,1)" });
  });
})();
