const loginForm = document.getElementById('loginForm');
const otpForm = document.getElementById('otpForm');
const loginMsg = document.getElementById('loginMsg');
const otpMsg = document.getElementById('otpMsg');
const subtitle = document.getElementById('subtitle');

let pendingEmail = null;

const otpTimer = createOtpTimer({
  timerEl: document.getElementById('otpTimer'),
  resendBtn: document.getElementById('resendOtpBtn'),
  seconds: 60,
  onResend: async () => {
    const { data } = await postJson('/api/auth/login/resend-otp', {
      email: pendingEmail,
      purpose: 'login',
    });
    if (data.success) {
      showMsg(otpMsg, data.message, 'success');
      otpTimer.start();
    } else {
      showMsg(otpMsg, data.message, 'error');
      if (data.retryAfter) otpTimer.start(data.retryAfter);
    }
  },
});

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const submitBtn = document.getElementById('loginSubmit');
  submitBtn.disabled = true;

  const payload = {
    identifier: document.getElementById('identifier').value.trim(),
    password: document.getElementById('password').value,
  };

  const { data } = await postJson('/api/auth/login/start', payload);
  submitBtn.disabled = false;

  if (!data.success) {
    showMsg(loginMsg, data.message, 'error');
    return;
  }

  pendingEmail = data.email;
  loginForm.classList.add('hidden');
  otpForm.classList.remove('hidden');
  subtitle.textContent = `We sent a code to ${pendingEmail}`;
  otpTimer.start();
});

otpForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const submitBtn = document.getElementById('otpSubmit');
  submitBtn.disabled = true;

  const code = document.getElementById('otpCode').value.trim();
  const { data } = await postJson('/api/auth/login/verify-otp', {
    email: pendingEmail,
    purpose: 'login',
    code,
  });
  submitBtn.disabled = false;

  if (!data.success) {
    showMsg(otpMsg, data.message, 'error');
    return;
  }

  showMsg(otpMsg, 'Login successful. Redirecting…', 'success');
  setTimeout(() => (window.location.href = '/dashboard.html'), 1200);
});
