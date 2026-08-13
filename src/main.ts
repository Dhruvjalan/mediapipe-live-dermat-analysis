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

        // Wire up your login form handler
        const form = container.querySelector('#login-form');
        form?.addEventListener('submit', (e) => {
          e.preventDefault();
          window.location.hash = '#/dashboard';
        });
      },
      cleanup: () => {},
    },
    '/register': {
      template: registerTemplate,
      label: 'Register',
      setup: async (container: HTMLElement) => {
        container.innerHTML = registerTemplate;

        // Wire up registration form handler
        const form = container.querySelector('#register-form');
        form?.addEventListener('submit', (e) => {
          e.preventDefault();
          window.location.hash = '#/dashboard';
        });
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

  async function router() {
    let hash = window.location.hash.slice(1);

    // Default to landing page if hash is empty or invalid
    if (!hash || !routes[hash as keyof typeof routes]) {
      hash = '/landing';
      window.location.hash = hash;
    }

    const route = routes[hash as keyof typeof routes];

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
