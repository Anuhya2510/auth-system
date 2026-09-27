initPasswordStrengthMeter('password', 'strengthFill', 'strengthLabel');

const resetForm = document.getElementById('resetForm');
const resetMsg = document.getElementById('resetMsg');
const invalidTokenMsg = document.getElementById('invalidTokenMsg');

const token = new URLSearchParams(window.location.search).get('token');

async function validateTokenOnLoad() {
  if (!token) {
    showInvalid('Missing reset token. Please use the link from your email.');
    return;
  }
  const res = await fetch(`/api/auth/reset-password/validate?token=${encodeURIComponent(token)}`, {
    credentials: 'include',
  });
  const data = await res.json();
  if (!data.success) {
    showInvalid('This reset link is invalid or has expired. Please request a new one.');
  }
}

function showInvalid(message) {
  invalidTokenMsg.textContent = message;
  invalidTokenMsg.className = 'msg error';
  resetForm.classList.add('hidden');
}

resetForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const submitBtn = document.getElementById('resetSubmit');
  submitBtn.disabled = true;

  const payload = {
    token,
    password: document.getElementById('password').value,
    confirmPassword: document.getElementById('confirmPassword').value,
  };

  const { data } = await postJson('/api/auth/reset-password', payload);
  submitBtn.disabled = false;

  if (!data.success) {
    showMsg(resetMsg, data.message, 'error');
    return;
  }

  showMsg(resetMsg, `${data.message} Redirecting to login…`, 'success');
  setTimeout(() => (window.location.href = '/login.html'), 1500);
});

validateTokenOnLoad();
