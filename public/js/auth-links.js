'use strict';

const tokenValues = new URLSearchParams(location.hash.slice(1));
const token = tokenValues.get('token') || '';
const companyCode = tokenValues.get('company_code') || '';
const statusElement = document.getElementById('account-status');
const loginLink = document.getElementById('account-login-link');
history.replaceState(null, document.title, location.pathname);

function showAccountMessage(message, isError = false) {
  statusElement.textContent = message;
  statusElement.classList.toggle('error', isError);
}

async function postAccountAction(path, body) {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ ...body, company_code: companyCode })
  });
  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error('The server response could not be read. Try again later.');
  }
  if (!response.ok) throw new Error(result.error || 'The request could not be completed.');
  return result;
}

const resetForm = document.getElementById('password-reset-form');
if (resetForm) {
  if (!token) {
    resetForm.classList.add('hidden');
    showAccountMessage('This password-reset link is missing or invalid. Request a new link from the sign-in page.', true);
  }
  resetForm.addEventListener('submit', async event => {
    event.preventDefault();
    if (!token) return;
    const password = document.getElementById('new-password').value;
    if (password !== document.getElementById('confirm-password').value) {
      showAccountMessage('The passwords do not match.', true);
      return;
    }
    const button = resetForm.querySelector('button[type="submit"]');
    button.disabled = true;
    showAccountMessage('Updating your password…');
    try {
      await postAccountAction('/api/auth/password-reset/complete', { token, password });
      resetForm.classList.add('hidden');
      showAccountMessage('Your password was updated. You can now sign in with your username or verified email.');
      loginLink?.classList.remove('hidden');
    } catch (error) {
      showAccountMessage(error.message, true);
    } finally {
      button.disabled = false;
    }
  });
} else if (token) {
  postAccountAction('/api/auth/email/verify', { token })
    .then(() => {
      showAccountMessage('Your email address is verified. You can now sign in using your username or email.');
      loginLink?.classList.remove('hidden');
    })
    .catch(error => showAccountMessage(error.message, true));
} else {
  showAccountMessage('This verification link is missing or invalid. Ask your workspace administrator to send a new one.', true);
}
