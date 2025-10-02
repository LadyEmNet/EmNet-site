(function () {
  const navToggle = document.querySelector('.nav-toggle');
  const nav = document.getElementById('primary-nav');

  if (!navToggle || !nav) {
    return;
  }

  const closeNav = () => {
    navToggle.setAttribute('aria-expanded', 'false');
    nav.classList.remove('is-open');
  };

  navToggle.addEventListener('click', () => {
    const expanded = navToggle.getAttribute('aria-expanded') === 'true';
    navToggle.setAttribute('aria-expanded', String(!expanded));
    nav.classList.toggle('is-open', !expanded);
  });

  nav.addEventListener('click', (event) => {
    if (event.target.closest('a')) {
      closeNav();
    }
  });

  window.addEventListener('resize', () => {
    if (window.innerWidth > 640) {
      closeNav();
    }
  });
})();

(function () {
  const banner = document.querySelector('.js-cookie-banner');
  const acceptButton = banner ? banner.querySelector('.js-cookie-accept') : null;
  const storageKey = 'emnetCookieConsent';
  const root = document.documentElement;

  if (!banner || !acceptButton) {
    return;
  }

  let hasConsent = false;

  try {
    hasConsent = window.localStorage.getItem(storageKey) === 'true';
  } catch (error) {
    hasConsent = false;
  }

  const updateBannerOffset = () => {
    if (!banner.classList.contains('is-visible')) {
      root.style.setProperty('--cookie-banner-height', '0px');
      return;
    }

    root.style.setProperty('--cookie-banner-height', `${banner.offsetHeight}px`);
  };

  const hideBanner = () => {
    banner.classList.remove('is-visible');
    document.body.classList.remove('cookie-banner-visible');
    updateBannerOffset();
  };

  const showBanner = () => {
    banner.classList.add('is-visible');
    updateBannerOffset();
    document.body.classList.add('cookie-banner-visible');
  };

  if (!hasConsent) {
    showBanner();
  }

  acceptButton.addEventListener('click', () => {
    try {
      window.localStorage.setItem(storageKey, 'true');
    } catch (error) {
      // Ignore storage errors and continue closing the banner.
    }
    hideBanner();
  });

  window.addEventListener('resize', () => {
    if (!banner.classList.contains('is-visible')) {
      return;
    }

    updateBannerOffset();
  });
})();

(function () {
  if (!('IntersectionObserver' in window)) {
    return;
  }

  const targets = Array.from(document.querySelectorAll('.scroll-animate'));
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

(function () {
  const targets = document.querySelectorAll('.js-current-year');
  if (!targets.length) {
    return;
  }

  const year = String(new Date().getFullYear());
  targets.forEach((el) => {
    el.textContent = year;
  });
})();
