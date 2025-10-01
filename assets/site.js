(function () {
  if (!('IntersectionObserver' in window)) {
    return;
  }

  const targets = Array.from(document.querySelectorAll('.metric-number, .ais-heading'));
  if (!targets.length) {
    return;
  }

  const motionPreference = window.matchMedia('(prefers-reduced-motion: reduce)');
  let observer;

  const disconnectObserver = () => {
    if (!observer) {
      return;
    }
    targets.forEach((el) => {
      observer.unobserve(el);
      el.classList.remove('is-active');
    });
    observer.disconnect();
    observer = undefined;
  };

  const initObserver = () => {
    observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add('is-active');
          } else {
            entry.target.classList.remove('is-active');
          }
        });
      },
      {
        root: null,
        rootMargin: '-33% 0px -33% 0px',
        threshold: 0,
      }
    );

    targets.forEach((el) => observer.observe(el));
  };

  const handlePreferenceChange = (event) => {
    if (event.matches) {
      disconnectObserver();
    } else {
      initObserver();
    }
  };

  if (motionPreference.matches) {
    return;
  }

  initObserver();

  if (typeof motionPreference.addEventListener === 'function') {
    motionPreference.addEventListener('change', handlePreferenceChange);
  } else if (typeof motionPreference.addListener === 'function') {
    motionPreference.addListener(handlePreferenceChange);
  }
})();
