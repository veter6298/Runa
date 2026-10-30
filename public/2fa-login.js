// Автоматическая проверка второго пароля при входе
(function () {
  let pending2faUserId = null;

  // Ждём, пока страница загрузится
  document.addEventListener('DOMContentLoaded', () => {
    // Кнопка "Войти" на модалке второго пароля
    const submitBtn = document.getElementById('btn-2fa-login-submit');
    const input = document.getElementById('2fa-login-input');
    const err = document.getElementById('2fa-login-error');

    if (submitBtn) {
      submitBtn.addEventListener('click', async () => {
        const pwd = input.value;
        if (err) err.style.display = 'none';
        const r = await fetch('/api/auth/login/2fa', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId: pending2faUserId, password: pwd })
        }).then(r => r.json());
        if (r.token) {
          localStorage.setItem('token', r.token);
          location.reload();
        } else {
          if (err) {
            err.textContent = r.error || 'Ошибка';
            err.style.display = 'block';
          }
        }
      });
    }

    // Перехватываем ответ от /api/auth/login, чтобы показать модалку
    const originalFetch = window.fetch;
    window.fetch = async function (...args) {
      const response = await originalFetch.apply(this, args);

      try {
        const url = typeof args[0] === 'string' ? args[0] : args[0]?.url;
        if (url && url.includes('/api/auth/login') && !url.includes('/2fa')) {
          const clone = response.clone();
          const data = await clone.json();
          if (data && data.secondPasswordRequired) {
            pending2faUserId = data.userId;
            const modal = document.getElementById('modal-2fa-login');
            if (modal) modal.style.display = 'block';
          }
        }
      } catch (e) {}

      return response;
    };
  });
})();
