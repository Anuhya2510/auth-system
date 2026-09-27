const forgotForm = document.getElementById('forgotForm');
const forgotMsg = document.getElementById('forgotMsg');

forgotForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const submitBtn = document.getElementById('forgotSubmit');
  submitBtn.disabled = true;

  const email = document.getElementById('email').value.trim();
  const { data } = await postJson('/api/auth/forgot-password', { email });

  // Always shown as success-style — the API deliberately doesn't reveal
  // whether the email is registered.
  showMsg(forgotMsg, data.message, data.success ? 'success' : 'error');
  submitBtn.disabled = false;
});
