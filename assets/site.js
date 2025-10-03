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
  const marquee = document.querySelector('.js-announcement-marquee');
  const marqueeTrack = marquee ? marquee.querySelector('.js-marquee-track') : null;
  const marqueeContent = marquee ? marquee.querySelector('.js-marquee-content') : null;

  if (!marquee || !marqueeTrack || !marqueeContent || typeof window.fetch !== 'function') {
    return;
  }

  const spreadsheetId = '1ht93XqQSTmLsypDqJP5JmMRpXz7C4axjs5Xss3-gNac';
  const requestUrl = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/gviz/tq?tqx=out:json&headers=1`;
  const maxItems = 5;

  const extractEntries = (responseText) => {
    try {
      const jsonStart = responseText.indexOf('{');
      const jsonEnd = responseText.lastIndexOf('}');

      if (jsonStart === -1 || jsonEnd === -1) {
        return [];
      }

      const payload = JSON.parse(responseText.slice(jsonStart, jsonEnd + 1));
      const rows = Array.isArray(payload?.table?.rows) ? payload.table.rows : [];

      return rows
        .map((row) => {
          const cells = Array.isArray(row?.c) ? row.c : [];
          const messageCell = cells[2];
          const linkCell = cells[3];
          const message = typeof messageCell?.v === 'string' ? messageCell.v.trim() : String(messageCell?.v ?? '').trim();
          const url = typeof linkCell?.v === 'string' ? linkCell.v.trim() : String(linkCell?.v ?? '').trim();

          if (!message || !url) {
            return null;
          }

          return { message, url };
        })
        .filter(Boolean);
    } catch (error) {
      console.warn('[Marquee] Failed to parse spreadsheet response', error);
      return [];
    }
  };

  const renderEntries = (entries) => {
    marqueeContent.innerHTML = '';

    const fragment = document.createDocumentFragment();
    entries.forEach(({ message, url }) => {
      const item = document.createElement('span');
      item.className = 'announcement-marquee__item';

      const link = document.createElement('a');
      link.href = url;
      link.textContent = message;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';

      item.appendChild(link);
      fragment.appendChild(item);
    });

    marqueeContent.appendChild(fragment);

    const totalCharacters = entries.reduce((total, entry) => total + entry.message.length, 0);
    const charactersPerSecond = 18;
    const minDuration = 12;
    const maxDuration = 15;
    const durationSeconds = Math.min(
      Math.max(totalCharacters / charactersPerSecond, minDuration),
      maxDuration,
    );
    marquee.style.setProperty('--marquee-duration', `${durationSeconds}s`);

    marqueeTrack.querySelectorAll('.announcement-marquee__content--clone').forEach((clone) => {
      clone.remove();
    });

    const clone = marqueeContent.cloneNode(true);
    clone.classList.add('announcement-marquee__content--clone');
    clone.classList.remove('js-marquee-content');
    clone.setAttribute('aria-hidden', 'true');
    marqueeTrack.appendChild(clone);
  };

  const initialise = async () => {
    try {
      const response = await fetch(requestUrl, { cache: 'no-store' });
      if (!response.ok) {
        throw new Error(`Unexpected response: ${response.status}`);
      }

      const raw = await response.text();
      const entries = extractEntries(raw).slice(-maxItems);

      if (!entries.length) {
        return;
      }

      renderEntries(entries);
      marquee.hidden = false;
    } catch (error) {
      console.warn('[Marquee] Failed to load announcements', error);
    }
  };

  initialise();
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
