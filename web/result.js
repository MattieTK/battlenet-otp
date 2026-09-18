// The setup URL is already on this local page. Copy only when the user clicks.
for (const button of document.querySelectorAll('[data-copy]')) {
  button.addEventListener('click', async () => {
    const field = document.getElementById(button.dataset.copy);
    const status = document.getElementById('copy-status');
    try {
      await navigator.clipboard.writeText(field.value);
      status.textContent = 'Copied. Paste it into your OTP provider.';
    } catch {
      field.focus();
      field.select();
      status.textContent = 'Press Ctrl+C (or Command+C) to copy the selected value.';
    }
  });
}
