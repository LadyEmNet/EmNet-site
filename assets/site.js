(function () {
  var yearEls = document.querySelectorAll('.js-current-year');
  var currentYear = new Date().getFullYear();
  yearEls.forEach(function (el) {
    el.textContent = currentYear;
  });

  var highlightTargets = Array.prototype.slice.call(
    document.querySelectorAll('.metric-number, .ais-heading')
  );

  if (!highlightTargets.length) {
    return;
  }

  var motionQuery = null;
  if (window.matchMedia) {
    motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
  }

  var observer = null;

  function setStaticState() {
    if (observer && typeof observer.disconnect === 'function') {
      observer.disconnect();
    }
    observer = null;
    highlightTargets.forEach(function (el) {
      el.classList.add('is-active');
    });
  }

  function setDynamicState() {
    if (!('IntersectionObserver' in window)) {
      setStaticState();
      return;
    }

    if (observer && typeof observer.disconnect === 'function') {
      observer.disconnect();
    }

    highlightTargets.forEach(function (el) {
      el.classList.remove('is-active');
    });

    observer = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
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
        threshold: 0.5
      }
    );

    highlightTargets.forEach(function (el) {
      observer.observe(el);
    });
  }

  function handlePreferenceChange(event) {
    if (event.matches) {
      setStaticState();
    } else {
      setDynamicState();
    }
  }

  if (motionQuery && typeof motionQuery.matches === 'boolean') {
    if (motionQuery.matches) {
      setStaticState();
    } else {
      setDynamicState();
    }

    if (typeof motionQuery.addEventListener === 'function') {
      motionQuery.addEventListener('change', handlePreferenceChange);
    } else if (typeof motionQuery.addListener === 'function') {
      motionQuery.addListener(handlePreferenceChange);
    }
  } else {
    setDynamicState();
  }
})();
