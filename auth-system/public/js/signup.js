initPasswordStrengthMeter('password', 'strengthFill', 'strengthLabel');

const signupForm = document.getElementById('signupForm');
const otpForm = document.getElementById('otpForm');
const signupMsg = document.getElementById('signupMsg');
const otpMsg = document.getElementById('otpMsg');
const subtitle = document.getElementById('subtitle');

function setLoading(button, loading, loadingLabel) {
  const label = button.querySelector('.button-label');
  if (loading) {
    button.dataset.originalLabel = label.textContent;
    button.disabled = true;
    button.classList.add('is-loading');
    button.setAttribute('aria-busy', 'true');
    label.textContent = loadingLabel;
  } else {
    button.disabled = false;
    button.classList.remove('is-loading');
    button.removeAttribute('aria-busy');
    label.textContent = button.dataset.originalLabel || label.textContent;
  }
}

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
  setLoading(submitBtn, true, 'Creating account…');

  const payload = {
    username: document.getElementById('username').value.trim(),
    email: document.getElementById('email').value.trim(),
    mobile: document.getElementById('mobile').value.trim(),
    password: document.getElementById('password').value,
    confirmPassword: document.getElementById('confirmPassword').value,
  };

  let data;
  try {
    ({ data } = await postJson('/api/auth/signup/start', payload));
  } finally {
    setLoading(submitBtn, false);
  }

  if (!data.success) {
    showMsg(signupMsg, data.message, 'error');
    return;
  }

  pendingEmail = payload.email;
  signupForm.classList.add('hidden');
  otpForm.classList.remove('hidden');
  document.getElementById('signupHeading').textContent = 'Verify your email';
  document.getElementById('signupStep').textContent = 'One last step';
  subtitle.textContent = `We sent a code to ${pendingEmail}`;
  otpTimer.start();
});

otpForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const submitBtn = document.getElementById('otpSubmit');
  setLoading(submitBtn, true, 'Verifying…');

  const code = document.getElementById('otpCode').value.trim();
  let data;
  try {
    ({ data } = await postJson('/api/auth/signup/verify-otp', {
      email: pendingEmail,
      purpose: 'signup',
      code,
    }));
  } finally {
    setLoading(submitBtn, false);
  }

  if (!data.success) {
    showMsg(otpMsg, data.message, 'error');
    return;
  }

  showMsg(otpMsg, `${data.message} Redirecting to login…`, 'success');
  setTimeout(() => (window.location.href = '/login.html'), 1500);
});
