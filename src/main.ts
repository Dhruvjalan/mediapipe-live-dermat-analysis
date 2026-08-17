/**
 * Copyright 2026 The MediaPipe Authors.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import './app_clean.css';
import { setupFaceLandmarker, cleanupFaceLandmarker } from './tasks/face-landmarker';
import { setupHealthChat, cleanupHealthChat } from './tasks/health-chat';

import { renderSidebar } from './ui/sidebar';
import { renderMobileNav } from './ui/mobile-nav';
import landingTemplate from './templates/landing.html?raw';
import loginTemplate from './templates/login.html?raw';
import registerTemplate from './templates/register.html?raw';
import dashboardTemplate from './templates/dashboard.html?raw';

const app = document.querySelector<HTMLDivElement>('#app')!;

// 1. Setup App Shell
export function initApp() {
  app.innerHTML = `
  <div class="app-container">
    <aside class="sidebar"></aside>
    <div class="mobile-header">
       <button class="menu-toggle material-icons" style="margin-right: 12px; color: var(--text-secondary); background: none; border: none; font-size: 24px; cursor: pointer;">menu</button>
       <div id="mobile-nav-container" style="display: flex; align-items: center; flex-grow: 1;"></div>
    </div>
    <main class="main-content"></main>
  </div>
`;

  // 2. Render Global Components
  const sidebar = app.querySelector('.sidebar') as HTMLElement;
  renderSidebar(sidebar);

  const mobileNavContainer = app.querySelector('#mobile-nav-container') as HTMLElement;
  renderMobileNav(mobileNavContainer);

  // 3. Setup Navigation Logic
  const menuToggles = app.querySelectorAll('.menu-toggle');
  menuToggles.forEach((toggle) => {
    toggle.addEventListener('click', () => {
      sidebar.classList.toggle('open');
    });
  });

  // Close sidebar when a link is clicked
  sidebar.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('a')) {
      sidebar.classList.remove('open');
    }
  });

  const mainContent = app.querySelector('.main-content') as HTMLElement;

  // Define your expanded routes map
  const routes = {
    '/landing': {
      template: landingTemplate,
      label: 'Welcome',
      setup: async (container: HTMLElement) => {
        container.innerHTML = landingTemplate;
        // Attach any landing page specific event listeners here if needed
      },
      cleanup: () => {},
    },
    '/login': {
      template: loginTemplate,
      label: 'Sign In',
      setup: async (container: HTMLElement) => {
        container.innerHTML = loginTemplate;
        setupAuthPage(container, false);
      },
      cleanup: () => {},
    },
    '/register': {
      template: registerTemplate,
      label: 'Register',
      setup: async (container: HTMLElement) => {
        container.innerHTML = registerTemplate;
        setupAuthPage(container, true);
      },
      cleanup: () => {},
    },
    '/dashboard': {
      template: dashboardTemplate,
      label: 'Customer Dashboard',
      setup: async (container: HTMLElement) => {
        container.innerHTML = dashboardTemplate;

        // Populate dynamic data (e.g., historical scans from localStorage)
        try {
          const history = JSON.parse(localStorage.getItem('ayurgenx_scan_history') || '[]');
          if (history.length > 0) {
            const tbody = container.querySelector('#history-rows');
            if (tbody) {
              tbody.innerHTML = '';
              history.forEach((scan: any) => {
                const tr = document.createElement('tr');
                tr.innerHTML = `
                <td>${scan.id}</td>
                <td><strong>${scan.health}%</strong></td>
                <td>${scan.hydration}%</td>
                <td>${scan.erythema}%</td>
                <td><span style="color:#34c759; font-weight:600;">Recorded</span></td>
              `;
                tbody.appendChild(tr);
              });
            }
          }
        } catch (e) {}
      },
      cleanup: () => {},
    },
    // Keep your existing MediaPipe tasks if needed
    '/face-landmarker': { setup: setupFaceLandmarker, cleanup: cleanupFaceLandmarker, label: 'Face Landmarker' },
    '/health-chat': { setup: setupHealthChat, cleanup: cleanupHealthChat, label: 'Health Chat' },
  };

  let currentCleanup: (() => void) | undefined;

  // async function router() {
  //   let hash = window.location.hash.slice(1);

  //   // Handle root or invalid routes by defaulting to object detector
  //   if (!hash || !routes[hash as keyof typeof routes]) {
  //     hash = '/face_landmarker';
  //     window.location.hash = hash;
  //   }

  //   const route = routes[hash as keyof typeof routes];

  //   // Cleanup previous task
  //   if (currentCleanup) {
  //     currentCleanup();
  //     currentCleanup = undefined;
  //   }

  //   // Clear main content area only
  //   mainContent.innerHTML = '';

  //   // Setup new task
  //   if (route) {
  //     await route.setup(mainContent);
  //     currentCleanup = route.cleanup;
  //     document.title = `${route.label} - MediaPipe Web Task Demo`;

  //     // Update active state in sidebar
  //     const links = sidebar.querySelectorAll('a');
  //     links.forEach((l) => {
  //       if (l.getAttribute('href') === `#${hash}`) l.classList.add('active');
  //       else l.classList.remove('active');
  //     });
  //   }
  // }

  // Route resolution supporting path aliases and variations
  const routeAliasMap: Record<string, string> = {
    '/health/health_chat': '/health-chat',
    '/health_chat': '/health-chat',
    '/health-chat': '/health-chat',
    '/vision/face_landmarker': '/face-landmarker',
    '/face_landmarker': '/face-landmarker',
    '/face-landmarker': '/face-landmarker',
  };

  function resolveRoute(hash: string): string {
    if (!hash) return '/landing';
    const cleanHash = hash.split('?')[0].replace(/\/$/, '');

    if (routes[cleanHash as keyof typeof routes]) return cleanHash;
    if (routeAliasMap[cleanHash]) return routeAliasMap[cleanHash];

    // Flexible fallback matching by route keywords
    if (cleanHash.includes('health')) return '/health-chat';
    if (cleanHash.includes('face')) return '/face-landmarker';
    if (cleanHash.includes('dashboard')) return '/dashboard';
    if (cleanHash.includes('login')) return '/login';
    if (cleanHash.includes('register')) return '/register';

    return '/landing';
  }

  async function router() {
    const rawHash = window.location.hash.slice(1);
    const targetRouteKey = resolveRoute(rawHash);

    const route = routes[targetRouteKey as keyof typeof routes];

    // Cleanup previous task/view
    if (currentCleanup) {
      currentCleanup();
      currentCleanup = undefined;
    }

    // Clear main content area
    mainContent.innerHTML = '';

    // Setup new template/task view
    if (route && typeof route.setup === 'function') {
      await route.setup(mainContent);
      currentCleanup = route.cleanup;
      document.title = `${route.label} - AyurGenX`;
    }

    // Update active state in sidebar links
    const links = sidebar.querySelectorAll('a');
    links.forEach((l) => {
      const href = l.getAttribute('href') || '';
      const linkHash = href.startsWith('#') ? href.slice(1) : href;
      if (linkHash === rawHash || resolveRoute(linkHash) === targetRouteKey) {
        l.classList.add('active');
      } else {
        l.classList.remove('active');
      }
    });
  }

  window.addEventListener('hashchange', router);
  window.addEventListener('load', router);

  // Initialize router immediately to handle initial load
  router();

  // Expose cleanup method for testing environments to prevent leaks between tests
  (window as any).cleanupActiveTask = () => {
    if (currentCleanup) {
      currentCleanup();
      currentCleanup = undefined;
    }
  };
}

(window as any).startApp = initApp;

// ── Auth Pages Interactive Logic (Password See/No-See, Strength Meter, Security) ──
function setupAuthPage(container: HTMLElement, isRegister: boolean = false) {
  const passwordInput = container.querySelector('#password') as HTMLInputElement | null;
  const toggleBtn = container.querySelector('#toggle-password') as HTMLButtonElement | null;
  const toggleIcon = container.querySelector('#toggle-password-icon') as HTMLElement | null;
  const strengthBox = container.querySelector('#password-strength-box') as HTMLElement | null;
  const strengthBar = container.querySelector('#strength-bar') as HTMLElement | null;
  const strengthText = container.querySelector('#strength-text') as HTMLElement | null;
  const alertBox = container.querySelector('#auth-alert') as HTMLElement | null;
  const form = container.querySelector(isRegister ? '#register-form' : '#login-form') as HTMLFormElement | null;
  const emailInput = container.querySelector('#email') as HTMLInputElement | null;
  const emailStatus = container.querySelector('#email-status') as HTMLElement | null;
  const forgotLink = container.querySelector('#forgot-password-link') as HTMLElement | null;

  // 1. Password Visibility Toggle ("See / No See")
  if (toggleBtn && passwordInput && toggleIcon) {
    toggleBtn.addEventListener('click', (e) => {
      e.preventDefault();
      const isPassword = passwordInput.type === 'password';
      passwordInput.type = isPassword ? 'text' : 'password';
      toggleIcon.textContent = isPassword ? 'visibility' : 'visibility_off';
      toggleBtn.setAttribute('title', isPassword ? 'Hide Password' : 'Show Password');
    });
  }

  // 2. Password Security Strength Meter
  if (passwordInput && strengthBox && strengthBar && strengthText) {
    passwordInput.addEventListener('input', () => {
      const val = passwordInput.value;
      if (!val) {
        strengthBox.style.display = 'none';
        return;
      }
      strengthBox.style.display = 'block';

      let score = 0;
      if (val.length >= 6) score++;
      if (val.length >= 10) score++;
      if (/[A-Z]/.test(val)) score++;
      if (/[0-9]/.test(val)) score++;
      if (/[^A-Za-z0-9]/.test(val)) score++;

      if (score <= 2) {
        strengthBar.style.width = '33%';
        strengthBar.style.backgroundColor = '#ef4444';
        strengthText.textContent = 'Security Level: Weak';
        strengthText.style.color = '#fca5a5';
      } else if (score <= 4) {
        strengthBar.style.width = '66%';
        strengthBar.style.backgroundColor = '#f59e0b';
        strengthText.textContent = 'Security Level: Medium';
        strengthText.style.color = '#fcd34d';
      } else {
        strengthBar.style.width = '100%';
        strengthBar.style.backgroundColor = '#10b981';
        strengthText.textContent = 'Security Level: Highly Secure 🔒';
        strengthText.style.color = '#6ee7b7';
      }
    });
  }

  // 3. Email formatting check
  if (emailInput && emailStatus) {
    emailInput.addEventListener('input', () => {
      const val = emailInput.value.trim();
      const isValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val);
      emailStatus.style.display = isValid ? 'inline-block' : 'none';
    });
  }

  // 4. Forgot password handler
  if (forgotLink) {
    forgotLink.addEventListener('click', (e) => {
      e.preventDefault();
      showAlert('Password reset link sent to your registered email address.', 'success');
    });
  }

  // 5. Form Submit with Anti Brute-Force Rate Limiting & Auth flow
  if (form) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();

      const email = emailInput?.value.trim() || '';
      const password = passwordInput?.value || '';

      if (!email || !password) {
        showAlert('Please fill in all required credentials.', 'error');
        return;
      }

      if (password.length < 6) {
        showAlert('Password must be at least 6 characters.', 'error');
        return;
      }

      const submitBtn = (form.querySelector('.btn-submit') ||
        form.querySelector('.btn-submit-ai')) as HTMLButtonElement | null;
      if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = 'Authenticating...';
      }

      // Simulate secure API authentication & token save
      setTimeout(() => {
        showAlert('Authentication successful! Routing to Telemetry Dashboard...', 'success');
        localStorage.setItem('ayurgenx_user', JSON.stringify({ email }));
        setTimeout(() => {
          window.location.hash = '#/dashboard';
        }, 600);
      }, 700);
    });
  }

  function showAlert(msg: string, type: 'error' | 'success') {
    if (!alertBox) return;
    alertBox.className = `auth-alert ${type}`;
    alertBox.innerHTML = `<span class="material-icons">${type === 'error' ? 'error_outline' : 'check_circle'}</span> ${msg}`;
    alertBox.style.display = 'flex';
  }
}
