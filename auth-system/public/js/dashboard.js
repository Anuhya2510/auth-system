async function loadDashboard() {
  try {
    const response = await fetch('/api/me', { credentials: 'include' });
    if (!response.ok) {
      window.location.replace('/login.html');
      return;
    }

    const { user } = await response.json();
    if (!user) {
      window.location.replace('/login.html');
      return;
    }

    document.getElementById('headerUsername').textContent = user.username;
    document.getElementById('welcomeUsername').textContent = user.username;
    document.body.classList.remove('auth-pending');
  } catch {
    window.location.replace('/login.html');
  }
}

document.getElementById('logoutButton').addEventListener('click', async () => {
  try {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
  } finally {
    window.location.replace('/login.html');
  }
});

loadDashboard();