initPasswordStrengthMeter('password', 'strengthFill', 'strengthLabel');

const signupForm = document.getElementById('signupForm');
const otpForm = document.getElementById('otpForm');
const signupMsg = document.getElementById('signupMsg');
const otpMsg = document.getElementById('otpMsg');
const mobileOtpForm = document.getElementById('mobileOtpForm');
const mobileOtpMsg = document.getElementById('mobileOtpMsg');
const subtitle = document.getElementById('subtitle');

let pendingEmail = null;
let pendingMobile = null;

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

const mobileOtpTimer = createOtpTimer({
  timerEl: document.getElementById('mobileOtpTimer'),
  resendBtn: document.getElementById('resendMobileOtpBtn'),
  seconds: 60,
  onResend: async () => {
    const { data } = await postJson('/api/auth/signup/resend-mobile-otp', {
      email: pendingEmail,
    });
    if (data.success) {
      showMsg(mobileOtpMsg, data.message, 'success');
      mobileOtpTimer.start();
    } else {
      showMsg(mobileOtpMsg, data.message, 'error');
      if (data.retryAfter) mobileOtpTimer.start(data.retryAfter);
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
    mobile: document.getElementById('mobile').value.trim(),
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
  pendingMobile = payload.mobile;
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

  if (data.nextStep === 'mobile') {
    otpForm.classList.add('hidden');
    mobileOtpForm.classList.remove('hidden');
    subtitle.textContent = `Verify your mobile number ${pendingMobile}`;
    showMsg(mobileOtpMsg, data.message, data.success ? 'success' : 'error');
    if (data.success) mobileOtpTimer.start();
    return;
  }

  if (!data.success) {
    showMsg(otpMsg, data.message, 'error');
    return;
  }

  showMsg(otpMsg, `${data.message} Redirecting to login…`, 'success');
  setTimeout(() => (window.location.href = '/login.html'), 1500);
});

mobileOtpForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const submitBtn = document.getElementById('mobileOtpSubmit');
  submitBtn.disabled = true;

  const code = document.getElementById('mobileOtpCode').value.trim();
  const { data } = await postJson('/api/auth/signup/verify-mobile-otp', {
    email: pendingEmail,
    code,
  });
  submitBtn.disabled = false;

  if (!data.success) {
    showMsg(mobileOtpMsg, data.message, 'error');
    return;
  }

  showMsg(mobileOtpMsg, `${data.message} Redirecting to login…`, 'success');
  setTimeout(() => (window.location.href = '/login.html'), 1500);
});
