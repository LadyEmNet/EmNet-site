if (window.top !== window.self) {
  window.top.location = window.location.href;
}

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
  const form = document.querySelector('.js-contact-form');
  if (!form || typeof window.fetch !== 'function') {
    return;
  }

  const confirmation = form.querySelector('.js-contact-confirmation');
  const errorMessage = form.querySelector('.js-contact-error');
  const messageInput = form.querySelector('textarea[name="message"]');
  const subjectSelect = form.querySelector('select[name="subject"]');
  const submitButton = form.querySelector('[type="submit"]');
  const submitButtonText = submitButton ? submitButton.textContent : '';

  const hideFeedback = () => {
    if (confirmation && !confirmation.hidden) {
      confirmation.hidden = true;
    }

    if (errorMessage && !errorMessage.hidden) {
      errorMessage.hidden = true;
    }
  };

  const setSubmittingState = (isSubmitting) => {
    if (!submitButton) {
      return;
    }

    submitButton.disabled = isSubmitting;
    if (isSubmitting) {
      submitButton.setAttribute('aria-disabled', 'true');
    } else {
      submitButton.removeAttribute('aria-disabled');
    }

    submitButton.textContent = isSubmitting ? 'Sending…' : submitButtonText;
  };

  form.addEventListener('input', (event) => {
    hideFeedback();

    if (event.target === messageInput && messageInput) {
      messageInput.setCustomValidity('');
    }
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();

    hideFeedback();
    setSubmittingState(true);

    if (messageInput) {
      messageInput.setCustomValidity('');
    }

    if (typeof form.reportValidity === 'function' && !form.reportValidity()) {
      setSubmittingState(false);
      return;
    }

    const formData = new FormData(form);
    const getValue = (name) => {
      const value = formData.get(name);
      return typeof value === 'string' ? value.trim() : '';
    };

    const message = getValue('message');
    if (messageInput && message.length < 10) {
      messageInput.setCustomValidity('Message must be at least 10 characters long.');
      messageInput.reportValidity();
      setSubmittingState(false);
      return;
    }

    const name = getValue('name') || 'N/A';
    const email = getValue('email') || 'N/A';
    const subject = getValue('subject') || 'General enquiry';

    const endpoint = form.dataset.formsubmitEndpoint || form.action;

    try {
      formData.set('name', name);
      formData.set('email', email);
      formData.set('subject', subject);
      formData.set('message', message);

      const payload = {};
      formData.forEach((value, key) => {
        if (typeof value === 'string') {
          payload[key] = value;
        }
      });

      const response = await fetch(endpoint, {
        method: form.method || 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        throw new Error(`Request failed with status ${response.status}`);
      }
    } catch (error) {
      if (errorMessage) {
        errorMessage.hidden = false;
      }
      setSubmittingState(false);
      return;
    }

    if (confirmation) {
      confirmation.hidden = false;
    }

    form.reset();
    if (subjectSelect) {
      subjectSelect.value = 'General enquiry';
    }
    setSubmittingState(false);
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
