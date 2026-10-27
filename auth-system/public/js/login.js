const loginForm = document.getElementById('loginForm');
const loginMsg = document.getElementById('loginMsg');

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const submitBtn = document.getElementById('loginSubmit');
  const label = submitBtn.querySelector('.button-label');
  const originalLabel = label.textContent;
  submitBtn.disabled = true;
  submitBtn.classList.add('is-loading');
  submitBtn.setAttribute('aria-busy', 'true');
  label.textContent = 'Signing in…';

  const payload = {
    identifier: document.getElementById('identifier').value.trim(),
    password: document.getElementById('password').value,
  };

  let data;
  try {
    ({ data } = await postJson('/api/auth/login/start', payload));
  } finally {
    submitBtn.disabled = false;
    submitBtn.classList.remove('is-loading');
    submitBtn.removeAttribute('aria-busy');
    label.textContent = originalLabel;
  }

  if (!data.success) {
    showMsg(loginMsg, data.message, 'error');
    return;
  }

  window.location.replace('/dashboard.html');
});
