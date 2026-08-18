(function () {
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const hasGsap = Boolean(window.gsap && window.ScrollTrigger);

  function smoothGo(selector) {
    const target = document.querySelector(selector);
    if (target) target.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth" });
  }

  document.querySelector("#enter-book")?.addEventListener("click", function () {
    if (!hasGsap || reduceMotion) {
      smoothGo("#contents");
      return;
    }
    window.gsap.timeline({
      defaults: { ease: "power3.inOut" },
      onComplete: function () { smoothGo("#contents"); }
    })
      .to("#hero-book", { rotateY: -72, xPercent: -15, duration: 0.72 })
      .to("#hero-book", { rotateY: -9, xPercent: 0, duration: 0.5, ease: "power3.out" });
  });

  const creed = document.querySelector("[data-word-reveal]");
  if (creed) {
    creed.innerHTML = creed.textContent.trim().split(/\s+/).map(function (word) {
      return '<span class="creed-word">' + word + '</span>';
    }).join(" ");
  }

  if (!hasGsap || reduceMotion) return;
  window.gsap.registerPlugin(window.ScrollTrigger);

  document.querySelectorAll(".book-spread").forEach(function (spread) {
    const leaf = document.createElement("span");
    leaf.className = "page-turn-leaf";
    leaf.setAttribute("aria-hidden", "true");
    spread.appendChild(leaf);

    window.gsap.timeline({
      scrollTrigger: { trigger: spread, start: "top 96%", end: "top 38%", scrub: 0.45 }
    })
      .fromTo(spread, { y: 54 }, { y: 0, duration: 1, ease: "none", force3D: true }, 0)
      .fromTo(leaf, { rotateY: 0, opacity: 1 }, { rotateY: -96, opacity: 0, duration: 1, ease: "power1.inOut", force3D: true }, 0);
  });
  window.gsap.from(".topbar", { y: -30, autoAlpha: 0, duration: 0.8, ease: "power3.out" });
  window.gsap.from(".hero-copy > *", { y: 36, autoAlpha: 0, duration: 0.85, stagger: 0.09, ease: "power3.out", delay: 0.15 });
  window.gsap.from(".book-scene", { xPercent: 18, yPercent: 4, rotate: 9, autoAlpha: 0, duration: 1.25, ease: "power4.out", delay: 0.25 });
  window.gsap.to(".book", { y: 14, rotateZ: -1.2, duration: 3.6, repeat: -1, yoyo: true, ease: "sine.inOut" });
  window.gsap.to(".orbit-one", { rotation: 360, transformOrigin: "-125px 110px", duration: 12, repeat: -1, ease: "none" });
  window.gsap.to(".orbit-two", { rotation: -360, transformOrigin: "145px -85px", duration: 15, repeat: -1, ease: "none" });

  window.gsap.utils.toArray(".chapter-card").forEach(function (card, index) {
    window.gsap.from(card, { y: 55, autoAlpha: 0, duration: 0.85, delay: index * 0.04, ease: "power3.out", scrollTrigger: { trigger: card, start: "top 88%" } });
  });

  window.gsap.utils.toArray(".image-reveal").forEach(function (frame) {
    const image = frame.querySelector("img");
    if (!image) return;
    window.gsap.from(image, { scale: 0.92, opacity: 0.55, duration: 0.8, ease: "power2.out", force3D: true, scrollTrigger: { trigger: frame, start: "top 88%", once: true } });
  });

  window.ScrollTrigger.batch(".story-beat", {
    start: "top 88%",
    once: true,
    onEnter: function (beats) {
      window.gsap.from(beats, { y: 54, opacity: 0.2, duration: 0.72, stagger: 0.08, ease: "power2.out", force3D: true });
    }
  });

  window.gsap.to(".creed-word", {
    color: "#f4eedc",
    stagger: 0.045,
    ease: "none",
    scrollTrigger: { trigger: ".creed", start: "top 78%", end: "bottom 42%", scrub: 0.5 }
  });

  window.gsap.from(".finale-mascot", { yPercent: 12, scale: 0.9, duration: 0.9, ease: "power2.out", force3D: true, scrollTrigger: { trigger: ".finale", start: "top 82%", once: true } });

  window.ScrollTrigger.refresh();
  if (window.location.hash) {
    window.setTimeout(function () {
      const deepLink = document.querySelector(window.location.hash);
      if (deepLink) deepLink.scrollIntoView({ behavior: "auto", block: "start" });
      window.ScrollTrigger.refresh();
    }, 120);
  }
})();
