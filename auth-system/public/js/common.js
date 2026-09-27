// Wires up every button.toggle-visibility on the page to show/hide its target input.
function initPasswordToggles() {
  document.querySelectorAll('.toggle-visibility').forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = document.getElementById(btn.dataset.target);
      const isHidden = target.type === 'password';
      target.type = isHidden ? 'text' : 'password';
      btn.textContent = isHidden ? 'Hide' : 'Show';
    });
  });
}

// Returns { score: 0-4, label, color } for a password.
function scorePassword(password) {
  let score = 0;
  if (password.length >= 8) score++;
  if (/[a-z]/.test(password) && /[A-Z]/.test(password)) score++;
  if (/\d/.test(password)) score++;
  if (/[^A-Za-z0-9]/.test(password)) score++;

  const levels = [
    { label: 'Enter a password', color: '#e2e4ea' },
    { label: 'Weak', color: '#dc2626' },
    { label: 'Fair', color: '#f59e0b' },
    { label: 'Good', color: '#eab308' },
    { label: 'Strong', color: '#16a34a' },
  ];
  return { score, ...levels[score] };
}

function initPasswordStrengthMeter(inputId, fillId, labelId) {
  const input = document.getElementById(inputId);
  const fill = document.getElementById(fillId);
  const label = document.getElementById(labelId);
  if (!input || !fill || !label) return;

  input.addEventListener('input', () => {
    const { score, label: text, color } = scorePassword(input.value);
    fill.style.width = `${(score / 4) * 100}%`;
    fill.style.background = color;
    label.textContent = input.value ? text : 'Enter a password';
  });
}

function showMsg(el, message, type) {
  el.textContent = message;
  el.className = `msg ${type}`;
}

// Manages the "resend code" cooldown countdown. onResend is called when clicked.
function createOtpTimer({ timerEl, resendBtn, seconds, onResend }) {
  let remaining = seconds;
  let intervalId = null;

  function tick() {
    if (remaining <= 0) {
      clearInterval(intervalId);
      timerEl.textContent = '';
      resendBtn.disabled = false;
      return;
    }
    timerEl.textContent = `Resend available in ${remaining}s`;
    remaining--;
  }

  function start(newSeconds) {
    remaining = newSeconds != null ? newSeconds : seconds;
    resendBtn.disabled = true;
    clearInterval(intervalId);
    tick();
    intervalId = setInterval(tick, 1000);
  }

  resendBtn.addEventListener('click', async () => {
    if (resendBtn.disabled) return;
    await onResend();
  });

  return { start };
}

const API_BASE_URL = 'https://rohith-solutions.onrender.com';

async function postJson(url, body) {
  const res = await fetch(`${API_BASE_URL}${url}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(body || {}),
  });
  let data;
  try {
    data = await res.json();
  } catch {
    data = { success: false, message: 'Unexpected server response.' };
  }
  return { ok: res.ok, status: res.status, data };
}

document.addEventListener('DOMContentLoaded', initPasswordToggles);
