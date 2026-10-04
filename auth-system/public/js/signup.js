initPasswordStrengthMeter('password', 'strengthFill', 'strengthLabel');

const signupForm = document.getElementById('signupForm');
const otpForm = document.getElementById('otpForm');
const signupMsg = document.getElementById('signupMsg');
const otpMsg = document.getElementById('otpMsg');
const subtitle = document.getElementById('subtitle');

let pendingEmail = null;

const otpTimer = createOtpTimer({
  timerEl: document.getElementById('otpTimer'),
  resendBtn: document.getElementById('resendOtpBtn'),
  seconds: 60,
  onResend: async () => {
    const { data } = await postJson('/api/auth/signup/resend-otp', {
      email: pendingEmail,
      purpose: 'signup',
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

signupForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const submitBtn = document.getElementById('signupSubmit');
  submitBtn.disabled = true;

  const payload = {
    username: document.getElementById('username').value.trim(),
    email: document.getElementById('email').value.trim(),
    password: document.getElementById('password').value,
    confirmPassword: document.getElementById('confirmPassword').value,
  };

  const { data } = await postJson('/api/auth/signup/start', payload);
  submitBtn.disabled = false;

  if (!data.success) {
    showMsg(signupMsg, data.message, 'error');
    return;
  }

  pendingEmail = payload.email;
  signupForm.classList.add('hidden');
  otpForm.classList.remove('hidden');
  subtitle.textContent = `We sent a code to ${pendingEmail}`;
  otpTimer.start();
});

otpForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const submitBtn = document.getElementById('otpSubmit');
  submitBtn.disabled = true;

  const code = document.getElementById('otpCode').value.trim();
  const { data } = await postJson('/api/auth/signup/verify-otp', {
    email: pendingEmail,
    purpose: 'signup',
    code,
  });
  submitBtn.disabled = false;

  if (!data.success) {
    showMsg(otpMsg, data.message, 'error');
    return;
  }

  showMsg(otpMsg, `${data.message} Redirecting to login…`, 'success');
  setTimeout(() => (window.location.href = '/login.html'), 1500);
});
